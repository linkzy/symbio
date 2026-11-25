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
  // "Back to the project" until its name has loaded.
  await until("Back to name the project", async () => (await page.locator(".settings-back").innerText()) === "Back to Nav check");
  await page.locator(".settings-back").click();
  await onPlan();
  await open();
  await page.locator(".topbar-actions a", { hasText: "Settings" }).click();
  await onPlan();
  await open();
  await page.keyboard.press("Escape");
  await onPlan();
});

test("Settings in groups: one click to each, the address keeps the group through a reload, and Back still returns to the project", async () => {
  const { project } = await projectWithCore(symbio, "Groups check");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".topbar-actions a", { hasText: "Settings" }).click();
  // Agents first: runtimes and skills, not connections.
  await page.locator(".settings-tab.on", { hasText: "Agents" }).waitFor();
  await page.locator("#skills").waitFor();
  assert.equal(await page.locator(".section", { hasText: "Model prices" }).count(), 0);

  await page.locator(".settings-tab", { hasText: "Usage and costs" }).click();
  await until("the group in the address", () => hash(page.url()) === "#/settings/usage");
  await page.locator(".section", { hasText: "Model prices" }).waitFor();
  assert.equal(await page.locator("#skills").count(), 0);
  await page.reload();
  await page.locator(".settings-tab.on", { hasText: "Usage and costs" }).waitFor();
  await page.locator(".settings-tab", { hasText: "Help" }).click();
  await page.locator(".section a", { hasText: "Report a problem" }).waitFor();
  // Moving between groups doesn't change where Back goes.
  await page.locator(".settings-back").click();
  await until("the project page", () => hash(page.url()) === `#/p/${project.id}`);

  // A link into Settings opens its group; a project's settings have groups too.
  await page.goto(`${symbio.base}/#/settings/connections`);
  await page.locator(".settings-tab.on", { hasText: "Connections" }).waitFor();
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Settings" }).click();
  await page.locator(".settings-tab.on", { hasText: "General" }).waitFor();
  await page.locator(".settings-tab", { hasText: "Maintenance" }).click();
  await page.locator(".danger-zone").waitFor();
  assert.deepEqual((page as any).errors, []);
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
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".tabs, .settings-tabs, .columns, .side, pre, .md table"))
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
