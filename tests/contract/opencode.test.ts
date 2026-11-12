// Contract test: the OpenCode HTTP API as Symbio uses it, against a real `opencode serve` (the
// bundled one, or SYMBIO_OPENCODE_BIN). Much of that API is new or experimental (instructions,
// MCP registration); this catches a breaking change before users do. It needs no model or
// sign-in: nothing here starts a model turn. OpenCode's own data goes to a temporary folder.
//
// npm run test:contract   (CI runs it on every push and daily, also against the newest OpenCode)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";

const root = mkdtempSync(path.join(os.tmpdir(), "sym-contract-"));
// OpenCode keeps its database, logs and config under the XDG folders, on every platform.
for (const [key, dir] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache" })) {
  process.env[key] = path.join(root, dir);
}
process.env.SYMBIO_HOME = path.join(root, "symbio");

const { OpencodeRuntime } = await import("../../src/server/opencode/runtime.js");
const { OpencodeClient } = await import("../../src/server/opencode/client.js");
const { handleMcp } = await import("../../src/server/mcp.js");

const runtime = new OpencodeRuntime(path.join(root, "opencode.pid"));
let client: InstanceType<typeof OpencodeClient>;
const work = path.join(root, "work");
mkdirSync(work, { recursive: true });
const where = `location%5Bdirectory%5D=${encodeURIComponent(work)}`;
let model: { providerID: string; id: string };
let sessionId: string;
let turnSession: string;
let pageSession: string;
const events: any[] = [];
const stopEvents = new AbortController();

// A tool server like Symbio's, with one tool, for OpenCode to connect to.
const mcpApp = new Hono();
mcpApp.all("/mcp/:token", (c) =>
  handleMcp(c, (token) =>
    token === "contract"
      ? { ctx: {}, tools: [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} }, run: () => "pong" }] }
      : null,
  ),
);
const mcpServer = createServer(getRequestListener(mcpApp.fetch));

before(async () => {
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  await runtime.start();
  client = runtime.client!;
  void client.subscribe((e) => events.push(e), stopEvents.signal).catch(() => {});
});

after(async () => {
  stopEvents.abort();
  for (const id of [sessionId, turnSession, pageSession]) if (id) await client.request("DELETE", `/api/session/${id}`).catch(() => {});
  await runtime.stop();
  mcpServer.close();
});

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("server info and models (GET /api/info, /api/model)", async () => {
  console.log(`OpenCode ${runtime.version}`);
  assert.match(runtime.version ?? "", /^\d+\.\d+\.\d+/);
  const models = await client.listModels();
  assert.ok(Array.isArray(models) && models.length > 0, "a list of models");
  const m = models[0];
  const providerID = m.providerID ?? m.provider?.id;
  assert.equal(typeof providerID, "string", "models carry providerID");
  assert.equal(typeof m.id, "string", "models carry id");
  model = { providerID, id: m.id };
});

test("providers and integrations, for Settings → Model providers", async () => {
  const providers = await client.request("GET", "/api/provider");
  assert.ok(providers && typeof providers === "object");
  const integrations = await client.request("GET", "/api/integration");
  assert.ok(integrations && typeof integrations === "object");
});

test("sessions: create, read, permissions, model, children", async () => {
  const s = await client.createSession({ title: "contract", directory: work, model, permissions: [{ action: "read", resource: "*", effect: "allow" }] });
  assert.match(s.id, /^ses_/, "created sessions return data.id");
  sessionId = s.id;
  const read = await client.request("GET", `/api/session/${sessionId}`);
  assert.equal(read?.data?.id ?? read?.id, sessionId, "GET /api/session/{id}");
  await client.setPermissions(sessionId, [{ action: "bash", resource: "rm -rf *", effect: "deny" }]);
  await client.switchModel(sessionId, model);
  const children = await client.request("GET", `/api/session?parentID=${encodeURIComponent(sessionId)}&limit=100`);
  assert.ok(Array.isArray(children?.data), "listing child sessions returns data[]");
});

test("instructions (experimental): set and remove an entry", async () => {
  await client.setInstruction(sessionId, "symbio-role", "You are a contract test.");
  await client.setInstruction(sessionId, "symbio-role", "Replaced.");
  await client.removeInstruction(sessionId, "symbio-role");
});

test("tool server registration (experimental): OpenCode connects to it", async () => {
  const { port } = mcpServer.address() as { port: number };
  await client.request("PUT", `/api/experimental/mcp/symbio?${where}`, { config: { type: "remote", url: `http://127.0.0.1:${port}/mcp/contract` } });
  let last: unknown;
  await until("the tool server to be connected", async () => {
    const res = await client.request<{ data?: { name: string; status?: { status?: string } }[] }>("GET", `/api/mcp?${where}`);
    last = res;
    return !!res?.data?.some((s) => s.name === "symbio" && s.status?.status === "connected");
  }).catch((err) => {
    throw new Error(`${err.message}; last /api/mcp answer: ${JSON.stringify(last)}`);
  });
});

test("notes without a turn wait in the inbox; a turn takes the oldest queued item", async () => {
  // A model that doesn't exist: each turn fails at once ("Model unavailable"), with no network.
  const s = await client.createSession({ title: "turns", directory: work, model: { providerID: "symbio-contract", id: "no-such-model" } });
  turnSession = s.id;
  const note = await client.synthetic(turnSession, "a note for later", false);
  const inbox = await client.request("GET", `/api/session/${turnSession}/inbox`);
  assert.ok(inbox.data.some((i: any) => i.id === note.data.id), "the note waits in the inbox");
  assert.equal((await client.messages(turnSession)).length, 0, "and isn't in the conversation yet");

  await client.prompt(turnSession, "hello 1");
  await until("the turn to end", async () => (await client.messages(turnSession)).some((m) => m.type === "idle"));
  const history = await client.messages(turnSession);
  assert.match(JSON.stringify(history[0]), /a note for later/, "the note joined the conversation first");
  // Verified on 2.1.4: one item per turn. After a failed turn the rest stay queued until the
  // next turn starts (here "hello 1"); see docs/opencode-api.md.
  const left = (await client.request("GET", `/api/session/${turnSession}/inbox`)).data;
  assert.ok(left.length <= 1, "at most the prompt is still queued");
});

test("a failed turn: its events, and the message that records it", async () => {
  const types = events.filter((e) => e?.data?.sessionID === turnSession).map((e) => e.type);
  assert.ok(types.includes("session.execution.started"), `execution.started among ${types.join(", ")}`);
  assert.ok(types.some((t) => t === "session.execution.failed" || t === "session.execution.succeeded"), `a terminal execution event among ${types.join(", ")}`);
  const idle = (await client.messages(turnSession)).find((m) => m.type === "idle");
  assert.match(JSON.stringify(idle), /Model unavailable/, "the turn's end says why it failed");
});

test("message pages: newest first, and the cursor Symbio builds pages backwards", async () => {
  const pages = await client.createSession({ title: "pages", directory: work, model: { providerID: "symbio-contract", id: "no-such-model" } });
  pageSession = pages.id;
  for (const n of [1, 2, 3]) {
    await client.prompt(pageSession, `hello ${n}`);
    await until(`turn ${n} to end`, async () => (await client.messages(pageSession)).filter((m) => m.type === "idle").length >= n);
  }
  const all = await client.messages(pageSession);
  assert.ok(all.length >= 6, "three turns, each with the user's message and its end");
  const i1 = all.findIndex((m) => JSON.stringify(m).includes("hello 1"));
  const i3 = all.findIndex((m) => JSON.stringify(m).includes("hello 3"));
  assert.ok(i1 >= 0 && i1 < i3, "oldest first once Symbio reverses them");

  const latest = await client.messagePage(pageSession, 2);
  assert.equal(latest.messages.length, 2);
  assert.ok(latest.hasMore, "one extra item tells there are older messages");
  const older = await client.messagePage(pageSession, 2, latest.messages[0].id);
  assert.equal(older.messages.length, 2, "the cursor Symbio builds pages backwards");
  assert.ok(!older.messages.some((m) => latest.messages.some((l) => l.id === m.id)), "no overlap between pages");
  assert.equal(older.messages[1].id, all[all.length - 3].id, "the page right before the latest");
});

test("events: the stream carries the sessions' activity", async () => {
  await until("an event about a session", () => events.some((e) => e?.data?.sessionID === turnSession));
  assert.ok(events.every((e) => typeof e.type === "string"), "events have a type");
});

test("inbox, forms, permissions list, shells and interrupt on an idle session", async () => {
  const inbox = await client.request("GET", `/api/session/${sessionId}/inbox`);
  assert.ok(Array.isArray(inbox?.data), "inbox returns data[]");
  const forms = await client.request("GET", `/api/session/${sessionId}/form`);
  assert.ok(Array.isArray(forms?.data), "forms return data[]");
  const shells = await client.shells(work);
  assert.ok(Array.isArray(shells), "shells list");
  await client.interrupt(sessionId);
});

test("deleting a session", async () => {
  const doomed = await client.createSession({ title: "to delete", directory: work, model });
  await client.request("DELETE", `/api/session/${doomed.id}`);
  await assert.rejects(client.request("GET", `/api/session/${doomed.id}`), /404/);
});
