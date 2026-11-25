// A project's Usage section: usage by agent, by provider and by model, narrowed to one provider,
// with totals for what's shown.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, idle, MODEL, openPage, projectWithCore, RUNTIME, startSymbio, until, type Symbio, openProjectSettings } from "./harness.js";

// A model from a second provider, with a model reference of more than two parts on OpenCode; on
// Copilot, one from the user's own providers (providers.json, as in runtimes.test.ts).
const OTHER = RUNTIME === "copilot" ? "foundry/fake-byok" : "acme/custom/deploy";
const OTHER_PROVIDER = OTHER.split("/")[0];
const FIRST_PROVIDER = MODEL.split("/")[0];

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
  if (RUNTIME === "copilot") {
    const userHome = path.join(symbio.root, "no-copilot-login");
    mkdirSync(userHome, { recursive: true });
    writeFileSync(
      path.join(userHome, "providers.json"),
      JSON.stringify({
        providers: [{ name: "foundry", type: "anthropic", baseUrl: "https://example.invalid/anthropic", apiKey: "sk-e2e" }],
        models: [{ id: "fake-byok", provider: "foundry", modelId: "claude-haiku-5.5", name: "Fake BYOK" }],
      }),
    );
  }
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("usage can be grouped by provider and model, and narrowed to one provider", async () => {
  const models = [MODEL, OTHER];
  const { project, core } = await projectWithCore(symbio, "Usage providers", { models });
  const spawn = { name: "worker", purpose: "Works", task: "@worker say on it", workspace: "shared", model: OTHER };
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: `@core tool spawn_agent ${JSON.stringify(spawn)}` });
  await until("the helper", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.some((a: any) => a.name === "worker"));
  await idle(symbio, project.id);

  // The provider is what comes before the first "/".
  await until("usage on both providers", async () => (await symbio.call("GET", `/projects/${project.id}/usage`)).byProvider.length === 2);
  const usage = await symbio.call("GET", `/projects/${project.id}/usage`);
  assert.deepEqual(usage.byProvider.map((p: any) => p.provider).sort(), [FIRST_PROVIDER, OTHER_PROVIDER].sort());
  assert.deepEqual(usage.byModel.map((m: any) => m.model).sort(), [MODEL, OTHER].sort());
  assert.equal(usage.byModel.find((m: any) => m.model === OTHER).provider, OTHER_PROVIDER);
  assert.equal(
    usage.byProvider.reduce((s: number, p: any) => s + p.tokens, 0),
    usage.tokens,
  );

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/usage`);
  await page.locator(".section", { hasText: "Costs and tokens" }).locator("input[type=checkbox]").check();
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "usage");
  const section = page.locator("#usage");
  const rows = section.locator(".usage-table tbody tr");
  await section.locator(".usage-table").waitFor();
  assert.equal(await rows.count(), 2, "by agent: one row per agent and model");

  await section.locator(".seg button", { hasText: "By provider" }).click();
  assert.equal(await rows.count(), 2);
  // A provider without prices says so, rather than $0.00.
  assert.match(await rows.filter({ hasText: OTHER_PROVIDER }).innerText(), /no price/);
  assert.match(await section.locator(".usage-table tbody").innerText(), new RegExp(`${OTHER_PROVIDER}[\\s\\S]*${FIRST_PROVIDER}|${FIRST_PROVIDER}[\\s\\S]*${OTHER_PROVIDER}`));

  await section.locator(".seg button", { hasText: "By model" }).click();
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText() + (await rows.nth(1).innerText()), new RegExp(OTHER));

  // Narrowed to one provider: only its rows, and the total is for them alone.
  await section.locator("select").selectOption(OTHER_PROVIDER);
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().innerText(), new RegExp(OTHER));
  assert.match(await section.locator("tfoot").innerText(), new RegExp(`Total for ${OTHER_PROVIDER}`));
  const other = usage.byProvider.find((p: any) => p.provider === OTHER_PROVIDER);
  assert.equal((await section.locator("tfoot td.num").first().innerText()).replace(/\D/g, ""), String(other.usage.input));

  await section.locator(".seg button", { hasText: "By agent" }).click();
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().innerText(), /worker/);
});
