import { useEffect, useState } from "react";
import { Check, Globe, Power, Share2 } from "lucide-react";
import { CopyButton, copyToClipboard } from "./ui";
import { api, subscribe, type RemoteStatus } from "./api";
import { useI18n, type MessageKey } from "./i18n";

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

/** The link and the access code together, as they read when pasted into a message. */
function remoteShareText(status: RemoteStatus, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  if (!status.url) return "";
  return status.code ? t("remote.shareText", { url: status.url, code: formatCode(status.code) }) : status.url;
}

/** Shares the remote link and code: the system share sheet where the browser has one, otherwise a copy of the same text. */
function ShareButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const title = copied ? t("remote.copiedBoth") : t("remote.share");
  return (
    <button
      type="button"
      className={`btn ghost icon xs ${copied ? "copied" : ""}`}
      title={title}
      aria-label={title}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof navigator.share === "function") {
          try {
            await navigator.share({ text });
          } catch {
            // The user closed the share sheet; nothing to do.
          }
          return;
        }
        // No share sheet here: fall back to copying the same text.
        try {
          await copyToClipboard(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Copying failed; nothing to show.
        }
      }}
    >
      {copied ? <Check size={13} /> : <Share2 size={13} />}
    </button>
  );
}

/** The banner at the top while remote access is on, with the button to turn it off. */
export function RemoteBanner() {
  const { t } = useI18n();
  const [status] = useRemote();
  const [stopping, setStopping] = useState(false);
  if (!status?.active) return null;
  const local = status.code !== undefined;
  async function stop() {
    if (!confirm(local ? t("remote.offConfirm.local") : t("remote.offConfirm.remote"))) return;
    setStopping(true);
    await api.stopRemote().catch((e) => alert(e.message));
    setStopping(false);
  }
  return (
    <div className="remote-banner">
      <Globe size={14} />
      <span>
        <strong>{t("remote.banner.on")}</strong>{" "}
        {local ? (
          <>
            <a href={status.url!} target="_blank" rel="noreferrer">
              {status.url}
            </a>
            {status.code && (
              <>
                {` · ${t("remote.banner.code")} `}
                <code className="remote-code">{formatCode(status.code)}</code>
              </>
            )}
            {" · "}
            {t(status.sessions === 1 ? "remote.sessionsOne" : "remote.sessions", { n: status.sessions })}
          </>
        ) : (
          t("remote.banner.viaLink")
        )}
      </span>
      <span className="spacer" />
      <button className="btn sm" onClick={stop} disabled={stopping}>
        <Power size={13} />
        {stopping ? t("remote.turningOff") : t("remote.turnOff")}
      </button>
    </div>
  );
}

/** Global settings: turn remote access on or off from this computer. */
export function RemoteSection() {
  const [status, reload] = useRemote();
  const { t, locale } = useI18n();
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
          <h2>{t("remote.title")}</h2>
          <p>
            {t("remote.desc.before")}<code>sym remote</code>{t("remote.desc.after")}
          </p>
        </div>
        {local && (
          <button className={`btn sm ${status?.active ? "" : "primary"}`} onClick={toggle} disabled={busy || !status}>
            <Power size={13} />
            {busy ? (status?.active ? t("remote.turningOff") : t("remote.opening")) : status?.active ? t("remote.turnOff") : t("remote.turnOn")}
          </button>
        )}
      </div>
      <div className="stack" style={{ padding: 16, gap: 10 }}>
        {error && <div className="error">{error}</div>}
        {status?.active ? (
          <>
            <div className="field">
              <span>{t("remote.link")}</span>
              <div className="row" style={{ gap: 8 }}>
                <a href={status.url!} target="_blank" rel="noreferrer" className="mono small">
                  {status.url}
                </a>
                <CopyButton text={remoteShareText(status, t)} label={t("remote.copyBoth")} copiedLabel={t("remote.copiedBoth")} />
                <ShareButton text={remoteShareText(status, t)} />
              </div>
            </div>
            {status.code && (
              <div className="field">
                <span>{t("remote.accessCode")}</span>
                <div className="row" style={{ gap: 8 }}>
                  <code className="remote-code big">{formatCode(status.code)}</code>
                  <CopyButton text={formatCode(status.code)} label={t("remote.copyCode")} copiedLabel={t("remote.copiedCode")} />
                </div>
              </div>
            )}
            <div className="small subtle">
              {t("remote.onSince", {
                date: new Date(status.startedAt!).toLocaleString(locale),
                sessions: t(status.sessions === 1 ? "remote.sessionsOne" : "remote.sessions", { n: status.sessions }),
              })}
            </div>
          </>
        ) : (
          <div className="small subtle">
            {t("remote.off")}
            {status?.lastStop ? t("remote.lastOff", { date: new Date(status.lastStop.at).toLocaleString(locale), reason: status.lastStop.reason }) : ""}
            {busy && t("remote.openingLink")}
          </div>
        )}
      </div>
    </section>
  );
}
