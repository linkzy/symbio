// Settings → About, the last tab: what Symbio is, what leaves the computer, and the usage
// statistics (the install id) with their switch. A development copy sends none, and says so.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, openPage, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("About: the last tab, with privacy and the usage statistics explained", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  const tabs = page.locator(".settings-tab");
  assert.equal(await tabs.last().getAttribute("data-group"), "about", "dead last");
  await tabs.last().click();
  await page.locator("#about h2", { hasText: "About Symbio" }).waitFor();
  await page.locator("#about", { hasText: "Free and open source (MIT)" }).waitFor();
  await page.locator("#privacy li", { hasText: "Your conversations with the agents go to the model provider you chose" }).waitFor();
  const stats = page.locator('[data-testid="telemetry"]');
  await stats.locator("h2", { hasText: "Usage statistics" }).waitFor();
  await stats.locator("li", { hasText: "carries Symbio's version and this copy's id" }).waitFor();
  await stats.locator("li", { hasText: "Never: your name, your projects" }).waitFor();
  // This copy runs from Symbio's development folder: no id, no switch, and it says why.
  await stats.locator("p", { hasText: "runs from a development folder" }).waitFor();
  assert.equal(await stats.getByRole("checkbox").count(), 0);
  // Updates no longer holds the switch: a line points here.
  await page.goto(`${symbio.base}/#/settings/computer`);
  await page.locator("#updates, section", { hasText: "Updates" }).first().waitFor();
  assert.equal(await page.locator('[data-testid="install-id"]').count(), 0);
  assert.deepEqual((page as any).errors, []);
});
