#!/usr/bin/env node
// The first-hour benchmark: a fresh Symbio (its own temporary home and port), OpenCode installed as a
// new user would, a new project on OpenCode's free models (no account needed), and the same request
// every time: a two-page pocket guide to Porto. Prints how long it took, the tokens, and what the
// human was asked. Run it before and after changing how core works (briefs, defaults), to see the
// cost of process. See docs/development.md (Benchmark).
//
//   npm run build; node scripts/benchmark.mjs                 # light (new projects' default)
//   node scripts/benchmark.mjs --depth thorough               # the thorough way, to compare
//   node scripts/benchmark.mjs --keep                         # leave it running to look at it
//
// It uses real free models: runs vary with the model's mood and the service's load, so compare a
// few runs, not one. Nothing is billed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const depth = args.includes("--depth") ? args[args.indexOf("--depth") + 1] : "light";
const keep = args.includes("--keep");
const REQUEST =
  "I want a short pocket guide to Porto for a first weekend there, in Markdown: where to stay, five things to see, " +
  "what to eat, and getting around. Keep it to about two pages.";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(os.tmpdir(), "symbio-bench-"));
const env = {
  ...process.env,
  SYMBIO_HOME: path.join(root, "home"),
  SYMBIO_PORT: process.env.SYMBIO_PORT ?? "4398",
  SYMBIO_NO_OPEN: "1",
  SYMBIO_UPDATE_URL: "off",
  SYMBIO_KEYRING_SERVICE: "symbio-benchmark",
  SYMBIO_NO_DEV_RUNTIMES: "1", // install OpenCode as a new user does, not the checkout's copy
};
const sym = (...a) => execFileSync(process.execPath, [path.join(repo, "bin", "symbio.js"), ...a], { env, stdio: "pipe" }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (t) => Math.round((Date.now() - t) / 1000);

sym();
const tokenFile = path.join(env.SYMBIO_HOME, "ui-token");
while (!existsSync(tokenFile)) await sleep(200);
const token = readFileSync(tokenFile, "utf8").trim();
const base = `http://127.0.0.1:${env.SYMBIO_PORT}/api`;
const call = async (method, route, body) => {
  const r = await fetch(base + route, { method, headers: { "x-symbio-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${route} → ${r.status}: ${JSON.stringify(d)}`);
  return d;
};

try {
  let t = Date.now();
  await call("POST", "/runtimes/opencode/install");
  while ((await call("GET", "/runtimes")).find((r) => r.kind === "opencode").installing) await sleep(2000);
  console.log(`OpenCode installed in ${secs(t)}s`);

  // As the New project dialog does: the free models, core on the first.
  const free = (await call("GET", "/models?runtime=opencode")).filter((m) => m.free && m.ref.startsWith("opencode/")).map((m) => m.ref);
  if (!free.length) throw new Error("OpenCode lists no free models right now.");
  const folder = path.join(root, "porto");
  const project = await call("POST", "/projects", { name: "porto", directory: folder, allowedModels: free, coordinatorModel: free[0], runtime: "opencode", initGit: true, depth });
  const { coordinator } = await call("POST", `/projects/${project.id}/start`);
  const quiet = async () => {
    for (;;) {
      const p = await call("GET", `/projects/${project.id}`);
      if (p.agents.every((a) => a.status !== "busy")) return p;
      await sleep(3000);
    }
  };
  await quiet();
  console.log(`${depth} project, core on ${free[0]}`);

  t = Date.now();
  await call("POST", `/projects/${project.id}/agents/${coordinator.id}/messages`, { text: REQUEST });
  let offered = null;
  for (;;) {
    await sleep(3000);
    const p = await call("GET", `/projects/${project.id}`);
    if (p.startOffer && offered === null) {
      offered = secs(t);
      console.log(`\nOffer after ${offered}s:\n${p.startOffer.summary}\n`);
      await call("POST", `/projects/${project.id}/start-offer`, { choice: "go" });
    }
    const tasks = (await call("GET", `/projects/${project.id}/plan`).catch(() => null))?.tasks ?? [];
    const busy = p.agents.some((a) => a.status === "busy");
    if (!busy && tasks.length && tasks.every((x) => x.status === "done")) break;
    // Thorough: core may wait for answers (briefing questions decided for the human count as asked).
    if (!busy && !p.startOffer && secs(t) > 120 && !tasks.some((x) => x.status !== "done")) break;
    if (secs(t) > 60 * 60) {
      console.log("Stopped after an hour.");
      break;
    }
  }
  const took = secs(t);
  const usage = await call("GET", `/projects/${project.id}/usage`);
  const tokens = usage.agents.reduce((n, a) => n + a.tokens, 0);
  const fresh = usage.agents.reduce((n, a) => n + a.byModel.reduce((m, b) => m + b.usage.input + b.usage.output + b.usage.reasoning, 0), 0);
  const questions = (await call("GET", `/projects/${project.id}/questions`).catch(() => [])) ?? [];
  const files = execFileSync("git", ["-C", folder, "ls-files"], { stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
  console.log(`Done in ${took}s (${(took / 60).toFixed(1)} min) · agents: ${usage.agents.map((a) => a.name).join(", ")}`);
  console.log(`Tokens: ${tokens.toLocaleString("en")} (${fresh.toLocaleString("en")} not from cache)`);
  console.log(`Questions and decisions for the human: ${Array.isArray(questions) ? questions.length : "?"}`);
  console.log(`Files in the project: ${files.join(", ")}`);
  if (keep) console.log(`\nStill running: http://127.0.0.1:${env.SYMBIO_PORT}/?token=${token}  (stop: SYMBIO_HOME=${env.SYMBIO_HOME} sym stop)`);
} finally {
  if (!keep) {
    try {
      sym("stop");
    } catch {}
    await sleep(2000);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
