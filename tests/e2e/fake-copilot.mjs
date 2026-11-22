// A stand-in for the GitHub Copilot SDK (and the Copilot runtime behind it), for Symbio's end-to-end
// tests: the same calls, callbacks and events Symbio's Copilot runtime uses (src/server/copilot/
// runtime.ts; shapes verified live in docs/copilot-api.md), with the same scripted "model" as
// fake-opencode.mjs. Symbio loads it in place of @github/copilot-sdk through SYMBIO_COPILOT_SDK.
//
// The script lives in the messages. A line `@<agent> <step>` is run by that agent (matched on the
// end of its session name, "<project> · <agent>"):
//
//   @core say Hello there                       a text reply
//   @core tool spawn_agent {"name":"writer",…}  call a Symbio tool, through Symbio's MCP server
//   @writer shell git commit -am "…"            run a command in the agent's folder
//   @writer write notes.txt Some text           write a file in the agent's folder
//   @core question Drink? | Tea | Coffee        ask the human (Copilot's ask_user); waits
//   @core wait 1500                             pause (milliseconds)
//
// Every tool call goes through the session's permission handler first, as Copilot's do. A session
// on the model "unavailable" fails every turn at once, like a model that isn't available.

import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const MODELS = [
  { id: "auto", name: "Auto" },
  { id: "scripted", name: "Scripted", capabilities: { supports: { vision: true, reasoningEffort: true } }, supportedReasoningEfforts: ["low", "medium", "high"] },
  { id: "scripted-2", name: "Scripted 2", capabilities: { supports: {} } },
  { id: "unavailable", name: "Unavailable", capabilities: { supports: {} } },
  { id: "flaky", name: "Flaky", capabilities: { supports: {} } },
];

/** Sessions outlive a client, like Copilot's stored sessions (a runtime restart resumes them). */
const sessions = new Map();
/** The fake runtime process (see FakeClient.start). */
let runtimeProcess = null;
/** Commands sent to the runtime's shell that haven't started yet. */
let spawned = [];
/** Signed in to GitHub, unless SYMBIO_FAKE_COPILOT_SIGNED_OUT=1 (then a device-code sign-in signs in). */
const logins = new Map();
const auth = { login: process.env.SYMBIO_FAKE_COPILOT_SIGNED_OUT === "1" ? null : "e2e" };

export function createClient() {
  return new FakeClient();
}

class FakeClient {
  // Like the SDK, the runtime is a process of its own (cliProcess), and agents' commands run under it:
  // here a small Node process that starts each line it's sent in a shell ("@core spawn <command>").
  async start() {
    this.cliProcess = spawn(
      process.execPath,
      [
        "-e",
        "require('readline').createInterface({ input: process.stdin }).on('line', (c) => " +
          "require('child_process').spawn(c, { shell: true, stdio: 'ignore', windowsHide: true }).on('spawn', () => console.log('spawned')))",
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    // Each "spawned" line answers the oldest command sent: a real shell tool returns once its command started.
    spawned = [];
    createInterface({ input: this.cliProcess.stdout }).on("line", () => spawned.shift()?.());
    runtimeProcess = this.cliProcess;
  }
  async stop() {
    this.cliProcess?.kill();
    if (runtimeProcess === this.cliProcess) runtimeProcess = null;
  }
  async getStatus() {
    return { version: "1.0.112-fake", protocolVersion: 3 };
  }
  async getAuthStatus() {
    return auth.login ? { isAuthenticated: true, authType: "user", login: auth.login } : { isAuthenticated: false, statusMessage: "Not authenticated" };
  }
  async listModels() {
    if (!auth.login) throw new Error("Not authenticated. Please authenticate first.");
    return MODELS;
  }
  async createSession(config) {
    const state = {
      id: config.sessionId ?? randomUUID(),
      name: config.name ?? "",
      directory: config.workingDirectory ?? process.cwd(),
      model: config.model ?? "scripted",
      effort: config.reasoningEffort ?? null,
      config,
      events: [],
      handlers: new Set(),
      queue: [],
      running: false,
      ctl: null,
      edits: new Map(),
      tokens: { input: 0, output: 0 },
    };
    sessions.set(state.id, state);
    record(state, "session.start", { sessionId: state.id, context: { cwd: state.directory } });
    return view(state);
  }
  async resumeSession(id, config) {
    const state = sessions.get(id);
    if (!state) throw new Error(`Session not found: ${id}`);
    state.config = config;
    if (config.workingDirectory) state.directory = config.workingDirectory;
    return view(state);
  }
  async deleteSession(id) {
    sessions.delete(id);
  }
  async getSessionMetadata(id) {
    const state = sessions.get(id);
    // As Copilot answers (verified): the folder is context.workingDirectory.
    return state ? { sessionId: id, context: { workingDirectory: state.directory } } : undefined;
  }
}

/** A session object as the SDK gives it: one per create/resume, all on the same session. */
function view(state) {
  const mine = new Set();
  return {
    sessionId: state.id,
    async send({ prompt, mode }) {
      const item = { id: randomUUID(), prompt };
      if (mode === "immediate") state.queue.unshift(item);
      else state.queue.push(item);
      void drain(state);
      return item.id;
    },
    async abort() {
      if (!state.ctl) return;
      state.ctl.aborted = true;
      state.ctl.onAbort?.();
    },
    async setModel(model, options) {
      state.model = model;
      // Like Copilot: without a level, the session keeps its last one (verified).
      if (options?.reasoningEffort) state.effort = options.reasoningEffort;
      record(state, "session.model_change", { newModel: model });
    },
    async getEvents() {
      return [...state.events];
    },
    on(handler) {
      state.handlers.add(handler);
      mine.add(handler);
      return () => {
        state.handlers.delete(handler);
        mine.delete(handler);
      };
    },
    async disconnect() {
      for (const h of mine) state.handlers.delete(h);
      mine.clear();
    },
    rpc: {
      queue: {
        pendingItems: async () => ({ items: state.queue.map((i) => ({ id: i.id, messageId: i.id, kind: "message", displayText: i.prompt })), steeringMessages: [] }),
        withdrawMessage: async ({ messageId, expectedPrompt }) => {
          const at = state.queue.findIndex((i) => i.id === messageId && i.prompt === expectedPrompt);
          if (at < 0) return { removed: false, interrupted: false };
          state.queue.splice(at, 1);
          return { removed: true, interrupted: false };
        },
      },
      usage: {
        getMetrics: async () => ({
          totalUserRequests: state.events.filter((e) => e.type === "user.message").length,
          tokenDetails: { input: { tokenCount: state.tokens.input }, output: { tokenCount: state.tokens.output }, cache_read: { tokenCount: 0 }, cache_write: { tokenCount: 0 } },
        }),
      },
      workspaces: {
        diff: async () => ({ requestedMode: "session", mode: "session", isFallback: false, changes: sessionChanges(state) }),
      },
      tasks: {
        list: async () => ({ tasks: [] }),
        cancel: async () => ({ cancelled: false }),
      },
      // Signing in with a device code: approved on "GitHub" a moment after it starts.
      accounts: {
        login: {
          begin: async ({ method }) => {
            const flowId = randomUUID();
            logins.set(flowId, { cancelled: false });
            return { flowId, step: method === "device-code" ? { kind: "device-code", userCode: "FAKE-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 } : { kind: "open-url", url: "https://github.com/login/oauth/authorize" } };
          },
          advance: async ({ flowId }) => {
            await new Promise((r) => setTimeout(r, 1500));
            const flow = logins.get(flowId);
            if (!flow || flow.cancelled) return { kind: "error", message: "The sign-in was cancelled." };
            auth.login = "e2e";
            return { kind: "completed", result: { status: "success", host: "https://github.com", login: "e2e" } };
          },
          cancel: async ({ flowId }) => {
            const flow = logins.get(flowId);
            if (flow) flow.cancelled = true;
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------- events

function emit(state, type, data, persist = true) {
  const event = { id: randomUUID(), timestamp: new Date().toISOString(), type, data };
  if (persist) state.events.push(event);
  for (const h of [...state.handlers]) {
    try {
      h(event);
    } catch {
      // a handler's error is the host's business
    }
  }
}
const record = (state, type, data) => emit(state, type, data, true);

// ---------------------------------------------------------------- the scripted model

const agentName = (state) => (state.name.includes(" · ") ? state.name.split(" · ").pop() : "core");

function stepsFor(state, text) {
  const me = agentName(state);
  const steps = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^@([\w-]+)\s+(\w+)\s*(.*)$/);
    if (m && m[1] === me) steps.push({ kind: m[2], rest: m[3] });
  }
  return steps;
}

function usage(state) {
  state.tokens.input += 10;
  state.tokens.output += 5;
  emit(state, "assistant.usage", { model: state.model, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 }, false);
}

function say(state, text) {
  const messageId = randomUUID();
  emit(state, "assistant.message_start", { messageId, phase: "final_answer" }, false);
  emit(state, "assistant.message_delta", { messageId, deltaContent: text }, false);
  record(state, "assistant.message", { messageId, model: state.model, content: text, toolRequests: [] });
  usage(state);
}

/** One tool call: the model asks for it, the host approves it (or not), it runs. */
async function toolCall(state, toolName, args, permission, run, extra = {}) {
  const toolCallId = `call_${randomUUID().slice(0, 12)}`;
  record(state, "assistant.message", { messageId: randomUUID(), model: state.model, content: "", toolRequests: [{ toolCallId, name: toolName, arguments: args }] });
  usage(state);
  record(state, "tool.execution_start", { toolCallId, toolName, arguments: args, ...extra });
  let result;
  const decision = permission ? await state.config.onPermissionRequest?.({ ...permission, toolCallId }) : { kind: "approve-once" };
  if (decision && decision.kind !== "approve-once" && decision.kind !== "approved") {
    const feedback = decision.feedback ? ` User feedback: ${decision.feedback}` : "";
    result = { error: `The user rejected this tool call.${feedback}` };
  } else {
    try {
      result = await run(toolCallId);
    } catch (err) {
      result = { error: String(err?.message ?? err) };
    }
  }
  if (result.error) record(state, "tool.execution_complete", { toolCallId, success: false, error: { message: result.error } });
  else record(state, "tool.execution_complete", { toolCallId, success: true, result: { content: result.text, detailedContent: result.text }, ...(result.fileEdits ? { fileEdits: result.fileEdits } : {}) });
}

async function callSymbio(state, name, args) {
  const server = state.config.mcpServers?.symbio;
  if (!server?.url) return { error: "Symbio's tools aren't configured for this session" };
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(server.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args, _meta: { "com.github.copilot/toolCallId": "fake" } } }),
  });
  const body = await res.json().catch(() => null);
  if (body?.error) return { error: body.error.message };
  const text = (body?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return body?.result?.isError ? { error: text } : { text };
}

async function runStep(state, step, ctl) {
  switch (step.kind) {
    // "@core effort": says the reasoning effort level its session is on; "@core coauthor": whether Copilot would add its line.
    case "effort":
      return say(state, `effort: ${state.effort ?? "default"}`);
    // "@core spawn <command>": a program that keeps running, started under the runtime's shell (not waited for).
    case "spawn":
      if (runtimeProcess) {
        const started = new Promise((resolve) => spawned.push(resolve));
        runtimeProcess.stdin.write(`${step.rest}\n`);
        await started;
      }
      return say(state, "started");
    case "coauthor":
      return say(state, `coauthor: ${state.config.coauthorEnabled === false ? "off" : "on"}`);
    case "say":
      return say(state, step.rest.replace(/\\n/g, "\n"));
    case "wait":
      return new Promise((r) => setTimeout(r, Number(step.rest) || 500));
    case "tool": {
      const m = step.rest.match(/^([\w.-]+)\s*(.*)$/);
      const name = m[1];
      const args = m[2] ? JSON.parse(m[2]) : {};
      return toolCall(state, `symbio-${name}`, args, { kind: "mcp", serverName: "symbio", toolName: `symbio-${name}`, args }, () => callSymbio(state, name, args), {
        mcpServerName: "symbio",
        toolTitle: name,
      });
    }
    case "shell":
      return toolCall(state, "powershell", { command: step.rest, description: "Run a command" }, { kind: "shell", fullCommandText: step.rest, shellType: "powershell" }, async () => {
        try {
          return { text: execSync(step.rest, { cwd: state.directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) };
        } catch (err) {
          return { text: `${err.stdout ?? ""}${err.stderr ?? ""}\n<exited with exit code ${err.status ?? 1}>` };
        }
      });
    case "write": {
      const m = step.rest.match(/^(\S+)\s+([\s\S]*)$/);
      const file = path.resolve(state.directory, m[1]);
      return toolCall(state, "create", { path: file, file_text: m[2] }, { kind: "write", fileName: file, intention: "Create file" }, async () => {
        const before = existsSync(file) ? readFileSync(file, "utf8") : null;
        mkdirSync(path.dirname(file), { recursive: true });
        const after = m[2].replace(/\\n/g, "\n") + "\n";
        writeFileSync(file, after);
        const rel = m[1].replace(/\\/g, "/");
        const first = state.edits.get(rel);
        state.edits.set(rel, { before: first ? first.before : before, after });
        return { text: `Created file ${file}`, fileEdits: [{ path: file }] };
      });
    }
    case "question": {
      const [question, ...choices] = step.rest.split("|").map((s) => s.trim());
      return toolCall(state, "ask_user", { question, choices }, null, async () => {
        const requestId = randomUUID();
        record(state, "user_input.requested", { requestId, question, choices, allowFreeform: true });
        const answer = await Promise.race([
          state.config.onUserInputRequest({ question, choices, allowFreeform: true, requestId }),
          new Promise((resolve) => (ctl.onAbort = () => resolve(null))),
        ]);
        if (!answer) return { error: "The user didn't answer (interrupted)." };
        record(state, "user_input.completed", { requestId, answer: answer.answer, wasFreeform: answer.wasFreeform });
        return { text: `User responded: ${answer.answer}` };
      });
    }
    default:
      return say(state, `(unknown fake step "${step.kind}")`);
  }
}

/** One queued prompt at a time; each is one turn. */
async function drain(state) {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length) {
      const item = state.queue.shift();
      // Like the real one: a model that isn't available fails before the prompt is recorded.
      // A model the session doesn't have (Copilot's own, or one of the providers it was given) isn't available.
      const known = MODELS.some((m) => m.id === state.model) || (state.config.models ?? []).some((m) => `${m.provider}/${m.id}` === state.model);
      if (state.model === "unavailable" || !known) {
        emit(state, "session.error", { errorType: "query", message: `Execution failed: Model "${state.model}" is not available.` });
        emit(state, "session.idle", {}, false);
        continue;
      }
      // "flaky" is overloaded for each session's first turn, then answers (a passing outage).
      if (state.model === "flaky" && !state.flakyFailed) {
        state.flakyFailed = true;
        emit(state, "session.error", { errorType: "server", statusCode: 503, message: "Service overloaded, try again later" });
        emit(state, "session.idle", {}, false);
        continue;
      }
      record(state, "user.message", { content: item.prompt, messageId: item.id });
      const ctl = { aborted: false, onAbort: null };
      state.ctl = ctl;
      emit(state, "assistant.turn_start", { turnId: item.id }, true);
      const steps = stepsFor(state, item.prompt);
      if (!steps.length) steps.push({ kind: "say", rest: defaultReply(state, item.prompt) });
      for (const step of steps) {
        if (ctl.aborted) break;
        await runStep(state, step, ctl);
      }
      state.ctl = null;
      emit(state, "assistant.turn_end", { turnId: item.id }, true);
      if (ctl.aborted) {
        record(state, "abort", { reason: "user_initiated" });
        emit(state, "session.idle", { aborted: true }, false);
        continue;
      }
      emit(state, "session.idle", {}, false);
    }
  } finally {
    state.running = false;
  }
}

function defaultReply(state, text) {
  const first = String(text).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return `Noted (${agentName(state)}): ${first.slice(0, 80)}`;
}

/** What the session changed, all of it (Copilot has no diff between two turns). */
function sessionChanges(state) {
  return [...state.edits.entries()].map(([file, { before, after }]) => {
    const old = before === null ? [] : before.replace(/\n$/, "").split("\n");
    const now = after.replace(/\n$/, "").split("\n");
    const diff = [`diff --git a/${file} b/${file}`, `--- ${before === null ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`, `@@ -1,${old.length} +1,${now.length} @@`, ...old.map((l) => `-${l}`), ...now.map((l) => `+${l}`)].join("\n");
    return { path: file, diff, changeType: before === null ? "added" : "modified" };
  });
}
