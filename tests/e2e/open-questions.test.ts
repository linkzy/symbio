// The team's open questions: core and a helper ask with ask_human, a repeat is refused, and the human
// answers two at once from Needs you (each asker gets its answers) and sets one aside.
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

test("questions wait in Needs you, are answered together, and reach whoever asked", async () => {
  const { project, core } = await projectWithCore(symbio, "Questions");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  const questions = async () => Object.fromEntries((await symbio.call("GET", `/projects/${project.id}/questions`)).map((q: any) => [q.id, q]));

  await say(
    [
      tool("core", "ask_human", {
        question: "Should a blank field in the generated form warn or block?",
        context: "Today it's **free**: nothing happens.",
        options: ["Warn", "Block"],
        blocking: true,
      }),
      tool("core", "ask_human", { question: "Which city goes at the end of the letter?" }),
      tool("core", "ask_human", { question: "Should a blank field in the generated form warn, or block?" }),
    ].join("\n"),
  );
  assert.match(await history(symbio, project.id, core.id), /Already open as Q1/, "the repeat is refused");
  await say(tool("core", "spawn_agent", { name: "writer", purpose: "Writes", task: tool("writer", "ask_human", { question: "May I rename the old images folder?" }), workspace: "shared" }));
  await until("the helper's question", async () => !!(await questions()).Q3);
  assert.deepEqual(Object.keys(await questions()), ["Q1", "Q2", "Q3"]);
  const writer = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "writer");

  const { page } = await openPage(symbio);
  page.on("dialog", (d) => void d.accept("We decided it in the meeting"));
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  await until("three open questions", async () => (await page.locator(".question-card").count()) === 3);
  const card = (id: string) => page.locator(".question-card", { has: page.locator(".question-id", { hasText: new RegExp(`^${id}$`) }) });
  await card("Q1").locator(".question-context strong", { hasText: "free" }).waitFor();
  await card("Q1").locator(".chip", { hasText: "Warn" }).click();
  await card("Q3").locator("textarea").fill("Yes, rename it to archive");
  await page.locator(".questions-head button", { hasText: "Send 2 answers" }).click();
  await until("Q1 and Q3 to be answered", async () => {
    const q = await questions();
    return q.Q1.state === "answered" && q.Q3.state === "answered";
  });
  const q = await questions();
  assert.equal(q.Q1.answer, "Warn");
  assert.equal(q.Q2.state, "open", "not answered, still open");

  // core gets its answer; the helper gets its own, and core is told about it.
  await until("core to get its answer", async () => /Q1: Should a blank field[^"]*\\n→ Warn/.test(await history(symbio, project.id, core.id)));
  await until("the writer to get its answer", async () => /Q3: May I rename the old images folder\?\\n→ Yes, rename it to archive/.test(await history(symbio, project.id, writer.id)));
  assert.doesNotMatch(await history(symbio, project.id, writer.id), /Q1:/, "each asker only gets its own answers");

  // Setting one aside tells whoever asked, with the note.
  await card("Q2").locator("button", { hasText: "Set aside" }).click();
  await until("Q2 to be set aside", async () => (await questions()).Q2.state === "set-aside");
  // Both notes to core wait for its next turn (they don't wake it).
  await say("@core say noted");
  await until("core to be told", async () => {
    const h = await history(symbio, project.id, core.id);
    return /the human answered writer's question/.test(h) && /set aside Q2 .*We decided it in the meeting/.test(h);
  });
  await page.locator(".question-card").first().waitFor({ state: "detached" });
  await page.locator(".questions-closed button", { hasText: "Answered questions (3)" }).click();
  await page.locator(".question-closed", { hasText: "→ Warn" }).waitFor();
});
