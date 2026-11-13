// Finding file paths in what agents write ("Abra docs/regras/checagem-ia.md. Linha 6"), so they can
// become links. Candidates only: the server says which exist (POST …/files/resolve), and only those
// are linked. Pure functions (no React), unit-tested in tests/paths.test.ts.

export interface PathMatch {
  path: string;
  /** The line mentioned with it ("file.md:12", "file.md#L12", "file.md, line 12", "Linha 12"). */
  line?: number;
  start: number;
  end: number;
}

// A path with at least one separator, ending in a file name with an extension that starts with a
// letter (so "v0.12.0" or "3.5/10" aren't paths). Windows drive letters and ./ ../ allowed.
const WITH_SEPARATOR = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@~$()+.\-]+[\\/])+[\w@~$()+\-][\w@~$()+.\-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
// Inside `code` a bare file name counts too ("`padrao.md`").
const BARE_NAME = /^[\w@~$()+\-][\w@~$()+.\-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const AFTER = /^(?::(\d+)|#L(\d+)|[.,;]?\s*\(?(?:line|lines|linha|linhas|l\.)\s*(\d+))/i;

/** File paths in a piece of plain text, with a line number when one follows. */
export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  for (const m of text.matchAll(WITH_SEPARATOR)) {
    const start = m.index ?? 0;
    // Not part of a URL (https://host/a/b.html) or of a longer word.
    const wordBefore = text.slice(0, start).split(/\s/).pop() ?? "";
    if (/:\/|[\w\-/]$/.test(wordBefore)) continue;
    let path = m[0];
    // A sentence's final period isn't part of the path ("…/checagem-ia.md." is caught as ".md" anyway).
    const after = AFTER.exec(text.slice(start + path.length));
    const line = after ? Number(after[1] ?? after[2] ?? after[3]) : undefined;
    // "file.md:12" → the ":12" is part of the link text.
    const end = start + path.length + (after && (after[1] || after[2]) ? after[0].length : 0);
    path = path.replace(/\\/g, "/");
    out.push({ path, ...(line ? { line } : {}), start, end });
  }
  return out;
}

/** An inline `code` span that is a path (or a bare file name). */
export function codePath(code: string): { path: string; line?: number } | null {
  const text = code.trim();
  if (/\s/.test(text) || /:\/\//.test(text)) return null;
  const m = /^(.*?)(?::(\d+)|#L(\d+))?$/.exec(text);
  const candidate = m?.[1] ?? text;
  const line = m && (m[2] || m[3]) ? Number(m[2] ?? m[3]) : undefined;
  const all = findPaths(candidate);
  if (all.length === 1 && all[0].start === 0 && all[0].end === candidate.length) return { path: all[0].path, ...(line ? { line } : {}) };
  if (BARE_NAME.test(candidate)) return { path: candidate, ...(line ? { line } : {}) };
  return null;
}

// Links carry the path in the fragment, which react-markdown's URL check lets through.
const PREFIX = "#symbio-file=";
export const fileHref = (path: string, line?: number) => `${PREFIX}${encodeURIComponent(path)}${line ? `&line=${line}` : ""}`;
export function parseFileHref(href: string | undefined): { path: string; line?: number } | null {
  if (!href?.startsWith(PREFIX)) return null;
  const [p, l] = href.slice(PREFIX.length).split("&line=");
  return { path: decodeURIComponent(p), ...(l ? { line: Number(l) } : {}) };
}

type Node = { type: string; value?: string; url?: string; children?: Node[] };
const SKIP = new Set(["link", "linkReference", "code", "html", "definition"]);

/** remark plugin: paths in text and `code` become links (the page then shows only those that exist). */
export function remarkPaths() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (!node.children) return;
      const next: Node[] = [];
      for (const child of node.children) {
        if (child.type === "text" && child.value) {
          let at = 0;
          for (const m of findPaths(child.value)) {
            if (m.start > at) next.push({ type: "text", value: child.value.slice(at, m.start) });
            next.push({ type: "link", url: fileHref(m.path, m.line), children: [{ type: "text", value: child.value.slice(m.start, m.end) }] });
            at = m.end;
          }
          if (at < child.value.length) next.push(at === 0 ? child : { type: "text", value: child.value.slice(at) });
        } else if (child.type === "inlineCode" && child.value) {
          const p = codePath(child.value);
          next.push(p ? { type: "link", url: fileHref(p.path, p.line), children: [child] } : child);
        } else {
          if (!SKIP.has(child.type)) walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}
