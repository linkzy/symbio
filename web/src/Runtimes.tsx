import { useEffect, useRef, useState } from "react";
import { Bot, Check, Download, ExternalLink, Loader2, LogIn, SquareTerminal, Trash2 } from "lucide-react";
import { api, subscribe, type RuntimeKind, type RuntimeSettings, type RuntimeView } from "./api";
import { useI18n } from "./i18n";

/**
 * The agent runtimes and whether they're installed, kept current: an install's progress and a
 * runtime starting or stopping come as runtime events.
 */
export function useRuntimes(): { runtimes: RuntimeView[] | null; error: string | null; reload: () => void } {
  const [runtimes, setRuntimes] = useState<RuntimeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = () =>
    api
      .runtimes()
      .then((r) => {
        setRuntimes(r);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    // An install prints many lines: read them at most a few times a second.
    const off = subscribe((e) => {
      if (e.type !== "runtime" || timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void load();
      }, 400);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return { runtimes, error, reload: () => void load() };
}

const ICONS: Record<RuntimeKind, React.ReactNode> = {
  opencode: <Bot size={16} />,
  copilot: <SquareTerminal size={16} />,
};

const size = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

/** One runtime: what it is, installing or removing it, and (GitHub Copilot) signing in. */
export function RuntimeCard({ view, onChange }: { view: RuntimeView; onChange: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  }

  const remove = () => {
    const uses = view.projects ? ` ${t(view.projects === 1 ? "agents.runtimes.usesOne" : "agents.runtimes.usesMany", { n: view.projects })}` : "";
    if (confirm(t("agents.runtimes.removeConfirm", { name: view.label, uses }))) void act(() => api.removeRuntime(view.kind));
  };

  return (
    <div className="runtime-card" data-runtime={view.kind}>
      <div className="row" style={{ gap: 10 }}>
        <span className="conn-icon">{ICONS[view.kind]}</span>
        <div className="grow">
          <div className="list-title">{view.label}</div>
          <div className="list-sub">
            {view.installed ? (
              <span className="row" style={{ gap: 4, display: "inline-flex" }}>
                <Check size={12} /> {view.source === "path" ? t("agents.runtimes.usingPath") : t("agents.runtimes.installed")}
                {(view.installedVersion ?? view.version) ? ` · ${view.installedVersion ?? view.version}` : ""}
              </span>
            ) : view.installing ? (
              t("common.installing")
            ) : (
              t("agents.runtimes.notInstalled", { size: size(view.sizeMB) })
            )}
          </div>
        </div>
        {!view.installed && !view.installing && (
          <button className="btn sm primary" onClick={() => act(() => api.installRuntime(view.kind))} disabled={busy}>
            <Download size={13} />
            {t("common.install")}
          </button>
        )}
        {view.installed && view.removable && (
          <button className="btn sm ghost icon" title={t("agents.runtimes.removeTitle", { name: view.label })} onClick={remove} disabled={busy}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {/* The server's text is English: the runtimes Symbio knows are described here, in the interface's language. */}
      <p className="runtime-card-desc">{view.kind === "opencode" || view.kind === "copilot" ? t(`agents.runtimes.desc.${view.kind}`) : view.description}</p>
      <p className="runtime-card-desc subtle">
        {t("agents.runtimes.needs", { needs: view.kind === "opencode" || view.kind === "copilot" ? t(`agents.runtimes.needs.${view.kind}`) : view.needs })}
      </p>
      {view.installing && (
        <div className="runtime-install-log">
          <Loader2 size={13} className="spin" />
          <span className="ellipsis">{view.installLog.at(-1) ?? t("agents.runtimes.downloading")}</span>
        </div>
      )}
      {view.installed && view.kind === "copilot" && <CopilotSignIn view={view} onChange={onChange} />}
      {(error || view.installError) && <div className="error">{error ?? t("agents.runtimes.installError", { error: view.installError ?? "" })}</div>}
    </div>
  );
}

/** Who GitHub Copilot is signed in as, and signing in with a device code (Symbio waits for the approval on GitHub). */
function CopilotSignIn({ view, onChange }: { view: RuntimeView; onChange: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // While a sign-in waits for the human's approval on GitHub, watch for it to complete.
  useEffect(() => {
    if (!view.signIn) return;
    const timer = setInterval(onChange, 2000);
    return () => clearInterval(timer);
  }, [view.signIn?.userCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (action: () => Promise<RuntimeView>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const running = view.state === "running";
  return (
    <div className="copilot-sign-in">
      <div className="row" style={{ gap: 10 }}>
        <div className="grow small">
          {!running ? (
            <span className="subtle">{t("agents.runtimes.startsWhenUsed")}</span>
          ) : view.login ? (
            <span className="copilot-login">
              <span className="dot busy" /> {t("agents.runtimes.signedInAs", { login: view.login })}
            </span>
          ) : (
            <span>{t("agents.runtimes.notSignedIn")}</span>
          )}
        </div>
        {!running ? (
          <button className="btn sm" onClick={() => run(api.checkCopilot)} disabled={busy}>
            {busy ? t("agents.runtimes.starting") : t("agents.runtimes.checkSignIn")}
          </button>
        ) : !view.login && !view.signIn ? (
          <button className="btn sm primary" onClick={() => run(api.copilotSignIn)} disabled={busy}>
            <LogIn size={13} />
            {busy ? t("agents.runtimes.starting") : t("agents.runtimes.signInGitHub")}
          </button>
        ) : null}
      </div>
      {view.signIn && (
        <div className="sign-in-code">
          <div className="small">{t("agents.runtimes.enterCode")}</div>
          <code className="device-code">{view.signIn.userCode}</code>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <a className="btn sm primary" href={view.signIn.verificationUri} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              {t("agents.runtimes.openGitHub")}
            </a>
            <button className="btn sm ghost" onClick={() => run(api.cancelCopilotSignIn)} disabled={busy}>
              {t("common.cancel")}
            </button>
            <span className="subtle small row" style={{ gap: 6 }}>
              <Loader2 size={13} className="spin" /> {t("agents.runtimes.waitingApproval")}
            </span>
          </div>
        </div>
      )}
      {(error || view.signInError) && <div className="error">{error ?? view.signInError}</div>}
    </div>
  );
}

export function RuntimeCards({ runtimes, onChange }: { runtimes: RuntimeView[]; onChange: () => void }) {
  return (
    <div className="runtime-cards">
      {runtimes.map((r) => (
        <RuntimeCard key={r.kind} view={r} onChange={onChange} />
      ))}
    </div>
  );
}

/** Opt-in to an OpenCode already installed on the computer, instead of Symbio's tested copy. */
function PathOpenCodeOption({ onChange }: { onChange: () => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.runtimeSettings().then(setSettings).catch((e: Error) => setError(e.message));
  }, []);

  async function toggle(usePathOpenCode: boolean) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.setRuntimeSettings({ usePathOpenCode }));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="runtime-path-option">
      <label className="check">
        <input
          type="checkbox"
          checked={settings?.usePathOpenCode ?? false}
          // If the executable disappears while it's on, the human must still be able to turn it off.
          disabled={busy || (!settings?.usePathOpenCode && !settings?.pathAvailable)}
          onChange={(e) => void toggle(e.target.checked)}
        />
        {t("agents.runtimes.usePath")}
      </label>
      <p className="runtime-card-desc subtle">
        {t("agents.runtimes.pathDesc.before")}
        <code>opencode</code>
        {t("agents.runtimes.pathDesc.after")}
        {settings && !settings.pathAvailable ? t("agents.runtimes.pathNotFound") : t("agents.runtimes.pathUntested")}
      </p>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Settings section: the agent runtimes, installed or not. */
export function RuntimesSection() {
  const { t } = useI18n();
  const { runtimes, error, reload } = useRuntimes();
  return (
    <section className="section" id="runtimes">
      <div className="section-head">
        <div>
          <h2>{t("agents.runtimes.title")}</h2>
          <p>{t("agents.runtimes.intro")}</p>
        </div>
      </div>
      <div className="section-body">
        {runtimes && <RuntimeCards runtimes={runtimes} onChange={reload} />}
        <PathOpenCodeOption onChange={reload} />
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}
