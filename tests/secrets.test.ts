import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The key file, as on a Linux without a Secret Service (a server, WSL): forced here, on any system.
process.env.SYMBIO_VAULT = "file";
const { SecretVault } = await import("../src/server/secrets.js");

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "symbio-vault-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("without an OS credential store, the key goes to a file only the user can read", async () => {
  const dir = tempDir();
  const vault = SecretVault.at(dir);
  assert.equal(vault.store().store, "file");
  await vault.set("notify:webhook:url", "https://example.com/hook");

  const keyFile = path.join(dir, "secrets.key");
  assert.ok(existsSync(keyFile));
  if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path.join(dir, "secrets.enc")).includes("example.com"));
  // Another Symbio on the same folder (a restart): reads the same key.
  assert.equal(await new SecretVault(path.join(dir, "secrets.enc")).get("notify:webhook:url"), "https://example.com/hook");
});

test("secrets whose key was lost say so, and the pages can still load", async () => {
  const dir = tempDir();
  const first = SecretVault.at(dir);
  await first.set("con_1:token", "secret");
  rmSync(path.join(dir, "secrets.key"));

  // A fresh process wouldn't have the key cached: another folder stands for it.
  const moved = tempDir();
  copyFileSync(path.join(dir, "secrets.enc"), path.join(moved, "secrets.enc"));
  const vault = SecretVault.at(moved);
  assert.match((await vault.problem()) ?? "", /vault key was lost.*enter them again/);
  assert.equal(await SecretVault.at(tempDir()).problem(), null);
});
