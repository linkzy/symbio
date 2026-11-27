import { useEffect, useState, type ReactNode } from "react";
import { Bell, Check, Search, Send, Shuffle } from "lucide-react";
import { api, NOTIFY_KINDS_NEEDS, NOTIFY_KINDS_NEWS, subscribe, type NotificationSettings, type NotifyChannel, type NotifyKind, type Project } from "./api";
import { useI18n } from "./i18n";
import { timeAgo } from "./ui";

const supported = () => typeof window !== "undefined" && "Notification" in window;

/**
 * Shows Symbio's notifications (notifier.ts) as the system's, while this tab is in the background
 * and the human allowed it. Every open tab gets them: the tag makes the browser show one.
 */
export function useBrowserNotifications() {
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== "notification" || !supported() || Notification.permission !== "granted") return;
        if (document.visibilityState === "visible") return;
        const n = e.notification;
        try {
          const shown = new Notification(n.title, { body: n.body, tag: n.id });
          shown.onclick = () => {
            window.focus();
            if (n.projectId) location.hash = `#/p/${n.projectId}`;
            shown.close();
          };
        } catch {
          // Phones' browsers only show notifications from a service worker: other channels reach them.
        }
      }),
    [],
  );
}

type Draft = Omit<NotificationSettings, "secrets" | "status">;
/** Secrets typed in the form (sent once, never shown back). */
type SecretDraft = Record<string, string>;

const strip = (s: NotificationSettings): Draft => {
  const { secrets: _s, status: _t, ...rest } = s;
  return structuredClone(rest);
};

const randomTopic = () => `symbio-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Settings → Notifications: where Symbio tells you what needs you, and what got done. */
export function NotificationsSection() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<NotificationSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secrets, setSecrets] = useState<SecretDraft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<NotifyChannel | null>(null);
  const [result, setResult] = useState<{ channel: NotifyChannel; ok: boolean; text: string } | null>(null);
  // Where the last save was pressed: its error shows there, next to the button, not at the top.
  const [findError, setFindError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [savedFrom, setSavedFrom] = useState<NotifyChannel | null>(null);
  const [permission, setPermission] = useState(supported() ? Notification.permission : "unsupported");

  const loaded = (s: NotificationSettings) => {
    setSaved(s);
    setDraft(strip(s));
    setSecrets({});
  };
  useEffect(() => {
    api.notifications().then(loaded).catch((e) => setError(e.message));
  }, []);
  if (!saved || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(strip(saved)) || Object.values(secrets).some((v) => v.trim());
  // One channel's unsaved changes (its card shows Save where the test would be).
  const channelDirty = (channel: NotifyChannel) =>
    JSON.stringify(draft[channel]) !== JSON.stringify(strip(saved)[channel]) || Object.entries(secrets).some(([k, v]) => k.startsWith(`${channel}.`) && v.trim());
  const tokenSaved = saved.secrets["telegram.token"];
  const bot = saved.telegram.bot || t("notify.telegram.yourBot");
  // What a channel still needs before a test can work, said next to the disabled button.
  const missing = (channel: NotifyChannel): string | null => {
    const s = saved;
    if (channel === "browser") return permission === "granted" ? null : t("notify.need.browser");
    if (channel === "telegram") return !tokenSaved ? t("notify.need.telegramToken") : !s.telegram.chatId ? t("notify.need.telegramChat") : null;
    if (channel === "ntfy") return s.ntfy.topic ? null : t("notify.need.ntfy");
    if (channel === "webhook") return s.secrets["webhook.url"] ? null : t("notify.need.webhook");
    return s.email.host && s.email.to ? null : t("notify.need.email");
  };
  const set = <C extends NotifyChannel>(channel: C, patch: Partial<Draft[C]>) => setDraft({ ...draft, [channel]: { ...draft[channel], ...patch } });

  async function save(from: NotifyChannel | null = null) {
    setSaving(true);
    setError(null);
    setSavedFrom(from);
    setResult(null);
    try {
      const body: Record<string, any> = structuredClone(draft!);
      for (const [key, value] of Object.entries(secrets)) {
        if (!value.trim()) continue;
        const [channel, field] = key.split(".");
        body[channel] = { ...body[channel], [field]: value.trim() };
      }
      loaded(await api.updateNotifications(body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function test(channel: NotifyChannel) {
    setTesting(channel);
    setResult(null);
    try {
      await api.testNotification(channel);
      setResult({ channel, ok: true, text: channel === "browser" ? t("notify.test.browserSent") : t("notify.test.sent") });
    } catch (e) {
      setResult({ channel, ok: false, text: (e as Error).message });
    } finally {
      setTesting(null);
      // Tests only run with nothing unsaved, so reloading loses nothing; it shows a chat a Telegram test found.
      api.notifications().then(loaded).catch(() => {});
    }
  }

  async function findChat() {
    setFindError(null);
    setFinding(true);
    try {
      const chat = await api.findTelegramChat();
      loaded(await api.notifications());
      setResult({ channel: "telegram", ok: true, text: t("notify.telegram.found", { name: chat.name }) });
    } catch (e) {
      setFindError((e as Error).message);
    } finally {
      setFinding(false);
    }
  }

  const secretInput = (key: string, label: string, placeholder?: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete="off"
        value={secrets[key] ?? ""}
        placeholder={saved.secrets[key] ? t("notify.secret.saved") : (placeholder ?? "")}
        onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
      />
    </label>
  );

  const footer = (channel: NotifyChannel) => {
    const status = saved.status[channel];
    // Unsaved changes here: saving is the next step, so it takes the test's place.
    if (channelDirty(channel))
      return (
        <div className="row notify-footer">
          <button className="btn sm primary" disabled={saving} onClick={() => save(channel)}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
          {error && savedFrom === channel ? <span className="small notify-error">{error}</span> : <span className="small subtle">{t("notify.saveToContinue")}</span>}
        </div>
      );
    const need = missing(channel);
    return (
      <div className="row notify-footer">
        <button className="btn sm" disabled={!!need || dirty || testing !== null} title={dirty ? t("notify.test.saveFirst") : undefined} onClick={() => test(channel)}>
          <Send size={13} />
          {testing === channel ? t("common.testing") : t("notify.test")}
        </button>
        {need ? (
          <span className="small subtle">{need}</span>
        ) : result?.channel === channel ? (
          <span className={`small ${result.ok ? "notify-ok" : "notify-error"}`}>{result.text}</span>
        ) : status ? (
          <span className={`small ${status.error ? "notify-error" : "subtle"}`}>
            {status.error ? t("notify.status.failed", { when: timeAgo(status.at), error: status.error }) : t("notify.status.sent", { when: timeAgo(status.at) })}
          </span>
        ) : null}
      </div>
    );
  };

  const card = (channel: NotifyChannel, title: string, desc: string, body: ReactNode) => (
    <div className={`notify-channel ${draft[channel].on ? "on" : ""}`} data-channel={channel}>
      <label className="choice">
        <input
          type="checkbox"
          checked={draft[channel].on}
          onChange={(e) =>
            // ntfy needs a topic nobody guesses: one is made up when it's turned on.
            channel === "ntfy" && e.target.checked && !draft.ntfy.topic ? set("ntfy", { on: true, topic: randomTopic() }) : set(channel, { on: e.target.checked } as any)
          }
        />
        <span className="choice-body">
          <span className="choice-title">{title}</span>
          <span className="choice-desc">{desc}</span>
        </span>
      </label>
      {draft[channel].on && (
        <div className="stack notify-body">
          {body}
          {footer(channel)}
        </div>
      )}
    </div>
  );

  return (
    <section className="section" id="notifications">
      <div className="section-head">
        <div>
          <h2>{t("notify.title")}</h2>
          <p>{t("notify.desc")}</p>
        </div>
      </div>
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        {error && !savedFrom && <div className="error">{error}</div>}
        {saved.vaultError && <div className="error">{saved.vaultError}</div>}
        <div className="field">
          <span>{t("notify.detail.title")}</span>
          <div className="seg">
            <button className={draft.detail === "full" ? "on" : ""} onClick={() => setDraft({ ...draft, detail: "full" })}>
              {t("notify.detail.full")}
            </button>
            <button className={draft.detail === "short" ? "on" : ""} onClick={() => setDraft({ ...draft, detail: "short" })}>
              {t("notify.detail.short")}
            </button>
          </div>
          <span className="hint">{draft.detail === "full" ? t("notify.detail.hint.full") : t("notify.detail.hint.short")}</span>
        </div>

        {/* Which kinds go out, for every project and channel: what needs the human, then news. */}
        <div className="field" data-testid="notify-kinds">
          <span>{t("notify.kinds.title")}</span>
          <div className="notify-kinds">
            {([
              ["needs", NOTIFY_KINDS_NEEDS],
              ["news", NOTIFY_KINDS_NEWS],
            ] as const).map(([group, kinds]) => (
              <div key={group} className="notify-kinds-group">
                <div className="small notify-kinds-head">{t(`notify.kinds.${group}`)}</div>
                {kinds.map((kind: NotifyKind) => (
                  <label key={kind} className="check small">
                    <input type="checkbox" checked={draft.kinds[kind] !== false} onChange={(e) => setDraft({ ...draft, kinds: { ...draft.kinds, [kind]: e.target.checked } })} />
                    {t(`notify.kind.${kind}`)}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <span className="hint">{t("notify.kinds.hint")}</span>
        </div>

        {card(
          "browser",
          t("notify.browser.title"),
          t("notify.browser.desc"),
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            {permission === "granted" ? (
              <span className="small notify-ok">{t("notify.browser.allowed")}</span>
            ) : permission === "denied" ? (
              <span className="small notify-error">{t("notify.browser.denied")}</span>
            ) : permission === "unsupported" ? (
              <span className="small subtle">{t("notify.browser.unsupported")}</span>
            ) : (
              <button className="btn sm primary" onClick={() => Notification.requestPermission().then(setPermission)}>
                <Bell size={13} />
                {t("notify.browser.allow")}
              </button>
            )}
          </div>,
        )}

        {card(
          "telegram",
          "Telegram",
          t("notify.telegram.desc"),
          <>
            {/* In the order it's done: the token (saved), then the chat (found), then the test (below). */}
            <ol className="notify-flow">
              <li className={tokenSaved ? "done" : "current"}>
                <div className="notify-step-title">{t("notify.telegram.s1")}</div>
                <div className="small subtle">{t("notify.telegram.s1.how")}</div>
                {secretInput("telegram.token", t("notify.telegram.token"), "123456789:AA…")}
                {tokenSaved && saved.telegram.bot && (
                  <span className="small notify-ok">
                    <Check size={12} /> {t("notify.telegram.bot", { bot: saved.telegram.bot })}
                  </span>
                )}
              </li>
              {tokenSaved && (
                <li className={saved.telegram.chatId ? "done" : "current"}>
                  <div className="notify-step-title">{t("notify.telegram.s2")}</div>
                  <div className="small subtle">{t("notify.telegram.s2.how", { bot })}</div>
                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <button className={`btn sm ${saved.telegram.chatId ? "" : "primary"}`} disabled={finding || channelDirty("telegram")} onClick={findChat}>
                      <Search size={13} />
                      {t("notify.telegram.find")}
                    </button>
                    {saved.telegram.chatId && (
                      <span className="small notify-ok" data-testid="telegram-chat">
                        <Check size={12} /> {t("notify.telegram.chatFound", { name: saved.telegram.chatName || saved.telegram.chatId })}
                      </span>
                    )}
                  </div>
                  {findError && <span className="small notify-error">{findError}</span>}
                </li>
              )}
            </ol>
          </>,
        )}

        {card(
          "ntfy",
          "ntfy",
          t("notify.ntfy.desc"),
          <>
            <ol className="small notify-steps">
              <li>{t("notify.ntfy.step1")}</li>
              <li>{t("notify.ntfy.step2")}</li>
              <li>{t("notify.ntfy.step3")}</li>
            </ol>
            <div className="field-row">
              <label className="field">
                <span>{t("notify.ntfy.server")}</span>
                <input value={draft.ntfy.server} onChange={(e) => set("ntfy", { server: e.target.value })} placeholder="https://ntfy.sh" />
              </label>
              <div className="field">
                <span>{t("notify.ntfy.topic")}</span>
                <div className="input-row">
                  <input value={draft.ntfy.topic} onChange={(e) => set("ntfy", { topic: e.target.value })} placeholder="symbio-…" />
                  <button className="btn sm" title={t("notify.ntfy.random")} aria-label={t("notify.ntfy.random")} onClick={() => set("ntfy", { topic: randomTopic() })}>
                    <Shuffle size={13} />
                  </button>
                </div>
              </div>
            </div>
            <span className="small subtle">{t("notify.ntfy.hint")}</span>
            {secretInput("ntfy.token", t("notify.ntfy.token"), t("notify.optional"))}
          </>,
        )}

        {card(
          "webhook",
          t("notify.webhook.title"),
          t("notify.webhook.desc"),
          <>
            {secretInput("webhook.url", t("notify.webhook.url"), "https://discord.com/api/webhooks/…")}
            <span className="small subtle">
              {t("notify.webhook.hint")} <code>{"{ text, content, title, body, important, projectId, at }"}</code>
            </span>
          </>,
        )}

        {card(
          "email",
          t("notify.email.title"),
          t("notify.email.desc"),
          <>
            <div className="field-row">
              <label className="field" style={{ flex: 3 }}>
                <span>{t("notify.email.host")}</span>
                <input value={draft.email.host} onChange={(e) => set("email", { host: e.target.value })} placeholder="smtp.example.com" />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span>{t("notify.email.port")}</span>
                <input type="number" min={1} max={65535} value={draft.email.port} onChange={(e) => set("email", { port: Number(e.target.value) })} />
              </label>
            </div>
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={draft.email.secure} onChange={(e) => set("email", { secure: e.target.checked })} />
              {t("notify.email.secure")}
            </label>
            <div className="field-row">
              <label className="field">
                <span>{t("notify.email.user")}</span>
                <input value={draft.email.user} autoComplete="off" onChange={(e) => set("email", { user: e.target.value })} />
              </label>
              {secretInput("email.password", t("notify.email.password"))}
            </div>
            <span className="small subtle">{t("notify.email.hint")}</span>
            <div className="field-row">
              <label className="field">
                <span>{t("notify.email.from")}</span>
                <input value={draft.email.from} onChange={(e) => set("email", { from: e.target.value })} placeholder={t("notify.email.fromPlaceholder")} />
              </label>
              <label className="field">
                <span>{t("notify.email.to")}</span>
                <input value={draft.email.to} onChange={(e) => set("email", { to: e.target.value })} placeholder="you@example.com" />
              </label>
            </div>
          </>,
        )}
      </div>
      {/* Changes a channel's own Save doesn't show (the detail, a channel turned off). */}
      {dirty && !(["browser", "telegram", "ntfy", "webhook", "email"] as NotifyChannel[]).some((c) => draft[c].on && channelDirty(c)) && (
        <div className="row" style={{ justifyContent: "flex-end", padding: "0 16px 14px", gap: 8 }}>
          <button className="btn ghost sm" disabled={saving} onClick={() => loaded(saved)}>
            {t("common.discard")}
          </button>
          <button className="btn primary sm" disabled={saving} onClick={() => save()}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      )}
    </section>
  );
}

/** Project settings: which of this project's notifications to send. Applies at once. */
export function ProjectNotifyChoice({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const level = project.notify ?? "all";
  async function choose(notify: "all" | "important" | "off") {
    if (notify === level) return;
    setBusy(true);
    try {
      onChanged(await api.updateProject(project.id, { notify }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      <span>{t("notify.project.title")}</span>
      <div className="seg" data-testid="project-notify">
        {(["all", "important", "off"] as const).map((l) => (
          <button key={l} className={level === l ? "on" : ""} disabled={busy} onClick={() => choose(l)}>
            {t(`notify.project.${l}`)}
          </button>
        ))}
      </div>
      <span className="hint">
        {t(`notify.project.hint.${level}`)} <a href="#/settings/notifications">{t("notify.project.where")}</a>
      </span>
    </div>
  );
}
