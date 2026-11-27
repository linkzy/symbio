// Which agent runtimes are installed, and installing them. Symbio doesn't ship any: the human
// installs the ones they want (Settings → Runtimes, or the first-run cards), and Symbio downloads
// the version it was tested with into its own folder (~/.symbio/runtimes/<kind>), with npm. Removing
// one deletes that folder. A copy already on the computer (on the PATH) can be used instead, for the
// runtimes that allow it, but only when the human opts in: by default Symbio runs the version it was
// tested with.
//
// A runtime is found, in order: a path given in the environment (development, the end-to-end tests'
// stand-ins), the computer's copy when opted in, Symbio's own copy, or (in a development checkout)
// the copy in Symbio's node_modules.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globalDir } from "../store.js";
import { loadRuntimeSettings } from "./settings.js";
import type { RuntimeKind } from "./types.js";

export interface RuntimePackage {
  kind: RuntimeKind;
  label: string;
  /** What it is, for the cards. */
  description: string;
  /** What the human needs besides it. */
  needs: string;
  /** The npm package. The version Symbio installs is the one it's developed and tested with: its own dev dependency (package.json). */
  npm: string;
  /** About how much disk the install takes. */
  sizeMB: number;
  /** Where the runtime starts, inside an installed package folder (node_modules/<npm>). */
  entry(packageDir: string): string | null;
  /** An environment variable that points at the runtime instead (development, tests). */
  env: string;
  /** Its command, to find a copy already on the computer (on the PATH) and read its version. */
  command: string;
  /**
   * Whether Symbio can run on the computer's copy (when the human opts in). Copilot can't: Symbio
   * drives it through the SDK, which only talks to the runtime version it was built with
   * (docs/copilot-api.md), so a copy found is only mentioned.
   */
  computerUsable: boolean;
}

export const RUNTIME_PACKAGES: Record<RuntimeKind, RuntimePackage> = {
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    description: "Open-source agent runtime. Agents run on models from the providers you connect: OpenAI, Anthropic, Azure, OpenRouter, local models…",
    needs: "a model provider (an API key or a sign-in), connected in Settings → Model providers.",
    npm: "@opencode/cli",
    sizeMB: 700,
    // The executable its package declares (its postinstall puts the platform binary there).
    entry: (dir) => {
      const pkg = readJson(path.join(dir, "package.json"));
      const rel = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.opencode;
      return rel ? path.resolve(dir, rel) : null;
    },
    env: "SYMBIO_OPENCODE_BIN",
    command: "opencode",
    computerUsable: true,
  },
  copilot: {
    kind: "copilot",
    label: "GitHub Copilot CLI",
    description: "GitHub's agent runtime, through the Copilot SDK. Agents run on the models of your Copilot subscription (and providers you added to Copilot).",
    needs: "a GitHub account with a Copilot subscription (sign in from Settings).",
    npm: "@github/copilot-sdk",
    sizeMB: 210,
    // The SDK's ES module entry (its platform runtime comes as an optional dependency).
    entry: (dir) => {
      const pkg = readJson(path.join(dir, "package.json"));
      const rel = pkg?.exports?.["."]?.import?.default ?? pkg?.main;
      return rel ? path.resolve(dir, rel) : null;
    },
    env: "SYMBIO_COPILOT_SDK",
    command: "copilot",
    computerUsable: false,
  },
};

export const runtimesDir = () => path.join(globalDir, "runtimes");
const installDir = (kind: RuntimeKind) => path.join(runtimesDir(), kind);
const manifestFile = (kind: RuntimeKind) => path.join(installDir(kind), "runtime.json");

/** Where a runtime starts from, and how it got there. */
export interface Located {
  entry: string;
  source: "environment" | "path" | "symbio" | "development";
  version: string | null;
  /** Windows shims from npm are batch files: Node can only start them through cmd.exe. */
  shell?: boolean;
}

/** Whether Symbio's own copy is there, even when another source is currently preferred. */
export function hasInstalledCopy(kind: RuntimeKind): boolean {
  const manifest = readJson(manifestFile(kind));
  return typeof manifest?.entry === "string" && existsSync(manifest.entry);
}

/** A runtime's executable on the PATH (a copy installed on the computer), if there is one. */
export function findOnPath(kind: RuntimeKind): Located | null {
  const command = RUNTIME_PACKAGES[kind].command;
  // Windows npm shims are .cmd; the extensionless file is a shell script Node can't spawn directly.
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`] : [command];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    // Only absolute folders: a relative one (".", "bin") would depend on where Symbio was started from.
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of names) {
      const entry = path.resolve(dir, name);
      if (!existsSync(entry)) continue;
      try {
        if (!statSync(entry).isFile()) continue;
      } catch {
        continue; // a broken link on the PATH
      }
      return { entry, source: "path", version: null, ...(name.endsWith(".cmd") ? { shell: true } : {}) };
    }
  }
  return null;
}

/** The installed runtime, or null. */
export function locate(kind: RuntimeKind): Located | null {
  const spec = RUNTIME_PACKAGES[kind];
  const fromEnv = process.env[spec.env]?.trim();
  if (fromEnv) return { entry: fromEnv, source: "environment", version: null };
  // Opt-in and explicit: PATH can hold any version, so never use it silently.
  if (spec.computerUsable && loadRuntimeSettings().fromComputer[kind]) {
    const onPath = findOnPath(kind);
    if (onPath) return { ...onPath, version: versions.get(onPath.entry)?.version ?? null };
  }
  if (hasInstalledCopy(kind)) {
    const manifest = readJson(manifestFile(kind))!;
    return { entry: manifest.entry, source: "symbio", version: manifest.version ?? null };
  }
  if (process.env.SYMBIO_NO_DEV_RUNTIMES === "1") return null;
  // A development checkout has the runtimes in its own node_modules (dev dependencies). Only there:
  // an installed Symbio could otherwise pick up a copy someone installed globally next to it.
  try {
    const dir = packageDir(spec.npm);
    const root = symbioRoot();
    if (!root || !path.resolve(dir).startsWith(path.join(root, "node_modules") + path.sep)) return null;
    const entry = spec.entry(dir);
    if (entry && existsSync(entry)) return { entry, source: "development", version: readJson(path.join(dir, "package.json"))?.version ?? null };
  } catch {
    // not there: a normal install
  }
  return null;
}

export const isInstalled = (kind: RuntimeKind) => locate(kind) !== null;

/** Versions read from executables found on the computer, by path (and file time: an update changes it). */
const versions = new Map<string, { mtime: number; version: string | null }>();

/** What `<command> --version` says, as x.y.z (or null), read once per file and kept. */
export async function computerVersion(found: Located): Promise<string | null> {
  let mtime = 0;
  try {
    mtime = statSync(found.entry).mtimeMs;
  } catch {
    return null;
  }
  const known = versions.get(found.entry);
  if (known && known.mtime === mtime) return known.version;
  const output = await new Promise<string>((resolve) =>
    // Through cmd.exe for .cmd shims; the path is quoted, and comes from the PATH, not from a request.
    execFile(found.shell ? `"${found.entry}"` : found.entry, ["--version"], { timeout: 8000, windowsHide: true, shell: !!found.shell }, (_err, stdout) =>
      resolve(String(stdout ?? "")),
    ),
  );
  const version = /\d+\.\d+\.\d+(?:[-.][\w.]+)?/.exec(output)?.[0]?.replace(/\.$/, "") ?? null;
  versions.set(found.entry, { mtime, version });
  return version;
}

/** The version already read for an executable (undefined: not yet, or it changed since). */
export function knownVersion(found: Located): string | null | undefined {
  const known = versions.get(found.entry);
  try {
    return known && known.mtime === statSync(found.entry).mtimeMs ? known.version : undefined;
  } catch {
    return undefined;
  }
}

/** The version range of a runtime Symbio was tested with (its dev dependency). */
export function testedVersion(kind: RuntimeKind): string {
  const root = symbioRoot();
  const range = root ? readJson(path.join(root, "package.json"))?.devDependencies?.[RUNTIME_PACKAGES[kind].npm] : null;
  if (typeof range !== "string") throw new Error(`Symbio's package.json doesn't name the ${RUNTIME_PACKAGES[kind].label} version to install.`);
  return range;
}

/** The folder Symbio itself is in (its package.json), found from this file in src/ or dist/. */
function symbioRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (readJson(path.join(dir, "package.json"))?.name === "symbio") return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** Loads a module runtime (the Copilot SDK, or a stand-in for it) from where it was located. */
export async function importRuntime(kind: RuntimeKind): Promise<any> {
  const found = locate(kind);
  if (!found || found.source === "path") throw new NotInstalledError(kind);
  return import(pathToFileURL(path.resolve(found.entry)).href);
}

export class NotInstalledError extends Error {
  constructor(readonly kind: RuntimeKind) {
    super(`${RUNTIME_PACKAGES[kind].label} isn't installed. Install it in Settings → Runtimes.`);
  }
}

// ---------------------------------------------------------------- installing

export interface InstallState {
  installing: boolean;
  /** The last lines npm printed, for the card while it works and when it fails. */
  log: string[];
  error: string | null;
}

/**
 * Installs a runtime into Symbio's folder: `npm install <package>@<tested version>` in
 * ~/.symbio/runtimes/<kind>, then a manifest saying where it starts. SYMBIO_RUNTIME_INSTALLER can
 * name a module whose `install(kind, dir)` does it instead (the end-to-end tests' stand-in).
 */
export class RuntimeInstaller extends EventEmitter<{ change: [RuntimeKind] }> {
  private states = new Map<RuntimeKind, InstallState>();
  private running = new Map<RuntimeKind, Promise<void>>();

  private onChange(kind: RuntimeKind) {
    this.emit("change", kind);
  }

  state(kind: RuntimeKind): InstallState {
    return this.states.get(kind) ?? { installing: false, log: [], error: null };
  }

  /** Starts installing (or returns the install under way); resolves when it's done. */
  install(kind: RuntimeKind): Promise<void> {
    let job = this.running.get(kind);
    if (!job) {
      job = this.run(kind).finally(() => this.running.delete(kind));
      this.running.set(kind, job);
    }
    return job;
  }

  private async run(kind: RuntimeKind) {
    const spec = RUNTIME_PACKAGES[kind];
    const state: InstallState = { installing: true, log: [], error: null };
    this.states.set(kind, state);
    this.onChange(kind);
    const dir = installDir(kind);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      let entry: string | null;
      const standIn = process.env.SYMBIO_RUNTIME_INSTALLER?.trim();
      if (standIn) {
        entry = await (await import(pathToFileURL(path.resolve(standIn)).href)).install(kind, dir);
      } else {
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `symbio-runtime-${kind}`, private: true }, null, 2));
        await npmInstall(dir, `${spec.npm}@${testedVersion(kind)}`, (line) => {
          state.log = [...state.log, line].slice(-12);
          this.onChange(kind);
        });
        entry = spec.entry(path.join(dir, "node_modules", ...spec.npm.split("/")));
      }
      if (!entry || !existsSync(entry)) throw new Error(`${spec.label} was downloaded, but its program isn't where its package says.`);
      await fs.writeFile(manifestFile(kind), JSON.stringify({ kind, npm: spec.npm, version: installedVersion(entry), entry, installedAt: Date.now() }, null, 2));
      state.installing = false;
    } catch (err) {
      state.installing = false;
      state.error = (err as Error).message;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      this.onChange(kind);
    }
  }

  /** Deletes Symbio's copy (the caller checks nothing uses it and stops it first). */
  async remove(kind: RuntimeKind): Promise<void> {
    if (this.running.has(kind)) throw new Error(`${RUNTIME_PACKAGES[kind].label} is being installed.`);
    // Files of a process that just stopped can stay locked on Windows for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rm(installDir(kind), { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    this.states.delete(kind);
    this.onChange(kind);
  }
}

/**
 * The environment with the Node.js running Symbio first on the PATH, so `npm` is the one beside
 * it: the one-line installer's private Node.js isn't on the PATH at all.
 */
export function withOwnNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: `${path.dirname(process.execPath)}${path.delimiter}${env[key] ?? ""}` };
}

/** `npm install <spec>` in a folder, with npm's output line by line. */
function npmInstall(dir: string, spec: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    // In the folder itself (cwd), so its path never goes through a shell.
    const child = spawn(win ? "npm.cmd" : "npm", ["install", spec, "--no-audit", "--no-fund", "--omit=dev", "--loglevel=http"], {
      cwd: dir,
      shell: win,
      windowsHide: true,
      env: { ...withOwnNode(process.env), npm_config_update_notifier: "false" },
    });
    let tail = "";
    const read = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLine(line.trim().slice(0, 200));
      tail = (tail + chunk.toString()).slice(-2000);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const timer = setTimeout(() => child.kill(), 20 * 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`npm couldn't run: ${err.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm couldn't install ${spec}: ${tail.trim().split(/\r?\n/).slice(-4).join(" ").slice(0, 500)}`));
    });
  });
}

/** Where a package is in Symbio's node_modules: by its package.json, or (when it doesn't export it) its main file. */
function packageDir(name: string): string {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    let dir = path.dirname(require.resolve(name));
    while (readJson(path.join(dir, "package.json"))?.name !== name && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return dir;
  }
}

/** The version in the package.json nearest above a file (the package it belongs to). */
function installedVersion(file: string): string | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 5; i++) {
    const version = readJson(path.join(dir, "package.json"))?.version;
    if (typeof version === "string") return version;
    dir = path.dirname(dir);
  }
  return null;
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
