import assert from "node:assert/strict";
import { promises as fsp, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { replaceFile } from "../src/server/fsutil.js";

test("replacing a file waits out Windows briefly holding it (EPERM), and gives up on real errors", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-fsutil-"));
  const dest = path.join(dir, "project.json");
  writeFileSync(dest, "old");

  // An antivirus scan holding the file: the first two attempts are refused.
  const realRename = fsp.rename;
  let refused = 0;
  fsp.rename = (async (from: string, to: string) => {
    if (refused < 2) {
      refused++;
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    return realRename(from, to);
  }) as typeof fsp.rename;
  try {
    const tmp = path.join(dir, "project.json.tmp");
    writeFileSync(tmp, "new");
    await replaceFile(tmp, dest);
    assert.equal(refused, 2);
    assert.equal(readFileSync(dest, "utf8"), "new", "saved after the retries");
    assert.ok(!existsSync(tmp));
  } finally {
    fsp.rename = realRename;
  }

  // Not a transient error (the folder is gone): fails at once, and the temporary file is cleaned up.
  const tmp = path.join(dir, "other.tmp");
  writeFileSync(tmp, "x");
  await assert.rejects(replaceFile(tmp, path.join(dir, "missing", "file.json")), /ENOENT/);
  assert.ok(!existsSync(tmp), "temporary file removed");
});
