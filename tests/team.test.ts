// Team logic against a fake OpenCode: records the calls instead of running models.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-team-home-"));
const { Store } = await import("../src/server/store.js");
const { Team } = await import("../src/server/team.js");

/** A stand-in for OpenCode: answers every call and remembers prompts (which start a turn) and notes. */
function fakeRuntime() {
  const calls: { method: string; path: string; body?: any }[] = [];
  const client: any = {
    calls,
    request: async (method: string, p: string, body?: any) => {
      calls.push({ method, path: p, body });
      if (p.startsWith("/api/mcp")) return { data: [{ name: "symbio", status: { status: "connected" } }] };
      return { data: { id: `inbox_${calls.length}` } };
    },
    prompt: async (sessionId: string, text: string) => {
      calls.push({ method: "PROMPT", path: sessionId, body: text });
      return { data: { id: `inbox_${calls.length}` } };
    },
    synthetic: async (sessionId: string, text: string) => calls.push({ method: "NOTE", path: sessionId, body: text }),
    setInstruction: async () => {},
    setPermissions: async (sessionId: string, permissions: any) => calls.push({ method: "PATCH", path: `/api/session/${sessionId}`, body: { permissions } }),
    removeInstruction: async () => {},
  };
  const runtime: any = Object.assign(new EventEmitter(), { client, state: "running" });
  return { runtime, client, calls };
}

async function setup() {
  const store = new Store();
  await store.load();
  const project: any = await store.create({
    name: "t",
    directory: mkdtempSync(path.join(os.tmpdir(), "sym-team-")),
    allowedModels: ["p/m"],
    coordinatorModel: "p/m",
    docsLocation: "project",
    origin: "new",
    inspectionSummary: "",
  });
  const mk = (id: string, name: string, role: string) => ({ id, name, role, sessionId: `ses_${name}`, directory: project.directory, model: "p/m", status: "idle", lastActivity: 0, createdAt: 0 });
  project.agents.push(mk("agt_core", "core", "coordinator"), mk("agt_a", "writer", "worker"), mk("agt_b", "editor", "worker"));
  await store.update(project);
  const { runtime, calls } = fakeRuntime();
  const team = new Team(store, runtime, "http://127.0.0.1:1");
  const [core, writer, editor] = project.agents;
  await (await team.assets(project)).declare("chapters", "the chapters", ["chapters/**"]);
  return { store, project, team, calls, core, writer, editor };
}

const prompts = (calls: any[], session: string) => calls.filter((c) => c.method === "PROMPT" && c.path === session);
const notes = (calls: any[], session: string) => calls.filter((c) => c.method === "NOTE" && c.path === session);

test("a free asset is granted at once; core gets a note, not a turn", async () => {
  const { project, team, calls, writer } = await setup();
  const answer = await team.sharedAssets.request(project, writer, "chapters", "write chapter 1");
  assert.match(answer, /Granted/);
  const reg = await team.assets(project);
  assert.equal(reg.list().find((a) => a.name === "chapters")!.holder, writer.id);
  assert.equal(prompts(calls, "ses_core").length, 0, "core was not woken");
  assert.equal(notes(calls, "ses_core").length, 1, "core got a note");

  // Released with nobody waiting: again only a note.
  await team.sharedAssets.release(project, writer, "chapters", "chapter 1 done");
  assert.equal(prompts(calls, "ses_core").length, 0, "still not woken");
  assert.equal(notes(calls, "ses_core").length, 2);
});

test("a held asset goes to core to decide, and the release wakes core when someone waits", async () => {
  const { project, team, calls, writer, editor } = await setup();
  await team.sharedAssets.request(project, writer, "chapters", "write");
  const answer = await team.sharedAssets.request(project, editor, "chapters", "edit");
  assert.match(answer, /Request sent to the coordinator/);
  assert.equal(prompts(calls, "ses_core").length, 1, "contention → core decides");
  await team.sharedAssets.release(project, writer, "chapters", "done");
  assert.equal(prompts(calls, "ses_core").length, 2, "someone waiting → core is woken");
});

test("message limit: protocol traffic doesn't count; conversation does, per project setting", async () => {
  const { project, team, writer, core } = await setup();
  project.messageLimit = 3;
  for (let i = 0; i < 10; i++) await team.deliver(project, writer, core, "asset-request", `protocol ${i}`);
  for (let i = 0; i < 3; i++) await team.deliver(project, writer, core, "info", `chat ${i}`);
  await assert.rejects(team.deliver(project, writer, core, "info", "one too many"), /Too many messages/);
  project.messageLimit = 0;
  await team.deliver(project, writer, core, "info", "no limit now");
});

test("rename: new name, old name still reaches the agent, and can't be reused", async () => {
  const { project, team, writer } = await setup();
  await team.renameAgent(project, writer, "Autor Principal");
  assert.equal(writer.name, "autor-principal");
  assert.equal(team.findAgent(project, "writer")?.id, writer.id, "old name still works");
  await assert.rejects(team.renameAgent(project, project.agents[2], "writer"), /taken/);
  await assert.rejects(team.renameAgent(project, project.agents[0], "boss"), /core keeps its name/);
});

test("after an update, core gets the agent-facing changes once, as a note; new projects start up to date", async () => {
  const { AGENT_UPDATES } = await import("../src/server/updates.js");
  const { project, team, calls, store } = await setup();
  // An existing project from before the mechanism: nothing seen yet.
  delete project.updatesSeen;
  await (team as any).tellAboutUpdates(project);
  const told = notes(calls, "ses_core");
  assert.equal(told.length, 1, "one note");
  assert.match(told[0].body, /^Symbio update/);
  assert.equal(prompts(calls, "ses_core").length, 0, "core not woken");
  assert.deepEqual(project.updatesSeen, AGENT_UPDATES.map((u) => u.id));
  const log = await store.readMessages(project);
  assert.ok(log.some((m: any) => /^Symbio update/.test(m.text)), "visible in Messages");

  await (team as any).tellAboutUpdates(project);
  assert.equal(notes(calls, "ses_core").length, 1, "not repeated");
});

test("in the shared project folder, each agent sees and stops only the processes it started", async () => {
  const { project, team, core, writer, editor } = await setup();
  const shell = (id: string, sessionID?: string) => ({
    id,
    status: "running",
    command: `run ${id}`,
    time: { started: 0 },
    metadata: sessionID ? { sessionID } : {},
  });
  // As OpenCode reports them: one list per folder; the starting session is in the metadata.
  let shells = [shell("sh_w", "ses_writer"), shell("sh_e", "ses_editor"), shell("sh_c", "ses_core"), shell("sh_none"), shell("sh_x", "ses_gone")];
  const stopped: string[] = [];
  const client = (team as any).runtime.client;
  client.shells = async () => shells;
  client.stopShell = async (_dir: string, id: string) => {
    stopped.push(id);
    shells = shells.filter((s) => s.id !== id);
  };
  client.interrupt = async () => {};

  assert.match(await team.processes.list(project, writer), /sh_w/);
  assert.doesNotMatch(await team.processes.list(project, writer), /sh_e|sh_c|sh_none|sh_x/);
  const coreList = await team.processes.list(project, core);
  assert.match(coreList, /sh_c/);
  assert.match(coreList, /sh_none/, "processes with no recorded owner are core's");
  assert.match(coreList, /sh_x/, "processes of sessions no agent has are core's");
  assert.doesNotMatch(coreList, /sh_w|sh_e/, "not the helpers'");
  await assert.rejects(team.processes.stop(project, editor, "sh_w"), /No running background process/);

  // A renewed session keeps its earlier processes.
  writer.previousSessions = [{ sessionId: "ses_writer" , endedAt: 0 }];
  writer.sessionId = "ses_writer2";
  await team.stopAgent(project, writer, "done");
  assert.deepEqual(stopped, ["sh_w"], "stopping a helper stops only its own processes");
});

test("where helpers work: project setting, per-helper choice, and moving a helper into the project folder", async () => {
  const { git, initRepository } = await import("../src/server/git.js");
  const { writeFileSync, existsSync } = await import("node:fs");
  const { project, team, calls, core } = await setup();
  writeFileSync(path.join(project.directory, "a.txt"), "1\n");
  await initRepository(project.directory);
  const client = (team as any).runtime.client;
  let n = 0;
  client.createSession = async () => ({ id: `ses_new${++n}` });
  client.messagePage = async () => ({ messages: [], hasMore: false });
  client.shells = async () => [];
  (team as any).registerTools = async () => {};
  team.usage.refresh = async () => {};

  await team.spawnWorker(project, core, { name: "branchy", purpose: "p", task: "t" });
  const branchy = team.findAgent(project, "branchy")!;
  assert.equal(branchy.branch, "symbio/branchy", "default: own copy");

  await team.setHelperWorkspace(project, "shared");
  assert.match(notes(calls, "ses_core").at(-1)!.body, /project folder itself/, "core is told");
  const reply = await team.spawnWorker(project, core, { name: "stepper", purpose: "p", task: "t" });
  const stepper = team.findAgent(project, "stepper")!;
  assert.equal(stepper.branch, null);
  assert.equal(stepper.directory, project.directory, "project setting: the project folder");
  assert.match(reply, /nothing to merge/);
  await team.spawnWorker(project, core, { name: "isolated", purpose: "p", task: "t", workspace: "own" });
  assert.equal(team.findAgent(project, "isolated")!.branch, "symbio/isolated", "core can still choose per helper");

  // Busy helpers aren't moved; unmerged work in its own copy blocks the move.
  await assert.rejects(team.moveToProjectFolder(project, branchy, "test"), /is working/);
  branchy.status = "idle";
  writeFileSync(path.join(branchy.directory, "draft.txt"), "x\n");
  await assert.rejects(team.moveToProjectFolder(project, branchy, "test"), /isn't in the project yet \(draft\.txt\)/, "uncommitted");
  await git(branchy.directory, "add", "-A");
  await git(branchy.directory, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "draft");
  await assert.rejects(team.moveToProjectFolder(project, branchy, "test"), /draft\.txt/, "committed but not merged");
  assert.equal((await team.mergeWork(project, branchy, true)).includes("draft.txt"), true);

  const oldDir = branchy.directory;
  await team.moveToProjectFolder(project, branchy, "test");
  assert.equal(branchy.directory, project.directory);
  assert.equal(branchy.branch, null);
  assert.equal(branchy.sessionId.startsWith("ses_new"), true, "continues in a fresh session");
  assert.equal(existsSync(oldDir), false, "its own copy is removed");
  assert.equal(await git(project.directory, "branch", "--list", "symbio/branchy"), "", "its merged branch is deleted");
});

test("a conversation too large to send gets one fresh session, then an alert instead of a loop", async () => {
  const { project, team, calls, store } = await setup();
  const writer = project.agents[1];
  const client = (team as any).runtime.client;
  let n = 0;
  client.createSession = async () => ({ id: `ses_fresh${++n}` });
  client.messagePage = async () => ({ messages: [], hasMore: false });
  client.interrupt = async () => {};
  team.usage.refresh = async () => {};
  const error = { type: "provider.error", message: "Timed out reading request body. Try again, or use a smaller request size." };

  await team.fallback.onFailure(project, writer, error);
  assert.equal(writer.sessionId, "ses_fresh1", "continues in a fresh session");
  assert.equal(writer.model, "p/m", "no model switching");
  assert.match(prompts(calls, "ses_fresh1").at(-1)!.body, /too large to send/, "and is told why");

  await team.fallback.onFailure(project, writer, error);
  assert.equal(writer.sessionId, "ses_fresh1", "not renewed again right away");
  assert.equal(writer.status, "error");
  const log = await store.readMessages(project);
  assert.ok(log.some((m: any) => m.kind === "alert" && /too large to send/.test(m.text)), "the human is told");
});

test("a question stays open while messages arrive, and the watchdog never interrupts it", async () => {
  const { project, team, calls, core, writer } = await setup();
  const runtime = (team as any).runtime;
  // Earlier tests' projects share the data folder (and "ses_core"): this core needs its own session.
  core.sessionId = "ses_core_question";
  runtime.client.interrupt = async (session: string) => calls.push({ method: "INTERRUPT", path: session });
  const interrupts = () => calls.filter((c) => c.method === "INTERRUPT").length;
  core.status = "busy";
  runtime.emit("event", { type: "session.tool.input.started", data: { sessionID: "ses_core_question", name: "question", id: "prt_q" } });
  assert.equal(core.status, "waiting");

  // What happened in a real project: a helper's report arrived while core waited on the human.
  await team.deliver(project, writer, core, "task-review", "T1 done");
  assert.equal(core.status, "waiting", "still waiting: the question stays visible");

  core.lastActivity = Date.now() - 60 * 60_000;
  await team.watchdog.checkStuck();
  assert.equal(core.status, "waiting");
  assert.equal(interrupts(), 0, "not interrupted");

  // Answered: back to work.
  runtime.emit("event", { type: "session.tool.success", data: { sessionID: "ses_core_question", id: "prt_q" } });
  assert.equal(core.status, "busy");

  // A question Symbio didn't see start (missed event): the watchdog finds it instead of interrupting.
  const client = runtime.client;
  const request = client.request;
  client.request = async (method: string, p: string, body?: any) =>
    p.endsWith("/form") ? { data: [{ id: "frm_1", fields: [] }] } : request(method, p, body);
  core.lastActivity = Date.now() - 60 * 60_000;
  await team.watchdog.checkStuck();
  assert.equal(core.status, "waiting");
  assert.equal(interrupts(), 0);
});

test("a helper that goes quiet without reporting is nudged once, then core is told; reporting or waiting for an asset isn't quiet", async () => {
  const { project, team, calls, core, writer, editor } = await setup();
  // Earlier tests' projects share the data folder (and their session names): use our own.
  core.sessionId = "ses_core_quiet";
  writer.sessionId = "ses_writer_quiet";
  editor.sessionId = "ses_editor_quiet";
  const runtime = (team as any).runtime;
  // A turn ends: OpenCode has delivered what was queued for the agent, and says the turn succeeded.
  const turnEnds = (agent: any) => {
    for (const inboxID of [...((team as any).inbox.get(agent.id)?.keys() ?? [])]) {
      runtime.emit("event", { type: "session.inbox.delivered", data: { sessionID: agent.sessionId, inboxID } });
    }
    runtime.emit("event", { type: "session.execution.succeeded", data: { sessionID: agent.sessionId } });
  };
  const check = (agent: any) => team.quiet.check(project.id, agent.id);
  const lastPrompt = (agent: any) => prompts(calls, agent.sessionId).at(-1)?.body ?? "";

  // Given work, the helper ends its turn without a word: nudged, then core is told.
  await team.deliver(project, core, writer, "request", "Write chapter 1");
  turnEnds(writer);
  await check(writer);
  assert.match(lastPrompt(writer), /ended your turn without reporting to core/);
  const toCore = prompts(calls, core.sessionId).length;
  turnEnds(writer);
  await check(writer);
  assert.match(lastPrompt(core), /writer has gone quiet/);
  turnEnds(writer);
  await check(writer);
  assert.equal(prompts(calls, core.sessionId).length, toCore + 1, "core is told once");

  // A report settles it.
  await team.deliver(project, core, writer, "request", "Write chapter 2");
  await team.deliver(project, writer, core, "info", "Chapter 2 is written, in chapters/02.md");
  const before = prompts(calls, writer.sessionId).length;
  turnEnds(writer);
  await check(writer);
  assert.equal(prompts(calls, writer.sessionId).length, before, "no nudge after reporting");

  // Waiting for a shared asset someone else holds isn't going quiet.
  await team.sharedAssets.request(project, editor, "chapters", "edit");
  await team.deliver(project, core, writer, "request", "Write chapter 3");
  await team.sharedAssets.request(project, writer, "chapters", "write chapter 3");
  const waiting = prompts(calls, writer.sessionId).length;
  turnEnds(writer);
  await check(writer);
  assert.equal(prompts(calls, writer.sessionId).length, waiting, "no nudge while waiting for an asset");
  team.quiet.reported(writer);
});

test("chat modes: Plan sets core's session rules and refuses work-starting tools; messages to core carry the mode", async () => {
  const { planModeRefusal } = await import("../src/server/tools.js");
  assert.match(planModeRefusal("spawn_agent", {})!, /Plan mode.*creating helpers is blocked/);
  assert.match(planModeRefusal("merge_work", { agent: "writer" })!, /merging work/);
  assert.match(planModeRefusal("send_message", { to: "writer", kind: "request", message: "go" })!, /asking helpers to do things/);
  assert.equal(planModeRefusal("send_message", { to: "writer", kind: "info", message: "fyi" }), null, "telling helpers things is fine");
  assert.equal(planModeRefusal("send_message", { to: "core", kind: "request", message: "x" }), null);
  assert.equal(planModeRefusal("github_api", { method: "GET", path: "/repos/x" }), null, "reading is fine");
  assert.match(planModeRefusal("github_api", { method: "POST", path: "/repos/x/pulls" })!, /changing things/);
  assert.equal(planModeRefusal("submit_plan", {}), null, "planning is the point");
  assert.equal(planModeRefusal("list_team", {}), null);

  const { project, team, calls, core } = await setup();
  core.sessionId = "ses_core_modes";
  const rulesSent = () => calls.filter((c) => c.method === "PATCH" && c.path === `/api/session/${core.sessionId}`).at(-1)?.body?.permissions ?? [];
  await team.setCoreMode(project, "plan");
  assert.equal(project.coreMode, "plan");
  assert.ok(rulesSent().some((r: any) => r.action === "edit" && r.resource === "*" && r.effect === "deny"), "edits denied in core's session");
  await team.sendFromHuman(project, core, "Let's think about the menu");
  assert.match(prompts(calls, core.sessionId).at(-1)!.body, /Let's think about the menu\n\n\[Mode: Plan — /);

  await team.setCoreMode(project, "act");
  assert.ok(!rulesSent().some((r: any) => r.action === "edit" && r.resource === "*"), "edits allowed again");
  await team.sendFromHuman(project, core, "Fix the typo");
  assert.match(prompts(calls, core.sessionId).at(-1)!.body, /\[Mode: Act — /);
  await team.setCoreMode(project, "auto");
  await team.sendFromHuman(project, core, "Hello");
  assert.equal(prompts(calls, core.sessionId).at(-1)!.body, "Hello", "Auto adds nothing");
});
