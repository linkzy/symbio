// The project's files as the human sees them from the chat: paths agents mention become links, and
// files agents share (share_file) show in the chat and the Files tab. A path is looked up in the
// project folder and in helpers' own copies (a file on a helper's branch exists only there until
// it's merged), relative to whoever mentioned it first. Only files inside those folders are served,
// never git's internals, Symbio's own files or things that look like secrets.

import { createReadStream, existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { newId, type Agent, type Project } from "./store.js";
import { replaceFile } from "./fsutil.js";

export type FileKind = "markdown" | "text" | "image" | "video" | "audio" | "pdf" | "other";

export interface ResolvedFile {
  /** Absolute path on this machine (server-side only). */
  abs: string;
  /** Relative to the folder it was found in, forward slashes (what the browser sees). */
  rel: string;
  /** "project", or the name of the helper whose copy it's in. */
  where: string;
  /** The agent whose folder it's in (null: the project folder). */
  agentId: string | null;
  kind: FileKind;
  mime: string;
  size: number;
}

const KINDS: Record<string, [FileKind, string]> = {
  ".md": ["markdown", "text/markdown"],
  ".markdown": ["markdown", "text/markdown"],
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"],
  ".webp": ["image", "image/webp"],
  ".bmp": ["image", "image/bmp"],
  ".avif": ["image", "image/avif"],
  ".mp4": ["video", "video/mp4"],
  ".webm": ["video", "video/webm"],
  ".mov": ["video", "video/quicktime"],
  ".m4v": ["video", "video/mp4"],
  ".mp3": ["audio", "audio/mpeg"],
  ".wav": ["audio", "audio/wav"],
  ".ogg": ["audio", "audio/ogg"],
  ".m4a": ["audio", "audio/mp4"],
  ".flac": ["audio", "audio/flac"],
  ".pdf": ["pdf", "application/pdf"],
};
// Shown as text in the viewer (code, data, logs). Anything else downloads.
const TEXT = new Set(
  ".txt .log .csv .tsv .json .jsonc .yml .yaml .xml .toml .ini .cfg .conf .html .htm .css .scss .less .js .jsx .ts .tsx .mjs .cjs .cs .cshtml .razor .vb .fs .java .kt .py .rb .php .go .rs .c .h .cpp .hpp .swift .sql .sh .ps1 .psm1 .bat .cmd .gradle .props .targets .csproj .sln .vue .svelte .graphql .proto .tex .rst .adoc .srt .vtt"
    .split(" "),
);

export function kindOf(file: string): { kind: FileKind; mime: string } {
  const ext = path.extname(file).toLowerCase();
  const known = KINDS[ext];
  if (known) return { kind: known[0], mime: known[1] };
  if (TEXT.has(ext)) return { kind: "text", mime: "text/plain; charset=utf-8" };
  return { kind: "other", mime: "application/octet-stream" };
}

/** Paths never served: git's internals, Symbio's own data (except attachments and docs), secrets. */
export function refused(rel: string): string | null {
  const parts = rel.split("/");
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (parts.includes(".git")) return "git's internal files aren't shown";
  if (parts[0] === ".symbio" && !["attachments", "docs"].includes(parts[1] ?? "")) return "Symbio's own files aren't shown";
  if (/^\.env(\.|$)/.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(name) || /\.(pem|key|pfx|p12|ppk|keystore|jks)$/.test(name) || /^\.?(netrc|npmrc|pgpass)$/.test(name)) {
    return "files that may hold secrets aren't shown";
  }
  return null;
}

/** The folders a path can be in: the agent's own first (it mentioned the path), then the project, then other helpers'. */
function roots(project: Project, agent?: Agent | null): { dir: string; where: string; agentId: string | null }[] {
  const list: { dir: string; where: string; agentId: string | null }[] = [];
  const add = (dir: string, where: string, agentId: string | null) => {
    if (dir && !list.some((r) => samePath(r.dir, dir))) list.push({ dir, where, agentId });
  };
  if (agent && agent.branch) add(agent.directory, agent.name, agent.id);
  add(project.directory, "project", null);
  for (const a of project.agents) if (a.branch) add(a.directory, a.name, a.id);
  return list;
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Finds a file the way an agent meant it. Returns null when it doesn't exist; throws when it isn't allowed. */
export async function resolveFile(project: Project, given: string, agent?: Agent | null): Promise<ResolvedFile | null> {
  const cleaned = given.trim().replace(/^["'`]|["'`]$/g, "").replace(/^file:\/\/\/?/i, "");
  if (!cleaned || cleaned.length > 1000) return null;
  for (const root of roots(project, agent)) {
    const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(root.dir, cleaned);
    if (!existsSync(abs)) continue;
    // Real paths, so a symlink inside the folder can't point outside it.
    let real: string;
    let realRoot: string;
    try {
      real = realpathSync(abs);
      realRoot = realpathSync(root.dir);
    } catch {
      continue;
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // an absolute path in another folder
    const relSlash = rel.split(path.sep).join("/");
    const st = await fs.stat(real).catch(() => null);
    if (!st?.isFile()) continue;
    const why = refused(relSlash);
    if (why) throw new Error(`${relSlash}: ${why}.`);
    return { abs: real, rel: relSlash, where: root.where, agentId: root.agentId, ...kindOf(real), size: st.size };
  }
  return null;
}

/** A file's bytes for the browser, with ranges so videos can seek. */
export function fileResponse(file: ResolvedFile, opts: { download?: boolean; range?: string | null }): Response {
  const inline = !opts.download && file.kind !== "other";
  // Markdown and code are shown as plain text when opened directly; the viewer page renders them.
  const type = file.kind === "markdown" || file.kind === "text" ? "text/plain; charset=utf-8" : inline ? file.mime : "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(file.abs))}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self' blob: data:; media-src 'self'; style-src 'unsafe-inline'",
    "accept-ranges": "bytes",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(opts.range ?? "");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, file.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), file.size - 1) : file.size - 1;
    if (start >= file.size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.size}` } });
    const stream = Readable.toWeb(createReadStream(file.abs, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${file.size}`, "content-length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(createReadStream(file.abs)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "content-length": String(file.size) } });
}

// ---------------------------------------------------------------- files agents share

export interface SharedFile {
  id: string;
  /** As the agent gave it, and where it was found then. */
  path: string;
  rel: string;
  where: string;
  agentId: string;
  caption?: string;
  kind: FileKind;
  size: number;
  at: number;
}

const sharedIndex = (project: Project) => path.join(project.directory, ".symbio", "shared-files.json");

export async function listShared(project: Project): Promise<SharedFile[]> {
  const raw = await fs.readFile(sharedIndex(project), "utf8").catch(() => "[]");
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Records a file an agent shared. The file stays where it is (videos can be large); the record keeps where. */
export async function addShared(project: Project, agent: Agent, given: string, caption?: string): Promise<SharedFile> {
  const file = await resolveFile(project, given, agent);
  if (!file) throw new Error(`Not found: ${given}. Give a path inside the project folder or your working folder.`);
  const list = await listShared(project);
  const entry: SharedFile = {
    id: newId("shf"),
    path: given.trim(),
    rel: file.rel,
    where: file.where,
    agentId: agent.id,
    ...(caption?.trim() ? { caption: caption.trim().slice(0, 500) } : {}),
    kind: file.kind,
    size: file.size,
    at: Date.now(),
  };
  list.push(entry);
  await fs.mkdir(path.dirname(sharedIndex(project)), { recursive: true });
  const tmp = `${sharedIndex(project)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list.slice(-1000), null, 2));
  await replaceFile(tmp, sharedIndex(project));
  return entry;
}
