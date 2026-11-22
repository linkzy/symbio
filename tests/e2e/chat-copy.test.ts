import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, openPage, projectWithCore, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => { symbio = await startSymbio(); });
after(async () => { await closeBrowser(); await symbio?.stop(); });

const step = (agent: string, kind: string, rest: string | object = "") => `@${agent} ${kind} ${typeof rest === "string" ? rest : JSON.stringify(rest)}`.trimEnd();

test("chat: copy buttons copy a code block and a whole message", async () => {
  const { project } = await projectWithCore(symbio, "Copy check");
  const { page, context } = await openPage(symbio);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${symbio.base}/#/p/${project.id}`);

  const message = ["Here is code:", "```ts", "const n: number = 1", "```", "After."].join("\\n");
  const box = page.locator(".composer textarea");
  await box.fill([`Show code`, step("core", "say", message)].join("\n"));
  await page.locator(".composer button[title=Send]").click();

  const assistant = page.locator(".msg-assistant", { hasText: "Here is code:" }).first();
  await assistant.waitFor();
  await assistant.locator(".msg-copy").first().evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.includes("Here is code:") && t.includes("const n: number = 1")));
  const copiedMessage = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copiedMessage, /Here is code:/);
  assert.match(copiedMessage, /const n: number = 1/);

  const code = assistant.locator(".code-block").first();
  await code.locator(".code-copy").evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.trim() === "const n: number = 1"));
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copiedCode.trim(), "const n: number = 1");

  const user = page.locator(".msg-user", { hasText: "Show code" }).first();
  await user.locator(".msg-copy").evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.trim() === "Show code"));
});
