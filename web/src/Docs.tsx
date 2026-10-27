import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, FileText, Pencil, Save } from "lucide-react";
import { api, subscribe, type DocFile, type Project } from "./api";
import { EmptyState, timeAgo } from "./ui";

export function Docs({ project }: { project: Project }) {
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;

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
  }, [files]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected) {
      setEditing(false);
      setContent(null);
      void loadFile(selected);
    }
  }, [selected, loadFile]);

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

  return (
    <div className="docs">
      <nav className="docs-list">
        <div className="side-group-title" title={root}>
          {project.docsLocation === "private" ? "Private docs" : "Project docs"}
        </div>
        {files?.map((f) => (
          <button key={f.path} className={`docs-item ${selected === f.path ? "active" : ""}`} onClick={() => setSelected(f.path)} title={f.path}>
            <FileText size={14} />
            <span className="grow">{f.path}</span>
            <span className="docs-item-time">{timeAgo(f.modified)}</span>
          </button>
        ))}
      </nav>

      <section className="docs-view">
        {error && <div className="error">{error}</div>}
        {selected && (
          <div className="docs-toolbar">
            <code>{selected}</code>
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
            ) : (
              <div className="md">
                <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </section>
    </div>
  );
}
