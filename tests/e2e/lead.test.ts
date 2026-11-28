// core as lead (docs/roadmap.md): the project's glossary reaches every agent, tasks have a Done when
// the helper gets and the human can change, and a fresh session can start from the agent's own
// handoff, with the conversation's size shown in its chat.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;

test("new projects are light (no rules register up front) and give helpers a fresh session after each task; a thorough one keeps a register; the glossary reaches every agent", async () => {
  const light = await projectWithCore(symbio, "Light");
  assert.equal(light.project.depth, "light");
  assert.equal(light.project.rulesRegister, false);
  const { project, core } = await projectWithCore(symbio, "Glossary", { depth: "thorough" });
  assert.equal(project.depth, "thorough");
  assert.equal(project.rulesRegister, true);
  assert.equal(project.renewSessions, "after-task");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  // core starts the glossary; it's listed right after AGENTS.md.
  await say("@core write docs/glossary.md | lote | a batch of forms sent together | pacote |");
  await say("@core write AGENTS.md # Agents");
  const docs = await symbio.call("GET", `/projects/${project.id}/docs`);
  assert.deepEqual(docs.files.map((f: any) => f.path).slice(0, 2), ["AGENTS.md", "docs/glossary.md"]);
  // core has it on its next turn, and a helper from its first.
  await say("@core knows | lote | a batch of forms");
  assert.match(await history(symbio, project.id, core.id), /knows: yes/);
  await say(tool("core", "spawn_agent", { name: "forms", purpose: "Forms", task: "@forms knows | lote | a batch of forms", workspace: "shared" }));
  const helper = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "forms");
  await until("the helper to know the glossary", async () => /knows: yes/.test(await history(symbio, project.id, helper.id)));
});

test("Done when: core writes it, the helper gets it with the task, the human changes it on the board", async () => {
  const { project, core } = await projectWithCore(symbio, "Done when");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "submit_plan", { goal: "A page", tasks: [{ key: "page", title: "Write the page", description: "Hello page", done_when: "The page says hello" }] }));
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });
  await say(tool("core", "spawn_agent", { name: "pages", purpose: "Pages", task_id: "T1", task: "@pages say on it", workspace: "shared" }));
  const pages = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "pages");
  await until("the helper to get its Done when", async () => /Done when:\\n\s*The page says hello/.test(await history(symbio, project.id, pages.id)));

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator(".task-card", { hasText: "Write the page" }).click();
  const section = page.locator(".done-when");
  await section.locator("li", { hasText: "The page says hello" }).waitFor();
  await section.getByRole("button", { name: "Edit" }).click();
  await section.locator("textarea").fill("The page says hello\nIn large letters");
  await section.getByRole("button", { name: "Save" }).click();
  await section.locator("li", { hasText: "In large letters" }).waitFor();
  await until("the change to be saved", async () => (await symbio.call("GET", `/projects/${project.id}/plan`)).tasks[0].doneWhen === "The page says hello\nIn large letters");
  await until("the change to be logged", async () =>
    (await symbio.call("GET", `/projects/${project.id}/log`)).some((m: any) => /T1's Done when was changed by the human/.test(m.text)),
  );
  // Only core changes it among the agents.
  await say(tool("core", "update_task", { task_id: "T1", done_when: "The page says hello in large letters" }));
  assert.equal((await symbio.call("GET", `/projects/${project.id}/plan`)).tasks[0].doneWhen, "The page says hello in large letters");
  assert.deepEqual((page as any).errors, []);
});

test("a fresh session from the agent's own handoff; the conversation's size shows in its chat", async () => {
  const { project, core } = await projectWithCore(symbio, "Fresh start");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core say working on it" });
  await idle(symbio, project.id);
  await until("the conversation's size to be known", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents[0].context?.tokens > 0);

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".context-size", { hasText: "% of its context" }).waitFor();
  await page.locator(".chat-head button", { hasText: "Fresh session" }).click();
  const dialog = page.locator(".dialog", { hasText: "A fresh session for core" });
  assert.equal(await dialog.locator("input[type=checkbox]").isChecked(), true, "its own handoff by default");
  await dialog.getByRole("button", { name: "Fresh session" }).click();
  await until("core to be in a fresh session", async () => ((await symbio.call("GET", `/projects/${project.id}`)).agents[0].previousSessions ?? []).length === 1);
  await idle(symbio, project.id);
  // The new session starts from its own handoff (its answer to the request), plus Symbio's note.
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core knows Your own handoff, written at the end of your previous session" });
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, core.id), /knows: yes/);
  assert.deepEqual((page as any).errors, []);
});
