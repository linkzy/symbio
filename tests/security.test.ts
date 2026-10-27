import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-sec-home-"));
const { git, initRepository } = await import("../src/server/git.js");
const { refuseRiskyGitConfig } = await import("../src/server/remote.js");
const { loadUiToken, tokenMatches } = await import("../src/server/ui-token.js");

test("credentials aren't used in a repository whose config could leak them", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-sec-"));
  await initRepository(dir);
  await refuseRiskyGitConfig(dir); // a plain repository is fine
  await git(dir, "config", "user.name", "someone"); // harmless settings are fine too
  await refuseRiskyGitConfig(dir);

  for (const [key, value] of [
    ["url.https://evil.example/.insteadOf", "https://github.com/"],
    ["http.proxy", "http://evil.example:8080"],
    ["core.hooksPath", ".githooks"],
    ["credential.helper", "store"],
    ["include.path", "../elsewhere"],
  ]) {
    await git(dir, "config", key, value);
    await assert.rejects(refuseRiskyGitConfig(dir), /Refusing to use GitHub credentials/, key);
    await git(dir, "config", "--unset", key);
  }
});

test("the UI key is created once, kept, and compared exactly", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-key-"));
  const token = loadUiToken(dir);
  assert.ok(token.length >= 32);
  assert.equal(loadUiToken(dir), token, "reused across restarts, so open tabs keep working");
  assert.equal(readFileSync(path.join(dir, "ui-token"), "utf8"), token);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, token.slice(0, -1) + "x"), false);
  assert.equal(tokenMatches(token, ""), false);
  assert.equal(tokenMatches(token, undefined), false);
});
