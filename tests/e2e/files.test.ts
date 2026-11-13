// Files from the team: paths in what agents write become links to the files that exist (Markdown
// opening formatted at the line mentioned, in a new tab), files they share show as cards in the
// chat and the Files tab, and a path on a helper's branch opens the helper's copy.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("paths become links, shared files show as cards, and a helper's branch has its own copy", async () => {
  const directory = gitRepo(symbio.folder("files"));
  mkdirSync(path.join(directory, "docs", "regras"), { recursive: true });
  writeFileSync(path.join(directory, "docs", "regras", "checagem-ia.md"), "# Checagem\n\nIntro.\n\n## Resumo\n\nThe summary.\n");
  writeFileSync(path.join(directory, "tela.png"), PNG);
  writeFileSync(path.join(directory, "relatorio.xlsx"), Buffer.alloc(2048, 1));
  const { project, core } = await projectWithCore(symbio, "Files", { directory });
  await symbio.call("PATCH", `/projects/${project.id}`, { reviewBy: "every" });
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };

  await say(
    [
      "@core say Open docs/regras/checagem-ia.md, line 5, for the summary. `docs/regras/missing.md` doesn't exist yet.",
      tool("core", "share_file", { path: "tela.png", caption: "The new screen" }),
      tool("core", "share_file", { path: "relatorio.xlsx", caption: "The report" }),
    ].join("\n"),
  );

  const { page, context } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  // Only the file that exists is a link.
  const link = page.locator(".file-link", { hasText: "docs/regras/checagem-ia.md" });
  await link.waitFor();
  assert.equal(await page.locator(".file-link", { hasText: "missing.md" }).count(), 0);
  // Shared files: the image in place, the spreadsheet to download.
  await page.locator(".shared-file.kind-image img").waitFor();
  await page.locator(".shared-file.kind-other button", { hasText: "Download" }).waitFor();
  assert.ok((await page.locator(".shared-file.kind-image").innerText()).includes("The new screen"));

  // The link opens the file formatted, in a new tab, at the line mentioned.
  const [viewer] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await viewer.locator(".file-view-head", { hasText: "docs/regras/checagem-ia.md" }).waitFor();
  assert.equal(await viewer.locator(".file-view-target").innerText(), "Resumo", "line 5 is the Resumo heading");
  await viewer.close();

  // The Files tab lists what the team shared.
  await page.locator("button.tab", { hasText: "Files" }).click();
  await page.locator(".files-section", { hasText: "From the team" }).waitFor();
  assert.equal(await page.locator(".shared-files .shared-file").count(), 2);

  // A helper on its own branch writes a file that exists only there, and its guide links to it.
  await say(tool("core", "submit_plan", { goal: "Rules", tasks: [{ key: "new", title: "A new rule", description: "x" }] }));
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });
  const helperScript = [
    "@ia write docs/regras/novo.md # A new rule\\n\\nOnly on the branch.",
    tool("ia", "update_task", { task_id: "T1", status: "review", summary: "Wrote it", guide: "Open docs/regras/novo.md and read the rule." }),
  ].join("\n");
  await say(tool("core", "spawn_agent", { name: "ia", purpose: "Rules", task_id: "T1", task: helperScript, workspace: "own" }));
  await say(tool("core", "update_task", { task_id: "T1", status: "done" }));
  const ia = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "ia");
  await until("the task to wait for review", async () => (await symbio.call("GET", `/projects/${project.id}/plan`)).tasks[0].humanReview?.state === "waiting");

  await page.locator("button.tab", { hasText: "Chat" }).click();
  await page.locator(".needs-you").click();
  const guideLink = page.locator(".review-guide .file-link", { hasText: "docs/regras/novo.md" });
  await guideLink.waitFor();
  assert.match((await guideLink.getAttribute("href")) ?? "", new RegExp(`agent=${ia.id}`), "it opens the helper's copy");
  assert.match((await guideLink.getAttribute("title")) ?? "", /in ia's copy/);
});
