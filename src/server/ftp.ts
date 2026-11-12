// FTP and FTPS for FTP connections: uploads and file operations (FTP has no shell). Runs inside the
// Symbio process with the password from the vault; agents only see results.

import { Client } from "basic-ftp";
import { promises as fs } from "node:fs";
import path from "node:path";

export type FtpSecurity = "explicit" | "implicit" | "none";

export interface FtpTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  /** "explicit": FTPS via AUTH TLS (the usual), "implicit": FTPS from the start (port 990), "none": plain FTP. */
  security: FtpSecurity;
  /** Accept a certificate that doesn't verify (self-signed, or issued for the hosting company's name). */
  acceptAnyCertificate: boolean;
}

/** Folders never uploaded: version control, dependencies, Symbio's own files (as with SSH uploads). */
export const SKIPPED = new Set([".git", "node_modules", ".symbio"]);

async function connect(target: FtpTarget, timeoutMs = 30_000): Promise<Client> {
  const client = new Client(timeoutMs);
  try {
    await client.access({
      host: target.host,
      port: target.port,
      user: target.username,
      password: target.password,
      secure: target.security === "none" ? false : target.security === "implicit" ? "implicit" : true,
      secureOptions: { rejectUnauthorized: !target.acceptAnyCertificate, servername: target.host },
    });
    return client;
  } catch (err) {
    client.close();
    throw new Error(friendly(err as Error, target));
  }
}

/** Signs in and lists the starting folder: what Settings' Test shows. */
export async function ftpCheck(target: FtpTarget): Promise<string> {
  const client = await connect(target);
  try {
    const home = await client.pwd();
    const entries = await client.list();
    return `Connected${target.security === "none" ? " (unencrypted)" : " over TLS"}: ${home} (${entries.length} item(s))`;
  } finally {
    client.close();
  }
}

// FTP has no shell: remote_exec on an FTP connection runs these file operations instead.
export const FTP_OPERATIONS = "ls [path], mkdir <path>, rm <file>, rmdir <folder> (with everything in it), mv <from> <to>";

export interface FtpOperation {
  op: "ls" | "mkdir" | "rm" | "rmdir" | "mv";
  args: string[];
}

/** Parses FTP operations, one per line; paths with spaces go in quotes. Throws on anything else. */
export function parseFtpOperations(script: string): FtpOperation[] {
  const counts: Record<FtpOperation["op"], [number, number]> = { ls: [0, 1], mkdir: [1, 1], rm: [1, 1], rmdir: [1, 1], mv: [2, 2] };
  const ops: FtpOperation[] = [];
  for (const raw of script.split(/\r?\n|;|&&/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const words = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const op = words[0].toLowerCase() as FtpOperation["op"];
    const args = words.slice(1).filter((w) => !/^-[a-z]+$/i.test(w)); // tolerate "rm -r", "ls -la"
    const count = counts[op];
    if (!count) throw new Error(`"${words[0]}" isn't an FTP operation. An FTP connection can do: ${FTP_OPERATIONS}; and upload with remote_upload.`);
    if (args.length < count[0] || args.length > count[1]) throw new Error(`Usage: ${FTP_OPERATIONS.split(", ").find((u) => u.startsWith(op))}`);
    ops.push({ op, args });
  }
  if (ops.length === 0) throw new Error(`No FTP operation given. An FTP connection can do: ${FTP_OPERATIONS}.`);
  return ops;
}

/** Only listing: runs without the human's approval, like read-only API calls. */
export const ftpReadOnly = (script: string) => {
  try {
    return parseFtpOperations(script).every((o) => o.op === "ls");
  } catch {
    return false;
  }
};

/** Runs FTP operations in order, stopping at the first failure. Returns a report of each. */
export async function ftpRun(target: FtpTarget, script: string): Promise<string> {
  const ops = parseFtpOperations(script);
  const client = await connect(target, 5 * 60_000);
  const out: string[] = [];
  try {
    const home = await client.pwd();
    const absolute = (p = ".") => {
      const rel = p.replace(/^~\/?/, "");
      return rel.startsWith("/") ? path.posix.normalize(rel) : path.posix.join(home, rel || ".");
    };
    for (const { op, args } of ops) {
      const label = `${op} ${args.join(" ")}`.trim();
      try {
        if (op === "ls") {
          const list = await client.list(absolute(args[0]));
          const lines = list.map((e) => `${e.isDirectory ? "d" : "-"} ${String(e.size).padStart(10)}  ${e.name}${e.isDirectory ? "/" : ""}`);
          out.push(`$ ${label}\n${lines.join("\n") || "(empty)"}`);
        } else if (op === "mkdir") {
          await client.ensureDir(absolute(args[0]));
          out.push(`$ ${label}\nok`);
        } else if (op === "rm") {
          await client.remove(absolute(args[0]));
          out.push(`$ ${label}\nok`);
        } else if (op === "rmdir") {
          const dir = absolute(args[0]);
          if (dir === "/" || dir === home) throw new Error("Refusing to remove the account's top folder.");
          await client.removeDir(dir);
          out.push(`$ ${label}\nok`);
        } else {
          await client.rename(absolute(args[0]), absolute(args[1]));
          out.push(`$ ${label}\nok`);
        }
      } catch (err) {
        out.push(`$ ${label}\nfailed: ${friendly(err as Error, target)}`);
        if (ops.length > 1) out.push("(stopped here; the operations after it didn't run)");
        break;
      }
    }
    return out.join("\n\n");
  } finally {
    client.close();
  }
}

/** Uploads a local file or folder (recursively) to a remote path. Returns the number of files. */
export async function ftpUpload(target: FtpTarget, localPath: string, remotePath: string): Promise<number> {
  const client = await connect(target, 5 * 60_000);
  try {
    // Relative paths are relative to where the account starts; "~" means the same.
    const home = await client.pwd();
    const rel = remotePath.replace(/^~\/?/, "");
    const absolute = (p: string) => (p.startsWith("/") ? p : path.posix.join(home, p || "."));
    const stat = await fs.stat(localPath);
    if (stat.isFile()) {
      const target = absolute(rel);
      await client.ensureDir(path.posix.dirname(target));
      await client.uploadFrom(localPath, target);
      return 1;
    }
    let count = 0;
    const walk = async (dir: string, remote: string) => {
      await client.ensureDir(remote);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name)) continue;
        const local = path.join(dir, entry.name);
        const target = path.posix.join(remote, entry.name);
        if (entry.isDirectory()) await walk(local, target);
        else if (entry.isFile()) {
          await client.uploadFrom(local, target);
          count++;
        }
      }
    };
    await walk(localPath, absolute(rel));
    return count;
  } catch (err) {
    throw new Error(friendly(err as Error, target));
  } finally {
    client.close();
  }
}

/** The usual FTP failures, said so the human knows what to change in Settings. */
function friendly(err: Error, target: FtpTarget): string {
  const m = err.message || String(err);
  if (/^530/.test(m)) return `The server refused the user or password (${m.trim()}).`;
  if (/certificate|self[- ]signed|altnames|unable to verify/i.test(m)) {
    return `The server's TLS certificate doesn't verify (${m.trim()}). If it's your hosting provider's certificate, tick "Accept the server's certificate as it is" in the connection.`;
  }
  if (/AUTH|534|TLS not available|SSL/i.test(m) && target.security === "explicit") {
    return `The server doesn't offer FTPS (${m.trim()}). Try "Implicit FTPS", or "Plain FTP" if the hosting only has that.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|Timeout/i.test(m)) return `Can't reach ${target.host}:${target.port} (${m.trim()}).`;
  return m;
}
