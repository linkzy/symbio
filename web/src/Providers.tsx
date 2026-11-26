import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowLeft, Bot, ExternalLink, Loader2, LogIn, Plus, Search, Trash2 } from "lucide-react";
import { api, type ConnectedProvider, type OauthAttempt, type ProviderCatalogEntry, type ProviderFormField } from "./api";
import { Dialog } from "./ui";
import { t as translate, useI18n } from "./i18n";

/** Settings section: the model providers OpenCode is connected to. */
export function ProvidersSection() {
  const { t } = useI18n();
  const [connected, setConnected] = useState<ConnectedProvider[] | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ConnectedProvider | null>(null);

  const load = () =>
    api
      .providers()
      .then((r) => {
        setConnected(r.connected);
        setCatalog(r.catalog);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{t("agents.providers.title")}</h2>
          <p>{t("agents.providers.intro")}</p>
        </div>
        <button className="btn sm" onClick={() => setAdding(true)} disabled={!catalog.length}>
          <Plus size={13} />
          {t("agents.providers.add")}
        </button>
      </div>

      {error && (
        <div style={{ padding: 12 }}>
          <div className="error">{error}</div>
        </div>
      )}
      {!connected && !error && <div className="section-empty">{t("agents.providers.loading")}</div>}

      {connected && (
        <div className="section-body">
          {connected.map((p) => (
            <div key={p.id} className="list-row">
              <span className="conn-icon">
                <Bot size={16} />
              </span>
              <div className="grow">
                <div className="list-title">{p.name}</div>
                <div className="list-sub ellipsis">
                  {t(p.models === 1 ? "agents.providers.modelsOne" : "agents.providers.modelsMany", { n: p.models })} · {sourceText(p)}
                  {p.usedBy.length > 0 && ` · ${t("agents.providers.usedBy", { list: p.usedBy.join(", ") })}`}
                </div>
              </div>
              {p.logins.length > 0 ? (
                <button className="btn ghost icon sm" onClick={() => setRemoving(p)} title={t("common.remove")}>
                  <Trash2 size={13} />
                </button>
              ) : (
                <span className="subtle small" title={removalHint(p)}>
                  {t("agents.providers.cantRemove")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {adding && (
          <AddProviderDialog
            catalog={catalog}
            connected={new Set(connected?.map((p) => p.id))}
            onClose={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              void load();
            }}
          />
        )}
        {removing && (
          <RemoveProviderDialog
            provider={removing}
            onClose={() => setRemoving(null)}
            onRemoved={() => {
              setRemoving(null);
              void load();
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function sourceText(p: ConnectedProvider) {
  if (p.source === "login") return p.logins.map((l) => l.label).join(", ");
  if (p.source === "config") return translate("agents.providers.source.config");
  if (p.source === "environment") return translate("agents.providers.source.environment");
  return translate("agents.providers.source.builtIn");
}

function removalHint(p: ConnectedProvider) {
  if (p.source === "config") return translate("agents.providers.hint.config");
  if (p.source === "environment") return translate("agents.providers.hint.environment");
  return translate("agents.providers.hint.builtIn");
}

function RemoveProviderDialog({ provider, onClose, onRemoved }: { provider: ConnectedProvider; onClose: () => void; onRemoved: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    try {
      for (const login of provider.logins) await api.removeProviderLogin(login.id);
      onRemoved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t("agents.providers.removeTitle", { name: provider.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn danger-solid" onClick={remove} disabled={busy}>
            {busy ? t("agents.providers.removing") : t("common.remove")}
          </button>
        </>
      }
    >
      <p>{t("agents.providers.removeBody", { name: provider.name, logins: provider.logins.map((l) => l.label).join(", "), n: provider.models })}</p>
      {provider.usedBy.length > 0 && <div className="notice">{t("agents.providers.removeUsedBy", { list: provider.usedBy.join(", ") })}</div>}
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}

function AddProviderDialog({
  catalog,
  connected,
  onClose,
  onAdded,
}: {
  catalog: ProviderCatalogEntry[];
  connected: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ProviderCatalogEntry | null>(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((e) => !q || e.name.toLowerCase().includes(q) || e.id.includes(q));
  }, [catalog, query]);

  if (chosen) return <ConnectDialog entry={chosen} onBack={() => setChosen(null)} onClose={onClose} onAdded={onAdded} />;

  return (
    <Dialog title={t("agents.providers.addTitle")} subtitle={t("agents.providers.addSubtitle")} onClose={onClose}>
      <div className="model-picker">
        <div className="model-picker-head">
          <Search size={14} className="subtle" />
          <input autoFocus placeholder={t("agents.providers.searchPlaceholder", { n: catalog.length })} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="model-groups" style={{ maxHeight: 360 }}>
          {list.map((e) => (
            <div key={e.id} className="model-row" onClick={() => setChosen(e)}>
              <span className="model-name">{e.name}</span>
              {connected.has(e.id) && <span className="tag green">{t("agents.providers.connected")}</span>}
              <span className="subtle small">{e.methods.map((m) => (m.type === "key" ? t("agents.providers.apiKey") : t("agents.providers.signInMethod"))).filter(unique).join(" · ")}</span>
            </div>
          ))}
          {list.length === 0 && <div className="section-empty">{t("agents.providers.noMatch")}</div>}
        </div>
      </div>
    </Dialog>
  );
}

const unique = <T,>(v: T, i: number, a: T[]) => a.indexOf(v) === i;

/** Fields that apply given the current answers (`when` conditions), minus hidden ones. */
function visibleFields(form: ProviderFormField[], answer: Record<string, string>) {
  return form.filter((f) => !f.hidden && (f.when ?? []).every((w) => (w.op === "eq" ? answer[w.key] === w.value : answer[w.key] !== w.value)));
}

function ConnectDialog({
  entry,
  onBack,
  onClose,
  onAdded,
}: {
  entry: ProviderCatalogEntry;
  onBack: () => void;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const [methodIndex, setMethodIndex] = useState(0);
  const method = entry.methods[methodIndex];
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");
  const [attempt, setAttempt] = useState<OauthAttempt | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef<OauthAttempt | null>(null);

  // Defaults (including hidden fields) are sent unless the user changes them.
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const f of method.form) if (f.default !== undefined) initial[f.key] = f.default;
    else if (f.options?.length) initial[f.key] = f.options[0].value;
    setAnswer(initial);
    setError(null);
  }, [methodIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sign-in that finishes on its own: poll until OpenCode reports the result.
  useEffect(() => {
    attemptRef.current = attempt;
    if (!attempt || attempt.mode !== "auto") return;
    const timer = setInterval(async () => {
      const s = await api.providerOauthStatus(entry.id, attempt.attemptID).catch(() => null);
      if (!s || s.status === "pending") return;
      clearInterval(timer);
      attemptRef.current = null;
      if (s.status === "complete") onAdded();
      else {
        setAttempt(null);
        setError(s.status === "expired" ? t("agents.providers.expired") : s.message || t("agents.providers.failed"));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Abandoned sign-ins are cancelled so OpenCode doesn't keep waiting.
  useEffect(() => () => void (attemptRef.current && api.cancelProviderOauth(entry.id, attemptRef.current.attemptID).catch(() => {})), []); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = visibleFields(method.form, answer);
  const answerToSend = () => {
    const sent: Record<string, string> = {};
    const keep = new Set([...fields.map((f) => f.key), ...method.form.filter((f) => f.hidden).map((f) => f.key)]);
    for (const [k, v] of Object.entries(answer)) if (keep.has(k) && v.trim()) sent[k] = v.trim();
    return sent;
  };
  const missing = fields.some((f) => f.required && !answer[f.key]?.trim()) || (method.type === "key" && !key.trim());
  const invalid = fields.find((f) => f.pattern && answer[f.key] && !new RegExp(f.pattern).test(answer[f.key]));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (method.type === "key") {
        await api.connectProviderKey(entry.id, key, answerToSend());
        onAdded();
      } else if (attempt) {
        await api.completeProviderOauth(entry.id, attempt.attemptID, code);
        attemptRef.current = null;
        onAdded();
      } else {
        const a = await api.beginProviderOauth(entry.id, method.id!, answerToSend());
        setAttempt(a);
        window.open(a.url, "_blank", "noopener");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const action =
    method.type === "key"
      ? t(busy ? "agents.providers.connecting" : "agents.providers.connect")
      : attempt
        ? t(busy ? "agents.providers.finishing" : "agents.providers.finish")
        : t(busy ? "agents.providers.starting" : "agents.providers.signIn");

  return (
    <Dialog
      title={t("agents.providers.connectTitle", { name: entry.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onBack} disabled={busy}>
            <ArrowLeft size={14} />
            {t("common.back")}
          </button>
          {!(attempt && attempt.mode === "auto") && (
            <button className="btn primary" onClick={submit} disabled={busy || (attempt ? !code.trim() : missing || !!invalid)}>
              {action}
            </button>
          )}
        </>
      }
    >
      {attempt ? (
        <>
          <p>
            {t("agents.providers.finishInBrowser", { name: entry.name })}{" "}
            <a href={attempt.url} target="_blank" rel="noopener noreferrer">
              {attempt.url} <ExternalLink size={12} />
            </a>
          </p>
          {attempt.instructions && <div className="notice">{attempt.instructions}</div>}
          {attempt.mode === "code" ? (
            <label className="field">
              <span>{t("agents.providers.code")}</span>
              <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("agents.providers.codePlaceholder")} />
            </label>
          ) : (
            <div className="row subtle small">
              <Loader2 size={13} className="spin" /> {t("agents.providers.waiting")}
            </div>
          )}
        </>
      ) : (
        <>
          {entry.methods.length > 1 && (
            <div className="field">
              <span>{t("agents.providers.howToConnect")}</span>
              <div className="seg">
                {entry.methods.map((m, i) => (
                  <button key={i} className={i === methodIndex ? "on" : ""} onClick={() => setMethodIndex(i)}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {fields.map((f) => (
            <label key={f.key} className="field">
              <span>{f.title}</span>
              {f.options ? (
                <select value={answer[f.key] ?? ""} onChange={(e) => setAnswer({ ...answer, [f.key]: e.target.value })}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                      {o.description ? ` — ${o.description}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={answer[f.key] ?? ""} onChange={(e) => setAnswer({ ...answer, [f.key]: e.target.value })} placeholder={f.placeholder} />
              )}
              {f.description && <span className="hint">{f.description}</span>}
              {invalid === f && <span className="hint" style={{ color: "var(--red)" }}>{t("agents.providers.invalid")}</span>}
            </label>
          ))}
          {method.type === "key" ? (
            <label className="field">
              <span>{t("agents.providers.apiKey")}</span>
              <input type="password" autoFocus={fields.length === 0} value={key} onChange={(e) => setKey(e.target.value)} />
            </label>
          ) : (
            <p className="subtle">{t("agents.providers.signInOnSite", { name: entry.name })}</p>
          )}
          {entry.other.length > 0 && <p className="subtle small">{t("agents.providers.alsoOutside", { list: entry.other.join("; ") })}</p>}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
