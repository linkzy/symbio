// The programs agents started, from a process listing: what runs under a runtime's shells, and
// programs seen that way before whose parent has exited since.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentProcesses, descendants, MachineMonitor, parseWindowsListing, type ProcessInfo } from "../src/server/machine.js";

const p = (pid: number, parent: number, name: string, started = 1): ProcessInfo => ({ pid, parent, name, command: name, memory: 1, cpuTime: 0, started });

test("agents' programs: under a runtime's shells, without the shells or the runtime's own helpers", () => {
  const list = [
    p(10, 1, "opencode.exe"),
    p(11, 10, "node.exe"), // the runtime's own helper (a language server): not an agent's program
    p(12, 10, "pwsh.exe"),
    p(13, 12, "blender.exe"),
    p(14, 13, "blender-worker.exe"),
    p(15, 12, "conhost.exe"), // Windows' console host for the shell: not a program of its own
    p(20, 1, "msedge.exe"), // the user's own browser
  ];
  assert.deepEqual(agentProcesses(list, [10], new Map()).map((x) => x.pid).sort(), [13, 14]);
});

test("a program seen before keeps counting after its parent exits; a reused pid doesn't", () => {
  const before = [p(10, 1, "opencode.exe"), p(12, 10, "cmd.exe"), p(13, 12, "node.exe"), p(15, 13, "msedge.exe", 5)];
  const known = new Map(agentProcesses(before, [10], new Map()).map((x) => [x.pid, x.started]));
  // The script that launched the browser ended: the browser (and what it started) is still the agents'.
  const after = [p(10, 1, "opencode.exe"), p(15, 999, "msedge.exe", 5), p(16, 15, "msedge.exe", 6)];
  assert.deepEqual(agentProcesses(after, [10], known).map((x) => x.pid).sort(), [15, 16]);
  // The same pid, started at another time, is someone else's.
  const reused = [p(10, 1, "opencode.exe"), p(15, 999, "msedge.exe", 50)];
  assert.deepEqual(agentProcesses(reused, [10], known), []);
});

test("a process whose parent id now belongs to an agent's shell isn't the agent's (Windows reuses ids)", () => {
  const list = [
    p(10, 1, "opencode.exe", 100),
    p(12, 10, "pwsh.exe", 200), // a new shell got pid 12…
    p(13, 12, "node.exe", 210), // …and runs this
    p(40, 12, "wininit.exe", 5), // started long before, by an earlier pid 12 that exited at boot
    p(41, 40, "services.exe", 6),
    p(42, 41, "MsMpEng.exe", 7),
  ];
  assert.deepEqual(agentProcesses(list, [10], new Map()).map((x) => x.pid), [13]);
  assert.deepEqual(descendants(list, 12).map((x) => x.pid), [13]);
});

test("a Windows listing with a raw control character in a command line still parses", () => {
  const out = '[{"p":10,"q":1,"n":"odd.exe","c":"odd.exe --title \u0007bell\u001b[0m","m":1,"t":0,"s":0},{"p":11,"q":1,"n":"ok.exe","c":null,"m":2,"t":0,"s":0}]';
  const list = parseWindowsListing(out);
  assert.deepEqual(list.map((p) => [p.pid, p.command]), [[10, "odd.exe --title  bell [0m"], [11, "ok.exe"]]);
});

test("stop_program tells an ended program apart from one that isn't an agent's", async () => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const machine = new MachineMonitor(mkdtempSync(path.join(os.tmpdir(), "symbio-machine-")), () => [], () => false);
  await assert.rejects(machine.stopProcess(process.pid), /is running, but it isn't a program an agent started/);
  await assert.rejects(machine.stopProcess(2 ** 30), /has already ended: there's nothing to stop/);
});
