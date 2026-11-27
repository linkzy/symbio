// Symbio ships no agent runtime: a first run explains what one is and walks through what's needed
// (a runtime installed for Symbio, or the one already on the computer; the models; git; then a
// project), installs the one the human picks (here with a stand-in for npm that "installs" the
// stand-in runtimes), offers only installed ones for new projects, and installs again one that
// existing projects use but that's missing. A Copilot CLI on the computer is mentioned, not used.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { closeBrowser, idle, MODEL, openPage, RUNTIME, startSymbio, until, type Symbio } from "./harness.js";

const OTHER = RUNTIME === "copilot" ? "opencode" : "copilot";
const LABEL = { opencode: "OpenCode", copilot: "GitHub Copilot CLI" } as const;

// Nothing installed: no runtime from the environment, nor from Symbio's own node_modules.
// Given an earlier instance's folder, the same data (Symbio's, and the runtimes').
const freshEnv = (root?: string): Record<string, string> => ({
  SYMBIO_OPENCODE_BIN: "",
  SYMBIO_COPILOT_SDK: "",
  SYMBIO_NO_DEV_RUNTIMES: "1",
  SYMBIO_RUNTIME_INSTALLER: path.resolve(import.meta.dirname, "fake-installer.mjs"),
  ...(root
    ? Object.fromEntries([
        ["SYMBIO_HOME", path.join(root, "home")],
        ...["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((k) => [k, path.join(root, k)]),
      ])
    : {}),
});

// A real launcher on PATH that starts the stand-in OpenCode: .cmd on Windows (npm's shims are
// batch files), a shell script elsewhere. Nothing here touches the human's own OpenCode.
function fakeOpenCodeOnPath(root: string): Record<string, string> {
  const dir = path.join(root, "path-bin");
  mkdirSync(dir, { recursive: true });
  const source = path.resolve(import.meta.dirname, "fake-opencode.mjs");
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "opencode.cmd"), `@echo off\r\nnode "${source}" %*\r\n`);
  } else {
    const file = path.join(dir, "opencode");
    writeFileSync(file, `#!/bin/sh\nexec node "${source}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  const value = `${dir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  return { PATH: value, Path: value };
}

const running: Symbio[] = [];
after(async () => {
  await closeBrowser();
  for (const s of running) await s.stop();
});

test("a first run asks for an agent runtime, installs the one chosen, and offers only that one", async () => {
  const symbio = await startSymbio(freshEnv());
  running.push(symbio);
  const runtimes = await symbio.call("GET", "/runtimes");
  assert.deepEqual(
    runtimes.map((r: any) => [r.kind, r.installed]),
    [
      ["opencode", false],
      ["copilot", false],
    ],
  );

  const { page } = await openPage(symbio);
  const firstRun = page.locator('[data-testid="first-run"]');
  await firstRun.locator("h2", { hasText: "Getting started" }).waitFor();
  await firstRun.locator("p", { hasText: "Agents run on an agent runtime: a program like OpenCode or GitHub Copilot CLI." }).waitFor();
  assert.ok(await firstRun.locator('li[data-step="project"] button', { hasText: "New project" }).isDisabled(), "not before a runtime and models");
  assert.ok(await page.locator(".page-head button", { hasText: "New project" }).isDisabled(), "nothing to run agents on yet");
  // A project can't be created on a runtime that isn't installed.
  await assert.rejects(
    symbio.call("POST", "/projects", { name: "early", directory: symbio.folder("early"), coordinatorModel: MODEL, allowedModels: [MODEL], runtime: RUNTIME }),
    /isn't installed/,
  );

  const card = firstRun.locator(`.runtime-card[data-runtime="${RUNTIME}"]`);
  await card.locator("p", { hasText: "a separate copy in Symbio's own folder: it doesn't touch, replace or update one already on this computer" }).waitFor();
  await card.locator("button", { hasText: "Install it for Symbio" }).click();
  // Installed, then the models: the stand-ins come with them (OpenCode's provider, Copilot signed in).
  await firstRun.locator('li[data-step="runtime"].done', { hasText: `${LABEL[RUNTIME]} · installed for Symbio` }).waitFor({ timeout: 20_000 });
  await firstRun.locator('li[data-step="models"].done').waitFor({ timeout: 20_000 });
  assert.ok(existsSync(path.join(symbio.root, "home", "runtimes", RUNTIME, "runtime.json")), "installed in Symbio's folder");

  // New project, from the last step: only the installed runtime.
  await firstRun.locator('li[data-step="project"] button', { hasText: "New project" }).click();
  await page.getByPlaceholder("my-project", { exact: false }).fill(symbio.folder("first"));
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();
  await page.locator(".runtime-choice .choice", { hasText: LABEL[RUNTIME] }).waitFor();
  assert.equal(await page.locator(".runtime-choice .choice").count(), 1, `${LABEL[OTHER]} isn't offered`);
  assert.ok(await page.getByRole("radio", { name: new RegExp(LABEL[RUNTIME]) }).isChecked());
  await page.keyboard.press("Escape");

  // Settings: the installed one can be removed, the other installed.
  await page.goto(`${symbio.base}/#/settings`);
  await page.locator(`.runtime-card[data-runtime="${RUNTIME}"] .list-sub`, { hasText: "Installed" }).waitFor();
  await page.locator(`.runtime-card[data-runtime="${OTHER}"] button`, { hasText: "Install" }).waitFor();
  assert.deepEqual((page as any).errors, []);
});

test("a runtime agents run on can't be removed; one projects use is installed again when missing", async () => {
  const symbio = await startSymbio(freshEnv());
  running.push(symbio);
  await symbio.call("POST", `/runtimes/${RUNTIME}/install`);
  await until("the install", async () => (await symbio.call("GET", "/runtimes")).find((r: any) => r.kind === RUNTIME).installed, 20_000, symbio.output);
  const project = await symbio.call("POST", "/projects", {
    name: "kept",
    directory: symbio.folder("kept"),
    coordinatorModel: MODEL,
    allowedModels: [MODEL],
    runtime: RUNTIME,
  });
  await symbio.call("POST", `/projects/${project.id}/start`);
  await idle(symbio, project.id);
  await assert.rejects(symbio.call("DELETE", `/runtimes/${RUNTIME}`), /stop them first/);

  // The copy is gone (as after updating from a Symbio that came with OpenCode): the next start installs it.
  const home = path.join(symbio.root, "home");
  await symbio.stop();
  rmSync(path.join(home, "runtimes", RUNTIME), { recursive: true, force: true });
  const again = await startSymbio(freshEnv(symbio.root));
  running.push(again);
  await until("the runtime to be installed again", async () => (await again.call("GET", "/runtimes")).find((r: any) => r.kind === RUNTIME).installed, 20_000, again.output);
  assert.match(again.output(), /isn't installed, and projects use it/);
  await idle(again, project.id);
  const core = (await again.call("GET", `/projects/${project.id}`)).agents[0];
  assert.notEqual(core.status, "error", "core carries on");
  assert.equal((await again.call("GET", "/runtimes")).find((r: any) => r.kind === OTHER).installed, false, "only what projects use");

  // Without agents on it, it can be removed.
  await again.call("DELETE", `/projects/${project.id}`);
  await again.call("DELETE", `/runtimes/${RUNTIME}`);
  assert.equal((await again.call("GET", "/runtimes")).find((r: any) => r.kind === RUNTIME).installed, false);
  assert.ok(!existsSync(path.join(home, "runtimes", RUNTIME)));
});

test(
  "an OpenCode on PATH can be opted into, and Symbio downloads nothing",
  { skip: RUNTIME === "copilot" && "the PATH opt-in is OpenCode-only" },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sym-e2e-path-"));
    const symbio = await startSymbio({ ...freshEnv(root), SYMBIO_OPENCODE_BIN: "", ...fakeOpenCodeOnPath(root) });
    running.push(symbio);

    assert.deepEqual(
      (await symbio.call("GET", "/runtimes")).map((r: any) => [r.kind, r.installed, r.source]),
      [
        ["opencode", false, null],
        ["copilot", false, null],
      ],
      "off by default, even with an executable on PATH",
    );
    assert.equal((await symbio.call("GET", "/runtime/settings")).pathAvailable, true);

    // Chosen on the first run, with its version and the one Symbio is tested with.
    const { page } = await openPage(symbio);
    const card = page.locator('[data-testid="first-run"] .runtime-card[data-runtime="opencode"]');
    await card.locator("p", { hasText: "Found on this computer 9.9.9. Symbio is tested with" }).waitFor();
    await card.locator("button", { hasText: "Use the one on this computer 9.9.9" }).click();
    await page.locator('li[data-step="runtime"].done', { hasText: "OpenCode · the one on this computer" }).waitFor({ timeout: 10_000 });
    await until("the PATH OpenCode to be used", async () => {
      const r = (await symbio.call("GET", "/runtimes")).find((x: any) => x.kind === "opencode");
      return r.installed && r.source === "path";
    }, 10_000, symbio.output);

    const views = await symbio.call("GET", "/runtimes");
    const opencode = views.find((r: any) => r.kind === "opencode");
    assert.equal(opencode.removable, false, "there's no Symbio copy to remove");
    await assert.rejects(symbio.call("DELETE", "/runtimes/opencode"), /wasn't installed by Symbio/);
    assert.equal(existsSync(path.join(symbio.root, "home", "runtimes", "opencode")), false, "nothing was downloaded");

    const project = await symbio.call("POST", "/projects", {
      name: "from-path",
      directory: symbio.folder("from-path"),
      coordinatorModel: MODEL,
      allowedModels: [MODEL],
      runtime: "opencode",
    });
    await symbio.call("POST", `/projects/${project.id}/start`);
    await idle(symbio, project.id);
    assert.equal((await symbio.call("GET", "/runtime")).runtimes.find((r: any) => r.kind === "opencode").state, "running");
    assert.equal((await symbio.call("GET", "/runtime/settings")).usePathOpenCode, true, "the choice is persisted");
    // Settings: the same choice in the card, turned off from there.
    await page.goto(`${symbio.base}/#/settings`);
    const settingsCard = page.locator('#runtimes .runtime-card[data-runtime="opencode"]');
    await settingsCard.locator(".list-sub", { hasText: "Using the one on this computer" }).waitFor();
    assert.equal(await settingsCard.getByRole("checkbox", { name: "Use the one on this computer 9.9.9" }).isChecked(), true);
    assert.deepEqual((page as any).errors, []);
  },
);

test("a GitHub Copilot CLI on the computer is mentioned, with why Symbio installs its own", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sym-e2e-copilot-cli-"));
  const dir = path.join(root, "path-bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, "version.mjs"), 'console.log("GitHub Copilot CLI 1.0.116.")');
  if (process.platform === "win32") writeFileSync(path.join(dir, "copilot.cmd"), `@echo off\r\nnode "${path.join(root, "version.mjs")}" %*\r\n`);
  else {
    writeFileSync(path.join(dir, "copilot"), `#!/bin/sh\nexec node "${path.join(root, "version.mjs")}" "$@"\n`);
    chmodSync(path.join(dir, "copilot"), 0o755);
  }
  const value = `${dir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  const symbio = await startSymbio({ ...freshEnv(root), PATH: value, Path: value });
  running.push(symbio);
  const { page } = await openPage(symbio);
  const note = page.locator('[data-testid="first-run"] .runtime-card[data-runtime="copilot"] [data-testid="computer-copy"]');
  await note.filter({ hasText: "GitHub Copilot CLI 1.0.116 is on this computer. Symbio can't run agents on it" }).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('[data-testid="first-run"] .runtime-card[data-runtime="copilot"] button', { hasText: "Use the one on this computer" }).count(), 0);
  await assert.rejects(symbio.call("PUT", "/runtime/settings", { kind: "copilot", fromComputer: true }), /can't run GitHub Copilot CLI from the computer's copy/);
  assert.deepEqual((page as any).errors, []);
});

test("first run with GitHub Copilot signed out: the models step is signing in", async () => {
  const symbio = await startSymbio({ ...freshEnv(), SYMBIO_FAKE_COPILOT_SIGNED_OUT: "1" });
  running.push(symbio);
  await symbio.call("POST", "/runtimes/copilot/install");
  await until("the install", async () => (await symbio.call("GET", "/runtimes")).find((r: any) => r.kind === "copilot").installed, 20_000, symbio.output);
  const { page } = await openPage(symbio);
  const models = page.locator('[data-testid="first-run"] li[data-step="models"]');
  // Copilot is started to read its sign-in: signed out, the step asks for it.
  await models.locator("span", { hasText: "sign in with your GitHub account" }).waitFor({ timeout: 20_000 });
  await models.getByRole("button", { name: "Sign in with GitHub" }).waitFor();
  assert.ok(await page.locator('li[data-step="project"] button', { hasText: "New project" }).isDisabled());
  assert.deepEqual((page as any).errors, []);
});
