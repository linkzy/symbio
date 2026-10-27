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
import { OpencodeRuntime } from "./opencode/runtime.js";
import { Store, globalDir } from "./store.js";
import { Team } from "./team.js";

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
  const app = new Hono();
  app.use("*", async (c, next) => {
    const ok = isAllowedRequest({ method: c.req.method, host: c.req.header("host"), origin: c.req.header("origin") }, PORT);
    if (!ok) return c.json({ error: "Requests must come from Symbio's own page on this computer." }, 403);
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

  const shutdown = async () => {
    team.shuttingDown = true;
    team.stopWatchdog();
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function openBrowser(url: string) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
