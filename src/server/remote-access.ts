// Remote access: a temporary Cloudflare quick tunnel (https://….trycloudflare.com) to this
// Symbio, guarded by an access code.
//
// Through the tunnel Symbio controls agents that run commands on this computer, so:
// - remote requests need a session, obtained by entering the access code (8 characters);
//   after 10 wrong codes the tunnel is shut down;
// - API calls also need the UI key, as locally (a leaked key alone isn't enough from outside);
// - the agents' tool endpoint, debug routes and shutdown are never reachable remotely;
// - turning remote access off ends every remote session; the code is shown only locally.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const CODE_LENGTH = 8;
export const MAX_FAILURES = 10;
const SESSION_MS = 12 * 3600_000;
export const SESSION_COOKIE = "symbio_remote";

export function newAccessCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function codesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim().toUpperCase().replace(/[\s-]/g, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Requests that came through Cloudflare (they carry its headers) or name the tunnel's host. */
export function isTunnelRequest(headers: { host?: string | null; cfRay?: string | null; cfIp?: string | null }, tunnelHost: string | null): boolean {
  if (headers.cfRay || headers.cfIp) return true;
  const host = (headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return !!tunnelHost && host === tunnelHost.toLowerCase();
}

export type RemoteDecision = "allow" | "deny" | "login-page" | "login-submit" | "need-login";

// Never through the tunnel: the agents' tools, debugging, shutting Symbio down, starting a
// tunnel, and the native folder dialog (it would open on this computer's screen).
const NEVER_REMOTE = [/^\/mcp(\/|$)/, /^\/api\/debug(\/|$)/, /^\/api\/shutdown$/, /^\/api\/remote\/start$/, /^\/api\/pick-folder$/];

/** What to do with a request that came through the tunnel. */
export function remoteDecision(req: { method: string; path: string; hasSession: boolean; active: boolean }): RemoteDecision {
  if (!req.active) return "deny";
  if (NEVER_REMOTE.some((re) => re.test(req.path))) return "deny";
  if (req.path === "/remote-login") return req.method === "POST" ? "login-submit" : "login-page";
  if (req.hasSession) return "allow";
  return req.path.startsWith("/api/") ? "need-login" : "login-page";
}

export function cookieValue(header: string | undefined | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ---------------------------------------------------------------- the tunnel

export interface RemoteStatus {
  active: boolean;
  url: string | null;
  startedAt: number | null;
  sessions: number;
  /** Only ever sent to local requests. */
  code?: string | null;
  lastStop?: { at: number; reason: string } | null;
}

export class RemoteAccess {
  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private code: string | null = null;
  private startedAt: number | null = null;
  private sessions = new Map<string, number>(); // id → expiry
  private failures = 0;
  private lastStop: { at: number; reason: string } | null = null;
  onChange: () => void = () => {};

  constructor(private readonly binDir: string) {}

  get active() {
    return !!this.proc && !!this.url;
  }
  get host() {
    return this.url ? new URL(this.url).host : null;
  }

  status(local: boolean): RemoteStatus {
    this.pruneSessions();
    return {
      active: this.active,
      url: this.url,
      startedAt: this.startedAt,
      sessions: this.sessions.size,
      ...(local ? { code: this.code } : {}),
      lastStop: this.lastStop,
    };
  }

  /** Opens the tunnel to http://127.0.0.1:<port>. Resolves once Cloudflare gave a URL. */
  async start(port: number): Promise<RemoteStatus> {
    if (this.active) return this.status(true);
    const bin = await this.cloudflared();
    const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
    // A .js stand-in (SYMBIO_CLOUDFLARED_BIN) runs with Node: used to test without opening a real tunnel.
    const [cmd, argv] = /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
    const proc = spawn(cmd, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Cloudflare didn't open a tunnel within 60 seconds.")), 60_000);
      const onData = (buf: Buffer) => {
        const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", onData);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (code ${code}) before opening the tunnel.`));
      });
    }).catch((err) => {
      this.kill();
      throw err;
    });
    this.url = url;
    this.code = newAccessCode();
    this.startedAt = Date.now();
    this.failures = 0;
    this.sessions.clear();
    proc.once("exit", () => {
      if (this.proc === proc) this.reset("the tunnel closed");
    });
    console.log(`[remote] on: ${url}`);
    this.onChange();
    return this.status(true);
  }

  stop(reason: string) {
    if (!this.proc && !this.url) return;
    this.kill();
    this.reset(reason);
  }

  private kill() {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) proc.kill();
  }

  private reset(reason: string) {
    this.proc = null;
    this.url = null;
    this.code = null;
    this.startedAt = null;
    this.sessions.clear();
    this.lastStop = { at: Date.now(), reason };
    console.log(`[remote] off: ${reason}`);
    this.onChange();
  }

  hasSession(cookieHeader: string | undefined | null): boolean {
    const id = cookieValue(cookieHeader, SESSION_COOKIE);
    const expiry = id ? this.sessions.get(id) : undefined;
    return !!expiry && expiry > Date.now();
  }

  /** Checks an access code. Too many wrong ones shut the tunnel down. */
  async login(given: string): Promise<{ ok: true; session: string; maxAge: number } | { ok: false; left: number }> {
    if (this.code && codesMatch(this.code, given)) {
      const session = randomBytes(32).toString("base64url");
      this.sessions.set(session, Date.now() + SESSION_MS);
      console.log("[remote] a remote session started");
      this.onChange();
      return { ok: true, session, maxAge: SESSION_MS / 1000 };
    }
    this.failures++;
    console.warn(`[remote] wrong access code (${this.failures}/${MAX_FAILURES})`);
    if (this.failures >= MAX_FAILURES) this.stop(`${MAX_FAILURES} wrong access codes; turned off for safety`);
    await new Promise((r) => setTimeout(r, 1500)); // slows guessing down
    return { ok: false, left: Math.max(0, MAX_FAILURES - this.failures) };
  }

  private pruneSessions() {
    const now = Date.now();
    for (const [id, exp] of this.sessions) if (exp <= now) this.sessions.delete(id);
  }

  /** cloudflared from SYMBIO_CLOUDFLARED_BIN, the PATH, or downloaded once into ~/.symbio/bin. */
  private async cloudflared(): Promise<string> {
    if (process.env.SYMBIO_CLOUDFLARED_BIN) return process.env.SYMBIO_CLOUDFLARED_BIN;
    const onPath = spawnSync("cloudflared", ["--version"], { windowsHide: true, encoding: "utf8" });
    if (onPath.status === 0) return "cloudflared";
    const exe = path.join(this.binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    if (existsSync(exe)) return exe;
    await downloadCloudflared(exe);
    return exe;
  }
}

/** Downloads cloudflared from Cloudflare's official GitHub releases. */
async function downloadCloudflared(dest: string) {
  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  const asset =
    process.platform === "win32"
      ? `cloudflared-windows-${arch}.exe`
      : process.platform === "darwin"
        ? `cloudflared-darwin-${arch}.tgz`
        : `cloudflared-linux-${arch}`;
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  console.log(`[remote] downloading cloudflared (${asset})…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download cloudflared (${res.status}). Install it yourself: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  if (asset.endsWith(".tgz")) {
    const r = spawnSync("tar", ["-xzf", tmp, "-C", path.dirname(dest)]);
    await fs.rm(tmp, { force: true });
    if (r.status !== 0) throw new Error("Couldn't unpack cloudflared.");
  } else {
    await fs.rename(tmp, dest);
  }
  if (process.platform !== "win32") chmodSync(dest, 0o755);
}

/** The page remote visitors see first: enter the access code. Self-contained (no assets). */
export function loginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Symbio — remote access</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0b0c0e; color: #e8e9ec; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { width: min(360px, calc(100vw - 32px)); padding: 28px 24px; border: 1px solid #23252b; border-radius: 12px; background: #111215; }
  h1 { margin: 0 0 6px; font-size: 18px; display: flex; align-items: center; gap: 8px; }
  p { margin: 0 0 18px; color: #9a9ca4; }
  input { box-sizing: border-box; width: 100%; height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #2c2f36; background: #0b0c0e; color: #e8e9ec; font: 600 20px/1 ui-monospace, monospace; letter-spacing: 0.25em; text-transform: uppercase; text-align: center; }
  input:focus { outline: none; border-color: #6d6af5; box-shadow: 0 0 0 3px rgba(109,106,245,.25); }
  button { margin-top: 12px; width: 100%; height: 40px; border: 0; border-radius: 8px; background: #6d6af5; color: white; font: 600 14px system-ui, sans-serif; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .error { margin-top: 12px; color: #f0726a; min-height: 1.5em; }
</style>
</head>
<body>
<form class="card" id="f">
  <h1><svg width="22" height="22" viewBox="0 0 24 24"><circle cx="9" cy="12" r="6.5" fill="none" stroke="#6d6af5" stroke-width="2.2"/><circle cx="15" cy="12" r="6.5" fill="none" stroke="#3fb27f" stroke-width="2.2"/></svg>Symbio</h1>
  <p>Enter the access code shown on the computer running Symbio.</p>
  <input id="code" name="code" autocomplete="one-time-code" maxlength="12" autofocus required />
  <button id="go">Open Symbio</button>
  <div class="error" id="err"></div>
</form>
<script>
  const f = document.getElementById("f"), go = document.getElementById("go"), err = document.getElementById("err");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    go.disabled = true; err.textContent = "";
    try {
      const res = await fetch("/remote-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.getElementById("code").value }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) { localStorage.setItem("symbio:token", data.token); location.href = "/"; return; }
      err.textContent = data.error || "That didn't work.";
    } catch { err.textContent = "Couldn't reach Symbio."; }
    go.disabled = false;
  });
</script>
</body>
</html>`;
}
