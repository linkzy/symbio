// The interface language: chosen in Settings → Appearance or from the top bar's menu, applied at once,
// kept in this browser; English is the default and fills in what isn't translated.
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

test("the interface language switches at once, survives a reload, and English comes back from the top bar", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/computer`);
  const lang = () => page.evaluate(() => document.documentElement.lang);
  const settingsLink = page.locator(".topbar a[href='#/settings']");
  assert.equal(await lang(), "en");
  assert.match(await settingsLink.innerText(), /Settings/);

  await page.locator("#appearance").getByRole("radio", { name: "Português (Brasil)" }).click();
  assert.equal(await lang(), "pt-BR");
  assert.match(await settingsLink.innerText(), /Configurações/);

  await page.reload();
  await settingsLink.filter({ hasText: "Configurações" }).waitFor();
  assert.equal(await lang(), "pt-BR");

  await page.locator(".topbar").getByRole("button", { name: "Idioma" }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();
  await settingsLink.filter({ hasText: "Settings" }).waitFor();
  assert.equal(await lang(), "en");
  assert.deepEqual((page as any).errors, []);
});
