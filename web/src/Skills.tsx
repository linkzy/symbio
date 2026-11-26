import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { BookOpen, Download, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, type Agent, type Project, type SkillInfo } from "./api";
import { Md } from "./files";
import { Dialog } from "./ui";
import { useI18n, type MessageKey } from "./i18n";

// Skills (server: skills.ts): packaged methods agents load when a task calls for one. Settings has
// the library (Symbio's and the human's own, and others found on this computer to add a copy of);
// a project's settings choose core's skills and the ones core may give helpers; a helper's chat
// shows its skills, which the human can change.

function useSkills() {
  const [data, setData] = useState<{ skills: SkillInfo[]; computer: SkillInfo[]; categories: { id: string; label: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api.skills().then(
      (d) => (setData(d), setError(null)),
      (e) => setError((e as Error).message),
    );
  useEffect(() => {
    void reload();
  }, []);
  return { data, error, reload };
}

/** Who wrote a skill: Symbio's own, or its author (linked), its license and where it comes from. */
function Credit({ skill }: { skill: SkillInfo }) {
  const { t } = useI18n();
  const c = skill.credit;
  if (!c) return null;
  if (c.author === "Symbio") return <span className="tag">{t("agents.skills.symbios")}</span>;
  return (
    <span className="skill-credit subtle small">
      {t("agents.skills.by")}{" "}
      {c.authorUrl ? (
        <a href={c.authorUrl} target="_blank" rel="noreferrer">
          {c.author}
        </a>
      ) : (
        c.author
      )}
      {c.license && ` · ${c.license}`}
      {c.source && (
        <>
          {" · "}
          <a href={c.source} target="_blank" rel="noreferrer">
            {t("agents.skills.source")}
          </a>
        </>
      )}
    </span>
  );
}

/** A skill's SKILL.md, to read before adding or giving it. */
function SkillView({ skill, onClose, footer }: { skill: SkillInfo; onClose: () => void; footer?: React.ReactNode }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    api.skillText(skill.name).then(
      (r) => setText(r.text),
      (e) => setText(t("agents.skills.readError", { error: (e as Error).message })),
    );
  }, [skill.name]);
  return (
    <Dialog title={skill.name} subtitle={skill.description} onClose={onClose} wide footer={footer}>
      {skill.credit && skill.credit.author !== "Symbio" && (
        <div className="skill-credit-box small">
          <Credit skill={skill} />
          {skill.credit.changes?.length ? <div className="subtle">{t("agents.skills.symbiosCopy", { changes: skill.credit.changes.join("; ") })}</div> : null}
        </div>
      )}
      <div className="skill-source subtle small">
        {skill.dir}
        {skill.files.length > 0 &&
          ` · ${t(skill.files.length === 1 ? "agents.skills.alsoFile" : "agents.skills.alsoFiles", { n: skill.files.length, files: `${skill.files.slice(0, 8).join(", ")}${skill.files.length > 8 ? "…" : ""}` })}`}
      </div>
      <div className="skill-text">{text === null ? <span className="subtle">{t("common.loading")}</span> : <Md text={text.replace(/^---[\s\S]*?---\s*/, "")} projectId="" />}</div>
    </Dialog>
  );
}

/** Settings → Skills: the library. */
export function SkillsSection() {
  const { t } = useI18n();
  const { data, error, reload } = useSkills();
  const [viewing, setViewing] = useState<SkillInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [fromFolder, setFromFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const q = query.trim().toLowerCase();
  const shown = (data?.skills ?? []).filter(
    (s) => (category === "all" || s.category === category) && (!q || `${s.name} ${s.description} ${s.credit?.author ?? ""}`.toLowerCase().includes(q)),
  );
  const groups = (data?.categories ?? []).map((c) => ({ ...c, skills: shown.filter((s) => s.category === c.id) })).filter((g) => g.skills.length);
  const present = (data?.categories ?? []).filter((c) => data?.skills.some((s) => s.category === c.id));

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" id="skills">
      <div className="section-head">
        <div>
          <h2>{t("agents.skills.title")}</h2>
          <p>{t("agents.skills.intro")}</p>
        </div>
        <button className="btn sm" onClick={() => setCreating(true)}>
          <Plus size={13} />
          {t("agents.skills.new")}
        </button>
      </div>
      <div className="section-body">
        {error && <div className="error">{error}</div>}
        <div className="skill-filters">
          <input placeholder={t("agents.skills.search")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("agents.skills.search")} />
          <div className="chips">
            {[{ id: "all", label: t("agents.skills.all") }, ...present].map((c) => (
              <button key={c.id} className={`chip${category === c.id ? " on" : ""}`} onClick={() => setCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {data && shown.length === 0 && <div className="subtle small" style={{ padding: "8px 4px" }}>{t("agents.skills.noMatch")}</div>}
        {groups.map((g) => (
          <div key={g.id} className="skill-category" data-category={g.id}>
            <div className="skill-group-title">{g.label}</div>
            {g.skills.map((s) => (
          <div key={s.name} className="list-row skill-row">
            <Sparkles size={15} className="subtle" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="list-title">
                {s.name} <Credit skill={s} />
              </div>
              <div className="list-sub" title={s.description}>{s.description}</div>
            </div>
            <button className="btn ghost sm" onClick={() => setViewing(s)}>
              <BookOpen size={13} />
              {t("agents.skills.read")}
            </button>
            {s.source === "library" && (
              <button
                className="btn ghost icon sm"
                title={t("agents.skills.removeTitle", { name: s.name })}
                aria-label={t("agents.skills.removeTitle", { name: s.name })}
                disabled={busy}
                onClick={() => confirm(t("agents.skills.removeConfirm", { name: s.name })) && act(() => api.removeSkill(s.name))}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
            ))}
          </div>
        ))}

        {data && data.computer.length > 0 && (
          <>
            <div className="skill-group-title">{t("agents.skills.computer")}</div>
            {data.computer.map((s) => (
              <div key={`${s.dir}`} className="list-row skill-row">
                <Sparkles size={15} className="subtle" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="list-title">{s.name}</div>
                  <div className="list-sub" title={s.description}>{s.description}</div>
                </div>
                <button className="btn sm" onClick={() => setViewing(s)}>
                  <Download size={13} />
                  {t("agents.skills.readAndAdd")}
                </button>
              </div>
            ))}
          </>
        )}

        <div className="skill-import row">
          <input
            placeholder={t("agents.skills.fromFolder")}
            value={fromFolder}
            onChange={(e) => setFromFolder(e.target.value)}
          />
          <button
            className="btn sm"
            disabled={busy || !fromFolder.trim()}
            onClick={() => act(async () => (await api.importSkill(fromFolder.trim()), setFromFolder("")))}
          >
            {t("agents.skills.addCopy")}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {viewing && (
          <SkillView
            skill={viewing}
            onClose={() => setViewing(null)}
            footer={
              viewing.source === "computer" ? (
                <>
                  <span className="subtle small grow">{t("agents.skills.readFirst")}</span>
                  <button className="btn ghost" onClick={() => setViewing(null)}>
                    {t("common.cancel")}
                  </button>
                  <button className="btn primary" disabled={busy} onClick={() => act(() => api.importSkill(viewing.dir)).then(() => setViewing(null))}>
                    {t("agents.skills.addCopy")}
                  </button>
                </>
              ) : undefined
            }
          />
        )}
        {creating && <NewSkillDialog onClose={() => setCreating(false)} onCreated={() => (setCreating(false), void reload())} />}
      </AnimatePresence>
    </section>
  );
}

function NewSkillDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.createSkill({ name, description, instructions });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t("agents.skills.new")}
      subtitle={t("agents.skills.newSubtitle")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !description.trim() || !instructions.trim()}>
            {t("common.create")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("agents.skills.name")}</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder={t("agents.skills.namePlaceholder")} />
        <span className="hint">{t("agents.skills.nameHint")}</span>
      </label>
      <label className="field">
        <span>{t("agents.skills.description")}</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("agents.skills.descriptionPlaceholder")} />
        <span className="hint">{t("agents.skills.descriptionHint")}</span>
      </label>
      <label className="field">
        <span>{t("agents.skills.instructions")}</span>
        <textarea rows={12} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t("agents.skills.instructionsPlaceholder")} />
      </label>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}

/** Checkboxes over the library: which skills are chosen. */
/** The library's categories, in order (as skills.ts lists them). */
const CATEGORY_ORDER = ["leading", "planning", "software", "design", "writing", "data", "operations", "media", "other"];
const CATEGORY_LABEL: Record<string, MessageKey> = {
  leading: "agents.skills.category.leading",
  planning: "agents.skills.category.planning",
  software: "agents.skills.category.software",
  design: "agents.skills.category.design",
  writing: "agents.skills.category.writing",
  data: "agents.skills.category.data",
  operations: "agents.skills.category.operations",
  media: "agents.skills.category.media",
  other: "agents.skills.category.other",
};

export function SkillChecklist({ skills, chosen, onChange, disabled }: { skills: SkillInfo[]; chosen: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const order = (s: SkillInfo) => CATEGORY_ORDER.indexOf(s.category) + (CATEGORY_ORDER.includes(s.category) ? 0 : 99);
  const sorted = [...skills].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return (
    <div className="skill-checklist">
      {sorted.map((s, i) => (
        <div key={s.name}>
          {(i === 0 || sorted[i - 1].category !== s.category) && <div className="skill-group-title">{CATEGORY_LABEL[s.category] ? t(CATEGORY_LABEL[s.category]) : s.category}</div>}
        <label key={s.name} className="check skill-check">
          <input
            type="checkbox"
            checked={chosen.includes(s.name)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...chosen, s.name] : chosen.filter((x) => x !== s.name))}
          />
          <span>
            <strong>{s.name}</strong>
            <span className="hint" title={s.description}>{s.description}</span>
          </span>
        </label>
        </div>
      ))}
      {skills.length === 0 && <span className="subtle small">{t("agents.skills.emptyLibrary")}</span>}
    </div>
  );
}

const DEFAULT_CORE = ["briefing", "glossary", "handoff", "review"];

/** Project settings → Skills: core's, and the ones core may give helpers. */
export function ProjectSkillsSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const { data } = useSkills();
  const library = data?.skills ?? [];
  const names = library.map((s) => s.name);
  const [core, setCore] = useState<string[]>(project.coreSkills ?? DEFAULT_CORE);
  const [helpers, setHelpers] = useState<string[] | null>(project.helperSkills ?? null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setCore(project.coreSkills ?? DEFAULT_CORE);
    setHelpers(project.helperSkills ?? null);
  }, [project.coreSkills, project.helperSkills]);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const dirty = !sameSet(core, project.coreSkills ?? DEFAULT_CORE) || (helpers === null) !== (project.helperSkills === undefined) || (helpers !== null && !sameSet(helpers, project.helperSkills ?? []));
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { coreSkills: core.filter((s) => names.includes(s)), helperSkills: helpers === null ? null : helpers }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="section" id="project-skills">
      <div className="section-head">
        <div>
          <h2>{t("agents.skills.title")}</h2>
          <p>{t("agents.skills.projectIntro")}</p>
        </div>
      </div>
      <div className="section-body">
        <div className="field">
          <span>{t("agents.skills.coreSkills")}</span>
          <SkillChecklist skills={library} chosen={core} onChange={setCore} />
        </div>
        <div className="field">
          <span>{t("agents.skills.helperSkills")}</span>
          <label className="check">
            <input type="checkbox" checked={helpers === null} onChange={(e) => setHelpers(e.target.checked ? null : [...names])} />
            {t("agents.skills.anySkill")}
          </label>
          {helpers !== null && <SkillChecklist skills={library} chosen={helpers} onChange={setHelpers} />}
        </div>
        {dirty && (
          <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
            <button className="btn ghost sm" onClick={() => (setCore(project.coreSkills ?? DEFAULT_CORE), setHelpers(project.helperSkills ?? null))} disabled={saving}>
              {t("agents.skills.reset")}
            </button>
            <button className="btn primary sm" onClick={save} disabled={saving}>
              {t("common.save")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** In a chat header: the agent's skills; for a helper, a click to change them. */
export function AgentSkills({ project, agent }: { project: Project; agent: Agent }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const skills = agent.role === "coordinator" ? (project.coreSkills ?? DEFAULT_CORE) : (agent.skills ?? []);
  const label = skills.length ? t(skills.length === 1 ? "agents.skills.countOne" : "agents.skills.countMany", { n: skills.length }) : t("agents.skills.noneShort");
  return (
    <>
      {" · "}
      <button
        className="inline-select agent-skills"
        title={skills.length ? t("agents.skills.list", { list: skills.join(", ") }) : t("agents.skills.none")}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <AnimatePresence>{open && <AgentSkillsDialog project={project} agent={agent} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function AgentSkillsDialog({ project, agent, onClose }: { project: Project; agent: Agent; onClose: () => void }) {
  const { t } = useI18n();
  const { data } = useSkills();
  const [chosen, setChosen] = useState<string[]>(agent.skills ?? []);
  if (agent.role === "coordinator") {
    const mine = project.coreSkills ?? DEFAULT_CORE;
    return (
      <Dialog title={t("agents.skills.coreSkills")} subtitle={t("agents.skills.coreSubtitle")} onClose={onClose}>
        <SkillChecklist skills={(data?.skills ?? []).filter((s) => mine.includes(s.name))} chosen={mine} onChange={() => {}} disabled />
      </Dialog>
    );
  }
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.setAgentSkills(project.id, agent.id, chosen);
      onClose();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t("agents.skills.list", { list: agent.name })}
      subtitle={t("agents.skills.agentSubtitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <SkillChecklist skills={data?.skills ?? []} chosen={chosen} onChange={setChosen} />
    </Dialog>
  );
}
