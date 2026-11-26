// Projects without git: with git missing, the New project dialog shows the git option off and
// disabled, says why and how to get it (install, download, check again, which finds a git installed
// meanwhile); with git there but broken, creating a project still works, without git, and the
// human is told why.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { closeBrowser, MODEL, openPage, RUNTIME, startSymbio, until, type Symbio } from "./harness.js";

const running: Symbio[] = [];
after(async () => {
  await closeBrowser();
  for (const s of running) await s.stop();
});

// The PATH without any git on it (the tests' machines have one).
const sep = process.platform === "win32" ? ";" : ":";
const withoutGit = (process.env.PATH ?? process.env.Path ?? "")
  .split(sep)
  .filter((dir) => !/[\\/]git([\\/]|$)/i.test(dir) && !/[\\/]Git[\\/]/.test(dir))
  .join(sep);

// A program that answers --version and fails at everything else: Node, renamed.
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
function fakeProgram(name: string): string {
  const bin = path.join(os.tmpdir(), `symbio-fake-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, path.join(bin, exe(name)));
  return bin;
}

// SYMBIO_GIT_SEARCH: where Symbio looks for a git installed while it runs (none, unless given).
async function symbioWithPath(dirs: string, gitSearch = "") {
  const symbio = await startSymbio({ PATH: dirs, Path: dirs, SYMBIO_GIT_SEARCH: gitSearch });
  running.push(symbio);
  return symbio;
}

test("git missing: the option is off and disabled, with why and how to get it; a git installed meanwhile is found", async () => {
  // A winget that fails, so "Install git" shows its error instead of installing anything.
  const winget = fakeProgram("winget");
  const installed = path.join(os.tmpdir(), `symbio-git-later-${process.pid}-${Date.now()}`);
  mkdirSync(installed, { recursive: true });
  const symbio = await symbioWithPath(`${winget}${sep}${withoutGit}`, installed);
  const { page } = await openPage(symbio);
  await page.locator("button", { hasText: "New project" }).first().click();
  await page.getByPlaceholder("C:\\Users\\you\\projects\\my-project").fill(symbio.folder("plain"));
  const notice = page.locator('[data-testid="no-git"]');
  await notice.locator("div", { hasText: "Git isn't installed. Without it, helpers share the project folder" }).first().waitFor();
  const option = page.locator(".choice", { hasText: "Set up version history (git)" }).locator("input");
  assert.equal(await option.isDisabled(), true, "the option is shown, disabled");
  assert.equal(await option.isChecked(), false, "and off");
  assert.equal(await notice.locator("a", { hasText: "Download git" }).getAttribute("href"), "https://git-scm.com/downloads");
  if (process.platform === "win32") {
    await notice.getByRole("button", { name: "Install git" }).click();
    await notice.locator(".error", { hasText: "Couldn't install git" }).waitFor();
  }
  await notice.getByRole("button", { name: "Check again" }).click();
  await notice.waitFor(); // still missing, still said
  // Installed meanwhile, where installers put it (not on Symbio's PATH): Check again finds it.
  copyFileSync(process.execPath, path.join(installed, exe("git")));
  await notice.getByRole("button", { name: "Check again" }).click();
  await notice.waitFor({ state: "detached" });
  assert.equal(await option.isDisabled(), false);
  assert.equal(await option.isChecked(), true, "on, as for anyone with git");
  assert.deepEqual((page as any).errors, []);
});

test("git there but broken: the project is created without it, and the human is told why", async () => {
  const bin = fakeProgram("git");
  const symbio = await symbioWithPath(`${bin}${sep}${withoutGit}`);
  const directory = symbio.folder("broken-git");
  const project = await symbio.call("POST", "/projects", { name: "Broken git", directory, coordinatorModel: MODEL, allowedModels: [MODEL], runtime: RUNTIME, initGit: true });
  assert.ok(project.id, "created anyway");
  assert.ok(project.gitError, "with the reason");
  const log = await symbio.call("GET", `/projects/${project.id}/log`);
  assert.ok(log.some((m: any) => m.kind === "alert" && /Couldn't set up git in the project folder/.test(m.text)));
  const inspection = await symbio.call("GET", `/inspect?dir=${encodeURIComponent(directory)}`);
  assert.equal(inspection.isGit, false, "no half-made repository left behind");
  const { coordinator } = await symbio.call("POST", `/projects/${project.id}/start`);
  await until("core to start", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.some((a: any) => a.id === coordinator.id));
});
