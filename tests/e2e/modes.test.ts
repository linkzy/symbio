// Chat modes: in Plan, core can't start work (Symbio's tools refuse) or change files (its session
// rules deny edits and writing commands); Act and Auto let it; messages show their mode.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("Plan blocks starting work and changing files; Act lets it; the selector and labels show the mode", async () => {
  const { project, core, directory } = await projectWithCore(symbio, "Modes check");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  const send = async (lines: string[]) => {
    await page.locator(".composer textarea").fill(lines.join("\n"));
    await page.locator(".composer button[title=Send]").click();
    await until("the message to be sent", async () => (await page.locator(".composer textarea").inputValue()) === "");
    await idle(symbio, project.id);
  };
  const spawn = `@core tool spawn_agent ${JSON.stringify({ name: "builder", purpose: "Builds", task: "@builder say on it", workspace: "shared" })}`;

  // Plan: chosen in the chat box, applied at once.
  await page.locator(".mode-seg button", { hasText: "Plan" }).click();
  await until("Plan mode", async () => (await symbio.call("GET", `/projects/${project.id}`)).coreMode === "plan");
  await until("the chat box to show Plan mode", async () => /Plan: nothing starts/.test((await page.locator(".composer textarea").getAttribute("placeholder")) ?? ""));
  await send(["Let's think about it first", spawn, "@core write notes.txt sketch", "@core shell echo draft > draft.txt", "@core shell git --version", "@core say Here's what I propose."]);
  const planned = await history(symbio, project.id, core.id);
  assert.match(planned, /Plan mode: the human wants to discuss and plan before anything starts, so creating helpers is blocked/);
  assert.match(planned, /Permission denied: edit/, "file edits are denied in core's session");
  assert.match(planned, /Permission denied: shell/, "and writing commands");
  assert.match(planned, /git version/, "read-only commands still run");
  assert.ok(!existsSync(path.join(directory, "notes.txt")) && !existsSync(path.join(directory, "draft.txt")), "nothing written");
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).agents.length, 1, "no helper created");
  await page.locator(".msg-user .mode-tag.plan").first().waitFor();

  // Act: the same work goes ahead.
  await page.locator(".mode-seg button", { hasText: "Act" }).click();
  await until("Act mode", async () => (await symbio.call("GET", `/projects/${project.id}`)).coreMode === "act");
  await send(["Go ahead", spawn, "@core write notes.txt sketch"]);
  await until("the helper", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.some((a: any) => a.name === "builder"));
  assert.ok(existsSync(path.join(directory, "notes.txt")), "files can be written again");
  await page.locator(".msg-user .mode-tag.act").first().waitFor();

  // Auto: no label; and helpers' chats have no selector (modes are core's).
  await page.locator(".mode-seg button", { hasText: "Auto" }).click();
  await until("Auto mode", async () => (await symbio.call("GET", `/projects/${project.id}`)).coreMode === "auto");
  await send(["Thanks"]);
  assert.equal(await page.locator(".msg-user", { hasText: "Thanks" }).locator(".mode-tag").count(), 0);
  await page.locator(".agent-row", { hasText: "builder" }).click();
  await page.locator(".composer textarea").waitFor();
  assert.equal(await page.locator(".mode-seg").count(), 0, "no selector in a helper's chat");
});
