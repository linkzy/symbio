import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AssetRegister, matchPattern } from "../src/server/assets.js";

test("path patterns", () => {
  assert.ok(matchPattern("chapters/03/**", "chapters/03/a/b.md"));
  assert.ok(matchPattern("chapters/03/", "chapters/03/x.md"));
  assert.ok(matchPattern("chapters", "chapters/01.md"));
  assert.ok(matchPattern("brand/palette.json", "brand/palette.json"));
  assert.ok(!matchPattern("brand/palette.json", "brand/palette.json.bak"));
  assert.ok(matchPattern("docs/*.md", "docs/a.md"));
  assert.ok(!matchPattern("docs/*.md", "docs/sub/a.md"));
});

test("request → grant → release, and the merge guard", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orq-assets-"));
  const reg = await AssetRegister.load(dir);
  await reg.declare("chapter2", "neighborhoods", ["chapters/02-neighborhoods.md"]);
  await reg.declare("crm", "external CRM");
  const since = Date.now() - 1;

  assert.equal(reg.violations(["chapters/02-neighborhoods.md", "research/x.md"], "w1", since).length, 1);

  await reg.request("chapter2", "w1", "add a sentence");
  assert.equal(reg.get("chapter2")!.queue.length, 1);
  await reg.grant("chapter2", "w1");
  assert.equal(reg.get("chapter2")!.queue.length, 0);
  await assert.rejects(reg.grant("chapter2", "w2"), /held by another agent/);
  assert.equal(reg.violations(["chapters/02-neighborhoods.md"], "w1", since).length, 0);

  await reg.release("chapter2", "w1", "done");
  // A grant during the current unit of work still covers it after release…
  assert.equal(reg.violations(["chapters/02-neighborhoods.md"], "w1", since).length, 0);
  // …but not work that starts later.
  assert.equal(reg.violations(["chapters/02-neighborhoods.md"], "w1", Date.now() + 1).length, 1);

  await assert.rejects(reg.release("chapter2", "w1", "again"), /don't hold/);
  await assert.rejects(reg.request("nope", "w1", "x"), /Unknown shared asset/);
  assert.equal((await AssetRegister.load(dir)).list().length, 2, "persisted to disk");
});

test("forget releases holdings and drops requests", async () => {
  const reg = await AssetRegister.load(mkdtempSync(path.join(os.tmpdir(), "orq-assets-")));
  await reg.declare("a", "x", ["a/**"]);
  await reg.declare("b", "y", ["b/**"]);
  await reg.grant("a", "w1");
  await reg.request("b", "w1", "need it");
  await reg.forget("w1");
  assert.equal(reg.get("a")!.holder, null);
  assert.equal(reg.get("b")!.queue.length, 0);
});
