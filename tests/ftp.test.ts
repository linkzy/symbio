// FTP connections: settings, Test, and uploads through remote_upload, against a tiny FTP server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Entry } from "@napi-rs/keyring";
import { fakeFtp, type FakeFtp } from "./fake-ftp.js";

const home = mkdtempSync(path.join(os.tmpdir(), "sym-ftp-"));
process.env.SYMBIO_HOME = home;
process.env.SYMBIO_KEYRING_SERVICE = `symbio-test-ftp-${process.pid}`;
const { Connections, ftpHost } = await import("../src/server/connections.js");
const { RemoteOps } = await import("../src/server/remote.js");

const PASSWORD = "s3cret-FTP-password";
let server: FakeFtp;
before(async () => {
  server = await fakeFtp("deploy", PASSWORD);
});
after(() => {
  server?.close();
  try {
    new Entry(process.env.SYMBIO_KEYRING_SERVICE!, "vault-master-key").deletePassword();
  } catch {}
});

test("FTP host from what people paste", () => {
  assert.equal(ftpHost("ftp.example.com"), "ftp.example.com");
  assert.equal(ftpHost(" ftp://ftp.example.com/public_html "), "ftp.example.com");
  assert.equal(ftpHost("ftps://user@ftp.example.com:21"), "ftp.example.com");
});

test("an FTP connection: password kept secret, Test signs in, wrong password said plainly", async () => {
  const conns = new Connections();
  await conns.load();
  await assert.rejects(conns.create({ type: "ftp", name: "Hosting", host: "h", username: "u" }), /password is required/);
  const c = await conns.create({ type: "ftp", name: "Hosting", host: "127.0.0.1", port: server.port, username: "deploy", password: PASSWORD, security: "none" });
  const view = await conns.view(c);
  assert.equal(view.secrets.password, true);
  assert.ok(!JSON.stringify(view).includes(PASSWORD), "view has no secret");
  for (const f of readdirSync(home)) assert.ok(!readFileSync(path.join(home, f)).toString("latin1").includes(PASSWORD), `${f} has no plaintext secret`);

  const ok = await conns.test(c.id);
  assert.equal(ok.ok, true, ok.message);
  assert.match(ok.message, /Connected \(unencrypted\)/);

  await conns.update(c.id, { password: "wrong" });
  const bad = await conns.test(c.id);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /refused the user or password/);
  await conns.update(c.id, { password: PASSWORD });
});

test("remote_upload sends a folder over FTP (skipping .git); remote_exec says FTP can't run commands", async () => {
  const conns = new Connections();
  await conns.load();
  const c = await conns.create({ type: "ftp", name: "Site", host: "127.0.0.1", port: server.port, username: "deploy", password: PASSWORD, security: "none" });
  const work = mkdtempSync(path.join(os.tmpdir(), "sym-ftp-work-"));
  mkdirSync(path.join(work, "dist", "css"), { recursive: true });
  mkdirSync(path.join(work, "dist", ".git"));
  writeFileSync(path.join(work, "dist", "index.html"), "<h1>Hi</h1>");
  writeFileSync(path.join(work, "dist", "css", "site.css"), "body{}");
  writeFileSync(path.join(work, "dist", ".git", "HEAD"), "ref");

  const logs: string[] = [];
  const remote = new RemoteOps(conns, { log: async (_p, m) => void logs.push(m.text), notify: async () => {} });
  const project = { id: "p1", connections: [{ id: c.id, policy: "allow" }] } as any;
  const agent = { id: "a1", name: "helper", directory: work } as any;

  assert.match(remote.describeFor(project), /FTP account deploy@127\.0\.0\.1 — remote_upload only/);
  const result = await remote.request(project, agent, { kind: "remote_upload", connectionId: "Site", localPath: "dist", remotePath: "public_html" }, "Publish the site");
  assert.match(result, /Uploaded 2 file\(s\)/);
  assert.equal(readFileSync(path.join(server.root, "public_html", "index.html"), "utf8"), "<h1>Hi</h1>");
  assert.equal(readFileSync(path.join(server.root, "public_html", "css", "site.css"), "utf8"), "body{}");
  assert.deepEqual(readdirSync(path.join(server.root, "public_html")).sort(), ["css", "index.html"], ".git is skipped");
  assert.ok(!logs.join("\n").includes(PASSWORD), "the password isn't in the log");

  await assert.rejects(remote.request(project, agent, { kind: "remote_exec", connectionId: "Site", command: "ls" }, "x"), /FTP can only upload files/);
});

test("a server that allows SFTP but no commands tests as SFTP only", async () => {
  const { Server, utils } = (await import("ssh2")).default;
  const { STATUS_CODE } = utils.sftp;
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const sshd = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === PASSWORD ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (_accept, reject) => reject()); // hosting: no commands
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          let listed = false;
          sftp.on("REALPATH", (id) => sftp.name(id, [{ filename: "/home/deploy", longname: "", attrs: {} as any }]));
          sftp.on("OPENDIR", (id) => sftp.handle(id, Buffer.from("d")));
          sftp.on("READDIR", (id) => {
            if (listed) return sftp.status(id, STATUS_CODE.EOF);
            listed = true;
            sftp.name(id, [{ filename: "public_html", longname: "public_html", attrs: {} as any }]);
          });
          sftp.on("CLOSE", (id) => sftp.status(id, STATUS_CODE.OK));
        });
      }),
    );
  });
  await new Promise<void>((ok) => sshd.listen(0, "127.0.0.1", ok));
  try {
    const conns = new Connections();
    await conns.load();
    const port = (sshd.address() as net.AddressInfo).port;
    const c = await conns.create({ type: "server", name: "Hosting SFTP", host: "127.0.0.1", port, username: "deploy", auth: "password", password: PASSWORD });
    const result = await conns.test(c.id);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /SFTP only: uploads work, commands don't\): \/home\/deploy \(1 item/);
  } finally {
    sshd.close();
  }
});
