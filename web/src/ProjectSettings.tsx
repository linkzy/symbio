import { ProjectSkillsSection } from "./Skills";
import { ChecksSection } from "./Checks";
import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Bot, Coins, Plug, ShieldCheck, SlidersHorizontal, Trash2, Wrench, X } from "lucide-react";
import { SettingsTabs, useProjectSettingsGroup, type ProjectSettingsGroupId } from "./SettingsTabs";
import { api, RUNTIME_LABEL, type Project, type ProjectConnection } from "./api";
import { ConnectionsPicker } from "./ConnectionsPicker";
import { ModelPicker, choiceBody, choiceOf } from "./ModelPicker";
import { RemoveDialog } from "./ProjectMenu";
import { UsageSection } from "./Usage";
import { HousekeepingSection } from "./Housekeeping";
import { RuntimeSection } from "./SwitchRuntime";
import { EffortSection } from "./Effort";
import { useI18n } from "./i18n";
import { ProjectNotifyChoice } from "./Notifications";
import { BudgetSection } from "./Budget";

/** Project configuration: name, connections, models, remembered permissions, removal. */
export function ProjectSettings({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const [removing, setRemoving] = useState(false);
  const [group, setGroup] = useProjectSettingsGroup(project.id);
  const groups: { id: ProjectSettingsGroupId; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: t("projectSettings.group.general"), icon: <SlidersHorizontal size={14} /> },
    { id: "team", label: t("projectSettings.group.team"), icon: <Bot size={14} /> },
    { id: "quality", label: t("projectSettings.group.quality"), icon: <ShieldCheck size={14} /> },
    { id: "connections", label: t("projectSettings.group.connections"), icon: <Plug size={14} /> },
    { id: "usage", label: t("projectSettings.group.usage"), icon: <Coins size={14} /> },
    { id: "maintenance", label: t("projectSettings.group.maintenance"), icon: <Wrench size={14} /> },
  ];
  return (
    <div className="settings-scroll">
      <div className="settings-inner">
        <SettingsTabs groups={groups} current={group} onPick={setGroup} />
        {group === "general" && (
          <>
            <General project={project} onChanged={onChanged} />
            <Lead project={project} onChanged={onChanged} />
          </>
        )}
        {group === "team" && (
          <>
            <Team project={project} onChanged={onChanged} />
            <Models project={project} onChanged={onChanged} />
            <EffortSection project={project} onChanged={onChanged} />
            <ProjectSkillsSection project={project} onChanged={onChanged} />
            <RuntimeSection project={project} />
          </>
        )}
        {group === "quality" && <ChecksSection project={project} onChanged={onChanged} />}
        {group === "connections" && (
          <>
            <Connections project={project} onChanged={onChanged} />
            <AlwaysAllowed project={project} onChanged={onChanged} />
          </>
        )}
        {group === "usage" && (
          <>
            <BudgetSection project={project} onChanged={onChanged} />
            <UsageSection project={project} />
          </>
        )}
        {group === "maintenance" && (
          <>
            <HousekeepingSection project={project} />
            <section className="section danger-zone">
              <div className="section-head">
                <div>
                  <h2>{t("projectSettings.remove.title")}</h2>
                  <p>{t("projectSettings.remove.desc")}</p>
                </div>
                <button className="btn danger" onClick={() => setRemoving(true)}>
                  <Trash2 size={14} />
                  {t("common.remove")}…
                </button>
              </div>
            </section>
          </>
        )}
      </div>
      <AnimatePresence>
        {removing && <RemoveDialog project={project} onClose={() => setRemoving(false)} onRemoved={() => (location.hash = "#/")} />}
      </AnimatePresence>
    </div>
  );
}

function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  const { t } = useI18n();
  if (!dirty) return null;
  return (
    <div className="row" style={{ justifyContent: "flex-end", padding: "10px 12px 4px" }}>
      <button className="btn ghost sm" onClick={onReset} disabled={saving}>
        {t("common.discard")}
      </button>
      <button className="btn primary sm" onClick={onSave} disabled={saving}>
        {saving ? t("common.saving") : t("common.saveChanges")}
      </button>
    </div>
  );
}

function General({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState(!!project.rulesRegister);
  const dirty = (name.trim() !== project.name && !!name.trim()) || rules !== !!project.rulesRegister;
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { name: name.trim() || project.name, rulesRegister: rules }));
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
          <h2>{t("projectSettings.general")}</h2>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        <label className="field">
          <span>{t("newProject.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>{t("projectSettings.folder")}</span>
          <code className="muted">{project.directory}</code>
        </div>
        <div className="field">
          <span>{t("projectSettings.documentation")}</span>
          <div className="muted small">
            {project.docsLocation === "private" ? (
              <>{t("projectSettings.docs.private")}</>
            ) : (
              <>{t("projectSettings.docs.project")}</>
            )}
          </div>
        </div>
        <label className="choice">
          <input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} />
          <span className="choice-body">
            <span className="choice-title">{t("projectSettings.rules.title")}</span>
            <span className="choice-desc">{t("projectSettings.rules.desc")}</span>
          </span>
        </label>
        <ProjectNotifyChoice project={project} onChanged={onChanged} />
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        onReset={() => {
          setName(project.name);
          setRules(!!project.rulesRegister);
        }}
      />
    </section>
  );
}

/** How core runs the project: how much it decides on its own, how it questions the human, what the team may do without asking. */
function Lead({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const saved = {
    autonomy: project.autonomy ?? "ask",
    questionStyle: project.questionStyle ?? "briefing",
    standingPermissions: project.standingPermissions ?? "",
    allowInstalls: !!project.allowInstalls,
  };
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const key = JSON.stringify(saved);
  useEffect(() => setValue(saved), [key]);
  const dirty = JSON.stringify(value) !== key;
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, value));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="section" id="lead">
      <div className="section-head">
        <div>
          <h2>{t("lead.title")}</h2>
          <p>{t("lead.desc")}</p>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        <div className="field">
          <span>{t("lead.autonomy.title")}</span>
          <div className="seg">
            <button className={value.autonomy === "decide" ? "on" : ""} onClick={() => setValue({ ...value, autonomy: "decide" })}>
              {t("lead.autonomy.decide")}
            </button>
            <button className={value.autonomy === "ask" ? "on" : ""} onClick={() => setValue({ ...value, autonomy: "ask" })}>
              {t("lead.autonomy.ask")}
            </button>
          </div>
          <span className="hint">{value.autonomy === "decide" ? t("lead.autonomy.hint.decide") : t("lead.autonomy.hint.ask")}</span>
        </div>
        <div className="field">
          <span>{t("lead.style.title")}</span>
          <div className="seg">
            <button className={value.questionStyle === "briefing" ? "on" : ""} onClick={() => setValue({ ...value, questionStyle: "briefing" })}>
              {t("lead.style.briefing")}
            </button>
            <button className={value.questionStyle === "grill" ? "on" : ""} onClick={() => setValue({ ...value, questionStyle: "grill" })}>
              {t("lead.style.grill")}
            </button>
          </div>
          <span className="hint">{value.questionStyle === "grill" ? t("lead.style.hint.grill") : t("lead.style.hint.briefing")}</span>
        </div>
        <label className="field">
          <span>{t("lead.standing.title")}</span>
          <textarea rows={4} value={value.standingPermissions} placeholder={t("lead.standing.placeholder")} onChange={(e) => setValue({ ...value, standingPermissions: e.target.value })} />
          <span className="hint">{t("lead.standing.hint")}</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={value.allowInstalls} onChange={(e) => setValue({ ...value, allowInstalls: e.target.checked })} />
          <span className="choice-body">
            <span className="choice-title">{t("lead.installs.title")}</span>
            <span className="choice-desc">{t("lead.installs.desc")}</span>
          </span>
        </label>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={() => setValue(saved)} />
    </section>
  );
}

const DEFAULT_MESSAGE_LIMIT = 20;

function Team({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const current = project.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
  const currentRenew = project.renewSessions ?? "manual";
  const [value, setValue] = useState(String(current));
  const [renew, setRenew] = useState(currentRenew);
  const currentWorkspace = project.helperWorkspace ?? "own";
  const [workspace, setWorkspace] = useState(currentWorkspace);
  const currentReview = project.reviewBy ?? "core";
  const [review, setReview] = useState(currentReview);
  const [saving, setSaving] = useState(false);
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000;
  const dirty = valid && (parsed !== current || renew !== currentRenew || workspace !== currentWorkspace || review !== currentReview);
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { messageLimit: parsed, renewSessions: renew, helperWorkspace: workspace, reviewBy: review }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const { t } = useI18n();
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{t("projectSettings.team.title")}</h2>
          <p>{t("projectSettings.team.desc")}</p>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        <div className="field">
          <span>{t("projectSettings.team.workspace.title")}</span>
          <div className="seg">
            <button className={workspace === "own" ? "on" : ""} onClick={() => setWorkspace("own")}>
              {t("projectSettings.team.workspace.own")}
            </button>
            <button className={workspace === "shared" ? "on" : ""} onClick={() => setWorkspace("shared")}>
              {t("projectSettings.team.workspace.shared")}
            </button>
          </div>
          <span className="hint">
            {workspace === "own" ? t("projectSettings.team.workspace.hint.own") : t("projectSettings.team.workspace.hint.shared")}{" "}
            {t("projectSettings.team.workspace.hint.tail")}
          </span>
        </div>
        {project.subRepositories !== undefined && <RepositoriesChoice project={project} onChanged={onChanged} />}
        <CoauthorsChoice project={project} onChanged={onChanged} />
        <div className="field">
          <span>{t("projectSettings.team.review.title")}</span>
          <div className="seg">
            <button className={review === "core" ? "on" : ""} onClick={() => setReview("core")}>
              {t("projectSettings.team.review.core")}
            </button>
            <button className={review === "every" ? "on" : ""} onClick={() => setReview("every")}>
              {t("projectSettings.team.review.every")}
            </button>
            <button className={review === "marked" ? "on" : ""} onClick={() => setReview("marked")}>
              {t("projectSettings.team.review.marked")}
            </button>
          </div>
          <span className="hint">
            {review === "core"
              ? t("projectSettings.team.review.hint.core")
              : `${review === "marked" ? t("projectSettings.team.review.hint.marked") : ""}${t("projectSettings.team.review.hint.human")}`}
          </span>
        </div>
        <div className="field">
          <span>{t("projectSettings.team.renew.title")}</span>
          <div className="seg">
            <button className={renew === "manual" ? "on" : ""} onClick={() => setRenew("manual")}>
              {t("projectSettings.team.renew.manual")}
            </button>
            <button className={renew === "after-task" ? "on" : ""} onClick={() => setRenew("after-task")}>
              {t("projectSettings.team.renew.afterTask")}
            </button>
          </div>
          <span className="hint">{t("projectSettings.team.renew.hint")}</span>
        </div>
        <label className="field">
          <span>{t("projectSettings.team.limit.title")}</span>
          <input type="number" min={0} max={1000} value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 140 }} />
          <span className="hint">
            {valid && parsed === 0
              ? t("projectSettings.team.limit.none")
              : t("projectSettings.team.limit.hint", { n: DEFAULT_MESSAGE_LIMIT })}
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
          setWorkspace(currentWorkspace);
          setReview(currentReview);
        }}
      />
    </section>
  );
}

/** Whether commits may name the AI as a co-author (Project.aiCoauthors; off by default). Applies at once. */
function CoauthorsChoice({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  async function choose(on: boolean) {
    if (on === !!project.aiCoauthors) return;
    setBusy(true);
    try {
      onChanged(await api.updateProject(project.id, { aiCoauthors: on }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      <span>{t("projectSettings.coauthors.title")}</span>
      <div className="seg">
        <button className={!project.aiCoauthors ? "on" : ""} disabled={busy} onClick={() => choose(false)}>
          {t("projectSettings.coauthors.leaveOut")}
        </button>
        <button className={project.aiCoauthors ? "on" : ""} disabled={busy} onClick={() => choose(true)}>
          {t("projectSettings.coauthors.allow")}
        </button>
      </div>
      <span className="hint">
        {t("projectSettings.coauthors.hint.before")}<code>Co-authored-by</code>{t("projectSettings.coauthors.hint.after")}
      </span>
    </div>
  );
}

/** Shown once core (or the human) decided about a repository created on top of others. Applies at once. */
function RepositoriesChoice({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  async function choose(on: boolean) {
    if (on === !!project.subRepositories) return;
    setBusy(true);
    try {
      onChanged(await api.updateProject(project.id, { subRepositories: on }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      <span>{t("projectSettings.repos.title")}</span>
      <div className="seg">
        <button className={project.subRepositories ? "on" : ""} disabled={busy} onClick={() => choose(true)}>
          {t("projectSettings.repos.inside")}
        </button>
        <button className={!project.subRepositories ? "on" : ""} disabled={busy} onClick={() => choose(false)}>
          {t("projectSettings.repos.outer")}
        </button>
      </div>
      <span className="hint">{t("projectSettings.repos.hint")}</span>
    </div>
  );
}

function Connections({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState<ProjectConnection[]>(project.connections);
  const [saving, setSaving] = useState(false);
  const saved = JSON.stringify(project.connections);
  const dirty = JSON.stringify(value) !== saved;
  // Changed elsewhere (an "always allow" from Needs you): follow it, unless there are unsaved edits here.
  const [base, setBase] = useState(saved);
  useEffect(() => {
    if (saved === base) return;
    if (JSON.stringify(value) === base) setValue(project.connections);
    setBase(saved);
  }, [saved]);
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
          <h2>{t("projectSettings.connections.title")}</h2>
          <p>{t("projectSettings.connections.desc2", { ask: t("projectSettings.connections.askMe") })}</p>
        </div>
      </div>
      <div style={{ padding: 12 }}>
        <ConnectionsPicker
          value={value}
          onChange={setValue}
          grants={project.connectionGrants}
          agentName={(id) => project.agents.find((a) => a.id === id)?.name ?? t("connectionsPicker.anAgent")}
          onStopGrant={(g) => api.stopConnectionGrant(project.id, g.agentId, g.connectionId).then(onChanged, (e) => alert(e.message))}
        />
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={() => setValue(project.connections)} />
    </section>
  );
}

function Models({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const [choice, setChoice] = useState(() => choiceOf(project));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(choice) !== JSON.stringify(choiceOf(project));
  const helpersLeft = choice.allowed.some((m) => !choice.coreOnly.includes(m));
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, choiceBody(choice)));
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
          <h2>{t("projectSettings.models.title")}</h2>
          <p>{t("projectSettings.models.desc2", { runtime: RUNTIME_LABEL[project.runtime ?? "opencode"] })}</p>
        </div>
      </div>
      <div style={{ padding: 12 }}>
        <ModelPicker value={choice} onChange={setChoice} runtime={project.runtime} />
      </div>
      <SaveBar
        dirty={dirty && choice.allowed.length > 0 && !!choice.coordinator && helpersLeft}
        saving={saving}
        onSave={save}
        onReset={() => setChoice(choiceOf(project))}
      />
    </section>
  );
}

function AlwaysAllowed({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
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
          <h2>{t("projectSettings.alwaysAllowed.title")}</h2>
          <p>{t("projectSettings.alwaysAllowed.desc")}</p>
        </div>
      </div>
      {project.allowedPatterns.length === 0 ? (
        <div className="section-empty">{t("projectSettings.alwaysAllowed.empty")}</div>
      ) : (
        <div className="section-body">
          {project.allowedPatterns.map((a) => (
            <div key={`${a.action}:${a.pattern}`} className="list-row">
              <span className="tag">{a.action}</span>
              <code className="grow">{a.pattern}</code>
              <button className="btn ghost sm" onClick={() => remove(a.action, a.pattern)} title={t("projectSettings.alwaysAllowed.revokeTitle")}>
                <X size={13} />
                {t("projectSettings.alwaysAllowed.revoke")}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
