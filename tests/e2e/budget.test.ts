// Budgets (Project settings → Budget): a limit set in the page warns near it, pauses the team at it
// (a banner says why), core is told; raising the limit resumes the team.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, MODEL, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("a budget warns near its limit, pauses the team at it, and raising it lets the team go on", async () => {
  // A price that makes each step count: 10 input and 5 output tokens cost $0.015.
  await symbio.call("PUT", "/prices", { model: MODEL, price: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } });
  const { project, core } = await projectWithCore(symbio, "Budgeted");
  const spent = async () => (await symbio.call("GET", `/projects/${project.id}/budget`)).spent as number;
  await until("the greeting to be counted", async () => (await spent()) > 0);
  const limit = Math.round(((await spent()) + 0.3) * 1000) / 1000;

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Settings" }).click();
  const section = page.locator("#budget");
  await section.getByLabel("For the whole project").fill(String(limit));
  // Warned halfway: a turn costs a few steps, so the warning comes well before the pause.
  await section.getByLabel("Warn at").fill("50");
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await until("the limit to be saved", async () => (await symbio.call("GET", `/projects/${project.id}`)).budget?.warnAt === 50);
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).budget.total, limit);
  // Costs are hidden until the human shows them (privacy.ts): the amount is masked.
  await section.locator('[data-testid="budget-spent"]', { hasText: "Spent so far: •••" }).waitFor();

  // Work until the limit: a warning first, then the team pauses.
  const log = async () => (await symbio.call("GET", `/projects/${project.id}/log`)).filter((m: any) => m.kind === "budget").map((m: any) => m.text as string);
  for (let i = 0; i < 20 && !(await symbio.call("GET", `/projects/${project.id}`)).paused; i++) {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core say working" });
    await idle(symbio, project.id);
  }
  await until("the team to pause", async () => (await symbio.call("GET", `/projects/${project.id}`)).paused);
  const notes = await log();
  assert.match(notes[0], /^\d+% of the project's budget is used/);
  assert.match(notes.at(-1)!, /^Paused: the project's budget is reached/);
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).budgetState.pausedFor, "total");
  assert.match(await history(symbio, project.id, core.id), /of the project's budget is used/);
  await page.locator(".banner", { hasText: "Paused: the project's budget is reached." }).waitFor();

  // Raising the limit resumes the team, and core hears why it was paused.
  await section.getByLabel("For the whole project").fill(String(limit + 10));
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await until("the team to resume", async () => !(await symbio.call("GET", `/projects/${project.id}`)).paused);
  await until("core to be told", async () => /was reached and the team was paused; it's running again now/.test(await history(symbio, project.id, core.id)));
  assert.match((await log()).at(-1)!, /raised, so the team was resumed/);
  await page.locator(".banner", { hasText: "Paused" }).waitFor({ state: "detached" });
  assert.deepEqual((page as any).errors, []);
});
