import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Trash2, X } from "lucide-react";
import { api, type Project, type ProjectConnection } from "./api";
import { ConnectionsPicker } from "./ConnectionsPicker";
import { ModelPicker } from "./ModelPicker";
import { RemoveDialog } from "./ProjectMenu";
import { UsageSection } from "./Usage";

/** Project configuration: name, connections, models, remembered permissions, removal. */
export function ProjectSettings({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [removing, setRemoving] = useState(false);
  return (
    <div className="settings-scroll">
      <div className="settings-inner">
        <General project={project} onChanged={onChanged} />
        <Connections project={project} onChanged={onChanged} />
        <Models project={project} onChanged={onChanged} />
        <Team project={project} onChanged={onChanged} />
        <UsageSection project={project} />
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

const DEFAULT_MESSAGE_LIMIT = 20;

function Team({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const current = project.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
  const currentRenew = project.renewSessions ?? "manual";
  const [value, setValue] = useState(String(current));
  const [renew, setRenew] = useState(currentRenew);
  const [saving, setSaving] = useState(false);
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000;
  const dirty = valid && (parsed !== current || renew !== currentRenew);
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { messageLimit: parsed, renewSessions: renew }));
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
          <h2>Team</h2>
          <p>How the agents of this project work together.</p>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        <div className="field">
          <span>Fresh sessions for helpers</span>
          <div className="seg">
            <button className={renew === "manual" ? "on" : ""} onClick={() => setRenew("manual")}>
              When I ask
            </button>
            <button className={renew === "after-task" ? "on" : ""} onClick={() => setRenew("after-task")}>
              After each merged task
            </button>
          </div>
          <span className="hint">
            Long conversations get slow and costly, since every step re-reads them. A fresh session keeps the helper's name, folder, tasks
            and assets and starts from a handoff note; the old conversation stays readable. "When I ask": use New session in the agent's
            chat.
          </span>
        </div>
        <label className="field">
          <span>Messages two agents may exchange in 30 minutes</span>
          <input type="number" min={0} max={1000} value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 140 }} />
          <span className="hint">
            {valid && parsed === 0
              ? "No limit: agents can message each other freely."
              : `Guards against two agents going back and forth without progress; task assignments, shared-asset requests and review reports don't count. When two agents reach it, further messages between them wait until older ones are 30 minutes old, and you're told. 0 removes the limit. Default ${DEFAULT_MESSAGE_LIMIT}.`}
          </span>
        </label>
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        onReset={() => {
          setValue(String(current));
          setRenew(currentRenew);
        }}
      />
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
