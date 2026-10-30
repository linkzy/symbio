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
