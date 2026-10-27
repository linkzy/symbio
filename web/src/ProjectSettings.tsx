import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Trash2, X } from "lucide-react";
import { api, type Project, type ProjectConnection } from "./api";
import { ConnectionsPicker } from "./ConnectionsPicker";
import { ModelPicker } from "./ModelPicker";
import { RemoveDialog } from "./ProjectMenu";

/** Project configuration: name, connections, models, remembered permissions, removal. */
export function ProjectSettings({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [removing, setRemoving] = useState(false);
  return (
    <div className="settings-scroll">
      <div className="settings-inner">
        <General project={project} onChanged={onChanged} />
        <Connections project={project} onChanged={onChanged} />
        <Models project={project} onChanged={onChanged} />
        <AlwaysAllowed project={project} onChanged={onChanged} />
        <section className="section danger-zone">
          <div className="section-head">
            <div>
              <h2>Remove project</h2>
              <p>Stops the agents and removes their workspaces. Your files are never touched.</p>
            </div>
            <button className="btn danger" onClick={() => setRemoving(true)}>
              <Trash2 size={14} />
              Remove…
            </button>
          </div>
        </section>
      </div>
      <AnimatePresence>
        {removing && <RemoveDialog project={project} onClose={() => setRemoving(false)} onRemoved={() => (location.hash = "#/")} />}
      </AnimatePresence>
    </div>
  );
}

function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="row" style={{ justifyContent: "flex-end", padding: "10px 12px 4px" }}>
      <button className="btn ghost sm" onClick={onReset} disabled={saving}>
        Discard
      </button>
      <button className="btn primary sm" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}

function General({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== project.name && !!name.trim();
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { name: name.trim() }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>General</h2>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>Folder</span>
          <code className="muted">{project.directory}</code>
        </div>
        <div className="field">
          <span>Documentation</span>
          <div className="muted small">
            {project.docsLocation === "private" ? (
              <>
                Private — kept in <code>.symbio/docs</code> and handed to agents by Symbio.
              </>
            ) : (
              <>
                In the project — <code>AGENTS.md</code> and <code>docs/</code>.
              </>
            )}
          </div>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={() => setName(project.name)} />
    </section>
  );
}

function Connections({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [value, setValue] = useState<ProjectConnection[]>(project.connections);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(project.connections);
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { connections: value }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Connections</h2>
          <p>
            GitHub accounts and servers this project's agents may use. They act through Symbio and never see the credentials. With{" "}
            <strong>Ask me</strong>, every push, deploy or remote command waits for your approval.
          </p>
        </div>
      </div>
      <div style={{ padding: 12 }}>
        <ConnectionsPicker value={value} onChange={setValue} />
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={() => setValue(project.connections)} />
    </section>
  );
}

function Models({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [allowed, setAllowed] = useState(project.allowedModels);
  const [lead, setLead] = useState(project.coordinatorModel);
  const [saving, setSaving] = useState(false);
  const dirty = lead !== project.coordinatorModel || JSON.stringify(allowed) !== JSON.stringify(project.allowedModels);
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { allowedModels: allowed, coordinatorModel: lead }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Models</h2>
          <p>Agents may use any selected model and switch to the next one when a model fails. Adding a model also resumes agents that got stuck.</p>
        </div>
      </div>
      <div style={{ padding: 12 }}>
        <ModelPicker
          allowed={allowed}
          coordinator={lead}
          onChange={(a, c) => {
            setAllowed(a);
            setLead(c);
          }}
        />
      </div>
      <SaveBar
        dirty={dirty && allowed.length > 0 && !!lead}
        saving={saving}
        onSave={save}
        onReset={() => {
          setAllowed(project.allowedModels);
          setLead(project.coordinatorModel);
        }}
      />
    </section>
  );
}

function AlwaysAllowed({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  async function remove(action: string, pattern: string) {
    try {
      onChanged(
        await api.updateProject(project.id, {
          allowedPatterns: project.allowedPatterns.filter((x) => !(x.action === action && x.pattern === pattern)),
        }),
      );
    } catch (e) {
      alert((e as Error).message);
    }
  }
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Always allowed</h2>
          <p>Permission requests you answered with “Always allow”. Matching requests are approved automatically.</p>
        </div>
      </div>
      {project.allowedPatterns.length === 0 ? (
        <div className="section-empty">Nothing yet.</div>
      ) : (
        <div className="section-body">
          {project.allowedPatterns.map((a) => (
            <div key={`${a.action}:${a.pattern}`} className="list-row">
              <span className="tag">{a.action}</span>
              <code className="grow">{a.pattern}</code>
              <button className="btn ghost sm" onClick={() => remove(a.action, a.pattern)} title="Ask me again for these">
                <X size={13} />
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
