// 0.14's improvements: which models core and helpers may use, working agents first in the team list,
// new folders from the in-page folder browser, and the price simulator. (What the human does
// directly is in human.test.ts.)
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
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

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;
const MODELS = [MODEL, MODEL_2];

test("a model locked to core isn't given to helpers; select all and none", async () => {
  const { project, core } = await projectWithCore(symbio, "Roles", { models: MODELS });
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "team");
  const picker = page.locator(".model-picker");
  await picker.locator(".model-summary", { hasText: "2 selected, for everyone" }).waitFor();

  // None, then Select all, brings both back.
  await picker.locator("button", { hasText: "None" }).click();
  await picker.locator(".model-summary", { hasText: "Select the models" }).waitFor();
  await picker.locator("button", { hasText: "Select all" }).click();
  await picker.locator(".model-summary", { hasText: "4 selected, for everyone" }).waitFor();
  // The stand-in's other two models fail (always, or on each first turn): take them out again.
  await picker.locator(".model-row", { hasText: "Unavailable" }).click();
  await picker.locator(".model-row", { hasText: "Flaky" }).click();
  await picker.locator(".model-summary", { hasText: "2 selected, for everyone" }).waitFor();

  // Lock Scripted (core's model) to core: helpers get Scripted 2 only.
  const row = (name: string) => picker.locator(".model-row", { has: page.locator(".model-name", { hasText: new RegExp(`^${name}`) }) }).first();
  await row("Scripted").locator(".lock-btn").click();
  await picker.locator(".model-summary", { hasText: "helpers: Scripted 2" }).waitFor();
  await page.locator("button", { hasText: "Save changes" }).click();
  await until("the roles to be saved", async () => {
    const p = await symbio.call("GET", `/projects/${project.id}`);
    return JSON.stringify(p.coreOnlyModels) === JSON.stringify([MODEL]);
  });

  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "spawn_agent", { name: "picky", purpose: "x", task: "@picky say hi", workspace: "shared", model: MODEL }));
  assert.match(await history(symbio, project.id, core.id), new RegExp(`is for core only in this project\\. Helpers may use: ${MODEL_2}`));
  await say(tool("core", "spawn_agent", { name: "helper", purpose: "x", task: "@helper say hi", workspace: "shared" }));
  const helper = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "helper");
  assert.equal(helper.model, MODEL_2, "a new helper starts on a model helpers may use");
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
  await page.goto(`${symbio.base}/#/settings/usage`);
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
  const row = (role: string) => section.locator(`.simulator-row[data-role="${role}"]`);
  await row("all").locator("strong", { hasText: "$3.00" }).waitFor();
  assert.deepEqual(await row("all").locator("strong").allInnerTexts(), ["$3.00", "$21.00", "$90.00", "$0.261"], "day, week, month, per million");

  // Core and helpers apart: a dear model for core, a cheap one for helpers, and the total.
  await section.locator(".simulator-mode button", { hasText: "Core and helpers separately" }).click();
  const side = (role: string) => section.locator(".simulator-side", { has: page.locator(".simulator-role", { hasText: role }) });
  const input = (role: string, block: number, label: string) =>
    side(role)
      .locator(".simulator-block")
      .nth(block)
      .locator("label.price-field", { has: page.locator("span", { hasText: new RegExp(`^${label}`) }) })
      .locator("input");
  await input("core", 0, "Input").fill("2");
  await input("core", 0, "Output").fill("10");
  await input("core", 0, "Cache read").fill("0.2");
  for (const [label, v] of [["Fresh input", "1"], ["Cache read", "10"], ["Cache write", "0"], ["Output", "0.1"]]) await input("core", 1, label).fill(v);
  // Same as core, then cheaper.
  await side("helpers").locator("button", { hasText: "Same as core" }).click();
  assert.equal(await input("helpers", 0, "Output").inputValue(), "10");
  await input("helpers", 0, "Input").fill("0.07");
  await input("helpers", 0, "Output").fill("0.14");
  await input("helpers", 0, "Cache read").fill("0.014");
  for (const [label, v] of [["Fresh input", "1"], ["Cache read", "20"], ["Cache write", "0"], ["Output", "0.2"]]) await input("helpers", 1, label).fill(v);
  // core: 1×2 + 10×0.2 + 0.1×10 = $5; helpers: 1×0.07 + 20×0.014 + 0.2×0.14 = $0.378; total $5.378.
  await row("core").locator("strong", { hasText: "$5.00" }).waitFor();
  assert.equal(await row("helpers").locator("strong").first().innerText(), "$0.378");
  assert.deepEqual((await row("total").locator("strong").allInnerTexts()).slice(0, 3), ["$5.38", "$37.65", "$161"]);
});
