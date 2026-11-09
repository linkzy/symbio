// Projects made of several git repositories: a folder (not itself a repository) whose subfolders
// are, e.g. game/client, game/server, game/admin, each with its own remote. Symbio works inside
// each of them instead of creating a repository of its own on top.

import { existsSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import type { Agent, Project } from "./store.js";

// Never repositories of the project's own (tooling, dependencies, Symbio's data).
const SKIP = new Set([".git", ".symbio", "node_modules", ".venv", "venv", "__pycache__", "bin", "obj", "dist", "build", "target", ".next", ".cache", ".idea", ".vs", ".vscode"]);

/** Git repositories in subfolders (up to `depth` levels down), as relative paths with "/". A repository's own subfolders aren't searched. */
export function listRepositories(dir: string, depth = 2): string[] {
  const found: string[] = [];
  const walk = (abs: string, rel: string, left: number) => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (existsSync(path.join(childAbs, ".git"))) found.push(childRel);
      else if (left > 1) walk(childAbs, childRel, left - 1);
    }
  };
  walk(dir, "", depth);
  return found.sort((a, b) => a.localeCompare(b));
}

export const findRepositories = async (dir: string, depth = 2) => listRepositories(dir, depth);

export const isGitDir = (dir: string) => existsSync(path.join(dir, ".git"));

/**
 * The repositories a project works in, when there are several: the subfolders' repositories when
 * the folder isn't one itself, or when the project was switched to them (subRepositories). Empty
 * for a single repository, or no git.
 */
export function projectRepositoriesSync(project: Project): string[] {
  if (isGitDir(project.directory) && !project.subRepositories) return [];
  return listRepositories(project.directory);
}

export const projectRepositories = async (project: Project) => projectRepositoriesSync(project);

/** The repository an agent's git work happens in: its chosen sub-repository, or the project folder. */
export function repoRoot(project: Project, agent: Pick<Agent, "repo">): string {
  return agent.repo ? path.join(project.directory, ...agent.repo.split("/")) : project.directory;
}

/** A repository the agent named (relative to the project), checked to be one of the project's. */
export async function resolveRepository(project: Project, repo: string): Promise<string> {
  const rel = repo.trim().replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "");
  const repos = await projectRepositories(project);
  if (!repos.includes(rel)) {
    throw new Error(
      repos.length
        ? `"${repo}" isn't one of this project's repositories: ${repos.join(", ")}.`
        : "This project isn't made of several repositories, so there's no repository to choose.",
    );
  }
  return rel;
}

/**
 * A repository at the top of the project that contains other repositories as bare pointers
 * (gitlinks with no .gitmodules): typically one Symbio created over a folder of repositories,
 * before it knew to look for them. Returns those inner repositories, or [] when it isn't the case.
 */
export async function swallowedRepositories(dir: string): Promise<{ inner: string[]; createdBySymbio: boolean }> {
  if (!isGitDir(dir) || existsSync(path.join(dir, ".gitmodules"))) return { inner: [], createdBySymbio: false };
  const inner = await findRepositories(dir);
  if (!inner.length) return { inner: [], createdBySymbio: false };
  const first = await git(dir, "log", "--reverse", "--format=%s", "--max-count=1").catch(() => "");
  const root = (await git(dir, "rev-list", "--max-parents=0", "HEAD").catch(() => "")).split("\n")[0];
  const firstSubject = root ? await git(dir, "log", "-1", "--format=%s", root).catch(() => first) : first;
  return { inner, createdBySymbio: firstSubject.trim() === "Initial snapshot (created by Symbio)" };
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

/**
 * Which repository git_push / git_pull act on, relative to the project folder (null = the
 * agent's own folder). Helpers in their own copy push that copy. Agents in the project folder of
 * a project made of several repositories name one (shared helpers default to the one they were given).
 */
export async function gitRepoFor(project: Project, agent: Pick<Agent, "directory" | "repo">, repo?: string): Promise<string | null> {
  if (!samePath(agent.directory, project.directory)) {
    if (repo) throw new Error("You work in your own copy of a repository: push and pull apply to it, without repo.");
    return null;
  }
  if (repo) return resolveRepository(project, repo);
  const repos = await projectRepositories(project);
  if (!repos.length) return null;
  if (agent.repo) return agent.repo;
  throw new Error(`This project is made of several repositories (${repos.join(", ")}); say which one with repo.`);
}

/**
 * What the coordinator needs to decide whether to switch a project to its inner repositories:
 * who created the outer one, whether it has a remote, its history, and helpers working in copies of it.
 */
export async function describeOuterRepository(project: Project): Promise<string> {
  const dir = project.directory;
  const { inner, createdBySymbio } = await swallowedRepositories(dir);
  if (!inner.length) {
    return project.subRepositories
      ? "Symbio works in this project's inner repositories, but none were found now."
      : "The project folder doesn't contain other git repositories (or tracks them as submodules): nothing to switch.";
  }
  const remotes = (await git(dir, "remote").catch(() => "")).split("\n").map((r) => r.trim()).filter(Boolean);
  const count = Number(await git(dir, "rev-list", "--count", "HEAD").catch(() => "0")) || 0;
  const recent = (await git(dir, "log", "-5", "--format=%s").catch(() => "")).split("\n").filter(Boolean);
  const copies = project.agents.filter((a) => a.role === "worker" && a.status !== "stopped" && a.branch && !a.repo);
  return [
    `The project folder is a git repository that contains ${inner.length} other repositories (${inner.join(", ")}) without tracking ` +
      "their files (bare pointers, not submodules).",
    createdBySymbio
      ? "The outer repository was created by Symbio when the project was added (its first commit is Symbio's snapshot)."
      : "The outer repository was not created by Symbio: someone made it on purpose.",
    remotes.length ? `Its remotes: ${remotes.join(", ")}.` : "It has no remote.",
    `Its history: ${count} commit(s)${recent.length ? `; latest: ${recent.map((s) => `"${s}"`).join(", ")}` : ""}.`,
    copies.length
      ? `Helpers with their own copy of the outer repository: ${copies.map((a) => `${a.name} (${a.status})`).join(", ")}.`
      : "No active helper has its own copy of the outer repository.",
    project.subRepositories
      ? "Now: Symbio works in the inner repositories and leaves the outer one alone."
      : "Now: Symbio works in the outer repository, so helpers' own copies have the inner repositories as empty folders.",
    "Switching (action use) changes nothing on disk: the outer .git and every file stay where they are. From then on a helper's own " +
      "copy comes from one inner repository (spawn_agent repo), merges and pushes go to it, and the outer repository is left alone. " +
      "Action stop switches back.",
  ].join("\n");
}
