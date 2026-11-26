import { useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronRight, Minus, Scale, X } from "lucide-react";
import type { Rule, RuleConfirmation, RuleStatus, RulesRegister } from "./api";
import { EmptyState } from "./ui";
import { useI18n, type MessageKey } from "./i18n";

const STATUS: Record<RuleStatus, { label: MessageKey; icon: ReactNode; className: string }> = {
  done: { label: "docs.rules.status.done", icon: <Check size={13} />, className: "done" },
  partial: { label: "docs.rules.status.partial", icon: <span className="rule-dot" />, className: "partial" },
  missing: { label: "docs.rules.status.missing", icon: <X size={13} />, className: "missing" },
  "not-applicable": { label: "docs.rules.status.na", icon: <Minus size={13} />, className: "na" },
};

const CONFIRMATION: Record<RuleConfirmation, { label: MessageKey; className: string; hint: MessageKey }> = {
  found: { label: "docs.rules.confirmation.found", className: "", hint: "docs.rules.confirmation.found.hint" },
  "checked-by-agent": { label: "docs.rules.confirmation.agent", className: "blue", hint: "docs.rules.confirmation.agent.hint" },
  "checked-by-human": { label: "docs.rules.confirmation.human", className: "green", hint: "docs.rules.confirmation.human.hint" },
  contested: { label: "docs.rules.confirmation.contested", className: "amber", hint: "docs.rules.confirmation.contested.hint" },
};

/** Opens a cited source file: in the Docs tab when it's a doc (at a line), else in a new tab (at a page). */
export type OpenSource = (file: string, at: { line?: number; page?: number }) => void;

export function RulesView({ register, openSource }: { register: RulesRegister; openSource: OpenSource }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [area, setArea] = useState("");
  const [stage, setStage] = useState("");
  const [imposedBy, setImposedBy] = useState("");
  const [allExcerpts, setAllExcerpts] = useState(false);
  const [openExcerpts, setOpenExcerpts] = useState<Set<string>>(new Set());

  const ids = useMemo(() => new Set(register.rules.map((r) => r.id)), [register.rules]);
  const sources = useMemo(() => new Map(register.sources.map((s) => [s.id, s])), [register.sources]);
  const authorities = useMemo(() => new Map(register.authorities.map((a) => [a.id, a.name])), [register.authorities]);
  const whoValues = useMemo(() => [...new Set(register.rules.map((r) => r.imposedBy).filter(Boolean) as string[])].sort(), [register.rules]);
  const areaStages = register.areas.find((a) => a.id === area)?.stages ?? [];

  const filtered = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    return register.rules.filter((r) => {
      if (status && r.status !== status) return false;
      if (confirmation && r.confirmation !== confirmation) return false;
      if (area && r.area !== area) return false;
      if (stage && r.stage !== stage) return false;
      if (imposedBy && r.imposedBy !== imposedBy) return false;
      if (!words.length) return true;
      const hay = fold(
        [r.id, r.text, r.action, r.current, r.check, r.imposedBy, ...r.citations.flatMap((c) => [c.source, c.location, c.excerpt, sources.get(c.source)?.name])]
          .filter(Boolean)
          .join(" "),
      );
      return words.every((w) => hay.includes(w));
    });
  }, [register.rules, query, status, confirmation, area, stage, imposedBy, sources]);

  const filtering = !!(query || status || confirmation || area || stage || imposedBy);
  const clear = () => {
    setQuery("");
    setStatus("");
    setConfirmation("");
    setArea("");
    setStage("");
    setImposedBy("");
  };

  if (!register.rules.length) {
    return (
      <EmptyState icon={<Scale size={20} />} title={t("docs.rules.empty.title")}>
        {register.enabled
          ? t("docs.rules.empty.enabled")
          : t("docs.rules.empty.disabled")}
      </EmptyState>
    );
  }

  const toggleExcerpt = (id: string) =>
    setOpenExcerpts((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const jumpTo = (id: string) => {
    if (filtering && !filtered.some((r) => r.id === id)) clear();
    setTimeout(() => {
      const row = document.getElementById(`rule-${id}`);
      row?.scrollIntoView({ block: "center" });
      row?.classList.add("flash");
      setTimeout(() => row?.classList.remove("flash"), 1600);
    }, 50);
  };

  // Rule ids in the text become links to the rule.
  const md = (text?: string) =>
    text ? (
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{children}</p>,
          a: ({ href = "", children }) =>
            href.startsWith("#rule:") ? (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  jumpTo(href.slice(6));
                }}
              >
                {children}
              </a>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {linkIds(text, ids)}
      </Markdown>
    ) : null;

  const byArea = register.areas
    .map((a) => ({ area: a, rules: filtered.filter((r) => r.area === a.id) }))
    .filter((g) => g.rules.length);
  const orphans = filtered.filter((r) => !register.areas.some((a) => a.id === r.area));

  return (
    <div className="rules">
      <div className="rules-filters">
        <label className="field">
          <span>{t("common.search")}</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("docs.rules.search.placeholder")} />
        </label>
        <Select label={t("docs.rules.filter.status")} value={status} onChange={setStatus} options={Object.entries(STATUS).map(([v, s]) => [v, t(s.label)])} />
        <Select label={t("docs.rules.filter.confirmation")} value={confirmation} onChange={setConfirmation} options={Object.entries(CONFIRMATION).map(([v, c]) => [v, t(c.label)])} />
        <Select
          label={t("docs.rules.filter.area")}
          value={area}
          onChange={(v) => {
            setArea(v);
            setStage("");
          }}
          options={register.areas.map((a) => [a.id, `${a.id} · ${a.name}`])}
        />
        <Select label={t("docs.rules.filter.stage")} value={stage} onChange={setStage} options={areaStages.map((s) => [s.id, `${s.id}. ${s.name}`])} disabled={!area} />
        <Select label={t("docs.rules.filter.imposedBy")} value={imposedBy} onChange={setImposedBy} options={whoValues.map((w) => [w, authorities.get(w) ? `${w} · ${authorities.get(w)}` : w])} />
        <div className="rules-filters-foot">
          <label className="rules-check">
            <input type="checkbox" checked={allExcerpts} onChange={(e) => setAllExcerpts(e.target.checked)} />
            {t("docs.rules.showAllExcerpts")}
          </label>
          {filtering && (
            <button className="btn ghost sm" onClick={clear}>
              {t("docs.rules.clearFilters")}
            </button>
          )}
          <span className="spacer" />
          <span className="muted small">
            {filtered.length === register.rules.length ? t("docs.rules.count", { n: register.rules.length }) : t("docs.rules.countOf", { n: filtered.length, total: register.rules.length })}
          </span>
        </div>
      </div>

      {filtered.length === 0 && <div className="section-empty">{t("docs.rules.noMatch")}</div>}

      {byArea.map(({ area: a, rules }) => {
        const stages = [...a.stages.map((s) => ({ ...s, rules: rules.filter((r) => r.stage === s.id) })), { id: "", name: "", rules: rules.filter((r) => !r.stage || !a.stages.some((s) => s.id === r.stage)) }].filter(
          (s) => s.rules.length,
        );
        return (
          <section key={a.id} className="rules-area">
            <h2>
              {a.group && <span className="muted">{a.group} · </span>}
              {a.name} <span className="rules-prefix">{a.id}</span>
            </h2>
            {a.description && <p className="muted small">{a.description}</p>}
            {stages.length > 1 && (
              <div className="rules-stages">
                {t("docs.rules.stages")}{" "}
                {stages
                  .filter((s) => s.id)
                  .map((s) => (
                    <a
                      key={s.id}
                      href={`#stage-${a.id}-${s.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(`stage-${a.id}-${s.id}`)?.scrollIntoView({ block: "start" });
                      }}
                    >
                      {s.id}. {s.name}
                    </a>
                  ))}
              </div>
            )}
            {stages.map((s) => (
              <div key={s.id || "none"} className="rules-stage">
                {s.id && (
                  <h3 id={`stage-${a.id}-${s.id}`}>
                    {s.id}. {s.name}
                  </h3>
                )}
                <RulesTable
                  rules={s.rules}
                  sources={sources}
                  authorities={authorities}
                  excerptsOpen={(id) => allExcerpts || openExcerpts.has(id)}
                  toggleExcerpt={toggleExcerpt}
                  openSource={openSource}
                  md={md}
                  jumpTo={jumpTo}
                />
              </div>
            ))}
          </section>
        );
      })}
      {orphans.length > 0 && (
        <section className="rules-area">
          <h2>{t("docs.rules.withoutArea")}</h2>
          <RulesTable
            rules={orphans}
            sources={sources}
            authorities={authorities}
            excerptsOpen={(id) => allExcerpts || openExcerpts.has(id)}
            toggleExcerpt={toggleExcerpt}
            openSource={openSource}
            md={md}
            jumpTo={jumpTo}
          />
        </section>
      )}
    </div>
  );
}

function RulesTable({
  rules,
  sources,
  authorities,
  excerptsOpen,
  toggleExcerpt,
  openSource,
  md,
  jumpTo,
}: {
  rules: Rule[];
  sources: Map<string, RulesRegister["sources"][number]>;
  authorities: Map<string, string>;
  excerptsOpen: (id: string) => boolean;
  toggleExcerpt: (id: string) => void;
  openSource: OpenSource;
  md: (text?: string) => ReactNode;
  jumpTo: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rules-table-wrap">
      <table className="rules-table">
        <thead>
          <tr>
            <th style={{ width: 76 }}>{t("docs.rules.col.id")}</th>
            <th>{t("docs.rules.col.rule")}</th>
            <th style={{ width: "11%" }}>{t("docs.rules.col.action")}</th>
            <th style={{ width: "17%" }}>{t("docs.rules.col.source")}</th>
            <th style={{ width: 56 }}>{t("docs.rules.col.by")}</th>
            <th style={{ width: 118 }}>{t("docs.rules.col.confirmation")}</th>
            <th style={{ width: 92 }}>{t("docs.rules.col.status")}</th>
            <th style={{ width: "22%" }}>{t("docs.rules.col.current")}</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => {
            const st = STATUS[r.status] ?? STATUS.missing;
            const conf = CONFIRMATION[r.confirmation] ?? CONFIRMATION.found;
            const withExcerpt = r.citations.filter((c) => c.excerpt);
            const open = excerptsOpen(r.id);
            return (
              <tr key={r.id} id={`rule-${r.id}`} className={r.supersededBy ? "superseded" : ""}>
                <td className="rules-id">
                  {r.id}
                  {r.supersededBy && (
                    <div className="rules-superseded">
                      {t("docs.rules.supersededBy")}{" "}
                      <a
                        href={`#rule:${r.supersededBy}`}
                        onClick={(e) => {
                          e.preventDefault();
                          jumpTo(r.supersededBy!);
                        }}
                      >
                        {r.supersededBy}
                      </a>
                    </div>
                  )}
                </td>
                <td className="rules-md">
                  {md(r.text)}
                  {r.check && <div className="rules-check-how">{t("docs.rules.checkHow", { check: r.check })}</div>}
                </td>
                <td className="rules-md">{md(r.action) ?? <span className="muted">—</span>}</td>
                <td>
                  {r.citations.length === 0 ? (
                    <span className="tag amber" title={t("docs.rules.noSource.hint")}>
                                          {t("docs.rules.noSource")}
                    </span>
                  ) : (
                    <div className="rules-cites">
                      {r.citations.map((c, i) => {
                        const src = sources.get(c.source);
                        const line = lineOf(c.location);
                        const page = pageOf(c.location);
                        const openable = !!src?.file;
                        const label = `${c.source}${c.location ? ` ${c.location}` : ""}`;
                        return (
                          <span key={i}>
                            {openable ? (
                              <a
                                href={`#${src!.file}`}
                                title={t(line ? "docs.rules.cite.openAtLine" : page ? "docs.rules.cite.openAtPage" : "docs.rules.cite.open", { name: src!.name, file: src!.file!, n: line ?? page ?? "" })}
                                onClick={(e) => {
                                  e.preventDefault();
                                  openSource(src!.file!, { line, page });
                                }}
                              >
                                {label}
                              </a>
                            ) : (
                              <span className="rules-cite" title={src ? `${src.name}${src.file ? ` — ${src.file}` : ""}` : t("docs.rules.cite.unknown")}>
                                {label}
                              </span>
                            )}
                            {i < r.citations.length - 1 ? ", " : ""}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {withExcerpt.length > 0 && (
                    <>
                      <button className="rules-excerpt-toggle" onClick={() => toggleExcerpt(r.id)}>
                        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {withExcerpt.length > 1 ? t("docs.rules.excerpt.many", { n: withExcerpt.length }) : t("docs.rules.excerpt.one")}
                      </button>
                      {open &&
                        withExcerpt.map((c, i) => (
                          <blockquote key={i} className="rules-excerpt">
                            <div className="rules-excerpt-src">
                              {c.source}
                              {c.location ? ` ${c.location}` : ""}
                            </div>
                            “{c.excerpt}”
                          </blockquote>
                        ))}
                    </>
                  )}
                </td>
                <td title={r.imposedBy ? authorities.get(r.imposedBy) : undefined}>{r.imposedBy ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`tag ${conf.className}`}                   title={t(conf.hint)}>
                                      {t(conf.label)}
                  </span>
                </td>
                <td>
                  <span className={`rules-status ${st.className}`}>
                    {st.icon}
                    {t(st.label)}
                  </span>
                </td>
                <td className="rules-md">{md(r.current) ?? <span className="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{t("docs.rules.filter.all")}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** "l.10", "L10", "line 10", "linha 10", "l. 10-12" → 10. */
function lineOf(location?: string): number | undefined {
  const m = location && /(?:^|\b)(?:l\.?|line|linha)\s*(\d+)/i.exec(location);
  return m ? Number(m[1]) : undefined;
}

/** "p.20", "p. 20", "pp. 20-21", "pág. 20", "page 20" → 20. */
function pageOf(location?: string): number | undefined {
  const m = location && /(?:^|\b)(?:pp?\.?|p[aá]g\.?|page|p[aá]gina)\s*(\d+)/i.exec(location);
  return m ? Number(m[1]) : undefined;
}

/** Turns mentions of existing rule ids into links (outside code spans). */
function linkIds(text: string, ids: Set<string>): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part : part.replace(/\b([A-Z]{1,6}-\d{2,4})\b/g, (m) => (ids.has(m) ? `[${m}](#rule:${m})` : m))))
    .join("");
}
