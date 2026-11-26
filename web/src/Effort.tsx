import { useEffect, useState } from "react";
import { api, type Agent, type ModelInfo, type Project, type RuntimeKind } from "./api";
import { useI18n } from "./i18n";

// Reasoning effort: how much a model thinks before answering (low, medium, high…, as each model
// lists them). The project sets a level per model; an agent can have its own (Team.effortFor).

const cache = new Map<RuntimeKind, { at: number; models: Promise<ModelInfo[]> }>();

/** A runtime's models with their levels, shared by everything on the page (refreshed every few minutes). */
export function useModelInfos(runtime: RuntimeKind = "opencode"): ModelInfo[] | null {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  useEffect(() => {
    let hit = cache.get(runtime);
    if (!hit || Date.now() - hit.at > 5 * 60_000) {
      hit = { at: Date.now(), models: api.models(runtime) };
      hit.models.catch(() => cache.delete(runtime));
      cache.set(runtime, hit);
    }
    let live = true;
    hit.models.then((m) => live && setModels(m)).catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [runtime]);
  return models;
}

const levelsOf = (models: ModelInfo[] | null, ref: string) => models?.find((m) => m.ref === ref)?.efforts ?? [];

/** The level an agent runs at, as the server works it out (its own, else the project's for its model, if the model takes it). */
export function effectiveEffort(project: Project, agent: Agent, levels: string[]): string | null {
  for (const l of [agent.effort?.level, project.modelEfforts?.[agent.model]]) if (l && levels.includes(l)) return l;
  return null;
}

/** In an agent's chat header, next to its model: its reasoning effort level. Hidden when the model has none to choose. */
export function EffortSelect({ project, agent }: { project: Project; agent: Agent }) {
  const { t } = useI18n();
  const models = useModelInfos(agent.runtime ?? project.runtime);
  const levels = levelsOf(models, agent.model);
  if (!levels.length) return null;
  const projectLevel = project.modelEfforts?.[agent.model];
  const own = agent.effort?.level && levels.includes(agent.effort.level) ? agent.effort.level : "";
  const by = agent.effort?.by === "coordinator" ? ` ${t("agents.effort.setByCore")}` : "";
  return (
    <select
      className="inline-select effort-select"
      aria-label={t("agents.effort.label")}
      value={own}
      title={t("agents.effort.selectTitle", { name: agent.name, by })}
      onChange={(e) => api.setAgentEffort(project.id, agent.id, e.target.value || null).catch((err) => alert(err.message))}
    >
      <option value="">{projectLevel && levels.includes(projectLevel) ? t("agents.effort.projectOption", { level: projectLevel }) : t("agents.effort.defaultOption")}</option>
      {levels.map((l) => (
        <option key={l} value={l}>
          {t("agents.effort.option", { level: l })}
        </option>
      ))}
    </select>
  );
}

/** Project settings → Reasoning effort: a level per allowed model that has levels. Applies at once. */
export function EffortSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const models = useModelInfos(project.runtime);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = project.allowedModels.map((ref) => ({ ref, info: models?.find((m) => m.ref === ref) })).filter((r) => r.info?.efforts.length);
  async function set(ref: string, level: string) {
    setBusy(ref);
    try {
      onChanged(await api.updateProject(project.id, { modelEfforts: { [ref]: level || null } }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="section" id="effort">
      <div className="section-head">
        <div>
          <h2>{t("agents.effort.label")}</h2>
          <p>{t("agents.effort.intro")}</p>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 10 }}>
        {!models && <span className="subtle">{t("agents.models.loading")}</span>}
        {models && rows.length === 0 && <span className="subtle">{t("agents.effort.noLevels")}</span>}
        {rows.map(({ ref, info }) => (
          <label key={ref} className="effort-row">
            <span className="grow ellipsis" title={ref}>
              {info!.name}
              <span className="subtle"> · {info!.providerID}</span>
            </span>
            <select value={project.modelEfforts?.[ref] ?? ""} disabled={busy === ref} onChange={(e) => set(ref, e.target.value)} aria-label={t("agents.effort.for", { ref })}>
              <option value="">{t("agents.effort.default")}</option>
              {info!.efforts.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}
