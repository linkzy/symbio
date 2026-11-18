// A project's Usage section: usage by agent, by provider and by model, narrowed to one provider,
// with totals for what's shown.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("usage can be grouped by provider and model, and narrowed to one provider", async () => {
  const models = ["fake/scripted", "acme/custom/deploy"];
  const { project, core } = await projectWithCore(symbio, "Usage providers", { models });
  const spawn = { name: "worker", purpose: "Works", task: "@worker say on it", workspace: "shared", model: "acme/custom/deploy" };
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: `@core tool spawn_agent ${JSON.stringify(spawn)}` });
  await until("the helper", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.some((a: any) => a.name === "worker"));
  await idle(symbio, project.id);

  // The provider is what comes before the first "/".
  await until("usage on both providers", async () => (await symbio.call("GET", `/projects/${project.id}/usage`)).byProvider.length === 2);
  const usage = await symbio.call("GET", `/projects/${project.id}/usage`);
  assert.deepEqual(usage.byProvider.map((p: any) => p.provider).sort(), ["acme", "fake"]);
  assert.deepEqual(usage.byModel.map((m: any) => m.model).sort(), ["acme/custom/deploy", "fake/scripted"]);
  assert.equal(usage.byModel.find((m: any) => m.model === "acme/custom/deploy").provider, "acme");
  assert.equal(
    usage.byProvider.reduce((s: number, p: any) => s + p.tokens, 0),
    usage.tokens,
  );

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  await page.locator(".section", { hasText: "Costs and tokens" }).locator("input[type=checkbox]").check();
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Settings" }).click();
  const section = page.locator("#usage");
  const rows = section.locator(".usage-table tbody tr");
  await section.locator(".usage-table").waitFor();
  assert.equal(await rows.count(), 2, "by agent: one row per agent and model");

  await section.locator(".seg button", { hasText: "By provider" }).click();
  assert.equal(await rows.count(), 2);
  assert.match(await section.locator(".usage-table tbody").innerText(), /acme[\s\S]*fake|fake[\s\S]*acme/);

  await section.locator(".seg button", { hasText: "By model" }).click();
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText() + (await rows.nth(1).innerText()), /acme\/custom\/deploy/);

  // Narrowed to one provider: only its rows, and the total is for them alone.
  await section.locator("select").selectOption("acme");
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().innerText(), /acme\/custom\/deploy/);
  assert.match(await section.locator("tfoot").innerText(), /Total for acme/);
  const acme = usage.byProvider.find((p: any) => p.provider === "acme");
  assert.equal((await section.locator("tfoot td.num").first().innerText()).replace(/\D/g, ""), String(acme.usage.input));

  await section.locator(".seg button", { hasText: "By agent" }).click();
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().innerText(), /worker/);
});
