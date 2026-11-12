#!/usr/bin/env node
// A stand-in for `opencode serve`, for Symbio's end-to-end tests: the same HTTP API, events and
// stored messages (shapes recorded from OpenCode 2.1.4 in fixtures/opencode-turns.json), with a
// scripted "model" instead of a real one. Symbio launches it through SYMBIO_OPENCODE_BIN.
//
// The script lives in the messages themselves. A line `@<agent> <step>` is run by that agent
// (matched on the end of its session title, "<project> · <agent>"; the coordinator is "core"):
//
//   @core say Hello there                       a text reply
//   @core tool spawn_agent {"name":"writer",…}  call a Symbio tool (single-line JSON arguments)
//   @writer shell git commit -am "…"            run a command in the agent's folder
//   @writer write notes.txt Some text           write a file in the agent's folder
//   @core question Drink? | Tea | Coffee        ask through OpenCode's question form; waits
//   @core wait 1500                             pause (milliseconds)
//
// Lines for other agents are ignored, so a task handed to a helper can carry the helper's own
// script. A message with no line for the agent gets a short default reply. A session on the model
// "fake/unavailable" fails every turn at once, like a model that doesn't exist.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const port = Number(arg("--port", "4096"));
const hostname = arg("--hostname", "127.0.0.1");
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
delete process.env.OPENCODE_SERVER_PASSWORD;

let seq = 0;
const newId = (prefix) => `${prefix}_${Date.now().toString(16)}${(++seq).toString(36).padStart(6, "0")}fake`;
const now = () => Date.now();

const MODELS = [
  { providerID: "fake", id: "scripted", name: "Scripted", cost: { input: 1, output: 2 }, limit: { context: 200000 }, capabilities: { input: { image: true } } },
  { providerID: "fake", id: "scripted-2", name: "Scripted 2", cost: { input: 1, output: 2 }, limit: { context: 200000 } },
  { providerID: "fake", id: "unavailable", name: "Unavailable", cost: { input: 0, output: 0 }, limit: { context: 200000 } },
];

/** @type {Map<string, any>} */
const sessions = new Map();
/** directory → MCP url (Symbio's tools) */
const mcp = new Map();
const clients = new Set();

function emit(type, data, directory) {
  const event = { id: newId("evt"), created: now(), type, ...(directory ? { location: { directory } } : {}), data };
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

const agentName = (s) => (s.title.includes(" · ") ? s.title.split(" · ").pop() : "core");
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const notFound = (res, what = "Not found") => send(res, 404, { message: what });
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

// ---------------------------------------------------------------- the scripted model

function stepsFor(session, text) {
  const me = agentName(session);
  const steps = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^@([\w-]+)\s+(\w+)\s*(.*)$/);
    if (m && m[1] === me) steps.push({ kind: m[2], rest: m[3] });
  }
  return steps;
}

function usage(session, cost, tokens) {
  session.usage.cost += cost;
  for (const k of ["input", "output", "reasoning"]) session.usage.tokens[k] += tokens[k] ?? 0;
  emit("session.usage.updated", { sessionID: session.id, cost: session.usage.cost, tokens: session.usage.tokens });
}

function assistantMessage(session, content) {
  const msg = {
    id: newId("msg"),
    time: { created: now(), streamed: now(), completed: now() },
    type: "assistant",
    agent: "build",
    model: { ...session.model, variant: "default" },
    content,
    finish: "stop",
    rawFinish: "end_turn",
    cost: 0.001,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return msg;
}

async function sayStep(session, text) {
  const msg = assistantMessage(session, [{ type: "text", text }]);
  const d = session.directory;
  emit("session.step.started", { sessionID: session.id, agent: "build", model: session.model }, d);
  emit("session.text.started", { sessionID: session.id, assistantMessageID: msg.id, ordinal: 0 }, d);
  emit("session.text.delta", { sessionID: session.id, assistantMessageID: msg.id, ordinal: 0, delta: text }, d);
  emit("session.text.ended", { sessionID: session.id, assistantMessageID: msg.id, ordinal: 0, text }, d);
  session.messages.push(msg);
  emit("session.step.ended", { sessionID: session.id, assistantMessageID: msg.id, finish: "stop", rawFinish: "end_turn", cost: 0.001, tokens: msg.tokens }, d);
  usage(session, 0.001, { input: 10, output: 5 });
}

/** One tool call as its own assistant message, with the events OpenCode sends for it. */
async function toolStep(session, name, input, run) {
  const d = session.directory;
  const msg = assistantMessage(session, []);
  const callId = newId("toolu");
  const part = { type: "tool", id: callId, name, executed: false, state: { status: "running", input }, time: { created: now() } };
  msg.content.push(part);
  session.messages.push(msg);
  emit("session.step.started", { sessionID: session.id, agent: "build", model: session.model }, d);
  emit("session.tool.input.started", { sessionID: session.id, assistantMessageID: msg.id, id: callId, name }, d);
  emit("session.tool.input.ended", { sessionID: session.id, assistantMessageID: msg.id, id: callId, text: JSON.stringify(input) }, d);
  emit("session.tool.called", { sessionID: session.id, assistantMessageID: msg.id, id: callId, input, executed: false }, d);
  let result;
  try {
    result = await run(msg, callId);
  } catch (err) {
    result = { error: String(err.message ?? err) };
  }
  if (result.error) {
    part.state = { status: "error", input, error: { message: result.error } };
    emit("session.tool.failed", { sessionID: session.id, assistantMessageID: msg.id, id: callId, error: { message: result.error } }, d);
  } else {
    part.state = { status: "completed", input, content: [{ type: "text", text: result.text }], metadata: result.metadata ?? { truncated: false } };
    emit("session.tool.success", { sessionID: session.id, assistantMessageID: msg.id, id: callId, content: part.state.content, metadata: part.state.metadata, executed: false }, d);
  }
  part.time.completed = now();
  emit("session.step.ended", { sessionID: session.id, assistantMessageID: msg.id, finish: "tool-calls", rawFinish: "tool_use", cost: 0.001, tokens: msg.tokens }, d);
  usage(session, 0.001, { input: 10, output: 5 });
}

async function callSymbio(session, name, args) {
  const url = mcp.get(session.directory) ?? [...mcp.entries()].find(([dir]) => samePath(dir, session.directory))?.[1];
  if (!url) return { error: "Symbio's tools aren't registered for this folder" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args, _meta: { "ai.opencode/sessionID": session.id } } }),
  });
  const body = await res.json().catch(() => null);
  if (body?.error) return { error: body.error.message };
  const text = (body?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return body?.result?.isError ? { error: text } : { text };
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function runStep(session, step, ctl) {
  switch (step.kind) {
    case "say":
      return sayStep(session, step.rest);
    case "wait":
      return new Promise((r) => setTimeout(r, Number(step.rest) || 500));
    case "tool": {
      const m = step.rest.match(/^([\w.-]+)\s*(.*)$/);
      const name = m[1];
      const args = m[2] ? JSON.parse(m[2]) : {};
      // Like OpenCode's code mode: Symbio's tools are called from an "execute" step.
      return toolStep(session, "execute", { code: `return await tools.symbio.${name}(${JSON.stringify(args)});` }, () => callSymbio(session, name, args));
    }
    case "shell":
      return toolStep(session, "shell", { command: step.rest }, async () => {
        try {
          const out = execSync(step.rest, { cwd: session.directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
          return { text: out, metadata: { status: "completed", truncated: false, exit: 0 } };
        } catch (err) {
          return { text: `${err.stdout ?? ""}${err.stderr ?? ""}`, metadata: { status: "completed", truncated: false, exit: err.status ?? 1 } };
        }
      });
    case "write": {
      const m = step.rest.match(/^(\S+)\s+([\s\S]*)$/);
      return toolStep(session, "write", { path: m[1], content: m[2] }, async () => {
        const file = path.resolve(session.directory, m[1]);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, m[2].replace(/\\n/g, "\n") + "\n");
        return { text: `Wrote ${m[1]}` };
      });
    }
    case "question": {
      const [title, ...options] = step.rest.split("|").map((s) => s.trim());
      const input = { questions: [{ question: title, header: title, options: options.map((label) => ({ label })), multiple: false }] };
      return toolStep(session, "question", input, (msg, callId) => {
        const form = {
          id: newId("frm"),
          sessionID: session.id,
          title: "Questions",
          metadata: { kind: "question", tool: { messageID: msg.id, id: callId } },
          fields: [{ key: "q0", title, description: title, type: "string", options: options.map((o) => ({ value: o, label: o })), custom: true }],
        };
        session.forms.push(form);
        return new Promise((resolve) => {
          form.resolve = (answer) => resolve({ text: `User has answered your questions: "${title}"="${answer.q0}".`, metadata: { answers: [[answer.q0]], truncated: false } });
          ctl.onAbort = () => resolve({ error: "Tool execution interrupted" });
        });
      });
    }
    default:
      return sayStep(session, `(unknown fake step "${step.kind}")`);
  }
}

/** Takes queued items one at a time, like OpenCode: each is one turn. */
async function drain(session) {
  if (session.running) return;
  session.running = true;
  emit("session.execution.started", { sessionID: session.id });
  let outcome = "succeeded";
  let error = null;
  try {
    while (session.inbox.length) {
      const item = session.inbox.shift();
      const delivered = { id: item.id, time: { created: now() }, type: item.type, text: item.payload.text };
      session.messages.push(delivered);
      emit("session.inbox.delivered", { sessionID: session.id, inboxID: item.id }, session.directory);
      if (session.model.id === "unavailable") {
        outcome = "failed";
        error = { type: "provider.no-route", message: `Model unavailable: ${session.model.providerID}/${session.model.id}` };
        break;
      }
      if (item.type === "synthetic" && !item.resume) continue;
      const ctl = { aborted: false, onAbort: null };
      session.ctl = ctl;
      const steps = stepsFor(session, item.payload.text);
      if (!steps.length) steps.push({ kind: "say", rest: defaultReply(session, item.payload.text) });
      for (const step of steps) {
        if (ctl.aborted) break;
        await runStep(session, step, ctl);
      }
      session.ctl = null;
      if (ctl.aborted) {
        outcome = "failed";
        error = { type: "aborted", message: "Interrupted" };
        break;
      }
    }
  } finally {
    session.messages.push({ id: newId("msg"), time: { created: now() }, type: "idle", outcome, ...(error ? { error } : {}) });
    session.running = false;
    emit(outcome === "succeeded" ? "session.execution.succeeded" : "session.execution.failed", { sessionID: session.id, ...(error ? { error } : {}) });
  }
}

function defaultReply(session, text) {
  const first = String(text).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return `Noted (${agentName(session)}): ${first.slice(0, 80)}`;
}

function enqueue(session, type, text, delivery, resume = true) {
  const item = { id: newId("msg"), sessionID: session.id, time: { created: now() }, type, payload: { text }, delivery, resume };
  session.inbox.push(item);
  emit("session.inbox.enqueued", { inboxID: item.id, sessionID: session.id, item: { type, payload: { text }, delivery } }, session.directory);
  return item;
}

// ---------------------------------------------------------------- HTTP API

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const dir = url.searchParams.get("location[directory]");
  const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  if (password && req.headers.authorization !== expected) return send(res, 401, { message: "Unauthorized" });
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};
  const m = (re) => p.match(re);
  let s;

  if (p === "/api/info") return send(res, 200, { version: "2.1.4-fake", pid: process.pid });
  if (p === "/api/model") return send(res, 200, { data: MODELS });
  if (p === "/api/provider") return send(res, 200, { data: [{ id: "fake", name: "Fake provider" }] });
  if (p === "/api/integration") return send(res, 200, { data: [] });
  if (p === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (p === "/api/shell") return send(res, 200, { data: [] });
  if (m(/^\/api\/shell\/[^/]+$/) && req.method === "DELETE") return send(res, 200, {});
  if (p === "/api/mcp") return send(res, 200, { data: dir && mcp.has(dir) ? [{ name: "symbio", status: { status: "connected" } }] : [] });
  if (p === "/api/experimental/mcp/symbio" && req.method === "PUT") {
    mcp.set(dir, body.config?.url);
    return send(res, 200, { data: { name: "symbio" } });
  }
  if (p === "/api/session" && req.method === "POST") {
    const session = {
      id: newId("ses"),
      title: body.title ?? "",
      directory: body.location?.directory ?? process.cwd(),
      model: body.model ?? { providerID: "fake", id: "scripted" },
      permissions: body.permissions ?? [],
      instructions: {},
      messages: [],
      inbox: [],
      forms: [],
      running: false,
      usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      parentID: body.parentID ?? null,
    };
    sessions.set(session.id, session);
    return send(res, 200, { data: { id: session.id, model: session.model, cost: 0, tokens: session.usage.tokens } });
  }
  if (p === "/api/session" && req.method === "GET") {
    const parent = url.searchParams.get("parentID");
    return send(res, 200, { data: [...sessions.values()].filter((x) => x.parentID === parent).map((x) => ({ id: x.id, title: x.title })) });
  }
  if ((s = m(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/(.+)$/))) {
    const session = sessions.get(s[1]);
    if (!session) return notFound(res);
    if (req.method === "PUT") session.instructions[decodeURIComponent(s[2])] = body.value;
    else delete session.instructions[decodeURIComponent(s[2])];
    return send(res, 200, {});
  }
  if ((s = m(/^\/api\/session\/([^/]+)(\/.*)?$/))) {
    const session = sessions.get(s[1]);
    if (!session) return notFound(res, `Session not found: ${s[1]}`);
    const rest = s[2] ?? "";
    if (rest === "" && req.method === "GET") return send(res, 200, { data: { id: session.id, title: session.title, model: session.model, cost: session.usage.cost, tokens: session.usage.tokens } });
    if (rest === "" && req.method === "PATCH") {
      if (body.permissions) session.permissions = body.permissions;
      return send(res, 200, { data: { id: session.id } });
    }
    if (rest === "" && req.method === "DELETE") {
      sessions.delete(session.id);
      return send(res, 200, {});
    }
    if (rest === "/prompt") {
      const item = enqueue(session, "user", body.text ?? "", body.delivery ?? "queue");
      void drain(session);
      return send(res, 200, { data: { id: item.id } });
    }
    if (rest === "/synthetic") {
      const item = enqueue(session, "synthetic", body.text ?? "", body.delivery ?? "queue", !!body.resume);
      if (body.resume) void drain(session);
      return send(res, 200, { data: { id: item.id, sessionID: session.id, type: "synthetic", payload: { text: body.text }, delivery: body.delivery ?? "queue" } });
    }
    if (rest === "/interrupt") {
      if (session.ctl) {
        session.ctl.aborted = true;
        session.ctl.onAbort?.();
      }
      return send(res, 200, {});
    }
    if (rest === "/model") {
      session.model = body.model;
      return send(res, 200, {});
    }
    if (rest === "/message") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const newestFirst = [...session.messages].reverse();
      let start = 0;
      const cursor = url.searchParams.get("cursor");
      if (cursor) {
        const { id } = JSON.parse(Buffer.from(cursor, "base64url").toString());
        start = newestFirst.findIndex((x) => x.id === id) + 1;
      }
      const data = newestFirst.slice(start, start + limit);
      const more = start + limit < newestFirst.length;
      const next = more ? Buffer.from(JSON.stringify({ id: data[data.length - 1].id, order: "desc", direction: "next" })).toString("base64url") : null;
      return send(res, 200, { data, cursor: { previous: null, next } });
    }
    if (rest === "/inbox") return send(res, 200, { data: session.inbox.map(({ resume, ...i }) => i) });
    if ((s = rest.match(/^\/inbox\/(.+)$/)) && req.method === "DELETE") {
      session.inbox = session.inbox.filter((i) => i.id !== s[1]);
      emit("session.inbox.cancelled", { sessionID: session.id, inboxID: s[1] }, session.directory);
      return send(res, 200, {});
    }
    if (rest === "/form") return send(res, 200, { data: session.forms.map(({ resolve, ...f }) => f) });
    if ((s = rest.match(/^\/form\/([^/]+)\/reply$/))) {
      const form = session.forms.find((f) => f.id === s[1]);
      if (!form) return notFound(res, "Form not found");
      session.forms = session.forms.filter((f) => f !== form);
      emit("form.replied", { id: form.id, sessionID: session.id, answer: body.answer }, session.directory);
      form.resolve?.(body.answer ?? {});
      return send(res, 200, {});
    }
    if (rest.match(/^\/permission\/[^/]+\/reply$/)) return send(res, 200, {});
  }
  return notFound(res, `fake opencode: no route for ${req.method} ${p}`);
});

server.listen(port, hostname, () => {
  // Like `opencode serve --stdio`: the address on stdout, and exit when stdin closes.
  process.stdout.write(JSON.stringify({ url: `http://${hostname}:${port}` }) + "\n");
});
if (argv.includes("--stdio")) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}
