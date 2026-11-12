// The chat and the team, end to end: a reply in the chat, drafts that survive leaving the chat,
// a helper in its own copy whose committed work core merges.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, gitRepo, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

/** A script line for the stand-in model; JSON arguments keep to one line. */
const step = (agent: string, kind: string, rest: string | object = "") => `@${agent} ${kind} ${typeof rest === "string" ? rest : JSON.stringify(rest)}`.trimEnd();

test("chat: a reply arrives in the chat, and a draft survives other tabs and a reload", async () => {
  const { project } = await projectWithCore(symbio, "Chat check");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  const box = page.locator(".composer textarea");
  await box.fill(["Hello there", step("core", "say", "Hi! What are we building?")].join("\n"));
  await page.locator(".composer button[title=Send]").click();
  await page.locator(".msg-assistant", { hasText: "Hi! What are we building?" }).first().waitFor();
  assert.equal(await box.inputValue(), "", "the box is empty after sending");

  await box.fill("A half-written thought");
  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator("button.tab", { hasText: "Chat" }).click();
  assert.equal(await page.locator(".composer textarea").inputValue(), "A half-written thought", "kept after another tab");
  await page.reload();
  assert.equal(await page.locator(".composer textarea").inputValue(), "A half-written thought", "kept after a reload");
  assert.deepEqual((page as any).errors, [], "no errors in the page");
});

test("team: core spawns a helper in its own copy; the helper commits; core merges its work", async () => {
  const directory = gitRepo(symbio.folder("team-project"));
  const { project, core } = await projectWithCore(symbio, "Team check", { directory });
  const helperScript = [
    step("writer", "write", "notes.txt Written by the helper"),
    step("writer", "shell", "git add -A"),
    step("writer", "shell", "git -c user.name=writer -c user.email=w@example.invalid commit -qm notes"),
    step("writer", "tool", "send_message " + JSON.stringify({ to: "core", message: "notes.txt is committed" })),
  ].join("\n");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
    text: step("core", "tool", "spawn_agent " + JSON.stringify({ name: "writer", purpose: "Writes notes", task: helperScript, workspace: "own" })),
  });
  await idle(symbio, project.id);

  const team = (await symbio.call("GET", `/projects/${project.id}`)).agents;
  const writer = team.find((a: any) => a.name === "writer");
  assert.ok(writer, "the helper exists");
  assert.ok(writer.branch, "it works on its own branch");
  assert.notEqual(path.resolve(writer.directory), path.resolve(directory), "in its own copy");
  assert.ok(existsSync(path.join(writer.directory, "notes.txt")), "it wrote the file in its copy");
  assert.ok(!existsSync(path.join(directory, "notes.txt")), "not yet in the project");
  assert.match(await history(symbio, project.id, core.id), /notes\.txt is committed/, "core got the helper's report");

  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: step("core", "tool", 'merge_work {"agent":"writer"}') });
  await idle(symbio, project.id);
  await until("the merged file in the project", () => existsSync(path.join(directory, "notes.txt")));
  assert.match(readFileSync(path.join(directory, "notes.txt"), "utf8"), /Written by the helper/);

  // And the browser shows the helper in the team.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".agent-row", { hasText: "writer" }).waitFor();
});
