// Helpers that go quiet: a helper that ends its turn without reporting is nudged once, and core is
// told if it stays quiet; a helper that reports is left alone.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio({ SYMBIO_QUIET_HELPER_SECONDS: "1" });
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("a quiet helper is nudged, then core is told; a helper that reports is left alone", async () => {
  const { project, core } = await projectWithCore(symbio, "Quiet check");
  const spawn = (name: string, task: string) => `@core tool spawn_agent ${JSON.stringify({ name, purpose: "Does a thing", task, workspace: "shared" })}`;
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
    text: [
      spawn("silent", "@silent say I did the thing (and forgot to tell anyone)."),
      spawn("diligent", `@diligent tool send_message ${JSON.stringify({ to: "core", message: "The thing is done, in thing.txt" })}`),
    ].join("\n"),
  });

  const agentId = async (name: string) => (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === name).id;
  await until("core to hear that the silent helper went quiet", async () => /silent has gone quiet/.test(await history(symbio, project.id, core.id)), 30_000, symbio.output);
  await idle(symbio, project.id);

  assert.match(await history(symbio, project.id, await agentId("silent")), /ended your turn without reporting to core/, "the silent helper was nudged first");
  assert.doesNotMatch(await history(symbio, project.id, await agentId("diligent")), /without reporting/, "the one that reported wasn't");
  assert.match(await history(symbio, project.id, core.id), /The thing is done, in thing\.txt/);
  assert.doesNotMatch(await history(symbio, project.id, core.id), /diligent has gone quiet/);
});
