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

test("remote_upload sends a folder over FTP (skipping .git) and replaces files that exist", async () => {
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

  assert.match(remote.describeFor(project), /FTP account deploy@127\.0\.0\.1 — remote_upload .*remote_exec with FTP file operations/);
  const result = await remote.request(project, agent, { kind: "remote_upload", connectionId: "Site", localPath: "dist", remotePath: "public_html" }, "Publish the site");
  assert.match(result, /Uploaded 2 file\(s\)/);
  assert.equal(readFileSync(path.join(server.root, "public_html", "index.html"), "utf8"), "<h1>Hi</h1>");
  assert.equal(readFileSync(path.join(server.root, "public_html", "css", "site.css"), "utf8"), "body{}");
  assert.deepEqual(readdirSync(path.join(server.root, "public_html")).sort(), ["css", "index.html"], ".git is skipped");
  assert.ok(!logs.join("\n").includes(PASSWORD), "the password isn't in the log");

  // A second deploy replaces what's there.
  writeFileSync(path.join(work, "dist", "index.html"), "<h1>Hi again</h1>");
  await remote.request(project, agent, { kind: "remote_upload", connectionId: "Site", localPath: "dist/index.html", remotePath: "public_html/index.html" }, "Redeploy");
  assert.equal(readFileSync(path.join(server.root, "public_html", "index.html"), "utf8"), "<h1>Hi again</h1>");
});

test("FTP file operations through remote_exec: listing runs at once, changes follow the connection's approval setting", async () => {
  const { parseFtpOperations } = await import("../src/server/ftp.js");
  assert.deepEqual(parseFtpOperations('rm -f old.html\nmv "a b.txt" c.txt; ls'), [
    { op: "rm", args: ["old.html"] },
    { op: "mv", args: ["a b.txt", "c.txt"] },
    { op: "ls", args: [] },
  ]);
  assert.throws(() => parseFtpOperations("chmod 755 x"), /isn't an FTP operation/);
  assert.throws(() => parseFtpOperations("mv onlyone"), /Usage: mv/);

  const conns = new Connections();
  await conns.load();
  const c = await conns.create({ type: "ftp", name: "Ops", host: "127.0.0.1", port: server.port, username: "deploy", password: PASSWORD, security: "none" });
  mkdirSync(path.join(server.root, "www", "old", "img"), { recursive: true });
  writeFileSync(path.join(server.root, "www", "old", "img", "logo.png"), "png");
  writeFileSync(path.join(server.root, "www", "old", "page.html"), "old");
  writeFileSync(path.join(server.root, "www", "draft.html"), "draft");
  const notes: string[] = [];
  const remote = new RemoteOps(conns, { log: async () => {}, notify: async (_p, _a, text) => void notes.push(text) });
  const project = { id: "p2", connections: [{ id: c.id, policy: "ask" }] } as any;
  const agent = { id: "a1", name: "helper", directory: os.tmpdir() } as any;
  const exec = (command: string) => remote.request(project, agent, { kind: "remote_exec", connectionId: "Ops", command }, "Tidy the site");

  // Listing only reads: no approval even when the connection asks.
  const listing = await exec("ls www");
  assert.match(listing, /d .* old\//);
  assert.match(listing, /- +5 +draft\.html/);

  // Changes wait for the human; a mistake is refused before anything is queued.
  await assert.rejects(exec("rm -rf / && reboot"), /isn't an FTP operation/);
  const waiting = await exec("rmdir www/old\nmv www/draft.html www/index.html\nmkdir www/assets/css");
  assert.match(waiting, /Waiting for the human's approval/);
  assert.ok(readdirSync(path.join(server.root, "www")).includes("old"), "nothing changed before approval");
  const [approval] = (await remote.list(project)).filter((a: any) => a.status === "pending");
  await remote.decide(project, agent, approval.id, true, null);
  assert.deepEqual(readdirSync(path.join(server.root, "www")).sort(), ["assets", "index.html"]);
  assert.ok(readdirSync(path.join(server.root, "www", "assets")).includes("css"));
  assert.match(notes.at(-1)!, /\$ rmdir www\/old\nok/);

  // A failure stops the rest and says so; the account's top folder can't be removed.
  await remote.decide(project, agent, (await exec("rm www/missing.html\nrm www/index.html").then(async () => (await remote.list(project)).at(-1)!)).id, true, null);
  assert.match(notes.at(-1)!, /failed: .*\n\n\(stopped here/);
  assert.ok(readdirSync(path.join(server.root, "www")).includes("index.html"), "the second rm didn't run");
  await remote.decide(project, agent, (await exec("rmdir /").then(async () => (await remote.list(project)).at(-1)!)).id, true, null);
  assert.match(notes.at(-1)!, /Refusing to remove the account's top folder/);
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
