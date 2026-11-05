import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, FileText, Folder, Pencil, Save, Search, X } from "lucide-react";
import { api, subscribe, type DocFile, type DocMatch, type Project } from "./api";
import { EmptyState, timeAgo } from "./ui";

/** Where to land in a doc after opening it: a heading anchor, a line (text files), or a line's text (Markdown). */
type Target = { anchor?: string; line?: number; text?: string } | null;

export function Docs({ project }: { project: Project }) {
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ matches: DocMatch[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [target, setTarget] = useState<Target>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const editingRef = useRef(false);
  editingRef.current = editing;
  const body = useRef<HTMLDivElement>(null);

  const loadList = useCallback(
    () =>
      api
        .docs(project.id)
        .then((d) => {
          setFiles(d.files);
          setRoot(d.root);
        })
        .catch((e) => setError(e.message)),
    [project.id],
  );

  const loadFile = useCallback(
    (path: string) =>
      api
        .readDoc(project.id, path)
        .then((d) => setContent(d.content))
        .catch((e) => setError(e.message)),
    [project.id],
  );

  useEffect(() => {
    void loadList();
    // Agents write docs while they work: refresh after tool calls finish (debounced).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((e) => {
      if (e.type !== "agent.stream" || e.projectId !== project.id) return;
      if (e.event.type !== "session.tool.success" && !e.event.type.startsWith("session.execution.")) return;
      clearTimeout(timer);
      timer = setTimeout(() => void loadList(), 800);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [project.id, loadList]);

  // Select the entry point by default; reload the open file when the list changes (unless editing).
  useEffect(() => {
    if (!files?.length) return;
    const current = selected && files.some((f) => f.path === selected) ? selected : files[0].path;
    if (current !== selected) setSelected(current);
    else if (!editingRef.current) void loadFile(current);
    // Top-level folders start open.
    const top = files.filter((f) => f.path.includes("/")).map((f) => f.path.split("/")[0]);
    setExpanded((prev) => new Set([...prev, ...top]));
  }, [files]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected) {
      setEditing(false);
      setContent(null);
      void loadFile(selected);
      // Show where the open doc sits in the tree.
      setExpanded((prev) => new Set([...prev, ...ancestors(selected)]));
    }
  }, [selected, loadFile]);

  // Search as you type (debounced).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .searchDocs(project.id, q)
        .then(setResults)
        .catch((e) => setError(e.message))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, project.id]);

  // Land on the target once the doc is on screen. The page fades in after the old one fades
  // out, so it may not be mounted yet when the content arrives: try for a moment.
  useEffect(() => {
    if (content === null || editing || !target) return;
    let tries = 0;
    const timer = setInterval(() => {
      if ((body.current && reveal(body.current, target)) || ++tries > 20) {
        clearInterval(timer);
        setTarget(null);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  const paths = useMemo(() => new Set(files?.map((f) => f.path)), [files]);

  /** Opens a doc (or a place in the current one), remembering where we were for Back. */
  const open = (path: string, to: Target = null) => {
    if (path === selected) {
      if (to && body.current) reveal(body.current, to);
      return;
    }
    if (selected) setHistory((h) => [...h.slice(-30), selected]);
    setTarget(to);
    setSelected(path);
  };

  const back = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setTarget(null);
    setSelected(previous);
  };

  /** A link or path written in a doc → an existing doc (and place), if it is one. */
  const resolve = (href: string): { path: string; to: Target } | null => {
    if (!selected || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const [rawPath, hash = ""] = href.split("#");
    const to: Target = hash ? (/^L\d+$/i.test(hash) ? { line: Number(hash.slice(1)) } : { anchor: safeDecode(hash) }) : null;
    if (!rawPath) return { path: selected, to };
    const p = safeDecode(rawPath).replace(/\\/g, "/");
    const dir = selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/")) : "";
    // Relative to this doc, then to the docs root (agents often write paths from the project root).
    for (const candidate of [join(dir, p), join("", p), join("docs", p)]) if (candidate && paths.has(candidate)) return { path: candidate, to };
    return null;
  };

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      await api.writeDoc(project.id, selected, draft);
      setContent(draft);
      setEditing(false);
      void loadList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (files && files.length === 0) {
    return (
      <EmptyState icon={<BookOpen size={20} />} title="No documentation yet">
        core writes it as it learns the project — {project.docsLocation === "private" ? "privately in .symbio/docs" : "in AGENTS.md and docs/"}.
      </EmptyState>
    );
  }

  const isText = !!selected && /\.txt$/i.test(selected);
  const headings = content && !isText ? outline(content) : [];

  return (
    <div className="docs">
      <nav className="docs-list">
        <div className="docs-search">
          <Search size={13} />
          <input value={query} placeholder="Search docs" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {query && (
            <button className="btn ghost icon sm" title="Clear search" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </div>
        {results ? (
          <SearchResults
            query={query}
            results={results}
            searching={searching}
            onOpen={(m) => open(m.path, /\.txt$/i.test(m.path) ? { line: m.line } : { text: m.text })}
          />
        ) : (
          <>
            <div className="side-group-title" title={root}>
              {project.docsLocation === "private" ? "Private docs" : "Project docs"}
            </div>
            {files && <Tree nodes={tree(files)} selected={selected} expanded={expanded} setExpanded={setExpanded} onOpen={(p) => open(p)} />}
          </>
        )}
      </nav>

      <section className="docs-view">
        {error && <div className="error">{error}</div>}
        {selected && (
          <div className="docs-toolbar">
            <button className="btn ghost icon sm" title="Back" disabled={!history.length || editing} onClick={back}>
              <ArrowLeft size={14} />
            </button>
            <code className="ellipsis" title={selected}>
              {selected}
            </code>
            <div className="spacer" />
            {editing ? (
              <>
                <button className="btn ghost sm" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="btn primary sm" onClick={save} disabled={saving}>
                  <Save size={13} />
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            ) : (
              <button
                className="btn sm"
                onClick={() => {
                  setDraft(content ?? "");
                  setEditing(true);
                }}
                disabled={content === null}
              >
                <Pencil size={13} />
                Edit
              </button>
            )}
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={`${selected}:${editing}`}
            ref={body}
            className="docs-body"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            {editing ? (
              <textarea className="docs-editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck />
            ) : content === null ? (
              <div className="muted">Loading…</div>
            ) : isText ? (
              <TextDoc content={content} />
            ) : (
              <div className="docs-page">
                <div className="md">
                  <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents(resolve, open)}>
                    {content}
                  </Markdown>
                </div>
                {headings.length >= 3 && (
                  <aside className="docs-toc">
                    <div className="docs-toc-title">On this page</div>
                    {headings.map((h) => (
                      <button key={h.id} className={`docs-toc-item level-${h.level}`} onClick={() => open(selected!, { anchor: h.id })} title={h.text}>
                        {h.text}
                      </button>
                    ))}
                  </aside>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- tree

interface Node {
  name: string;
  path: string; // file path, or folder path
  file?: DocFile;
  children: Node[];
}

/** Folders first, then files, alphabetically; AGENTS.md stays on top. */
function tree(files: DocFile[]): Node[] {
  const top: Node = { name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = top;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        node.children.push({ name: part, path, file: f, children: [] });
        return;
      }
      let next = node.children.find((c) => !c.file && c.name === part);
      if (!next) node.children.push((next = { name: part, path, children: [] }));
      node = next;
    });
  }
  const order = (nodes: Node[]) => {
    nodes.sort((a, b) =>
      a.path === "AGENTS.md" ? -1 : b.path === "AGENTS.md" ? 1 : !!a.file !== !!b.file ? (a.file ? 1 : -1) : a.name.localeCompare(b.name),
    );
    nodes.forEach((n) => order(n.children));
  };
  order(top.children);
  return top.children;
}

function Tree({
  nodes,
  selected,
  expanded,
  setExpanded,
  onOpen,
  depth = 0,
}: {
  nodes: Node[];
  selected: string | null;
  expanded: Set<string>;
  setExpanded: (fn: (s: Set<string>) => Set<string>) => void;
  onOpen: (path: string) => void;
  depth?: number;
}) {
  const toggle = (path: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <>
      {nodes.map((n) =>
        n.file ? (
          <button
            key={n.path}
            className={`docs-item ${selected === n.path ? "active" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onOpen(n.path)}
            title={n.path}
          >
            <FileText size={14} />
            <span className="grow">{n.name}</span>
            <span className="docs-item-time">{timeAgo(n.file.modified)}</span>
          </button>
        ) : (
          <div key={n.path} className="docs-tree-folder">
            <button className="docs-item docs-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(n.path)} title={n.path}>
              {expanded.has(n.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} />
              <span className="grow">{n.name}</span>
            </button>
            {expanded.has(n.path) && (
              <Tree nodes={n.children} selected={selected} expanded={expanded} setExpanded={setExpanded} onOpen={onOpen} depth={depth + 1} />
            )}
          </div>
        ),
      )}
    </>
  );
}

const ancestors = (path: string) =>
  path
    .split("/")
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join("/"));

// ---------------------------------------------------------------- search

function SearchResults({
  query,
  results,
  searching,
  onOpen,
}: {
  query: string;
  results: { matches: DocMatch[]; truncated: boolean };
  searching: boolean;
  onOpen: (m: DocMatch) => void;
}) {
  const byFile = new Map<string, DocMatch[]>();
  for (const m of results.matches) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
  const n = results.matches.length;
  return (
    <div className="docs-results">
      <div className="side-group-title">
        {searching
          ? "Searching…"
          : n === 0
            ? "No matches"
            : `${n}${results.truncated ? "+" : ""} match${n === 1 ? "" : "es"} in ${byFile.size} doc${byFile.size === 1 ? "" : "s"}`}
      </div>
      {[...byFile].map(([path, matches]) => (
        <div key={path} className="docs-result-file">
          <div className="docs-result-path" title={path}>
            <FileText size={12} />
            <span className="ellipsis">{path}</span>
            <span className="docs-item-time">{matches.length}</span>
          </div>
          {matches.slice(0, 20).map((m) => (
            <button key={m.line} className="docs-result" onClick={() => onOpen(m)} title={`Line ${m.line}`}>
              <span className="docs-result-line">{m.line}</span>
              <span className="docs-result-text">{highlight(m.text, query)}</span>
            </button>
          ))}
          {matches.length > 20 && <div className="docs-result-more">+{matches.length - 20} more in this doc</div>}
        </div>
      ))}
    </div>
  );
}

/** Same folding as the server: case- and accent-insensitive. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Marks the query's words in a line, matching the way the server searched. */
function highlight(text: string, query: string): ReactNode {
  const words = fold(query).split(/\s+/).filter(Boolean);
  // Fold char by char so positions in the folded text map back to the original.
  let folded = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const ch of fold(text[i])) {
      folded += ch;
      origin.push(i);
    }
  }
  const marks: [number, number][] = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at !== -1; at = folded.indexOf(w, at + w.length)) {
      marks.push([origin[at], origin[at + w.length - 1] + 1]);
    }
  }
  if (!marks.length) return text;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  for (const [start, end] of marks) {
    if (start < pos) continue;
    out.push(text.slice(pos, start), <mark key={start}>{text.slice(start, end)}</mark>);
    pos = end;
  }
  out.push(text.slice(pos));
  return out;
}

// ---------------------------------------------------------------- rendering

/** Plain-text docs (e-mails, transcripts) with line numbers, since sources are cited by line. */
function TextDoc({ content }: { content: string }) {
  return (
    <div className="docs-text">
      {content.split(/\r?\n/).map((line, i) => (
        <div key={i} id={`L${i + 1}`} className="docs-text-line">
          <span className="docs-text-no">{i + 1}</span>
          <span className="docs-text-content">{line || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** GitHub-style heading ids, so links like `doc.md#some-heading` work. */
const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/** Headings (levels 1–3) outside code blocks, with the ids the renderer gives them. */
function outline(md: string): { id: string; text: string; level: number }[] {
  const out: { id: string; text: string; level: number }[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "");
    const id = unique(slug(text), seen);
    if (m[1].length <= 3) out.push({ id, text, level: m[1].length });
  }
  return out;
}

function unique(base: string, seen: Map<string, number>) {
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

function markdownComponents(resolve: (href: string) => { path: string; to: Target } | null, open: (path: string, to?: Target) => void): Components {
  const seen = new Map<string, number>(); // fresh per render, in document order, like outline()
  const heading =
    (Tag: "h1" | "h2" | "h3" | "h4") =>
    ({ children }: { children?: ReactNode }) => <Tag id={unique(slug(textOf(children)), seen)}>{children}</Tag>;
  const docLink = (doc: { path: string; to: Target }, children: ReactNode, className?: string) => (
    <a
      href={`#${doc.path}`}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        open(doc.path, doc.to);
      }}
    >
      {children}
    </a>
  );
  return {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    a: ({ href = "", children }) => {
      const doc = resolve(href);
      if (doc) return docLink(doc, children);
      if (/^(https?|mailto):/i.test(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        );
      }
      // A file outside the docs, or a folder: nothing to open here.
      return <span title={href}>{children}</span>;
    },
    // Agents often write paths in backticks: the ones that are docs become links.
    code: ({ className, children }) => {
      const text = textOf(children);
      const doc = !className && !text.includes("\n") && /\.(md|markdown|txt)(#\S*)?$/i.test(text) ? resolve(text) : null;
      if (doc) return docLink(doc, <code>{children}</code>, "doc-path");
      return <code className={className}>{children}</code>;
    },
  };
}

/** Scrolls to a target in the open doc and flashes it. False when it isn't on screen (yet). */
function reveal(container: HTMLElement, target: NonNullable<Target>): boolean {
  const el = findTarget(container, target);
  if (!el) return false;
  el.scrollIntoView({ block: target.anchor ? "start" : "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
  return true;
}

function findTarget(container: HTMLElement, target: NonNullable<Target>): HTMLElement | null {
  if (target.anchor) {
    const id = target.anchor;
    return container.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) ?? container.querySelector<HTMLElement>(`[id="${CSS.escape(slug(id))}"]`);
  }
  if (target.line) return container.querySelector<HTMLElement>(`[id="L${target.line}"]`);
  if (target.text) {
    // Markdown is rendered, so find the line by its text rather than by position. Whitespace is
    // ignored: a table row's cells run together in the page.
    const squash = (s: string) => fold(s).replace(/\s+/g, "");
    const needle = squash(
      target.text
        .replace(/^[#>*\-|\s\d.]+/, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_|]/g, " "),
    ).slice(0, 50);
    if (!needle) return null;
    for (const el of container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, p, li, tr, pre, blockquote")) {
      if (squash(el.textContent ?? "").includes(needle)) return el;
    }
  }
  return null;
}

function join(dir: string, rel: string): string {
  const out: string[] = [];
  for (const p of (dir ? `${dir}/${rel}` : rel).split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (!out.length) return "";
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
