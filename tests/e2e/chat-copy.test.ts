// The chat's copy buttons: a whole answer (its text as written), a code block, and the human's own message.
import { after, before, test } from "node:test";
import { clipboardText, closeBrowser, idle, openPage, ownClipboard, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => { symbio = await startSymbio(); });
after(async () => { await closeBrowser(); await symbio?.stop(); });

const step = (agent: string, kind: string, rest: string | object = "") => `@${agent} ${kind} ${typeof rest === "string" ? rest : JSON.stringify(rest)}`.trimEnd();

test("chat: copy buttons copy a code block and a whole message", async () => {
  const { project } = await projectWithCore(symbio, "Copy check");
  const { page, context } = await openPage(symbio);
  await ownClipboard(context);
  await page.goto(`${symbio.base}/#/p/${project.id}`);

  const message = ["Here is code:", "```ts", "const n: number = 1", "```", "After."].join("\\n");
  const box = page.locator(".composer textarea");
  await box.fill([`Show code`, step("core", "say", message)].join("\n"));
  await page.locator(".composer button[title=Send]").click();

  // Copied once the answer is complete (it streams in).
  await idle(symbio, project.id);
  const assistant = page.locator(".msg-assistant", { hasText: "After." }).first();
  await assistant.waitFor();
  // The buttons show on hover; clicked directly here. waitForFunction doesn't wait for a promise, so the clipboard is polled.
  const clipboard = () => clipboardText(page);
  await assistant.locator(".msg-copy").first().evaluate((el) => (el as HTMLButtonElement).click());
  await until("the answer to be copied", async () => (await clipboard()) === ["Here is code:", "```ts", "const n: number = 1", "```", "After."].join("\n"));
  await assistant.locator(".msg-copy[title=Copied]").waitFor();

  const code = assistant.locator(".code-block").first();
  await code.locator(".code-copy").evaluate((el) => (el as HTMLButtonElement).click());
  await until("the code to be copied", async () => (await clipboard()) === "const n: number = 1");

  // The human's message is copied as it was sent.
  const user = page.locator(".msg-user", { hasText: "Show code" }).first();
  await user.locator(".msg-copy").evaluate((el) => (el as HTMLButtonElement).click());
  await until("the message to be copied", async () => (await clipboard()).startsWith("Show code\n@core say Here is code:"));
});
