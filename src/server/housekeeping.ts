// Daily care of a project's surroundings: backups of Symbio's state, work that exists only on
// this machine (commits not on any remote), and disk used by helpers' folders (mostly build
// outputs). Symbio reports; the coordinator (or the human) acts.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import { projectRepositoriesSync } from "./repos.js";
import { globalDir, type Agent, type Project } from "./store.js";
import { replaceFile } from "./fsutil.js";

// ---------------------------------------------------------------- backups

const BACKUP_KEEP = Number(process.env.SYMBIO_BACKUP_DAYS ?? 7);
export const backupsDir = () => path.join(globalDir, "backups");

/**
 * Today's backup of every project's .symbio folder and Symbio's own small files (not the
 * helpers' worktrees, logs or the UI key). One per day; the last BACKUP_KEEP days are kept.
 * Returns the folder, or null when today's backup already exists.
 */
export async function dailyBackup(projects: Project[], now = new Date()): Promise<string | null> {
  const dest = path.join(backupsDir(), now.toISOString().slice(0, 10));
  if (existsSync(dest)) return null;
  return writeBackup(projects, dest);
}

/** A backup on demand, e.g. right before an update ("2026-11-06-before-0.7.0"); pruned like the daily ones. */
export async function labeledBackup(projects: Project[], label: string, now = new Date()): Promise<string> {
  const dest = path.join(backupsDir(), `${now.toISOString().slice(0, 10)}-${label.replace(/[^\w.-]+/g, "-")}`);
  await fs.rm(dest, { recursive: true, force: true });
  return writeBackup(projects, dest);
}

async function writeBackup(projects: Project[], dest: string): Promise<string> {
  const tmp = `${dest}.partial`;
  await fs.rm(tmp, { recursive: true, force: true });
  for (const p of projects) {
    const src = path.join(p.directory, ".symbio");
    if (existsSync(src)) await fs.cp(src, path.join(tmp, "projects", `${path.basename(p.directory)}-${p.id}`), { recursive: true });
  }
  for (const name of ["config.json", "connections.json", "secrets.enc", "prices.json", "approvals"]) {
    const src = path.join(globalDir, name);
    if (existsSync(src)) await fs.cp(src, path.join(tmp, "symbio", name), { recursive: true });
  }
  await fs.mkdir(tmp, { recursive: true });
  await replaceFile(tmp, dest);
  // Keep the last BACKUP_KEEP days that have backups (daily and labeled alike).
  const entries = (await fs.readdir(backupsDir())).filter((d) => /^\d{4}-\d{2}-\d{2}(-[\w.-]+)?$/.test(d));
  const keepDays = [...new Set(entries.map((d) => d.slice(0, 10)))].sort().slice(-BACKUP_KEEP);
  for (const old of entries.filter((d) => !keepDays.includes(d.slice(0, 10)))) {
    await fs.rm(path.join(backupsDir(), old), { recursive: true, force: true }).catch(() => {});
  }
  return dest;
}

export async function lastBackup(): Promise<string | null> {
  const days = (await fs.readdir(backupsDir()).catch(() => [] as string[])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return days.at(-1) ?? null;
}

// ---------------------------------------------------------------- work not on a remote

export interface UnpushedBranch {
  branch: string;
  /** Commits on the branch that no remote branch has. */
  commits: number;
  latest: string;
}

/** The project's current branch and the helpers' branches, with commits that exist only here. */
export async function unpushedWork(project: Project): Promise<{ remote: string | null; branches: UnpushedBranch[] }> {
  // Several repositories: each one against its own remote, branches named "repo: branch".
  const repos = projectRepositoriesSync(project);
  if (!repos.length) {
    if (existsSync(path.join(project.directory, ".git"))) return unpushedIn(project.directory, "");
    return { remote: null, branches: [] };
  }
  const remotes = new Set<string>();
  const branches: UnpushedBranch[] = [];
  for (const repo of repos) {
    const found = await unpushedIn(path.join(project.directory, ...repo.split("/")), `${repo}: `);
    if (!found.remote) continue;
    remotes.add(found.remote);
    branches.push(...found.branches);
  }
  return { remote: remotes.size === 0 ? null : remotes.size === 1 ? [...remotes][0] : "each repository's remote", branches };
}

async function unpushedIn(dir: string, label: string): Promise<{ remote: string | null; branches: UnpushedBranch[] }> {
  const remote = (await git(dir, "remote").catch(() => "")).split("\n")[0]?.trim() || null;
  if (!remote) return { remote: null, branches: [] };
  const current = await git(dir, "rev-parse", "--abbrev-ref", "HEAD").catch(() => "");
  const helpers = (await git(dir, "branch", "--list", "symbio/*", "--format=%(refname:short)").catch(() => ""))
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);
  const branches: UnpushedBranch[] = [];
  for (const branch of [...new Set([current, ...helpers].filter((b) => b && b !== "HEAD"))]) {
    const commits = Number(await git(dir, "rev-list", "--count", branch, "--not", "--remotes").catch(() => "0")) || 0;
    if (commits > 0) branches.push({ branch: label + branch, commits, latest: await git(dir, "log", "-1", "--format=%s", branch).catch(() => "") });
  }
  return { remote, branches };
}

// ---------------------------------------------------------------- disk

// Folders that are rebuilt or reinstalled on demand. Only removed when git ignores them.
const BUILD_DIRS = new Set(["bin", "obj", "node_modules", ".vs", "dist", "build", "target", "out", ".next", "__pycache__", ".pytest_cache"]);

export async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          // Await first, then add: `total += await …` reads total before the await, so with many
          // files measured at once each write-back dropped the others (80 GB counted as 4).
          const { size } = await fs.stat(p).catch(() => ({ size: 0 }));
          total += size;
        }
      }),
    );
  };
  await walk(dir);
  return total;
}

/** Git-ignored build folders in a helper's working copy (relative paths). */
async function buildOutputs(dir: string): Promise<string[]> {
  const out = await git(dir, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory").catch(() => "");
  return out
    .split("\n")
    .map((l) => l.trim().replace(/\/$/, ""))
    .filter((p) => p && BUILD_DIRS.has(path.basename(p)));
}

export interface FolderUsage {
  agentId: string;
  name: string;
  status: string;
  bytes: number;
  buildBytes: number;
}

export async function helperFolders(project: Project): Promise<FolderUsage[]> {
  const out: FolderUsage[] = [];
  for (const a of project.agents.filter((a) => a.branch && a.directory !== project.directory && existsSync(a.directory))) {
    const builds = await buildOutputs(a.directory);
    let buildBytes = 0;
    for (const b of builds) buildBytes += await sizeOf(path.join(a.directory, b));
    out.push({ agentId: a.id, name: a.name, status: a.status, bytes: await sizeOf(a.directory), buildBytes });
  }
  return out;
}

/** Deletes a helper's git-ignored build folders. Never touches the project folder itself. */
export async function cleanBuildOutputs(project: Project, agent: Agent): Promise<number> {
  if (!agent.branch || agent.directory === project.directory) throw new Error(`${agent.name} works in the project folder; only helpers' own folders are cleaned.`);
  if (agent.status === "busy" || agent.status === "waiting") throw new Error(`${agent.name} is working; clean its folder when it's idle.`);
  let freed = 0;
  for (const rel of await buildOutputs(agent.directory)) {
    const abs = path.resolve(agent.directory, rel);
    if (!abs.startsWith(path.resolve(agent.directory) + path.sep)) continue;
    freed += await sizeOf(abs);
    await fs.rm(abs, { recursive: true, force: true, maxRetries: 3 });
  }
  return freed;
}

export const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
