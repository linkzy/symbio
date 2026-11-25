import { useEffect, useRef, useState } from "react";
import { api, subscribe, type BudgetStatus, type Project } from "./api";
import { useI18n } from "./i18n";
import { MASK, useCostsShown } from "./privacy";
import { useProjectUsage } from "./Usage";

/** Dollars as people read them: $12, $3.40, $0.0021 (as the server writes them). */
export function money(n: number): string {
  if (n >= 100 || Number.isInteger(n)) return `$${n.toFixed(0)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${Number(n.toPrecision(2))}`;
}

/** What the project spent against its limits, refreshed as agents work. */
function useBudget(projectId: string): BudgetStatus | null {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const load = () => api.budget(projectId).then(setStatus).catch(() => {});
    void load();
    const unsubscribe = subscribe((e) => {
      if ((e.type === "project.updated" && e.projectId === projectId) || e.type === "prices.updated") {
        if (timer.current) return;
        timer.current = setTimeout(() => {
          timer.current = null;
          void load();
        }, 3000);
      }
    });
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId]);
  return status;
}

const field = (n: number | undefined) => (n ? String(n) : "");
const amount = (text: string): number | null | "bad" => {
  if (!text.trim()) return null;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : "bad";
};

/** Project settings → Budget: limits for the whole project and per day, and what was spent. */
export function BudgetSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const status = useBudget(project.id);
  const usage = useProjectUsage(project.id);
  const shown = useCostsShown();
  const [total, setTotal] = useState(field(project.budget?.total));
  const [daily, setDaily] = useState(field(project.budget?.daily));
  const [warnAt, setWarnAt] = useState(String(project.budget?.warnAt ?? 80));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTotal(field(project.budget?.total));
    setDaily(field(project.budget?.daily));
    setWarnAt(String(project.budget?.warnAt ?? 80));
    setError(null);
  };
  useEffect(reset, [project.budget?.total, project.budget?.daily, project.budget?.warnAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = { total: amount(total), daily: amount(daily), warnAt: Number(warnAt) };
  const valid = parsed.total !== "bad" && parsed.daily !== "bad" && Number.isInteger(parsed.warnAt) && parsed.warnAt >= 1 && parsed.warnAt <= 99;
  const dirty = total !== field(project.budget?.total) || daily !== field(project.budget?.daily) || warnAt !== String(project.budget?.warnAt ?? 80);
  const shownMoney = (n: number) => (shown ? money(n) : MASK);

  async function save() {
    if (!valid) return setError(t("budget.invalid"));
    setSaving(true);
    setError(null);
    try {
      onChanged(
        await api.updateProject(project.id, {
          budget: parsed.total || parsed.daily ? { total: (parsed.total as number | null) ?? null, daily: (parsed.daily as number | null) ?? null, warnAt: parsed.warnAt } : null,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="section" id="budget">
      <div className="section-head">
        <div>
          <h2>{t("budget.title")}</h2>
          <p>{t("budget.desc")}</p>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        {error && <div className="error">{error}</div>}
        <div className="field-row budget-fields">
          <label className="field">
            <span>{t("budget.total")}</span>
            <div className="budget-input">
              <span>$</span>
              <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder={t("budget.none")} aria-label={t("budget.total")} />
            </div>
            {status && (
              <span className="hint" data-testid="budget-spent">
                {t("budget.spent", { amount: shownMoney(status.spent) })}
              </span>
            )}
          </label>
          <label className="field">
            <span>{t("budget.daily")}</span>
            <div className="budget-input">
              <span>$</span>
              <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={t("budget.none")} aria-label={t("budget.daily")} />
            </div>
            {status && <span className="hint">{t("budget.today", { amount: shownMoney(status.today) })}</span>}
          </label>
          <label className="field">
            <span>{t("budget.warnAt")}</span>
            <div className="budget-input">
              <input type="number" min={1} max={99} value={warnAt} onChange={(e) => setWarnAt(e.target.value)} aria-label={t("budget.warnAt")} />
              <span>%</span>
            </div>
          </label>
        </div>
        <span className="small subtle">{t("budget.how")}</span>
        {usage && usage.unpriced.length > 0 && (
          <div className="small budget-unpriced">
            {t("budget.unpriced", { models: usage.unpriced.join(", ") })} <a href="#/settings">{t("budget.unpriced.where")}</a>
          </div>
        )}
      </div>
      {dirty && (
        <div className="row" style={{ justifyContent: "flex-end", padding: "0 16px 14px", gap: 8 }}>
          <button className="btn ghost sm" disabled={saving} onClick={reset}>
            {t("common.discard")}
          </button>
          <button className="btn primary sm" disabled={saving} onClick={save}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      )}
    </section>
  );
}
