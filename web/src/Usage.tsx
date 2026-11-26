import { Simulator } from "./Simulator";
import { MASK, setCostsShown, useCostsShown } from "./privacy";
import { useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import { api, formatTokens, subscribe, type Price, type PriceInfo, type Project, type ProjectUsage, type Usage } from "./api";
import { useI18n, type MessageKey } from "./i18n";

const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

/** The project's usage report, refreshed (at most every few seconds) as agents work. */
export function useProjectUsage(projectId: string): ProjectUsage | null {
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const load = () => api.projectUsage(projectId).then(setUsage).catch(() => {});
    void load();
    const unsubscribe = subscribe((e) => {
      if ((e.type === "project.updated" && e.projectId === projectId) || e.type === "prices.updated") {
        if (timer.current) return;
        timer.current = setTimeout(() => {
          timer.current = null;
          void load();
        }, 4000);
      }
    });
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId]);
  return usage;
}

/** Sidebar footer: everything the project's agents used, and what it probably cost. */
export function UsageLine({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const { t } = useI18n();
  const usage = useProjectUsage(project.id);
  const shown = useCostsShown();
  if (!shown || !usage || usage.tokens === 0) return null;
  const detail = usage.agents
    .filter((a) => a.tokens > 0)
    .map((a) => `${a.name}: ${formatTokens(a.tokens)}${a.cost > 0 ? ` · ≈ ${usd(a.cost)}` : ""}`)
    .join("\n");
  return (
    <button className="usage-line" onClick={onOpen} title={`${detail}\n\n${t("usage.line.title")}`}>
      <Coins size={13} />
      <span className="tnum">{t("usage.tokens", { n: formatTokens(usage.tokens) })}</span>
      {usage.cost > 0 && <span className="subtle tnum">· ≈ {usd(usage.cost)}</span>}
    </button>
  );
}

const providerOf = (model: string) => (model.includes("/") ? model.slice(0, model.indexOf("/")) : model);
const addUsage = (a: Usage, b: Usage): Usage => ({
  cost: a.cost + b.cost,
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
interface UsageRow {
  key: string;
  first: string;
  second: string;
  usage: Usage;
  cost: number | null;
  muted?: boolean;
}

/** Project settings: usage per agent and model, with the estimate. */
export function UsageSection({ project }: { project: Project }) {
  const { t } = useI18n();
  const usage = useProjectUsage(project.id);
  const shown = useCostsShown();
  const tokens = (n: number) => (shown ? formatTokens(n) : MASK);
  const money = (n: number) => (shown ? usd(n) : MASK);
  const [view, setView] = useState<"agent" | "provider" | "model">("agent");
  const [provider, setProvider] = useState("");
  // The rows of the chosen grouping, narrowed to one provider if picked, and what they add up to.
  const rows: UsageRow[] = [];
  if (usage) {
    if (view === "provider") {
      for (const p of usage.byProvider) if (!provider || p.provider === provider) rows.push({ key: p.provider, first: p.provider, second: "", usage: p.usage, cost: p.cost });
    } else if (view === "model") {
      for (const m of usage.byModel) if (!provider || m.provider === provider) rows.push({ key: m.model, first: m.model, second: m.provider, usage: m.usage, cost: m.cost });
    } else {
      for (const a of usage.agents) {
        const mine = a.byModel.filter((m) => !provider || providerOf(m.model) === provider);
        mine.forEach((m, i) =>
          rows.push({
            key: `${a.id}-${m.model}`,
            first:
              i === 0
                ? `${a.name}${a.status === "stopped" ? ` ${t("usage.usage.stopped")}` : ""}${a.sessions > 1 ? ` · ${t("usage.usage.sessions", { n: a.sessions })}` : ""}`
                : "",
            second: m.model,
            usage: m.usage,
            cost: m.cost,
            muted: a.status === "stopped",
          }),
        );
      }
    }
  }
  const selected = rows.reduce(
    (s, r) => ({ usage: addUsage(s.usage, r.usage), cost: s.cost + (r.cost ?? 0) }),
    { usage: { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as Usage, cost: 0 },
  );
  return (
    <section className="section" id="usage">
      <div className="section-head">
        <div>
          <h2>{t("usage.usage.title")}</h2>
          <p>
            {t("usage.usage.intro")}
            {!shown && ` ${t("usage.usage.hidden")}`}
          </p>
        </div>
        {usage && usage.tokens > 0 && (
          <div className="usage-total">
            <strong className="tnum">{usage.cost > 0 ? `≈ ${money(usage.cost)}` : "—"}</strong>
            <span className="subtle small tnum">{t("usage.tokens", { n: tokens(usage.tokens) })}</span>
          </div>
        )}
      </div>
      {!usage ? (
        <div className="section-empty">{t("common.loading")}</div>
      ) : usage.tokens === 0 ? (
        <div className="section-empty">{t("usage.usage.empty")}</div>
      ) : (
        <div style={{ padding: "4px 12px 12px", overflowX: "auto" }}>
          <div className="row" style={{ gap: 10, padding: "6px 0 8px", flexWrap: "wrap", alignItems: "center" }}>
            <div className="seg">
              {(["agent", "provider", "model"] as const).map((v) => (
                <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                  {t(v === "agent" ? "usage.usage.byAgent" : v === "provider" ? "usage.usage.byProvider" : "usage.usage.byModel")}
                </button>
              ))}
            </div>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label={t("usage.usage.provider")}>
              <option value="">{t("usage.usage.allProviders")}</option>
              {usage.byProvider.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.provider}
                </option>
              ))}
            </select>
          </div>
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t(view === "provider" ? "usage.usage.provider" : view === "model" ? "usage.usage.model" : "usage.usage.agent")}</th>
                <th>{view === "provider" ? "" : t(view === "model" ? "usage.usage.provider" : "usage.usage.model")}</th>
                <th className="num">{t("usage.field.input")}</th>
                <th className="num">{t("usage.field.output")}</th>
                <th className="num">{t("usage.field.cacheRead")}</th>
                <th className="num">{t("usage.field.cacheWrite")}</th>
                <th className="num">{t("usage.usage.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.muted ? "muted" : ""}>
                  <td className={view === "agent" ? "" : "mono small"}>{r.first}</td>
                  <td className="mono small">{r.second}</td>
                  <td className="num tnum">{tokens(r.usage.input)}</td>
                  <td className="num tnum">{tokens(r.usage.output + r.usage.reasoning)}</td>
                  <td className="num tnum">{tokens(r.usage.cacheRead)}</td>
                  <td className="num tnum">{tokens(r.usage.cacheWrite)}</td>
                  <td className="num tnum">{r.cost === null ? t("usage.usage.noPrice") : money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{provider ? t("usage.usage.totalFor", { provider }) : t("usage.usage.total")}</td>
                <td className="num tnum">{tokens(selected.usage.input)}</td>
                <td className="num tnum">{tokens(selected.usage.output + selected.usage.reasoning)}</td>
                <td className="num tnum">{tokens(selected.usage.cacheRead)}</td>
                <td className="num tnum">{tokens(selected.usage.cacheWrite)}</td>
                <td className="num tnum">{money(selected.cost)}</td>
              </tr>
            </tfoot>
          </table>
          {usage.unpriced.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              {t("usage.usage.unpriced", { models: usage.unpriced.join(", ") })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const FIELDS: { key: keyof Price; label: MessageKey }[] = [
  { key: "input", label: "usage.field.input" },
  { key: "output", label: "usage.field.output" },
  { key: "cacheRead", label: "usage.field.cacheRead" },
  { key: "cacheWrite", label: "usage.field.cacheWrite" },
];

/** Global settings: the price of each model in use, USD per million tokens. */
export function PricesSection() {
  const { t } = useI18n();
  const [prices, setPrices] = useState<Record<string, PriceInfo> | null>(null);
  const [tab, setTab] = useState<"prices" | "simulate">("prices");
  const load = () => api.prices().then(setPrices).catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{t("usage.prices.title")}</h2>
          <p>{tab === "prices" ? t("usage.prices.intro") : t("usage.prices.simulateIntro")}</p>
        </div>
        <div className="seg">
          <button className={tab === "prices" ? "on" : ""} onClick={() => setTab("prices")}>
            {t("usage.prices.tab")}
          </button>
          <button className={tab === "simulate" ? "on" : ""} onClick={() => setTab("simulate")}>
            {t("usage.prices.simulate")}
          </button>
        </div>
      </div>
      {tab === "simulate" ? (
        <Simulator prices={prices} />
      ) : !prices ? (
        <div className="section-empty">{t("common.loading")}</div>
      ) : (
        <div className="section-body">
          {Object.entries(prices)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([model, info]) => (
              <PriceRow key={model} model={model} info={info} onSaved={load} />
            ))}
        </div>
      )}
    </section>
  );
}

function PriceRow({ model, info, onSaved }: { model: string; info: PriceInfo; onSaved: () => void }) {
  const { t } = useI18n();
  const initial = () => Object.fromEntries(FIELDS.map((f) => [f.key, info.price ? String(info.price[f.key]) : ""])) as Record<keyof Price, string>;
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValues(initial()), [info]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed: Price = {
    input: Number(values.input),
    output: Number(values.output),
    cacheRead: Number(values.cacheRead),
    cacheWrite: Number(values.cacheWrite),
  };
  const valid = FIELDS.every((f) => values[f.key].trim() !== "" && Number.isFinite(parsed[f.key]) && parsed[f.key] >= 0);
  const changed = FIELDS.some((f) => values[f.key] !== (info.price ? String(info.price[f.key]) : ""));
  const canSave = valid && (changed || info.source === "suggested");
  async function save(price: Price | null) {
    setSaving(true);
    try {
      await api.setPrice(model, price);
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const sourceText =
    info.source === "yours"
      ? t("usage.prices.yours")
      : info.source === "opencode"
        ? model.startsWith("copilot/")
          ? t("usage.prices.fromCopilot")
          : t("usage.prices.fromOpenCode")
        : info.source === "suggested"
          ? t("usage.prices.suggested", { from: String(info.from) })
          : t("usage.prices.none");
  return (
    <div className="list-row price-row">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="list-title mono small ellipsis">{model}</div>
        <div className={`list-sub ${info.source === "suggested" || info.source === "none" ? "warn" : ""}`}>{sourceText}</div>
      </div>
      {FIELDS.map((f) => (
        <label key={f.key} className="price-field">
          <span>{t(f.label)}</span>
          <input type="number" min={0} step="any" value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
        </label>
      ))}
      <button className="btn sm" onClick={() => save(parsed)} disabled={!canSave || saving}>
        {info.source === "suggested" && !changed ? t("usage.prices.accept") : t("common.save")}
      </button>
      {info.source === "yours" && (
        <button className="btn ghost sm" onClick={() => save(null)} disabled={saving} title={t("usage.prices.resetTitle")}>
          {t("usage.prices.reset")}
        </button>
      )}
    </div>
  );
}


/** Settings: whether costs and token counts are shown at all (hidden by default, in this browser). */
export function CostsSection() {
  const { t } = useI18n();
  const shown = useCostsShown();
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{t("usage.costs.title")}</h2>
          <p>{t("usage.costs.intro")}</p>
        </div>
      </div>
      <div className="section-body" style={{ padding: "10px 16px 14px" }}>
        <label className="check">
          <input type="checkbox" checked={shown} onChange={(e) => setCostsShown(e.target.checked)} />
          {t("usage.costs.show")}
        </label>
      </div>
    </section>
  );
}
