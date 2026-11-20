import { useEffect, useRef, useState } from "react";
import { Bot, Check, Download, ExternalLink, Loader2, LogIn, SquareTerminal, Trash2 } from "lucide-react";
import { api, subscribe, type RuntimeKind, type RuntimeSettings, type RuntimeView } from "./api";

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
    const uses = view.projects ? ` ${view.projects === 1 ? "A project runs" : `${view.projects} projects run`} on it: they can't start agents until you install it again.` : "";
    if (confirm(`Remove ${view.label} from this computer?${uses}`)) void act(() => api.removeRuntime(view.kind));
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
                <Check size={12} /> {view.source === "path" ? "Using OpenCode from PATH" : "Installed"}
                {(view.installedVersion ?? view.version) ? ` · ${view.installedVersion ?? view.version}` : ""}
              </span>
            ) : view.installing ? (
              "Installing…"
            ) : (
              `Not installed · about ${size(view.sizeMB)}`
            )}
          </div>
        </div>
        {!view.installed && !view.installing && (
          <button className="btn sm primary" onClick={() => act(() => api.installRuntime(view.kind))} disabled={busy}>
            <Download size={13} />
            Install
          </button>
        )}
        {view.installed && view.removable && (
          <button className="btn sm ghost icon" title={`Remove ${view.label}`} onClick={remove} disabled={busy}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      <p className="runtime-card-desc">{view.description}</p>
      <p className="runtime-card-desc subtle">Needs: {view.needs}</p>
      {view.installing && (
        <div className="runtime-install-log">
          <Loader2 size={13} className="spin" />
          <span className="ellipsis">{view.installLog.at(-1) ?? "Downloading…"}</span>
        </div>
      )}
      {view.installed && view.kind === "copilot" && <CopilotSignIn view={view} onChange={onChange} />}
      {(error || view.installError) && <div className="error">{error ?? `Couldn't install it: ${view.installError}`}</div>}
    </div>
  );
}

/** Who GitHub Copilot is signed in as, and signing in with a device code (Symbio waits for the approval on GitHub). */
function CopilotSignIn({ view, onChange }: { view: RuntimeView; onChange: () => void }) {
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
            <span className="subtle">Starts when a project uses it.</span>
          ) : view.login ? (
            <span className="copilot-login">
              <span className="dot busy" /> Signed in as {view.login}
            </span>
          ) : (
            <span>Not signed in: sign in with the GitHub account that has your Copilot subscription.</span>
          )}
        </div>
        {!running ? (
          <button className="btn sm" onClick={() => run(api.checkCopilot)} disabled={busy}>
            {busy ? "Starting…" : "Check sign-in"}
          </button>
        ) : !view.login && !view.signIn ? (
          <button className="btn sm primary" onClick={() => run(api.copilotSignIn)} disabled={busy}>
            <LogIn size={13} />
            {busy ? "Starting…" : "Sign in with GitHub"}
          </button>
        ) : null}
      </div>
      {view.signIn && (
        <div className="sign-in-code">
          <div className="small">On GitHub, enter this code:</div>
          <code className="device-code">{view.signIn.userCode}</code>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <a className="btn sm primary" href={view.signIn.verificationUri} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              Open GitHub
            </a>
            <button className="btn sm ghost" onClick={() => run(api.cancelCopilotSignIn)} disabled={busy}>
              Cancel
            </button>
            <span className="subtle small row" style={{ gap: 6 }}>
              <Loader2 size={13} className="spin" /> Waiting for your approval on GitHub…
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
        Use OpenCode from PATH
      </label>
      <p className="runtime-card-desc subtle">
        Runs the <code>opencode</code> already installed on this computer instead of Symbio's tested copy.
        {settings && !settings.pathAvailable ? " No OpenCode was found on PATH." : " It may be a different, untested version."}
      </p>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Settings section: the agent runtimes, installed or not. */
export function RuntimesSection() {
  const { runtimes, error, reload } = useRuntimes();
  return (
    <section className="section" id="runtimes">
      <div className="section-head">
        <div>
          <h2>Agent runtimes</h2>
          <p>
            The programs agents run on. Install the ones you use: each project picks one when it's created. Symbio downloads them into its own
            folder, at the version it was tested with; removing one deletes that copy. You can opt in below to use an OpenCode already on PATH.
          </p>
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
