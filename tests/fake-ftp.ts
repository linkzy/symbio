// A tiny FTP server for tests: plain FTP, passive mode, files kept in a temporary folder.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface FakeFtp {
  port: number;
  root: string;
  close(): void;
}

/** Enough FTP (plain, passive mode) for basic-ftp's sign-in, listing, mkdir and uploads. */
export async function fakeFtp(user: string, password: string): Promise<FakeFtp> {
  const root = mkdtempSync(path.join(os.tmpdir(), "sym-ftp-root-"));
  const sockets = new Set<net.Socket>();
  const listeners = new Set<net.Server>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let cwd = "/";
    let given = "";
    let authed = false;
    let passive: net.Server | null = null;
    let data: Promise<net.Socket> | null = null;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    const resolve = (p: string) => path.posix.normalize(p.startsWith("/") ? p : path.posix.join(cwd, p));
    const local = (p: string) => path.join(root, ...resolve(p).split("/").filter(Boolean));
    const openPassive = async () => {
      passive?.close();
      const srv = net.createServer();
      passive = srv;
      listeners.add(srv);
      data = new Promise((ok) => srv.once("connection", (s) => (sockets.add(s), ok(s))));
      await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
      return (srv.address() as net.AddressInfo).port;
    };
    reply("220 fake FTP");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const [cmd, ...rest] = line.split(" ");
        const arg = rest.join(" ");
        const verb = cmd.toUpperCase();
        if (verb === "USER") (given = arg), reply("331 password please");
        else if (verb === "PASS") {
          authed = given === user && arg === password;
          reply(authed ? "230 welcome" : "530 Login incorrect.");
        } else if (!authed) reply("530 Please login");
        else if (verb === "FEAT") reply("211 no features");
        else if (["TYPE", "STRU", "OPTS", "MODE"].includes(verb)) reply("200 ok");
        else if (verb === "PWD") reply(`257 "${cwd}"`);
        else if (verb === "CWD") {
          try {
            if (readdirSync(local(arg))) (cwd = resolve(arg)), reply("250 ok");
          } catch {
            reply("550 no such folder");
          }
        } else if (verb === "MKD") mkdirSync(local(arg), { recursive: true }), reply(`257 "${resolve(arg)}" created`);
        else if (verb === "EPSV") reply(`229 Entering Extended Passive Mode (|||${await openPassive()}|)`);
        else if (verb === "PASV") {
          const port = await openPassive();
          reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
        } else if (verb === "LIST" || verb === "NLST") {
          const s = await data!;
          reply("150 here it comes");
          s.end(readdirSync(local(cwd)).map((n) => `-rw-r--r-- 1 u g 0 Jan 1 00:00 ${n}\r\n`).join(""), () => reply("226 done"));
        } else if (verb === "STOR") {
          const target = local(arg);
          const s = await data!;
          reply("150 send it");
          const parts: Buffer[] = [];
          s.on("data", (b) => parts.push(b));
          s.on("end", () => {
            writeFileSync(target, Buffer.concat(parts));
            reply("226 stored");
          });
        } else if (verb === "QUIT") reply("221 bye"), socket.end();
        else reply("502 not implemented");
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    port: (server.address() as net.AddressInfo).port,
    root,
    close: () => {
      for (const s of sockets) s.destroy();
      for (const l of listeners) l.close();
      server.close();
    },
  };
}
