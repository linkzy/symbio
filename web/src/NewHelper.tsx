import { useState } from "react";
import { api, type Agent, type Project } from "./api";
import { modelsForRole } from "./ModelPicker";
import { Dialog } from "./ui";

/**
 * A helper the human creates from the team list, to talk to directly (like opening a new chat).
 * It's a full team member: the same as one core creates with spawn_agent, without a first task.
 */
export function NewHelperDialog({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: (agent: Agent) => void }) {
  const models = modelsForRole(project, "worker");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [model, setModel] = useState(models.includes(project.coordinatorModel) ? project.coordinatorModel : models[0]);
  const [workspace, setWorkspace] = useState<"shared" | "own">("shared");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(slug);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createHelper(project.id, { name: slug, purpose: purpose.trim() || undefined, model, workspace });
      onCreated(agent);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="New helper"
      subtitle="A helper you talk to directly, in its own chat. core is told, and leaves it to you."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy || !valid}>
            {busy ? "Creating…" : "Create and open its chat"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && !busy && void create()}
          placeholder="e.g. researcher, writer, ideas"
        />
        {name && !valid && <span className="hint warn">Letters, digits and dashes, starting with a letter or digit.</span>}
      </label>
      <label className="field">
        <span>What it's for (optional)</span>
        <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Brainstorms level ideas with me" />
      </label>
      <label className="field">
        <span>Model</span>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Where it works</span>
        <div className="seg">
          <button className={workspace === "shared" ? "on" : ""} onClick={() => setWorkspace("shared")}>
            In the project folder
          </button>
          <button className={workspace === "own" ? "on" : ""} onClick={() => setWorkspace("own")}>
            In its own copy
          </button>
        </div>
        <span className="hint">
          {workspace === "shared"
            ? "What it writes is in the project at once, like core's own work."
            : "A separate copy (git branch): its work stays apart until core merges it."}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
