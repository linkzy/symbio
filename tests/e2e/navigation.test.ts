// Getting around: leaving Settings back to the same place, the project switcher, a removed
// project's page, and the phone layout (nothing wider than the screen, the team drawer).
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

const hash = (url: string) => new URL(url).hash;

test("Settings: Back names the project, and Back, Settings again or Escape return to the same tab", async () => {
  const { project } = await projectWithCore(symbio, "Nav check");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Plan" }).click();
  const open = async () => {
    await page.locator(".topbar-actions a", { hasText: "Settings" }).click();
    await page.locator(".settings-back").waitFor();
  };
  const onPlan = async () => {
    await until("the project page", () => hash(page.url()) === `#/p/${project.id}`);
    assert.equal(await page.locator("button.tab.active").innerText(), "Plan");
  };
  await open();
  assert.equal(await page.locator(".settings-back").innerText(), "Back to Nav check");
  await page.locator(".settings-back").click();
  await onPlan();
  await open();
  await page.locator(".topbar-actions a", { hasText: "Settings" }).click();
  await onPlan();
  await open();
  await page.keyboard.press("Escape");
  await onPlan();
});

test("the project switcher: other projects, all projects, a new project", async () => {
  const a = (await symbio.call("GET", "/projects")).find((p: any) => p.name === "Nav check") ?? (await projectWithCore(symbio, "Nav check")).project;
  const { project: b } = await projectWithCore(symbio, "Second project");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${a.id}`);
  await page.locator(".switcher-button").click();
  await page.locator(".menu-list.left button", { hasText: "Second project" }).click();
  await until("the other project", () => hash(page.url()) === `#/p/${b.id}`);
  await page.locator(".switcher-button").click();
  await page.locator(".menu-list.left button", { hasText: "New project" }).click();
  await page.locator(".dialog h2", { hasText: "New project" }).waitFor();
});

test("removing the project you're looking at goes back to the list, and so does its old link", async () => {
  const { project } = await projectWithCore(symbio, "To remove");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".main-actions button[title='Project options']").click();
  await page.locator(".menu-list button.danger").click();
  await page.locator(".dialog button", { hasText: /^Remove/ }).last().click();
  await until("the project list", () => hash(page.url()) === "#/");
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await until("the project list again", () => hash(page.url()) === "#/");
});

test("phone layout: nothing wider than the screen; the team opens as a drawer", async () => {
  const { project } = await projectWithCore(symbio, "Phone check");
  const { page } = await openPage(symbio, { phone: true });
  const overflowing = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".tabs, .columns, .side, pre, .md table"))
        .map((e) => (e as HTMLElement).className || e.tagName)
        .slice(0, 5),
    );
  for (const route of ["#/", `#/p/${project.id}`, "#/settings"]) {
    await page.goto(`${symbio.base}/${route}`);
    await page.waitForTimeout(700);
    assert.deepEqual(await overflowing(), [], `${route} fits the screen`);
  }
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  assert.equal(await page.locator(".side").evaluate((e) => e.getBoundingClientRect().right <= 0), true, "the team starts hidden");
  await page.locator(".team-toggle").click();
  await until("the drawer to open", () => page.locator(".side.open").evaluate((e) => e.getBoundingClientRect().left >= 0));
  await page.locator(".agent-row", { hasText: "core" }).click();
  await until("the drawer to close", async () => (await page.locator(".side.open").count()) === 0);
});
