// Settings → Appearance: picking a theme changes the page's colors at once and is kept in this
// browser across reloads; picking Symbio again goes back to the default look.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
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

test("a theme chosen in Settings applies at once and survives a reload", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/computer`);
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? null);
  const original = await background();
  assert.equal(await theme(), null);

  const light = page.locator('[data-theme-id="light-modern"]');
  await light.click();
  assert.equal(await light.getAttribute("aria-checked"), "true");
  assert.equal(await theme(), "light-modern");
  assert.equal(await background(), "#fff");

  await page.reload();
  await page.locator('[data-theme-id="light-modern"][aria-checked="true"]').waitFor();
  assert.equal(await theme(), "light-modern");
  assert.equal(await background(), "#fff");

  await page.locator('[data-theme-id="symbio"]').click();
  assert.equal(await theme(), null);
  assert.equal(await background(), original);
});

test("a VS Code color theme file can be imported, survives a reload and can be removed", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/computer`);
  const token = (name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const fixture = fileURLToPath(new URL("./fixtures/night-harbor-color-theme.json", import.meta.url));

  await page.getByTestId("theme-file").setInputFiles(fixture);
  const card = page.locator('[data-theme-id="custom-night-harbor"]');
  await card.waitFor();
  assert.equal(await card.getAttribute("aria-checked"), "true", "the imported theme is chosen at once");
  assert.equal(await token("--bg"), "#10141c");
  assert.equal(await token("--accent"), "#e07a5f");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark-modern", "on top of Dark Modern");

  await page.reload();
  await page.locator('[data-theme-id="custom-night-harbor"][aria-checked="true"]').waitFor();
  assert.equal(await token("--bg"), "#10141c");

  // Something that isn't a theme is refused with a reason.
  await page.getByTestId("theme-file").setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"hello": 1}') });
  await page.locator(".error", { hasText: 'no "colors"' }).waitFor();

  await page.getByRole("button", { name: "Remove Night Harbor" }).click();
  assert.equal(await card.count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null, "back to the default");
  assert.notEqual(await token("--bg"), "#10141c");
});
