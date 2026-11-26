// SSH connections that fail must say so, never crash Symbio: ssh2 can emit several errors for one
// failed connection (a timeout, then "Connection lost before handshake"), and one with no listener
// stopped Symbio on a user's computer.
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { connect, sshExec } from "../src/server/ssh.js";

async function server(onSocket: (s: Socket) => void) {
  const srv = createServer(onSocket);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: (srv.address() as { port: number }).port };
}

test("a server that never answers, then hangs up: one clear error, no crash", async () => {
  const sockets: Socket[] = [];
  const { srv, port } = await server((s) => {
    sockets.push(s);
    s.on("error", () => {});
    setTimeout(() => s.destroy(), 600); // after the handshake timeout
  });
  try {
    await assert.rejects(connect({ host: "127.0.0.1", port, username: "u", password: "p" }, 300), /Timed out|handshake/);
    await new Promise((r) => setTimeout(r, 900)); // the second error arrives meanwhile: it must not crash the process
  } finally {
    srv.close();
  }
});

test("a server that hangs up at once: the command fails with a reason", async () => {
  const { srv, port } = await server((s) => s.destroy());
  try {
    await assert.rejects(sshExec({ host: "127.0.0.1", port, username: "u", password: "p" }, "echo hi"), /./);
  } finally {
    srv.close();
  }
});
