import { useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import { api, formatTokens, subscribe, type Price, type PriceInfo, type Project, type ProjectUsage } from "./api";

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
  if (!usage || usage.tokens === 0) return null;
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

/** Project settings: usage per agent and model, with the estimate. */
export function UsageSection({ project }: { project: Project }) {
  const usage = useProjectUsage(project.id);
  return (
    <section className="section" id="usage">
      <div className="section-head">
        <div>
          <h2>Usage</h2>
          <p>
            Tokens used by every agent of this project, including stopped ones and earlier sessions. The cost is an estimate from the
            prices in Settings → Model prices.
          </p>
        </div>
        {usage && usage.tokens > 0 && (
          <div className="usage-total">
            <strong className="tnum">{usage.cost > 0 ? `≈ ${usd(usage.cost)}` : "—"}</strong>
            <span className="subtle small tnum">{formatTokens(usage.tokens)} tokens</span>
          </div>
        )}
      </div>
      {!usage ? (
        <div className="section-empty">Loading…</div>
      ) : usage.tokens === 0 ? (
        <div className="section-empty">No usage yet.</div>
      ) : (
        <div style={{ padding: "4px 12px 12px", overflowX: "auto" }}>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache read</th>
                <th className="num">Cache write</th>
                <th className="num">≈ Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.agents.flatMap((a) =>
                a.byModel.map((m, i) => (
                  <tr key={`${a.id}-${m.model}`} className={a.status === "stopped" ? "muted" : ""}>
                    <td>{i === 0 ? `${a.name}${a.status === "stopped" ? " (stopped)" : ""}${a.sessions > 1 ? ` · ${a.sessions} sessions` : ""}` : ""}</td>
                    <td className="mono small">{m.model}</td>
                    <td className="num tnum">{formatTokens(m.usage.input)}</td>
                    <td className="num tnum">{formatTokens(m.usage.output + m.usage.reasoning)}</td>
                    <td className="num tnum">{formatTokens(m.usage.cacheRead)}</td>
                    <td className="num tnum">{formatTokens(m.usage.cacheWrite)}</td>
                    <td className="num tnum">{m.cost === null ? "no price" : usd(m.cost)}</td>
                  </tr>
                )),
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td className="num tnum">{formatTokens(usage.total.input)}</td>
                <td className="num tnum">{formatTokens(usage.total.output + usage.total.reasoning)}</td>
                <td className="num tnum">{formatTokens(usage.total.cacheRead)}</td>
                <td className="num tnum">{formatTokens(usage.total.cacheWrite)}</td>
                <td className="num tnum">{usd(usage.cost)}</td>
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

type Daily = { input: string; cacheRead: string; cacheWrite: string; output: string };
const M = 1_000_000;
const millions = (n: number) => (n / M >= 100 ? (n / M).toFixed(0) : (n / M).toFixed(1));
const dollars = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

/**
 * The price simulator: a model's prices against your average daily tokens (across projects, since
 * each started), or any amounts you type, to compare providers before choosing one.
 */
function Simulator({ prices }: { prices: Record<string, PriceInfo> | null }) {
  const [price, setPrice] = useState<Record<keyof Price, string>>({ input: "", output: "", cacheRead: "", cacheWrite: "" });
  const [daily, setDaily] = useState<Daily | null>(null);
  const [average, setAverage] = useState<Awaited<ReturnType<typeof api.usageAverage>> | null>(null);
  useEffect(() => {
    api
      .usageAverage()
      .then((a) => {
        setAverage(a);
        const d = a.perDay;
        setDaily({ input: millions(d.input), cacheRead: millions(d.cacheRead), cacheWrite: millions(d.cacheWrite), output: millions(d.output + d.reasoning) });
      })
      .catch(() => setDaily({ input: "0", cacheRead: "0", cacheWrite: "0", output: "0" }));
  }, []);

  const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
  // A blank cache write price is the input price (most providers charge writes as input).
  const p = { input: n(price.input), output: n(price.output), cacheRead: n(price.cacheRead), cacheWrite: price.cacheWrite.trim() ? n(price.cacheWrite) : n(price.input) };
  const t = daily && { input: n(daily.input), cacheRead: n(daily.cacheRead), cacheWrite: n(daily.cacheWrite), output: n(daily.output) };
  // Without a cache read price, cached tokens cost as input (no cache discount).
  const cacheReadPrice = Number.isFinite(p.cacheRead) ? p.cacheRead : p.input;
  const perDay =
    t && [p.input, p.output].every(Number.isFinite) && Object.values(t).every((v) => Number.isFinite(v) && v >= 0)
      ? t.input * p.input + t.cacheRead * cacheReadPrice + t.cacheWrite * p.cacheWrite + t.output * p.output
      : null;
  const totalTokens = t ? Object.values(t).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) : 0;
  const share = (v: number) => (totalTokens > 0 && Number.isFinite(v) ? `${((v / totalTokens) * 100).toFixed(v / totalTokens < 0.01 ? 1 : 0)}%` : "");

  const fromModel = (model: string) => {
    const known = prices?.[model]?.price;
    if (known) setPrice({ input: String(known.input), output: String(known.output), cacheRead: String(known.cacheRead), cacheWrite: String(known.cacheWrite) });
  };

  return (
    <div className="simulator">
      <div className="simulator-block">
        <div className="simulator-title">The model's prices (USD per million tokens)</div>
        <div className="simulator-fields">
          {FIELDS.map((f) => (
            <label key={f.key} className="price-field">
              <span>
                {f.label}
                {f.key === "cacheWrite" && <span className="subtle"> (blank: as input)</span>}
                {f.key === "cacheRead" && <span className="subtle"> (blank: no discount)</span>}
              </span>
              <input type="number" min={0} step="any" value={price[f.key]} onChange={(e) => setPrice({ ...price, [f.key]: e.target.value })} />
            </label>
          ))}
          {prices && (
            <label className="price-field">
              <span>Or copy from</span>
              <select value="" onChange={(e) => fromModel(e.target.value)}>
                <option value="">a model you have…</option>
                {Object.entries(prices)
                  .filter(([, i]) => i.price)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([m]) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
      </div>
      <div className="simulator-block">
        <div className="simulator-title">Your tokens per day (millions)</div>
        {daily ? (
          <div className="simulator-fields">
            {(
              [
                ["input", "Fresh input"],
                ["cacheRead", "Cache read"],
                ["cacheWrite", "Cache write"],
                ["output", "Output"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="price-field">
                <span>
                  {label} <span className="subtle">{share(n(daily[key]))}</span>
                </span>
                <input type="number" min={0} step="any" value={daily[key]} onChange={(e) => setDaily({ ...daily, [key]: e.target.value })} />
              </label>
            ))}
          </div>
        ) : (
          <div className="subtle small">Loading your usage…</div>
        )}
        {average && (
          <div className="small subtle simulator-note">
            {average.projects.length
              ? `Your average since each project started: ${average.projects.map((p) => `${p.name} ${millions(p.tokensPerDay)}M/day over ${p.days} day${p.days === 1 ? "" : "s"}`).join(", ")}. Idle days count, so a busy week runs higher. Change the numbers to try other amounts.`
              : "No usage recorded yet: type the amounts you expect."}
          </div>
        )}
      </div>
      <div className="simulator-result">
        {perDay === null ? (
          <span className="subtle">Type at least the input and output prices.</span>
        ) : (
          <>
            <div>
              <span className="subtle small">Per day</span>
              <strong>{dollars(perDay)}</strong>
            </div>
            <div>
              <span className="subtle small">Per week</span>
              <strong>{dollars(perDay * 7)}</strong>
            </div>
            <div>
              <span className="subtle small">Per month (30 days)</span>
              <strong>{dollars(perDay * 30)}</strong>
            </div>
            <div>
              <span className="subtle small">Per million tokens, blended</span>
              <strong>{totalTokens > 0 ? dollars(perDay / totalTokens) : "—"}</strong>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
