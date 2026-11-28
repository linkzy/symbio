import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-briefs-home-"));
const { coordinatorBrief, kickoffMessage, workerBrief } = await import("../src/server/prompts.js");

test("briefs: Symbio's secrets are off-limits, the project's own credentials may be used but not spread", () => {
  const project: any = { name: "p", directory: os.tmpdir(), allowedModels: ["a/b"], docsLocation: "project", origin: "new", agents: [] };
  const agent: any = { name: "dev", role: "worker", directory: os.tmpdir(), branch: "symbio/dev" };
  for (const brief of [coordinatorBrief(project), workerBrief(project, agent, "core")]) {
    assert.match(brief, /Symbio's secrets are off-limits/);
    assert.match(brief, /project's own credentials[\s\S]*may be used for the task/);
    assert.match(brief, /never put a credential into anything that is committed/);
    assert.match(brief, /read-only mirror/);
    // The old blanket rule made agents refuse legitimate work.
    assert.doesNotMatch(brief, /never look for them on this machine/);
  }
});

test("briefs: AI co-author lines are left out of commits unless the project allows them", () => {
  const project: any = { name: "p", directory: os.tmpdir(), allowedModels: ["a/b"], docsLocation: "project", origin: "new", agents: [] };
  const own: any = { name: "dev", role: "worker", directory: os.tmpdir(), branch: "symbio/dev" };
  for (const brief of [coordinatorBrief(project), workerBrief(project, own, "core")]) assert.match(brief, /don't add `Co-authored-by`/);
  project.aiCoauthors = true;
  for (const brief of [coordinatorBrief(project), workerBrief(project, own, "core")]) assert.doesNotMatch(brief, /Co-authored-by/);
});

test("briefs: helpers in the project folder get the commit rule too", () => {
  const project: any = { name: "p", directory: os.tmpdir(), allowedModels: ["a/b"], docsLocation: "project", origin: "new", agents: [] };
  const shared: any = { name: "dev", role: "worker", directory: os.tmpdir(), branch: null };
  assert.match(workerBrief(project, shared, "core"), /don't add `Co-authored-by`/);
});

test("briefs: a light project offers how to start, and writes specs, a glossary and docs only when the work needs them", () => {
  const base: any = { name: "p", directory: mkdtempSync(path.join(os.tmpdir(), "sym-light-")), allowedModels: ["a/b"], docsLocation: "project", origin: "new", agents: [], autonomy: "decide" };
  const light = coordinatorBrief({ ...base, depth: "light" });
  assert.match(light, /This project is \*\*light\*\*/);
  assert.match(light, /offer_start/);
  assert.match(light, /Symbio tells you to go ahead/);
  assert.match(light, /Don't start a glossary up front/);
  assert.match(light, /Don't write documentation before the work starts/);
  assert.match(light, /only when the human asks for one: check the work yourself/);
  assert.doesNotMatch(light, /Start it early/);
  // The helper's brief doesn't point at a glossary that doesn't exist yet.
  assert.doesNotMatch(workerBrief({ ...base, depth: "light" }, { name: "dev", role: "worker", directory: base.directory, branch: null } as any, "core"), /project's glossary/);
  // An existing folder: a quick look without asking first, then the offer.
  assert.match(coordinatorBrief({ ...base, depth: "light", origin: "existing" }), /quick look before anything else, without\s+asking first/);
  assert.match(kickoffMessage({ ...base, depth: "light", origin: "existing" }), /offer how to start \(offer_start\)/);

  // Projects from before (no depth) keep the thorough way.
  const thorough = coordinatorBrief(base);
  assert.doesNotMatch(thorough, /offer_start/);
  assert.match(thorough, /Start it early/);
  assert.match(kickoffMessage({ ...base, origin: "existing" }), /offer to study the folder/);
});
