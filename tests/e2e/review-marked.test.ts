// Review of the tasks marked in the plan (a pipeline with one checkpoint), and a task's changes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, gitRepo, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;

test("only the marked steps wait for the human; a waiting task shows its changes; marks can be changed", async () => {
  const directory = gitRepo(symbio.folder("pipeline"));
  const { project, core } = await projectWithCore(symbio, "Pipeline check", { directory });
  await symbio.call("PATCH", `/projects/${project.id}`, { reviewBy: "marked" });
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  const tasks = async () => Object.fromEntries((await symbio.call("GET", `/projects/${project.id}/plan`)).tasks.map((t: any) => [t.id, t]));

  // Core proposes the pipeline with a checkpoint after step 2; the human approves the plan.
  await say(
    tool("core", "submit_plan", {
      goal: "An episode",
      tasks: [
        { key: "script", title: "Write the script", description: "The script" },
        { key: "frames", title: "Make the frames", description: "The frames", depends_on: ["script"], review: true },
        { key: "final", title: "Assemble", description: "The final cut", depends_on: ["frames"] },
      ],
    }),
  );
  assert.deepEqual(Object.values(await tasks()).map((t: any) => !!t.review), [false, true, false], "only the checkpoint is marked");
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });

  const guide = (what: string) => `Open ${what} in the project folder and check it reads well. I re-read it.`;
  const step = (id: string, file: string, text: string) =>
    [`@writer write ${file} ${text}`, tool("writer", "update_task", { task_id: id, status: "review", summary: "Done", guide: guide(file) })].join("\n");

  // Step 1 isn't marked: done is done.
  await say(tool("core", "spawn_agent", { name: "writer", purpose: "Writes", task_id: "T1", task: step("T1", "script.md", "the script"), workspace: "shared" }));
  await say(tool("core", "update_task", { task_id: "T1", status: "done" }));
  assert.equal((await tasks()).T1.status, "done");

  // Step 2 is marked: it waits, with its changes.
  await say(tool("core", "assign_task", { task_id: "T2", agent: "writer", note: step("T2", "frames.txt", "frame one") }));
  await say(tool("core", "update_task", { task_id: "T2", status: "done" }));
  assert.equal((await tasks()).T2.humanReview?.state, "waiting");

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Plan" }).click();

  // The human also wants to see the final cut: tick it in the task's panel.
  await page.locator(".task-card", { hasText: "Assemble" }).click();
  await page.locator(".review-mark input").check();
  await until("the mark to be saved", async () => (await tasks()).T3.review === true);
  await page.keyboard.press("Escape");
  await page.locator(".task-card", { hasText: "Assemble" }).locator(".tag", { hasText: "You review" }).waitFor();

  // The waiting step: its changes, and approve.
  await page.locator(".task-card", { hasText: "Waiting for you" }).click();
  await page.locator(".task-changes button", { hasText: "Show changes" }).click();
  const file = page.locator(".change-file", { hasText: "frames.txt" });
  await file.waitFor();
  assert.equal(await page.locator(".change-file").count(), 1, "only this task's file, not step 1's");
  await file.locator(".change-file-head").click();
  await file.locator(".patch .add", { hasText: "frame one" }).waitFor();
  await page.locator(".review-box button", { hasText: "Approve" }).click();
  await until("step 2 to be done", async () => (await tasks()).T2.status === "done");
});
