// Keeping Symbio up to date: checks npm for a newer version and, when the human allows it,
// updates while the team is idle. The install itself happens in bin/update-runner.mjs, a separate
// process that waits for Symbio to exit (OpenCode and native modules lock their files while
// running on Windows), installs, puts the old version back if that fails, and starts Symbio again.

import { spawn } from "node:child_process";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type UpdateMode = "auto" | "notify" | "off";

/** How this copy of Symbio was installed, which decides whether it can update itself. */
export interface InstallInfo {
  kind: "npm" | "dev";
  root: string;
  /** npm's global prefix this package lives in (npm installs only). */
  prefix: string | null;
}

export interface UpdateResult {
  from: string;
  to: string;
  ok: boolean;
  error: string | null;
  finishedAt: number;
  seen: boolean;
}

export interface UpdateState {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: number | null;
  error: string | null;
  mode: UpdateMode;
  install: InstallInfo["kind"];
  /** What a restart would interrupt right now (an agent working…), or null. */
  busy: string | null;
  /** Why an available update isn't being applied right now, if it isn't. */
  waiting: string | null;
  /** What's new between the current and the latest version (from the changelog). */
  notes: { version: string; items: string[] }[];
  lastResult: UpdateResult | null;
}

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A global npm install lives in <prefix>/node_modules/symbio (lib/node_modules on Unix); anything else, like `npm link` to a clone, is a development copy. */
export function installInfo(root = packageRoot): InstallInfo {
  const real = (() => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();
  const nodeModules = path.dirname(real);
  if (path.basename(nodeModules) !== "node_modules" || existsSync(path.join(real, ".git"))) return { kind: "dev", root: real, prefix: null };
  const prefix = process.platform === "win32" ? path.dirname(nodeModules) : path.dirname(path.dirname(nodeModules));
  return { kind: "npm", root: real, prefix };
}

/** 1 if a > b, -1 if a < b, 0 if equal. Pre-releases ("0.3.0-beta.1") sort before their release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0) ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// Overridable for tests (a local registry and package file); never set in normal use.
const REGISTRY = (process.env.SYMBIO_UPDATE_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");

/** The version npm installs as `symbio@latest`, and the Node.js it needs. */
export async function latestRelease(): Promise<{ version: string; node: string | null }> {
  return release("latest");
}

/** A published version ("0.9.0", or a tag like "latest") and the Node.js it needs. */
export async function release(spec: string): Promise<{ version: string; node: string | null }> {
  const res = await fetch(`${REGISTRY}/symbio/${encodeURIComponent(spec.replace(/^v(?=\d)/, ""))}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json" },
  });
  if (res.status === 404) throw new Error(`There's no Symbio ${spec} on npm.`);
  if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
  const data = (await res.json()) as { version?: string; engines?: { node?: string } };
  if (!data.version) throw new Error("npm registry gave no version");
  return { version: data.version, node: data.engines?.node ?? null };
}

/**
 * After going back to an earlier version on purpose: automatic updates leave the version that was
 * left alone, and resume with the next release (which may fix what made the human go back).
 * Written to the settings file so it also works when Symbio isn't running.
 */
export async function holdBack(home: string, left: string) {
  const file = path.join(home, "updates.json");
  const settings = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"));
  settings.skip = { version: left, until: Number.MAX_SAFE_INTEGER, reason: "went-back" };
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2));
}

export async function latestVersion(): Promise<string> {
  return (await latestRelease()).version;
}

/**
 * Whether this Node.js meets a release's requirement (">=22", ">=20.9.0"; anything fancier is
 * assumed met). npm only warns about it, and the new version would then fail to start.
 */
export function nodeSatisfies(range: string | null, version = process.versions.node): boolean {
  const m = range && /^\s*>=\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(range);
  return !m || compareVersions(version, m[1].split(".").concat(["0", "0"]).slice(0, 3).join(".")) >= 0;
}

/** Changelog entries newer than `current`, from the latest version's CHANGELOG.md (best effort). */
export async function changesSince(current: string, latest: string): Promise<{ version: string; items: string[] }[]> {
  const url = process.env.SYMBIO_UPDATE_CHANGELOG ?? `https://raw.githubusercontent.com/linkzy/symbio/v${latest}/CHANGELOG.md`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return [];
  return parseChangelog(await res.text()).filter((s) => compareVersions(s.version, current) > 0);
}

export function parseChangelog(text: string): { version: string; items: string[] }[] {
  const out: { version: string; items: string[] }[] = [];
  let section: { version: string; items: string[] } | null = null;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const head = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/.exec(line);
    if (head) {
      section = { version: head[1], items: [] };
      out.push(section);
    } else if (/^## /.test(line)) section = null;
    else if (section && /^- /.test(line)) section.items.push(line.slice(2).trim());
    else if (section && /^\s+\S/.test(line) && section.items.length) section.items[section.items.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

// A tiny registry lookup. Every 6 hours was too slow: a release could wait most of a day.
const CHECK_EVERY_MS = 60 * 60_000;
const TICK_MS = 5 * 60_000;
export const QUIET_MS = 10 * 60_000; // the team must have been quiet this long before an automatic update
const FAILED_PAUSE_MS = 24 * 60 * 60_000; // after a failed update, don't retry the same version for a day

export interface SelfUpdateHost {
  version: string;
  home: string;
  port: number;
  /** Null when nothing is in progress; otherwise what's still going on (an agent working…). */
  busy(): string | null;
  /** Remote access is on (restarting would end it, with a new link). */
  remoteActive(): boolean;
  /** Takes a backup of Symbio's state before updating. */
  backup(): Promise<void>;
  /** Tells every project's human (Messages) something about the update. */
  announce(text: string): Promise<void>;
  /** Stops Symbio cleanly (agents are resumed on the next start). */
  shutdown(): Promise<void>;
}

export class SelfUpdate {
  private latest: string | null = null;
  /** The Node.js the latest version needs (its package.json "engines"). */
  private latestNode: string | null = null;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private notes: { version: string; items: string[] }[] = [];
  private mode: UpdateMode = "auto";
  /** A version automatic updates leave alone: it failed to install, or the human went back from it. */
  private skip: { version: string; until: number; reason?: "failed" | "went-back" } | null = null;
  private lastResult: UpdateResult | null = null;
  private applying = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly settingsFile: string;
  private readonly resultFile: string;
  readonly install: InstallInfo;

  constructor(private readonly host: SelfUpdateHost, install = installInfo()) {
    this.install = install;
    this.settingsFile = path.join(host.home, "updates.json");
    this.resultFile = path.join(host.home, "update-result.json");
  }

  async load() {
    const settings = JSON.parse(await fs.readFile(this.settingsFile, "utf8").catch(() => "{}"));
    if (settings.mode === "auto" || settings.mode === "notify" || settings.mode === "off") this.mode = settings.mode;
    this.skip = settings.skip ?? null;
    this.lastResult = JSON.parse(await fs.readFile(this.resultFile, "utf8").catch(() => "null"));
    // The runner wrote this before starting us again: tell the humans once.
    if (this.lastResult && !this.lastResult.seen) {
      const r = this.lastResult;
      if (r.ok) await this.host.announce(`Symbio was updated from ${r.from} to ${r.to}.`).catch(() => {});
      else {
        await this.host.announce(`Symbio couldn't update to ${r.to} and is still on ${this.host.version}: ${r.error}`).catch(() => {});
        this.skip = { version: r.to, until: Date.now() + FAILED_PAUSE_MS, reason: "failed" };
        await this.saveSettings();
      }
      r.seen = true;
      await fs.writeFile(this.resultFile, JSON.stringify(r, null, 2)).catch(() => {});
    }
  }

  start() {
    void this.check().catch(() => {});
    this.timer ??= setInterval(() => void this.tick().catch((err) => console.error("[update]", err.message)), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): UpdateState {
    const available = !!this.latest && compareVersions(this.latest, this.host.version) > 0;
    return {
      current: this.host.version,
      latest: this.latest,
      available,
      checkedAt: this.checkedAt,
      error: this.error,
      mode: this.mode,
      install: this.install.kind,
      busy: this.host.busy(),
      waiting: available ? this.blocker(false) : null,
      notes: this.notes,
      lastResult: this.lastResult,
    };
  }

  async setMode(mode: UpdateMode) {
    this.mode = mode;
    await this.saveSettings();
  }

  async check(): Promise<UpdateState> {
    if (this.mode === "off" && this.checkedAt) return this.state();
    try {
      const release = await latestRelease();
      this.latest = release.version;
      this.latestNode = release.node;
      this.error = null;
      this.notes = compareVersions(this.latest, this.host.version) > 0 ? await changesSince(this.host.version, this.latest) : [];
    } catch (err) {
      this.error = `Couldn't check for updates: ${(err as Error).message}`;
    }
    this.checkedAt = Date.now();
    return this.state();
  }

  /** Why the update can't be applied now (null = it can). `forced`: the human asked, so only hard blockers count. */
  private blocker(forced: boolean): string | null {
    if (this.install.kind === "dev") return "This Symbio runs from a development folder; update it with git pull, npm install and npm run build.";
    if (!nodeSatisfies(this.latestNode)) {
      return `Symbio ${this.latest} needs Node.js ${this.latestNode}, and this machine has ${process.versions.node}: update Node.js first (https://nodejs.org), then update Symbio.`;
    }
    if (this.applying) return "Already updating.";
    if (!forced && this.mode === "notify") return "Updates are set to notify only: update from Settings or with `sym update`.";
    if (!forced && this.mode === "off") return "Automatic updates are off: update from Settings or with `sym update`.";
    if (!forced && this.skip && this.latest === this.skip.version && Date.now() < this.skip.until) {
      return this.skip.reason === "went-back"
        ? `You went back from ${this.skip.version}, so automatic updates skip it and resume with the next release (\`sym update\` installs it anyway).`
        : `The update to ${this.skip.version} failed recently; it will be retried tomorrow.`;
    }
    if (!forced && this.host.remoteActive()) return "Remote access is on (updating would end it); waiting until it's off.";
    if (!forced) {
      const busy = this.host.busy();
      if (busy) return `Waiting for the team to be idle (${busy}).`;
    }
    return null;
  }

  /** Automatic updates: check now and then; apply when allowed and the team has been quiet. */
  private async tick() {
    if (this.mode === "off" || this.install.kind === "dev") return;
    if (!this.checkedAt || Date.now() - this.checkedAt > CHECK_EVERY_MS) await this.check();
    const s = this.state();
    if (s.available && this.mode === "auto" && !this.blocker(false)) await this.apply(false);
  }

  /**
   * Hands over to the runner and stops Symbio. `forced` (the human asked): applies even with
   * agents working (they're interrupted and resumed after the restart).
   */
  async apply(forced: boolean, version?: string): Promise<string> {
    if (version) return this.applyVersion(version);
    if (!this.latest || compareVersions(this.latest, this.host.version) <= 0) await this.check();
    if (!this.latest || compareVersions(this.latest, this.host.version) <= 0) throw new Error(`Symbio ${this.host.version} is up to date.`);
    const blocked = this.blocker(forced);
    if (blocked) throw new Error(blocked);
    return this.handOver(this.latest, `Symbio is updating from ${this.host.version} to ${this.latest}`);
  }

  /**
   * A specific version, asked for by the human (`sym update --to 0.9.0`): usually going back to
   * the one before a release that broke something. Going back holds automatic updates (holdBack).
   */
  private async applyVersion(version: string): Promise<string> {
    if (this.install.kind === "dev") throw new Error(this.blocker(true)!);
    if (this.applying) throw new Error("Already updating.");
    const target = await release(version);
    if (compareVersions(target.version, this.host.version) === 0) throw new Error(`Symbio ${target.version} is already the one running.`);
    if (!nodeSatisfies(target.node)) {
      throw new Error(`Symbio ${target.version} needs Node.js ${target.node}, and this machine has ${process.versions.node}.`);
    }
    const back = compareVersions(target.version, this.host.version) < 0;
    if (back) {
      // Leave alone what's being left (or the newer release already out, if there is one).
      const left = this.latest && compareVersions(this.latest, this.host.version) > 0 ? this.latest : this.host.version;
      await holdBack(this.host.home, left);
      this.skip = { version: left, until: Number.MAX_SAFE_INTEGER, reason: "went-back" };
    }
    return this.handOver(target.version, `Symbio is ${back ? "going back" : "moving"} from ${this.host.version} to ${target.version}`);
  }

  private async handOver(to: string, announcement: string): Promise<string> {
    this.applying = true;
    try {
      await this.host.backup().catch((err) => console.error("[update] backup failed:", err.message));
      await this.host.announce(`${announcement}; it'll be back in a minute or two.`).catch(() => {});
      await this.runRunner({ waitPid: process.pid, to, start: true });
    } catch (err) {
      this.applying = false;
      throw err;
    }
    setTimeout(() => void this.host.shutdown(), 300);
    return `Installing ${to}: Symbio restarts in a minute or two.`;
  }

  /** Starts the runner from a copy in the temp folder (npm replaces the package folder). */
  async runRunner(opts: { waitPid?: number; to: string; start: boolean }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symbio-update-"));
    const runner = path.join(dir, "update-runner.mjs");
    await fs.copyFile(path.join(this.install.root, "bin", "update-runner.mjs"), runner);
    const job = path.join(dir, "job.json");
    await fs.writeFile(
      job,
      JSON.stringify({
        waitPid: opts.waitPid,
        prefix: this.install.prefix,
        spec: process.env.SYMBIO_UPDATE_SPEC ?? `symbio@${opts.to}`,
        from: this.host.version,
        to: opts.to,
        root: this.install.root,
        home: this.host.home,
        port: this.host.port,
        start: opts.start,
        resultFile: this.resultFile,
        logFile: path.join(this.host.home, "logs", "update.log"),
      }),
    );
    const child = spawn(process.execPath, [runner, job], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }

  private async saveSettings() {
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fs.writeFile(this.settingsFile, JSON.stringify({ mode: this.mode, skip: this.skip }, null, 2));
  }
}
