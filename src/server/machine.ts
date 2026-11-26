// This computer as the team uses it: agents' work runs at low priority (so the system, remote desktop
// tools and the human always come first), the programs agents started can be listed and stopped
// from the browser, and a load guard tells the human and core when the machine is overloaded (and,
// if the human wants, holds new agent turns until it recovers).

import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "./fsutil.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- priority

/** SYMBIO_AGENT_PRIORITY=normal keeps agents' work at normal priority. */
const LOW_PRIORITY = process.env.SYMBIO_AGENT_PRIORITY !== "normal";

/**
 * Lowers a runtime's process (and what it already started) to below-normal priority. What it starts
 * afterwards inherits it (verified on Windows: a below-normal process's children are below normal
 * unless they ask otherwise; nice values are inherited on Linux and macOS).
 */
export async function lowerPriority(root: number | null | undefined): Promise<void> {
  if (!LOW_PRIORITY || !root) return;
  const pids = [root, ...descendants(await listProcesses().catch(() => []), root).map((p) => p.pid)];
  for (const pid of pids) {
    try {
      os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // gone, or not ours to change
    }
  }
}

// ---------------------------------------------------------------- processes

export interface ProcessInfo {
  pid: number;
  parent: number;
  name: string;
  command: string;
  /** Working set / resident memory, bytes. */
  memory: number;
  /** CPU time used so far, seconds. */
  cpuTime: number;
  /** When it started (ms since epoch); 0 when unknown. */
  started: number;
}

const WINDOWS_LISTING = {
  file: "powershell.exe",
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { " +
      "$s = 0; if ($_.CreationDate) { $s = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }; " +
      "[pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; m = $_.WorkingSetSize; " +
      "t = ($_.KernelModeTime + $_.UserModeTime) / 10000000; s = $s } } | ConvertTo-Json -Compress",
  ],
  options: { encoding: "utf8" as const, windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
};

export function parseWindowsListing(stdout: string): ProcessInfo[] {
  // Windows PowerShell's ConvertTo-Json leaves some control characters raw in strings (a program's
  // command line can hold one), which JSON.parse refuses: the whole listing failed. They become spaces.
  const rows = JSON.parse((stdout || "[]").replace(/[\u0000-\u001f]/g, " "));
  return (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({
    pid: Number(r.p),
    parent: Number(r.q),
    name: String(r.n ?? ""),
    command: String(r.c ?? r.n ?? ""),
    memory: Number(r.m) || 0,
    cpuTime: Number(r.t) || 0,
    started: Number(r.s) || 0,
  }));
}

/** Every process on the machine (best effort; one listing call). */
export async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(WINDOWS_LISTING.file, WINDOWS_LISTING.args, WINDOWS_LISTING.options);
    return parseWindowsListing(stdout);
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,time=,etime=,comm=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const now = Date.now();
  return stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({
      pid: Number(m[1]),
      parent: Number(m[2]),
      memory: Number(m[3]) * 1024,
      cpuTime: duration(m[4]),
      started: now - duration(m[5]) * 1000,
      name: path.basename(m[6]),
      command: m[7] || m[6],
    }));
}

/** "[[dd-]hh:]mm:ss" → seconds. */
function duration(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  return rest.split(":").map(Number).reduce((total, n) => total * 60 + (n || 0), 0) + Number(days) * 86_400;
}

/**
 * Whether `p` really is a child of `parent`. Windows keeps a process's parent id after the parent
 * exits, and ids are reused: a long-running process (the antivirus, Task Manager, the system's own)
 * can name as its parent an id that now belongs to a new shell. A child never starts before its
 * parent, which tells them apart.
 */
export function childOf(p: ProcessInfo, parent: ProcessInfo | undefined): boolean {
  if (!parent || p.parent !== parent.pid) return false;
  return !(p.started && parent.started && p.started < parent.started);
}

/** A process's descendants in a listing. */
export function descendants(list: ProcessInfo[], root: number): ProcessInfo[] {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const children = new Map<number, ProcessInfo[]>();
  for (const p of list) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
  const out: ProcessInfo[] = [];
  const seen = new Set<number>([root]);
  const under = (pid: number) => {
    const parent = byPid.get(pid);
    // The root itself may be missing from the listing (it just exited): then its children can't be checked by time.
    return (children.get(pid) ?? []).filter((c) => (parent ? childOf(c, parent) : true));
  };
  const stack = under(root);
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue; // pid reuse can create cycles
    seen.add(p.pid);
    out.push(p);
    stack.push(...under(p.pid));
  }
  return out;
}

/**
 * Memory of a process and what runs under it, in bytes, without the shells under it (agents'
 * commands: a build or a dev server isn't the runtime's memory) and what runs under those.
 */
export function treeMemory(list: ProcessInfo[], root: number): number {
  const self = list.find((p) => p.pid === root);
  if (!self) return 0;
  const children = new Map<number, ProcessInfo[]>();
  for (const p of list) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
  let total = self.memory;
  const seen = new Set<number>([root]);
  const stack = [self];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of children.get(p.pid) ?? []) {
      if (seen.has(c.pid) || !childOf(c, p) || SHELL.test(c.name)) continue;
      seen.add(c.pid);
      total += c.memory;
      stack.push(c);
    }
  }
  return total;
}

/**
 * Stops a process and what runs under it, now (for shutdowns). On Windows the tree comes from a
 * listing checked by start time (`childOf`), not from `taskkill /T`, which follows parent ids that
 * Windows may have given to other programs since.
 */
export function killTreeSync(pid: number) {
  try {
    if (process.platform !== "win32") {
      process.kill(pid, "SIGTERM");
      return;
    }
    let list: ProcessInfo[] = [];
    try {
      list = parseWindowsListing(String(execFileSync(WINDOWS_LISTING.file, WINDOWS_LISTING.args, WINDOWS_LISTING.options)));
    } catch {
      // no listing: the process itself still stops
    }
    for (const p of [...descendants(list, pid).reverse(), { pid }]) {
      try {
        execFileSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        // already gone
      }
    }
  } catch {
    // already gone
  }
}

/** Shells a runtime runs agents' commands in: what runs under them is the agents' work. */
const SHELL = /^(pwsh|powershell|cmd|bash|sh|zsh|dash|fish)(\.exe)?$/i;
/** Not programs of their own: shells, and the console host Windows starts for each one. */
const plumbing = (name: string) => SHELL.test(name) || /^(conhost|openconsole)(\.exe)?$/i.test(name);

/**
 * The programs agents started: everything under a shell a runtime started, without the shells
 * themselves (unless one runs nothing but itself for a long time), plus processes seen that way
 * before whose parent has exited since (browsers and launchers detach).
 */
export function agentProcesses(list: ProcessInfo[], roots: number[], known: Map<number, number>): ProcessInfo[] {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const found = new Map<number, ProcessInfo>();
  for (const root of roots) {
    for (const p of descendants(list, root)) {
      // Under a shell the runtime started (not the runtime's own helpers, like language servers).
      let up = byPid.get(p.parent);
      let underShell = false;
      while (up && up.pid !== root) {
        if (SHELL.test(up.name)) underShell = true;
        const next = byPid.get(up.parent);
        up = next && childOf(up, next) ? next : undefined;
      }
      if (underShell && !plumbing(p.name)) found.set(p.pid, p);
    }
  }
  // Seen before (same pid, same start time) and still running, with whatever runs under them.
  for (const [pid, started] of known) {
    const p = byPid.get(pid);
    if (!p || p.started !== started || found.has(pid)) continue;
    found.set(pid, p);
    for (const d of descendants(list, pid)) if (!plumbing(d.name)) found.set(d.pid, d);
  }
  return [...found.values()];
}

// ---------------------------------------------------------------- the monitor

export interface MachineLoad {
  /** All cores, 0–100, averaged over the last sample. */
  cpu: number;
  memory: { total: number; free: number };
  cores: number;
  overloaded: boolean;
  /** Since when it's been overloaded (ms). */
  since: number | null;
  /** New agent turns wait until it recovers (the human's choice, while overloaded). */
  holding: boolean;
  settings: MachineSettings;
}

export interface MachineSettings {
  /** While overloaded, hold new agent turns (messages between agents wait) until it recovers. */
  holdTurns: boolean;
}

export interface AgentProcess {
  pid: number;
  name: string;
  command: string;
  memory: number;
  /** Share of the whole machine's CPU since the previous listing, 0–100; null on the first one. */
  cpu: number | null;
  started: number;
  /** "OpenCode", "GitHub Copilot CLI" */
  runtime: string;
  /**
   * Who started it: one agent, or the agents that were working when it started when that's all
   * Symbio can tell (several at once, in the same runtime); empty when unknown.
   */
  owners: { projectId: string; project: string; agentId: string; agent: string }[];
}

/** "overdrive · core", "overdrive · core or tester", or "" when unknown. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, but someone else's
  }
}

export function startedBy(p: Pick<AgentProcess, "owners">): string {
  const projects = new Set(p.owners.map((o) => o.projectId));
  if (projects.size === 1) return `${p.owners[0].project} · ${p.owners.map((o) => o.agent).join(" or ")}`;
  return p.owners.map((o) => `${o.project} · ${o.agent}`).join(" or ");
}

/** An agent that may have started a program. */
export interface ProgramOwner {
  projectId: string;
  project: string;
  agentId: string;
  agent: string;
  /** The agent's folder: a program whose command line names it is that agent's. */
  directory: string;
}

/** What the team tells the monitor so it can say who started each program (team.ts). */
export interface Attribution {
  /** The runtimes' background shells by pid, with the agent that started each (the runtimes record it). */
  shells(): Promise<Map<number, ProgramOwner>>;
  /** The agents on a runtime (by its label) that were working at a moment (ms). */
  workingAt(at: number, runtime: string): ProgramOwner[];
}

const SAMPLE_MS = Number(process.env.SYMBIO_MACHINE_SAMPLE_SECONDS ?? 15) * 1000;
/** Overloaded: CPU at or above this (%) on average over the window, or free memory below the floor. */
const CPU_LIMIT = Number(process.env.SYMBIO_OVERLOAD_CPU ?? 90);
const WINDOW_MS = Number(process.env.SYMBIO_OVERLOAD_SECONDS ?? 180) * 1000;
/** Back to normal: CPU below this on average over the window, and memory above the floor. */
const CPU_OK = Math.min(CPU_LIMIT - 10, 75);
const TRACK_MS = Math.min(30_000, SAMPLE_MS * 2);

export class MachineMonitor extends EventEmitter<{ changed: [MachineLoad]; overloaded: [MachineLoad, AgentProcess[]]; recovered: [MachineLoad] }> {
  private timer: NodeJS.Timeout | null = null;
  private samples: { at: number; cpu: number; free: number }[] = [];
  private lastCpu = cpuTimes();
  private overloadedSince: number | null = null;
  settings: MachineSettings = { holdTurns: false };
  /** pid → start time of every agent process seen, so ones whose parent exited are still recognized. */
  private known = new Map<number, number>();
  private lastListing = new Map<number, { cpuTime: number; at: number }>();
  private tracking: Promise<AgentProcess[]> | null = null;
  private listedAt = 0;
  /** Who started each program seen (pid → its start time and owners), kept while it runs. */
  private owners = new Map<number, { started: number; owners: ProgramOwner[] }>();
  attribution: Attribution | null = null;

  /**
   * @param roots the runtimes' processes (pid and label) that are running now
   * @param busy whether any agent is working (processes are only tracked then, to stay light)
   */
  constructor(
    private readonly home: string,
    private readonly roots: () => { pid: number; label: string }[],
    private readonly busy: () => boolean,
  ) {
    super();
  }

  private get settingsFile() {
    return path.join(this.home, "machine.json");
  }

  async load() {
    const saved = JSON.parse(await fs.readFile(this.settingsFile, "utf8").catch(() => "{}"));
    this.settings = { holdTurns: saved.holdTurns === true };
  }

  async setSettings(next: Partial<MachineSettings>) {
    if (typeof next.holdTurns === "boolean") this.settings.holdTurns = next.holdTurns;
    await writeFileAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this.emit("changed", this.state());
  }

  start() {
    this.timer ??= setInterval(() => void this.sample().catch((err) => console.error("[machine]", err.message)), SAMPLE_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get overloaded() {
    return this.overloadedSince !== null;
  }

  /** Whether new agent turns wait (overloaded, and the human chose to hold them). */
  get holding() {
    return this.overloaded && this.settings.holdTurns;
  }

  state(): MachineLoad {
    const last = this.samples[this.samples.length - 1];
    return {
      cpu: Math.round(last?.cpu ?? 0),
      memory: { total: os.totalmem(), free: last?.free ?? os.freemem() },
      cores: os.cpus().length,
      overloaded: this.overloaded,
      since: this.overloadedSince,
      holding: this.holding,
      settings: { ...this.settings },
    };
  }

  /** One measurement: CPU since the last one and free memory; decides overloaded / recovered. */
  async sample(now = Date.now()) {
    const fake = process.env.SYMBIO_MACHINE_LOAD_FILE;
    let cpu: number;
    let free: number;
    if (fake) {
      // Tests: the load comes from a file ({cpu, free}) instead of the machine.
      const data = JSON.parse(await fs.readFile(fake, "utf8").catch(() => "{}"));
      cpu = Number(data.cpu ?? 0);
      free = Number(data.free ?? os.freemem());
    } else {
      const times = cpuTimes();
      const total = times.total - this.lastCpu.total;
      cpu = total > 0 ? (100 * (total - (times.idle - this.lastCpu.idle))) / total : 0;
      this.lastCpu = times;
      free = os.freemem();
    }
    this.samples.push({ at: now, cpu, free });
    this.samples = this.samples.filter((s) => now - s.at <= WINDOW_MS + SAMPLE_MS);
    const window = this.samples.filter((s) => now - s.at <= WINDOW_MS);
    const full = now - window[0].at >= WINDOW_MS - SAMPLE_MS || WINDOW_MS <= SAMPLE_MS;
    const average = window.reduce((sum, s) => sum + s.cpu, 0) / window.length;
    const floor = memoryFloor();
    const lowMemory = window.every((s) => s.free < floor);

    // Keeps track of what agents started (so programs that detach are still known), at most every 30 seconds.
    if ((this.busy() || this.overloaded) && now - this.listedAt >= TRACK_MS) await this.processes().catch(() => []);

    if (!this.overloaded && full && (average >= CPU_LIMIT || lowMemory)) {
      this.overloadedSince = now;
      const heavy = await this.processes().catch(() => []);
      this.emit("overloaded", this.state(), heavy);
    } else if (this.overloaded && full && average < CPU_OK && window.every((s) => s.free >= floor)) {
      this.overloadedSince = null;
      this.emit("recovered", this.state());
    }
    this.emit("changed", this.state());
  }

  /** The programs agents started, heaviest first. */
  processes(): Promise<AgentProcess[]> {
    // One listing at a time: on a struggling machine, listing is itself work.
    this.tracking ??= this.listAgentProcesses().finally(() => (this.tracking = null));
    return this.tracking;
  }

  private async listAgentProcesses(): Promise<AgentProcess[]> {
    const roots = this.roots();
    const list = await listProcesses();
    const at = Date.now();
    this.listedAt = at;
    const found = agentProcesses(
      list,
      roots.map((r) => r.pid),
      this.known,
    );
    // Which runtime each one belongs to: the first root it's under (orphans: the only runtime, or unknown).
    const runtimeOf = new Map<number, string>();
    for (const root of roots) for (const d of descendants(list, root.pid)) if (!runtimeOf.has(d.pid)) runtimeOf.set(d.pid, root.label);
    const owners = await this.attribute(list, found, roots, runtimeOf);
    const cores = os.cpus().length || 1;
    const out: AgentProcess[] = found.map((p) => {
      const before = this.lastListing.get(p.pid);
      const cpu = before && at > before.at ? Math.min(100, (100 * (p.cpuTime - before.cpuTime)) / ((at - before.at) / 1000) / cores) : null;
      return {
        pid: p.pid,
        name: p.name,
        // Long command lines (scripts passed inline) are cut; the chat shows the agents' commands in full.
        command: p.command.length > 300 ? `${p.command.slice(0, 300)}…` : p.command,
        memory: p.memory,
        cpu: cpu === null ? null : Math.max(0, Math.round(cpu)),
        started: p.started,
        runtime: runtimeOf.get(p.pid) ?? (roots.length === 1 ? roots[0].label : ""),
        owners: (owners.get(p.pid) ?? []).map(({ projectId, project, agentId, agent }) => ({ projectId, project, agentId, agent })),
      };
    });
    this.lastListing = new Map(found.map((p) => [p.pid, { cpuTime: p.cpuTime, at }]));
    this.known = new Map(found.map((p) => [p.pid, p.started]));
    return out.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.memory - a.memory);
  }

  /**
   * Who started each program: the agent whose background shell it runs under (the runtimes record
   * that); otherwise the agents that were working on its runtime when the shell it runs under started,
   * narrowed to the one whose folder its command line names when several were. Remembered while the
   * program runs, so one whose shell has exited keeps its owner.
   */
  private async attribute(list: ProcessInfo[], found: ProcessInfo[], roots: { pid: number; label: string }[], runtimeOf: Map<number, string>) {
    const result = new Map<number, ProgramOwner[]>();
    if (!this.attribution) return result;
    const byPid = new Map(list.map((p) => [p.pid, p]));
    const rootPids = new Set(roots.map((r) => r.pid));
    const shells = await this.attribution.shells().catch(() => new Map<number, ProgramOwner>());
    const remembered = (p: ProcessInfo) => {
      const r = this.owners.get(p.pid);
      return r && r.started === p.started && r.owners.length ? r.owners : null;
    };
    for (const p of found) {
      const before = remembered(p);
      if (before?.length === 1) {
        result.set(p.pid, before);
        continue;
      }
      // Up from the program to the runtime: [the program, its parent, …, the shell the runtime started].
      const chain: ProcessInfo[] = [];
      let at: ProcessInfo | undefined = p;
      let reached = false;
      while (at && chain.length < 64) {
        chain.push(at);
        const parent = byPid.get(at.parent);
        if (!parent || !childOf(at, parent)) break;
        if (rootPids.has(parent.pid)) {
          reached = true;
          break;
        }
        at = parent;
      }
      let owners: ProgramOwner[] = [];
      const shell = chain.find((c) => shells.has(c.pid));
      const inherited = chain.slice(1).map(remembered).find((o) => o);
      if (shell) owners = [shells.get(shell.pid)!];
      else if (inherited) owners = inherited;
      else if (reached) {
        const entry = chain[chain.length - 1];
        owners = this.attribution.workingAt(entry.started || Date.now(), runtimeOf.get(p.pid) ?? "");
        if (owners.length > 1) {
          const plain = (text: string) => text.toLowerCase().replaceAll("\\", "/");
          const commands = plain(chain.map((c) => c.command).join("\n"));
          const named = owners.filter((o) => o.directory && commands.includes(plain(path.resolve(o.directory))));
          // The deepest folder named (a helper's folder can be inside the project's).
          const longest = Math.max(0, ...named.map((o) => o.directory.length));
          if (named.length) owners = named.filter((o) => o.directory.length === longest);
        }
      }
      if (!owners.length && before) owners = before;
      result.set(p.pid, owners);
    }
    this.owners = new Map(found.map((p) => [p.pid, { started: p.started, owners: result.get(p.pid) ?? [] }]));
    return result;
  }

  /** Stops one of the agents' programs and what it started; only those (checked again now). */
  async stopProcess(pid: number): Promise<AgentProcess> {
    const current = await this.processes();
    const target = current.find((p) => p.pid === pid);
    if (!target) {
      // Two different answers: one means it worked (the program was already gone), the other doesn't.
      if (!isRunning(pid)) throw new Error(`Process ${pid} has already ended: there's nothing to stop.`);
      throw new Error(`Process ${pid} is running, but it isn't a program an agent started, so it can't be stopped from here.`);
    }
    await killTree(pid, target.started);
    this.known.delete(pid);
    return target;
  }
}

/** Below this much free memory the machine counts as overloaded: 10% of it, at least 600 MB. */
export function memoryFloor(total = os.totalmem()): number {
  const fromEnv = Number(process.env.SYMBIO_OVERLOAD_FREE_MB);
  if (fromEnv > 0) return fromEnv * 1024 * 1024;
  return Math.max(total * 0.1, 600 * 1024 * 1024);
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/**
 * By process id only (never by name), with its children. The children come from a listing checked
 * by start time, not from `taskkill /T`, which follows parent ids that Windows may have reused.
 */
async function killTree(pid: number, started: number) {
  const list = await listProcesses().catch(() => []);
  const self = list.find((p) => p.pid === pid);
  if (self && started && self.started !== started) throw new Error(`Process ${pid} has ended (its id now belongs to another program).`);
  if (process.platform === "win32") {
    for (const p of [...descendants(list, pid).reverse(), { pid }]) {
      await execFileAsync("taskkill", ["/PID", String(p.pid), "/F"], { windowsHide: true }).catch((err) => {
        // A child may have ended on its own meanwhile; only the program itself must stop.
        if (p.pid === pid) throw new Error(`Could not stop process ${pid}: ${String(err.stderr || err.message).trim()}`);
      });
    }
    return;
  }
  for (const p of [...descendants(list, pid).reverse(), { pid }]) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** What core and helpers are told about this computer (their briefs). */
export function machineNote(): string {
  const cores = os.cpus().length;
  const gb = Math.round(os.totalmem() / 1024 ** 3);
  const small = cores <= 4 || gb <= 8;
  return (
    `This computer: ${cores} CPU threads, ${gb} GB of memory.` +
    (small
      ? " It's a small machine: run one heavy job at a time across the whole team (3D modeling and rendering, builds, " +
        "browsers and test runs, simulations, video), don't start heavy work in two helpers at once, give long jobs a " +
        "time limit, and close what you start when you're done with it."
      : " Heavy jobs (builds, rendering, browsers, simulations) still add up: don't run several at once without a reason, " +
        "and close what you start when you're done with it.") +
    " Programs you start run at low priority so the computer stays usable; Symbio tells the team when the machine is overloaded."
  );
}
