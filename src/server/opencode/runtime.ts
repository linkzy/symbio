// Owns a private `opencode serve` process: starts it, restarts it if it dies,
// and keeps a single event subscription alive across restarts.

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { OpencodeClient, type OpencodeEvent } from "./client.js";

const execFileAsync = promisify(execFile);

export type RuntimeState = "stopped" | "starting" | "running" | "crashed";

// Environment that keeps agent shell commands from waiting on input forever.
const NON_INTERACTIVE_ENV = {
  CI: "1",
  npm_config_yes: "true",
  GIT_TERMINAL_PROMPT: "0",
  PIP_NO_INPUT: "1",
};

export interface RuntimeEvents {
  state: [RuntimeState];
  event: [OpencodeEvent];
  restarted: [];
}

export class OpencodeRuntime extends EventEmitter<RuntimeEvents> {
  state: RuntimeState = "stopped";
  client: OpencodeClient | null = null;
  version: string | null = null;
  lastError: string | null = null;
  restarts = 0;

  private proc: ChildProcess | null = null;
  private stopping = false;
  private subscription: AbortController | null = null;
  private recentCrashes: number[] = [];

  /** @param pidFile where the server pid is recorded, so an orphan from a hard-killed run can be cleaned up. */
  constructor(private readonly pidFile: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return;
    this.stopping = false;
    this.setState("starting");
    killOrphan(this.pidFile);

    const port = await freePort();
    const password = randomBytes(24).toString("base64url");
    const { command, args, shell } = resolveOpencode();

    // --stdio: OpenCode removes the password from its own environment after reading it,
    // so agents' shells don't inherit it (they could otherwise call OpenCode directly and
    // change their own permissions). It also exits when our end of stdin closes, so the
    // server never outlives Symbio.
    const proc = spawn(command, [...args, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--stdio"], {
      env: { ...process.env, ...NON_INTERACTIVE_ENV, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    this.proc = proc;
    if (proc.pid) writeFileSync(this.pidFile, String(proc.pid));

    const tail: string[] = [];
    const remember = (buf: Buffer) => {
      tail.push(...buf.toString().split(/\r?\n/).filter(Boolean));
      if (tail.length > 40) tail.splice(0, tail.length - 40);
    };
    proc.stdout!.on("data", remember);
    proc.stderr!.on("data", remember);

    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.subscription?.abort();
      this.client = null;
      if (this.stopping) {
        this.setState("stopped");
        return;
      }
      this.lastError = `opencode exited (code ${code ?? "?"}${signal ? `, ${signal}` : ""}): ${tail.slice(-5).join(" | ")}`;
      console.error(`[runtime] ${this.lastError}`);
      this.setState("crashed");
      this.scheduleRestart();
    });

    const client = new OpencodeClient(`http://127.0.0.1:${port}`, password);
    try {
      await waitFor(async () => {
        if (!this.proc) throw new Error(`opencode exited during startup: ${tail.join(" | ")}`);
        const info = await client.info().catch(() => null);
        if (info) this.version = info.version;
        return !!info;
      }, 60_000);
    } catch (err) {
      this.lastError = String((err as Error).message);
      this.killProc();
      this.setState("crashed");
      throw err;
    }

    this.client = client;
    this.lastError = null;
    this.setState("running");
    this.subscribe(client);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.subscription?.abort();
    this.killProc();
    this.setState("stopped");
  }

  /** Restart on purpose (e.g. memory recycling). */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.restarts++;
    this.emit("restarted");
  }

  /** Last measured memory of the opencode process tree, in bytes. */
  lastMemory: number | null = null;

  /** Measures memory used by the opencode process tree, in bytes (Windows/Linux/macOS best effort). */
  async memoryUsage(): Promise<number | null> {
    const pid = this.proc?.pid;
    if (!pid) return null;
    try {
      let bytes: number;
      if (process.platform === "win32") {
        // List every process once ("pid parent bytes" per line) and sum the opencode tree here.
        const { stdout } = await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }",
          ],
          { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
        );
        bytes = sumProcessTree(stdout, pid);
      } else {
        const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
        bytes = Number(stdout.trim()) * 1024;
      }
      this.lastMemory = bytes || null;
      return this.lastMemory;
    } catch {
      return null;
    }
  }

  private scheduleRestart() {
    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter((t) => now - t < 5 * 60_000);
    this.recentCrashes.push(now);
    // Back off if it keeps dying, so a broken install doesn't spin forever.
    if (this.recentCrashes.length > 5) {
      this.lastError = `opencode crashed ${this.recentCrashes.length} times in 5 minutes; not restarting. ${this.lastError}`;
      console.error(`[runtime] ${this.lastError}`);
      return;
    }
    const delay = 1000 * 2 ** (this.recentCrashes.length - 1);
    setTimeout(() => {
      if (this.stopping || this.state === "running") return;
      this.start()
        .then(() => {
          this.restarts++;
          this.emit("restarted");
        })
        .catch((err) => console.error("[runtime] restart failed:", err.message));
    }, delay);
  }

  private subscribe(client: OpencodeClient) {
    const controller = new AbortController();
    this.subscription = controller;
    const loop = async () => {
      while (!controller.signal.aborted && this.client === client) {
        try {
          await client.subscribe((e) => this.emit("event", e), controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return;
          console.error("[runtime] event stream error:", (err as Error).message);
        }
        await sleep(1000);
      }
    };
    void loop();
  }

  private killProc() {
    const proc = this.proc;
    this.proc = null;
    this.client = null;
    if (!proc?.pid) return;
    killTree(proc.pid);
    rmSync(this.pidFile, { force: true });
  }

  private setState(state: RuntimeState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

/**
 * Finds a way to launch opencode. Prefers the real executable so we can
 * kill/monitor it directly instead of a .cmd shim.
 */
function resolveOpencode(): { command: string; args: string[]; shell: boolean } {
  const override = process.env.SYMBIO_OPENCODE_BIN;
  if (override) return { command: override, args: [], shell: false };
  if (process.platform === "win32") {
    try {
      const root = execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", windowsHide: true, shell: true }).trim();
      const exe = path.join(root, "@opencode", "cli", "bin", "opencode.exe");
      if (existsSync(exe)) return { command: exe, args: [], shell: false };
    } catch {
      // fall through
    }
    return { command: "opencode", args: [], shell: true };
  }
  return { command: "opencode", args: [], shell: false };
}

function killTree(pid: number) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
}

/** Kills the server left behind by a previous run, but only if that pid is still an opencode process. */
function killOrphan(pidFile: string) {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  rmSync(pidFile, { force: true });
  if (!pid) return;
  try {
    // Match the exact way we launch it, so a reused pid (or the user's own opencode) is never killed.
    const cmdline =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
            { encoding: "utf8", windowsHide: true, timeout: 10_000 },
          )
        : execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    if (/opencode/i.test(cmdline) && /serve --hostname 127\.0\.0\.1 --port/.test(cmdline)) {
      console.warn(`[runtime] killing orphaned opencode server from a previous run (pid ${pid})`);
      killTree(pid);
    }
  } catch {
    // not running
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error("timed out waiting for opencode to start");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sums the memory of a process and all its descendants from "pid parent bytes" lines. */
export function sumProcessTree(listing: string, root: number): number {
  const children = new Map<number, number[]>();
  const memory = new Map<number, number>();
  for (const line of listing.split(/\r?\n/)) {
    const [pid, parent, bytes] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    memory.set(pid, bytes || 0);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(pid);
  }
  let total = 0;
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue; // pid reuse can create cycles
    seen.add(pid);
    total += memory.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}
