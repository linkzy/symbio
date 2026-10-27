// Agent documentation: AGENTS.md + docs/ in the project folder ("project"), or
// .symbio/docs/ ("private"). Only these locations are readable/writable here.

import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import type { Project } from "./store.js";

export interface DocFile {
  path: string; // relative to the docs root, forward slashes
  size: number;
  modified: number;
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt"]);
const MAX_FILES = 500;

export function docsRoot(project: Project): string {
  return project.docsLocation === "private" ? path.join(project.directory, ".symbio", "docs") : project.directory;
}

/** Where agents should write docs, as absolute paths, for briefs. */
export function docsPaths(project: Project) {
  const root = docsRoot(project);
  return { entry: path.join(root, "AGENTS.md"), folder: path.join(root, project.docsLocation === "private" ? "" : "docs") };
}

export async function listDocs(project: Project): Promise<DocFile[]> {
  const root = docsRoot(project);
  const files: DocFile[] = [];
  const add = async (abs: string) => {
    const st = await fs.stat(abs).catch(() => null);
    if (st?.isFile()) files.push({ path: toRel(root, abs), size: st.size, modified: st.mtimeMs });
  };
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) await add(abs);
    }
  };

  if (project.docsLocation === "private") {
    await walk(root);
  } else {
    await add(path.join(root, "AGENTS.md"));
    await walk(path.join(root, "docs"));
  }
  return files.sort((a, b) => (a.path === "AGENTS.md" ? -1 : b.path === "AGENTS.md" ? 1 : a.path.localeCompare(b.path)));
}

export async function readDoc(project: Project, rel: string): Promise<string> {
  return fs.readFile(resolveDoc(project, rel), "utf8");
}

export async function writeDoc(project: Project, rel: string, content: string): Promise<void> {
  const abs = resolveDoc(project, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

/** Validates a doc path against the allowed locations. Throws on anything else. */
function resolveDoc(project: Project, rel: string): string {
  const root = docsRoot(project);
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, normalized);
  const relBack = toRel(root, abs);
  const insideRoot = !relBack.startsWith("..") && !path.isAbsolute(relBack);
  const allowed =
    project.docsLocation === "private"
      ? insideRoot
      : insideRoot && (relBack === "AGENTS.md" || relBack.startsWith("docs/"));
  if (!allowed || !TEXT_EXT.has(path.extname(abs).toLowerCase())) {
    throw new Error(`Not a docs file: ${rel}`);
  }
  // A symlink inside the docs could point at any file (an SSH key, say); compare real
  // paths (of the file, or of its folder for a file about to be written).
  const probe = existsSync(abs) ? abs : path.dirname(abs);
  if (existsSync(probe) && existsSync(root)) {
    const real = path.relative(realpathSync(root), realpathSync(probe));
    if (real.startsWith("..") || path.isAbsolute(real)) throw new Error(`Not a docs file: ${rel}`);
  }
  return abs;
}

/**
 * For private docs: the text injected into every agent, since agents (and
 * OpenCode's automatic AGENTS.md loading) can't see .symbio/docs on their own.
 */
export async function privateDocsInstruction(project: Project): Promise<string | null> {
  if (project.docsLocation !== "private") return null;
  const files = await listDocs(project);
  if (files.length === 0) return null;
  const root = docsRoot(project);
  const entry = files.find((f) => f.path === "AGENTS.md");
  const body = entry ? await readDoc(project, entry.path).catch(() => "") : "";
  const others = files.filter((f) => f !== entry).map((f) => `- ${path.join(root, f.path)}`);
  return [
    "# Project documentation (private, kept outside the project files)",
    body.slice(0, 40_000),
    others.length ? `\nMore documentation you can read when relevant:\n${others.join("\n")}` : "",
  ].join("\n");
}

function toRel(root: string, abs: string) {
  return path.relative(root, abs).replace(/\\/g, "/");
}
