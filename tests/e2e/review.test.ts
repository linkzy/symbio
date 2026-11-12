// Review by the human ("Me, every task"): a finished task waits in Needs you with its helper's
// guide; sent back, the note reaches the helper; approved, it's done.
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

test("a finished task waits for the human with its guide; send back reaches the helper; approve finishes it", async () => {
  const { project, core } = await projectWithCore(symbio, "Review check");
  await symbio.call("PATCH", `/projects/${project.id}`, { reviewBy: "every" });
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  const task = async () => (await symbio.call("GET", `/projects/${project.id}/plan`)).tasks.find((t: any) => t.id === "T1");
  const guide = "Open **page.txt** in the project folder. You should see the word hello. I opened it myself.";

  // The helper's first report has no guide (refused), then reports with one.
  const helperScript = [
    "@writer write page.txt hello",
    tool("writer", "update_task", { task_id: "T1", status: "review", summary: "Written" }),
    tool("writer", "update_task", { task_id: "T1", status: "review", summary: "Written", guide }),
  ].join("\n");
  await say([tool("core", "add_task", { title: "Write the page", description: "A page saying hello" }), tool("core", "spawn_agent", { name: "writer", purpose: "Writes", task_id: "T1", task: helperScript, workspace: "shared" })].join("\n"));
  const writer = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "writer");
  assert.match(await history(symbio, project.id, writer.id), /report it with a guide/, "a report without a guide is refused");
  assert.equal((await task()).guide, guide);

  // Core marks it done: it waits for the human.
  await say(tool("core", "update_task", { task_id: "T1", status: "done" }));
  assert.equal((await task()).humanReview?.state, "waiting");
  assert.match(await history(symbio, project.id, core.id), /now waits for the human's review/);

  // Needs you shows it with the guide; send it back with a note (which carries the helper's next steps).
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  const item = page.locator(".inbox-item", { hasText: "To review" });
  await item.locator(".review-guide", { hasText: "You should see the word hello" }).waitFor();
  await item.locator("button", { hasText: "Send back" }).click();
  const fix = ["Make it say hello world", "@writer write page.txt hello world", tool("writer", "update_task", { task_id: "T1", status: "review", summary: "Fixed", guide })].join("\n");
  await item.locator("textarea").fill(fix);
  await item.locator("button", { hasText: /^Send back$/ }).click();
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, writer.id), /sent back by the human[\s\S]*Make it say hello world/, "the note reached the helper");
  assert.equal((await task()).status, "review", "the helper reported again");

  // Done again, and this time approved from the Plan tab.
  await say(tool("core", "update_task", { task_id: "T1", status: "done" }));
  await page.keyboard.press("Escape");
  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator(".task-card", { hasText: "Waiting for you" }).click();
  await page.locator(".review-box .review-guide").waitFor();
  await page.locator(".review-box button", { hasText: "Approve" }).click();
  await until("the task to be done", async () => (await task()).status === "done");
  await idle(symbio, project.id);
  assert.match(await history(symbio, project.id, core.id), /the human approved T1/);
});
