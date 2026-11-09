// Files the human attaches to messages (uploaded, dropped or pasted in the chat), kept per project
// in .symbio/attachments (git-ignored with the rest of .symbio) with an index: the project's
// gallery. Agents get the files' full paths in the message, so helpers in their own copies can
// open them too; images through view_image, documents through read_document.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { IMAGE_EXTENSIONS } from "./guard.js";
import { DOCUMENT_EXTENSIONS } from "./documents.js";
import { newId, type Project } from "./store.js";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface Attachment {
  id: string;
  /** The name it was given (what the human sees). */
  name: string;
  mime: string;
  size: number;
  /** Absolute path of the stored copy. */
  file: string;
  addedAt: number;
  /** Who it was sent to, and when (agent ids). */
  sentTo: { agentId: string; at: number }[];
}

const dir = (project: Project) => path.join(project.directory, ".symbio", "attachments");
const indexFile = (project: Project) => path.join(project.directory, ".symbio", "attachments.json");

// One write at a time per project (several files are often dropped at once).
const queues = new Map<string, Promise<unknown>>();
function serial<T>(project: Project, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(project.id) ?? Promise.resolve()).then(fn);
  queues.set(project.id, run.catch(() => {}));
  return run;
}

export async function listAttachments(project: Project): Promise<Attachment[]> {
  const raw = await fs.readFile(indexFile(project), "utf8").catch(() => "[]");
  const all = JSON.parse(raw) as Attachment[];
  return all.filter((a) => existsSync(a.file));
}

async function save(project: Project, list: Attachment[]) {
  await fs.mkdir(path.dirname(indexFile(project)), { recursive: true });
  const tmp = `${indexFile(project)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2));
  await fs.rename(tmp, indexFile(project));
}

/** A file name safe on every OS, keeping the extension. */
export function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).normalize("NFC");
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(-120);
  return cleaned || "file";
}

export async function addAttachment(project: Project, name: string, data: Uint8Array, mime: string): Promise<Attachment> {
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  return serial(project, async () => {
    const id = newId("att");
    const clean = safeName(name);
    // The id keeps names unique; the readable name stays visible to agents and in file managers.
    const file = path.join(dir(project), `${id.slice(4, 12)}-${clean}`);
    await fs.mkdir(dir(project), { recursive: true });
    await fs.writeFile(file, data);
    const record: Attachment = { id, name: clean, mime: mime || "application/octet-stream", size: data.byteLength, file, addedAt: Date.now(), sentTo: [] };
    const list = await listAttachments(project);
    list.push(record);
    await save(project, list);
    return record;
  });
}

export async function getAttachments(project: Project, ids: string[]): Promise<Attachment[]> {
  const all = await listAttachments(project);
  const found = ids.map((id) => all.find((a) => a.id === id));
  const missing = ids.filter((_, i) => !found[i]);
  if (missing.length) throw new Error(`Attachment not found: ${missing.join(", ")}`);
  return found as Attachment[];
}

export async function markSent(project: Project, ids: string[], agentId: string) {
  await serial(project, async () => {
    const list = await listAttachments(project);
    for (const a of list) if (ids.includes(a.id)) a.sentTo.push({ agentId, at: Date.now() });
    await save(project, list);
  });
}

export async function removeAttachment(project: Project, id: string) {
  await serial(project, async () => {
    const list = await listAttachments(project);
    const target = list.find((a) => a.id === id);
    if (!target) throw new Error("Attachment not found");
    await fs.rm(target.file, { force: true });
    await save(project, list.filter((a) => a.id !== id));
  });
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** What the agent reads below the human's message: each file's full path and how to open it. */
export function attachmentNote(files: Attachment[]): string {
  if (!files.length) return "";
  const how = (a: Attachment) => {
    const ext = path.extname(a.name).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(ext)) return "image: look at it with view_image";
    if (ext === "pdf" || ["docx", "xlsx", "pptx", "odt"].includes(ext)) return "document: read it with read_document";
    if (DOCUMENT_EXTENSIONS.includes(ext)) return "text: read it with read (or read_document for long ones)";
    return "open it with the tools that fit its type";
  };
  // Seen live: without naming the tools' home, a model first tried webfetch and the read tool.
  return (
    `\n\n[Attached by the human — ${files.length === 1 ? "a file" : `${files.length} files`}, saved in the project:]\n` +
    files.map((a) => `- ${a.file} (${a.name}, ${kb(a.size)}; ${how(a)})`).join("\n") +
    "\n(view_image and read_document are Symbio's tools: tools.symbio.view_image / tools.symbio.read_document, with the path above.)"
  );
}
