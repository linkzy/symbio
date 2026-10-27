// SSH for server connections: run commands and upload files. Runs inside the
// Symbio process with credentials from the vault; agents only see results.

import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** The server's key fingerprint seen before (trust on first use); null the first time. */
  hostKey?: string | null;
  /** Called with the fingerprint when connecting to a server for the first time. */
  onFirstHostKey?: (fingerprint: string) => void | Promise<void>;
}

const MAX_OUTPUT = 60_000;

export const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

function connect(target: SshTarget, timeoutMs = 20_000): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seen: string | null = null;
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: timeoutMs,
      // Without this any server would be accepted, and an impostor on the network would
      // receive the password and the commands.
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        return !target.hostKey || seen === target.hostKey;
      },
      ...(target.privateKey ? { privateKey: target.privateKey, passphrase: target.passphrase } : { password: target.password }),
    };
    client.once("ready", async () => {
      if (!target.hostKey && seen) await target.onFirstHostKey?.(seen);
      resolve(client);
    });
    client.once("error", (err) => {
      if (target.hostKey && seen && seen !== target.hostKey) {
        reject(
          new Error(
            `The server at ${target.host} presented a different host key (${seen}) than before (${target.hostKey}). ` +
              "This can mean someone is intercepting the connection. If the server was reinstalled, edit and save the connection in Settings to trust its new key.",
          ),
        );
      } else reject(friendlyError(err, target));
    });
    client.connect(config);
  });
}

function friendlyError(err: Error & { level?: string; code?: string }, t: SshTarget): Error {
  if (err.level === "client-authentication") return new Error(`Authentication failed for ${t.username}@${t.host} — check the key/password.`);
  if (err.code === "ENOTFOUND") return new Error(`Host not found: ${t.host}`);
  if (err.code === "ECONNREFUSED") return new Error(`Connection refused by ${t.host}:${t.port}`);
  if (/timed out/i.test(err.message)) return new Error(`Timed out connecting to ${t.host}:${t.port}`);
  if (/passphrase/i.test(err.message)) return new Error("The private key is encrypted — add its passphrase.");
  return new Error(err.message);
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Runs one command (non-interactive) and returns its output. */
export async function sshExec(target: SshTarget, command: string, timeoutMs = 10 * 60_000): Promise<ExecResult> {
  const client = await connect(target);
  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let truncated = false;
        const add = (which: "out" | "err", chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (stdout.length + stderr.length + text.length > MAX_OUTPUT) {
            truncated = true;
            return;
          }
          if (which === "out") stdout += text;
          else stderr += text;
        };
        const timer = setTimeout(() => {
          stream.close();
          reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        // The exit status may arrive as an "exit" event before "close", or as close's argument.
        let exitCode: number | null = null;
        stream.on("exit", (code: number | null) => {
          if (typeof code === "number") exitCode = code;
        });
        stream.on("data", (c: Buffer) => add("out", c));
        stream.stderr.on("data", (c: Buffer) => add("err", c));
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ code: typeof code === "number" ? code : exitCode, stdout, stderr, truncated });
        });
      });
    });
  } finally {
    client.end();
  }
}

/** Uploads a local file or folder (recursively) to a remote path. Returns the number of files. */
export async function sshUpload(target: SshTarget, localPath: string, remotePath: string): Promise<number> {
  // SFTP doesn't expand "~"; relative paths are already relative to the home folder.
  remotePath = remotePath.replace(/^~\/?/, "") || ".";
  const client = await connect(target);
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((e, s) => (e ? reject(e) : resolve(s))));
    const stat = await fs.stat(localPath);
    if (stat.isFile()) {
      await mkdirp(sftp, path.posix.dirname(remotePath));
      await put(sftp, localPath, remotePath);
      return 1;
    }
    let count = 0;
    const walk = async (dir: string, remote: string) => {
      await mkdirp(sftp, remote);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".symbio") continue;
        const local = path.join(dir, entry.name);
        const target = path.posix.join(remote, entry.name);
        if (entry.isDirectory()) await walk(local, target);
        else if (entry.isFile()) {
          await put(sftp, local, target);
          count++;
        }
      }
    };
    await walk(localPath, remotePath);
    return count;
  } finally {
    client.end();
  }
}

function put(sftp: SFTPWrapper, local: string, remote: string) {
  return new Promise<void>((resolve, reject) => sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve())));
}

async function mkdirp(sftp: SFTPWrapper, dir: string) {
  const parts = dir.split("/").filter(Boolean);
  let current = dir.startsWith("/") ? "" : ".";
  for (const part of parts) {
    current = current === "" ? `/${part}` : `${current}/${part}`;
    await new Promise<void>((resolve) => sftp.mkdir(current, () => resolve())); // ignore "exists"
  }
}
