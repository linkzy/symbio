// The chat shows the team's work in plain words: a run of steps folds into one line, each step
// reads as what it did (Symbio's tools from their arguments, commands by what they run), and the
// raw command or script is a click away.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, gitRepo, idle, openPage, projectWithCore, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;

test("a run of steps folds into one line in plain words, the raw command a click away", async () => {
  const directory = gitRepo(symbio.folder("steps"));
  const { project, core } = await projectWithCore(symbio, "Steps", { directory });
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "spawn_agent", { name: "setor", purpose: "Setor module", task: "@setor say ok", workspace: "shared" }));
  await say(
    [
      "@core say Checking the work first.",
      "@core shell git status --short",
      tool("core", "send_message", { to: "setor", message: "Got T201, publishing it now." }),
      tool("core", "list_tasks", {}),
      "@core say All set.",
    ].join("\n"),
  );

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  // A single step stands alone, in words.
  await page.locator(".msg-assistant > .tool .step-text", { hasText: "Created helper setor" }).waitFor();
  // Three steps between two texts: one line, the most telling step first.
  const run = page.locator(".step-run").last();
  assert.equal(await run.locator(".step-run-title").innerText(), "Message to setor · Checked git status and 1 more");
  assert.equal(await run.locator(".step-run-count").innerText(), "3 steps");
  assert.ok(!(await page.locator(".chat-col").innerText()).includes("tools.symbio.send_message"), "no raw script on screen");

  await run.locator("> summary").click();
  const texts = await run.locator(".step-text").allInnerTexts();
  assert.deepEqual(texts, ["Checked git status", "Message to setor", "Checked the plan"]);
  const message = run.locator(".step-run-body > .tool", { hasText: "Message to setor" });
  await message.locator(".tool-arg", { hasText: "Got T201, publishing it now." }).waitFor();
  await message.locator("> summary").click();
  await message.locator("pre.tool-io", { hasText: "tools.symbio.send_message" }).waitFor();
  await message.locator("pre.tool-io.out", { hasText: "Delivered to setor." }).waitFor();
});

test("a helper's report is a card: its task and title on top, the summary folded, core's instructions left out", async () => {
  const { project, core } = await projectWithCore(symbio, "Reports");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "submit_plan", { goal: "Letters", tasks: [{ key: "email", title: "Rejection e-mail like the office's", description: "x" }] }));
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });
  const summary = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of what changed, with enough words to fill the width of the chat column.`).join("\n\n");
  await say(tool("core", "spawn_agent", { name: "letters", purpose: "Letters", task_id: "T1", task: tool("letters", "update_task", { task_id: "T1", status: "review", summary }), workspace: "shared" }));

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  const card = page.locator(".msg-agent.report");
  await card.waitFor();
  assert.equal(await card.locator(".report-task .task-id").innerText(), "T1");
  assert.equal(await card.locator(".report-title").innerText(), "Rejection e-mail like the office's");
  assert.ok(!(await card.innerText()).includes("Its work is already in the project folder"), "core's instructions aren't shown");
  // A long summary starts folded (clipped to a few lines), and opens in full.
  await card.locator(".folded.clipped").waitFor();
  const folded = await card.locator(".folded-body").evaluate((el) => el.clientHeight < el.scrollHeight);
  assert.ok(folded, "the summary is clipped");
  await card.locator(".folded-toggle", { hasText: "Show all" }).click();
  await card.locator(".folded.open").waitFor();
  assert.ok(await card.locator(".folded-body").evaluate((el) => el.clientHeight >= el.scrollHeight), "all of it shows");
  await card.locator(".folded-toggle", { hasText: "Show less" }).waitFor();
});
