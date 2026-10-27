// Deterministic, model-free look at a folder: is it empty, is it git, what kind of
// content does it hold, and does it already have guidance for agents/humans.

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";

export type ContentKind =
  | "documents"
  | "spreadsheets"
  | "presentations"
  | "images"
  | "audio-video"
  | "code"
  | "data"
  | "archives"
  | "other";

export interface FolderInspection {
  directory: string;
  exists: boolean;
  empty: boolean;
  isGit: boolean;
  fileCount: number;
  totalBytes: number;
  /** True when the walk stopped early; counts are then lower bounds. */
  truncated: boolean;
  kinds: Partial<Record<ContentKind, number>>;
  topExtensions: { ext: string; count: number }[];
  topLevel: string[];
  /** Existing guidance files/folders, relative paths (README.md, AGENTS.md, docs/…). */
  guidance: string[];
}

const KIND_BY_EXT: Record<string, ContentKind> = {};
const add = (kind: ContentKind, exts: string) => exts.split(" ").forEach((e) => (KIND_BY_EXT[e] = kind));
add("documents", ".md .markdown .txt .doc .docx .odt .rtf .pdf .tex .rst .adoc .epub .pages");
add("spreadsheets", ".xls .xlsx .ods .numbers .csv .tsv");
add("presentations", ".ppt .pptx .odp .key");
add("images", ".png .jpg .jpeg .gif .webp .svg .bmp .tif .tiff .psd .ai .fig .sketch .xd .heic .ico");
add("audio-video", ".mp3 .wav .ogg .flac .m4a .mp4 .mov .avi .mkv .webm");
add(
  "code",
  ".js .mjs .cjs .ts .tsx .jsx .py .rb .go .rs .java .kt .cs .fs .vb .cpp .cc .c .h .hpp .swift .php .scala .lua .r .dart .ex .exs .clj .sh .ps1 .bat .sql .html .css .scss .vue .svelte .ipynb .sln .csproj",
);
add("data", ".json .yaml .yml .xml .toml .ini .parquet .db .sqlite .sqlite3 .geojson .ndjson .jsonl");
add("archives", ".zip .tar .gz .7z .rar .tgz");

// Folders that are tooling noise, not project content.
const SKIP_DIRS = new Set([
  ".git",
  ".symbio",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "bin",
  "obj",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  ".idea",
  ".vs",
  ".vscode",
]);

const GUIDANCE = ["README.md", "README", "README.txt", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "docs", "doc"];

const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 10;

export async function inspectFolder(input: string): Promise<FolderInspection> {
  const directory = path.resolve(input);
  const result: FolderInspection = {
    directory,
    exists: false,
    empty: true,
    isGit: false,
    fileCount: 0,
    totalBytes: 0,
    truncated: false,
    kinds: {},
    topExtensions: [],
    topLevel: [],
    guidance: [],
  };

  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) return result;
  result.exists = true;
  result.isGit = existsSync(path.join(directory, ".git"));

  const top = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const visibleTop = top.filter((e) => e.name !== ".symbio");
  result.empty = visibleTop.length === 0;
  result.topLevel = visibleTop
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
    .slice(0, 40);
  const lowerTop = new Map(visibleTop.map((e) => [e.name.toLowerCase(), e]));
  for (const name of GUIDANCE) {
    const entry = lowerTop.get(name.toLowerCase());
    if (entry) result.guidance.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
  }

  const extCounts = new Map<string, number>();
  let seen = 0;
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      result.truncated = true;
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) {
        result.truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      result.fileCount++;
      const size = (await fs.stat(full).catch(() => null))?.size ?? 0;
      result.totalBytes += size;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      const kind = KIND_BY_EXT[ext] ?? "other";
      result.kinds[kind] = (result.kinds[kind] ?? 0) + 1;
    }
  };
  await walk(directory, 0);

  result.topExtensions = [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => ({ ext, count }));
  return result;
}

/** Plain-text summary for agent briefs. */
export function describeInspection(i: FolderInspection): string {
  if (!i.exists) return "The folder does not exist yet; it will be created empty.";
  if (i.empty) return "The folder is empty — this is a new project.";
  const kinds = Object.entries(i.kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const lines = [
    `The folder already has content: ${i.fileCount}${i.truncated ? "+" : ""} files, ${formatBytes(i.totalBytes)}.`,
    `Content by kind: ${kinds}.`,
    `Most common extensions: ${i.topExtensions.map((e) => `${e.ext} (${e.count})`).join(", ") || "none"}.`,
    `Top level: ${i.topLevel.join(", ")}.`,
    i.guidance.length ? `Existing guidance: ${i.guidance.join(", ")}.` : "No README, AGENTS.md or docs folder.",
    i.isGit ? "It is a git repository." : "It is not a git repository.",
  ];
  return lines.join("\n");
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
