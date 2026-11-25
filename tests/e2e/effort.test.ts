// Reasoning effort: a level per model in the project's settings, an agent's own level from its chat,
// and core's (spawn_agent effort); the session runs at the level that applies. Also AI co-author
// lines in commits: left out unless the project allows them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, MODEL, MODEL_2, openPage, projectWithCore, startSymbio, until, type Symbio, openProjectSettings } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const agentNamed = async (projectId: string, name: string) => (await symbio.call("GET", `/projects/${projectId}`)).agents.find((a: any) => a.name === name);

/** Asks an agent (the stand-in model) which level its session is on, and returns what it said. */
async function effortOf(projectId: string, agent: { id: string; name: string }) {
  const before = (await history(symbio, projectId, agent.id)).match(/effort: \w+/g)?.length ?? 0;
  await symbio.call("POST", `/projects/${projectId}/agents/${agent.id}/messages`, { text: `@${agent.name} effort` });
  let said = "";
  await until(`${agent.name} to say its effort`, async () => {
    const all = (await history(symbio, projectId, agent.id)).match(/effort: \w+/g) ?? [];
    said = all.length > before ? all[all.length - 1] : "";
    return !!said;
  });
  await idle(symbio, projectId);
  return said.replace("effort: ", "");
}

test("reasoning effort: per model in the project, per agent in its chat, and core's for its helpers", async () => {
  const { project, core } = await projectWithCore(symbio, "Effort", { models: [MODEL, MODEL_2] });
  assert.equal(await effortOf(project.id, core), "default");

  // Project settings → Reasoning effort: only models with levels are listed.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "team");
  const section = page.locator("#effort");
  await section.waitFor();
  assert.equal(await section.locator("select").count(), 1, "only the model that has levels");
  await section.getByLabel(`Reasoning effort for ${MODEL}`).selectOption("high");
  await until("saved", async () => (await symbio.call("GET", `/projects/${project.id}`)).modelEfforts?.[MODEL] === "high");
  assert.equal(await effortOf(project.id, core), "high", "core's session follows its model's level");

  // core's own level, from its chat header, over the project's.
  await page.locator(".tab", { hasText: "Chat" }).click();
  const select = page.locator(".chat-head").getByLabel("Reasoning effort");
  assert.equal(await select.locator("option").first().innerText(), "effort: high (project)");
  await select.selectOption("low");
  await until("core's own level", async () => (await agentNamed(project.id, "core")).effort?.level === "low");
  assert.equal(await effortOf(project.id, core), "low");
  await select.selectOption("");
  await until("back to the project's", async () => !(await agentNamed(project.id, "core")).effort);
  assert.equal(await effortOf(project.id, core), "high");

  // core gives a helper its own level; a level the model doesn't take is refused with the ones it does.
  const spawn = (name: string, effort: string) =>
    `@core tool spawn_agent ${JSON.stringify({ name, purpose: "Writes", task: `@${name} say ready`, workspace: "shared", model: MODEL, effort })}`;
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: [spawn("thinker", "low"), spawn("wrong", "enormous")].join("\n") });
  await until("the helper", async () => !!(await agentNamed(project.id, "thinker")));
  await idle(symbio, project.id);
  assert.equal(await agentNamed(project.id, "wrong"), undefined);
  assert.match(await history(symbio, project.id, core.id), /doesn't take the reasoning effort \\?"enormous\\?"\. Its levels: low, /);
  const thinker = await agentNamed(project.id, "thinker");
  assert.deepEqual(thinker.effort, { level: "low", by: "coordinator" });
  assert.equal(await effortOf(project.id, thinker), "low");
  assert.deepEqual((page as any).errors, []);
});

test("AI co-author lines in commits are left out unless the project allows them", async () => {
  const { project, core } = await projectWithCore(symbio, "Coauthors");
  const ask = async () => {
    const before = (await history(symbio, project.id, core.id)).match(/coauthor: \w+/g)?.length ?? 0;
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core coauthor" });
    let said = "";
    await until("core to answer", async () => {
      const all = (await history(symbio, project.id, core.id)).match(/coauthor: \w+/g) ?? [];
      said = all.length > before ? all[all.length - 1] : "";
      return !!said;
    });
    await idle(symbio, project.id);
    return said;
  };
  assert.equal(await ask(), "coauthor: off", "left out by default");

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "team");
  // Done when the save answers: the project shows the setting at once, the agents' instructions a moment later.
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/projects/${project.id}`));
  await page.locator(".field", { hasText: "AI co-authors in commits" }).getByRole("button", { name: "Allow them" }).click();
  await saved;
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).aiCoauthors, true);
  assert.equal(await ask(), "coauthor: on");
});
