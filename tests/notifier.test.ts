import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bus } from "../src/server/bus.js";
import { compose, Notifier } from "../src/server/notifier.js";
import { Notifications, type Notification } from "../src/server/notifications.js";
import type { Plan, Task } from "../src/server/plan.js";
import type { Question } from "../src/server/questions.js";
import type { Agent, LoggedMessage, Project } from "../src/server/store.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Timers on a busy machine (CI) run late: wait for what's expected instead of a fixed time.
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return;
    await wait(10);
  }
  await wait(120); // and a moment more, so an extra notification would show up too
}

function setup(opts: { minRunMs?: number; tasks?: Partial<Task>[]; questions?: Partial<Question>[] } = {}) {
  const agent = { id: "a1", name: "core", status: "idle" } as Agent;
  const project = { id: "p1", name: "My site", agents: [agent] } as unknown as Project;
  const plan: Plan = {
    goal: "Ship the site",
    status: "approved",
    revision: 1,
    feedback: null,
    tasks: (opts.tasks ?? []).map((t) => ({ title: "A task", status: "todo", ...t }) as Task),
    updatedAt: 0,
  };
  const sent: Notification[] = [];
  const notifier = new Notifier(
    {
      project: (id) => (id === project.id ? project : undefined),
      projects: () => [project],
      plan: async () => plan,
      question: async (_p, id) => (opts.questions ?? []).find((q) => q.id === id) as Question | undefined,
    },
    async (n) => void sent.push(n),
    () => "full",
    { groupMs: 40, quietMs: 40, minRunMs: opts.minRunMs ?? 0 },
  );
  const log = (m: Partial<LoggedMessage>) =>
    bus.publish({ type: "message", projectId: project.id, message: { id: `m${Math.random()}`, time: Date.now(), from: agent.id, to: "human", kind: "chat", text: "", ...m } });
  const status = (s: Agent["status"]) => {
    agent.status = s;
    bus.publish({ type: "agent.status", projectId: project.id, agentId: agent.id, status: s });
  };
  return { project, plan, sent, notifier, log, status };
}

test("what happens together goes out as one notification, what waits on the human first", async () => {
  const { sent, notifier, log } = setup({ questions: [{ id: "Q1", question: "Which font for the titles?", blocking: true }] });
  await notifier.start();
  try {
    log({ kind: "file", text: "logo.png: the new logo" });
    log({ kind: "question", text: "Q1: Which font for the titles?" });
    log({ kind: "approval", text: "Deploy to production\n\nWhy: the site is ready" });
    log({ kind: "chat", text: "Working on it" }); // the chat isn't a notification
    await until(() => sent.length >= 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "My site: needs you (3)");
    assert.equal(sent[0].important, true);
    assert.deepEqual(sent[0].body.split("\n"), [
      "• core asks: Which font for the titles?",
      "• core wants to use a connection: Deploy to production",
      "• core shared a file: logo.png: the new logo",
    ]);
  } finally {
    notifier.stop();
  }
});

test("a project that wants only what needs the human doesn't send news, and one that wants none sends nothing", async () => {
  const { project, sent, notifier, log } = setup({ questions: [{ id: "Q2", question: "Blue or green?", decided: "Blue, the brand's color" }] });
  await notifier.start();
  try {
    project.notify = "important";
    log({ kind: "question", text: "Q2: Blue or green?" }); // decided: news, not a wait
    await wait(100);
    assert.equal(sent.length, 0);
    log({ kind: "plan", text: "Proposed a plan (revision 1, 2 tasks) — review it in the Plan tab.\n\n**Goal:** A faster site" });
    await until(() => sent.length >= 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "My site: Plan to review");
    assert.equal(sent[0].body, "Goal: A faster site");
    project.notify = "off";
    log({ kind: "alert", text: "core can't continue" });
    await until(() => sent.length >= 1);
    assert.equal(sent.length, 1);
  } finally {
    notifier.stop();
  }
});

test("tasks done count once, not the ones done before; every task done is its own news", async () => {
  const { plan, sent, notifier, project } = setup({ tasks: [{ id: "T1", status: "done" }, { id: "T2", status: "in-progress", title: "The contact page" }] });
  await notifier.start();
  try {
    bus.publish({ type: "plan.updated", projectId: project.id });
    await wait(100);
    assert.equal(sent.length, 0, "T1 was already done");
    plan.tasks[1].status = "done";
    bus.publish({ type: "plan.updated", projectId: project.id });
    bus.publish({ type: "plan.updated", projectId: project.id });
    await until(() => sent.length >= 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "My site: needs you (2)");
    assert.match(sent[0].body, /• All 2 tasks done: Goal: Ship the site\n• T2 done: The contact page/);
  } finally {
    notifier.stop();
  }
});

test("the team stopping after a while of work is news, with what it last said; a quick reply isn't", async () => {
  const s = setup();
  await s.notifier.start();
  try {
    s.status("busy");
    s.log({ kind: "chat", text: "The **contact page** is done; next I'd add a map." });
    s.status("idle");
    await until(() => s.sent.length >= 1);
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].title, "My site: The team stopped working");
    assert.equal(s.sent[0].body, "The contact page is done; next I'd add a map.");

    // Stopped to ask: the question already says so.
    s.status("busy");
    s.log({ kind: "question", text: "Q9: Which map?" });
    s.status("idle");
    await until(() => s.sent.length >= 2);
    assert.equal(s.sent.length, 2);
    assert.equal(s.sent[1].title, "My site: core asks");

    // Answered, back at work, then stopped: that's news again.
    s.status("busy");
    s.status("idle");
    await until(() => s.sent.length >= 3);
    assert.equal(s.sent.length, 3);
    assert.equal(s.sent[2].title, "My site: The team stopped working");
  } finally {
    s.notifier.stop();
  }
  const quick = setup({ minRunMs: 60_000 });
  await quick.notifier.start();
  try {
    quick.status("busy");
    quick.status("idle");
    await wait(150);
    assert.equal(quick.sent.length, 0);
  } finally {
    quick.notifier.stop();
  }
});

test("a short notification says only which project needs the human", () => {
  const items = [{ key: "a", title: "core asks", body: "Which font?", important: true }];
  const n = compose({ id: "p1", name: "My site" }, items, "short");
  assert.equal(n.title, "Symbio");
  assert.equal(n.body, "My site needs you");
});

function fakeVault() {
  const data: Record<string, string> = {};
  return {
    data,
    get: async (k: string) => data[k],
    has: async (k: string) => k in data,
    set: async (k: string, v: string) => void (data[k] = v),
    deletePrefix: async (p: string) => {
      for (const k of Object.keys(data)) if (k.startsWith(p)) delete data[k];
    },
  };
}

test("channels: the webhook and ntfy get what they read; secrets stay in the vault, never in the settings", async () => {
  const received: { url: string; auth?: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(body) });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const vault = fakeVault();
  const notifications = new Notifications(mkdtempSync(path.join(os.tmpdir(), "symbio-notify-")), vault as any);
  try {
    const view = await notifications.update({
      browser: { on: false },
      webhook: { on: true, url: `${base}/hook` },
      ntfy: { on: true, server: `${base}/`, topic: "symbio-abc123", token: "tk_secret" },
    });
    assert.deepEqual(view.secrets, { "telegram.token": false, "ntfy.token": true, "webhook.url": true, "email.password": false });
    assert.ok(!JSON.stringify(view).includes("tk_secret") && !JSON.stringify(view).includes("/hook"));
    assert.equal(vault.data["notify:webhook:url"], `${base}/hook`);

    await notifications.send({ id: "n1", projectId: "p1", title: "My site: core asks", body: "Which font?", important: true, at: 1 });
    const hook = received.find((r) => r.url === "/hook")!;
    assert.equal(hook.body.content, "My site: core asks\n\nWhich font?");
    assert.equal(hook.body.text, hook.body.content);
    assert.equal(hook.body.important, true);
    const ntfy = received.find((r) => r.url === "/")!;
    assert.deepEqual({ topic: ntfy.body.topic, title: ntfy.body.title, message: ntfy.body.message, priority: ntfy.body.priority }, {
      topic: "symbio-abc123",
      title: "My site: core asks",
      message: "Which font?",
      priority: 4,
    });
    assert.equal(ntfy.auth, "Bearer tk_secret");

    // A channel that fails says why, and the others still go.
    await notifications.update({ webhook: { url: `${base.replace(/:\d+$/, ":1")}/nothing` } });
    await notifications.send({ id: "n2", projectId: "p1", title: "x", body: "", important: false, at: 2 });
    const status = (await notifications.view()).status;
    assert.ok(status.webhook?.error);
    assert.equal(status.ntfy?.error, null);

    await assert.rejects(notifications.update({ ntfy: { topic: "has spaces" } }), /letters, digits/);
    await assert.rejects(notifications.update({ webhook: { url: "file:///etc/passwd" } }), /http/);
    // fetch refuses addresses with a user and password, quoting them in its error: refused when saved.
    await assert.rejects(notifications.update({ webhook: { url: "https://me:pw@example.com/hook" } }), /user and password/);
    await notifications.update({ webhook: { url: null } });
    assert.equal(vault.data["notify:webhook:url"], undefined);
  } finally {
    server.close();
  }
});

test("telegram: the chat is found, not typed; one the bot can't reach says which bot to open; another token finds it again", async () => {
  // A stand-in for Telegram: @home_bot knows chat 42 only after the human writes to it.
  let wrote = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.url!.split("/").pop();
      const reply = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (method === "getMe") return reply(200, { ok: true, result: { username: "home_bot" } });
      if (method === "getUpdates") return reply(200, { ok: true, result: wrote ? [{ message: { chat: { id: 42, first_name: "Danilo" } } }] : [] });
      if (method === "sendMessage") {
        return JSON.parse(body).chat_id === "42" && wrote ? reply(200, { ok: true, result: {} }) : reply(400, { ok: false, description: "Bad Request: chat not found" });
      }
      reply(404, { ok: false, description: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.SYMBIO_TELEGRAM_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "symbio-notify-"));
  const notifications = new Notifications(dir, fakeVault() as any);
  try {
    // A message typed where the chat goes (what happened to a human) is refused, and an old one is dropped.
    await assert.rejects(notifications.update({ telegram: { chatId: "teste" } }), /Find my chat/);
    writeFileSync(path.join(dir, "notifications.json"), JSON.stringify({ telegram: { on: true, chatId: "teste" } }));
    await notifications.load();
    assert.equal((await notifications.view()).telegram.chatId, "");
    await notifications.update({ telegram: { on: true, token: "111:old", chatId: "42" } });
    await assert.rejects(notifications.test("telegram"), /@home_bot can't write to that chat yet: open @home_bot in Telegram, send it \/start/);
    // A new bot: the old chat is dropped, to be found again with this one.
    await notifications.update({ telegram: { token: "222:new" } });
    assert.equal((await notifications.view()).telegram.chatId, "");
    await assert.rejects(notifications.findTelegramChat(), /@home_bot hasn't received a message yet/);
    wrote = true;
    // The human sent /start and pressed Send a test without Find my chat: the test finds the chat first.
    await notifications.test("telegram");
    assert.deepEqual([(await notifications.view()).telegram.chatId, (await notifications.view()).telegram.chatName], ["42", "Danilo"]);
    assert.deepEqual(await notifications.findTelegramChat(), { chatId: "42", name: "Danilo" });
    // The same token again keeps the chat.
    await notifications.update({ telegram: { token: "222:new" } });
    assert.equal((await notifications.view()).telegram.chatId, "42");
  } finally {
    delete process.env.SYMBIO_TELEGRAM_API;
    server.close();
  }
});
