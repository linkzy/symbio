import { useEffect, useState } from "react";
import { Copy, Globe, Power } from "lucide-react";
import { api, subscribe, type RemoteStatus } from "./api";

/** Remote access status, kept current. */
export function useRemote(): [RemoteStatus | null, () => void] {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const load = () => api.remote().then(setStatus).catch(() => {});
  useEffect(() => {
    void load();
    return subscribe((e) => {
      if (e.type === "remote.updated") void load();
    });
  }, []);
  return [status, load];
}

const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** The banner at the top while remote access is on, with the button to turn it off. */
export function RemoteBanner() {
  const [status] = useRemote();
  const [stopping, setStopping] = useState(false);
  if (!status?.active) return null;
  const local = status.code !== undefined;
  async function stop() {
    if (!confirm(local ? "Turn remote access off? Remote sessions end and the link stops working." : "Turn remote access off? This page stops working right away.")) return;
    setStopping(true);
    await api.stopRemote().catch((e) => alert(e.message));
    setStopping(false);
  }
  return (
    <div className="remote-banner">
      <Globe size={14} />
      <span>
        <strong>Remote access is on.</strong>{" "}
        {local ? (
          <>
            <a href={status.url!} target="_blank" rel="noreferrer">
              {status.url}
            </a>
            {status.code && (
              <>
                {" · code "}
                <code className="remote-code">{formatCode(status.code)}</code>
              </>
            )}
            {" · "}
            {status.sessions} remote session{status.sessions === 1 ? "" : "s"}
          </>
        ) : (
          "You're using Symbio through a temporary link."
        )}
      </span>
      <span className="spacer" />
      <button className="btn sm" onClick={stop} disabled={stopping}>
        <Power size={13} />
        {stopping ? "Turning off…" : "Turn off"}
      </button>
    </div>
  );
}

/** Global settings: turn remote access on or off from this computer. */
export function RemoteSection() {
  const [status, reload] = useRemote();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = status?.code !== undefined;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (status?.active) await api.stopRemote();
      else await api.startRemote();
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Remote access</h2>
          <p>
            Opens a temporary Cloudflare link to this Symbio so you can use it from another device. Visitors need the access code; after
            10 wrong codes the link is shut down. Whoever gets in controls your agents, which run commands on this computer: share the link
            and code only with yourself, and turn it off when you're done. Also available as <code>sym remote</code>.
          </p>
        </div>
        {local && (
          <button className={`btn sm ${status?.active ? "" : "primary"}`} onClick={toggle} disabled={busy || !status}>
            <Power size={13} />
            {busy ? (status?.active ? "Turning off…" : "Opening…") : status?.active ? "Turn off" : "Turn on"}
          </button>
        )}
      </div>
      <div className="stack" style={{ padding: 16, gap: 10 }}>
        {error && <div className="error">{error}</div>}
        {status?.active ? (
          <>
            <div className="field">
              <span>Link</span>
              <div className="row" style={{ gap: 8 }}>
                <a href={status.url!} target="_blank" rel="noreferrer" className="mono small">
                  {status.url}
                </a>
                <button className="btn ghost icon xs" title="Copy" onClick={() => navigator.clipboard.writeText(status.url!)}>
                  <Copy size={12} />
                </button>
              </div>
            </div>
            {status.code && (
              <div className="field">
                <span>Access code</span>
                <code className="remote-code big">{formatCode(status.code)}</code>
              </div>
            )}
            <div className="small subtle">
              On since {new Date(status.startedAt!).toLocaleString()} · {status.sessions} remote session{status.sessions === 1 ? "" : "s"}. A new
              link and code are made each time.
            </div>
          </>
        ) : (
          <div className="small subtle">
            Off.{status?.lastStop ? ` Last turned off ${new Date(status.lastStop.at).toLocaleString()}: ${status.lastStop.reason}.` : ""}
            {busy && " Opening the link (the first time, cloudflared is downloaded first)…"}
          </div>
        )}
      </div>
    </section>
  );
}
