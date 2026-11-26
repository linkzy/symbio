// Notifications (Settings → Notifications, and each project's choice in its settings): a webhook set
// up in the page gets a test and then what waits on the human; a tab in the background shows it as
// the system's notification; a project that wants none sends none.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { closeBrowser, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
let hooks: Server;
let telegram: Server;
const received: any[] = [];
const telegramSent: any[] = [];
before(async () => {
  hooks = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.end("ok");
    });
  });
  await new Promise<void>((r) => hooks.listen(0, "127.0.0.1", r));
  // A stand-in for Telegram, where the human already sent /start to the bot.
  telegram = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.url!.split("/").pop();
      if (req.url!.includes("/bot999:")) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, description: "Unauthorized" }));
      const result = method === "getUpdates" ? [{ message: { chat: { id: 42, first_name: "Danilo" } } }] : method === "getMe" ? { username: "my_bot" } : {};
      if (method === "sendMessage") telegramSent.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => telegram.listen(0, "127.0.0.1", r));
  // Gathered for two seconds, not twenty: long enough for a slow machine (CI) to log both questions of one turn.
  symbio = await startSymbio({
    SYMBIO_NOTIFY_GROUP_MS: "2000",
    SYMBIO_TELEGRAM_API: `http://127.0.0.1:${(telegram.address() as { port: number }).port}`,
  });
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
  hooks?.close();
  telegram?.close();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;

// The page's notifications, recorded, with the tab in the background and notifications allowed.
// A string, not a function: tsx's helpers (__name) don't exist in the page.
const BACKGROUND_TAB = `(() => {
  window.__shown = [];
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title, options) { window.__shown.push({ title, body: options?.body ?? "" }); }
    close() {}
  }
  window.Notification = FakeNotification;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
})();`;

test("a webhook set up in Settings gets a test, then what waits on the human; the browser shows it too; a project can turn them off", async () => {
  const { project, core } = await projectWithCore(symbio, "Notified");
  const { page, context } = await openPage(symbio);
  await context.addInitScript(BACKGROUND_TAB);
  await page.evaluate(BACKGROUND_TAB);
  const url = `http://127.0.0.1:${(hooks.address() as { port: number }).port}/hook`;

  await page.goto(`${symbio.base}/#/settings/notifications`);
  const section = page.locator("#notifications");
  const webhook = section.locator('[data-channel="webhook"]');
  await webhook.locator(".choice").click();
  await webhook.locator('input[type="password"]').fill(url);
  await webhook.getByRole("button", { name: "Save", exact: true }).click();
  // The address went to the vault: the page only learns that one is saved.
  await webhook.locator('input[placeholder="Saved (type to replace)"]').waitFor();
  assert.ok(!JSON.stringify(await symbio.call("GET", "/notifications")).includes("/hook"));
  await webhook.getByRole("button", { name: "Send a test" }).click();
  await webhook.locator(".notify-ok", { hasText: "Sent" }).waitFor();
  await until("the test to arrive", () => received.some((r) => r.title === "Symbio: test notification"));

  // What waits on the human: one message for the question and the approval asked together.
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
    text: [tool("core", "ask_human", { question: "Which font for the titles?" }), tool("core", "ask_human", { question: "Which city?" })].join("\n"),
  });
  await idle(symbio, project.id);
  await until("the questions to arrive", () => received.some((r) => r.title === "Notified: needs you (2)"));
  const hook = received.find((r) => r.title === "Notified: needs you (2)");
  assert.equal(hook.body, "• core asks: Which font for the titles?\n• core asks: Which city?");
  assert.equal(hook.content, `${hook.title}\n\n${hook.body}`);
  await until("the tab to show it", async () => ((await page.evaluate("window.__shown")) as any[]).some((n) => n.title === "Notified: needs you (2)"));

  // The project chooses: none.
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Settings" }).click();
  await page.locator('[data-testid="project-notify"]').getByRole("button", { name: "None" }).click();
  await until("the choice to be saved", async () => (await symbio.call("GET", `/projects/${project.id}`)).notify === "off");
  const before = received.length;
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: tool("core", "ask_human", { question: "Which color?" }) });
  await idle(symbio, project.id);
  await new Promise((r) => setTimeout(r, 3000)); // longer than the gathering: anything sent would be here
  assert.equal(received.length, before);
  assert.deepEqual((page as any).errors, []);
});

test("Telegram: set up in order (token, then chat, then test), each step shown when the one before is done", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/notifications`);
  const card = page.locator('#notifications [data-channel="telegram"]');
  await card.locator(".choice").click();
  // Only the first step until a token is saved: no chat to find, no test to send.
  assert.equal(await card.getByRole("button", { name: "Find my chat" }).count(), 0);
  // A token Telegram doesn't know is said at once, where it was saved.
  await card.locator('input[type="password"]').fill("999:wrong");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await card.locator(".notify-error", { hasText: "Telegram doesn't know this token" }).waitFor();
  await card.locator('input[type="password"]').fill("123456:ABC-def");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await card.locator(".notify-ok", { hasText: "Your bot: @my_bot" }).waitFor();
  // Then the chat: open that bot, /start, Find my chat. The test waits for it, and says so.
  await card.locator(".small", { hasText: "Open @my_bot in Telegram and send it /start" }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Send a test" }).isDisabled(), true);
  await card.locator(".small", { hasText: "Connect your chat first (step 2)." }).waitFor();
  await card.getByRole("button", { name: "Find my chat" }).click();
  await card.locator('[data-testid="telegram-chat"]', { hasText: "Chat: Danilo" }).waitFor();
  await card.getByRole("button", { name: "Send a test" }).click();
  await card.locator(".notify-ok", { hasText: "Sent" }).waitFor();
  assert.ok(telegramSent.some((m) => m.chat_id === "42" && /Symbio: test notification/.test(m.text)));
});
