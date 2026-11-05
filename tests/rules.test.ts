import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-rules-home-"));
const { listRules, readRegister, registerPath, saveArea, saveRule, saveSource } = await import("../src/server/rules.js");

const project = (): any => ({ directory: mkdtempSync(path.join(os.tmpdir(), "sym-rules-")), docsLocation: "project", rulesRegister: true });

test("rules register: areas, sources, ids per area, validation, partial updates", async () => {
  const p = project();
  await assert.rejects(saveRule(p, { area: "AP", text: "x" }, "core"), /No area AP/);
  await saveArea(p, { id: "ap", name: "Submission", stages: [{ name: "Access" }, { name: "Documents" }] });
  await saveSource(p, { id: "MA", name: "Manual", file: "docs\\manual.txt", authority: "EC", authority_name: "Directorate" });
  await assert.rejects(saveSource(p, { id: "AP", name: "clash" }), /area prefix/);
  await assert.rejects(saveArea(p, { id: "MA", name: "clash" }), /source code/);

  assert.match(await saveRule(p, { area: "AP", stage: "A", text: "Log in first.", citations: [{ source: "MA", location: "l.3", excerpt: "Log in" }] }, "core"), /Added AP-001/);
  assert.match(await saveRule(p, { area: "AP", stage: "B", text: "PDF only." }, "core"), /Added AP-002\. It has no source yet/);
  await assert.rejects(saveRule(p, { area: "AP", stage: "Z", text: "x" }, "core"), /no stage "Z"/);
  await assert.rejects(saveRule(p, { area: "AP", text: "x", citations: [{ source: "XX" }] }, "core"), /Unknown source "XX"/);
  await assert.rejects(saveRule(p, { area: "AP", text: "x", status: "maybe" }, "core"), /status must be one of/);
  await assert.rejects(saveRule(p, { id: "AP-099", text: "x" }, "core"), /No rule AP-099/);

  // Only the given fields change.
  await saveRule(p, { id: "ap-002", status: "partial", current: "Diverges: also accepts JPG." }, "helper");
  const reg = await readRegister(p);
  const r2 = reg.rules.find((r) => r.id === "AP-002")!;
  assert.equal(r2.text, "PDF only.");
  assert.equal(r2.stage, "B");
  assert.equal(r2.status, "partial");
  assert.equal(r2.updatedBy, "helper");
  assert.equal(reg.sources[0].file, "docs/manual.txt", "file paths use forward slashes");
  assert.deepEqual(reg.authorities, [{ id: "EC", name: "Directorate" }]);

  // Superseding keeps the old rule; numbers never come back.
  await saveRule(p, { area: "AP", stage: "B", text: "PDF or JPG." }, "core");
  await saveRule(p, { id: "AP-002", superseded_by: "AP-003" }, "core");
  assert.match(await listRules(p, { area: "AP" }), /AP-002 \[B\] partial\/found superseded by AP-003/);
  assert.match(await listRules(p, { query: "jpg" }), /2 rule\(s\)/);
  assert.equal(registerPath(p), path.join(p.directory, "docs", "rules.json"));
});

test("rules register: concurrent writes from several agents all land, with distinct ids", async () => {
  const p = project();
  await saveArea(p, { id: "GR", name: "General" });
  await Promise.all(Array.from({ length: 12 }, (_, i) => saveRule(p, { area: "GR", text: `Rule ${i}` }, `agent-${i}`)));
  const reg = JSON.parse(readFileSync(registerPath(p), "utf8"));
  assert.equal(reg.rules.length, 12);
  assert.equal(new Set(reg.rules.map((r: any) => r.id)).size, 12);
});

test("reopening a project's folder takes the rules register choice made in the dialog", async () => {
  const { Store } = await import("../src/server/store.js");
  const store = new Store();
  await store.load();
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-reopen-"));
  const input = { name: "p", directory: dir, allowedModels: ["a/b"], coordinatorModel: "a/b", docsLocation: "project" as const, origin: "new" as const, inspectionSummary: "" };
  const first = await store.create({ ...input, rulesRegister: false });
  await store.remove(first, false);
  const reopened = await store.create({ ...input, rulesRegister: true });
  assert.equal(reopened.id, first.id, "same project, reopened");
  assert.equal(reopened.rulesRegister, true);
});
