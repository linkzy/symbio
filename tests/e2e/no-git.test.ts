// Projects without git: with git missing, the New project dialog says what that means and how to
// get it (and checks again); with git there but broken, creating a project still works, without
// git, and the human is told why.
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

async function symbioWithPath(dirs: string) {
  const symbio = await startSymbio({ PATH: dirs, Path: dirs });
  running.push(symbio);
  return symbio;
}

test("git missing: the dialog says what it changes and how to install it; the project works without it", async () => {
  const symbio = await symbioWithPath(withoutGit);
  const { page } = await openPage(symbio);
  await page.locator("button", { hasText: "New project" }).first().click();
  await page.getByPlaceholder("C:\\Users\\you\\projects\\my-project").fill(symbio.folder("plain"));
  const notice = page.locator('[data-testid="no-git"]');
  await notice.locator("div", { hasText: "Git isn't installed. Without it, helpers share the project folder" }).first().waitFor();
  assert.equal(await notice.locator("a", { hasText: "git-scm.com" }).getAttribute("href"), "https://git-scm.com/downloads");
  assert.equal(await page.locator(".choice", { hasText: "git" }).count(), 0, "no git option to tick");
  await notice.getByRole("button", { name: "Check again" }).click();
  await notice.waitFor(); // still missing, still said
  assert.deepEqual((page as any).errors, []);
});

test("git there but broken: the project is created without it, and the human is told why", async () => {
  // A "git" that answers --version but fails at everything else: Node, renamed.
  const bin = path.join(os.tmpdir(), `symbio-fake-git-${process.pid}`);
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, path.join(bin, process.platform === "win32" ? "git.exe" : "git"));
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
