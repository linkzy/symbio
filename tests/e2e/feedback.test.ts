// Settings → Feedback: links to the repository's Discussions (new idea, new question).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, openPage, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("Settings has a Give feedback link to Discussions (Ideas) and one for questions (Q&A)", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings/help`);
  const feedback = page.locator("a", { hasText: "Give feedback" });
  await feedback.waitFor();
  assert.equal(await feedback.getAttribute("href"), "https://github.com/linkzy/symbio/discussions/new?category=ideas");
  assert.equal(await feedback.getAttribute("target"), "_blank");
  const question = page.locator("a", { hasText: "Ask a question" });
  assert.equal(await question.getAttribute("href"), "https://github.com/linkzy/symbio/discussions/new?category=q-a");
});
