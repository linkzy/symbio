import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { promises as fs, existsSync } from "node:fs";
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
import { Store, globalDir } from "./store.js";
import { Team } from "./team.js";
import { removeOrphanWorkspaces } from "./workspaces.js";

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
  const team = new Team(store, runtime, `http://127.0.0.1:${PORT}`);
  team.remote = new RemoteOps(connections, {
    log: (project, m) => team.log(project, m),
    notify: (project, agent, text) => team.notify(project, agent, text),
  });
  // Agents that were working when Symbio last went down (crash, killed, machine off)
  // are told to continue once OpenCode is up again.
  team.markInterrupted("Symbio was stopped and has been restarted");

  const uiToken = loadUiToken(globalDir);
  const remote = new RemoteAccess(path.join(globalDir, "bin"));
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
  app.route("/api", createApi(store, runtime, team, connections));
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

  console.log("Starting OpenCode…");
  runtime
    .start()
    .then(() => console.log(`OpenCode ${runtime.version} ready`))
    .catch((err) => console.error("OpenCode failed to start:", err.message));
  team.startWatchdog();

  shutdown = async () => {
    remote.stop("Symbio stopped");
    team.shuttingDown = true;
    team.stopWatchdog();
    await runtime.stop();
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
