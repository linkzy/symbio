// Scheduled jobs: core proposes one, the human approves it in Needs you, starts a run from the Plan
// tab, core gets the job's instructions and reports, and the run's result shows on the job.
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

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;
// Conversations as text, with the JSON escapes undone.
const said = async (projectId: string, agentId: string) => (await history(symbio, projectId, agentId)).replace(/\\n/g, "\n").replace(/\\"/g, '"');

test("a scheduled job: proposed by core, approved by the human, run on request, reported", async () => {
  const { project, core } = await projectWithCore(symbio, "Scheduled");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(
    tool("core", "schedule_job", {
      title: "Refresh the figures",
      instructions: "Download this week's figures and update the summary.",
      every: "week",
      days: ["mon"],
      at: "07:00",
    }),
  );
  assert.match(await history(symbio, project.id, core.id), /Proposed as J1 \(every Monday at 07:00\)/);

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  const item = page.locator(".inbox-item", { hasText: "Scheduled job to approve" });
  await item.locator(".small", { hasText: "every Monday at 07:00" }).waitFor();
  await item.getByRole("button", { name: "Approve" }).click();
  await until("the job to be on", async () => (await symbio.call("GET", `/projects/${project.id}/jobs`))[0].state === "active");
  await page.keyboard.press("Escape");

  // The Plan tab: the job, with Run now.
  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator(".jobs-head", { hasText: "Scheduled jobs (1)" }).click();
  const card = page.locator('.job-card[data-job="J1"]');
  await card.locator(".tag", { hasText: "On" }).waitFor();
  await card.getByRole("button", { name: "Run now" }).click();
  await until("core to get the job", async () => /scheduled job J1 "Refresh the figures" is due \(run 1[^)]*the human started it now\)/.test(await said(project.id, core.id)));
  await card.locator(".tag", { hasText: "Running" }).waitFor();
  await idle(symbio, project.id);
  // The approval was a note for core's next turn: it's there now.
  assert.match(await said(project.id, core.id), /the human approved scheduled job J1/);

  await say(tool("core", "report_job", { job: "J1", outcome: "done", summary: "Summary updated with 4 new figures." }));
  await card.locator(".tag", { hasText: "Done" }).waitFor();
  await card.locator(".job-run-note", { hasText: "Summary updated with 4 new figures." }).waitFor();
  const log = await symbio.call("GET", `/projects/${project.id}/log`);
  assert.ok(log.some((m: any) => m.kind === "job" && /^Done: J1 "Refresh the figures" \(run 1\)/.test(m.text)));
  assert.deepEqual((page as any).errors, []);
});
