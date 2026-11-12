// A file attached in the chat: uploaded, sent with the message (the agent gets its path), and
// listed in the project's Files tab.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("an attached file reaches the agent and is kept in the Files tab", async () => {
  const { project, core, directory } = await projectWithCore(symbio, "Attachment check");
  const file = path.join(symbio.folder("to-attach"), "brief.txt");
  writeFileSync(file, "The brief for the attachment check.\n");

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator('.composer input[type="file"]').setInputFiles(file);
  await page.locator(".att-chip.ready").waitFor();
  await page.locator(".composer textarea").fill("Here is the brief.");
  await page.locator(".composer button[title=Send]").click();
  await page.locator(".att-chip.sent", { hasText: "brief.txt" }).waitFor();
  await idle(symbio, project.id);

  const text = await history(symbio, project.id, core.id);
  assert.match(text, /Attached by the human/, "the agent got the note");
  const stored = path.join(directory, ".symbio", "attachments").replace(/\\/g, "\\\\\\\\");
  assert.match(text, new RegExp(stored + ".*brief\\.txt"), "with the stored file's full path");

  await page.locator("button.tab", { hasText: "Files" }).click();
  await page.locator(".file-card", { hasText: "brief.txt" }).waitFor();
});
