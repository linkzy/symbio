#!/usr/bin/env node
// Installs a Symbio update while Symbio is stopped, then starts it again. Runs as its own process,
// from a copy outside the package folder (which npm replaces): Symbio hands over and exits, or
// `sym update` runs it when Symbio isn't running. It can't install in place: on Windows, OpenCode
// and the native modules keep their files locked while they run.
//
// Usage: node update-runner.mjs <job.json>
//   job: { waitPid?, prefix, spec, from, to, root, home, port, start, resultFile, logFile }

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
mkdirSync(path.dirname(job.logFile), { recursive: true });
const log = (line) => appendFileSync(job.logFile, `${new Date().toISOString()} ${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0); // signal 0: only checks the process exists
    return true;
  } catch {
    return false;
  }
};

/** npm install -g <spec> into the prefix Symbio was installed in. */
function install(spec) {
  log(`npm install -g ${spec} (prefix ${job.prefix})`);
  const res = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "-g", spec, "--no-fund", "--no-audit"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 10 * 60_000,
    env: { ...process.env, npm_config_prefix: job.prefix },
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (output) log(output.split("\n").slice(-30).join("\n"));
  return { ok: res.status === 0, output: res.error ? res.error.message : output };
}

/** The installed package is the old version and can start. */
function intact() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(job.root, "package.json"), "utf8"));
    return pkg.version === job.from && existsSync(path.join(job.root, "bin", "symbio.js")) && existsSync(path.join(job.root, "dist", "server", "index.js"));
  } catch {
    return false;
  }
}

const result = { from: job.from, to: job.to, ok: false, error: null, finishedAt: 0, seen: false };
try {
  log(`Updating Symbio ${job.from} → ${job.to}`);
  if (job.waitPid) {
    for (let i = 0; i < 180 && alive(job.waitPid); i++) await sleep(500);
    if (alive(job.waitPid)) throw new Error("Symbio didn't stop within 90 seconds; nothing was changed.");
  }
  const done = install(job.spec);
  if (done.ok) {
    result.ok = true;
    log("Installed.");
  } else {
    result.error = `npm couldn't install ${job.to}: ${done.output.split("\n").slice(-6).join(" ").slice(0, 600)}`;
    log(result.error);
    // npm often fails before touching anything (no network, a lock); only if the old version
    // was damaged, put it back so Symbio still starts.
    if (intact()) log(`${job.from} is still in place.`);
    else {
      const back = install(`symbio@${job.from}`);
      log(back.ok ? `Reinstalled ${job.from}.` : `Couldn't reinstall ${job.from} either; run: npm install -g symbio`);
      if (!back.ok) result.error += ` Reinstalling ${job.from} failed too; run "npm install -g symbio".`;
    }
  }
} catch (err) {
  result.error = err.message;
  log(`Failed: ${err.message}`);
}
result.finishedAt = Date.now();
writeFileSync(job.resultFile, JSON.stringify(result, null, 2));

if (job.start) {
  log("Starting Symbio.");
  // `sym start` from the (possibly new) package, in the background like a normal start.
  const child = spawn(process.execPath, [path.join(job.root, "bin", "symbio.js"), "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, SYMBIO_NO_OPEN: "1", SYMBIO_HOME: job.home, SYMBIO_PORT: String(job.port) },
  });
  child.unref();
}
