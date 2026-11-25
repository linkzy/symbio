// Moving a project to another agent runtime (Project settings → Agent runtime): every agent continues
// in a new session there, from a handoff note (its own, written in a last turn, plus Symbio's), with
// the project's models carried over; the earlier conversations stay readable; core is told.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, MODEL, openPage, projectWithCore, RUNTIME, startSymbio, until, type Symbio, openProjectSettings } from "./harness.js";

const OTHER = RUNTIME === "copilot" ? "opencode" : "copilot";
const OTHER_MODEL = `${OTHER === "copilot" ? "copilot" : "fake"}/scripted`;
const LABEL = { opencode: "OpenCode", copilot: "GitHub Copilot CLI" } as const;

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const say = (project: any, core: any, text: string) => symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
const switched = (projectId: string) =>
  until("the switch to finish", async () => (await symbio.call("GET", `/projects/${projectId}/switch-runtime`))?.status !== "running", 30_000, symbio.output);

test("a project moves to the other runtime from its settings, with its team, handoffs and models", async () => {
  const { project, core } = await projectWithCore(symbio, "Moving");
  const spawn = `@core tool spawn_agent ${JSON.stringify({ name: "builder", purpose: "Builds", task: "@builder say on it", workspace: "shared" })}`;
  await say(project, core, ["Start", spawn].join("\n"));
  await idle(symbio, project.id);
  const before = await symbio.call("GET", `/projects/${project.id}`);
  const builder = before.agents.find((a: any) => a.name === "builder");
  assert.ok(builder, "a helper to move too");

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "team");
  const section = page.locator("#agent-runtime");
  await section.locator("strong", { hasText: LABEL[RUNTIME] }).waitFor();
  await section.locator("button", { hasText: "Switch runtime" }).click();
  const dialog = page.locator(".dialog");
  await dialog.locator(".notice", { hasText: "Best done when the team is idle" }).waitFor();
  // The project's model was carried over to the same model there.
  await dialog.locator(".model-group-title", { hasText: "Selected" }).waitFor();
  await dialog.locator("button.btn.primary", { hasText: `Move to ${LABEL[OTHER]}` }).click();
  await section.locator(".switch-status.done", { hasText: `Moved ${LABEL[RUNTIME]} → ${LABEL[OTHER]}` }).waitFor({ timeout: 30_000 });
  await idle(symbio, project.id);

  assert.deepEqual((await symbio.call("GET", `/projects/${project.id}/switch-runtime`)).withoutHandoff, [], "every agent wrote its handoff");
  const moved = await symbio.call("GET", `/projects/${project.id}`);
  assert.equal(moved.runtime, OTHER);
  assert.deepEqual(moved.allowedModels, [OTHER_MODEL]);
  assert.equal(moved.coordinatorModel, OTHER_MODEL);
  assert.ok(!moved.paused, "the team runs again");
  for (const name of ["core", "builder"]) {
    const was = before.agents.find((a: any) => a.name === name);
    const now = moved.agents.find((a: any) => a.name === name);
    assert.equal(now.runtime, OTHER, name);
    assert.equal(now.model, OTHER_MODEL, name);
    assert.notEqual(now.sessionId, was.sessionId, `${name} has a new session`);
    assert.deepEqual(now.previousSessions.at(-1), { ...now.previousSessions.at(-1), sessionId: was.sessionId, runtime: RUNTIME });
    // Its earlier conversation is still readable, from the runtime it lives in.
    const old = await symbio.call("GET", `/projects/${project.id}/agents/${now.id}/history?limit=50&session=${was.sessionId}`);
    assert.match(JSON.stringify(old.messages), /This is your last turn in this session/, `${name} was asked for its handoff`);
  }
  // Core heard about it, and answered on the new runtime.
  const coreNow = await history(symbio, project.id, core.id);
  assert.match(coreNow, new RegExp(`moved this project from ${LABEL[RUNTIME]} to ${LABEL[OTHER]}`));
  assert.match(coreNow, /Noted \(core\)/);
  // The helper works there too.
  await symbio.call("POST", `/projects/${project.id}/agents/${builder.id}/messages`, { text: "Still there?" });
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, builder.id), /Still there\?.*\n.*Noted \(builder\)/);
  // The top bar shows the runtime the project's agents run on now.
  await page.locator(`.topbar .runtime[data-runtime="${OTHER}"]`).waitFor();
  assert.deepEqual((page as any).errors, []);
});

test("a switch checks its models; a stopped helper moves when restarted; and the project can move back", async () => {
  const { project, core } = await projectWithCore(symbio, "Back and forth");
  await say(project, core, `@core tool spawn_agent ${JSON.stringify({ name: "resting", purpose: "Waits", task: "@resting say ok", workspace: "shared" })}`);
  await idle(symbio, project.id);
  const resting = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "resting");
  await symbio.call("POST", `/projects/${project.id}/agents/${resting.id}/stop`);

  const body = { to: OTHER, allowedModels: [OTHER_MODEL], coordinatorModel: OTHER_MODEL, coreModels: [OTHER_MODEL], coreOnlyModels: [], askHandoffs: false };
  await assert.rejects(symbio.call("POST", `/projects/${project.id}/switch-runtime`, { ...body, to: RUNTIME }), /already runs on/);
  await assert.rejects(symbio.call("POST", `/projects/${project.id}/switch-runtime`, { ...body, allowedModels: [MODEL], coordinatorModel: MODEL, coreModels: [MODEL] }), /doesn't have/);

  await symbio.call("POST", `/projects/${project.id}/switch-runtime`, body);
  await switched(project.id);
  assert.equal((await symbio.call("GET", `/projects/${project.id}/switch-runtime`)).status, "done");
  let p = await symbio.call("GET", `/projects/${project.id}`);
  assert.equal(p.agents.find((a: any) => a.name === "resting").runtime ?? "opencode", RUNTIME, "a stopped helper stays until restarted");

  await symbio.call("POST", `/projects/${project.id}/agents/${resting.id}/restart`);
  p = await symbio.call("GET", `/projects/${project.id}`);
  const restarted = p.agents.find((a: any) => a.name === "resting");
  assert.equal(restarted.runtime, OTHER);
  assert.equal(restarted.previousSessions.at(-1).runtime, RUNTIME);
  await symbio.call("POST", `/projects/${project.id}/agents/${resting.id}/messages`, { text: "Back?" });
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, resting.id), /Back\?.*\n.*Noted \(resting\)/);

  // And back again, the same way.
  await symbio.call("POST", `/projects/${project.id}/switch-runtime`, { ...body, to: RUNTIME, allowedModels: [MODEL], coordinatorModel: MODEL, coreModels: [MODEL] });
  await switched(project.id);
  await idle(symbio, project.id);
  p = await symbio.call("GET", `/projects/${project.id}`);
  assert.equal(p.runtime ?? "opencode", RUNTIME);
  assert.ok(p.agents.filter((a: any) => a.status !== "stopped").every((a: any) => (a.runtime ?? "opencode") === RUNTIME));
  assert.equal(p.agents.find((a: any) => a.role === "coordinator").previousSessions.length, 2, "core's sessions on both runtimes are kept");
});
