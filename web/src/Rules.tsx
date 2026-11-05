import { useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronRight, Minus, Scale, X } from "lucide-react";
import type { Rule, RuleConfirmation, RuleStatus, RulesRegister } from "./api";
import { EmptyState } from "./ui";

const STATUS: Record<RuleStatus, { label: string; icon: ReactNode; className: string }> = {
  done: { label: "Done", icon: <Check size={13} />, className: "done" },
  partial: { label: "Partial", icon: <span className="rule-dot" />, className: "partial" },
  missing: { label: "Missing", icon: <X size={13} />, className: "missing" },
  "not-applicable": { label: "N/A", icon: <Minus size={13} />, className: "na" },
};

const CONFIRMATION: Record<RuleConfirmation, { label: string; className: string; hint: string }> = {
  found: { label: "Found", className: "", hint: "Extracted from the source; nobody checked it yet" },
  "checked-by-agent": { label: "Checked (agent)", className: "blue", hint: "An agent compared text, location and excerpt with the source" },
  "checked-by-human": { label: "Checked (human)", className: "green", hint: "A person confirmed it" },
  contested: { label: "Contested", className: "amber", hint: "A source contradicts it; waiting for a decision" },
};

/** Where a citation points in a doc, when its source is a file the Docs tab can open. */
export type OpenSource = (file: string, line?: number) => void;

export function RulesView({ register, openSource }: { register: RulesRegister; openSource: OpenSource }) {
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
      <EmptyState icon={<Scale size={20} />} title="No rules recorded yet">
        {register.enabled
          ? "Agents add the project's rules here as they come up: what each says, where it came from and whether it's met."
          : "This project doesn't keep a rules register. Turn it on in the project's Settings."}
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
          <span>Search</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="id, text, source or excerpt" />
        </label>
        <Select label="Status" value={status} onChange={setStatus} options={Object.entries(STATUS).map(([v, s]) => [v, s.label])} />
        <Select label="Confirmation" value={confirmation} onChange={setConfirmation} options={Object.entries(CONFIRMATION).map(([v, c]) => [v, c.label])} />
        <Select
          label="Area"
          value={area}
          onChange={(v) => {
            setArea(v);
            setStage("");
          }}
          options={register.areas.map((a) => [a.id, `${a.id} · ${a.name}`])}
        />
        <Select label="Stage" value={stage} onChange={setStage} options={areaStages.map((s) => [s.id, `${s.id}. ${s.name}`])} disabled={!area} />
        <Select label="Imposed by" value={imposedBy} onChange={setImposedBy} options={whoValues.map((w) => [w, authorities.get(w) ? `${w} · ${authorities.get(w)}` : w])} />
        <div className="rules-filters-foot">
          <label className="rules-check">
            <input type="checkbox" checked={allExcerpts} onChange={(e) => setAllExcerpts(e.target.checked)} />
            Show all excerpts
          </label>
          {filtering && (
            <button className="btn ghost sm" onClick={clear}>
              Clear filters
            </button>
          )}
          <span className="spacer" />
          <span className="muted small">
            {filtered.length === register.rules.length ? `${register.rules.length} rules` : `${filtered.length} of ${register.rules.length} rules`}
          </span>
        </div>
      </div>

      {filtered.length === 0 && <div className="section-empty">No rules match these filters.</div>}

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
                Stages:{" "}
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
          <h2>Without an area</h2>
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
  return (
    <div className="rules-table-wrap">
      <table className="rules-table">
        <thead>
          <tr>
            <th style={{ width: 76 }}>Id</th>
            <th>Rule</th>
            <th style={{ width: "11%" }}>Action</th>
            <th style={{ width: "17%" }}>Source</th>
            <th style={{ width: 56 }}>By</th>
            <th style={{ width: 118 }}>Confirmation</th>
            <th style={{ width: 92 }}>Status</th>
            <th style={{ width: "22%" }}>Current state</th>
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
                      superseded by{" "}
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
                  {r.check && <div className="rules-check-how">Check: {r.check}</div>}
                </td>
                <td className="rules-md">{md(r.action) ?? <span className="muted">—</span>}</td>
                <td>
                  {r.citations.length === 0 ? (
                    <span className="tag amber" title="Nothing backs this rule yet">
                      No source
                    </span>
                  ) : (
                    <div className="rules-cites">
                      {r.citations.map((c, i) => {
                        const src = sources.get(c.source);
                        const line = lineOf(c.location);
                        const openable = !!src?.file && /\.(md|markdown|txt)$/i.test(src.file);
                        const label = `${c.source}${c.location ? ` ${c.location}` : ""}`;
                        return (
                          <span key={i}>
                            {openable ? (
                              <a
                                href={`#${src!.file}`}
                                title={`${src!.name} — open ${src!.file}${line ? ` at line ${line}` : ""}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  openSource(src!.file!, line);
                                }}
                              >
                                {label}
                              </a>
                            ) : (
                              <span className="rules-cite" title={src ? `${src.name}${src.file ? ` — ${src.file}` : ""}` : "Unknown source"}>
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
                        Literal excerpt{withExcerpt.length > 1 ? `s (${withExcerpt.length})` : ""}
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
                  <span className={`tag ${conf.className}`} title={conf.hint}>
                    {conf.label}
                  </span>
                </td>
                <td>
                  <span className={`rules-status ${st.className}`}>
                    {st.icon}
                    {st.label}
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
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">All</option>
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

/** Turns mentions of existing rule ids into links (outside code spans). */
function linkIds(text: string, ids: Set<string>): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part : part.replace(/\b([A-Z]{1,6}-\d{2,4})\b/g, (m) => (ids.has(m) ? `[${m}](#rule:${m})` : m))))
    .join("");
}
