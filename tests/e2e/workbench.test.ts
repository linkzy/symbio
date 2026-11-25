// The Workbench layout (Settings → Appearance): an activity bar with the team and the Explorer, the
// work in the middle, the chat on the right with a switcher; narrow windows keep the classic layout.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, idle, openPage, projectWithCore, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("the Workbench layout keeps the chat on the right while the middle shows the plan or a file", async () => {
  const { project, core } = await projectWithCore(symbio, "Workbench");
  writeFileSync(path.join(project.directory, "brief.md"), "# The brief\n\nWhat we're making.\n");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core say Ready when you are." });
  await idle(symbio, project.id);

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/computer`);
  await page.locator('[data-layout-id="workbench"]').click();
  assert.equal(await page.locator('[data-layout-id="workbench"]').getAttribute("aria-checked"), "true");

  await page.goto(`${symbio.base}/#/p/${project.id}`);
  const chat = page.locator(".wb-chat");
  await chat.locator(".msg-assistant, .md", { hasText: "Ready when you are." }).first().waitFor();
  assert.equal(await page.locator(".wb-center .tab.active").innerText(), "Plan", "the middle starts on the plan");

  // The Explorer opens in the side bar; a file opens as a tab in the middle, the chat stays.
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page.locator(".wb-side .explorer-item", { hasText: "brief.md" }).click();
  await page.locator(".wb-center h1", { hasText: "The brief" }).waitFor();
  assert.match(await page.locator(".wb-center .tab.active").innerText(), /brief\.md/);
  assert.equal(await chat.isVisible(), true);
  await page.getByRole("button", { name: "Close brief.md" }).click();
  assert.equal(await page.locator(".wb-center .tab", { hasText: "brief.md" }).count(), 0);

  // The plan, messages, docs, files and settings open from the activity bar as tabs that close too.
  await page.getByRole("button", { name: "Close Plan" }).click();
  await page.locator(".wb-center", { hasText: "Nothing open" }).waitFor();
  await page.locator(".wb-activity").getByRole("button", { name: "Messages" }).click();
  await page.locator(".wb-activity").getByRole("button", { name: "Project settings" }).click();
  assert.deepEqual(await page.locator(".wb-center .tab").allInnerTexts(), ["Messages", "Settings"]);
  assert.equal(await page.locator(".wb-center .tab.active").innerText(), "Settings");
  await page.getByRole("button", { name: "Close Settings" }).click();
  assert.equal(await page.locator(".wb-center .tab.active").innerText(), "Messages", "closing the open tab shows the one before it");

  // Dragging the chat's border makes it wider, and the width is kept.
  const before = (await chat.boundingBox())!.width;
  const handle = page.getByRole("separator", { name: "Resize the chat" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + 200, { steps: 5 });
  await page.mouse.up();
  const after = (await chat.boundingBox())!.width;
  assert.ok(after > before + 80, `the chat got wider (${before} → ${after})`);
  await page.reload();
  await chat.waitFor();
  assert.ok(Math.abs((await chat.boundingBox())!.width - after) < 2, "the width survives a reload");

  // A narrow window gets the classic layout back.
  await page.setViewportSize({ width: 800, height: 800 });
  await page.locator(".project-view").waitFor();
  assert.equal(await page.locator(".workbench").count(), 0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".workbench").waitFor();

  // Back to Classic from Settings.
  await page.goto(`${symbio.base}/#/settings/computer`);
  await page.locator('[data-layout-id="classic"]').click();
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".project-view").waitFor();
});
