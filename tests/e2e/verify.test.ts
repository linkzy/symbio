// Between a helper's report and core (team/verify.ts): the project's checks, which Symbio runs
// itself on every report and again before a merge when the work changed, and reviewers, one-off
// helpers that check a task against its Done when, by core's request or on every task.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, gitRepo, history, idle, openPage, projectWithCore, refused, startSymbio, until, type Symbio, openProjectSettings } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

// Conversations as text, with the JSON escapes undone (newlines and quotes read as written).
const said = async (projectId: string, agentId: string) => (await history(symbio, projectId, agentId)).replace(/\\n/g, "\n").replace(/\\"/g, '"');
const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;
const task = async (projectId: string) => (await symbio.call("GET", `/projects/${projectId}/plan`)).tasks[0];
const agentNamed = async (projectId: string, name: string) => (await symbio.call("GET", `/projects/${projectId}`)).agents.find((a: any) => a.name === name);
// A check that passes only when done.txt is there (node is on every machine that runs Symbio).
const DONE_CHECK = `"${process.execPath}" -e "require('fs').accessSync('done.txt'); console.log('done.txt is there')"`;

test("checks: core proposes one, the human approves it; a failure goes back to the helper, a pass reaches core, and a merge checks again", async () => {
  const directory = gitRepo(symbio.folder("checks"));
  const { project, core } = await projectWithCore(symbio, "Checks", { directory });
  const say = async (agentId: string, text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${agentId}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(core.id, tool("core", "propose_check", { name: "done file", command: DONE_CHECK, why: "The task's output." }));
  assert.equal((await symbio.call("GET", `/projects/${project.id}`)).checks[0].approved, false);

  // The human approves it in the project's settings.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "quality");
  const section = page.locator("#checks");
  const row = section.locator(".check-row", { hasText: "done file" });
  await row.locator(".tag", { hasText: "Proposed by core" }).waitFor();
  await row.getByRole("button", { name: "Approve" }).click();
  await until("the check to be approved", async () => (await symbio.call("GET", `/projects/${project.id}`)).checks[0].approved === true);
  await row.locator(".tag").waitFor({ state: "detached" });

  await say(core.id, tool("core", "submit_plan", { goal: "A file", tasks: [{ key: "file", title: "Write the file", description: `Write done.txt.\n${tool("review-t1", "submit_review", { task_id: "T1", verdict: "pass", findings: "done.txt is there." })}` }] }));
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });
  // The helper reports without the file: the check fails, and the task comes back to it.
  await say(core.id, tool("core", "spawn_agent", { name: "writer", purpose: "Files", task_id: "T1", task: tool("writer", "update_task", { task_id: "T1", status: "review", note: "Finished." }), workspace: "own" }));
  const writer = await agentNamed(project.id, "writer");
  await until("the check to fail", async () => (await task(project.id)).checks?.state === "failed");
  await until("the task to come back", async () => (await task(project.id)).status === "in-progress");
  await until("the helper to get the output", async () => /came back to you[\s\S]*Check "done file" failed/.test(await said(project.id, writer.id)));
  await idle(symbio, project.id);
  assert.doesNotMatch(await said(project.id, core.id), /T1 "Write the file" → review/, "core doesn't hear of it");

  // Fixed and reported again: core gets the report, with the checks that passed.
  await say(
    writer.id,
    [
      "@writer write done.txt done",
      "@writer shell git add -A",
      "@writer shell git -c user.name=writer -c user.email=w@example.invalid commit -qm done",
      tool("writer", "update_task", { task_id: "T1", status: "review", note: "done.txt is written." }),
    ].join("\n"),
  );
  await until("core to get the report", async () => /T1 "Write the file" → review: done\.txt is written\.\s*Symbio's checks passed: done file/.test(await said(project.id, core.id)));
  await idle(symbio, project.id);

  // core asks for a reviewer: it works in the helper's own copy, and its verdict comes to core.
  await say(core.id, tool("core", "request_review", { task_id: "T1" }));
  await until("core to get the verdict", async () => /review-t1 reviewed T1 "Write the file": it passes\.\s*done\.txt is there\./.test(await said(project.id, core.id)));
  const reviewer = await agentNamed(project.id, "review-t1");
  assert.equal(path.resolve(reviewer.directory), path.resolve(writer.directory));
  await until("the reviewer to be stopped", async () => (await agentNamed(project.id, "review-t1")).status === "stopped");
  await idle(symbio, project.id);

  // The work changed since the checks ran: they run again before the merge, and fail.
  await say(writer.id, ["@writer shell git rm -q done.txt", "@writer shell git -c user.name=writer -c user.email=w@example.invalid commit -qm undone"].join("\n"));
  await say(core.id, tool("core", "merge_work", { agent: "writer" }));
  assert.match(await said(project.id, core.id), /Not merged: Symbio ran the project's checks before merging, and they failed/);
  assert.equal((await task(project.id)).checks.when, "merge");

  // The task shows the latest run, and the reviewer's verdict.
  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator(".task-card", { hasText: "Write the file" }).click();
  await page.locator(".task-checks .check-result.failed", { hasText: "done file" }).waitFor();
  await page.locator(".task-checks", { hasText: "before merging" }).waitFor();
  await page.locator(".task-reviews .review-verdict.pass", { hasText: "done.txt is there." }).waitFor();
  assert.deepEqual((page as any).errors, []);
});

test("a reviewer on every task: it can't change the work, its findings go back to the helper, and a pass reaches core", async () => {
  const { project, core, directory } = await projectWithCore(symbio, "Reviewers");
  const say = async (agentId: string, text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${agentId}/messages`, { text });
    await idle(symbio, project.id);
  };
  // The human turns it on in the project's settings.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await openProjectSettings(page, "quality");
  await page.locator("#checks .seg button", { hasText: "Every task" }).click();
  await until("reviewers to be required", async () => (await symbio.call("GET", `/projects/${project.id}`)).requireReviewer === true);
  // With a check too: it runs first, then the reviewer.
  await symbio.call("PATCH", `/projects/${project.id}`, { checks: [{ name: "runs", command: `"${process.execPath}" -e "process.exit(0)"` }] });

  const reviewers = [
    "@review-t1 write page.txt changed by the reviewer",
    tool("review-t1", "submit_review", { task_id: "T1", verdict: "changes", findings: "The page has no title." }),
    tool("review-t1-2", "submit_review", { task_id: "T1", verdict: "pass", findings: "The title is there." }),
  ].join("\n");
  await say(core.id, tool("core", "submit_plan", { goal: "A page", tasks: [{ key: "page", title: "Write the page", description: `A page with a title.\n${reviewers}`, done_when: "The page has a title" }] }));
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });
  await say(core.id, tool("core", "spawn_agent", { name: "pages", purpose: "Pages", task_id: "T1", task: tool("pages", "update_task", { task_id: "T1", status: "review", note: "The page is written." }), workspace: "shared" }));
  const pages = await agentNamed(project.id, "pages");

  // The first reviewer can't write, and sends it back with its findings.
  await until("the findings to reach the helper", async () => /came back to you: a reviewer \(review-t1\) found it isn't done yet:\s*The page has no title\./.test(await said(project.id, pages.id)));
  const first = await agentNamed(project.id, "review-t1");
  assert.equal(path.resolve(first.directory), path.resolve(directory));
  assert.match(await said(project.id, first.id), refused("edit"));
  assert.ok(!existsSync(path.join(directory, "page.txt")), "the reviewer changed nothing");
  await until("the first reviewer to be stopped", async () => (await agentNamed(project.id, "review-t1")).status === "stopped");
  assert.equal((await task(project.id)).status, "in-progress");
  await idle(symbio, project.id);
  assert.doesNotMatch(await said(project.id, core.id), /→ review/, "core hasn't heard of it yet");

  // Reported again: a fresh reviewer passes it, and core gets the report with the verdict.
  await say(pages.id, tool("pages", "update_task", { task_id: "T1", status: "review", note: "Added the title." }));
  await until("core to get the report", async () => /T1 "Write the page" → review: Added the title\.\s*Reviewed by review-t1-2: it passes\./.test(await said(project.id, core.id)));
  await until("the second reviewer to be stopped", async () => (await agentNamed(project.id, "review-t1-2")).status === "stopped");
  assert.deepEqual((await task(project.id)).reviews.map((r: any) => [r.by, r.verdict]), [["review-t1", "changes"], ["review-t1-2", "pass"]]);
  assert.equal((await task(project.id)).checks.state, "passed");
  await idle(symbio, project.id);

  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator(".task-card", { hasText: "Write the page" }).click();
  await page.locator(".task-reviews .review-verdict.changes", { hasText: "The page has no title." }).waitFor();
  await page.locator(".task-reviews .review-verdict.pass", { hasText: "The title is there." }).waitFor();
  assert.deepEqual((page as any).errors, []);
});
