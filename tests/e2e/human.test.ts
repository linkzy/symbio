// What the human does directly: files with an answer and with sending a task back, helpers they
// create and talk to themselves, and costs hidden until they turn them on.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio, openProjectSettings } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;

test("files go with an answer and with sending a task back", async () => {
  const { project, core, directory } = await projectWithCore(symbio, "Files with answers");
  await symbio.call("PATCH", `/projects/${project.id}`, { reviewBy: "every" });
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "ask_human", { question: "Which logo should the site use?" }));
  const file = path.join(directory, "..", "logo-choice.txt");
  writeFileSync(file, "the round one");

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  const card = page.locator(".question-card", { hasText: "Which logo" });
  await card.locator("input[type=file]").setInputFiles(file);
  await card.locator(".att-chip.ready").waitFor();
  // A file alone is an answer.
  await page.locator(".questions-head button", { hasText: "Send answer" }).click();
  await until("core to get the file", async () => /Attached by the human[^"]*logo-choice\.txt/.test(await history(symbio, project.id, core.id)));
  const q = (await symbio.call("GET", `/projects/${project.id}/questions`))[0];
  assert.equal(q.state, "answered");
  assert.deepEqual(q.files, ["logo-choice.txt"]);

  // Sending a task back with a screenshot: the helper gets it with the note.
  await say(tool("core", "submit_plan", { goal: "Site", tasks: [{ key: "logo", title: "Put the logo in", description: "x" }] }));
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });
  const step = tool("web", "update_task", { task_id: "T1", status: "review", summary: "Done", guide: "Look at the header." });
  await say(tool("core", "spawn_agent", { name: "web", purpose: "Site", task_id: "T1", task: step, workspace: "shared" }));
  await say(tool("core", "update_task", { task_id: "T1", status: "done" }));
  const shot = path.join(directory, "..", "header-wrong.txt");
  writeFileSync(shot, "the logo is cut off");
  const review = page.locator(".inbox-item", { hasText: "To review" });
  await review.waitFor();
  await review.locator("button", { hasText: "Send back" }).click();
  await review.locator("textarea").fill("The logo is cut off, see the file.");
  await review.locator("input[type=file]").setInputFiles(shot);
  await review.locator(".att-chip.ready").waitFor();
  await review.locator("button.primary", { hasText: "Send back" }).click();
  const web = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "web");
  await until("the helper to get the note and the file", async () => {
    const h = await history(symbio, project.id, web.id);
    return /The logo is cut off/.test(h) && /header-wrong\.txt/.test(h);
  });
});

test("the human creates a helper from the team list and talks to it directly; core is told", async () => {
  const { project, core } = await projectWithCore(symbio, "Own helpers");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".side-add").click();
  const dialog = page.locator(".dialog", { hasText: "New helper" });
  await dialog.locator("label.field", { hasText: "Name" }).locator("input").fill("Ideas");
  await dialog.locator("label.field", { hasText: "What it's for" }).locator("input").fill("Brainstorms with me");
  await dialog.locator("button", { hasText: "Create and open its chat" }).click();
  // Its chat opens, ready to talk to.
  await page.locator(".chat-head", { hasText: "ideas" }).waitFor();
  const ideas = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "ideas");
  assert.equal(ideas.startedBy, "human");
  assert.equal(ideas.purpose, "Brainstorms with me");
  await page.locator(".composer textarea").fill("@ideas say Here are three ideas for the first level.");
  await page.keyboard.press("Enter");
  // First match: for a moment the reply can show twice (still streaming, and already in the history).
  await page.locator(".msg-assistant", { hasText: "three ideas for the first level" }).first().waitFor();
  // core hears about it at its next turn, without a turn just for that.
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core say ok" });
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, core.id), /the human created a helper, ideas \(\\"Brainstorms with me\\"\)/);
  // Stopping it moves it to the stopped list.
  page.once("dialog", (d) => void d.accept());
  await page.locator(".agent-row", { hasText: "ideas" }).click();
  await page.locator("button", { hasText: "Stop agent" }).click();
  await until("ideas to stop", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "ideas").status === "stopped");
});

test("costs and token counts are hidden until the human turns them on", async () => {
  const { project, core } = await projectWithCore(symbio, "Private costs");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core say working" });
  await idle(symbio, project.id);
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".side .agent-row").first().waitFor();
  // Hidden by default: no usage line under the team, numbers masked in the project's settings.
  assert.equal(await page.locator(".usage-line").count(), 0);
  await openProjectSettings(page, "usage");
  const usage = page.locator("#usage");
  await usage.locator("p", { hasText: "Hidden" }).waitFor();
  assert.ok((await usage.locator(".usage-table tfoot").innerText()).includes("•••"));
  assert.equal(await usage.locator(".usage-total .subtle").innerText(), "••• tokens");

  // Turned on in Settings: the line shows, the numbers too.
  await page.goto(`${symbio.base}/#/settings/usage`);
  await page.locator(".section", { hasText: "Costs and tokens" }).locator("input[type=checkbox]").check();
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".usage-line", { hasText: "tokens" }).waitFor();
  await openProjectSettings(page, "usage");
  assert.ok(!(await page.locator("#usage .usage-table tfoot").innerText()).includes("•••"));
});
