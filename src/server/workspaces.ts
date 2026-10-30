// Worker workspaces. In a git project each worker gets its own worktree on its
// own branch (isolated copy of the committed files); without git, workers share
// the project folder and rely on shared-asset grants alone.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import { globalDir, type Agent, type Project } from "./store.js";

export interface Workspace {
  directory: string;
  branch: string | null;
  /** Commit the branch started from; used to compute what the worker changed. */
  base: string | null;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return existsSync(path.join(dir, ".git"));
}

export async function createWorkspace(project: Project, agentName: string): Promise<Workspace & { warning?: string }> {
  if (!(await isGitRepo(project.directory))) {
    return { directory: project.directory, branch: null, base: null };
  }
  const slug = agentName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const branch = `symbio/${slug}`;
  const directory = path.join(globalDir, "worktrees", project.id, slug);
  if (existsSync(directory)) throw new Error(`A workspace for "${agentName}" already exists.`);
  await fs.mkdir(path.dirname(directory), { recursive: true });

  const base = await git(project.directory, "rev-parse", "HEAD").catch(() => "");
  if (!base) throw new Error("The project's git repository has no commits yet; commit the current files first.");
  const branchExists = await git(project.directory, "rev-parse", "--verify", "--quiet", branch).then(
    () => true,
    () => false,
  );
  await git(project.directory, "worktree", "add", ...(branchExists ? [directory, branch] : ["-b", branch, directory, base]));

  const dirty = await git(project.directory, "status", "--porcelain").catch(() => "");
  const warning = dirty
    ? "The project folder has uncommitted changes; the new agent's workspace does not include them. Commit first if the agent needs them."
    : undefined;
  return { directory, branch, base, warning };
}

/** Files the worker changed: commits on its branch since the base, plus uncommitted edits. */
export async function changedFiles(agent: Agent): Promise<{ committed: string[]; uncommitted: string[] }> {
  if (!agent.branch || !agent.base) return { committed: [], uncommitted: [] };
  const committed = (await git(agent.directory, "diff", "--name-only", `${agent.base}..HEAD`).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  // Ask git for names directly (parsing `status --porcelain` breaks once output is trimmed).
  const lines = async (...args: string[]) =>
    (await git(agent.directory, ...args).catch(() => ""))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const modified = await lines("diff", "--name-only", "HEAD");
  const untracked = await lines("ls-files", "--others", "--exclude-standard");
  const uncommitted = [...new Set([...modified, ...untracked])];
  return { committed, uncommitted };
}

export type MergeResult =
  | { ok: true; summary: string; files: string[] }
  | { ok: false; reason: string; files?: string[] };

/** Merges a worker's branch into the project's current branch. */
export async function mergeWorkspace(project: Project, agent: Agent): Promise<MergeResult> {
  if (!agent.branch) return { ok: false, reason: "This agent works directly in the project folder; there is nothing to merge." };
  const { committed, uncommitted } = await changedFiles(agent);
  if (uncommitted.length) {
    return {
      ok: false,
      reason: `${agent.name} has uncommitted changes. Ask them to commit their work first.`,
      files: uncommitted,
    };
  }
  if (committed.length === 0) return { ok: false, reason: `${agent.name} has no committed changes to merge.` };
  const mainDirty = await git(project.directory, "status", "--porcelain").catch(() => "");
  if (mainDirty) {
    return { ok: false, reason: "The project folder has uncommitted changes. Commit or stash them before merging." };
  }
  try {
    await git(project.directory, "merge", "--no-ff", "--no-edit", "-m", `Merge work from ${agent.name} (Symbio)`, agent.branch);
  } catch (err) {
    const conflicts = (await git(project.directory, "diff", "--name-only", "--diff-filter=U").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    await git(project.directory, "merge", "--abort").catch(() => {});
    const main = await git(project.directory, "rev-parse", "--abbrev-ref", "HEAD").catch(() => "the main branch");
    return {
      ok: false,
      reason: conflicts.length
        ? `Merge conflicts — nothing was merged; the project is unchanged. Ask ${agent.name} to bring the latest project ` +
          `state into its workspace and resolve them there: \`git merge ${main}\` in its folder, fix the conflicted files ` +
          `(keeping both sides' intent), commit, and report back — then merge again.`
        : `Merge failed: ${(err as Error).message}`,
      files: conflicts,
    };
  }
  return { ok: true, summary: `Merged ${committed.length} changed file(s) from ${agent.name}.`, files: committed };
}

/** After a merge, move the worker's branch to the new project state so it continues from there. */
export async function syncWorkspace(project: Project, agent: Agent): Promise<string | null> {
  if (!agent.branch) return null;
  const head = await git(project.directory, "rev-parse", "HEAD");
  await git(agent.directory, "merge", "--ff-only", head).catch(() => {});
  return head;
}

/**
 * Gives a restarted agent its workspace back. A kept workspace (unmerged work) is
 * reused; a removed one had nothing unmerged, so its branch restarts from the
 * project's current commit.
 */
export async function restoreWorkspace(project: Project, agent: Agent): Promise<Workspace & { reset: boolean }> {
  if (!agent.branch || existsSync(agent.directory)) {
    return { directory: agent.directory, branch: agent.branch ?? null, base: agent.base ?? null, reset: false };
  }
  const base = await git(project.directory, "rev-parse", "HEAD");
  await git(project.directory, "worktree", "prune").catch(() => {});
  await git(project.directory, "branch", "-f", agent.branch, base);
  await fs.mkdir(path.dirname(agent.directory), { recursive: true });
  await git(project.directory, "worktree", "add", agent.directory, agent.branch);
  return { directory: agent.directory, branch: agent.branch, base, reset: true };
}

export async function removeWorkspace(project: Project, agent: Agent): Promise<void> {
  if (!agent.branch) return;
  await git(project.directory, "worktree", "remove", "--force", agent.directory).catch(() => {});
}

/**
 * Deletes helper folders left behind by projects that no longer exist (removing a project
 * deletes them, but on Windows an open file can make that fail halfway). Only Symbio's own
 * worktrees folder is touched. Returns the folders removed.
 */
export async function removeOrphanWorkspaces(knownProjectIds: Set<string>): Promise<string[]> {
  const root = path.join(globalDir, "worktrees");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^prj_[a-z0-9]+$/i.test(e.name) || knownProjectIds.has(e.name)) continue;
    const dir = path.join(root, e.name);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).then(
      () => removed.push(dir),
      (err) => console.warn(`[cleanup] could not remove ${dir}: ${err.message}`),
    );
  }
  return removed;
}
