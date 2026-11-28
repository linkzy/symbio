// How core runs the project (Project settings → How core runs the project): deciding on its own
// (its plan is approved as it's made, questions become decisions the human keeps or changes),
// what the team may do without asking, and briefing or grilling. And the skill library: categories,
// credits, and skills core writes for its team.
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

test("deciding on its own: the plan is approved as it's made; questions are decisions the human keeps or changes", async () => {
  const { project, core } = await projectWithCore(symbio, "Autopilot", { autonomy: "decide" });
  assert.equal(project.autonomy, "decide");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "submit_plan", { goal: "A site", tasks: [{ key: "home", title: "Build the home page", description: "The page." }] }));
  assert.equal((await symbio.call("GET", `/projects/${project.id}/plan`)).status, "approved");
  assert.match(await said(project.id, core.id), /it's approved: start assigning the work now/);

  // A question has to come with what core decided; waiting needs a reason.
  await say(tool("core", "ask_human", { question: "Which color for the buttons?" }));
  assert.match(await said(project.id, core.id), /give decided/);
  await say(tool("core", "ask_human", { question: "Which font?", blocking: true }));
  assert.match(await said(project.id, core.id), /give wait_reason/);
  await say(
    [
      tool("core", "ask_human", { question: "Which color for the buttons?", options: ["Blue", "Green"], decided: "Blue" }),
      tool("core", "ask_human", { question: "Which font for the titles?", decided: "Inter" }),
    ].join("\n"),
  );
  assert.match(await said(project.id, core.id), /as decided: "Blue"\. Go on with it now/);

  // Needs you: decisions to keep or change.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  const card = (text: string) => page.locator(".question-card.decided", { hasText: text });
  await card("Which color").locator(".question-decided", { hasText: "Blue" }).waitFor();
  await card("Which color").getByRole("button", { name: "Keep it" }).click();
  await card("Which font").locator("textarea").fill("Georgia");
  await page.locator(".questions-head button", { hasText: "Send answer" }).click();
  await until("both closed", async () => (await symbio.call("GET", `/projects/${project.id}/questions`)).every((q: any) => q.state === "answered"));
  // A change wakes core with what to do instead; a kept decision is a note for its next turn.
  await until("core to get the change", async () => /Which font for the titles\?\s*\(you had decided: Inter;[^)]*\)\s*→ Georgia/.test(await said(project.id, core.id)));
  await idle(symbio, project.id);
  await say("@core say noted");
  assert.match(await said(project.id, core.id), /the human kept your decision on Q\d+ \("Which color for the buttons\?"\): Blue/);
  assert.deepEqual((page as any).errors, []);
});

test("how core runs the project: its settings reach every agent, and grilling replaces the briefing", async () => {
  // Thorough: its brief has the questioning the light one leaves for when the human picks it.
  const { project, core } = await projectWithCore(symbio, "Settings", { depth: "thorough" });
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Settings" }).click();
  const section = page.locator("#lead");
  await section.locator(".seg button", { hasText: "Decide and tell me" }).click();
  await section.locator(".seg button", { hasText: "Grilling" }).click();
  await section.locator("textarea").fill("Spend up to US$ 20 per action.");
  await section.locator("label.choice", { hasText: "Install software without asking" }).locator("input").check();
  // The save returns once every agent has its new instructions.
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/projects/${project.id}`);
  await section.getByRole("button", { name: "Save changes" }).click();
  await saved;
  await until("saved", async () => {
    const p = await symbio.call("GET", `/projects/${project.id}`);
    return p.autonomy === "decide" && p.questionStyle === "grill" && p.standingPermissions === "Spend up to US$ 20 per action." && p.allowInstalls === true;
  });

  await say(["@core knows Spend up to US$ 20 per action.", "@core knows Installing the software the work needs", "@core knows decide it yourself", "@core skills"].join("\n"));
  const coreSaid = await said(project.id, core.id);
  assert.equal(coreSaid.match(/knows: yes/g)?.length, 3, `core has the standing permissions and decides:\n${coreSaid.slice(-1500)}`);
  assert.match(coreSaid, /skills: glossary, grilling, handoff, review|skills: [^\n]*grilling/);
  assert.doesNotMatch(coreSaid.split("skills: ").at(-1)!.split("\n")[0], /briefing/);
  await say(tool("core", "spawn_agent", { name: "pages", purpose: "Pages", task: "@pages knows Spend up to US$ 20 per action.", workspace: "shared" }));
  const pages = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "pages");
  await until("the helper to have them", async () => /knows: yes/.test(await said(project.id, pages.id)));
  assert.deepEqual((page as any).errors, []);
});

test("the skill library: categories, credits with the author's link, search; skills core writes for its team", async () => {
  const { project, core } = await projectWithCore(symbio, "Library");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
    text: tool("core", "create_skill", { name: "invoice-check", description: "Check an invoice's totals and dates.", instructions: "1. Add it up.", category: "data" }),
  });
  await idle(symbio, project.id);
  assert.match(await said(project.id, core.id), /Wrote "invoice-check" into the library/);

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  const section = page.locator("#skills");
  const grilling = section.locator(".skill-category[data-category=planning] .skill-row", { hasText: "grilling" });
  await grilling.waitFor();
  assert.equal(await grilling.locator(".skill-credit a", { hasText: "Matt Pocock" }).getAttribute("href"), "https://github.com/mattpocock");
  await grilling.locator(".skill-credit", { hasText: "MIT" }).waitFor();
  await section.locator(".skill-category[data-category=data] .skill-row", { hasText: "invoice-check" }).locator(".skill-credit", { hasText: "by core, in Library" }).waitFor();
  await section.locator(".skill-category[data-category=leading] .skill-row", { hasText: "briefing" }).locator(".tag", { hasText: "Symbio's" }).waitFor();

  await section.locator(".skill-filters .chip", { hasText: "Operations and servers" }).click();
  await until("only operations", async () => (await section.locator(".skill-category").count()) === 1);
  await section.locator(".skill-row", { hasText: "server-administration" }).waitFor();
  await section.locator(".skill-filters .chip", { hasText: "All" }).click();
  await section.locator(".skill-filters input").fill("ffmpeg");
  await until("the search to find it", async () => (await section.locator(".skill-category .skill-row").count()) === 1);
  await section.locator(".skill-row", { hasText: "video-production" }).waitFor();
  assert.deepEqual((page as any).errors, []);
});
