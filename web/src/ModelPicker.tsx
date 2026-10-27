import { useEffect, useMemo, useState } from "react";
import { Check, Crown, Eye, Search } from "lucide-react";
import { api, type ModelInfo } from "./api";

/**
 * Choose which models the project may use, and which one core runs on.
 * Click a model to allow it; click the crown to run core on it.
 */
export function ModelPicker(props: {
  allowed: string[];
  coordinator: string;
  onChange: (allowed: string[], coordinator: string) => void;
}) {
  const { allowed, coordinator, onChange } = props;
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [visionOnly, setVisionOnly] = useState(false);
  // Models selected when the picker opened are listed first. Fixed for the session so
  // rows don't jump while the user toggles them.
  const [pinned] = useState(() => new Set(allowed));

  useEffect(() => {
    api
      .models()
      .then(setModels)
      .catch((e) => setError(e.message));
  }, []);

  const byProvider = useMemo(() => {
    const q = query.toLowerCase();
    const selected: ModelInfo[] = [];
    const groups = new Map<string, ModelInfo[]>();
    for (const m of models ?? []) {
      if (freeOnly && !m.free) continue;
      if (visionOnly && !m.vision) continue;
      if (q && !m.ref.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) continue;
      if (pinned.has(m.ref)) {
        selected.push(m);
        continue;
      }
      if (!groups.has(m.providerID)) groups.set(m.providerID, []);
      groups.get(m.providerID)!.push(m);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    return selected.length ? [["Selected", selected] as [string, ModelInfo[]], ...sorted] : sorted;
  }, [models, query, freeOnly, visionOnly, pinned]);

  const toggle = (ref: string) => {
    if (allowed.includes(ref)) {
      const next = allowed.filter((r) => r !== ref);
      onChange(next, coordinator === ref ? (next[0] ?? "") : coordinator);
    } else {
      onChange([...allowed, ref], coordinator || ref);
    }
  };
  const lead = (ref: string) => onChange(allowed.includes(ref) ? allowed : [...allowed, ref], ref);
  const nameOf = (ref: string) => models?.find((m) => m.ref === ref)?.name ?? ref;

  if (error) return <div className="error">Could not load models: {error}</div>;
  if (!models) return <div className="subtle">Loading models…</div>;

  return (
    <div className="model-picker">
      <div className="model-picker-head">
        <Search size={14} className="subtle" />
        <input placeholder="Search models…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> Free
        </label>
        <label className="check">
          <input type="checkbox" checked={visionOnly} onChange={(e) => setVisionOnly(e.target.checked)} /> Vision
        </label>
      </div>
      <div className="model-summary">
        {allowed.length === 0 ? (
          <span className="subtle">Select the models agents may use. Agents switch to the next one if a model fails.</span>
        ) : (
          <>
            <span>{allowed.length} selected ·</span>
            <span className="row" style={{ gap: 4 }}>
              <Crown size={12} style={{ color: "var(--amber)" }} />
              core runs on <strong style={{ color: "var(--text)" }}>{coordinator ? nameOf(coordinator) : "—"}</strong>
            </span>
          </>
        )}
      </div>
      <div className="model-groups">
        {byProvider.map(([provider, list]) => (
          <div key={provider}>
            <div className="model-group-title">{provider}</div>
            {list.map((m) => {
              const on = allowed.includes(m.ref);
              const isLead = coordinator === m.ref;
              return (
                <div key={m.ref} className={`model-row ${on ? "on" : ""}`} onClick={() => toggle(m.ref)}>
                  <span className="check-box">{on && <Check size={11} strokeWidth={3} />}</span>
                  <span className="model-name" title={m.ref}>
                    {m.name}
                    {pinned.has(m.ref) && <span className="subtle"> · {m.providerID}</span>}
                  </span>
                  {m.free && <span className="tag green">Free</span>}
                  <span className="subtle" title={m.vision ? "Can read images" : undefined} style={{ display: "inline-flex", width: 14, opacity: m.vision ? 1 : 0 }}>
                    <Eye size={13} />
                  </span>
                  <button
                    className={`lead-btn ${isLead ? "on" : ""}`}
                    title={isLead ? "core runs on this model" : "Run core on this model"}
                    onClick={(e) => {
                      e.stopPropagation();
                      lead(m.ref);
                    }}
                  >
                    <Crown size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {byProvider.length === 0 && <div className="section-empty">No models match.</div>}
      </div>
    </div>
  );
}
