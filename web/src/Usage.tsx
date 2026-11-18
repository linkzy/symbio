import { Simulator } from "./Simulator";
import { MASK, setCostsShown, useCostsShown } from "./privacy";
import { useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import { api, formatTokens, subscribe, type Price, type PriceInfo, type Project, type ProjectUsage, type Usage } from "./api";

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
  const usage = useProjectUsage(project.id);
  const shown = useCostsShown();
  if (!shown || !usage || usage.tokens === 0) return null;
  const detail = usage.agents
    .filter((a) => a.tokens > 0)
    .map((a) => `${a.name}: ${formatTokens(a.tokens)}${a.cost > 0 ? ` · ≈ ${usd(a.cost)}` : ""}`)
    .join("\n");
  return (
    <button className="usage-line" onClick={onOpen} title={`${detail}\n\nIncludes cache reads. Click for details.`}>
      <Coins size={13} />
      <span className="tnum">{formatTokens(usage.tokens)} tokens</span>
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
            first: i === 0 ? `${a.name}${a.status === "stopped" ? " (stopped)" : ""}${a.sessions > 1 ? ` · ${a.sessions} sessions` : ""}` : "",
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
          <h2>Usage</h2>
          <p>
            Tokens used by every agent of this project, including stopped ones and earlier sessions. The cost is an estimate from the
            prices in Settings → Model prices.
            {!shown && " Hidden: turn on Show costs and token counts in Settings to see them."}
          </p>
        </div>
        {usage && usage.tokens > 0 && (
          <div className="usage-total">
            <strong className="tnum">{usage.cost > 0 ? `≈ ${money(usage.cost)}` : "—"}</strong>
            <span className="subtle small tnum">{tokens(usage.tokens)} tokens</span>
          </div>
        )}
      </div>
      {!usage ? (
        <div className="section-empty">Loading…</div>
      ) : usage.tokens === 0 ? (
        <div className="section-empty">No usage yet.</div>
      ) : (
        <div style={{ padding: "4px 12px 12px", overflowX: "auto" }}>
          <div className="row" style={{ gap: 10, padding: "6px 0 8px", flexWrap: "wrap", alignItems: "center" }}>
            <div className="seg">
              {(["agent", "provider", "model"] as const).map((v) => (
                <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                  By {v}
                </button>
              ))}
            </div>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
              <option value="">All providers</option>
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
                <th>{view === "provider" ? "Provider" : view === "model" ? "Model" : "Agent"}</th>
                <th>{view === "provider" ? "" : view === "model" ? "Provider" : "Model"}</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache read</th>
                <th className="num">Cache write</th>
                <th className="num">≈ Cost</th>
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
                  <td className="num tnum">{r.cost === null ? "no price" : money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{provider ? `Total for ${provider}` : "Total"}</td>
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
              No price for {usage.unpriced.join(", ")}, so their tokens aren't in the estimate. Add it in Settings → Model prices.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const FIELDS: { key: keyof Price; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
];

/** Global settings: the price of each model in use, USD per million tokens. */
export function PricesSection() {
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
          <h2>Model prices</h2>
          <p>
            {tab === "prices"
              ? "USD per million tokens, used to estimate what projects cost. Models whose provider doesn't publish prices (like a company Azure deployment) get a suggestion from the same model in OpenCode's catalog: check it against your contract and save."
              : "What a model would cost at your usage: type its prices (USD per million tokens, as providers list them) and see the cost per day, week and month."}
          </p>
        </div>
        <div className="seg">
          <button className={tab === "prices" ? "on" : ""} onClick={() => setTab("prices")}>
            Prices
          </button>
          <button className={tab === "simulate" ? "on" : ""} onClick={() => setTab("simulate")}>
            Simulate
          </button>
        </div>
      </div>
      {tab === "simulate" ? (
        <Simulator prices={prices} />
      ) : !prices ? (
        <div className="section-empty">Loading…</div>
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
      ? "Your price"
      : info.source === "opencode"
        ? "From OpenCode"
        : info.source === "suggested"
          ? `Suggested from ${info.from} — not saved yet`
          : "No price";
  return (
    <div className="list-row price-row">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="list-title mono small ellipsis">{model}</div>
        <div className={`list-sub ${info.source === "suggested" || info.source === "none" ? "warn" : ""}`}>{sourceText}</div>
      </div>
      {FIELDS.map((f) => (
        <label key={f.key} className="price-field">
          <span>{f.label}</span>
          <input type="number" min={0} step="any" value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
        </label>
      ))}
      <button className="btn sm" onClick={() => save(parsed)} disabled={!canSave || saving}>
        {info.source === "suggested" && !changed ? "Accept" : "Save"}
      </button>
      {info.source === "yours" && (
        <button className="btn ghost sm" onClick={() => save(null)} disabled={saving} title="Forget your price">
          Reset
        </button>
      )}
    </div>
  );
}


/** Settings: whether costs and token counts are shown at all (hidden by default, in this browser). */
export function CostsSection() {
  const shown = useCostsShown();
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Costs and tokens</h2>
          <p>
            What projects spend and how many tokens they use: hidden unless you turn it on, so people passing by don't see it. The
            choice is kept in this browser, so other computers and phones start hidden too.
          </p>
        </div>
      </div>
      <div className="section-body" style={{ padding: "10px 16px 14px" }}>
        <label className="check">
          <input type="checkbox" checked={shown} onChange={(e) => setCostsShown(e.target.checked)} />
          Show costs and token counts
        </label>
      </div>
    </section>
  );
}
