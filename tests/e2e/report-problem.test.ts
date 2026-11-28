// Report a problem: a link in the top bar and in Settings to a new bug report, with versions and OS filled in
// and nothing about the person's projects.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("Report a problem opens a new bug report with Symbio's version and the OS, and no project details", async () => {
  await projectWithCore(symbio, "Secret project name");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/about`);
  const current = (await symbio.call("GET", "/update")).current as string;
  const top = page.locator(".topbar-actions a", { hasText: "Report a problem" });
  const inSettings = page.locator(".section a", { hasText: "Report a problem" });
  await top.waitFor();
  await inSettings.waitFor();
  for (const link of [top, inSettings]) {
    const url = async () => new URL((await link.getAttribute("href"))!);
    await until("the version in the link", async () => (await url()).searchParams.get("version") === current);
    await until("the runtimes in the link", async () => /^OpenCode.*, GitHub Copilot CLI/.test((await url()).searchParams.get("runtime") ?? ""));
    const u = await url();
    assert.equal(u.origin + u.pathname, "https://github.com/linkzy/symbio/issues/new");
    // The issue form's fields, by id (.github/ISSUE_TEMPLATE/bug_report.yml).
    assert.equal(u.searchParams.get("template"), "bug_report.yml");
    assert.match(u.searchParams.get("os") ?? "", /\S/);
    assert.ok(!u.href.includes(encodeURIComponent("Secret project name")) && !u.href.includes("Secret"));
    assert.equal(await link.getAttribute("target"), "_blank");
  }
});
