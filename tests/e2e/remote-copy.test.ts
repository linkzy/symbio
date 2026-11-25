// Remote access: one button copies the link and code together, another copies the code alone, and
// a share button hands the same text to the system share sheet (or copies it where there is none).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { clipboardText, closeBrowser, openPage, ownClipboard, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("remote access: copy the link and code together, and share them", async () => {
  const { page, context } = await openPage(symbio);
  await ownClipboard(context);
  // As if remote access were on: the link and code come from the server, and standing up a real
  // one here would need a tunnel out to the internet.
  await page.route("**/api/remote", (route) =>
    route.fulfill({ json: { active: true, url: "https://try-abc123.symbio.link", code: "12345678", startedAt: Date.now(), sessions: 0 } }),
  );
  await page.goto(`${symbio.base}/#/settings`);
  const shareText = "Symbio: https://try-abc123.symbio.link\nAccess code: 1234-5678";
  await page.locator("a", { hasText: "https://try-abc123.symbio.link" }).waitFor();
  const clipboard = () => clipboardText(page);

  // "Copy link and code" copies both together.
  await page.locator('button[title="Copy link and code"]').click();
  await until("the link and code to be copied together", async () => (await clipboard()) === shareText);
  await page.locator('button[title="Link and code copied"]').first().waitFor();

  // The code on its own.
  await page.locator('button[title="Copy access code"]').click();
  await until("the access code to be copied on its own", async () => (await clipboard()) === "1234-5678");
  await page.locator('button[title="Access code copied"]').waitFor();

  // Share hands the same text to the share sheet... (strings, not functions: tsx's helpers don't exist in the page)
  await page.evaluate(`window.__shared = null; Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => { window.__shared = data.text; } });`);
  await page.locator('button[title="Share"]').click();
  await until("the link and code to be shared", async () => (await page.evaluate("window.__shared")) === shareText);

  // ...and where there is none, copies it.
  await page.evaluate(`Object.defineProperty(navigator, "share", { configurable: true, value: undefined });`);
  await page.locator('button[title="Share"]').click();
  await until("the link and code to be copied from the share button", async () => (await clipboard()) === shareText);
  await page.locator('button[title="Link and code copied"]').first().waitFor();
  assert.deepEqual((page as any).errors, []);
});
