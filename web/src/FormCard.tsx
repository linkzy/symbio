import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { MessageCircleQuestion } from "lucide-react";
import { api, type Agent, type Project } from "./api";

// OpenCode "forms": an agent's interactive question. Fields have a key, a title,
// a type and optional options; the answer is { [key]: value }.
// Field types: string (optionally with single-choice options), multiselect, boolean,
// integer, number, external (a link to open).
interface Field {
  key: string;
  title?: string;
  description?: string;
  type: string;
  required?: boolean;
  hidden?: boolean;
  options?: Option[];
  custom?: boolean;
  placeholder?: string;
  default?: unknown;
  maxItems?: number;
  url?: string;
  when?: { key: string; op: string; value: unknown }[];
  items?: { options?: Option[] };
}

const isMulti = (f: Field) => f.type === "multiselect" || f.type === "array";
const isNumeric = (f: Field) => f.type === "number" || f.type === "integer";
const applies = (f: Field, values: Record<string, unknown>) =>
  (f.when ?? []).every((w) => (w.op === "eq" ? values[w.key] === w.value : w.op === "neq" ? values[w.key] !== w.value : true));

interface Option {
  value: string;
  label: string;
  description?: string;
}

interface Form {
  id: string;
  title?: string;
  fields: Field[];
}

/** Shows the agent's open questions (if any) and sends the answers back. */
export function PendingForms({ project, agent }: { project: Project; agent: Agent }) {
  const [forms, setForms] = useState<Form[]>([]);

  useEffect(() => {
    if (agent.status !== "waiting") {
      setForms([]);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .forms(project.id, agent.id)
        .then((f) => alive && setForms(f as Form[]))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [project.id, agent.id, agent.status]);

  return (
    <>
      {forms.map((f) => (
        <FormView key={f.id} form={f} project={project} agent={agent} onDone={() => setForms((l) => l.filter((x) => x.id !== f.id))} />
      ))}
    </>
  );
}

function FormView({ form, project, agent, onDone }: { form: Form; project: Project; agent: Agent; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.key, f.default ?? (isMulti(f) ? [] : f.type === "boolean" ? false : "")])),
  );
  const fields = form.fields.filter((f) => !f.hidden && applies(f, values));
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const set = (key: string, v: unknown) => setValues((s) => ({ ...s, [key]: v }));
  const missing = fields.some((f) => f.required && isEmpty(values[f.key]) && !custom[f.key]);

  async function submit() {
    setSending(true);
    setError(null);
    const answer: Record<string, unknown> = {};
    const summary: string[] = [];
    for (const f of fields) {
      if (f.type === "external") continue;
      let v = values[f.key];
      if (custom[f.key]?.trim()) v = isMulti(f) ? [...((v as string[]) ?? []), custom[f.key].trim()] : custom[f.key].trim();
      if (isNumeric(f) && typeof v === "string" && v !== "") v = Number(v);
      if (isEmpty(v) && !f.required) continue;
      answer[f.key] = v;
      const label = (val: unknown) => f.options?.find((o) => o.value === val)?.label ?? String(val);
      summary.push(`${f.title ?? f.key}: ${Array.isArray(v) ? v.map(label).join(", ") : label(v)}`);
    }
    try {
      await api.answerForm(project.id, agent.id, form.id, answer, summary.join("\n"));
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  }

  return (
    <motion.div ref={card} className="form-card" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <div className="form-card-head">
        <MessageCircleQuestion size={15} />
        {agent.name} needs your answer{form.title ? ` — ${form.title}` : ""}
      </div>
      <div className="form-card-body">
      {fields.map((f) => {
        const options = f.options ?? f.items?.options;
        return (
          <div key={f.key} className="form-field">
            {f.title && <div className="form-field-title">{f.title}</div>}
            {f.description && <div className="form-field-desc">{f.description}</div>}
            {f.type === "external" && f.url ? (
              <a className="btn sm" href={f.url} target="_blank" rel="noopener noreferrer">
                Open link
              </a>
            ) : options ? (
              <div className="form-options">
                {options.map((o) => {
                  const multi = isMulti(f);
                  const current = values[f.key];
                  const on = multi ? (current as string[]).includes(o.value) : current === o.value;
                  const full = multi && !on && f.maxItems !== undefined && (current as string[]).length >= f.maxItems;
                  return (
                    <button
                      key={o.value}
                      className={`form-option ${on ? "on" : ""}`}
                      disabled={full}
                      title={full ? `Choose up to ${f.maxItems}` : undefined}
                      onClick={() => {
                        if (multi) {
                          const list = current as string[];
                          set(f.key, on ? list.filter((x) => x !== o.value) : [...list, o.value]);
                        } else set(f.key, o.value);
                        if (!multi) setCustom((c) => ({ ...c, [f.key]: "" }));
                      }}
                    >
                      <strong style={{ fontWeight: 500 }}>{o.label}</strong>
                      {o.description && <span>{o.description}</span>}
                    </button>
                  );
                })}
                {f.custom !== false && (
                  <input
                    placeholder="Or type your own answer…"
                    value={custom[f.key] ?? ""}
                    onChange={(e) => {
                      setCustom((c) => ({ ...c, [f.key]: e.target.value }));
                      if (!isMulti(f)) set(f.key, "");
                    }}
                  />
                )}
              </div>
            ) : f.type === "boolean" ? (
              <div className="form-options">
                {[true, false].map((b) => (
                  <button key={String(b)} className={`form-option ${values[f.key] === b ? "on" : ""}`} onClick={() => set(f.key, b)}>
                    <strong>{b ? "Yes" : "No"}</strong>
                  </button>
                ))}
              </div>
            ) : (
              <textarea
                rows={2}
                placeholder={f.placeholder ?? "Your answer…"}
                value={String(values[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" onClick={submit} disabled={sending || missing}>
          {sending ? "Sending…" : "Send answer"}
        </button>
      </div>
      </div>
    </motion.div>
  );
}

function isEmpty(v: unknown) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}
