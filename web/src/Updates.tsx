import { useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { api, type UpdateMode, type UpdateState } from "./api";

/** Update state, refreshed now and then (the server checks npm every few hours). */
export function useUpdate(): [UpdateState | null, (s: UpdateState) => void] {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const load = () => api.update().then(setState).catch(() => {});
    void load();
    const timer = setInterval(load, 10 * 60_000);
    return () => clearInterval(timer);
  }, []);
  return [state, setState];
}

/** Top bar: a small notice when a newer version exists, linking to Settings. */
export function UpdateBadge() {
  const [state] = useUpdate();
  if (!state?.available || state.install === "dev") return null;
  return (
    <a className="btn ghost sm update-badge" href="#/settings" title={state.waiting ?? `Symbio ${state.latest} is available`}>
      <ArrowUpCircle size={15} />
      {state.latest}
    </a>
  );
}

/** Waits for Symbio to come back on the new version, then reloads the page. */
function waitForRestart(from: string) {
  const timer = setInterval(() => {
    api
      .update()
      .then((s) => {
        if (s.current !== from || (s.lastResult && !s.lastResult.ok)) {
          clearInterval(timer);
          location.reload();
        }
      })
      .catch(() => {}); // restarting
  }, 3000);
}

const MODES: { id: UpdateMode; label: string; hint: string }[] = [
  { id: "auto", label: "Automatic", hint: "Installs new versions by itself, only when no agent has been working for 10 minutes and remote access is off; it backs up first and tells you in Messages." },
  { id: "notify", label: "Tell me", hint: "Shows when a new version is available; you update with the button below or `sym update`." },
  { id: "off", label: "Off", hint: "Doesn't check for new versions." },
];

/** Settings → Updates. */
export function UpdatesSection() {
  const [state, setState] = useUpdate();
  const [busy, setBusy] = useState<null | "check" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  async function run(kind: "check" | "apply") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "check") setState(await api.checkUpdate());
      else {
        const warn = state?.busy ? `\n\nRight now ${state.busy}: it's interrupted and continues after the restart.` : "";
        if (!confirm(`Update Symbio to ${state?.latest}? Symbio stops, installs it and starts again (a minute or two).${warn}`)) return;
        await api.applyUpdate();
        setRestarting(true);
        waitForRestart(state!.current);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setMode(mode: UpdateMode) {
    try {
      setState(await api.setUpdateMode(mode));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Updates</h2>
          <p>
            You have Symbio <strong>{state?.current ?? "…"}</strong>
            {state?.latest && !state.available && state.install === "npm" ? ", the latest version." : "."} Also available as{" "}
            <code>sym update</code>.
          </p>
        </div>
        {state?.install === "npm" && (
          <button className="btn sm" onClick={() => run("check")} disabled={!!busy || restarting}>
            <RefreshCw size={13} />
            {busy === "check" ? "Checking…" : "Check now"}
          </button>
        )}
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        {error && <div className="error">{error}</div>}
        {state?.install === "dev" ? (
          <div className="small subtle">
            This Symbio runs from a development folder, so it doesn't update itself: update it there with <code>git pull</code>,{" "}
            <code>npm install</code> and <code>npm run build</code>.
          </div>
        ) : (
          <>
            {state?.lastResult && !state.lastResult.ok && (
              <div className="error">
                The update to {state.lastResult.to} didn't complete: {state.lastResult.error}
              </div>
            )}
            {state?.available && (
              <div className="update-available">
                <div className="row" style={{ gap: 10 }}>
                  <ArrowUpCircle size={16} />
                  <strong className="grow">Symbio {state.latest} is available</strong>
                  <button className="btn primary sm" onClick={() => run("apply")} disabled={!!busy || restarting}>
                    {restarting ? "Restarting…" : busy === "apply" ? "Starting…" : "Update now"}
                  </button>
                </div>
                {restarting ? (
                  <div className="small subtle">Symbio is restarting with the new version; this page reloads by itself.</div>
                ) : (
                  state.waiting && <div className="small subtle">{state.waiting}</div>
                )}
                {state.notes.length > 0 && (
                  <div className="update-notes">
                    {state.notes.map((n) => (
                      <div key={n.version}>
                        <div className="small" style={{ fontWeight: 600 }}>
                          What's new in {n.version}
                        </div>
                        <ul>
                          {n.items.map((item, i) => (
                            <li key={i}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="field">
              <span>New versions</span>
              <div className="seg">
                {MODES.map((m) => (
                  <button key={m.id} className={state?.mode === m.id ? "on" : ""} onClick={() => setMode(m.id)} disabled={!state}>
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="hint">{MODES.find((m) => m.id === state?.mode)?.hint}</span>
            </div>
            {state?.error && <div className="small subtle">{state.error}</div>}
            {state?.checkedAt && <div className="small subtle">Last checked {new Date(state.checkedAt).toLocaleString()}.</div>}
          </>
        )}
      </div>
    </section>
  );
}
