import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { api, type Project } from "./api";
import { Dialog } from "./ui";

/** "⋯" menu for a project: rename and remove. */
export function ProjectMenu({ project, onRemoved }: { project: Project; onRemoved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "remove" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);

  const pick = (d: "rename" | "remove") => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    setDialog(d);
  };

  return (
    <div className="menu" ref={ref} onClick={(e) => e.preventDefault()}>
      <button
        className="btn ghost icon sm"
        title="Project options"
        aria-label="Project options"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu-list" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.1 }}>
            <button onClick={pick("rename")}>
              <Pencil size={14} />
              Rename
            </button>
            <button className="danger" onClick={pick("remove")}>
              <Trash2 size={14} />
              Remove from Symbio…
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {dialog === "rename" && <RenameDialog project={project} onClose={() => setDialog(null)} />}
        {dialog === "remove" && <RemoveDialog project={project} onClose={() => setDialog(null)} onRemoved={onRemoved} />}
      </AnimatePresence>
    </div>
  );
}

function RenameDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim() && name.trim() !== project.name;
  async function save() {
    try {
      await api.updateProject(project.id, { name: name.trim() });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog
      title="Rename project"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!valid}>
            Rename
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && valid && save()} />
        <span className="hint">Only the name shown in Symbio changes; the folder stays where it is.</span>
      </label>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}

export function RemoveDialog({ project, onClose, onRemoved }: { project: Project; onClose: () => void; onRemoved?: () => void }) {
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = project.agents.filter((a) => a.status === "busy" || a.status === "waiting").length;

  async function remove() {
    setBusy(true);
    try {
      await api.deleteProject(project.id, deleteData);
      onClose();
      onRemoved?.();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Remove “${project.name}”?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger-solid" onClick={remove} disabled={busy}>
            {busy ? "Removing…" : "Remove project"}
          </button>
        </>
      }
    >
      <p className="muted">
        Symbio stops its agents and removes their workspaces. <strong style={{ color: "var(--text)" }}>Your project files are not touched</strong> —{" "}
        <code>{project.directory}</code> stays exactly as it is, including its git history and any branches helpers created.
      </p>
      {working > 0 && <div className="notice">{working} agent(s) are working right now and will be stopped.</div>}
      <label className="choice">
        <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
        <span className="choice-body">
          <span className="choice-title">Also delete Symbio's data for it</span>
          <span className="choice-desc">
            The plan, message log and asset register (<code>.symbio</code> folder) and the agents' conversations. Leave unchecked to be able
            to add the folder again later and continue where you left off.
          </span>
        </span>
      </label>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
