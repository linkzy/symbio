import { useEffect, useMemo, useState } from "react";
import { Check, Crown, Eye, Lock, Search } from "lucide-react";
import { api, type ModelInfo, type RuntimeKind } from "./api";
import { useI18n } from "./i18n";

/** The project's models and who may use them (Project.coreModels, Project.coreOnlyModels). */
export interface ModelChoice {
  allowed: string[];
  /** The model core runs on now (one of `core`). */
  coordinator: string;
  /** Models core may use (the crowns). */
  core: string[];
  /** Models only core may use (the locks); helpers never get them. */
  coreOnly: string[];
}

/** A project's saved choice, as the picker shows it: no roles set means everyone may use everything. */
export function choiceOf(p: { allowedModels: string[]; coordinatorModel: string; coreModels?: string[]; coreOnlyModels?: string[] }): ModelChoice {
  const coreOnly = (p.coreOnlyModels ?? []).filter((m) => p.allowedModels.includes(m));
  const core = p.coreModels?.length ? p.allowedModels.filter((m) => p.coreModels!.includes(m) || coreOnly.includes(m)) : [...p.allowedModels];
  return { allowed: [...p.allowedModels], coordinator: p.coordinatorModel, core, coreOnly };
}

/** The models an agent of this role may use (the same rule as the server's modelsFor). */
export function modelsForRole(p: { allowedModels: string[]; coreModels?: string[]; coreOnlyModels?: string[] }, role: "coordinator" | "worker"): string[] {
  const coreOnly = (p.coreOnlyModels ?? []).filter((m) => p.allowedModels.includes(m));
  if (role === "coordinator") {
    if (!p.coreModels?.length) return p.allowedModels;
    const core = p.allowedModels.filter((m) => p.coreModels!.includes(m) || coreOnly.includes(m));
    return core.length ? core : p.allowedModels;
  }
  const helpers = p.allowedModels.filter((m) => !coreOnly.includes(m));
  return helpers.length ? helpers : p.allowedModels;
}

/** What to send to the server for a choice (it collapses "everything crowned, nothing locked" to no roles). */
export const choiceBody = (c: ModelChoice) => ({ allowedModels: c.allowed, coordinatorModel: c.coordinator, coreModels: c.core, coreOnlyModels: c.coreOnly });

/**
 * Choose which models the project may use and who may use each: click a model to allow it, the
 * crown for core to be able to use it (several can be crowned), the lock to keep it for core only.
 */
export function ModelPicker(props: { value: ModelChoice; onChange: (next: ModelChoice) => void; runtime?: RuntimeKind }) {
  const { t, locale } = useI18n();
  const { value, onChange } = props;
  const { allowed, core, coreOnly } = value;
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [visionOnly, setVisionOnly] = useState(false);
  // Models selected when the picker opened are listed first. Fixed for the session so
  // rows don't jump while the user toggles them.
  const [pinned] = useState(() => new Set(allowed));

  useEffect(() => {
    setModels(null);
    setError(null);
    api
      .models(props.runtime)
      .then(setModels)
      .catch((e) => setError(e.message));
  }, [props.runtime]);

  const visible = useMemo(() => {
    const q = query.toLowerCase();
    return (models ?? []).filter(
      (m) => (!freeOnly || m.free) && (!visionOnly || m.vision) && (!q || m.ref.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
    );
  }, [models, query, freeOnly, visionOnly]);

  const byProvider = useMemo(() => {
    const selected: ModelInfo[] = [];
    const groups = new Map<string, ModelInfo[]>();
    for (const m of visible) {
      if (pinned.has(m.ref)) {
        selected.push(m);
        continue;
      }
      if (!groups.has(m.providerID)) groups.set(m.providerID, []);
      groups.get(m.providerID)!.push(m);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    return selected.length ? [[t("agents.models.selected"), selected] as [string, ModelInfo[]], ...sorted] : sorted;
  }, [visible, pinned, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Every change goes through here: keeps the lists consistent and core on a model it may use. */
  const set = (next: { allowed: string[]; core: string[]; coreOnly: string[] }) => {
    const allowedNext = [...new Set(next.allowed)];
    const coreOnlyNext = [...new Set(next.coreOnly)].filter((m) => allowedNext.includes(m));
    const coreNext = allowedNext.filter((m) => next.core.includes(m) || coreOnlyNext.includes(m));
    const coordinator = coreNext.includes(value.coordinator) ? value.coordinator : (coreNext[0] ?? "");
    onChange({ allowed: allowedNext, core: coreNext, coreOnly: coreOnlyNext, coordinator });
  };
  // A newly allowed model is core's too when core may use everything so far (or nothing yet).
  const crownNew = core.length === 0 || core.length === allowed.length;

  const toggle = (ref: string) => {
    if (allowed.includes(ref)) set({ allowed: allowed.filter((r) => r !== ref), core, coreOnly });
    else set({ allowed: [...allowed, ref], core: crownNew ? [...core, ref] : core, coreOnly });
  };
  const toggleCrown = (ref: string) => {
    if (allowed.includes(ref) && core.includes(ref)) {
      if (core.length === 1) return; // core needs a model
      set({ allowed, core: core.filter((r) => r !== ref), coreOnly: coreOnly.filter((r) => r !== ref) });
    } else set({ allowed: allowed.includes(ref) ? allowed : [...allowed, ref], core: [...core, ref], coreOnly });
  };
  const toggleLock = (ref: string) => {
    if (allowed.includes(ref) && coreOnly.includes(ref)) set({ allowed, core, coreOnly: coreOnly.filter((r) => r !== ref) });
    else set({ allowed: allowed.includes(ref) ? allowed : [...allowed, ref], core: [...core, ref], coreOnly: [...coreOnly, ref] });
  };
  const selectAll = () => {
    const added = visible.map((m) => m.ref).filter((r) => !allowed.includes(r));
    set({ allowed: [...allowed, ...added], core: crownNew ? [...core, ...added] : core, coreOnly });
  };
  const selectNone = () => set({ allowed: [], core: [], coreOnly: [] });

  const nameOf = (ref: string) => models?.find((m) => m.ref === ref)?.name ?? ref;
  const helpers = allowed.filter((m) => !coreOnly.includes(m));
  const everyone = core.length === allowed.length && coreOnly.length === 0;

  if (error) return <div className="error">{t("agents.models.loadError", { error })}</div>;
  if (!models) return <div className="subtle">{t("agents.models.loading")}</div>;

  return (
    <div className="model-picker">
      <div className="model-picker-head">
        <Search size={14} className="subtle" />
        <input placeholder={t("agents.models.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> {t("agents.models.free")}
        </label>
        <label className="check">
          <input type="checkbox" checked={visionOnly} onChange={(e) => setVisionOnly(e.target.checked)} /> {t("agents.models.vision")}
        </label>
        <button
          className="btn ghost xs"
          onClick={selectAll}
          disabled={visible.every((m) => allowed.includes(m.ref))}
          title={t("agents.models.selectAllTitle")}
        >
          {t("agents.models.selectAll")}
        </button>
        <button className="btn ghost xs" onClick={selectNone} disabled={allowed.length === 0}>
          {t("common.none")}
        </button>
      </div>
      <div className="model-summary">
        {allowed.length === 0 ? (
          <span className="subtle">{t("agents.models.empty")}</span>
        ) : everyone ? (
          <span>
            {t("agents.models.everyone", { n: allowed.length })} <Crown size={12} style={{ color: "var(--amber)", verticalAlign: -1 }} /> {t("agents.models.coreRunsOn")}{" "}
            <strong style={{ color: "var(--text)" }}>{value.coordinator ? nameOf(value.coordinator) : "—"}</strong>
          </span>
        ) : (
          <span>
            <Crown size={12} style={{ color: "var(--amber)", verticalAlign: -1 }} /> {t("agents.models.coreAndHelpers", { core: core.map(nameOf).join(", ") })}{" "}
            {helpers.length ? helpers.map(nameOf).join(", ") : <strong style={{ color: "var(--red)" }}>{t("agents.models.noHelpers")}</strong>}
          </span>
        )}
      </div>
      <div className="model-groups">
        {byProvider.map(([provider, list]) => (
          <div key={provider}>
            <div className="model-group-title">{provider}</div>
            {list.map((m) => {
              const on = allowed.includes(m.ref);
              const crowned = on && core.includes(m.ref);
              const locked = on && coreOnly.includes(m.ref);
              return (
                <div key={m.ref} className={`model-row ${on ? "on" : ""}`} onClick={() => toggle(m.ref)}>
                  <span className="check-box">{on && <Check size={11} strokeWidth={3} />}</span>
                  <span className="model-name" title={m.ref}>
                    {m.name}
                    {pinned.has(m.ref) && <span className="subtle"> · {m.providerID}</span>}
                  </span>
                  {m.free && <span className="tag green">{t("agents.models.free")}</span>}
                  <span className="subtle" title={m.vision ? t("agents.models.canReadImages") : undefined} style={{ display: "inline-flex", width: 14, opacity: m.vision ? 1 : 0 }}>
                    <Eye size={13} />
                  </span>
                  <button
                    className={`lead-btn ${crowned ? "on" : ""}`}
                    title={crowned ? (m.ref === value.coordinator ? t("agents.models.coreRuns") : t("agents.models.coreMay")) : t("agents.models.letCore")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCrown(m.ref);
                    }}
                  >
                    <Crown size={14} />
                  </button>
                  <button
                    className={`lock-btn ${locked ? "on" : ""}`}
                    title={locked ? t("agents.models.onlyCore") : t("agents.models.keepCore")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLock(m.ref);
                    }}
                  >
                    <Lock size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {byProvider.length === 0 && <div className="section-empty">{t("agents.models.noMatch")}</div>}
      </div>
    </div>
  );
}
