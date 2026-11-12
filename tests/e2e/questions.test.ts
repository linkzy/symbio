// A multiple-choice question from core: it stays open (and visible) while another agent's
// message arrives, and the human answers it from Needs you.
import assert from "node:assert/strict";
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

test("a question stays open while a helper's message arrives, and is answered from Needs you", async () => {
  const { project, core } = await projectWithCore(symbio, "Question check");
  const pinger = ["@pinger wait 800", `@pinger tool send_message ${JSON.stringify({ to: "core", message: "report ready" })}`].join("\n");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
    text: [
      `@core tool spawn_agent ${JSON.stringify({ name: "pinger", purpose: "Reports back", task: pinger, workspace: "shared" })}`,
      "@core question Which drink? | Tea | Coffee",
      "@core say Thanks for answering.",
    ].join("\n"),
  });

  const coreStatus = async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.id === core.id).status;
  await until("core to wait for the answer", async () => (await coreStatus()) === "waiting");
  // The helper reports while the question is open: core must keep waiting, the question kept.
  await until("the helper to report", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.some((a: any) => a.name === "pinger" && a.status === "idle"));
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await coreStatus(), "waiting", "still waiting for the human");
  assert.equal((await symbio.call("GET", `/projects/${project.id}/agents/${core.id}/forms`)).length, 1, "the question is still open");

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Plan" }).click(); // away from the chat
  await page.locator(".needs-you").click();
  await page.locator(".drawer .form-option", { hasText: "Coffee" }).click();
  await page.locator(".drawer button", { hasText: "Send answer" }).click();
  await page.locator(".drawer", { hasText: "Nothing is waiting for you" }).waitFor();

  await idle(symbio, project.id);
  const text = await history(symbio, project.id, core.id);
  assert.match(text, /User has answered your questions.*Coffee/, "core got the answer");
  assert.match(text, /Thanks for answering\./, "and carried on");
  assert.match(text, /report ready/, "the helper's message was delivered after");
});
