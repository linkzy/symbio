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

test("azure devops connection: organization from what people paste, token kept secret, API calls scoped to the organization", async () => {
  const { azureOrganization } = await import("../src/server/connections.js");
  assert.equal(azureOrganization("unipti"), "unipti");
  assert.equal(azureOrganization("https://dev.azure.com/unipti/"), "unipti");
  assert.equal(azureOrganization("https://user@dev.azure.com/unipti/CPA/_git/Pesquisas"), "unipti");
  assert.equal(azureOrganization("https://unipti.visualstudio.com/DefaultCollection"), "unipti");

  const conns = new Connections();
  await conns.load();
  await assert.rejects(conns.create({ type: "azure", name: "x", token: "t" }), /organization/);
  const AZ = "azdo_FAKE_PAT_0123456789abcdef";
  const c: any = await conns.create({ type: "azure", name: "Company", organization: "https://dev.azure.com/contoso", token: AZ });
  assert.equal(c.organization, "contoso");
  assert.ok(!JSON.stringify(await conns.view(c)).includes(AZ));

  // The API: requests go to the connection's organization, with api-version, Basic auth with an empty user.
  const realFetch = globalThis.fetch;
  const seen: { url: string; auth: string }[] = [];
  let reply = () => new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    return reply();
  }) as any;
  try {
    await conns.azureRequest(c, "GET", "/CPA/_apis/git/repositories");
    assert.equal(seen[0].url, "https://dev.azure.com/contoso/CPA/_apis/git/repositories?api-version=7.1");
    assert.equal(seen[0].auth, `Basic ${Buffer.from(`:${AZ}`).toString("base64")}`);
    await assert.rejects(conns.azureRequest(c, "GET", "https://evil.example/_apis"), /not a full URL/);
    // A refused token gets a sign-in page, not a 401.
    reply = () => new Response("<html>Sign in</html>", { status: 203, headers: { "content-type": "text/html" } });
    await assert.rejects(conns.azureRequest(c, "GET", "_apis/projects"), /rejected the token/);
  } finally {
    globalThis.fetch = realFetch;
  }
  await conns.remove(c.id);
});

test("git credentials only go to a remote of the connection's own host and organization", async () => {
  const { gitAuth } = await import("../src/server/remote.js");
  const azure: any = { type: "azure", name: "Company", organization: "contoso" };
  const github: any = { type: "github", name: "Mine" };
  const a = gitAuth(azure, "https://contoso@dev.azure.com/contoso/Proj/_git/repo", "PAT");
  assert.equal(a.headerKey, "http.https://dev.azure.com/.extraheader");
  assert.equal(a.header, `Authorization: Basic ${Buffer.from(":PAT").toString("base64")}`);
  assert.equal(gitAuth(azure, "https://contoso.visualstudio.com/Proj/_git/repo", "PAT").headerKey, "http.https://contoso.visualstudio.com/.extraheader");
  assert.throws(() => gitAuth(azure, "https://dev.azure.com/otherorg/Proj/_git/repo", "PAT"), /organization "otherorg"/);
  assert.throws(() => gitAuth(azure, "git@ssh.dev.azure.com:v3/contoso/Proj/repo", "PAT"), /SSH remote; switch it to HTTPS/);
  assert.throws(() => gitAuth(azure, "https://github.com/me/repo.git", "PAT"), /Azure DevOps HTTPS URL/);
  assert.throws(() => gitAuth(github, "https://dev.azure.com/contoso/Proj/_git/repo", "T"), /GitHub HTTPS URL/);
  assert.equal(gitAuth(github, "https://github.com/me/repo.git", "T").headerKey, "http.https://github.com/.extraheader");
});
