// Actions agents take through connections (SSH commands and uploads, FTP uploads, git push/pull,
// GitHub and Azure DevOps APIs). Symbio runs them itself with credentials from the
// vault — agents only see results. Connections set to "ask" queue an approval for
// the human; the result is delivered to the agent as a message once approved.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bus } from "./bus.js";
import type { AzureConnection, Connection, Connections, GithubConnection, ServerConnection } from "./connections.js";
import { FTP_OPERATIONS, ftpReadOnly, ftpRun, ftpUpload, parseFtpOperations } from "./ftp.js";
import { sshExec, sshUpload } from "./ssh.js";
import { globalDir, newId, type Agent, type Project, type ProjectConnection } from "./store.js";

const run = promisify(execFile);

export type RemoteAction =
  | { kind: "remote_exec"; connectionId: string; command: string }
  | { kind: "remote_upload"; connectionId: string; localPath: string; remotePath: string }
  // repo: a repository inside the agent's folder (projects made of several repositories), or the folder itself.
  | { kind: "git_push"; connectionId: string; remote: string | null; branch: string | null; repo?: string | null }
  | { kind: "git_pull"; connectionId: string; remote: string | null; branch: string | null; repo?: string | null }
  | { kind: "github_api"; connectionId: string; method: string; path: string; body?: unknown }
  | { kind: "azure_devops_api"; connectionId: string; method: string; path: string; body?: unknown };

export interface Approval {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  connectionName: string;
  action: RemoteAction;
  /** Human-readable "what will happen". */
  summary: string;
  reason: string;
  status: "pending" | "approved" | "denied";
  note: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** Hooks into the rest of Symbio (kept narrow so this module stays testable). */
export interface RemoteHost {
  log(project: Project, m: { from: string; to: string; kind: "approval" | "remote"; text: string }): Promise<void>;
  /** Delivers a message from Symbio to the agent and wakes it. */
  notify(project: Project, agent: Agent, text: string): Promise<void>;
}

export class RemoteOps {
  private approvals = new Map<string, Approval[]>(); // projectId → approvals

  constructor(
    private readonly connections: Connections,
    private readonly host: RemoteHost,
  ) {}

  /** Connections the project may use, with their policy. */
  enabled(project: Project): { conn: Connection; link: ProjectConnection }[] {
    return project.connections
      .map((link) => ({ link, conn: this.connections.get(link.id) }))
      .filter((x): x is { conn: Connection; link: ProjectConnection } => !!x.conn);
  }

  describeFor(project: Project): string {
    const list = this.enabled(project);
    if (list.length === 0) {
      return (
        "This project has no connections. That's fine when the project has its own way (e.g. a deploy script): use it. " +
        "Only if the work needs GitHub, Azure DevOps, a server or an FTP account and the project has no access of its own, " +
        "tell the human to add one in the project's Settings (Connections)."
      );
    }
    return list
      .map(({ conn, link }) => {
        const what =
          conn.type === "github"
            ? `GitHub${conn.account ? ` account ${conn.account}` : ""} — git_push, git_pull, github_api`
            : conn.type === "azure"
              ? `Azure DevOps organization ${conn.organization}${conn.account ? ` (as ${conn.account})` : ""} — git_push, git_pull, azure_devops_api`
              : conn.type === "ftp"
                ? `FTP account ${conn.username}@${conn.host}${conn.security === "none" ? "" : " (FTPS)"} — remote_upload (replaces files that exist), and remote_exec with FTP file operations, one per line: ${FTP_OPERATIONS} (no shell commands; ls never needs approval)`
                : `server ${conn.username}@${conn.host} — remote_exec, remote_upload`;
        return `- "${conn.name}": ${what} (${link.policy === "ask" ? "each action needs the human's approval" : "allowed without approval"})`;
      })
      .join("\n");
  }

  /** Runs an action now (policy "allow", or read-only) or queues it for approval. */
  async request(project: Project, agent: Agent, action: RemoteAction, reason: string): Promise<string> {
    const { conn, link } = this.resolve(project, action.connectionId, action.kind);
    // FTP operations are checked now, so a mistake comes back at once rather than after an approval.
    if (action.kind === "remote_exec" && conn.type === "ftp") parseFtpOperations(action.command);
    const summary = this.summarize(conn, action, agent);
    const readOnly =
      ((action.kind === "github_api" || action.kind === "azure_devops_api") && action.method.toUpperCase() === "GET") ||
      (action.kind === "remote_exec" && conn.type === "ftp" && ftpReadOnly(action.command));
    if (link.policy === "allow" || readOnly) {
      return this.execute(project, agent, conn, action, summary, reason);
    }
    const approval: Approval = {
      id: newId("apr"),
      projectId: project.id,
      agentId: agent.id,
      agentName: agent.name,
      connectionName: conn.name,
      action,
      summary,
      reason,
      status: "pending",
      note: null,
      createdAt: Date.now(),
      decidedAt: null,
    };
    (await this.load(project)).push(approval);
    await this.save(project);
    await this.host.log(project, { from: agent.id, to: "human", kind: "approval", text: `${summary}\n\nWhy: ${reason}` });
    bus.publish({ type: "approvals.updated", projectId: project.id });
    return (
      `Waiting for the human's approval (${approval.id}): ${summary}. ` +
      `The result arrives as a message once they decide — continue with other work or end your turn. Don't request it again.`
    );
  }

  async list(project: Project): Promise<Approval[]> {
    return this.load(project);
  }

  async decide(project: Project, agent: Agent | undefined, approvalId: string, approved: boolean, note: string | null) {
    const approval = (await this.load(project)).find((a) => a.id === approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "pending") throw new Error(`Already ${approval.status}`);
    approval.status = approved ? "approved" : "denied";
    approval.note = note?.trim() || null;
    approval.decidedAt = Date.now();
    await this.save(project);
    bus.publish({ type: "approvals.updated", projectId: project.id });
    if (!agent) return;

    if (!approved) {
      await this.host.notify(
        project,
        agent,
        `Symbio: the human denied ${approval.summary}.${approval.note ? ` Their note: ${approval.note}` : ""}`,
      );
      return;
    }
    let result: string;
    try {
      const { conn } = this.resolve(project, approval.action.connectionId, approval.action.kind);
      result = await this.execute(project, agent, conn, approval.action, approval.summary, approval.reason);
    } catch (err) {
      result = `Failed: ${(err as Error).message}`;
    }
    await this.host.notify(
      project,
      agent,
      `Symbio: the human approved ${approval.summary}.${approval.note ? ` Their note: ${approval.note}` : ""}\n\nResult:\n${result}`,
    );
  }

  // ---------------------------------------------------------------- internals

  private resolve(project: Project, connectionRef: string, kind: RemoteAction["kind"]) {
    const ref = connectionRef.trim().toLowerCase();
    const found = this.enabled(project).find(({ conn }) => conn.id === connectionRef || conn.name.toLowerCase() === ref);
    if (!found) {
      const names = this.enabled(project).map(({ conn }) => conn.name).join(", ") || "none";
      throw new Error(`No connection "${connectionRef}" in this project. Available: ${names}.`);
    }
    const needs: Connection["type"][] = kind.startsWith("remote_")
      ? ["server", "ftp"]
      : kind === "github_api"
        ? ["github"]
        : kind === "azure_devops_api"
          ? ["azure"]
          : ["github", "azure"]; // git_push / git_pull
    if (!needs.includes(found.conn.type)) {
      const label = (t: string) => (t === "azure" ? "Azure DevOps" : t === "github" ? "GitHub" : t === "ftp" ? "FTP" : "server");
      throw new Error(`"${found.conn.name}" is a ${label(found.conn.type)} connection; ${kind} needs a ${needs.map(label).join(" or ")} connection.`);
    }
    return found;
  }

  private summarize(conn: Connection, a: RemoteAction, agent: Agent): string {
    switch (a.kind) {
      case "remote_exec":
        return `run \`${a.command}\` on ${conn.name}`;
      case "remote_upload":
        return `upload ${a.localPath} to ${conn.name}:${a.remotePath}`;
      case "git_push":
        return `git push ${a.remote ?? "origin"} ${a.branch ?? "(current branch)"} from ${a.repo ? `the ${a.repo} repository` : `${agent.name}'s workspace`} using ${conn.name}`;
      case "git_pull":
        return `git pull ${a.remote ?? "origin"} ${a.branch ?? "(current branch)"} into ${a.repo ? `the ${a.repo} repository` : `${agent.name}'s workspace`} using ${conn.name}`;
      case "github_api":
        return `GitHub API ${a.method.toUpperCase()} ${a.path} using ${conn.name}`;
      case "azure_devops_api":
        return `Azure DevOps API ${a.method.toUpperCase()} ${a.path} using ${conn.name}`;
    }
  }

  private async execute(project: Project, agent: Agent, conn: Connection, a: RemoteAction, summary: string, reason: string): Promise<string> {
    let output: string;
    let ok = true;
    try {
      output = await this.perform(agent, conn, a);
    } catch (err) {
      ok = false;
      output = `Error: ${(err as Error).message}`;
    }
    await this.host.log(project, {
      from: agent.id,
      to: "human",
      kind: "remote",
      text: `${ok ? "✓" : "✕"} ${summary}\n\nWhy: ${reason}\n\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\``,
    });
    return output;
  }

  private async perform(agent: Agent, conn: Connection, a: RemoteAction): Promise<string> {
    switch (a.kind) {
      case "remote_exec": {
        if (conn.type === "ftp") return await ftpRun(await this.connections.ftpTarget(conn), a.command);
        const res = await sshExec(await this.connections.sshTarget(conn as ServerConnection), a.command);
        const parts = [`exit code ${res.code}`];
        if (res.stdout.trim()) parts.push(`stdout:\n${res.stdout.trimEnd()}`);
        if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trimEnd()}`);
        if (res.truncated) parts.push("(output truncated)");
        return parts.join("\n");
      }
      case "remote_upload": {
        const local = insideWorkspace(agent, a.localPath);
        const count =
          conn.type === "ftp"
            ? await ftpUpload(await this.connections.ftpTarget(conn), local, a.remotePath)
            : await sshUpload(await this.connections.sshTarget(conn as ServerConnection), local, a.remotePath);
        return `Uploaded ${count} file(s) to ${a.remotePath} (skipping .git, node_modules and .symbio).`;
      }
      case "git_push":
      case "git_pull": {
        const gitConn = conn as GithubConnection | AzureConnection;
        const token = await this.connections.githubToken(gitConn);
        const remote = a.remote ?? "origin";
        const cwd = a.repo ? path.join(agent.directory, ...a.repo.split("/")) : agent.directory;
        const url = remote.startsWith("https://") ? remote : await gitOut(cwd, ["remote", "get-url", remote]);
        const auth = gitAuth(gitConn, url, token);
        const branch = a.branch ?? (await gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
        // The agent controls this repository, so its config and hooks are untrusted: a hook
        // would see the token, a proxy or URL rewrite would send it elsewhere.
        await refuseRiskyGitConfig(cwd);
        const noHooks = path.join(os.tmpdir(), `symbio-no-hooks-${randomUUID()}`); // never exists
        const safe = ["-c", `core.hooksPath=${noHooks}`, "-c", "http.proxy=", "-c", "http.sslVerify=true", "-c", "credential.helper="];
        // The token goes in an HTTP header via environment-only git config: never in
        // the command line, the repo config or the agent's view.
        const { headerKey, header } = auth;
        const git = (args: string[], withToken: boolean) =>
          run("git", [...safe, ...args], {
            cwd,
            windowsHide: true,
            timeout: 5 * 60_000,
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: "0",
              ...(withToken ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: headerKey, GIT_CONFIG_VALUE_0: header } : {}),
            },
          }).catch((err) => {
            throw new Error(scrub(String(err.stderr || err.message), token));
          });
        if (a.kind === "git_push") {
          const { stdout, stderr } = await git(["push", "--no-verify", url, `HEAD:refs/heads/${branch}`], true);
          return scrub(`${stdout}${stderr}`.trim() || "done", token);
        }
        // Pull = fetch with the token, then merge without it (merging can run filters).
        const fetched = await git(["fetch", url, branch], true);
        const merged = await git(["merge", "--no-edit", "FETCH_HEAD"], false);
        return scrub(`${fetched.stdout}${fetched.stderr}${merged.stdout}${merged.stderr}`.trim() || "done", token);
      }
      case "github_api":
      case "azure_devops_api": {
        const data =
          a.kind === "github_api"
            ? await this.connections.githubRequest(conn as GithubConnection, a.method.toUpperCase(), a.path, a.body)
            : await this.connections.azureRequest(conn as AzureConnection, a.method.toUpperCase(), a.path, a.body);
        const text = JSON.stringify(data, null, 2) ?? "(no content)";
        return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated)` : text;
      }
    }
  }

  private async load(project: Project): Promise<Approval[]> {
    let list = this.approvals.get(project.id);
    if (!list) {
      try {
        list = JSON.parse(await fs.readFile(file(project), "utf8")) as Approval[];
      } catch {
        list = [];
      }
      this.approvals.set(project.id, list);
    }
    return list;
  }

  private async save(project: Project) {
    const list = this.approvals.get(project.id) ?? [];
    await fs.mkdir(path.dirname(file(project)), { recursive: true });
    await fs.writeFile(file(project), JSON.stringify(list.slice(-500), null, 2));
  }
}

// Outside the project folder, where agents can't edit what the human is about to approve.
const file = (project: Project) => path.join(globalDir, "approvals", `${project.id}.json`);

/** Resolves a path the agent gave, refusing anything outside its own working folder. */
function insideWorkspace(agent: Agent, p: string): string {
  const abs = path.resolve(agent.directory, p);
  if (!existsSync(abs)) throw new Error(`Not found: ${p}`);
  // Compare real paths, so a symlink inside the folder can't point outside it.
  const rel = path.relative(realpathSync(agent.directory), realpathSync(abs));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Only files inside your working folder can be uploaded (${agent.directory}).`);
  return abs;
}

// Repository settings that could run code or redirect traffic while the token is in use.
const RISKY_GIT_CONFIG = [
  /^include(if)?\./,
  /\.(insteadof|pushinsteadof)$/,
  /^http\./,
  /^credential\./,
  /^core\.(hookspath|fsmonitor|sshcommand|askpass|gitproxy)$/,
  /^remote\.[^.]+\.(proxy|uploadpack|receivepack|pushurl)$/,
];

/** Refuses to use credentials in a repository whose own config could leak them. */
export async function refuseRiskyGitConfig(dir: string): Promise<void> {
  const { stdout } = await run("git", ["config", "--list", "--show-scope", "--name-only"], { cwd: dir, windowsHide: true });
  const risky = stdout
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter(([scope, key]) => (scope === "local" || scope === "worktree") && key && RISKY_GIT_CONFIG.some((re) => re.test(key.toLowerCase())))
    .map(([, key]) => key);
  if (risky.length) {
    throw new Error(
      `Refusing to use the connection's credentials: this repository's git config sets ${risky.join(", ")}, which could redirect or capture them. Remove ${risky.length > 1 ? "these settings" : "it"} (git config --unset <name>) and try again.`,
    );
  }
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, windowsHide: true }).catch(() => ({ stdout: "" }));
  return stdout.trim();
}

function scrub(text: string, secret: string): string {
  let out = text.split(secret).join("***");
  for (const user of ["x-access-token:", ":"]) out = out.split(Buffer.from(`${user}${secret}`).toString("base64")).join("***");
  return out;
}

/**
 * How to send a connection's token to a git remote, after checking the remote belongs to it:
 * a GitHub HTTPS URL for GitHub; for Azure DevOps, a dev.azure.com (or older visualstudio.com)
 * URL of the connection's own organization, so its token never goes to someone else's.
 */
export function gitAuth(conn: GithubConnection | AzureConnection, url: string, token: string): { headerKey: string; header: string } {
  if (conn.type === "github") {
    if (!/^https:\/\/github\.com\//i.test(url)) {
      throw new Error(`The remote must be a GitHub HTTPS URL (got ${url || "nothing"}). Add one with: git remote add origin https://github.com/<owner>/<repo>.git`);
    }
    return { headerKey: "http.https://github.com/.extraheader", header: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` };
  }
  const devAzure = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\//i.exec(url);
  const legacy = /^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\//i.exec(url);
  if (!devAzure && !legacy) {
    throw new Error(
      `The remote must be an Azure DevOps HTTPS URL (got ${url || "nothing"}). ` +
        (/^git@|^ssh:/i.test(url)
          ? "It's an SSH remote; switch it to HTTPS: git remote set-url origin https://dev.azure.com/<organization>/<project>/_git/<repository>"
          : "Add one with: git remote add origin https://dev.azure.com/<organization>/<project>/_git/<repository>"),
    );
  }
  const org = decodeURIComponent((devAzure ?? legacy)![1]);
  if (org.toLowerCase() !== conn.organization.toLowerCase()) {
    throw new Error(`This remote belongs to the Azure DevOps organization "${org}", but "${conn.name}" is for "${conn.organization}". Use a connection for "${org}".`);
  }
  const host = devAzure ? "https://dev.azure.com/" : `https://${legacy![1]}.visualstudio.com/`;
  return { headerKey: `http.${host}.extraheader`, header: `Authorization: Basic ${Buffer.from(`:${token}`).toString("base64")}` };
}
