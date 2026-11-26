// Team logic against a fake agent runtime: records the calls instead of running models.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-team-home-"));
const { Store } = await import("../src/server/store.js");
const { Team } = await import("../src/server/team.js");

/** A stand-in for the agent runtime: answers every call and remembers prompts (which start a turn) and notes. */
function fakeRuntime() {
  const calls: { method: string; path: string; body?: any }[] = [];
  let sessions = 0;
  const runtime: any = Object.assign(new EventEmitter(), {
    kind: "opencode",
    label: "OpenCode",
    state: "running",
    calls,
    prompt: async (sessionId: string, text: string) => {
      calls.push({ method: "PROMPT", path: sessionId, body: text });
      return `inbox_${calls.length}`;
    },
    note: async (sessionId: string, text: string) => {
      calls.push({ method: "NOTE", path: sessionId, body: text });
    },
    setInstruction: async () => {},
    setPermissions: async (sessionId: string, permissions: any) => {
      calls.push({ method: "PERMISSIONS", path: sessionId, body: permissions });
    },
    setSkills: async () => {},
    skillsChanged: () => {},
    ensureTools: async () => {},
    queued: async () => [],
    cancelQueued: async () => true,
    interrupt: async () => {},
    switchModel: async () => {},
    createSession: async () => `ses_new${++sessions}`,
    deleteSession: async () => {},
    historyPage: async () => ({ messages: [], hasMore: false }),
    shells: async () => [],
    stopShell: async () => {},
    forms: async () => [],
    answerForm: async () => {},
    answerPermission: async () => {},
    sessionUsage: async () => null,
    childSessions: async () => [],
    changes: async () => [],
  });
  return { runtime, calls };
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
  const shell = (id: string, sessionId?: string) => ({ id, running: true, command: `run ${id}`, started: 0, sessionId });
  // One list per folder, with the session that started each shell when the runtime knows it.
  let shells = [shell("sh_w", "ses_writer"), shell("sh_e", "ses_editor"), shell("sh_c", "ses_core"), shell("sh_none"), shell("sh_x", "ses_gone")];
  const stopped: string[] = [];
  const runtime = (team as any).runtime;
  runtime.shells = async () => shells;
  runtime.stopShell = async (_dir: string, id: string) => {
    stopped.push(id);
    shells = shells.filter((s) => s.id !== id);
  };

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

test("a reviewer in a helper's own folder stops only what it started there, not the helper's programs", async () => {
  const { project, team, editor } = await setup();
  const own = path.join(project.directory, "..", "editor-copy");
  editor.directory = own;
  editor.branch = "symbio/editor";
  const reviewer = { id: "agt_r", name: "review-t1", role: "worker", reviewer: { taskId: "T1", of: editor.id, by: "coordinator" }, sessionId: "ses_review", directory: own, model: "p/m", status: "idle", lastActivity: 0, createdAt: 0 };
  project.agents.push(reviewer);
  let shells = [{ id: "sh_server", running: true, command: "serve", started: 0, sessionId: "ses_editor" }, { id: "sh_r", running: true, command: "test", started: 0, sessionId: "ses_review" }];
  const stopped: string[] = [];
  const runtime = (team as any).runtime;
  runtime.shells = async () => shells;
  runtime.stopShell = async (_dir: string, id: string) => {
    stopped.push(id);
    shells = shells.filter((s) => s.id !== id);
  };
  assert.doesNotMatch(await team.processes.list(project, reviewer as any), /sh_server/);
  await team.stopAgent(project, reviewer as any, "its review is done");
  assert.deepEqual(stopped, ["sh_r"]);
  // Alone in its folder again, the helper owns everything there.
  assert.match(await team.processes.list(project, editor), /sh_server/);
});

test("where helpers work: project setting, per-helper choice, and moving a helper into the project folder", async () => {
  const { git, initRepository } = await import("../src/server/git.js");
  const { writeFileSync, existsSync } = await import("node:fs");
  const { project, team, calls, core } = await setup();
  writeFileSync(path.join(project.directory, "a.txt"), "1\n");
  await initRepository(project.directory);
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

test("a pinned helper waits and retries its model instead of switching; unpinned, it switches", async () => {
  const { project, team, calls, store, core, writer } = await setup();
  project.allowedModels = ["p/m", "p/n"];
  writer.sessionId = "ses_pinned_writer";
  const outage = { type: "provider.error", status: 503, message: "Service unavailable: overloaded" };

  await team.pinModel(project, writer, true, "human");
  assert.match(notes(calls, core.sessionId).at(-1)!.body, /the human pinned writer to p\/m/, "core is told");
  await assert.rejects(team.pinModel(project, writer, false, "coordinator"), /only they can unpin/);

  const before = Date.now();
  await team.fallback.onFailure(project, writer, outage);
  assert.equal(writer.model, "p/m", "not switched");
  assert.equal(writer.status, "error");
  assert.ok(writer.modelWait && writer.modelWait.attempt === 0);
  assert.ok(writer.modelWait!.until - before >= 15_000 && writer.modelWait!.until - before < 20_000, "first try again after about 15 seconds");

  // The retry wakes it on the same model; failing again, it waits longer.
  await team.fallback.retryPinned(project.id, writer.id);
  assert.match(prompts(calls, "ses_pinned_writer").at(-1)!.body, /trying your pinned model p\/m again/);
  assert.equal(writer.status, "busy");
  await team.fallback.onFailure(project, writer, outage);
  assert.equal(writer.modelWait!.attempt, 1);
  assert.ok(writer.modelWait!.until - Date.now() > 25_000, "then about 30 seconds");

  // Unpinned while waiting: it switches at once, as before.
  await team.pinModel(project, writer, false, "human");
  assert.equal(writer.model, "p/n", "switched to the other allowed model");
  assert.equal(writer.modelWait, null);
  assert.match(prompts(calls, "ses_pinned_writer").at(-1)!.body, /You were switched to p\/n/);

  // A model that can't be used isn't retried forever: the human is told at once.
  await team.pinModel(project, writer, true, "coordinator");
  await team.fallback.onFailure(project, writer, { type: "provider.error", status: 404, message: 'Model "p/n" is not available.' });
  assert.equal(writer.model, "p/n");
  assert.equal(writer.modelWait, null, "no retries");
  const log = await store.readMessages(project);
  assert.ok(log.some((m: any) => m.kind === "alert" && /pinned to it, so it isn't switched/.test(m.text)));
  team.fallback.cancelRetry(writer.id);
});

test("a conversation too large to send gets one fresh session, then an alert instead of a loop", async () => {
  const { project, team, calls, store } = await setup();
  const writer = project.agents[1];
  let n = 0;
  (team as any).runtime.createSession = async () => `ses_fresh${++n}`;
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
  runtime.interrupt = async (session: string) => {
    calls.push({ method: "INTERRUPT", path: session });
  };
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
  runtime.forms = async () => [{ id: "frm_1", fields: [] }];
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
  const rulesSent = () => calls.filter((c) => c.method === "PERMISSIONS" && c.path === core.sessionId).at(-1)?.body ?? [];
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

test("review by the human: a guide is required, done waits for the human, approve finishes it, send back reopens it", async () => {
  const { project, team, calls, core, writer } = await setup();
  core.sessionId = "ses_core_review";
  writer.sessionId = "ses_writer_review";
  const plan = await team.plan(project);
  await plan.propose("Two chapters", [
    { key: "one", title: "Chapter 1", description: "Write it" },
    { key: "two", title: "Chapter 2", description: "Write it", depends_on: ["one"] },
  ]);
  await plan.decide(true, null);
  const [t1, t2] = plan.plan.tasks;
  await team.assignTask(project, core, t1.id, writer);

  // Core reviews (the default): done is done, a guide is optional.
  await team.updateTask(project, writer, t1.id, "review", "Written");
  await team.updateTask(project, core, t1.id, "done", undefined);
  assert.equal(plan.task(t1.id).status, "done");
  await plan.update(t1.id, { status: "in-progress" });

  // The human reviews every task.
  project.reviewBy = "every";
  await assert.rejects(team.updateTask(project, writer, t1.id, "review", "Written"), /report it with a guide/);
  await team.updateTask(project, writer, t1.id, "review", "Written", "Open chapters/01.md; the hook is in the first paragraph. I re-read it myself.");
  assert.match(plan.task(t1.id).guide!, /chapters\/01\.md/);
  assert.match(await team.updateTask(project, core, t1.id, "done", "Looks good"), /waits for the human's review/);
  assert.equal(plan.task(t1.id).status, "review");
  assert.equal(plan.task(t1.id).humanReview?.state, "waiting");
  assert.deepEqual(plan.openDependencies(plan.task(t2.id)).map((t) => t.id), [t1.id], "chapter 2 waits");

  // Sent back: reopened, the note goes to the helper, core is told.
  await team.reviews.sendBack(project, t1.id, "The hook is too long");
  assert.equal(plan.task(t1.id).status, "in-progress");
  assert.match(prompts(calls, writer.sessionId).at(-1)!.body, /sent back by the human[\s\S]*The hook is too long/);
  assert.match(notes(calls, core.sessionId).at(-1)!.body, /sent back by the human[\s\S]*went back to writer/);
  await assert.rejects(team.reviews.approve(project, t1.id), /isn't waiting for your review/);

  // Reported again, done again, approved: done, and core is told.
  await team.updateTask(project, writer, t1.id, "review", "Shorter hook", "Same file, first paragraph.");
  assert.equal(plan.task(t1.id).humanReview, undefined, "a fresh review");
  await team.updateTask(project, core, t1.id, "done", undefined);
  await team.reviews.approve(project, t1.id, "Great");
  assert.equal(plan.task(t1.id).status, "done");
  assert.equal(plan.openDependencies(plan.task(t2.id)).length, 0, "chapter 2 can start");
  assert.match(prompts(calls, core.sessionId).at(-1)!.body, /the human approved .*Chapter 1.*\(Great\)/);
});

test("a turn that ends before its prompt's reply arrives leaves the agent idle, not working", async () => {
  const { project, team, writer } = await setup();
  const runtime: any = (team as any).rt(writer);
  const prompt = runtime.prompt;
  // The runtime's events come on another connection: a quick turn can be over before the prompt call returns.
  runtime.prompt = async (sessionId: string, text: string) => {
    const id = await prompt(sessionId, text);
    runtime.emit("event", { type: "session.execution.started", data: { sessionID: sessionId } });
    runtime.emit("event", { type: "session.execution.succeeded", data: { sessionID: sessionId } });
    await new Promise((r) => setTimeout(r, 20));
    return id;
  };
  await team.sendFromHuman(project, writer, "hello");
  assert.equal(writer.status, "idle");
  runtime.prompt = prompt;
  await team.sendFromHuman(project, writer, "again");
  assert.equal(writer.status, "busy");
});

test("list_team: a working helper shows for how long, its last activity and what it runs", async () => {
  const { workingText } = await import("../src/server/tools.js");
  const now = Date.now();
  const project: any = { id: "p1" };
  const helper: any = { id: "h1", name: "bots", busySince: now - 95 * 60_000, lastActivity: now - 20_000 };
  const programs = [
    { pid: 7, name: "node", cpu: 88, owners: [{ projectId: "p1", agentId: "h1" }] },
    { pid: 8, name: "chrome", cpu: 5, owners: [{ projectId: "p2", agentId: "h1" }] },
  ];
  assert.equal(workingText(project, helper, programs), "working for 1.6 h, last activity 20s ago; running node (pid 7, 88% CPU)");
  assert.equal(workingText(project, { ...helper, lastActivity: now - 40 * 60_000 }, []), "working for 1.6 h, last activity 40 min ago; no programs running");
});

test("after a merge, core hears which tasks could start now and which helpers are free", async () => {
  const { readyNote } = await import("../src/server/team/tasks.js");
  const task = (id: string, status: string, dependsOn: string[] = [], assets: string[] = [], assignee: string | null = null): any => ({ id, title: `task ${id}`, status, dependsOn, assets, assignee });
  const tasks = [
    task("T7", "done"),
    task("T10", "in-progress", ["T7"], ["sim"], "h1"),
    task("T11", "todo", ["T7"], ["infra"]),
    task("T12", "todo", ["T7"], ["bot"]),
    task("T13", "todo", ["T10"]),
    task("T14", "todo", ["T7"], ["sim"]),
  ];
  const agents: any[] = [
    { id: "h1", name: "architect", role: "worker", status: "busy" },
    { id: "h2", name: "client", role: "worker", status: "idle" },
  ];
  const assets: any[] = [{ name: "sim", holder: "h1" }, { name: "infra", holder: null }];
  const note = readyNote(tasks, agents, assets, false);
  assert.match(note, /Ready to start, with nothing in their way: T11 \(task T11\), T12 \(task T12\)\./, "not T13 (waits on T10) nor T14 (sim is held)");
  assert.match(note, /Helpers with nothing under way: client\./);
  assert.match(readyNote(tasks, agents, assets, true), /overloaded now/);
  assert.equal(readyNote([task("T1", "done")], agents, assets, false), "");
});
