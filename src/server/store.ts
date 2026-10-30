// Persistence: global config in ~/.symbio, per-project state in <project folder>/.symbio.

import { promises as fs, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type AgentRole = "coordinator" | "worker";
/** "waiting" = blocked on a question to the human (not hung; the watchdog leaves it alone). */
export type AgentStatus = "idle" | "busy" | "waiting" | "stuck" | "error" | "stopped";

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  /** What this agent is for, in the coordinator's words. */
  purpose?: string;
  sessionId: string;
  /** Working folder: the project root, or the worker's own git worktree. */
  directory: string;
  /** Worktree branch, or null when working directly in the project folder. */
  branch?: string | null;
  /** Commit the worker's current work is based on (updated after each merge). */
  base?: string | null;
  /** Start of the current unit of work; asset grants are checked from here. */
  workSince?: number;
  model: string; // provider/model
  status: AgentStatus;
  /** Why the agent can't continue on its own (e.g. every allowed model failed); null when fine. */
  problem?: string | null;
  /** Cumulative usage of the agent's current session. Cost is 0 when the model has no pricing info. */
  usage?: { cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  /** Everything used across sessions, split by model (see costs.ts). */
  usageByModel?: Record<string, NonNullable<Agent["usage"]>>;
  /** The current session's totals already counted in usageByModel. */
  usageSeen?: NonNullable<Agent["usage"]>;
  /** Usage of earlier sessions, for agents that predate usageByModel. */
  pastUsage?: NonNullable<Agent["usage"]>;
  /** Sessions this agent used before its session was renewed, oldest first. */
  previousSessions?: { sessionId: string; endedAt: number }[];
  /** Earlier names (after a rename), still accepted when other agents address it. */
  aliases?: string[];
  lastActivity: number;
  createdAt: number;
}

/** "project": AGENTS.md + docs/ committed in the folder. "private": .symbio/docs, injected into agents. */
export type DocsLocation = "project" | "private";

export interface Project {
  id: string;
  name: string;
  directory: string;
  allowedModels: string[]; // provider/model
  coordinatorModel: string;
  docsLocation: DocsLocation;
  /** Whether the folder was empty ("new") or had content ("existing") when the project was created. */
  origin: "new" | "existing";
  /** Folder summary taken at creation, given to the coordinator. */
  inspectionSummary: string;
  /** The coordinator's opening turn has been triggered. */
  kickedOff: boolean;
  /** Global connections this project may use, and whether each action needs the human's OK. */
  connections: ProjectConnection[];
  /** "Always allow" answers to agents' permission requests (e.g. shell "pip install *"). */
  allowedPatterns: { action: string; pattern: string }[];
  /** Paused by the human: working agents were interrupted and agent messages are held. */
  paused?: boolean;
  /** Messages held while paused, delivered in order on resume. */
  heldMessages?: { agentId: string; text: string }[];
  /** Agents that were working when the team was paused (told to continue on resume). */
  pausedAgents?: string[];
  /**
   * Loop guard: how many conversational messages two agents may exchange in 30 minutes
   * before further ones are refused. 0 turns the guard off. Unset = DEFAULT_MESSAGE_LIMIT.
   */
  messageLimit?: number;
  /** "after-task": helpers get a fresh session when their task is merged. Unset/"manual": only on request. */
  renewSessions?: "manual" | "after-task";
  agents: Agent[];
  createdAt: number;
}

export const DEFAULT_MESSAGE_LIMIT = 20;

export interface ProjectConnection {
  id: string;
  /** "ask": every remote action waits for the human's approval. "allow": runs directly. */
  policy: "ask" | "allow";
}

/** Fills fields added after a project was first saved. */
function migrate(p: Project): Project {
  p.connections ??= [];
  p.allowedPatterns ??= [];
  p.docsLocation ??= "project";
  p.origin ??= "existing";
  p.inspectionSummary ??= "";
  p.kickedOff ??= p.agents.length > 0;
  return p;
}

export type MessageKind =
  | "chat"
  | "info"
  | "request"
  | "blocking"
  | "needs-human"
  | "urgent"
  | "system"
  | "asset-request"
  | "asset-granted"
  | "asset-denied"
  | "asset-released"
  | "form" // an interactive question waiting in the agent's chat
  | "plan" // the coordinator proposed a plan for the human to review
  | "task-review" // a helper finished a task
  | "task-blocked" // a helper is blocked on a task
  | "alert" // Symbio needs the human to act (e.g. no working model left)
  | "approval" // an agent wants to use a connection (deploy, push…) and waits for the human
  | "remote" // a connection action that ran (audit trail)
  | "permission"; // an agent asks to do something its rules require approval for (e.g. install software)

export interface LoggedMessage {
  id: string;
  time: number;
  from: string; // agent id or "human" or "symbio"
  to: string;
  kind: MessageKind;
  text: string;
}

interface GlobalConfig {
  projects: { id: string; directory: string }[];
}

export const globalDir = process.env.SYMBIO_HOME ?? path.join(os.homedir(), ".symbio");
const globalConfigPath = path.join(globalDir, "config.json");

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function projectDataDir(directory: string) {
  return path.join(directory, ".symbio");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

export class Store {
  private projects = new Map<string, Project>();
  // Serializes writes per file so concurrent updates don't interleave.
  private writes = new Map<string, Promise<void>>();

  async load() {
    mkdirSync(globalDir, { recursive: true });
    const config = await readJson<GlobalConfig>(globalConfigPath, { projects: [] });
    for (const ref of config.projects) {
      const project = await readJson<Project | null>(path.join(projectDataDir(ref.directory), "project.json"), null);
      if (project) this.projects.set(project.id, migrate(project));
      else console.warn(`[store] project ${ref.id} missing at ${ref.directory}, skipping`);
    }
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  findAgentBySession(sessionId: string): { project: Project; agent: Agent } | undefined {
    for (const project of this.projects.values()) {
      const agent = project.agents.find((a) => a.sessionId === sessionId);
      if (agent) return { project, agent };
    }
  }

  async create(input: {
    name: string;
    directory: string;
    allowedModels: string[];
    coordinatorModel: string;
    docsLocation: DocsLocation;
    origin: "new" | "existing";
    inspectionSummary: string;
    connections?: ProjectConnection[];
  }) {
    const directory = path.resolve(input.directory);
    const existing = this.list().find((p) => samePath(p.directory, directory));
    if (existing) throw new Error(`A project already exists for ${directory} ("${existing.name}")`);
    if (!existsSync(directory)) await fs.mkdir(directory, { recursive: true });

    // Reopen a project that was registered on another machine or removed from the list.
    const onDisk = await readJson<Project | null>(path.join(projectDataDir(directory), "project.json"), null);
    const project: Project = onDisk
      ? migrate(onDisk)
      : {
          id: newId("prj"),
          name: input.name,
          directory,
          allowedModels: input.allowedModels,
          coordinatorModel: input.coordinatorModel,
          docsLocation: input.docsLocation,
          origin: input.origin,
          inspectionSummary: input.inspectionSummary,
          kickedOff: false,
          connections: input.connections ?? [],
          allowedPatterns: [],
          agents: [],
          createdAt: Date.now(),
        };
    project.directory = directory;
    this.projects.set(project.id, project);
    await this.saveProject(project);
    await this.saveGlobal();
    return project;
  }

  async update(project: Project) {
    // A project that was removed must not be written back (late status updates).
    if (!this.projects.has(project.id)) return;
    this.projects.set(project.id, project);
    await this.saveProject(project);
  }

  /**
   * Forgets a project. With `deleteData`, also deletes its .symbio folder
   * (plan, messages, assets, docs if private). The project's own files are never touched.
   */
  async remove(project: Project, deleteData: boolean) {
    this.projects.delete(project.id);
    await this.saveGlobal();
    if (deleteData) {
      const dir = projectDataDir(project.directory);
      await this.serialized(path.join(dir, "project.json"), () => fs.rm(dir, { recursive: true, force: true }));
    }
  }

  async appendMessage(project: Project, message: LoggedMessage) {
    if (!this.projects.has(project.id)) return;
    const file = path.join(projectDataDir(project.directory), "messages.jsonl");
    await this.serialized(file, () => fs.appendFile(file, JSON.stringify(message) + "\n"));
  }

  async readMessages(project: Project): Promise<LoggedMessage[]> {
    const file = path.join(projectDataDir(project.directory), "messages.jsonl");
    try {
      const text = await fs.readFile(file, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  private async saveProject(project: Project) {
    const dir = projectDataDir(project.directory);
    const file = path.join(dir, "project.json");
    await this.serialized(file, async () => {
      await writeJson(file, project);
      const ignore = path.join(dir, ".gitignore");
      if (!existsSync(ignore)) await fs.writeFile(ignore, "*\n");
    });
  }

  private async saveGlobal() {
    const config: GlobalConfig = {
      projects: this.list().map((p) => ({ id: p.id, directory: p.directory })),
    };
    await this.serialized(globalConfigPath, () => writeJson(globalConfigPath, config));
  }

  private serialized(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writes.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.writes.set(key, next);
    return next;
  }
}

function samePath(a: string, b: string) {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
