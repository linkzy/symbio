// A cap on helpers (Project settings → Team → Helpers at a time): core can't create one past it and
// is told to reuse or stop one; its brief says the limit.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, openProjectSettings, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;

test("helpers at a time: set in Team settings, core can't go past it and is told what to do instead", async () => {
  const { project, core } = await projectWithCore(symbio, "Capped");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "team");
  await page.locator('[data-testid="max-helpers"]').fill("1");
  await page.getByRole("button", { name: "Save changes" }).click();
  await until("the limit to be saved", async () => (await symbio.call("GET", `/projects/${project.id}`)).maxHelpers === 1);

  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "spawn_agent", { name: "one", purpose: "Writes", task: "@one say ready", workspace: "shared" }));
  await say(tool("core", "spawn_agent", { name: "two", purpose: "Writes", task: "@two say ready", workspace: "shared" }));
  const agents = (await symbio.call("GET", `/projects/${project.id}`)).agents.map((a: any) => a.name);
  assert.ok(agents.includes("one") && !agents.includes("two"), "only one helper");
  const said = (await history(symbio, project.id, core.id)).replace(/\\n/g, "\n");
  assert.match(said, /allows at most 1 helper at a time \(the human's setting\), and it has 1: one\. Give the task to one of them/);

  // Cleared: no limit again.
  await page.locator('[data-testid="max-helpers"]').fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await until("the limit to be cleared", async () => (await symbio.call("GET", `/projects/${project.id}`)).maxHelpers === undefined);
  await say(tool("core", "spawn_agent", { name: "two", purpose: "Writes", task: "@two say ready", workspace: "shared" }));
  assert.ok((await symbio.call("GET", `/projects/${project.id}`)).agents.some((a: any) => a.name === "two"));
});
