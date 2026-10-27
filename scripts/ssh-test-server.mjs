// Usage: node scripts/ssh-test-server.mjs <folder>  — then add a Server connection
// 127.0.0.1:2222, user "deploy", password "s3cret" in Settings.
// Minimal local SSH server for testing Symbio's server connections:
// password auth, exec (via bash), and enough SFTP for uploads. Root dir = argv[2].
import ssh2 from "ssh2";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;
const root = process.argv[2];
const hostKey = utils.generateKeyPairSync("ed25519").private;

new Server({ hostKeys: [hostKey] }, (client) => {
  client.on("authentication", (ctx) => (ctx.method === "password" && ctx.username === "deploy" && ctx.password === "s3cret" ? ctx.accept() : ctx.reject(["password"])));
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acc, _rej, info) => {
        const stream = acc();
        const child = spawn("bash", ["-c", info.command], { cwd: root });
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream.stderr, { end: false });
        child.on("close", (code) => { stream.exit(code ?? 1); stream.end(); });
      });
      session.on("sftp", (acc) => {
        const sftp = acc();
        const handles = new Map();
        let next = 0;
        const abs = (p) => path.join(root, p.replace(/^\/+/, ""));
        sftp.on("OPEN", (id, filename) => {
          const fd = fs.openSync(abs(filename), "w");
          const h = Buffer.alloc(4); h.writeUInt32BE(next, 0); handles.set(next++, fd);
          sftp.handle(id, h);
        });
        sftp.on("WRITE", (id, handle, offset, data) => { fs.writeSync(handles.get(handle.readUInt32BE(0)), data, 0, data.length, offset); sftp.status(id, STATUS_CODE.OK); });
        sftp.on("FSTAT", (id) => sftp.attrs(id, { mode: 0o644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }));
        sftp.on("CLOSE", (id, handle) => { fs.closeSync(handles.get(handle.readUInt32BE(0))); sftp.status(id, STATUS_CODE.OK); });
        sftp.on("MKDIR", (id, p) => { try { fs.mkdirSync(abs(p)); } catch {} sftp.status(id, STATUS_CODE.OK); });
      });
    });
  });
}).listen(2222, "127.0.0.1", () => console.log("test ssh server on 127.0.0.1:2222"));
