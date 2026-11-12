// A folder of several git repositories: the New project dialog keeps them as they are, and a
// helper's work is merged into the repository it was given, not into a repository on top.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, gitRepo, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("several repositories: no repository on top, and merges go to the helper's repository", async () => {
  const root = symbio.folder("game");
  gitRepo(path.join(root, "client"));
  gitRepo(path.join(root, "server"));

  const { page } = await openPage(symbio);
  await page.locator("button", { hasText: "New project" }).first().click();
  await page.getByPlaceholder("my-project", { exact: false }).fill(root);
  await page.locator(".notice", { hasText: "Symbio keeps them as they are" }).waitFor();
  assert.equal(await page.getByText("Set up version history").count(), 0, "no offer to create a repository on top");
  await page.keyboard.press("Escape");

  const { project, core } = await projectWithCore(symbio, "Game", { directory: root });
  const helper = [
    "@api write api.txt endpoints",
    "@api shell git add -A",
    "@api shell git -c user.name=api -c user.email=a@example.invalid commit -qm api",
  ].join("\n");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
    text: `@core tool spawn_agent ${JSON.stringify({ name: "api", purpose: "Server work", task: helper, workspace: "own", repo: "server" })}`,
  });
  await idle(symbio, project.id);
  const api = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "api");
  assert.equal(api?.repo, "server", "the helper works in the server repository");

  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: '@core tool merge_work {"agent":"api"}' });
  await idle(symbio, project.id);
  await until("the merge into server/", () => existsSync(path.join(root, "server", "api.txt")));
  assert.ok(!existsSync(path.join(root, "client", "api.txt")), "nothing in the other repository");
  assert.ok(!existsSync(path.join(root, ".git")), "no repository on top");
});
