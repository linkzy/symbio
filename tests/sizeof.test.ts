// Measuring folders (the daily check's build-output alert): every file counts, however many at once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sizeOf } from "../src/server/housekeeping.js";

test("a folder's size adds up every file, even with thousands measured at once", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sym-size-"));
  let expected = 0;
  for (let d = 0; d < 20; d++) {
    const dir = path.join(root, `project${d}`, "bin", "Debug");
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 100; f++) {
      const bytes = 1000 + f;
      writeFileSync(path.join(dir, `lib${f}.dll`), Buffer.alloc(bytes));
      expected += bytes;
    }
  }
  // Before the fix this came out at a small fraction (the parallel additions overwrote each other).
  assert.equal(await sizeOf(root), expected);
});
