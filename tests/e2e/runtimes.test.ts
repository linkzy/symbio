// Choosing the agent runtime: the New project dialog offers OpenCode and GitHub Copilot CLI, each with
// its own models, and the project's agents run on the one chosen.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, idle, openPage, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("a new project's agents run on GitHub Copilot CLI when chosen, with its models; core answers there", async () => {
  const folder = symbio.folder("on-copilot");
  const { page } = await openPage(symbio);
  await page.locator("button", { hasText: "New project" }).first().click();
  await page.getByPlaceholder("my-project", { exact: false }).fill(folder);
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();

  // OpenCode by default, with its models.
  assert.ok(await page.getByRole("radio", { name: /OpenCode/ }).isChecked());
  await page.locator(".model-group-title", { hasText: "fake" }).waitFor();

  // GitHub Copilot CLI: its own models instead.
  await page.locator(".runtime-choice .choice", { hasText: "GitHub Copilot CLI" }).click();
  await page.locator(".model-group-title", { hasText: "copilot" }).waitFor();
  assert.equal(await page.locator(".model-group-title", { hasText: "fake" }).count(), 0, "not OpenCode's models");
  await page.locator(".model-row").filter({ has: page.locator(".model-name", { hasText: /^Scripted$/ }) }).click();
  await page.locator("button.btn.primary", { hasText: "Create project" }).click();

  await until("the project page", () => /#\/p\//.test(page.url()));
  const project = (await symbio.call("GET", "/projects")).find((p: any) => p.directory.toLowerCase() === folder.toLowerCase());
  assert.equal(project.runtime, "copilot");
  assert.equal(project.coordinatorModel, "copilot/scripted");
  await idle(symbio, project.id);
  const core = (await symbio.call("GET", `/projects/${project.id}`)).agents[0];
  assert.equal(core.runtime, "copilot", "core runs on Copilot");
  await page.locator(".msg-assistant", { hasText: "Noted (core)" }).first().waitFor();
  // The top bar shows the runtime this project's agents run on, not OpenCode.
  await page.locator('.topbar .runtime[data-runtime="copilot"] .runtime-label', { hasText: "GitHub Copilot CLI" }).waitFor();
  assert.equal(await page.locator('.topbar .runtime[data-runtime="opencode"]').count(), 0);
  // Elsewhere, every runtime that is running.
  await page.goto(`${symbio.base}/#/`);
  await page.locator('.topbar .runtime[data-runtime="copilot"]').waitFor();
  assert.deepEqual((page as any).errors, []);
});

test("signing in to GitHub Copilot from Settings, with a device code", async () => {
  const signedOut = await startSymbio({ SYMBIO_FAKE_COPILOT_SIGNED_OUT: "1" });
  try {
    const { page } = await openPage(signedOut);
    // Choosing Copilot before signing in says where to sign in.
    await page.locator("button", { hasText: "New project" }).first().click();
    await page.getByPlaceholder("my-project", { exact: false }).fill(signedOut.folder("later"));
    await page.locator("button.btn.primary", { hasText: "Continue" }).click();
    await page.locator(".runtime-choice .choice", { hasText: "GitHub Copilot CLI" }).click();
    await page.locator(".error", { hasText: "Sign in from Settings → Agent runtimes" }).waitFor();
    await page.keyboard.press("Escape");

    await page.goto(`${signedOut.base}/#/settings`);
    const section = page.locator('.runtime-card[data-runtime="copilot"]');
    await section.locator(".copilot-sign-in", { hasText: "Not signed in" }).waitFor();
    await section.locator("button", { hasText: "Sign in with GitHub" }).click();
    await section.locator(".device-code", { hasText: "FAKE-1234" }).waitFor();
    assert.equal(await section.locator("a", { hasText: "Open GitHub" }).getAttribute("href"), "https://github.com/login/device");
    // Approved on GitHub (the stand-in approves it a moment later).
    await section.locator(".copilot-login", { hasText: "Signed in as e2e" }).waitFor({ timeout: 15_000 });
    assert.equal(await section.locator(".device-code").count(), 0, "the code is gone");
    assert.deepEqual((page as any).errors, []);
  } finally {
    await signedOut.stop();
  }
});

test("models from the user's own Copilot providers (e.g. Azure AI Foundry) are offered, and agents run on them", async () => {
  // The harness's stand-in for the user's Copilot folder (~/.copilot), with a providers.json as Copilot keeps it.
  const userHome = path.join(symbio.root, "no-copilot-login");
  mkdirSync(userHome, { recursive: true });
  writeFileSync(
    path.join(userHome, "providers.json"),
    JSON.stringify({
      providers: [{ name: "foundry", type: "anthropic", baseUrl: "https://example.invalid/anthropic", apiKey: "sk-e2e-secret" }],
      models: [{ id: "fake-byok", provider: "foundry", modelId: "claude-haiku-5.5", name: "Fake BYOK (Foundry)", capabilities: { supports: { vision: true } } }],
    }),
  );
  const listed = await symbio.call("GET", "/models?runtime=copilot");
  assert.ok(listed.some((m: any) => m.ref === "foundry/fake-byok" && m.name === "Fake BYOK (Foundry)" && m.vision));
  assert.ok(!JSON.stringify(listed).includes("sk-e2e-secret"), "the key never reaches the browser");

  const { page } = await openPage(symbio);
  await page.locator("button", { hasText: "New project" }).first().click();
  const folder = symbio.folder("on-foundry");
  await page.getByPlaceholder("my-project", { exact: false }).fill(folder);
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();
  await page.locator(".runtime-choice .choice", { hasText: "GitHub Copilot CLI" }).click();
  await page.locator(".model-group-title", { hasText: "foundry" }).waitFor();
  await page.locator(".model-row", { hasText: "Fake BYOK (Foundry)" }).click();
  await page.locator("button.btn.primary", { hasText: "Create project" }).click();
  await until("the project page", () => /#\/p\//.test(page.url()));
  const project = (await symbio.call("GET", "/projects")).find((p: any) => p.directory.toLowerCase() === folder.toLowerCase());
  assert.equal(project.coordinatorModel, "foundry/fake-byok");
  await idle(symbio, project.id);
  await page.locator(".msg-assistant", { hasText: "Noted (core)" }).first().waitFor();
});

test("each runtime starts when needed: with only Copilot agents, OpenCode isn't started", async () => {
  const first = await startSymbio();
  const home = path.join(first.root, "home");
  let again: Symbio | null = null;
  try {
    const directory = first.folder("copilot-only");
    const project = await first.call("POST", "/projects", { name: "Copilot only", directory, coordinatorModel: "copilot/scripted", allowedModels: ["copilot/scripted"], runtime: "copilot" });
    await first.call("POST", `/projects/${project.id}/start`);
    await idle(first, project.id);
    await first.stop();

    // The same data, started again: core runs on Copilot, so only Copilot starts.
    again = await startSymbio({ SYMBIO_HOME: home });
    const runtimes = async () => Object.fromEntries((await again!.call("GET", "/runtime")).runtimes.map((r: any) => [r.kind, r.state]));
    await until("Copilot to start", async () => (await runtimes()).copilot === "running");
    assert.equal((await runtimes()).opencode, "stopped", "OpenCode isn't started for nothing");
    const { page } = await openPage(again);
    await page.goto(`${again.base}/#/`);
    await page.locator('.topbar .runtime[data-runtime="copilot"]').waitFor();
    assert.equal(await page.locator('.topbar .runtime[data-runtime="opencode"]').count(), 0);

    // Something that needs OpenCode starts it: its models, for a new project on it.
    const models = await again.call("GET", "/models?runtime=opencode");
    assert.ok(models.some((m: any) => m.ref === "fake/scripted"));
    assert.equal((await runtimes()).opencode, "running");
  } finally {
    await again?.stop();
    await first.stop().catch(() => {});
  }
});

