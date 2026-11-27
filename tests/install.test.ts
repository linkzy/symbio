// Finding and installing agent runtimes (runtime/install.ts): Symbio ships none.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-install-home-"));
const { findOnPath, hasInstalledCopy, locate, RuntimeInstaller, runtimesDir, testedVersion } = await import("../src/server/runtime/install.js");
const { loadRuntimeSettings, setFromComputer } = await import("../src/server/runtime/settings.js");

const standIn = path.resolve(import.meta.dirname, "e2e", "fake-installer.mjs");
const saved = { ...process.env };
// A fake executable on a temporary PATH: finding it only needs a file, running it is tested in e2e.
const pathDir = mkdtempSync(path.join(os.tmpdir(), "sym-path-bin-"));
const pathName = process.platform === "win32" ? "opencode.exe" : "opencode";
const pathExe = path.join(pathDir, pathName);
writeFileSync(pathExe, "");
if (process.platform !== "win32") chmodSync(pathExe, 0o755);
const usePath = () => {
  process.env.PATH = `${pathDir}${path.delimiter}${saved.PATH ?? ""}`;
};
afterEach(async () => {
  for (const k of ["SYMBIO_OPENCODE_BIN", "SYMBIO_COPILOT_SDK", "SYMBIO_NO_DEV_RUNTIMES", "SYMBIO_RUNTIME_INSTALLER", "SYMBIO_FAKE_INSTALL_FAILS"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (saved.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = saved.PATH;
  await setFromComputer("opencode", false);
});

test("a development checkout finds the runtimes in its own node_modules, at the versions it installs", () => {
  delete process.env.SYMBIO_OPENCODE_BIN;
  delete process.env.SYMBIO_COPILOT_SDK;
  for (const kind of ["opencode", "copilot"] as const) {
    const found = locate(kind);
    assert.equal(found?.source, "development", kind);
    assert.ok(existsSync(found!.entry), kind);
    // The installed version is the one Symbio is developed and tested with.
    assert.ok(testedVersion(kind).includes(found!.version!.split(".").slice(0, 2).join(".")), kind);
  }
});

test("without one installed (nor in the environment), a runtime isn't found", () => {
  process.env.SYMBIO_NO_DEV_RUNTIMES = "1";
  process.env.SYMBIO_OPENCODE_BIN = "  ";
  assert.equal(locate("opencode"), null);
  process.env.SYMBIO_OPENCODE_BIN = "/somewhere/opencode";
  assert.deepEqual(locate("opencode"), { entry: "/somewhere/opencode", source: "environment", version: null });
});

test("installing writes where the runtime starts; a failed install leaves nothing behind", async () => {
  process.env.SYMBIO_NO_DEV_RUNTIMES = "1";
  delete process.env.SYMBIO_COPILOT_SDK;
  process.env.SYMBIO_RUNTIME_INSTALLER = standIn;
  const installer = new RuntimeInstaller();
  const changes: string[] = [];
  installer.on("change", (kind) => changes.push(kind));

  process.env.SYMBIO_FAKE_INSTALL_FAILS = "copilot";
  await assert.rejects(installer.install("copilot"), /couldn't reach the registry/);
  assert.match(installer.state("copilot").error!, /couldn't reach the registry/);
  assert.equal(existsSync(path.join(runtimesDir(), "copilot")), false);
  assert.equal(locate("copilot"), null);

  delete process.env.SYMBIO_FAKE_INSTALL_FAILS;
  // Asking twice while it installs is one install.
  const first = installer.install("copilot");
  assert.equal(installer.install("copilot"), first);
  assert.equal(installer.state("copilot").installing, true);
  await first;
  const found = locate("copilot");
  assert.equal(found?.source, "symbio");
  assert.equal(found?.entry, path.resolve(import.meta.dirname, "e2e", "fake-copilot.mjs"));
  assert.equal(JSON.parse(readFileSync(path.join(runtimesDir(), "copilot", "runtime.json"), "utf8")).kind, "copilot");
  assert.deepEqual(installer.state("copilot"), { installing: false, log: [], error: null });
  assert.ok(changes.length >= 4);

  await installer.remove("copilot");
  assert.equal(existsSync(path.join(runtimesDir(), "copilot")), false);
  assert.equal(locate("copilot"), null);
});

test("an OpenCode on PATH is ignored unless the human opts in", async () => {
  process.env.SYMBIO_NO_DEV_RUNTIMES = "1";
  process.env.SYMBIO_OPENCODE_BIN = "  ";
  usePath();
  await setFromComputer("opencode", false);
  assert.equal(findOnPath("opencode")?.source, "path");
  assert.equal(locate("opencode"), null, "off by default");

  await setFromComputer("opencode", true);
  const found = locate("opencode");
  assert.equal(found?.source, "path");
  assert.equal(found?.entry, pathExe);
  assert.equal(found?.version, null);
  assert.equal(loadRuntimeSettings().usePathOpenCode, true, "the opt-in is persisted");
});

test("the PATH opt-in wins over Symbio's copy but not over an explicit override", async () => {
  process.env.SYMBIO_NO_DEV_RUNTIMES = "1";
  process.env.SYMBIO_COPILOT_SDK = "";
  delete process.env.SYMBIO_OPENCODE_BIN;
  process.env.SYMBIO_RUNTIME_INSTALLER = standIn;
  const installer = new RuntimeInstaller();
  await installer.install("opencode");
  assert.equal(locate("opencode")?.source, "symbio");
  assert.equal(hasInstalledCopy("opencode"), true);

  usePath();
  await setFromComputer("opencode", true);
  assert.equal(locate("opencode")?.source, "path", "PATH is preferred once opted in");
  assert.equal(hasInstalledCopy("opencode"), true, "Symbio's copy is still there and removable");

  process.env.SYMBIO_OPENCODE_BIN = "/override/opencode";
  assert.deepEqual(locate("opencode"), { entry: "/override/opencode", source: "environment", version: null });
});

test("relative folders on the PATH are skipped (they'd depend on where Symbio was started)", () => {
  const cwd = process.cwd();
  process.chdir(path.dirname(pathDir));
  try {
    process.env.PATH = path.basename(pathDir);
    assert.equal(findOnPath("opencode"), null);
    process.env.PATH = pathDir;
    assert.equal(findOnPath("opencode")?.entry, pathExe);
  } finally {
    process.chdir(cwd);
  }
});

test("a Copilot CLI on the computer is found, but never run (the SDK needs its own runtime version)", async () => {
  process.env.SYMBIO_NO_DEV_RUNTIMES = "1";
  process.env.SYMBIO_COPILOT_SDK = "";
  const copilot = path.join(pathDir, process.platform === "win32" ? "copilot.cmd" : "copilot");
  writeFileSync(copilot, "");
  usePath();
  await setFromComputer("copilot", true);
  assert.equal(findOnPath("copilot")?.entry, copilot, "found, to mention it");
  assert.equal(locate("copilot"), null, "but not used, even if the setting says so");
});

test("the choice per runtime; OpenCode's earlier setting (usePathOpenCode) still counts", async () => {
  const { writeFileSync: write } = await import("node:fs");
  write(path.join(process.env.SYMBIO_HOME!, "runtime-settings.json"), JSON.stringify({ usePathOpenCode: true }));
  assert.deepEqual(loadRuntimeSettings(), { fromComputer: { opencode: true }, usePathOpenCode: true });
  const saved = await setFromComputer("opencode", false);
  assert.deepEqual(saved, { fromComputer: {}, usePathOpenCode: false });
  assert.deepEqual(JSON.parse(readFileSync(path.join(process.env.SYMBIO_HOME!, "runtime-settings.json"), "utf8")), saved, "written for older versions too");
});

test("the version of a copy on the computer is read from --version, once per file", async () => {
  const { computerVersion, knownVersion } = await import("../src/server/runtime/install.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-ver-"));
  const script = path.join(dir, "v.mjs");
  writeFileSync(script, 'console.log("GitHub Copilot CLI 1.0.116.")');
  const exe = path.join(dir, process.platform === "win32" ? "tool.cmd" : "tool");
  writeFileSync(exe, process.platform === "win32" ? `@node "${script}" %*\r\n` : `#!/bin/sh\nexec node "${script}" "$@"\n`);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  const found = { entry: exe, source: "path" as const, version: null, ...(process.platform === "win32" ? { shell: true } : {}) };
  assert.equal(knownVersion(found), undefined);
  assert.equal(await computerVersion(found), "1.0.116");
  assert.equal(knownVersion(found), "1.0.116");
});
