import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Entry } from "@napi-rs/keyring";

// Isolated home and credential entry for this test run.
const home = mkdtempSync(path.join(os.tmpdir(), "orq-conn-"));
process.env.SYMBIO_HOME = home;
process.env.SYMBIO_KEYRING_SERVICE = `symbio-test-${process.pid}`;
const { Connections } = await import("../src/server/connections.js");

after(() => {
  try {
    new Entry(process.env.SYMBIO_KEYRING_SERVICE!, "vault-master-key").deletePassword();
  } catch {}
});

const SECRET = "ghp_THIS_IS_A_FAKE_TOKEN_1234567890";

test("github connection: secret stored encrypted, never exposed", async () => {
  const conns = new Connections();
  await conns.load();
  const c = await conns.create({ type: "github", name: "Personal", token: SECRET });
  const view = await conns.view(c);
  assert.equal(view.secrets.token, true);
  assert.ok(!JSON.stringify(view).includes(SECRET), "view has no secret");
  for (const f of readdirSync(home)) assert.ok(!readFileSync(path.join(home, f)).toString("latin1").includes(SECRET), `${f} has no plaintext secret`);

  // A fresh instance (new process) can decrypt with the master key.
  const again = new Connections();
  await again.load();
  assert.equal(await again.githubToken(again.get(c.id) as any), SECRET);

  // Updating without a token keeps the stored one.
  await again.update(c.id, { name: "Renamed" });
  assert.equal(await again.githubToken(again.get(c.id) as any), SECRET);

  await again.remove(c.id);
  assert.equal(await again.vault.has(`${c.id}:token`), false, "secrets deleted with the connection");
});

test("validation", async () => {
  const conns = new Connections();
  await conns.load();
  await assert.rejects(conns.create({ type: "github", name: "x" }), /token is required/);
  await assert.rejects(conns.create({ type: "server", name: "vps", username: "root", privateKey: "k" }), /Host is required/);
  await assert.rejects(conns.create({ type: "server", name: "vps", host: "h", username: "root" }), /private key/);
  await assert.rejects(conns.create({ type: "server", name: "vps", host: "h", username: "root", keyPath: "C:/nope/id_x" }), /Can't read the key file/);
  const pw = await conns.create({ type: "server", name: "vps", host: "h", username: "root", auth: "password", password: "pw" });
  assert.equal((await conns.sshTarget(pw as any)).password, "pw");
});

test("server test reports a friendly error", async () => {
  const conns = new Connections();
  await conns.load();
  const c = await conns.create({ type: "server", name: "local", host: "127.0.0.1", port: 1, username: "nobody", auth: "password", password: "x" });
  const result = await conns.test(c.id);
  assert.equal(result.ok, false);
  assert.match(result.message, /refused|timed out/i);
});
