// Global connections (set once in Settings, used by any project): GitHub accounts,
// Azure DevOps organizations and servers reachable over SSH. Public details live in
// ~/.symbio/connections.json; secrets live in the encrypted vault and are never
// returned by the API.

import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretVault } from "./secrets.js";
import { sshExec, type SshTarget } from "./ssh.js";
import { globalDir, newId } from "./store.js";
import { replaceFile } from "./fsutil.js";

export type ConnectionType = "github" | "azure" | "server";

export interface ConnectionTest {
  ok: boolean;
  message: string;
  time: number;
}

interface Base {
  id: string;
  type: ConnectionType;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastTest: ConnectionTest | null;
}

export interface GithubConnection extends Base {
  type: "github";
  /** GitHub login the token belongs to (filled by Test). */
  account: string | null;
}

export interface ServerConnection extends Base {
  type: "server";
  host: string;
  port: number;
  username: string;
  auth: "key" | "password";
  /** Path to a private key file on this machine (instead of storing the key in the vault). */
  keyPath: string | null;
  /** The server's host key fingerprint, pinned on first connection; cleared when the connection is edited. */
  hostKey?: string | null;
}

export interface AzureConnection extends Base {
  type: "azure";
  /** The organization, as in https://dev.azure.com/<organization>. */
  organization: string;
  /** Display name of the token's owner (filled by Test). */
  account: string | null;
}

export type Connection = GithubConnection | AzureConnection | ServerConnection;

/** Organization from what people paste: "org", https://dev.azure.com/org/…, https://org.visualstudio.com/…. */
export function azureOrganization(value: string): string {
  const v = value.trim();
  const m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)/i.exec(v) ?? /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com/i.exec(v);
  return decodeURIComponent(m ? m[1] : v.replace(/\/+$/, ""));
}

/** What the browser sees: public fields plus which secrets are stored. */
export type ConnectionView = Connection & { secrets: Record<string, boolean> };

export interface ConnectionInput {
  type?: ConnectionType;
  name?: string;
  // github, azure
  token?: string;
  // azure
  organization?: string;
  // server
  host?: string;
  port?: number;
  username?: string;
  auth?: "key" | "password";
  keyPath?: string | null;
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

const SECRET_FIELDS: Record<ConnectionType, string[]> = {
  github: ["token"],
  azure: ["token"],
  server: ["privateKey", "passphrase", "password"],
};

export class Connections {
  private list: Connection[] = [];
  private readonly file = path.join(globalDir, "connections.json");
  readonly vault = SecretVault.at(globalDir);

  async load() {
    try {
      this.list = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  get(id: string): Connection | undefined {
    return this.list.find((c) => c.id === id);
  }

  async views(): Promise<ConnectionView[]> {
    return Promise.all(this.list.map((c) => this.view(c)));
  }

  async view(c: Connection): Promise<ConnectionView> {
    const secrets: Record<string, boolean> = {};
    for (const f of SECRET_FIELDS[c.type]) secrets[f] = await this.vault.has(`${c.id}:${f}`);
    return { ...c, secrets };
  }

  async create(input: ConnectionInput): Promise<Connection> {
    if (input.type !== "github" && input.type !== "azure" && input.type !== "server") throw new Error("type must be github, azure or server");
    const now = Date.now();
    const base = { id: newId("con"), name: "", createdAt: now, updatedAt: now, lastTest: null };
    const conn: Connection =
      input.type === "github"
        ? { ...base, type: "github", account: null }
        : input.type === "azure"
          ? { ...base, type: "azure", organization: "", account: null }
          : { ...base, type: "server", host: "", port: 22, username: "", auth: "key", keyPath: null };
    this.apply(conn, input);
    if (!conn.name) throw new Error("Give the connection a name.");
    this.validate(conn);
    try {
      await this.storeSecrets(conn, input);
    } catch (err) {
      await this.vault.deletePrefix(`${conn.id}:`);
      throw err;
    }
    this.list.push(conn);
    await this.save();
    return conn;
  }

  async update(id: string, input: ConnectionInput): Promise<Connection> {
    const conn = this.get(id);
    if (!conn) throw new Error("Connection not found");
    this.apply(conn, input);
    this.validate(conn);
    await this.storeSecrets(conn, input);
    conn.updatedAt = Date.now();
    conn.lastTest = null;
    // Saving the connection is how the human says "trust this server's (new) key".
    if (conn.type === "server") conn.hostKey = null;
    await this.save();
    return conn;
  }

  async remove(id: string) {
    this.list = this.list.filter((c) => c.id !== id);
    await this.vault.deletePrefix(`${id}:`);
    await this.save();
  }

  /** Checks the connection works, with the stored credentials. */
  async test(id: string): Promise<ConnectionTest> {
    const conn = this.get(id);
    if (!conn) throw new Error("Connection not found");
    let result: ConnectionTest;
    try {
      if (conn.type === "github") {
        const user = await this.githubRequest(conn, "GET", "/user");
        conn.account = user.login;
        result = { ok: true, message: `Signed in as ${user.login}${user.name ? ` (${user.name})` : ""}`, time: Date.now() };
      } else if (conn.type === "azure") {
        const data = await this.azureRequest(conn, "GET", "_apis/connectionData", undefined, "7.1-preview");
        const user = data?.authenticatedUser;
        conn.account = user?.providerDisplayName ?? user?.customDisplayName ?? null;
        const projects = await this.azureRequest(conn, "GET", "_apis/projects").catch(() => null);
        const count = Array.isArray(projects?.value) ? ` — ${projects.value.length} project(s) visible` : "";
        result = { ok: true, message: `Signed in to ${conn.organization}${conn.account ? ` as ${conn.account}` : ""}${count}`, time: Date.now() };
      } else {
        const res = await sshExec(await this.sshTarget(conn), "uname -srm 2>/dev/null || ver", 30_000);
        const out = (res.stdout || res.stderr).trim().split("\n")[0];
        result = { ok: res.code === 0, message: res.code === 0 ? `Connected — ${out}` : `Connected, but the test command failed: ${out}`, time: Date.now() };
      }
    } catch (err) {
      result = { ok: false, message: (err as Error).message, time: Date.now() };
    }
    conn.lastTest = result;
    await this.save();
    return result;
  }

  /** SSH credentials for a server connection (server-side use only). */
  async sshTarget(conn: ServerConnection): Promise<SshTarget> {
    const target: SshTarget = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      hostKey: conn.hostKey ?? null,
      onFirstHostKey: async (fp) => {
        conn.hostKey = fp;
        await this.save();
      },
    };
    if (conn.auth === "password") {
      target.password = await this.vault.get(`${conn.id}:password`);
      if (!target.password) throw new Error(`No password stored for "${conn.name}".`);
    } else {
      target.privateKey = conn.keyPath ? readKeyFile(conn.keyPath) : await this.vault.get(`${conn.id}:privateKey`);
      if (!target.privateKey) throw new Error(`No private key for "${conn.name}".`);
      target.passphrase = await this.vault.get(`${conn.id}:passphrase`);
    }
    return target;
  }

  /** Calls the Azure DevOps REST API of the connection's organization with its token. */
  async azureRequest(conn: AzureConnection, method: string, apiPath: string, body?: unknown, apiVersion = "7.1"): Promise<any> {
    const rel = apiPath.trim().replace(/^\/+/, "");
    if (/^[a-z]+:/i.test(rel)) throw new Error("Give a path inside the organization (e.g. MyProject/_apis/git/repositories), not a full URL.");
    const url = new URL(`https://dev.azure.com/${encodeURIComponent(conn.organization)}/${rel}`);
    if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", apiVersion);
    const token = await this.githubToken(conn);
    const res = await fetch(url, {
      method,
      redirect: "manual", // a sign-in redirect means the token was refused
      headers: {
        authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        accept: "application/json",
        "user-agent": "symbio",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // A rejected token gets a sign-in page (203 or a redirect) rather than a 401.
    const html = /^\s*</.test(text) || (res.headers.get("content-type") ?? "").includes("text/html");
    if (res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400) || (html && res.ok)) {
      throw new Error(`Azure DevOps rejected the token for "${conn.organization}" (expired, revoked, or without access to this organization?)`);
    }
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (data as any)?.message ?? res.statusText;
      throw new Error(`Azure DevOps ${res.status}: ${msg}`);
    }
    return data;
  }

  /** The stored token of a GitHub or Azure DevOps connection. */
  async githubToken(conn: GithubConnection | AzureConnection): Promise<string> {
    const token = await this.vault.get(`${conn.id}:token`);
    if (!token) throw new Error(`No token stored for "${conn.name}".`);
    return token;
  }

  /** Calls the GitHub REST API with the connection's token. */
  async githubRequest(conn: GithubConnection, method: string, apiPath: string, body?: unknown): Promise<any> {
    const res = await fetch(`https://api.github.com${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.githubToken(conn)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "symbio",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (data as any)?.message ?? res.statusText;
      throw new Error(res.status === 401 ? "GitHub rejected the token (expired or revoked?)" : `GitHub ${res.status}: ${msg}`);
    }
    return data;
  }

  private apply(conn: Connection, input: ConnectionInput) {
    if (input.name !== undefined) conn.name = input.name.trim();
    if (conn.type === "azure" && input.organization !== undefined) conn.organization = azureOrganization(input.organization);
    if (conn.type === "server") {
      if (input.host !== undefined) conn.host = input.host.trim();
      if (input.port !== undefined) conn.port = Number(input.port) || 22;
      if (input.username !== undefined) conn.username = input.username.trim();
      if (input.auth !== undefined) conn.auth = input.auth === "password" ? "password" : "key";
      if (input.keyPath !== undefined) conn.keyPath = input.keyPath?.trim() ? expandHome(input.keyPath.trim()) : null;
    }
  }

  private validate(conn: Connection) {
    if (conn.type === "azure" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(conn.organization)) {
      throw new Error("Give the organization, e.g. \"contoso\" or https://dev.azure.com/contoso.");
    }
    if (conn.type === "server") {
      if (!conn.host) throw new Error("Host is required.");
      if (!conn.username) throw new Error("User is required.");
      if (conn.keyPath) readKeyFile(conn.keyPath); // fail early on a wrong path
    }
  }

  /** Stores the secrets present in the input; empty/missing ones keep their stored value. */
  private async storeSecrets(conn: Connection, input: ConnectionInput) {
    for (const field of SECRET_FIELDS[conn.type]) {
      const value = (input as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) await this.vault.set(`${conn.id}:${field}`, value.trim());
    }
    if ((conn.type === "github" || conn.type === "azure") && !(await this.vault.has(`${conn.id}:token`))) throw new Error("The token is required.");
    if (conn.type === "server") {
      if (conn.auth === "password" && !(await this.vault.has(`${conn.id}:password`))) throw new Error("The password is required.");
      if (conn.auth === "key" && !conn.keyPath && !(await this.vault.has(`${conn.id}:privateKey`))) {
        throw new Error("Paste the private key, or give the path to the key file.");
      }
    }
  }

  private async save() {
    await fs.mkdir(globalDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.list, null, 2));
    await replaceFile(tmp, this.file);
  }
}

function expandHome(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function readKeyFile(p: string): string {
  try {
    return readFileSync(expandHome(p), "utf8");
  } catch {
    throw new Error(`Can't read the key file ${p}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
