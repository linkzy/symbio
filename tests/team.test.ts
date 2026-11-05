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
    setPermissions: async () => {},
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
  const answer = await team.requestAsset(project, writer, "chapters", "write chapter 1");
  assert.match(answer, /Granted/);
  const reg = await team.assets(project);
  assert.equal(reg.list().find((a) => a.name === "chapters")!.holder, writer.id);
  assert.equal(prompts(calls, "ses_core").length, 0, "core was not woken");
  assert.equal(notes(calls, "ses_core").length, 1, "core got a note");

  // Released with nobody waiting: again only a note.
  await team.releaseAsset(project, writer, "chapters", "chapter 1 done");
  assert.equal(prompts(calls, "ses_core").length, 0, "still not woken");
  assert.equal(notes(calls, "ses_core").length, 2);
});

test("a held asset goes to core to decide, and the release wakes core when someone waits", async () => {
  const { project, team, calls, writer, editor } = await setup();
  await team.requestAsset(project, writer, "chapters", "write");
  const answer = await team.requestAsset(project, editor, "chapters", "edit");
  assert.match(answer, /Request sent to the coordinator/);
  assert.equal(prompts(calls, "ses_core").length, 1, "contention → core decides");
  await team.releaseAsset(project, writer, "chapters", "done");
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

  assert.match(await team.listProcesses(project, writer), /sh_w/);
  assert.doesNotMatch(await team.listProcesses(project, writer), /sh_e|sh_c|sh_none|sh_x/);
  const coreList = await team.listProcesses(project, core);
  assert.match(coreList, /sh_c/);
  assert.match(coreList, /sh_none/, "processes with no recorded owner are core's");
  assert.match(coreList, /sh_x/, "processes of sessions no agent has are core's");
  assert.doesNotMatch(coreList, /sh_w|sh_e/, "not the helpers'");
  await assert.rejects(team.stopProcess(project, editor, "sh_w"), /No running background process/);

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
  (team as any).refreshUsage = async () => {};

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
  (team as any).refreshUsage = async () => {};
  const error = { type: "provider.error", message: "Timed out reading request body. Try again, or use a smaller request size." };

  await (team as any).fallback(project, writer, error);
  assert.equal(writer.sessionId, "ses_fresh1", "continues in a fresh session");
  assert.equal(writer.model, "p/m", "no model switching");
  assert.match(prompts(calls, "ses_fresh1").at(-1)!.body, /too large to send/, "and is told why");

  await (team as any).fallback(project, writer, error);
  assert.equal(writer.sessionId, "ses_fresh1", "not renewed again right away");
  assert.equal(writer.status, "error");
  const log = await store.readMessages(project);
  assert.ok(log.some((m: any) => m.kind === "alert" && /too large to send/.test(m.text)), "the human is told");
});
