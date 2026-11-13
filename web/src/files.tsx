import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FileAudio, FileImage, FileQuestion, FileText, FileVideo } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, openProjectFile, projectFileBlob, type ProjectFile } from "./api";
import { parseFileHref, remarkPaths } from "./paths";

// Files in what the team writes: paths become links (to the files that exist), files agents share
// show as cards, and Markdown or code opens in a viewer page at the line mentioned (files.ts).

// ---------------------------------------------------------------- finding files, in batches

const cache = new Map<string, { at: number; file: ProjectFile }>();
let queue: { projectId: string; agentId: string | null; path: string; done: (f: ProjectFile) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Whether a path exists (as the agent that wrote it meant it), asking the server in batches. */
export function findFile(projectId: string, agentId: string | null | undefined, path: string): Promise<ProjectFile> {
  const key = `${projectId}|${agentId ?? ""}|${path}`;
  const hit = cache.get(key);
  // Found files stay found; a missing one is asked again later (it may be written meanwhile).
  if (hit && (hit.file.found || Date.now() - hit.at < 30_000)) return Promise.resolve(hit.file);
  return new Promise((resolve) => {
    queue.push({ projectId, agentId: agentId ?? null, path, done: resolve });
    timer ??= setTimeout(flush, 40);
  });
}

function flush() {
  timer = null;
  const batch = queue;
  queue = [];
  const groups = new Map<string, typeof batch>();
  for (const q of batch) {
    const k = `${q.projectId}|${q.agentId ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  for (const items of groups.values()) {
    const { projectId, agentId } = items[0];
    const paths = [...new Set(items.map((i) => i.path))];
    api
      .resolveFiles(projectId, paths, agentId)
      .then((files) => {
        for (const f of files) cache.set(`${projectId}|${agentId ?? ""}|${f.path}`, { at: Date.now(), file: f });
        for (const i of items) i.done(files.find((f) => f.path === i.path) ?? { path: i.path, found: false });
      })
      .catch(() => items.forEach((i) => i.done({ path: i.path, found: false })));
  }
}

function useFile(projectId: string, agentId: string | null | undefined, path: string | null) {
  const [file, setFile] = useState<ProjectFile | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    findFile(projectId, agentId, path).then((f) => live && setFile(f));
    return () => {
      live = false;
    };
  }, [projectId, agentId, path]);
  return file;
}

/** The viewer page for a text file (opened in a new tab), at a line. */
export const viewerHref = (projectId: string, rel: string, agentId?: string | null, line?: number) =>
  `#/view/${projectId}?path=${encodeURIComponent(rel)}${agentId ? `&agent=${encodeURIComponent(agentId)}` : ""}${line ? `&line=${line}` : ""}`;

const where = (f: ProjectFile) => (f.where && f.where !== "project" ? ` (in ${f.where}'s copy)` : "");

/** A path in the text: a link when the file exists, plain text otherwise. */
function FileLink({ projectId, agentId, path, line, children }: { projectId: string; agentId?: string | null; path: string; line?: number; children: React.ReactNode }) {
  const f = useFile(projectId, agentId, path);
  if (!f?.found || !f.rel) return <>{children}</>;
  const title = `Open ${f.rel}${line ? ` at line ${line}` : ""}${where(f)}`;
  if (f.kind === "markdown" || f.kind === "text") {
    return (
      <a className="file-link" href={viewerHref(projectId, f.rel, f.agentId, line)} target="_blank" rel="noopener" title={title}>
        {children}
      </a>
    );
  }
  return (
    <a
      className="file-link"
      href="#"
      title={f.kind === "other" ? `Download ${f.rel}${where(f)}` : title}
      onClick={(e) => {
        e.preventDefault();
        openProjectFile(projectId, { rel: f.rel!, agentId: f.agentId }, f.kind === "other");
      }}
    >
      {children}
    </a>
  );
}

/**
 * Markdown from the team, with paths turned into links to the files that exist (looked up as
 * `agentId` meant them) and other links opening in a new tab.
 */
export function Md({ text, projectId, agentId, className = "md" }: { text: string; projectId: string; agentId?: string | null; className?: string }) {
  const components: Components = {
    a: ({ href, children }) => {
      const file = parseFileHref(href);
      if (file) {
        return (
          <FileLink projectId={projectId} agentId={agentId} path={file.path} line={file.line}>
            {children}
          </FileLink>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
  return (
    <div className={className}>
      <Markdown remarkPlugins={[remarkGfm, remarkPaths]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

// ---------------------------------------------------------------- shared files, as cards

const MAX_PREVIEW = 150 * 1024 * 1024; // larger videos download instead of loading into the page

export function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const KIND_ICON = { image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, markdown: FileText, text: FileText, other: FileQuestion };

/** A file an agent shared: shown in place when the browser can, with Open / Download. */
export function FileCard({ projectId, agentId, path, caption }: { projectId: string; agentId?: string | null; path: string; caption?: string }) {
  const f = useFile(projectId, agentId, path);
  const [src, setSrc] = useState<string | null>(null);
  const previewable = f?.found && (f.kind === "image" || f.kind === "video" || f.kind === "audio") && (f.size ?? 0) <= MAX_PREVIEW;
  useEffect(() => {
    if (previewable && f?.rel) projectFileBlob(projectId, f.rel, f.agentId).then(setSrc, () => setSrc(null));
  }, [previewable, projectId, f?.rel, f?.agentId]);

  const name = (f?.rel ?? path).split("/").pop();
  if (f && !f.found) {
    return (
      <div className="shared-file missing">
        <FileQuestion size={16} />
        <span className="shared-file-name">{name}</span>
        <span className="small subtle">{f.refused ?? "no longer there"}</span>
      </div>
    );
  }
  const Icon = KIND_ICON[f?.kind ?? "other"];
  const open = () => f?.rel && openProjectFile(projectId, { rel: f.rel, agentId: f.agentId });
  return (
    <div className={`shared-file kind-${f?.kind ?? "loading"}`}>
      {f?.kind === "image" && src && <img className="shared-file-image" src={src} alt={caption ?? name} onClick={open} />}
      {f?.kind === "video" && src && <video className="shared-file-video" src={src} controls preload="metadata" />}
      {f?.kind === "audio" && src && <audio className="shared-file-audio" src={src} controls preload="metadata" />}
      <div className="shared-file-row">
        <Icon size={16} className="subtle" />
        <div className="shared-file-text">
          <span className="shared-file-name" title={f?.rel}>
            {name}
          </span>
          <span className="small subtle">
            {f ? `${formatSize(f.size)}${where(f)}` : "…"}
            {caption ? ` · ${caption}` : ""}
          </span>
        </div>
        {f?.rel && (f.kind === "markdown" || f.kind === "text") && (
          <a className="btn sm" href={viewerHref(projectId, f.rel, f.agentId)} target="_blank" rel="noopener">
            <ExternalLink size={13} />
            Open
          </a>
        )}
        {f?.rel && (f.kind === "pdf" || f.kind === "image" || (f.kind !== "other" && !previewable && f.kind !== "markdown" && f.kind !== "text")) && (
          <button className="btn sm" onClick={open}>
            <ExternalLink size={13} />
            Open
          </button>
        )}
        {f?.rel && (
          <button className="btn ghost sm" title="Download" onClick={() => openProjectFile(projectId, { rel: f.rel!, agentId: f.agentId }, true)}>
            <Download size={13} />
            {f.kind === "other" ? "Download" : ""}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the viewer page (a new tab)

/** A text file on its own page: Markdown formatted, code with line numbers, scrolled to the line. */
export function FileViewer({ projectId, rel, agentId, line }: { projectId: string; rel: string; agentId?: string | null; line?: number }) {
  const [data, setData] = useState<{ content: string; where: string; kind: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // The block that holds the line: the last one starting at or before it (found after the first
  // render, then marked by the render itself, so re-renders keep it).
  const [mark, setMark] = useState<number | null>(null);
  useEffect(() => {
    document.title = `${rel.split("/").pop()} · Symbio`;
    api.fileText(projectId, rel, agentId).then(setData, (e) => setError((e as Error).message));
  }, [projectId, rel, agentId]);
  useLayoutEffect(() => {
    if (!data || !line || !body.current) return;
    const starts = [...body.current.querySelectorAll<HTMLElement>("[data-line]")].map((b) => Number(b.dataset.line));
    setMark(starts.filter((n) => n <= line).pop() ?? null);
  }, [data, line, source]);
  useEffect(() => {
    body.current?.querySelector(".file-view-target")?.scrollIntoView({ block: "center" });
  }, [mark]);

  const markdown = data?.kind === "markdown" && !source;
  const components = useMemo(() => {
    const at = (node: any, className?: string) => {
      const n = node?.position?.start?.line;
      return { "data-line": n, className: [className, n != null && n === mark ? "file-view-target" : ""].filter(Boolean).join(" ") || undefined };
    };
    return {
      p: ({ node, className, ...p }: any) => <p {...p} {...at(node, className)} />,
      h1: ({ node, className, ...p }: any) => <h1 {...p} {...at(node, className)} />,
      h2: ({ node, className, ...p }: any) => <h2 {...p} {...at(node, className)} />,
      h3: ({ node, className, ...p }: any) => <h3 {...p} {...at(node, className)} />,
      h4: ({ node, className, ...p }: any) => <h4 {...p} {...at(node, className)} />,
      li: ({ node, className, ...p }: any) => <li {...p} {...at(node, className)} />,
      tr: ({ node, className, ...p }: any) => <tr {...p} {...at(node, className)} />,
      pre: ({ node, className, ...p }: any) => <pre {...p} {...at(node, className)} />,
      blockquote: ({ node, className, ...p }: any) => <blockquote {...p} {...at(node, className)} />,
      a: ({ href, children }: any) => (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
    } as Components;
  }, [mark]);
  return (
    <div className="file-view">
      <div className="file-view-head">
        <FileText size={15} />
        <strong>{rel}</strong>
        {data && data.where !== "project" && <span className="tag">in {data.where}'s copy</span>}
        {line && <span className="small subtle">line {line}</span>}
        <span className="grow" />
        {data?.kind === "markdown" && (
          <button className="btn ghost sm" onClick={() => setSource((s) => !s)}>
            {source ? "Formatted" : "Source"}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => openProjectFile(projectId, { rel, agentId }, true)}>
          <Download size={13} />
          Download
        </button>
      </div>
      <div ref={body} className="file-view-body">
        {error && <div className="error">{error}</div>}
        {!data && !error && <div className="subtle">Loading…</div>}
        {data && markdown && (
          <div className="md">
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {data.content}
            </Markdown>
          </div>
        )}
        {data && !markdown && (
          <pre className="file-view-code">
            {data.content.split("\n").map((l, i) => (
              <div key={i} data-line={i + 1} className={`code-line${i + 1 === mark ? " file-view-target" : ""}`}>
                <span className="code-num">{i + 1}</span>
                <span className="code-text">{l || " "}</span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
