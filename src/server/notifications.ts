// Where Symbio's notifications go (notifier.ts decides what to send): the browser tabs that have
// Symbio open, and channels that reach the human anywhere: Telegram, ntfy, a webhook, e-mail.
// Settings live in ~/.symbio/notifications.json; tokens, the webhook URL and the e-mail password
// live in the encrypted vault (secrets.ts) and never go back to the browser.

import { promises as fs } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { bus } from "./bus.js";
import { writeFileAtomic } from "./fsutil.js";
import type { SecretVault } from "./secrets.js";

export const CHANNELS = ["browser", "telegram", "ntfy", "webhook", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface NotificationSettings {
  /** "full": what happened ("core asks: …"); "short": only the project and that it needs the human. */
  detail: "full" | "short";
  browser: { on: boolean };
  /** The chat is found from a message sent to the bot (Find my chat), with its name to show. */
  telegram: { on: boolean; chatId: string; chatName: string; bot: string };
  ntfy: { on: boolean; server: string; topic: string };
  webhook: { on: boolean };
  email: { on: boolean; host: string; port: number; secure: boolean; user: string; from: string; to: string };
}

/** The secrets each channel keeps in the vault (key: `notify:<channel>:<field>`). */
const SECRET_FIELDS: Record<Channel, string[]> = {
  browser: [],
  telegram: ["token"],
  ntfy: ["token"],
  webhook: ["url"],
  email: ["password"],
};

export interface Notification {
  id: string;
  projectId: string;
  title: string;
  body: string;
  /** Something waits on the human (not just news). */
  important: boolean;
  at: number;
}

/** What the browser sees: the settings, which secrets are set (never their values), and how each channel last went. */
export interface NotificationSettingsView extends NotificationSettings {
  secrets: Record<string, boolean>;
  status: Partial<Record<Channel, { at: number; error: string | null }>>;
}

const defaults = (): NotificationSettings => ({
  detail: "full",
  browser: { on: true },
  telegram: { on: false, chatId: "", chatName: "", bot: "" },
  ntfy: { on: false, server: "https://ntfy.sh", topic: "" },
  webhook: { on: false },
  email: { on: false, host: "", port: 587, secure: false, user: "", from: "", to: "" },
});

const SEND_TIMEOUT_MS = 15_000;
/** The bot's @username for a token being saved; a token Telegram doesn't know is refused. */
async function checkBot(token: string): Promise<string> {
  try {
    const me = await telegram(token, "getMe", {});
    return me?.result?.username ? `@${me.result.username}` : "";
  } catch (err) {
    const message = (err as Error).message;
    if (/Unauthorized|Not Found|doesn't look like/i.test(message)) throw new Error("Telegram doesn't know this token: copy it again from @BotFather (it reads like 123456789:AA…).");
    return ""; // Telegram out of reach: the token is kept, and the test will say what's wrong.
  }
}

/** The bot's @username, so the human opens the right one (people often have several). */
async function botName(token: string): Promise<string> {
  const me = await telegram(token, "getMe", {}).catch(() => null);
  return me?.result?.username ? `@${me.result.username}` : "The bot";
}
// A chat id is a number (negative for groups), or a public channel's @name; anything else is a mistake
// (someone typed a message there), and Telegram would only answer "chat not found".
const isChatId = (v: string) => /^-?\d{1,20}$/.test(v) || /^@\w{5,32}$/.test(v);
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

export class Notifications {
  private settings: NotificationSettings = defaults();
  private status: NotificationSettingsView["status"] = {};

  constructor(
    private readonly dir: string,
    private readonly vault: SecretVault,
  ) {}

  private get file() {
    return path.join(this.dir, "notifications.json");
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<NotificationSettings>;
      const base = defaults();
      this.settings = {
        detail: saved.detail === "short" ? "short" : "full",
        browser: { ...base.browser, ...saved.browser },
        telegram: { ...base.telegram, ...saved.telegram },
        ntfy: { ...base.ntfy, ...saved.ntfy },
        webhook: { ...base.webhook, ...saved.webhook },
        email: { ...base.email, ...saved.email },
      };
      // Earlier versions took any text as the chat (people typed a message there): found again instead.
      if (this.settings.telegram.chatId && !isChatId(this.settings.telegram.chatId)) this.settings.telegram = { ...this.settings.telegram, chatId: "", chatName: "" };
    } catch (err: any) {
      if (err.code !== "ENOENT") console.error("[notifications] couldn't read the settings:", err.message);
    }
  }

  get current(): NotificationSettings {
    return this.settings;
  }

  async view(): Promise<NotificationSettingsView> {
    const secrets: Record<string, boolean> = {};
    for (const channel of CHANNELS) for (const field of SECRET_FIELDS[channel]) secrets[`${channel}.${field}`] = await this.vault.has(`notify:${channel}:${field}`);
    return { ...structuredClone(this.settings), secrets, status: { ...this.status } };
  }

  /**
   * Changes the settings (only the fields given). Secrets: a non-empty text sets one, null removes it,
   * anything else leaves it as it is.
   */
  async update(body: any): Promise<NotificationSettingsView> {
    const next = structuredClone(this.settings);
    if (body?.detail === "full" || body?.detail === "short") next.detail = body.detail;
    for (const channel of CHANNELS) {
      const given = body?.[channel];
      if (!given || typeof given !== "object") continue;
      const target = next[channel] as Record<string, unknown>;
      if (typeof given.on === "boolean") target.on = given.on;
      const chatId = channel === "telegram" ? str(given.chatId, 100) : undefined;
      if (chatId !== undefined && chatId !== next.telegram.chatId) {
        if (chatId && !isChatId(chatId)) throw new Error("The chat is found with Find my chat, after you send /start to your bot (it's a number, not a message).");
        next.telegram.chatId = chatId;
        next.telegram.chatName = typeof given.chatName === "string" ? given.chatName.slice(0, 100) : "";
      }
      if (channel === "ntfy") {
        const server = str(given.server, 300);
        if (server !== undefined) next.ntfy.server = server.replace(/\/+$/, "");
        const topic = str(given.topic, 100);
        if (topic !== undefined) {
          if (topic && !/^[\w-]+$/.test(topic)) throw new Error("An ntfy topic has only letters, digits, - and _.");
          next.ntfy.topic = topic;
        }
      }
      if (channel === "email") {
        for (const field of ["host", "user", "from", "to"] as const) {
          const v = str(given[field], 300);
          if (v !== undefined) next.email[field] = v;
        }
        if (given.port !== undefined) {
          const port = Number(given.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The SMTP port is a number from 1 to 65535.");
          next.email.port = port;
        }
        if (typeof given.secure === "boolean") next.email.secure = given.secure;
      }
      for (const field of SECRET_FIELDS[channel]) {
        const value = given[field];
        if (value === null) {
          await this.vault.deletePrefix(`notify:${channel}:${field}`);
          if (channel === "telegram") next.telegram = { ...next.telegram, chatId: "", chatName: "", bot: "" };
        }
        else if (typeof value === "string" && value.trim()) {
          if (channel === "webhook") checkWebhook(value.trim());
          // Another bot: the chat found for the old one may never have talked to it, so it's found again.
          if (channel === "telegram" && given.chatId === undefined && value.trim() !== (await this.vault.get("notify:telegram:token"))) {
            next.telegram.chatId = "";
            next.telegram.chatName = "";
          }
          // Checked when saved, so a wrong token is said at once, and the page can name the bot to open.
          if (channel === "telegram") next.telegram.bot = await checkBot(value.trim());
          await this.vault.set(`notify:${channel}:${field}`, value.trim());
        }
      }
    }
    if (next.ntfy.server && !/^https?:\/\/\S+$/i.test(next.ntfy.server)) throw new Error("The ntfy server is an http(s) address.");
    this.settings = next;
    await writeFileAtomic(this.file, JSON.stringify(next, null, 2));
    return this.view();
  }

  /** Sends to every channel that's on; one failing doesn't stop the others. */
  async send(n: Notification): Promise<void> {
    await Promise.all(CHANNELS.filter((c) => this.settings[c].on).map((c) => this.sendTo(c, n).catch(() => {})));
  }

  /** A test message on one channel (whether it's on or not); throws what went wrong. */
  async test(channel: Channel): Promise<void> {
    const n: Notification = {
      id: `test-${Date.now()}`,
      projectId: "",
      title: "Symbio: test notification",
      body: "Notifications from Symbio reach you here.",
      important: false,
      at: Date.now(),
    };
    // Telegram without a chat yet: the human just sent /start, so find it first instead of failing.
    if (channel === "telegram" && !this.settings.telegram.chatId && (await this.vault.has("notify:telegram:token"))) await this.findTelegramChat();
    await this.sendTo(channel, n);
  }

  /**
   * Telegram's bot doesn't know the human's chat until they write to it: the chat of the latest
   * message the bot received (the human sends it anything, e.g. /start).
   */
  async findTelegramChat(): Promise<{ chatId: string; name: string }> {
    const token = await this.vault.get("notify:telegram:token");
    if (!token) throw new Error("Save the bot's token first.");
    const res = await telegram(token, "getUpdates", { allowed_updates: ["message"] });
    const updates = (res.result ?? []) as { message?: { chat?: { id: number; first_name?: string; title?: string; username?: string } } }[];
    const chat = updates.map((u) => u.message?.chat).filter(Boolean).at(-1);
    if (!chat) {
      const bot = await botName(token);
      throw new Error(`${bot} hasn't received a message yet: open ${bot} in Telegram, send it /start, then press Find my chat again.`);
    }
    const name = chat.title ?? chat.first_name ?? chat.username ?? String(chat.id);
    await this.update({ telegram: { chatId: String(chat.id), chatName: name } });
    return { chatId: String(chat.id), name };
  }

  private async sendTo(channel: Channel, n: Notification): Promise<void> {
    try {
      await this.deliver(channel, n);
      this.status[channel] = { at: Date.now(), error: null };
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      this.status[channel] = { at: Date.now(), error };
      console.error(`[notifications] ${channel}:`, error);
      throw err;
    }
  }

  private async deliver(channel: Channel, n: Notification): Promise<void> {
    const s = this.settings;
    const text = n.body ? `${n.title}\n\n${n.body}` : n.title;
    switch (channel) {
      case "browser":
        // The open tabs show it (App.tsx), when they're in the background and the human allowed it.
        bus.publish({ type: "notification", notification: n });
        return;
      case "telegram": {
        const token = await this.vault.get("notify:telegram:token");
        if (!token) throw new Error("No bot token.");
        if (!s.telegram.chatId) throw new Error("No chat yet: send the bot a message, then use Find my chat.");
        try {
          await telegram(token, "sendMessage", { chat_id: s.telegram.chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
        } catch (err) {
          // The chat never wrote to this bot (another bot's chat, or a mistyped one), left it or blocked it:
          // say which bot to open, instead of Telegram's "chat not found".
          if (!/chat not found|can't initiate|blocked by the user|user is deactivated|kicked/i.test((err as Error).message)) throw err;
          const bot = await botName(token);
          throw new Error(`${bot} can't write to that chat yet: open ${bot} in Telegram, send it /start, then press Find my chat.`);
        }
        return;
      }
      case "ntfy": {
        if (!s.ntfy.topic) throw new Error("No topic.");
        const token = await this.vault.get("notify:ntfy:token");
        // JSON publishing (to the server's root) carries titles in any language, which headers can't.
        await post(s.ntfy.server || "https://ntfy.sh", {
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ topic: s.ntfy.topic, title: n.title, message: n.body || n.title, priority: n.important ? 4 : 3, tags: ["robot"] }),
        });
        return;
      }
      case "webhook": {
        const url = await this.vault.get("notify:webhook:url");
        if (!url) throw new Error("No webhook address.");
        // `content` is what Discord reads, `text` what Slack and most chat tools read; the rest is for scripts.
        await post(url, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text.slice(0, 1900), text, title: n.title, body: n.body, important: n.important, projectId: n.projectId, at: n.at }),
        }).catch((err: Error) => {
          // The address is a secret (it holds Discord's and Slack's keys), and fetch's errors can quote it.
          throw new Error(err.message.split(url).join("<the webhook address>"));
        });
        return;
      }
      case "email": {
        const e = s.email;
        if (!e.host || !e.to) throw new Error("Set the SMTP server and the address to send to.");
        const password = await this.vault.get("notify:email:password");
        const transport = nodemailer.createTransport({
          host: e.host,
          port: e.port,
          secure: e.secure,
          ...(e.user ? { auth: { user: e.user, pass: password ?? "" } } : {}),
          connectionTimeout: SEND_TIMEOUT_MS,
          greetingTimeout: SEND_TIMEOUT_MS,
          socketTimeout: SEND_TIMEOUT_MS,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        try {
          await transport.sendMail({ from: e.from || e.user || e.to, to: e.to, subject: n.title, text: n.body || n.title });
        } finally {
          transport.close();
        }
        return;
      }
    }
  }
}

/** A webhook address: http(s), and no user or password in it (fetch refuses those, quoting the address). */
function checkWebhook(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The webhook is an http(s) address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The webhook is an http(s) address.");
  if (url.username || url.password) throw new Error("Put the webhook's user and password elsewhere: an address with them can't be called.");
}

async function post(url: string, init: { headers: Record<string, string>; body: string }): Promise<Response> {
  const res = await fetch(url, { method: "POST", ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}${await res.text().then((t) => (t ? `: ${t.slice(0, 200)}` : "")).catch(() => "")}`);
  return res;
}

async function telegram(token: string, method: string, body: unknown): Promise<any> {
  if (!/^\d+:[\w-]+$/.test(token)) throw new Error("That doesn't look like a bot token (it reads like 123456:ABC…).");
  // SYMBIO_TELEGRAM_API stands for Telegram in the tests.
  const api = process.env.SYMBIO_TELEGRAM_API ?? "https://api.telegram.org";
  const res = await fetch(`${api}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  // Telegram's errors can quote the request URL, which holds the token: only its description is kept.
  if (!res.ok || !data?.ok) throw new Error(`Telegram: ${data?.description ?? res.status}`);
  return data;
}
