import { serve } from "@hono/node-server";
import { MachineMonitor } from "./machine.js";
import { stopRunningChecks } from "./checks.js";
import { Hono } from "hono";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { createApi } from "./api.js";
import { Connections } from "./connections.js";
import { RemoteOps } from "./remote.js";
import { handleMcp } from "./mcp.js";
import { isAllowedRequest } from "./origin.js";
import { loadUiToken, tokenMatches } from "./ui-token.js";
import { isTunnelRequest, loginPage, RemoteAccess, remoteDecision, SESSION_COOKIE } from "./remote-access.js";
import { bus } from "./bus.js";
import { OpencodeRuntime } from "./opencode/runtime.js";
import { CopilotRuntime } from "./copilot/runtime.js";
import { runtimeOf, type RuntimeKind } from "./runtime/types.js";
import { isInstalled, RUNTIME_PACKAGES, RuntimeInstaller } from "./runtime/install.js";
import { Store, globalDir } from "./store.js";
import { Team } from "./team.js";
import { removeOrphanWorkspaces } from "./workspaces.js";
import { packageRoot, QUIET_MS, SelfUpdate, type UpdateMode } from "./self-update.js";
import { labeledBackup } from "./housekeeping.js";
import { CHANNELS, Notifications, type Channel } from "./notifications.js";
import { Notifier } from "./notifier.js";

// Background work (timers, event handlers) must never take the whole app down: an error there
// (e.g. OpenCode restarting mid-call) is logged and the next tick tries again.
process.on("unhandledRejection", (err) => console.error("[unhandled]", err instanceof Error ? err.stack ?? err.message : err));

const PORT = Number(process.env.SYMBIO_PORT ?? 4310);
const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server/index.js → dist/web ; src/server/index.ts → dist/web (after a build)
const webRoot = [path.resolve(here, "../web"), path.resolve(here, "../../dist/web")].find((p) =>
  existsSync(path.join(p, "index.html")),
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** True when a Symbio is already answering on our port (its API asks for the UI key). */
async function alreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/runtime`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    return res.status === 401 && body?.code === "locked";
  } catch {
    return false;
  }
}

async function main() {
  // Starting Symbio twice must not disturb the running one (or its OpenCode server);
  // just open its page.
  if (await alreadyRunning()) {
    const url = `http://127.0.0.1:${PORT}/?token=${loadUiToken(globalDir)}`;
    console.log(`Symbio is already running: ${url}`);
    if (process.env.SYMBIO_NO_OPEN !== "1") openBrowser(url);
    return;
  }

  const store = new Store();
  await store.load();
  // Folders of removed projects that couldn't be deleted at the time (e.g. a file was open).
  const orphans = await removeOrphanWorkspaces(new Set(store.list().map((p) => p.id)));
  if (orphans.length) console.log(`Removed ${orphans.length} leftover helper folder(s) of removed projects`);

  const connections = new Connections();
  await connections.load();

  const runtime = new OpencodeRuntime(path.join(globalDir, "opencode.pid"));
  // GitHub Copilot CLI: its sessions in Symbio's own Copilot folder; started when a project uses it.
  const copilot = new CopilotRuntime(path.join(globalDir, "copilot"));
  const team = new Team(store, [runtime, copilot], `http://127.0.0.1:${PORT}`);
  // The computer's load: agents' programs, the load guard (machine.ts).
  const machine = new MachineMonitor(
    globalDir,
    () => [runtime, copilot].filter((r) => r.state === "running" && r.pid).map((r) => ({ pid: r.pid!, label: r.label })),
    () => store.list().some((p) => p.agents.some((a) => a.status === "busy")),
  );
  await machine.load();
  team.attachMachine(machine);
const installer = new RuntimeInstaller();
  team.remote = new RemoteOps(connections, {
    log: (project, m) => team.log(project, m),
    notify: (project, agent, text) => team.notify(project, agent, text),
    save: (project) => store.update(project),
  });
  // Notifications: what's worth telling the human (notifier.ts), and where it goes (notifications.ts).
  const notifications = new Notifications(globalDir, connections.vault);
  await notifications.load();
  const notifier = new Notifier(
    {
      project: (id) => store.get(id),
      projects: () => store.list(),
      plan: async (project) => (await team.plan(project)).plan,
      question: async (project, id) => (await team.questions.store(project)).questions.find((q) => q.id === id),
    },
    (n) => notifications.send(n),
    () => notifications.current.detail,
  );
  await notifier.start();
  // Agents that were working when Symbio last went down (crash, killed, machine off)
  // are told to continue once OpenCode is up again.
  team.markInterrupted("Symbio was stopped and has been restarted");

  const uiToken = loadUiToken(globalDir);
  const remote = new RemoteAccess(path.join(globalDir, "bin"));

  // Updates: checked now and then; applied when allowed and the team is idle (see self-update.ts).
  const version: string = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  const updates: SelfUpdate = new SelfUpdate({
    version,
    home: globalDir,
    port: PORT,
    busy: () => team.busyReason(QUIET_MS),
    remoteActive: () => remote.active,
    backup: async () => {
      await labeledBackup(store.list(), `before-${updates.state().latest ?? "update"}`);
    },
    announce: (text) => team.announce(text),
    shutdown: async () => {
      await shutdown?.();
    },
  });
  await updates.load();
  remote.onChange = () => bus.publish({ type: "remote.updated" });
  const remoteRequests = new WeakSet<Request>(); // requests that came through the tunnel
  const app = new Hono();
  app.use("*", async (c, next) => {
    const viaTunnel = isTunnelRequest(
      { host: c.req.header("host"), cfRay: c.req.header("cf-ray"), cfIp: c.req.header("cf-connecting-ip") },
      remote.host,
    );
    if (!viaTunnel) {
      const ok = isAllowedRequest({ method: c.req.method, host: c.req.header("host"), origin: c.req.header("origin") }, PORT);
      if (!ok) return c.json({ error: "Requests must come from Symbio's own page on this computer." }, 403);
      return next();
    }
    // Through the tunnel: only Symbio's own remote page may change things.
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && origin && origin !== `https://${remote.host}`) {
      return c.json({ error: "Not allowed." }, 403);
    }
    const decision = remoteDecision({ method: c.req.method, path: c.req.path, hasSession: remote.hasSession(c.req.header("cookie")), active: remote.active });
    if (decision === "deny") return c.text("Not available through remote access.", 403);
    if (decision === "login-page") return c.html(loginPage());
    if (decision === "need-login") return c.json({ error: "Log in with the access code.", code: "remote-login" }, 401);
    if (decision === "login-submit") {
      const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
      const result = await remote.login(String(body.code ?? ""));
      if (result.ok) {
        c.header("Set-Cookie", `${SESSION_COOKIE}=${result.session}; Path=/; Max-Age=${result.maxAge}; HttpOnly; Secure; SameSite=Strict`);
        return c.json({ token: uiToken });
      }
      if (!remote.active) return c.json({ error: "Too many wrong codes: remote access was turned off." }, 423);
      return c.json({ error: `Wrong code. ${result.left} attempt${result.left === 1 ? "" : "s"} left.` }, 401);
    }
    remoteRequests.add(c.req.raw);
    await next();
  });
  // The UI's key: a header, or a query parameter for the event stream (EventSource can't set headers).
  app.use("/api/*", async (c, next) => {
    const given = c.req.header("x-symbio-token") ?? (c.req.method === "GET" ? c.req.query("token") : undefined);
    if (!tokenMatches(uiToken, given)) {
      return c.json({ error: "Open Symbio from the link it printed when it started (or run it again).", code: "locked" }, 401);
    }
    await next();
  });
  // `sym stop`: a clean shutdown (agents are left as they are and resumed on the next start).
  let shutdown: (() => Promise<void>) | null = null;
  app.post("/api/shutdown", (c) => {
    setTimeout(() => void shutdown?.(), 200);
    return c.json({ ok: true });
  });
  // Updates: state and settings for the UI; applying stops Symbio (never through remote access).
  app.get("/api/update", (c) => c.json(updates.state()));
  app.post("/api/update/check", async (c) => c.json(await updates.check()));
  app.put("/api/update/settings", async (c) => {
    const { mode, installId } = await c.req.json<{ mode?: UpdateMode; installId?: boolean }>();
    if (mode === undefined && typeof installId !== "boolean") return c.json({ error: "mode (auto, notify or off) or installId (true/false) is required" }, 400);
    if (mode !== undefined && mode !== "auto" && mode !== "notify" && mode !== "off") return c.json({ error: "mode must be auto, notify or off" }, 400);
    if (mode) await updates.setMode(mode);
    if (typeof installId === "boolean") await updates.setInstallId(installId);
    return c.json(updates.state());
  });
  app.post("/api/update/apply", async (c) => {
    // version: a specific one (`sym update --to 0.9.0`), usually going back; otherwise the latest.
    const { force, version } = await c.req.json<{ force?: boolean; version?: string }>().catch(() => ({ force: false, version: undefined }));
    try {
      return c.json({ message: await updates.apply(force !== false, typeof version === "string" && version.trim() ? version.trim() : undefined) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  // Notifications: settings (secrets only as set / not set), a test per channel, Telegram's chat.
  app.get("/api/notifications", async (c) => c.json(await notifications.view()));
  app.put("/api/notifications", async (c) => {
    try {
      return c.json(await notifications.update(await c.req.json()));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.post("/api/notifications/test/:channel", async (c) => {
    const channel = c.req.param("channel") as Channel;
    if (!CHANNELS.includes(channel)) return c.json({ error: "Unknown channel" }, 404);
    try {
      await notifications.test(channel);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.post("/api/notifications/telegram/chat", async (c) => {
    try {
      return c.json(await notifications.findTelegramChat());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  // Remote access: status for everyone (the code only locally), start locally, stop from anywhere.
  app.get("/api/remote", (c) => c.json(remote.status(!remoteRequests.has(c.req.raw))));
  app.post("/api/remote/start", async (c) => {
    try {
      return c.json(await remote.start(PORT));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
  app.post("/api/remote/stop", (c) => {
    remote.stop(remoteRequests.has(c.req.raw) ? "turned off from a remote session" : "turned off on this computer");
    return c.json(remote.status(!remoteRequests.has(c.req.raw)));
  });
  app.route("/api", createApi(store, runtime, team, connections, installer));
  // Agents' tool server. Only reachable from this machine (we bind to 127.0.0.1) and only with a per-run token.
  app.all("/mcp/:token", (c) => handleMcp(c, team.mcpResolver));

  if (webRoot) {
    app.get("*", async (c) => {
      const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
      let file = path.resolve(webRoot, rel || "index.html");
      if (!file.startsWith(webRoot + path.sep) || !existsSync(file) || (await fs.stat(file)).isDirectory()) {
        file = path.join(webRoot, "index.html"); // SPA fallback
      }
      const body = await fs.readFile(file);
      return c.body(body, 200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    });
  }

  serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
    // The link carries the UI key; once opened, the browser remembers it.
    const url = `http://127.0.0.1:${PORT}/?token=${uiToken}`;
    console.log(`Symbio running at ${url}${webRoot ? "" : " (API only — run the web dev server or build the UI)"}`);
    if (webRoot && process.env.SYMBIO_NO_OPEN !== "1") openBrowser(url);
  });

  // Each runtime starts when something needs it (a project's agents, New project, Settings), and at
  // launch only when agents that were left active run on it. Symbio ships no runtime: the human
  // installs the ones they use (Settings → Runtimes). One that projects use but that isn't installed
  // (Symbio used to ship OpenCode) is installed now, so those projects keep working.
  const projects = store.list();
  // Stopped agents don't count: after a project switched runtimes, they move when restarted.
  const usedBy = (kind: RuntimeKind) =>
    projects.filter((p) => (p.runtime ?? "opencode") === kind || p.agents.some((a) => runtimeOf(a) === kind && a.status !== "stopped"));
  const active = (kind: RuntimeKind) => projects.some((p) => p.agents.some((a) => runtimeOf(a) === kind && a.status !== "stopped"));
  for (const r of [runtime, copilot]) {
    const label = RUNTIME_PACKAGES[r.kind].label;
    const start = () => {
      console.log(`Starting ${label}…`);
      return r
        .start()
        .then(() => console.log(`${label} ${r.version} ready`))
        .catch((err) => console.error(`${label} failed to start:`, err.message));
    };
    if (!isInstalled(r.kind)) {
      if (!usedBy(r.kind).length) continue;
      console.log(`${label} isn't installed, and projects use it: installing it (Settings → Agent runtimes shows how it goes)…`);
      installer
        .install(r.kind)
        .then(() => (active(r.kind) ? start() : undefined))
        .catch((err) => console.error(`${label} couldn't be installed:`, err.message));
    } else if (active(r.kind)) void start();
  }
  team.startWatchdog();
  machine.start();
  updates.start();

  shutdown = async () => {
    remote.stop("Symbio stopped");
    team.shuttingDown = true;
    team.stopWatchdog();
    notifier.stop();
    machine.stop();
    updates.stop();
    stopRunningChecks();
    await Promise.all([runtime.stop(), copilot.stop()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown?.());
  process.on("SIGTERM", () => void shutdown?.());
}

function openBrowser(url: string) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
