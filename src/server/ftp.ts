// FTP and FTPS for FTP connections: uploads only (FTP can't run commands). Runs inside the
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
