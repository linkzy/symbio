import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowLeft, Bot, ExternalLink, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { api, type ConnectedProvider, type OauthAttempt, type ProviderCatalogEntry, type ProviderFormField } from "./api";
import { Dialog } from "./ui";

/** Settings section: the model providers OpenCode is connected to. */
export function ProvidersSection() {
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
          <h2>Model providers</h2>
          <p>
            The AI services OpenCode is signed in to. Every model you can pick for a project comes from one of these; remove the ones you don't
            use to keep that list short. Keys are handed to OpenCode and not kept by Symbio.
          </p>
        </div>
        <button className="btn sm" onClick={() => setAdding(true)} disabled={!catalog.length}>
          <Plus size={13} />
          Add provider
        </button>
      </div>

      {error && (
        <div style={{ padding: 12 }}>
          <div className="error">{error}</div>
        </div>
      )}
      {!connected && !error && <div className="section-empty">Loading providers…</div>}

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
                  {p.models} model{p.models === 1 ? "" : "s"} · {sourceText(p)}
                  {p.usedBy.length > 0 && ` · used by ${p.usedBy.join(", ")}`}
                </div>
              </div>
              {p.logins.length > 0 ? (
                <button className="btn ghost icon sm" onClick={() => setRemoving(p)} title="Remove">
                  <Trash2 size={13} />
                </button>
              ) : (
                <span className="subtle small" title={removalHint(p)}>
                  Can't remove here
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
  if (p.source === "config") return "from your OpenCode config file";
  if (p.source === "environment") return "from an environment variable";
  return "built in";
}

function removalHint(p: ConnectedProvider) {
  if (p.source === "config") return "Defined in OpenCode's config file (opencode.jsonc). Remove it there.";
  if (p.source === "environment") return "Comes from an environment variable on this computer. Remove the variable to disconnect it.";
  return "This provider is built into OpenCode.";
}

function RemoveProviderDialog({ provider, onClose, onRemoved }: { provider: ConnectedProvider; onClose: () => void; onRemoved: () => void }) {
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
      title={`Remove ${provider.name}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger-solid" onClick={remove} disabled={busy}>
            {busy ? "Removing…" : "Remove"}
          </button>
        </>
      }
    >
      <p>
        OpenCode signs out of {provider.name} and deletes its saved login ({provider.logins.map((l) => l.label).join(", ")}). Its{" "}
        {provider.models} models leave the model list. To use it again, add it back with its key or sign-in.
      </p>
      {provider.usedBy.length > 0 && (
        <div className="notice">
          Selected in {provider.usedBy.join(", ")}. Agents there switch to the project's other models; if it has none left, they stop and ask
          for one.
        </div>
      )}
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
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ProviderCatalogEntry | null>(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((e) => !q || e.name.toLowerCase().includes(q) || e.id.includes(q));
  }, [catalog, query]);

  if (chosen) return <ConnectDialog entry={chosen} onBack={() => setChosen(null)} onClose={onClose} onAdded={onAdded} />;

  return (
    <Dialog title="Add a model provider" subtitle="Pick the service you have an account or API key for." onClose={onClose}>
      <div className="model-picker">
        <div className="model-picker-head">
          <Search size={14} className="subtle" />
          <input autoFocus placeholder={`Search ${catalog.length} providers…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="model-groups" style={{ maxHeight: 360 }}>
          {list.map((e) => (
            <div key={e.id} className="model-row" onClick={() => setChosen(e)}>
              <span className="model-name">{e.name}</span>
              {connected.has(e.id) && <span className="tag green">Connected</span>}
              <span className="subtle small">{e.methods.map((m) => (m.type === "key" ? "API key" : "Sign-in")).filter(unique).join(" · ")}</span>
            </div>
          ))}
          {list.length === 0 && <div className="section-empty">No provider matches.</div>}
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
        setError(s.status === "expired" ? "The sign-in expired. Try again." : s.message || "The sign-in failed.");
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
    method.type === "key" ? (busy ? "Connecting…" : "Connect") : attempt ? (busy ? "Finishing…" : "Finish") : busy ? "Starting…" : "Sign in";

  return (
    <Dialog
      title={`Connect ${entry.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onBack} disabled={busy}>
            <ArrowLeft size={14} />
            Back
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
            Finish signing in to {entry.name} in your browser. If it didn't open, use this link:{" "}
            <a href={attempt.url} target="_blank" rel="noopener noreferrer">
              {attempt.url} <ExternalLink size={12} />
            </a>
          </p>
          {attempt.instructions && <div className="notice">{attempt.instructions}</div>}
          {attempt.mode === "code" ? (
            <label className="field">
              <span>Code</span>
              <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code shown after signing in" />
            </label>
          ) : (
            <div className="row subtle small">
              <Loader2 size={13} className="spin" /> Waiting for the sign-in to finish…
            </div>
          )}
        </>
      ) : (
        <>
          {entry.methods.length > 1 && (
            <div className="field">
              <span>How to connect</span>
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
              {invalid === f && <span className="hint" style={{ color: "var(--red)" }}>This doesn't look right.</span>}
            </label>
          ))}
          {method.type === "key" ? (
            <label className="field">
              <span>API key</span>
              <input type="password" autoFocus={fields.length === 0} value={key} onChange={(e) => setKey(e.target.value)} />
            </label>
          ) : (
            <p className="subtle">You'll sign in on {entry.name}'s website, then come back here.</p>
          )}
          {entry.other.length > 0 && <p className="subtle small">Also possible outside Symbio: {entry.other.join("; ")}.</p>}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
