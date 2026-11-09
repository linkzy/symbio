// read_document: the text of documents agents can't (or shouldn't) open with the read tool.
// OpenCode's read tool puts a whole PDF into the conversation as data (sent again every turn, like
// images) and refuses Office files as binary. This returns their text, a part at a time.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { isSecretPath } from "./guard.js";

export const DOCUMENT_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "odt", "txt", "md", "csv", "tsv", "json", "xml", "html", "htm"];
const MAX_CHARS = 40_000; // per call; agents ask for the next part
const MAX_BYTES = 100 * 1024 * 1024;

export async function readDocument(folder: string, input: { path?: unknown; pages?: unknown; from?: unknown }): Promise<string> {
  const given = String(input.path ?? "").trim();
  if (!given) throw new Error("Give the document's path.");
  const file = path.resolve(folder, given);
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.includes(ext)) throw new Error(`Not a document read_document understands (${DOCUMENT_EXTENSIONS.join(", ")}): ${given}`);
  if (isSecretPath(file)) throw new Error(`Not allowed: ${given}`);
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  const stat = await fs.stat(file);
  if (stat.size > MAX_BYTES) throw new Error(`${given} is ${Math.round(stat.size / 1024 / 1024)} MB; documents up to ${MAX_BYTES / 1024 / 1024} MB can be read.`);
  const data = await fs.readFile(file);

  if (ext === "pdf") return readPdf(given, data, String(input.pages ?? ""));
  const from = Math.max(0, Math.floor(Number(input.from) || 0));
  let text: string;
  let unit = "";
  if (ext === "docx") text = docxText(data);
  else if (ext === "odt") text = odtText(data);
  else if (ext === "xlsx") {
    text = xlsxText(data);
    unit = " (sheets as tab-separated rows)";
  } else if (ext === "pptx") text = pptxText(data);
  else text = data.toString("utf8");
  return page(given, text, from, unit);
}

/** A slice of a long text, with how to get the next one. */
function page(name: string, text: string, from: number, unit = ""): string {
  const total = text.length;
  if (!total) return `${name}: no text found${unit}.`;
  const slice = text.slice(from, from + MAX_CHARS);
  const end = from + slice.length;
  const more = end < total ? `\n\n[… characters ${from + 1}–${end} of ${total}; for the next part call read_document with from=${end}]` : "";
  return `${name}${unit}${from || more ? `, characters ${from + 1}–${end} of ${total}` : ""}:\n\n${slice}${more}`;
}

async function readPdf(name: string, data: Buffer, pages: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const all = text as string[];
  let [first, last] = [1, totalPages];
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(pages);
  if (m) {
    first = Math.min(Math.max(1, Number(m[1])), totalPages);
    last = Math.min(Math.max(first, Number(m[2] ?? m[1])), totalPages);
  }
  const out: string[] = [];
  let used = 0;
  let p = first;
  for (; p <= last; p++) {
    const t = `--- page ${p} ---\n${(all[p - 1] ?? "").trim()}`;
    if (used + t.length > MAX_CHARS && out.length) break;
    out.push(t);
    used += t.length;
  }
  const shown = p - 1;
  const noText = all.every((t) => !t.trim());
  const head = `${name}: ${totalPages} page${totalPages === 1 ? "" : "s"}, showing ${first}–${shown}.`;
  if (noText) return `${head} It has no text layer (probably scanned images): ask the human for a text version, or for the pages as images to look at with view_image.`;
  const more = shown < totalPages ? `\n\n[… for more, call read_document with pages="${shown + 1}-${Math.min(totalPages, shown + 20)}"]` : "";
  return `${head}\n\n${out.join("\n\n")}${more}`;
}

const unzip = (data: Buffer) => unzipSync(new Uint8Array(data));
const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Word: paragraphs (w:p) of w:t runs; tabs and breaks kept; table cells separated by tabs. */
function docxText(data: Buffer): string {
  const files = unzip(data);
  const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]) : "";
  if (!xml) throw new Error("This doesn't look like a Word document (no word/document.xml).");
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => decode(l).trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** OpenDocument text: paragraphs and headings of content.xml. */
function odtText(data: Buffer): string {
  const files = unzip(data);
  const xml = files["content.xml"] ? strFromU8(files["content.xml"]) : "";
  if (!xml) throw new Error("This doesn't look like an OpenDocument text (no content.xml).");
  return decode(xml.replace(/<text:tab\/>/g, "\t").replace(/<\/text:(p|h)>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
}

/** Excel: every sheet, by name, as tab-separated rows (shared strings, inline strings, numbers). */
function xlsxText(data: Buffer): string {
  const files = unzip(data);
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : "");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, "")));
  const workbook = read("xl/workbook.xml");
  const rels = read("xl/_rels/workbook.xml.rels");
  const target = (rid: string) => /Target="([^"]+)"/.exec(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*>`).exec(rels)?.[0] ?? "")?.[1];
  const sheets = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: decode(m[1]), file: target(m[2]) }));
  if (!sheets.length) throw new Error("This doesn't look like an Excel workbook (no sheets found).");
  const col = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "A")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return sheets
    .map(({ name, file }) => {
      const xml = file ? read(`xl/${file.replace(/^\/?xl\//, "")}`) : "";
      const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        const cells: string[] = [];
        for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const body = c[2] ?? "";
          const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
          const type = /t="([^"]+)"/.exec(attrs)?.[1];
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? decode(body.replace(/<[^>]+>/g, "")) : decode(v ?? "");
          cells[ref ? col(ref) : cells.length] = value.replace(/\s*\n\s*/g, " ");
        }
        return Array.from(cells, (x) => x ?? "").join("\t").trimEnd();
      });
      return `## ${name}\n${rows.filter((r) => r).join("\n")}`;
    })
    .join("\n\n");
}

/** PowerPoint: the text of each slide, in order. */
function pptxText(data: Buffer): string {
  const files = unzip(data);
  const slides = Object.keys(files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!slides.length) throw new Error("This doesn't look like a PowerPoint presentation (no slides found).");
  return slides
    .map((f, i) => {
      const xml = strFromU8(files[f]);
      const text = decode(xml.replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{2,}/g, "\n").trim();
      return `--- slide ${i + 1} ---\n${text}`;
    })
    .join("\n\n");
}
