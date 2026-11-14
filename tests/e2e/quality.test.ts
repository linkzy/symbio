// 0.14's improvements: which models core and helpers may use, working agents first in the team list,
// new folders from the in-page folder browser, the price simulator, and files with answers and
// with sending a task back.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
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
const MODELS = ["fake/scripted", "fake/scripted-2"];

test("a model locked to core isn't given to helpers; select all and none", async () => {
  const { project, core } = await projectWithCore(symbio, "Roles", { models: MODELS });
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Settings" }).click();
  const picker = page.locator(".model-picker");
  await picker.locator(".model-summary", { hasText: "2 selected, for everyone" }).waitFor();

  // None, then Select all, brings both back.
  await picker.locator("button", { hasText: "None" }).click();
  await picker.locator(".model-summary", { hasText: "Select the models" }).waitFor();
  await picker.locator("button", { hasText: "Select all" }).click();
  await picker.locator(".model-summary", { hasText: "3 selected, for everyone" }).waitFor();
  // The stand-in's third model always fails: take it out again.
  await picker.locator(".model-row", { hasText: "Unavailable" }).click();
  await picker.locator(".model-summary", { hasText: "2 selected, for everyone" }).waitFor();

  // Lock Scripted (core's model) to core: helpers get Scripted 2 only.
  const row = (name: string) => picker.locator(".model-row", { has: page.locator(".model-name", { hasText: new RegExp(`^${name}`) }) }).first();
  await row("Scripted").locator(".lock-btn").click();
  await picker.locator(".model-summary", { hasText: "helpers: Scripted 2" }).waitFor();
  await page.locator("button", { hasText: "Save changes" }).click();
  await until("the roles to be saved", async () => {
    const p = await symbio.call("GET", `/projects/${project.id}`);
    return JSON.stringify(p.coreOnlyModels) === JSON.stringify(["fake/scripted"]);
  });

  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "spawn_agent", { name: "picky", purpose: "x", task: "@picky say hi", workspace: "shared", model: "fake/scripted" }));
  assert.match(await history(symbio, project.id, core.id), /is for core only in this project\. Helpers may use: fake\/scripted-2/);
  await say(tool("core", "spawn_agent", { name: "helper", purpose: "x", task: "@helper say hi", workspace: "shared" }));
  const helper = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "helper");
  assert.equal(helper.model, "fake/scripted-2", "a new helper starts on a model helpers may use");
});

test("working agents move up the team list, under core", async () => {
  const { project, core } = await projectWithCore(symbio, "Busy list");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  for (const name of ["alpha", "beta", "gamma"]) await say(tool("core", "spawn_agent", { name, purpose: "x", task: `@${name} say ready`, workspace: "shared" }));
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  const order = async () => (await page.locator(".side .agent-row .agent-name").allInnerTexts()).map((t) => t.trim().split(/\s/)[0]);
  await until("the team to show", async () => (await order()).length >= 4);
  assert.deepEqual((await order()).slice(0, 4), ["core", "alpha", "beta", "gamma"]);
  // gamma starts working: it moves up, right under core.
  await symbio.call("POST", `/projects/${project.id}/agents/${(await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "gamma").id}/messages`, {
    text: "@gamma wait 4000\n@gamma say done",
  });
  await until("gamma to move up", async () => (await order()).slice(0, 2).join() === "core,gamma");
  await idle(symbio, project.id);
  await until("gamma back in its place", async () => (await order()).slice(0, 4).join() === "core,alpha,beta,gamma");
});

test("the in-page folder browser (remote access) creates folders", async () => {
  const { page } = await openPage(symbio);
  // As if this were a remote session: the page uses its own folder browser.
  await page.route("**/api/remote", (route) => route.fulfill({ json: { active: true } }));
  await page.goto(`${symbio.base}/#/new`);
  const base = symbio.folder("browse-here");
  await page.locator("label.field", { hasText: "Folder" }).locator("input").fill(base);
  await page.locator("button", { hasText: "Browse…" }).click();
  const browser = page.locator(".folder-browser");
  await browser.locator(".folder-browser-path", { hasText: base }).waitFor();
  await browser.locator("button", { hasText: "New folder" }).click();
  await browser.locator(".folder-browser-new input").fill("bad/name");
  await browser.locator(".folder-browser-new button", { hasText: "Create" }).click();
  await browser.locator(".error", { hasText: "plain folder name" }).waitFor();
  await browser.locator(".folder-browser-new input").fill("My game");
  await browser.locator(".folder-browser-new button", { hasText: "Create" }).click();
  await browser.locator(".folder-browser-path", { hasText: path.join(base, "My game") }).waitFor();
  assert.ok(existsSync(path.join(base, "My game")));
  await browser.locator("button", { hasText: "Choose this folder" }).click();
  assert.equal(await page.locator("label.field", { hasText: "Folder" }).locator("input").inputValue(), path.join(base, "My game"));
});

test("the price simulator gives the cost per day, week and month", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  const section = page.locator(".section", { hasText: "Model prices" });
  await section.locator(".seg button", { hasText: "Simulate" }).click();
  // "$Input" is a price (first block), "Fresh input" a token amount (second); labels matched from their start.
  const field = (label: string) =>
    section
      .locator(".simulator-block")
      .nth(label.startsWith("$") ? 0 : 1)
      .locator("label.price-field", { has: page.locator("span", { hasText: new RegExp(`^${label.replace(/^\$/, "")}`) }) })
      .locator("input");
  await field("$Input").fill("1");
  await field("$Output").fill("2");
  await field("$Cache read").fill("0.1");
  // Tokens per day, in millions: 1 fresh, 10 cached, 0 written, 0.5 out → 1 + 1 + 0 + 1 = $3 a day.
  await field("Fresh input").fill("1");
  await field("Cache read").fill("10");
  await field("Cache write").fill("0");
  await field("Output").fill("0.5");
  const result = section.locator(".simulator-result");
  await result.locator("div", { hasText: "Per day" }).locator("strong", { hasText: "$3.00" }).waitFor();
  assert.ok((await result.innerText()).includes("$21.00"), "a week");
  assert.ok((await result.innerText()).includes("$90"), "a month");
});

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
  await page.locator(".msg-assistant", { hasText: "three ideas for the first level" }).waitFor();
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
