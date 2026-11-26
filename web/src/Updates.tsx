import { useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { api, type UpdateMode, type UpdateState } from "./api";
import { CopyButton } from "./ui";
import { useI18n, type MessageKey } from "./i18n";

/** Update state, refreshed now and then (the server checks npm every hour). */
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
  const { t } = useI18n();
  if (!state?.available || state.install === "dev") return null;
  return (
    <a className="btn sm update-badge" href="#/settings/computer" title={state.waiting ?? t("usage.updates.badgeTitle", { version: state.latest ?? "" })}>
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

const MODES: { id: UpdateMode; label: MessageKey; hint: MessageKey }[] = [
  { id: "auto", label: "usage.updates.auto", hint: "usage.updates.autoHint" },
  { id: "notify", label: "usage.updates.notify", hint: "usage.updates.notifyHint" },
  { id: "off", label: "usage.updates.off", hint: "usage.updates.offHint" },
];

/** Settings → Updates. */
export function UpdatesSection() {
  const [state, setState] = useUpdate();
  const { t } = useI18n();
  const [busy, setBusy] = useState<null | "check" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  async function run(kind: "check" | "apply") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "check") setState(await api.checkUpdate());
      else {
        const warn = state?.busy ? `\n\n${t("usage.updates.busyWarn", { busy: state.busy })}` : "";
        if (!confirm(`${t("usage.updates.confirm", { version: String(state?.latest) })}${warn}`)) return;
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

  async function setInstallId(on: boolean) {
    try {
      setState(await api.setInstallId(on));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setMode(mode: UpdateMode) {
    try {
      setState(await api.setUpdateMode(mode));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const modeHint = MODES.find((m) => m.id === state?.mode)?.hint;
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{t("usage.updates.title")}</h2>
          <p>
            {t("usage.updates.youHave")} <strong>{state?.current ?? "…"}</strong>
            {state?.latest && !state.available && state.install === "npm" ? t("usage.updates.latestVersion") : "."} {t("usage.updates.alsoAvailable")}{" "}
            <code>sym update</code>.
          </p>
        </div>
        {state?.install === "npm" && (
          <button className="btn sm" onClick={() => run("check")} disabled={!!busy || restarting}>
            <RefreshCw size={13} />
            {busy === "check" ? t("usage.checking") : t("usage.checkNow")}
          </button>
        )}
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        {error && <div className="error">{error}</div>}
        {state?.install === "dev" ? (
          <div className="small subtle">
            {t("usage.updates.dev")} <code>git pull</code>,{" "}
            <code>npm install</code> {t("common.and")} <code>npm run build</code>.
          </div>
        ) : (
          <>
            {state?.lastResult && !state.lastResult.ok && (
              <div className="error">
                {t("usage.updates.failed", { version: state.lastResult.to, error: state.lastResult.error ?? "" })}
              </div>
            )}
            {state?.available && (
              <div className="update-available">
                <div className="row" style={{ gap: 10 }}>
                  <ArrowUpCircle size={16} />
                  <strong className="grow">{t("usage.updates.badgeTitle", { version: state.latest ?? "" })}</strong>
                  <button className="btn primary sm" onClick={() => run("apply")} disabled={!!busy || restarting}>
                    {restarting ? t("usage.updates.restarting") : busy === "apply" ? t("usage.updates.starting") : t("usage.updates.updateNow")}
                  </button>
                </div>
                {restarting ? (
                  <div className="small subtle">{t("usage.updates.restartingNote")}</div>
                ) : (
                  state.waiting && <div className="small subtle">{state.waiting}</div>
                )}
                {state.notes.length > 0 && (
                  <div className="update-notes">
                    {state.notes.map((n) => (
                      <div key={n.version}>
                        <div className="small" style={{ fontWeight: 600 }}>
                          {t("usage.updates.whatsNew", { version: n.version })}
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
              <span>{t("usage.updates.newVersions")}</span>
              <div className="seg">
                {MODES.map((m) => (
                  <button key={m.id} className={state?.mode === m.id ? "on" : ""} onClick={() => setMode(m.id)} disabled={!state}>
                    {t(m.label)}
                  </button>
                ))}
              </div>
              <span className="hint">{modeHint && t(modeHint)}</span>
            </div>
            {state?.error && <div className="small subtle">{state.error}</div>}
            {state?.checkedAt && <div className="small subtle">{t("usage.updates.lastChecked", { date: new Date(state.checkedAt).toLocaleString() })}</div>}
            <label className="choice" data-testid="install-id">
              <input type="checkbox" checked={!!state?.installId} onChange={(e) => setInstallId(e.target.checked)} disabled={!state} />
              <span className="choice-body">
                <span className="choice-title">{t("usage.updates.installId.title")}</span>
                <span className="choice-desc">
                  {t("usage.updates.installId.desc")}{" "}
                  <a href="https://github.com/linkzy/symbio/blob/main/docs/security.md#update-checks" target="_blank" rel="noreferrer">
                    {t("usage.updates.installId.more")}
                  </a>
                </span>
                {state?.installId && (
                  <span className="choice-desc row" style={{ gap: 6 }}>
                    {t("usage.updates.installId.yours")} <code>{state.installId}</code>
                    <CopyButton text={state.installId} />
                  </span>
                )}
              </span>
            </label>
          </>
        )}
      </div>
    </section>
  );
}
