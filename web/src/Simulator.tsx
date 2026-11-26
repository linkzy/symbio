import { useEffect, useState } from "react";
import { api, type Price, type PriceInfo } from "./api";
import { useCostsShown } from "./privacy";
import { useI18n, type MessageKey } from "./i18n";

// Settings → Model prices → Simulate: what models would cost at your usage. One model for all
// tokens, or core and helpers apart (core usually runs on a dearer model), with each one's cost and
// the total per day, week and month.

type Prices = Record<keyof Price, string>;
type Tokens = { input: string; cacheRead: string; cacheWrite: string; output: string };
type Usage = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
type Average = Awaited<ReturnType<typeof api.usageAverage>>;

const M = 1_000_000;
const millions = (n: number) => (n / M >= 100 ? (n / M).toFixed(0) : (n / M).toFixed(1));
const dollars = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const EMPTY_PRICES: Prices = { input: "", output: "", cacheRead: "", cacheWrite: "" };
const tokensOf = (u?: Usage): Tokens =>
  u ? { input: millions(u.input), cacheRead: millions(u.cacheRead), cacheWrite: millions(u.cacheWrite), output: millions(u.output + u.reasoning) } : { input: "0", cacheRead: "0", cacheWrite: "0", output: "0" };
const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

const PRICE_FIELDS: { key: keyof Price; label: MessageKey; hint?: MessageKey }[] = [
  { key: "input", label: "usage.field.input" },
  { key: "output", label: "usage.field.output" },
  { key: "cacheRead", label: "usage.field.cacheRead", hint: "usage.simulator.hintCacheRead" },
  { key: "cacheWrite", label: "usage.field.cacheWrite", hint: "usage.simulator.hintCacheWrite" },
];
const TOKEN_FIELDS: { key: keyof Tokens; label: MessageKey }[] = [
  { key: "input", label: "usage.simulator.freshInput" },
  { key: "cacheRead", label: "usage.field.cacheRead" },
  { key: "cacheWrite", label: "usage.field.cacheWrite" },
  { key: "output", label: "usage.field.output" },
];

/** USD per day for these prices and tokens (millions per day); null until the prices can be used. */
export function dailyCost(p: Prices, t: Tokens): number | null {
  const input = num(p.input);
  const output = num(p.output);
  // Without a cache read price, cached tokens cost as input; without a cache write price, writes too.
  const cacheRead = Number.isFinite(num(p.cacheRead)) ? num(p.cacheRead) : input;
  const cacheWrite = Number.isFinite(num(p.cacheWrite)) ? num(p.cacheWrite) : input;
  const amounts = TOKEN_FIELDS.map((f) => num(t[f.key]));
  if (![input, output].every(Number.isFinite) || !amounts.every((v) => Number.isFinite(v) && v >= 0)) return null;
  return num(t.input) * input + num(t.cacheRead) * cacheRead + num(t.cacheWrite) * cacheWrite + num(t.output) * output;
}
const totalTokens = (t: Tokens) => TOKEN_FIELDS.reduce((a, f) => a + (Number.isFinite(num(t[f.key])) ? num(t[f.key]) : 0), 0);

export function Simulator({ prices }: { prices: Record<string, PriceInfo> | null }) {
  // While costs and tokens are hidden, your real usage isn't filled in or named: type amounts instead.
  const { t } = useI18n();
  const shown = useCostsShown();
  const [split, setSplit] = useState(false);
  const [average, setAverage] = useState<Average | null>(null);
  // One model for everything.
  const [allPrices, setAllPrices] = useState<Prices>(EMPTY_PRICES);
  const [allTokens, setAllTokens] = useState<Tokens | null>(null);
  // Core and helpers apart.
  const [corePrices, setCorePrices] = useState<Prices>(EMPTY_PRICES);
  const [helperPrices, setHelperPrices] = useState<Prices>(EMPTY_PRICES);
  const [coreTokens, setCoreTokens] = useState<Tokens | null>(null);
  const [helperTokens, setHelperTokens] = useState<Tokens | null>(null);

  useEffect(() => {
    if (!shown) {
      const blank: Tokens = { input: "", cacheRead: "", cacheWrite: "", output: "" };
      setAverage(null);
      setAllTokens(blank);
      setCoreTokens(blank);
      setHelperTokens(blank);
      return;
    }
    api
      .usageAverage()
      .then((a) => {
        setAverage(a);
        setAllTokens(tokensOf(a.perDay));
        setCoreTokens(tokensOf(a.byRole?.core));
        setHelperTokens(tokensOf(a.byRole?.helpers));
      })
      .catch(() => {
        setAllTokens(tokensOf());
        setCoreTokens(tokensOf());
        setHelperTokens(tokensOf());
      });
  }, [shown]);

  const note = !shown ? (
    <div className="small subtle simulator-note">{t("usage.simulator.hidden")}</div>
  ) : average && (
    <div className="small subtle simulator-note">
      {average.projects.length
        ? t("usage.simulator.average", {
            list: average.projects
              .map((p) => t(p.days === 1 ? "usage.simulator.projectDay" : "usage.simulator.projectDays", { name: p.name, m: millions(p.tokensPerDay), days: p.days }))
              .join(", "),
          })
        : t("usage.simulator.noUsage")}
    </div>
  );

  return (
    <div className="simulator">
      <div className="seg simulator-mode">
        <button className={!split ? "on" : ""} onClick={() => setSplit(false)}>
          {t("usage.simulator.oneModel")}
        </button>
        <button className={split ? "on" : ""} onClick={() => setSplit(true)}>
          {t("usage.simulator.split")}
        </button>
      </div>

      {!split ? (
        <>
          <PriceBlock title={t("usage.simulator.modelPrices")} value={allPrices} onChange={setAllPrices} prices={prices} />
          <TokenBlock title={t("usage.simulator.yourTokens")} value={allTokens} onChange={setAllTokens} />
          {note}
          <Result rows={[{ label: null, cost: allTokens && dailyCost(allPrices, allTokens), tokens: allTokens ? totalTokens(allTokens) : 0 }]} />
        </>
      ) : (
        <>
          <div className="simulator-split">
            <div className="simulator-side">
              <div className="simulator-role">core</div>
              <PriceBlock title={t("usage.simulator.coreModel")} value={corePrices} onChange={setCorePrices} prices={prices} />
              <TokenBlock title={t("usage.simulator.coreTokens")} value={coreTokens} onChange={setCoreTokens} />
            </div>
            <div className="simulator-side">
              <div className="simulator-role">
                {t("usage.simulator.helpers")}
                <button className="btn ghost xs" onClick={() => setHelperPrices(corePrices)} title={t("usage.simulator.sameAsCoreTitle")}>
                  {t("usage.simulator.sameAsCore")}
                </button>
              </div>
              <PriceBlock title={t("usage.simulator.helpersModel")} value={helperPrices} onChange={setHelperPrices} prices={prices} />
              <TokenBlock title={t("usage.simulator.helpersTokens")} value={helperTokens} onChange={setHelperTokens} />
            </div>
          </div>
          {note}
          <Result
            rows={[
              { label: "core", cost: coreTokens && dailyCost(corePrices, coreTokens), tokens: coreTokens ? totalTokens(coreTokens) : 0 },
              { label: "helpers", cost: helperTokens && dailyCost(helperPrices, helperTokens), tokens: helperTokens ? totalTokens(helperTokens) : 0 },
            ]}
            total
          />
        </>
      )}
    </div>
  );
}

/** A model's four prices, typed or copied from a model Symbio already has a price for. */
function PriceBlock({ title, value, onChange, prices }: { title: string; value: Prices; onChange: (p: Prices) => void; prices: Record<string, PriceInfo> | null }) {
  const { t } = useI18n();
  const fromModel = (model: string) => {
    const known = prices?.[model]?.price;
    if (known) onChange({ input: String(known.input), output: String(known.output), cacheRead: String(known.cacheRead), cacheWrite: String(known.cacheWrite) });
  };
  return (
    <div className="simulator-block">
      <div className="simulator-title">{title}</div>
      <div className="simulator-fields">
        {PRICE_FIELDS.map((f) => (
          <label key={f.key} className="price-field">
            <span>
              {t(f.label)}
              {f.hint && <span className="subtle"> ({t(f.hint)})</span>}
            </span>
            <input type="number" min={0} step="any" value={value[f.key]} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
          </label>
        ))}
        {prices && (
          <label className="price-field">
            <span>{t("usage.simulator.copyFrom")}</span>
            <select value="" onChange={(e) => fromModel(e.target.value)}>
              <option value="">{t("usage.simulator.aModel")}</option>
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
  );
}

/** Tokens per day by kind, in millions, with each kind's share. */
function TokenBlock({ title, value, onChange }: { title: string; value: Tokens | null; onChange: (t: Tokens) => void }) {
  const { t } = useI18n();
  if (!value) {
    return (
      <div className="simulator-block">
        <div className="simulator-title">{title}</div>
        <div className="subtle small">{t("usage.simulator.loading")}</div>
      </div>
    );
  }
  const total = totalTokens(value);
  const share = (v: number) => (total > 0 && Number.isFinite(v) ? `${((v / total) * 100).toFixed(v / total < 0.01 ? 1 : 0)}%` : "");
  return (
    <div className="simulator-block">
      <div className="simulator-title">{title}</div>
      <div className="simulator-fields">
        {TOKEN_FIELDS.map((f) => (
          <label key={f.key} className="price-field">
            <span>
              {t(f.label)} <span className="subtle">{share(num(value[f.key]))}</span>
            </span>
            <input type="number" min={0} step="any" value={value[f.key]} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
          </label>
        ))}
      </div>
    </div>
  );
}

/** The cost per day, week and month: one row, or one per role and the total. */
function Result({ rows, total }: { rows: { label: string | null; cost: number | null; tokens: number }[]; total?: boolean }) {
  const { t } = useI18n();
  // Labels double as the rows' ids (data-role); only the text shown is translated ("core" stays).
  const labelText = (label: string | null) => (label === "helpers" ? t("usage.simulator.helpers") : label === "total" ? t("usage.simulator.total") : (label ?? ""));
  const all = rows.every((r) => r.cost !== null) ? rows.reduce((a, r) => a + (r.cost ?? 0), 0) : null;
  const allTokens = rows.reduce((a, r) => a + r.tokens, 0);
  const lines = total ? [...rows, { label: "total", cost: all, tokens: allTokens }] : rows;
  if (lines.every((l) => l.cost === null)) return <div className="simulator-result empty subtle">{t("usage.simulator.typePrices")}</div>;
  return (
    <div className="simulator-result">
      <div className="simulator-row head">
        <span />
        <span>{t("usage.simulator.perDay")}</span>
        <span>{t("usage.simulator.perWeek")}</span>
        <span>{t("usage.simulator.perMonth")}</span>
        <span>{t("usage.simulator.perMillion")}</span>
      </div>
      {lines.map((l) => (
        <div key={l.label ?? "all"} className={`simulator-row${l.label === "total" ? " total" : ""}`} data-role={l.label ?? "all"}>
          <span className="simulator-row-label">{labelText(l.label)}</span>
          {l.cost === null ? (
            <span className="subtle small simulator-missing">{t("usage.simulator.missing")}</span>
          ) : (
            <>
              <strong>{dollars(l.cost)}</strong>
              <strong>{dollars(l.cost * 7)}</strong>
              <strong>{dollars(l.cost * 30)}</strong>
              <strong>{l.tokens > 0 ? dollars(l.cost / l.tokens) : "—"}</strong>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
