import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PlanStore } from "../src/server/plan.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "orq-plan-"));

test("propose resolves keys to ids and dependencies", async () => {
  const store = await PlanStore.load(tmp());
  const plan = await store.propose("Build a site", [
    { key: "skeleton", title: "Skeleton", description: "pages + nav" },
    { key: "menu", title: "Menu page", description: "prices", depends_on: ["skeleton"], assets: ["stylesheet"] },
    { title: "Contact page", description: "form", depends_on: ["skeleton"] },
  ]);
  assert.equal(plan.status, "proposed");
  assert.deepEqual(plan.tasks.map((t) => t.id), ["T1", "T2", "T3"]);
  assert.deepEqual(store.task("t2").dependsOn, ["T1"]);
  assert.deepEqual(store.openDependencies(store.task("T2")).map((t) => t.id), ["T1"]);
  await store.update("T1", { status: "done" });
  assert.equal(store.openDependencies(store.task("T2")).length, 0);
});

test("rejects unknown dependencies and cycles", async () => {
  const store = await PlanStore.load(tmp());
  await assert.rejects(store.propose("g", [{ title: "A", description: "", depends_on: ["nope"] }]), /unknown task/);
  await assert.rejects(
    store.propose("g", [
      { key: "a", title: "A", description: "", depends_on: ["b"] },
      { key: "b", title: "B", description: "", depends_on: ["a"] },
    ]),
    /Circular/,
  );
});

test("a revision keeps progress of reused task ids", async () => {
  const dir = tmp();
  const store = await PlanStore.load(dir);
  await store.propose("v1", [
    { title: "A", description: "" },
    { title: "B", description: "" },
  ]);
  await store.decide(true, null);
  await store.update("T1", { status: "in-progress", assignee: "agent-1", note: { by: "x", text: "started" } });
  const plan = await store.propose("v2", [
    { key: "T1", title: "A (renamed)", description: "" },
    { title: "C", description: "", depends_on: ["T1"] },
  ]);
  assert.equal(plan.revision, 2);
  assert.equal(plan.status, "proposed");
  const t1 = store.task("T1");
  assert.equal(t1.title, "A (renamed)");
  assert.equal(t1.status, "in-progress");
  assert.equal(t1.assignee, "agent-1");
  assert.equal(t1.notes.length, 1);
  assert.equal(plan.tasks[1].id, "T3", "new ids don't reuse dropped ones");
  assert.equal((await PlanStore.load(dir)).plan.revision, 2, "persisted");
});

test("decide only applies to a proposed plan", async () => {
  const store = await PlanStore.load(tmp());
  await assert.rejects(store.decide(true, null), /no proposed plan/);
  await store.propose("g", [{ title: "A", description: "" }]);
  const plan = await store.decide(false, "split A in two");
  assert.equal(plan.status, "changes-requested");
  assert.equal(plan.feedback, "split A in two");
});
