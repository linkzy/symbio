// Persistence: global config in ~/.symbio, per-project state in <project folder>/.symbio.

import { promises as fs, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "./fsutil.js";
import type { Check } from "./checks.js";
import type { RuntimeKind } from "./runtime/types.js";

export type AgentRole = "coordinator" | "worker";
/** "waiting" = blocked on a question to the human (not hung; the watchdog leaves it alone). */
export type AgentStatus = "idle" | "busy" | "waiting" | "stuck" | "error" | "stopped";

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  /** What this agent is for, in the coordinator's words. */
  purpose?: string;
  /** "human": created by the human from the team list, to work with them directly (no first task). */
  startedBy?: "human";
  sessionId: string;
  /** The runtime its session lives in (runtime/types.ts). Unset: OpenCode (agents from before there was a choice). */
  runtime?: RuntimeKind;
  /** Working folder: the project root (coordinator, shared helpers), or the helper's own git worktree. */
  directory: string;
  /**
   * In a project made of several git repositories (subfolders, see repos.ts): the one this helper
   * works in, relative to the project folder. Its worktree, merges and pushes are in that repository.
   */
  repo?: string;
  /** Worktree branch, or null when working directly in the project folder. */
  branch?: string | null;
  /** Commit the worker's current work is based on (updated after each merge). */
  base?: string | null;
  /** Start of the current unit of work; asset grants are checked from here. */
  workSince?: number;
  model: string; // provider/model
  /**
   * Pinned to its model: when the model fails, Symbio waits and retries it (modelWait) instead of
   * switching to another allowed model. Set by the human (chat header) or core (spawn_agent, pin_model).
   */
  modelPinned?: { by: "human" | "coordinator"; at: number } | null;
  /**
   * The agent's own reasoning effort level, over the project's level for its model (modelEfforts).
   * Used while its model takes that level; otherwise the model's default. Set by the human or core.
   */
  effort?: { level: string; by: "human" | "coordinator" } | null;
  /** A pinned agent waiting for its model to respond again: the next retry, which one, since when. */
  modelWait?: { until: number; attempt: number; since: number; error: string; alerted?: boolean } | null;
  status: AgentStatus;
  /** Why the agent can't continue on its own (e.g. every allowed model failed); null when fine. */
  problem?: string | null;
  /** Cumulative usage of the agent's current session. Cost is 0 when the model has no pricing info. */
  usage?: { cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  /** Everything used across sessions, split by model (see costs.ts). */
  usageByModel?: Record<string, NonNullable<Agent["usage"]>>;
  /** The current session's totals already counted in usageByModel. */
  usageSeen?: NonNullable<Agent["usage"]>;
  /** Its skills (names from the library, skills.ts); unset: core gets the project's, a helper none. */
  skills?: string[];
  /** Who set a helper's skills: core can't change the ones the human set. */
  skillsBy?: "human" | "coordinator";
  /**
   * A reviewer: a one-off helper checking another helper's task (team/verify.ts). It works in that
   * helper's folder, can't edit files, and is stopped once it gives its verdict.
   */
  reviewer?: { taskId: string; of: string; by: "coordinator" | "required"; done?: boolean };
  /** How big its current conversation is (tokens the model reads on its next step), and the model's limit when known. */
  context?: { tokens: number; limit: number | null; at: number } | null;
  /** Usage of earlier sessions, for agents that predate usageByModel. */
  pastUsage?: NonNullable<Agent["usage"]>;
  /**
   * Sessions this agent used before its session was renewed, oldest first. `runtime`: where that
   * session lives, when it isn't the agent's runtime now (the project switched runtimes since).
   */
  previousSessions?: { sessionId: string; endedAt: number; runtime?: RuntimeKind }[];
  /** Sub-agent sessions it started, with the totals already counted (see costs.ts). */
  childSessions?: Record<string, { model: string; seen: NonNullable<Agent["usage"]> }>;
  /** Earlier names (after a rename), still accepted when other agents address it. */
  aliases?: string[];
  lastActivity: number;
  /** When its current turn of work began (while busy), so core can tell a long task from a stuck one. */
  busySince?: number | null;
  createdAt: number;
}

/** "project": AGENTS.md + docs/ committed in the folder. "private": .symbio/docs, injected into agents. */
export type DocsLocation = "project" | "private";

export type Depth = "light" | "thorough";
export type StartChoice = "go" | "brainstorm" | "briefing" | "grill";
export interface StartOffer {
  /** What core understood and what it would do, in its words (markdown, short). */
  summary: string;
  at: number;
}

export interface Project {
  id: string;
  name: string;
  directory: string;
  allowedModels: string[]; // provider/model
  coordinatorModel: string;
  /**
   * The agent runtime new agents run on: "opencode" (unset) or "copilot" (GitHub Copilot CLI).
   * Models are the runtime's own; agents keep the runtime they were created on.
   */
  runtime?: RuntimeKind;
  /**
   * Which allowed models core may use (the crowns in the model picker); unset: all of them.
   * coordinatorModel is the one it runs on now.
   */
  coreModels?: string[];
  /** Allowed models only core may use (the locks): helpers never get them. */
  coreOnlyModels?: string[];
  /** Reasoning effort level per model ("low", "high"…, as the model lists them); a model not here uses its default. */
  modelEfforts?: Record<string, string>;
  /**
   * Whether agents may add `Co-authored-by` lines naming the AI to their commits. Off (unset) by
   * default: they're told not to, and GitHub Copilot CLI is configured not to.
   */
  aiCoauthors?: boolean;
  docsLocation: DocsLocation;
  /** Whether the folder was empty ("new") or had content ("existing") when the project was created. */
  origin: "new" | "existing";
  /** Folder summary taken at creation, given to the coordinator. */
  inspectionSummary: string;
  /** The coordinator's opening turn has been triggered. */
  kickedOff: boolean;
  /** Global connections this project may use, and whether each action needs the human's OK. */
  connections: ProjectConnection[];
  /** Agents allowed to use a connection without asking for now (see ConnectionGrant). */
  connectionGrants?: ConnectionGrant[];
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
  /** core's skills (unset: Symbio's defaults, DEFAULT_CORE_SKILLS). */
  coreSkills?: string[];
  /** Skills core may give helpers (unset: every skill in the library). */
  helperSkills?: string[];
  /** "after-task": helpers get a fresh session when their task is merged (or, without a branch, marked done). Unset/"manual": only on request. */
  renewSessions?: "manual" | "after-task";
  /**
   * Where new helpers work in a git project. "own": their own worktree and branch (parallel
   * edits, merged by the coordinator). "shared": the project folder itself, so what one writes
   * the next sees at once (pipelines). Unset = "own". Projects without git always share.
   */
  helperWorkspace?: HelperWorkspace;
  /**
   * The project folder is a repository created over other repositories (older Symbio versions did
   * this): work in those inner repositories instead, and leave the outer one alone. Nothing on disk
   * changes. Unset = never decided (see repos.ts, the sub_repositories tool).
   */
  subRepositories?: boolean;
  /**
   * How core handles the human's messages (the selector in its chat box). "plan": discuss and plan
   * only, with starting work blocked by Symbio; "act": get it done without a plan to approve.
   * Unset = "auto" (core decides).
   */
  coreMode?: CoreMode;
  /**
   * Who reviews the team's work. "core" (unset): core does, nothing waits on the human. "every":
   * every finished task waits for the human's approval before it's done; "marked": only the tasks
   * marked in the plan. See team/review.ts.
   */
  reviewBy?: ReviewBy;
  /** Keep a rules register (rules.json next to the docs, shown in the Docs tab). Unset = off. */
  rulesRegister?: boolean;
  /**
   * How much core decides on its own. "ask" (unset): it asks the human and waits. "decide": it
   * decides what it can undo, says so, and keeps going; the human can change any decision later.
   */
  autonomy?: Autonomy;
  /** How core questions the human about a feature: a briefing (unset) or grilling (rounds until nothing is open). */
  questionStyle?: "briefing" | "grill";
  /**
   * How much process core puts around the work. "light" (new projects): core understands the request,
   * offers how to start (go ahead, brainstorm, briefing, grilling) and goes ahead by default; specs,
   * the glossary and documentation come only when the work calls for them. "thorough" (unset, as
   * projects created before 0.39 worked): core works from specs, keeps a glossary and documentation
   * from the start.
   */
  depth?: Depth;
  /**
   * core offered how to start (offer_start) and waits for the human's pick: shown above core's chat
   * box with the choices. When the project lets core decide, Symbio goes ahead on its own after
   * START_OFFER_WAIT_MS (team/start-offer.ts).
   */
  startOffer?: StartOffer;
  /** What the team may do without asking (spending, deploying, deleting…), in the human's words; every agent gets it. */
  standingPermissions?: string;
  /** Installing software (pip, npm -g, winget…) without asking the human first. Unset = ask. */
  allowInstalls?: boolean;
  /** Which notifications the project sends (notifier.ts): everything (unset), only what waits on the human, or none. */
  notify?: NotifyLevel;
  /** Spending limits (team/budget.ts), in USD of estimated cost. Unset: no limit. */
  budget?: Budget;
  /** Where the project stands against its budget: today's start, the warnings given, the limits the human went past. */
  budgetState?: BudgetState;
  /** Commands Symbio runs itself when a helper reports a task and before its work is merged (checks.ts). */
  checks?: Check[];
  /**
   * Every reported task gets a reviewer (a one-off helper) before core sees it. Unset/false: core
   * decides when one is worth it (request_review). See team/verify.ts.
   */
  requireReviewer?: boolean;
  /** At most this many helpers at a time (not counting one-off reviewers); unset: no limit. The human sets it to spend less. */
  maxHelpers?: number;
  /** Agent-facing Symbio updates (updates.ts) the coordinator has been told about. */
  updatesSeen?: string[];
  /** When the daily housekeeping check last ran (and told the human/coordinator). */
  housekeptAt?: number;
  agents: Agent[];
  createdAt: number;
}

export const DEFAULT_MESSAGE_LIMIT = 20;

export type HelperWorkspace = "own" | "shared";

export type CoreMode = "auto" | "plan" | "act";

export type ReviewBy = "core" | "every" | "marked";

export type Autonomy = "ask" | "decide";

export type NotifyLevel = "all" | "important" | "off";

export interface Budget {
  /** For the whole project. */
  total?: number;
  /** Per day (the computer's local day). */
  daily?: number;
  /** Warn (the human and core) at this share of a limit, in percent. Unset: 80. */
  warnAt?: number;
}

export interface BudgetState {
  /**
   * The local day ("2026-11-25"), and the tokens used per model when it began: today's spending is
   * the tokens since, at today's prices (a price set later doesn't turn past use into today's).
   */
  day: string;
  dayTokens: Record<string, { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number }>;
  /** Limits already warned about or reached ("total:10", "daily:2026-11-25:5"): each is said once. */
  warned: string[];
  reached: string[];
  /** Limits the human resumed past: they don't pause the team again. */
  overridden: string[];
  /** The team is paused because of this limit (resumed by the human, or by a new day). */
  pausedFor?: "total" | "daily";
}

export interface ProjectConnection {
  id: string;
  /** "ask": every remote action waits for the human's approval. "allow": runs directly. */
  policy: "ask" | "allow";
  /**
   * Server commands that run without asking even under "ask" ("systemctl status *"): plain commands
   * only, no chaining or redirects (remote.ts commandAllowed). Added from an approval or in settings.
   */
  allowedCommands?: string[];
}

/** The human let an agent use a connection without asking, for a while (or until they stop it, or pause the team). */
export interface ConnectionGrant {
  connectionId: string;
  agentId: string;
  /** Until when (ms); null: until the human stops it. */
  until: number | null;
  at: number;
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
  | "needs-human" // (before 0.12) a question for the human, sent as a message
  | "question" // an agent added a question to the human's open questions (team/questions.ts)
  | "file" // an agent shared a file with the human (share_file, files.ts)
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
  | "job" // a scheduled job: proposed, scheduled, a run's result (team/schedules.ts)
  | "budget" // a project's spending: a warning, or the team paused at a limit (team/budget.ts)
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
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
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
    rulesRegister?: boolean;
    runtime?: RuntimeKind;
    depth?: Depth;
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
          rulesRegister: input.rulesRegister,
          ...(input.runtime && input.runtime !== "opencode" ? { runtime: input.runtime } : {}),
          origin: input.origin,
          inspectionSummary: input.inspectionSummary,
          kickedOff: false,
          connections: input.connections ?? [],
          allowedPatterns: [],
          // Helpers start each task from a clean conversation; what carries over is in documents.
          renewSessions: "after-task",
          // New projects run on their own: core decides what it can undo, and the human can change it.
          autonomy: "decide",
          // And light: the process grows with the work, instead of up front (Project.depth).
          depth: input.depth ?? "light",
          agents: [],
          createdAt: Date.now(),
        };
    project.directory = directory;
    // A reopened project keeps its history and team, but takes the options just chosen in the
    // dialog that have no history behind them.
    if (onDisk && input.rulesRegister !== undefined) project.rulesRegister = input.rulesRegister;
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

/**
 * The models an agent may use, in the project's order: core the crowned ones (all allowed when
 * none are set, as before), helpers every allowed model except the core-only ones. Never empty.
 */
export function modelsFor(project: Pick<Project, "allowedModels" | "coreModels" | "coreOnlyModels">, role: Agent["role"]): string[] {
  const allowed = project.allowedModels;
  const coreOnly = new Set((project.coreOnlyModels ?? []).filter((m) => allowed.includes(m)));
  if (role === "coordinator") {
    if (!project.coreModels?.length) return allowed;
    const core = allowed.filter((m) => project.coreModels!.includes(m) || coreOnly.has(m));
    return core.length ? core : allowed;
  }
  const helpers = allowed.filter((m) => !coreOnly.has(m));
  return helpers.length ? helpers : allowed;
}

/** The model an agent of this role starts on: core's current one when it may use it, else its first. */
export function defaultModel(project: Pick<Project, "allowedModels" | "coreModels" | "coreOnlyModels" | "coordinatorModel">, role: Agent["role"]): string {
  const list = modelsFor(project, role);
  return list.includes(project.coordinatorModel) ? project.coordinatorModel : list[0];
}
