// Light projects (Project.depth, new projects' default): core says what it understood and offers how
// to start (offer_start); the human picks above core's chat box, or writes instead; when the project
// lets core decide and nobody picks, Symbio goes ahead after a while. The New project dialog starts
// light, with the free models chosen and the heavier options tucked under "More options".
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  // Symbio goes ahead on its own after 2 s here (5 minutes in the app).
  symbio = await startSymbio({ SYMBIO_START_OFFER_SECONDS: "2" });
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;
const OFFER = { summary: "A pocket guide to Porto, about two pages.\n\nI'd start with: **research**, then **writing**." };

test("core offers how to start; the human picks from the buttons, and core is told", async () => {
  const { project, core } = await projectWithCore(symbio, "Offer", { autonomy: "ask" });
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  // Symbio's opening instruction to core isn't shown to the human.
  await page.locator(".msg-assistant").first().waitFor();
  assert.equal(await page.locator(".msg-note", { hasText: "the project was just created" }).count(), 0);

  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: tool("core", "offer_start", OFFER) });
  await idle(symbio, project.id);
  const card = page.locator('[data-testid="start-offer"]');
  await card.locator("strong", { hasText: "research" }).waitFor();
  assert.deepEqual(await card.locator(".start-choice").evaluateAll((els) => els.map((e) => e.getAttribute("data-choice"))), ["go", "brainstorm", "briefing", "grill"]);
  await card.locator("text=core waits for your pick.").waitFor();

  await card.locator('.start-choice[data-choice="briefing"]').click();
  await card.waitFor({ state: "detached" });
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, core.id), /The human chose: a briefing/);
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).startOffer, undefined);

  // core offers again (after a brainstorm, say): the buttons work again, and in a project that asks,
  // going ahead means proposing the plan for approval.
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: tool("core", "offer_start", OFFER) });
  await idle(symbio, project.id);
  await card.locator('.start-choice[data-choice="go"]:not([disabled])').click();
  await card.waitFor({ state: "detached" });
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, core.id), /The human chose: go ahead\. Plan the work as you proposed and submit the plan now/);
  assert.deepEqual((page as any).errors, []);
});

test("when core may decide and nobody picks, Symbio goes ahead; writing instead of picking also answers", async () => {
  const { project, core } = await projectWithCore(symbio, "Ahead", { autonomy: "decide" });
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "offer_start", OFFER));
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator('[data-testid="start-offer"]', { hasText: "core goes ahead on its own" }).waitFor().catch(() => {});
  await until("Symbio to go ahead", async () => /no answer to your offer in .* go ahead as you proposed/.test(await history(symbio, project.id, core.id)), 20_000);
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).startOffer, undefined);
  await page.locator('[data-testid="start-offer"]').waitFor({ state: "detached" });

  // A new offer, answered by writing: the message decides, and the offer goes.
  await say(tool("core", "offer_start", OFFER));
  assert.ok((await symbio.call("GET", `/projects/${project.id}`)).startOffer);
  await say("@core say fine, but in Portuguese");
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).startOffer, undefined);
});

test("New project: the free models are chosen, the project is light, and the heavier options wait under More options", async () => {
  const { page } = await openPage(symbio);
  await page.locator("button", { hasText: "New project" }).first().click();
  await page.getByPlaceholder("my-project", { exact: false }).fill(symbio.folder("dialog"));
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();
  // Straight to the models (the folder, then what agents run on): the free ones are chosen. OpenCode's
  // stand-in has two (Copilot's models have prices, so none is chosen there).
  await page.locator(".runtime-choice .choice", { hasText: "OpenCode" }).click();
  await page.locator(".model-row.on", { hasText: "Unavailable" }).waitFor();
  await page.locator(".model-row.on", { hasText: "Flaky" }).waitFor();
  assert.equal(await page.locator(".model-row.on", { hasText: /^Scripted$/ }).count(), 0, "paid ones aren't");
  await page.locator(".model-legend", { hasText: "core may use it" }).waitFor();
  assert.equal(await page.locator("button.btn.primary", { hasText: "Create project" }).isDisabled(), false);

  const more = page.locator('[data-testid="more-options"]');
  assert.equal(await more.getAttribute("open"), null, "closed at first");
  await more.locator("summary").click();
  assert.ok(await more.getByRole("radio", { name: /^Light/ }).isChecked());
  const register = more.locator("label.choice", { hasText: "Keep a rules register" }).locator("input");
  assert.equal(await register.isChecked(), false, "no register when light");
  await more.getByRole("radio", { name: /^Thorough/ }).check();
  assert.equal(await register.isChecked(), true, "a thorough project keeps one");
  await page.keyboard.press("Escape");
  assert.deepEqual((page as any).errors, []);
});
