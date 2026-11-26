// This computer: programs agents start are listed in the top bar's machine view and can be stopped
// there; when the machine is overloaded, the human and core are told, and (if the human chose so)
// messages between agents wait until it recovers. The load comes from a file here, not the machine.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
const loadFile = path.join(mkdtempSync(path.join(os.tmpdir(), "sym-load-")), "load.json");
const setLoad = (cpu: number) => writeFileSync(loadFile, JSON.stringify({ cpu, free: 4 * 1024 ** 3 }));
before(async () => {
  setLoad(10);
  symbio = await startSymbio({ SYMBIO_MACHINE_LOAD_FILE: loadFile, SYMBIO_MACHINE_SAMPLE_SECONDS: "1", SYMBIO_OVERLOAD_SECONDS: "2" });
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const MARKER = "symbio-e2e-busy-program";

test("the programs agents start are listed in the machine view and can be stopped there", async () => {
  const { project, core } = await projectWithCore(symbio, "Machine");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: `@core spawn node -e "setTimeout(function(){},600000)" ${MARKER}` });
  await idle(symbio, project.id);
  await until("the program to be listed", async () => (await symbio.call("GET", "/machine/processes")).some((p: any) => p.command.includes(MARKER)), 30_000);
  // core sees it too (list_programs), with its pid.
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core tool list_programs {}" });
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, core.id), new RegExp(`pid \\d+ node[^\\n]*${MARKER}`));

  const { page } = await openPage(symbio);
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${symbio.base}/#/`);
  await page.locator(".machine-badge").click();
  const row = page.locator(".machine-program", { hasText: MARKER });
  await row.waitFor();
  assert.match(await row.innerText(), /node/);
  // Who started it: the project and the agent.
  await until("who started it to be known", async () => /Machine · core/.test(await row.innerText()));
  assert.ok((await symbio.call("GET", "/machine/processes")).some((p: any) => p.command.includes(MARKER) && p.owners.length === 1 && p.owners[0].agent === "core"));
  await row.getByRole("button", { name: /^Stop / }).click();
  await row.waitFor({ state: "detached" });
  await until("the program to be gone", async () => !(await symbio.call("GET", "/machine/processes")).some((p: any) => p.command.includes(MARKER)), 30_000);
  // Only agents' programs can be stopped.
  await assert.rejects(symbio.call("POST", `/machine/processes/${process.pid}/stop`), /isn't a program an agent started/);
  assert.deepEqual((page as any).errors, []);
});

test("an overloaded machine: the human and core are told, and messages between agents can wait until it recovers", async () => {
  const { project, core } = await projectWithCore(symbio, "Overload");
  await symbio.call("POST", `/projects/${project.id}/agents`, { name: "writer", workspace: "shared" });
  await idle(symbio, project.id);
  await symbio.call("PUT", "/machine/settings", { holdTurns: true });

  // core is working when the load goes up.
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core wait 6000" });
  setLoad(99);
  await until("overloaded", async () => (await symbio.call("GET", "/machine")).overloaded, 20_000);
  await until("the human to be told", async () => (await symbio.call("GET", `/projects/${project.id}/log`)).some((m: any) => /This computer is overloaded/.test(m.text)));
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".machine-badge.overloaded", { hasText: "Overloaded" }).waitFor();
  await idle(symbio, project.id);

  // A message between agents waits.
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
    text: `@core tool send_message ${JSON.stringify({ to: "writer", message: "@writer say got it" })}`,
  });
  await until("the message to be held", async () => (await symbio.call("GET", `/projects/${project.id}`)).heldMessages?.length === 1);
  await idle(symbio, project.id);
  // The note reaches core with its next turn (on Copilot, notes go with the next prompt).
  assert.match(await history(symbio, project.id, core.id), /this computer is overloaded/i, "core got a note");

  // Recovered: delivered.
  setLoad(10);
  await until("recovered", async () => !(await symbio.call("GET", "/machine")).overloaded, 20_000);
  await until("the held message to be delivered", async () => !(await symbio.call("GET", `/projects/${project.id}`)).heldMessages?.length);
  const writer = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "writer");
  await until("the helper to get it", async () => /got it/.test(await history(symbio, project.id, writer.id)), 15_000, () => JSON.stringify(writer));
  await page.locator(".machine-badge.overloaded").waitFor({ state: "detached" });
  await symbio.call("PUT", "/machine/settings", { holdTurns: false });
});
