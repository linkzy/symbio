#!/usr/bin/env node
// symbio / sym — start, stop and inspect the local Symbio server.
//
//   sym            start in the background (or just open it, if it's running) and open the browser
//   sym stop       stop it (agents are left as they are and pick up on the next start)
//   sym status     is it running? where? which version?
//   sym open       open it in the browser
//   sym logs       the last lines of its log
//   sym doctor     check that everything Symbio needs is in place
//   sym run        run in the foreground (for debugging)
//   sym remote     open a temporary link to use Symbio from another device (sym remote off to close it)

import { execFileSync, exec, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const PORT = Number(process.env.SYMBIO_PORT ?? 4310);
const HOME = process.env.SYMBIO_HOME ?? path.join(os.homedir(), ".symbio");
const LOG = path.join(HOME, "logs", "symbio.log");
const BASE = `http://127.0.0.1:${PORT}`;
const server = path.join(root, "dist", "server", "index.js");

const token = () => {
  try {
    return readFileSync(path.join(HOME, "ui-token"), "utf8").trim();
  } catch {
    return "";
  }
};
const link = () => `${BASE}/?token=${token()}`;

async function api(method, p) {
  const res = await fetch(BASE + p, { method, headers: { "x-symbio-token": token() }, signal: AbortSignal.timeout(3000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** "running" (ours), "other" (something else on the port) or "stopped". */
async function state() {
  try {
    const r = await api("GET", "/api/runtime");
    if (r.status === 200 || (r.status === 401 && r.body?.code === "locked")) return "running";
    return "other";
  } catch {
    return "stopped";
  }
}

function openBrowser(url) {
  if (process.env.SYMBIO_NO_OPEN === "1") return;
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  const s = await state();
  if (s === "running") {
    console.log(`Symbio is running: ${link()}`);
    openBrowser(link());
    return;
  }
  if (s === "other") {
    console.error(`Port ${PORT} is used by another program. Start Symbio on another port: SYMBIO_PORT=4320 sym`);
    process.exit(1);
  }
  if (!existsSync(server)) {
    console.error(`Symbio isn't built (${server} is missing). Run "npm run build" in ${root}.`);
    process.exit(1);
  }
  mkdirSync(path.dirname(LOG), { recursive: true });
  const out = openSync(LOG, "a");
  // Detached, so closing this terminal doesn't stop Symbio (or the agents' work).
  const child = spawn(process.execPath, [server], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: { ...process.env, SYMBIO_NO_OPEN: "1" },
  });
  child.unref();
  process.stdout.write("Starting Symbio");
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if ((await state()) === "running") {
      console.log(`\nSymbio is running: ${link()}\nStop it with "sym stop". Log: ${LOG}`);
      openBrowser(link());
      return;
    }
    process.stdout.write(".");
  }
  console.error(`\nSymbio didn't come up within a minute. See the log: ${LOG}`);
  process.exit(1);
}

async function stop() {
  if ((await state()) !== "running") return console.log("Symbio isn't running.");
  await api("POST", "/api/shutdown").catch(() => {});
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if ((await state()) === "stopped") return console.log("Symbio stopped. Agents that were working continue on the next start.");
  }
  console.error("Symbio didn't stop within 15 seconds.");
  process.exit(1);
}

async function status() {
  const s = await state();
  console.log(`Symbio ${pkg.version} — ${s === "running" ? `running at ${BASE}` : s === "other" ? `port ${PORT} is used by another program` : "not running"}`);
  if (s !== "running") return;
  const runtime = (await api("GET", "/api/runtime")).body;
  const projects = (await api("GET", "/api/projects")).body ?? [];
  console.log(`OpenCode ${runtime?.version ?? "?"} (${runtime?.state ?? "?"}${runtime?.memoryMB ? `, ${runtime.memoryMB} MB` : ""})`);
  const remote = (await api("GET", "/api/remote")).body;
  if (remote?.active) console.log(`Remote access ON: ${remote.url} (${remote.sessions} session(s)) — sym remote off`);
  for (const p of projects) {
    const working = p.agents.filter((a) => a.status === "busy").length;
    console.log(`- ${p.name}: ${p.agents.filter((a) => a.status !== "stopped").length} agents${working ? `, ${working} working` : ""}${p.paused ? " (paused)" : ""}`);
  }
}

async function remoteOn() {
  if ((await state()) !== "running") {
    process.env.SYMBIO_NO_OPEN = "1";
    await start();
  }
  console.log("Opening a temporary link (the first time, cloudflared is downloaded)…");
  const res = await fetch(BASE + "/api/remote/start", { method: "POST", headers: { "x-symbio-token": token() }, signal: AbortSignal.timeout(180_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Couldn't open remote access: ${body.error ?? res.status}`);
    process.exit(1);
  }
  const code = body.code ? `${body.code.slice(0, 4)}-${body.code.slice(4)}` : "?";
  console.log(`
Remote access is on.

  Link: ${body.url}
  Code: ${code}

Whoever has both controls your agents, which run commands on this computer.
Turn it off with "sym remote off" (or the button in Symbio). After 10 wrong codes it turns off by itself.`);
}

async function remoteOff() {
  if ((await state()) !== "running") return console.log("Symbio isn't running.");
  await api("POST", "/api/remote/stop");
  console.log("Remote access is off.");
}

function logs() {
  if (!existsSync(LOG)) return console.log(`No log yet (${LOG}).`);
  const lines = readFileSync(LOG, "utf8").split(/\r?\n/);
  console.log(lines.slice(-60).join("\n").replace(/token=[\w-]+/g, "token=…"));
  console.log(`\n(${LOG})`);
}

async function doctor() {
  let ok = true;
  const check = (pass, label, fix) => {
    console.log(`${pass ? "✔" : "✘"} ${label}${!pass && fix ? `\n    → ${fix}` : ""}`);
    if (!pass) ok = false;
  };
  const [major] = process.versions.node.split(".").map(Number);
  check(major >= 22, `Node.js ${process.versions.node}`, "Symbio needs Node.js 22 or newer: https://nodejs.org");
  let gitVersion = "";
  try {
    gitVersion = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch {}
  check(!!gitVersion, gitVersion || "git", "Install git (https://git-scm.com) so helpers can work in parallel without conflicts.");
  let oc = "";
  try {
    const { resolveOpencode } = await import(pathToFileURL(path.join(root, "dist", "server", "opencode", "runtime.js")).href);
    const { command, args, shell } = resolveOpencode();
    oc = `${execFileSync(command, [...args, "--version"], { encoding: "utf8", shell, timeout: 20_000 }).trim()} (${command})`;
  } catch {}
  check(!!oc, oc ? `OpenCode ${oc}` : "OpenCode", "Reinstall Symbio (npm i -g symbio): it brings its own OpenCode.");
  const s = await state();
  check(s !== "other", s === "running" ? `Symbio running at ${BASE}` : s === "stopped" ? `Port ${PORT} free` : `Port ${PORT}`, `Another program uses port ${PORT}; use SYMBIO_PORT.`);
  if (s === "running") {
    const providers = (await api("GET", "/api/providers").catch(() => ({ body: null }))).body;
    const n = providers?.connected?.length ?? 0;
    check(n > 0, `${n} model provider(s) connected`, "Open Symbio → Settings → Model providers and connect one.");
  }
  console.log(ok ? "\nAll good." : "\nFix the items marked ✘.");
  if (!ok) process.exitCode = 1;
}

function help() {
  console.log(`Symbio ${pkg.version} — run a team of AI agents on your project, from your browser.

Usage: sym [command]

  (none), start   start Symbio in the background and open it in the browser
  stop            stop Symbio
  status          show whether it's running, and its projects
  open            open Symbio in the browser
  logs            show the last lines of the log
  doctor          check that everything Symbio needs is in place
  run             run in the foreground (logs in this terminal)
  remote          open a temporary link + access code to use Symbio from another device
  remote off      close that link
  --version       print the version

Environment: SYMBIO_PORT (default 4310), SYMBIO_HOME (default ~/.symbio), SYMBIO_NO_OPEN=1.`);
}

const cmd = process.argv[2] ?? "start";
switch (cmd) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "status":
    await status();
    break;
  case "open":
    if ((await state()) === "running") {
      console.log(link());
      openBrowser(link());
    } else console.log('Symbio isn\'t running. Start it with "sym".');
    break;
  case "remote":
  case "--remote":
    if (process.argv[3] === "off") await remoteOff();
    else await remoteOn();
    break;
  case "logs":
    logs();
    break;
  case "doctor":
    await doctor();
    break;
  case "run":
    await import(pathToFileURL(server).href);
    break;
  case "-v":
  case "--version":
  case "version":
    console.log(pkg.version);
    break;
  case "-h":
  case "--help":
  case "help":
    help();
    break;
  default:
    console.error(`Unknown command "${cmd}".\n`);
    help();
    process.exit(1);
}
