// Agents: creating them, delivering messages between them, the shared-asset
// protocol, merging work, and recovering from hangs (watchdog), opencode crashes
// (runtime restarts) and failing providers (model fallback).

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AssetRegister } from "./assets.js";
import { AGENT_PERMISSIONS, wildcardMatch } from "./guard.js";
import { bus } from "./bus.js";
import { privateDocsInstruction } from "./docs.js";
import type { McpResolver } from "./mcp.js";
import { parseModel, type OpencodeClient, type OpencodeEvent } from "./opencode/client.js";
import type { OpencodeRuntime } from "./opencode/runtime.js";
import { PlanStore, type TaskInput, type TaskStatus } from "./plan.js";
import type { RemoteOps } from "./remote.js";
import { coordinatorBrief, kickoffMessage, workerBrief } from "./prompts.js";
import { git } from "./git.js";
import { globalDir, newId, type Agent, type LoggedMessage, type MessageKind, type Project, type Store } from "./store.js";
import { coordinatorTools, workerTools, type ToolContext } from "./tools.js";
import { changedFiles, createWorkspace, mergeWorkspace, removeWorkspace, restoreWorkspace, syncWorkspace } from "./workspaces.js";

const STUCK_AFTER_MS = Number(process.env.SYMBIO_STUCK_MINUTES ?? 10) * 60_000;
const WATCHDOG_INTERVAL_MS = 30_000;
// Loop guard: max agent-to-agent messages between the same pair in the window.
const PAIR_LIMIT = 12;
const PAIR_WINDOW_MS = 30 * 60_000;
// Model fallback: a failed model is skipped for this long; switch after this many provider retries.
const FAILED_MODEL_COOLDOWN_MS = 30 * 60_000;
const RETRIES_BEFORE_FALLBACK = 4;
const RETRIES_BEFORE_FALLBACK_ON_TIMEOUT = 2;
// Memory recycling of the OpenCode process (MB), checked every minute.
const MEMORY_SOFT_MB = Number(process.env.SYMBIO_RECYCLE_MB ?? 1500);
const MEMORY_HARD_MB = Number(process.env.SYMBIO_RECYCLE_HARD_MB ?? 3000);
const MEMORY_CHECK_MS = Number(process.env.SYMBIO_MEMORY_CHECK_SECONDS ?? 60) * 1000;

// Session events forwarded to the browser for live views.
const STREAMED = new Set([
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.tool.error",
  "session.step.started",
  "session.step.ended",
  "session.usage.updated",
  "session.execution.started",
]);

// OpenCode's built-in interactive question tool (answered through session forms).
const QUESTION_TOOLS = new Set(["question"]);

const active = (a: Agent) => a.status !== "stopped";

export class Team {
  private watchdog: NodeJS.Timeout | null = null;
  private recycler: NodeJS.Timeout | null = null;
  private recycling = false;
  private lastRecycle = 0;
  /** Last private-docs text sent to each agent, to avoid re-sending unchanged docs. */
  private docsSynced = new Map<string, string>();
  private registers = new Map<string, Promise<AssetRegister>>();
  private plans = new Map<string, Promise<PlanStore>>();
  /** MCP URL token → which project/folder it serves. Valid for this run only. */
  private mcpTokens = new Map<string, { projectId: string; directory: string }>();
  private pairTraffic = new Map<string, number[]>();
  private failedModels = new Map<string, Map<string, number>>(); // agentId → model → failedAt
  private fallbackBusy = new Set<string>();
  /** agentId → tool call id of an open interactive question. */
  private pendingQuestion = new Map<string, string>();
  /** Connection actions (SSH, git, GitHub API) and their approvals. Set at startup. */
  remote!: RemoteOps;
  /** Set when Symbio itself is shutting down on purpose. */
  shuttingDown = false;
  private usageTimers = new Map<string, NodeJS.Timeout>();
  /** Open OpenCode permission requests, by request id. */
  private permissions = new Map<string, PendingPermission>();
  /** Agents to wake once OpenCode is running again, and why they stopped. */
  private interrupted = new Map<string, { reason: string; wasWaiting: boolean }>();
  /** agentId → agent-to-agent messages queued in OpenCode's inbox, not yet delivered (inboxID → text). */
  private inbox = new Map<string, Map<string, string>>();

  constructor(
    private readonly store: Store,
    private readonly runtime: OpencodeRuntime,
    private readonly mcpBaseUrl: string,
  ) {
    runtime.on("event", (e) => this.onEvent(e));
    runtime.on("state", (state) => {
      // Open permission requests die with the OpenCode process.
      if (state === "crashed" || state === "stopped") this.permissions.clear();
      if (state === "crashed") this.markInterrupted("the OpenCode runtime crashed and was restarted");
      else if (state === "stopped") this.markInterrupted("the OpenCode runtime was restarted");
      // Tool registrations and briefs live in the OpenCode process; push them whenever it
      // (re)starts, then wake whoever was interrupted.
      else if (state === "running") void this.refreshAll().then(() => this.recoverInterrupted());
    });
  }

  startWatchdog() {
    this.watchdog ??= setInterval(() => void this.checkStuck(), WATCHDOG_INTERVAL_MS);
    this.recycler ??= setInterval(() => void this.checkMemory(), MEMORY_CHECK_MS);
  }

  /**
   * OpenCode's memory grows over long sessions until it crashes. Restart it before
   * that: above the soft limit only when every agent is idle (nobody notices);
   * above the hard limit regardless (interrupted agents are told to continue).
   */
  private async checkMemory() {
    if (this.runtime.state !== "running" || this.recycling) return;
    const bytes = await this.runtime.memoryUsage();
    if (!bytes) return;
    const mb = Math.round(bytes / 1024 / 1024);
    const everyoneIdle = this.store
      .list()
      .every((p) => p.agents.every((a) => a.status === "idle" || a.status === "stopped" || a.status === "error"));
    const quiet = everyoneIdle && this.permissions.size === 0 && this.pendingQuestion.size === 0;
    // Quiet restarts at most every 10 minutes, in case the limit is set below OpenCode's baseline.
    const softAllowed = Date.now() - this.lastRecycle > 10 * 60_000;
    const reason = mb >= MEMORY_HARD_MB ? "hard" : mb >= MEMORY_SOFT_MB && quiet && softAllowed ? "soft" : null;
    if (!reason) return;
    this.recycling = true;
    this.lastRecycle = Date.now();
    console.warn(`[recycle] OpenCode uses ${mb} MB (${reason} limit) — restarting it`);
    try {
      await this.runtime.restart(); // stopped → markInterrupted; running → refreshAll → recover
      for (const project of this.store.list().filter((p) => p.agents.some((a) => a.status !== "stopped"))) {
        await this.log(project, {
          from: "symbio",
          to: "human",
          kind: "system",
          text:
            reason === "soft"
              ? `Restarted OpenCode while everyone was idle to free memory (it was using ${mb} MB).`
              : `OpenCode was using ${mb} MB, close to crashing, so it was restarted. Agents that were working were told to continue.`,
        });
      }
    } catch (err) {
      console.error("[recycle] restart failed:", (err as Error).message);
    } finally {
      this.recycling = false;
    }
  }

  stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.recycler) clearInterval(this.recycler);
    this.watchdog = null;
    this.recycler = null;
  }

  // ---------------------------------------------------------------- lookups

  findAgent(project: Project, name: string): Agent | undefined {
    const key = name.trim().toLowerCase();
    // "coordinator" (and "core") always reach the lead agent, whatever it is called.
    if (key === "coordinator" || key === "core") return this.coordinator(project);
    return project.agents.find((a) => a.name.toLowerCase() === key && active(a));
  }

  agentName(project: Project, agentId: string): string | undefined {
    return project.agents.find((a) => a.id === agentId)?.name;
  }

  coordinator(project: Project): Agent | undefined {
    return project.agents.find((a) => a.role === "coordinator");
  }

  assets(project: Project): Promise<AssetRegister> {
    let reg = this.registers.get(project.id);
    if (!reg) {
      reg = AssetRegister.load(project.directory);
      this.registers.set(project.id, reg);
    }
    return reg;
  }

  assetsChanged(project: Project) {
    bus.publish({ type: "assets.updated", projectId: project.id });
  }

  plan(project: Project): Promise<PlanStore> {
    let plan = this.plans.get(project.id);
    if (!plan) {
      plan = PlanStore.load(project.directory);
      this.plans.set(project.id, plan);
    }
    return plan;
  }

  private planChanged(project: Project) {
    bus.publish({ type: "plan.updated", projectId: project.id });
  }

  // ---------------------------------------------------------------- plan

  async submitPlan(project: Project, coordinator: Agent, goal: string, tasks: TaskInput[]): Promise<string> {
    const store = await this.plan(project);
    const plan = await store.propose(goal, tasks);
    this.planChanged(project);
    await this.log(project, {
      from: coordinator.id,
      to: "human",
      kind: "plan",
      text: `Proposed a plan (revision ${plan.revision}, ${plan.tasks.length} tasks) — review it in the Plan tab.\n\n**Goal:** ${plan.goal}`,
    });
    return (
      `Plan submitted (revision ${plan.revision}): ${plan.tasks.map((t) => t.id).join(", ")}. ` +
      `The human reviews it in Symbio's Plan tab; their decision arrives as a message. ` +
      `Don't start assigning work until it is approved. Tell the human briefly that the plan is ready for review.`
    );
  }

  async decidePlan(project: Project, approved: boolean, feedback: string | null) {
    const store = await this.plan(project);
    const plan = await store.decide(approved, feedback);
    this.planChanged(project);
    const coordinator = this.coordinator(project);
    if (!coordinator) return;
    const text = approved
      ? `✅ I approved the plan (revision ${plan.revision}).${feedback ? ` Note: ${feedback}` : ""} Assign the tasks to helpers.`
      : `✏️ I'd like changes to the plan (revision ${plan.revision}): ${feedback ?? "(no details)"}\nRevise it and submit it again.`;
    await this.sendFromHuman(project, coordinator, text);
  }

  async addTask(project: Project, input: TaskInput): Promise<string> {
    const store = await this.plan(project);
    const task = await store.addTask(input);
    this.planChanged(project);
    return `Added ${task.id}: ${task.title}.`;
  }

  /** Gives a task to a helper: marks it in progress and sends the helper the task. */
  async assignTask(project: Project, coordinator: Agent, taskId: string, helper: Agent, extra?: string): Promise<string> {
    if (helper.role === "coordinator") {
      throw new Error("Tasks are done by helpers, not the coordinator. Assign it to a helper (spawn one if needed).");
    }
    const store = await this.plan(project);
    if (store.plan.status === "proposed" || store.plan.status === "changes-requested") {
      throw new Error("The plan isn't approved yet. Wait for the human's approval before assigning work.");
    }
    const task = store.task(taskId);
    const open = store.openDependencies(task);
    if (open.length) {
      throw new Error(`${task.id} depends on unfinished task(s): ${open.map((t) => `${t.id} (${t.status})`).join(", ")}.`);
    }
    await store.update(task.id, { assignee: helper.id, status: "in-progress", note: { by: coordinator.name, text: `assigned to ${helper.name}` } });
    this.planChanged(project);
    const assets = task.assets.length ? `\nShared assets involved: ${task.assets.join(", ")} — request them before changing them.` : "";
    await this.deliver(
      project,
      coordinator,
      helper,
      "request",
      `Task ${task.id}: ${task.title}\n\n${task.description}${assets}${extra ? `\n\n${extra}` : ""}\n\n` +
        `When it's done, commit your work and call update_task("${task.id}", "review", <summary>) — that is your report. ` +
        `If you get stuck, update_task("${task.id}", "blocked", <why>).`,
    );
    return `Assigned ${task.id} to ${helper.name}.`;
  }

  async updateTask(project: Project, agent: Agent, taskId: string, status: TaskStatus | undefined, note: string | undefined): Promise<string> {
    const store = await this.plan(project);
    const task = store.task(taskId);
    if (agent.role !== "coordinator" && task.assignee !== agent.id) {
      throw new Error(`${task.id} isn't assigned to you. Ask the coordinator.`);
    }
    await store.update(task.id, { status, note: note ? { by: agent.name, text: note } : undefined });
    this.planChanged(project);

    // A helper's review/blocked update is its report to the coordinator.
    const coordinator = this.coordinator(project);
    if (coordinator && agent.role !== "coordinator" && (status === "review" || status === "blocked")) {
      await this.deliver(
        project,
        agent,
        coordinator,
        status === "review" ? "task-review" : "task-blocked",
        `${task.id} "${task.title}" → ${status}${note ? `: ${note}` : ""}` +
          (status === "review" && agent.branch ? `\nMerge with merge_work("${agent.name}") when it looks right.` : ""),
      );
      return `${task.id} is now ${status}. The coordinator has been notified — no separate report needed.`;
    }
    return `${task.id} is now ${task.status}.`;
  }

  /** Resolves MCP callers: the token says which folder, the session says which agent. */
  mcpResolver: McpResolver<ToolContext> = (token, sessionId) => {
    const target = this.mcpTokens.get(token);
    if (!target) return null;
    const project = this.store.get(target.projectId);
    if (!project) return null;
    if (sessionId) {
      const agent = project.agents.find((a) => a.sessionId === sessionId && active(a));
      if (!agent) return { ctx: null as any, tools: [] };
      return { ctx: { team: this, project, agent }, tools: agent.role === "coordinator" ? coordinatorTools : workerTools };
    }
    // Tool listing has no session (and happens at registration, possibly before the agent
    // exists). The coordinator always works in the project root, so that folder gets the
    // full set; calls are still checked against the caller's role.
    const isProjectRoot = target.directory === project.directory;
    return { ctx: null as any, tools: isProjectRoot ? coordinatorTools : workerTools };
  };

  // ---------------------------------------------------------------- agents

  async ensureCoordinator(project: Project): Promise<Agent> {
    const existing = this.coordinator(project);
    if (existing) return existing;

    const client = this.client();
    await this.registerTools(project, project.directory);
    const session = await client.createSession({
      title: `${project.name} · core`,
      directory: project.directory,
      model: parseModel(project.coordinatorModel),
      permissions: AGENT_PERMISSIONS,
    });

    const agent: Agent = {
      id: newId("agt"),
      name: "core",
      role: "coordinator",
      sessionId: session.id,
      directory: project.directory,
      branch: null,
      model: project.coordinatorModel,
      status: "idle",
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    await this.refreshInstructions(project, agent);
    project.agents.push(agent);
    await this.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });

    if (!project.kickedOff) {
      project.kickedOff = true;
      await this.store.update(project);
      await this.system(project, agent, kickoffMessage(project));
    }
    return agent;
  }

  async spawnWorker(
    project: Project,
    coordinator: Agent,
    opts: { name: string; purpose: string; task?: string; taskId?: string; model?: string },
  ): Promise<string> {
    if (!opts.task && !opts.taskId) throw new Error("Give the helper a task: a plan task_id, or a task description.");
    if (opts.taskId) {
      // Validate before creating anything.
      const store = await this.plan(project);
      const task = store.task(opts.taskId);
      if (store.plan.status === "proposed" || store.plan.status === "changes-requested") {
        throw new Error("The plan isn't approved yet. Wait for the human's approval before assigning work.");
      }
      const open = store.openDependencies(task);
      if (open.length) throw new Error(`${task.id} depends on unfinished task(s): ${open.map((t) => t.id).join(", ")}.`);
    }
    const name = opts.name.trim().toLowerCase().replace(/\s+/g, "-");
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
      throw new Error("Use a short name with letters, digits and dashes (e.g. 'researcher').");
    }
    if (name === "core" || name === "coordinator" || name === "human" || project.agents.some((a) => a.name === name)) {
      throw new Error(`The name "${name}" is taken. Choose another.`);
    }
    const model = opts.model?.trim() || coordinator.model;
    if (!project.allowedModels.includes(model)) {
      throw new Error(`Model "${model}" is not allowed for this project. Allowed: ${project.allowedModels.join(", ")}`);
    }

    const workspace = await createWorkspace(project, name);
    const client = this.client();
    await this.registerTools(project, workspace.directory);
    const session = await client.createSession({
      title: `${project.name} · ${name}`,
      directory: workspace.directory,
      model: parseModel(model),
      permissions: AGENT_PERMISSIONS,
    });
    const agent: Agent = {
      id: newId("agt"),
      name,
      role: "worker",
      purpose: opts.purpose,
      sessionId: session.id,
      directory: workspace.directory,
      branch: workspace.branch,
      base: workspace.base,
      workSince: Date.now(),
      model,
      status: "idle",
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    project.agents.push(agent);
    await this.store.update(project);
    await this.refreshInstructions(project, agent);
    bus.publish({ type: "project.updated", projectId: project.id });

    if (opts.taskId) await this.assignTask(project, coordinator, opts.taskId, agent, opts.task);
    else await this.deliver(project, coordinator, agent, "request", opts.task!);
    const where = workspace.branch
      ? `It works in its own copy of the project on branch ${workspace.branch} (${workspace.directory}); merge its work with merge_work.`
      : "It works directly in the project folder (no git), so rely on shared-asset grants to avoid conflicts.";
    return [`Created ${name} on ${model} and sent it the task. ${where}`, workspace.warning].filter(Boolean).join("\n");
  }

  async stopAgent(project: Project, agent: Agent, reason: string): Promise<string> {
    await this.client()
      .interrupt(agent.sessionId)
      .catch(() => {});
    const reg = await this.assets(project);
    await reg.forget(agent.id);
    this.assetsChanged(project);
    // Helpers have their own folder; the project root is shared, so leave its processes alone.
    if (agent.directory !== project.directory) await this.stopAllProcesses(agent);
    const { committed, uncommitted } = await changedFiles(agent);
    const unmerged = committed.length > 0 || uncommitted.length > 0;
    if (!unmerged) await removeWorkspace(project, agent);
    agent.status = "stopped";
    await this.store.update(project);
    const plan = await this.plan(project);
    for (const task of plan.plan.tasks.filter((t) => t.assignee === agent.id && t.status !== "done")) {
      await plan.update(task.id, { assignee: null, status: "todo", note: { by: "symbio", text: `${agent.name} was stopped` } });
    }
    this.planChanged(project);
    await this.log(project, { from: "symbio", to: "human", kind: "system", text: `${agent.name} stopped: ${reason}` });
    bus.publish({ type: "project.updated", projectId: project.id });
    return unmerged
      ? `Stopped ${agent.name}. Its workspace still has unmerged work (branch ${agent.branch}); it was kept.`
      : `Stopped ${agent.name}.`;
  }

  /**
   * Brings a stopped helper back on its existing session (it keeps its memory).
   * Its tasks were unassigned when it stopped, so core is told it's available.
   */
  async restartAgent(project: Project, agent: Agent): Promise<void> {
    if (agent.status !== "stopped") throw new Error(`${agent.name} isn't stopped.`);
    if (agent.role === "coordinator") throw new Error("core can't be restarted this way.");
    const workspace = await restoreWorkspace(project, agent);
    if (workspace.reset) {
      agent.base = workspace.base;
      agent.workSince = Date.now();
    }
    await this.registerTools(project, agent.directory);
    if (!project.allowedModels.includes(agent.model)) await this.setModel(project, agent, project.coordinatorModel);
    agent.status = "idle";
    agent.problem = null;
    agent.lastActivity = Date.now();
    await this.store.update(project);
    await this.refreshInstructions(project, agent);
    await this.log(project, { from: "symbio", to: "human", kind: "system", text: `${agent.name} restarted by the human` });
    bus.publish({ type: "project.updated", projectId: project.id });

    const folder = workspace.reset
      ? ` Your workspace was recreated from the project's current state (branch ${agent.branch}).`
      : agent.branch
        ? " Your workspace and its unmerged work are as you left them."
        : "";
    await this.system(
      project,
      agent,
      `Symbio: the human restarted you after you were stopped. Your tasks were unassigned when you stopped, so wait for core to give you work.${folder}`,
      false,
    );
    const coordinator = this.coordinator(project);
    if (coordinator) {
      await this.system(
        project,
        coordinator,
        `Symbio: the human restarted ${agent.name} (${agent.model}). It is idle and has no task; assign it work when it fits the plan.`,
      );
    }
  }

  async mergeWork(project: Project, agent: Agent, force: boolean): Promise<string> {
    const { committed, uncommitted } = await changedFiles(agent);
    const reg = await this.assets(project);
    const violations = reg.violations([...committed, ...uncommitted], agent.id, agent.workSince ?? agent.createdAt);
    if (violations.length && !force) {
      const list = violations.map((v) => `- "${v.asset.name}": ${v.files.join(", ")}`).join("\n");
      return `Not merged: ${agent.name} changed shared assets it was not granted:\n${list}\nReview the changes, then grant the asset and merge again, ask ${agent.name} to revert them, or merge with force=true.`;
    }
    const result = await mergeWorkspace(project, agent);
    if (!result.ok) return `Not merged: ${result.reason}${result.files?.length ? `\nFiles: ${result.files.join(", ")}` : ""}`;

    agent.base = await syncWorkspace(project, agent);
    agent.workSince = Date.now();
    await this.store.update(project);

    // Merged work completes the helper's tasks that were waiting for review.
    const plan = await this.plan(project);
    const completed: string[] = [];
    for (const task of plan.plan.tasks.filter((t) => t.assignee === agent.id && t.status === "review")) {
      await plan.update(task.id, { status: "done", note: { by: "symbio", text: "merged" } });
      completed.push(task.id);
    }
    if (completed.length) this.planChanged(project);
    await this.system(
      project,
      agent,
      "Symbio: your committed work was merged into the project, and your workspace now includes the latest project state.",
      false,
    );
    return (
      `${result.summary}\n${result.files.map((f) => `- ${f}`).join("\n")}` +
      (completed.length ? `\nMarked done: ${completed.join(", ")}.` : "")
    );
  }

  // ---------------------------------------------------------------- messages

  /**
   * Delivers a message to an agent: logs it, and prompts the agent's session.
   * Delivery wakes the agent; if it is busy, OpenCode queues it.
   */
  async deliver(project: Project, from: Agent, to: Agent, kind: MessageKind, text: string) {
    if (to.status === "stopped") throw new Error(`${to.name} is stopped.`);
    this.guardLoop(from, to);
    await this.log(project, { from: from.id, to: to.id, kind, text });
    await this.prepare(project, to);
    const body = `[from: ${from.name} · ${kind}]\n${text}`;
    if (project.paused) {
      await this.hold(project, to, body);
      return;
    }
    const res = await this.client().prompt(to.sessionId, body, kind === "urgent" ? "steer" : "queue");
    // Track it until OpenCode delivers it, so it can be handed over mid-turn (see takeInbox).
    const inboxId: string | undefined = res?.data?.id;
    if (inboxId && kind !== "urgent") {
      if (!this.inbox.has(to.id)) this.inbox.set(to.id, new Map());
      this.inbox.get(to.id)!.set(inboxId, body);
    }
    this.setStatus(project, to, "busy");
  }

  /**
   * Messages from other agents that are still waiting in the agent's OpenCode inbox
   * (it is mid-turn). They are cancelled there and returned, so the agent can see them
   * now — in the result of whatever Symbio tool it is calling — instead of after its
   * turn, and they aren't delivered twice.
   */
  async takeInbox(agent: Agent): Promise<string[]> {
    const pending = this.inbox.get(agent.id);
    if (!pending?.size) return [];
    const client = this.client();
    // Re-check against OpenCode right before taking them, to keep the race window tiny.
    const res = await client.request("GET", `/api/session/${agent.sessionId}/inbox`).catch(() => null);
    const stillQueued = new Set<string>((res?.data ?? []).map((i: any) => i.id));
    const taken: string[] = [];
    for (const [id, body] of pending) {
      pending.delete(id);
      if (!stillQueued.has(id)) continue; // already delivered (or about to be)
      const ok = await client.request("DELETE", `/api/session/${agent.sessionId}/inbox/${id}`).then(
        () => true,
        () => false,
      );
      if (ok) taken.push(body);
    }
    return taken;
  }

  async sendFromHuman(project: Project, agent: Agent, text: string, urgent = false) {
    await this.log(project, { from: "human", to: agent.id, kind: urgent ? "urgent" : "chat", text });
    await this.prepare(project, agent);
    // The coordinator talks with the human directly; for helpers, say who is speaking.
    const body = agent.role === "coordinator" ? text : `[from: human · ${urgent ? "urgent" : "chat"}]\n${text}`;
    await this.client().prompt(agent.sessionId, body, urgent ? "steer" : "queue");
    this.setStatus(project, agent, "busy");
  }

  async askHuman(project: Project, from: Agent, question: string) {
    await this.log(project, { from: from.id, to: "human", kind: "needs-human", text: question });
  }

  // ---------------------------------------------------------------- shared assets

  async requestAsset(project: Project, agent: Agent, assetName: string, reason: string): Promise<string> {
    const reg = await this.assets(project);
    const { asset, alreadyHeld } = await reg.request(assetName, agent.id, reason);
    if (alreadyHeld) return `You already hold "${asset.name}".`;
    this.assetsChanged(project);
    const coordinator = this.coordinator(project);
    if (!coordinator) throw new Error("This project has no coordinator.");
    const holder = asset.holder ? this.agentName(project, asset.holder) : null;
    const waiting = asset.queue.map((q) => this.agentName(project, q.agentId)).join(", ");
    await this.deliver(
      project,
      agent,
      coordinator,
      "asset-request",
      `${agent.name} requests the shared asset "${asset.name}": ${reason}\n` +
        `Currently held by: ${holder ?? "nobody (you)"}. Waiting: ${waiting}.\n` +
        `Answer with grant_asset or deny_asset.`,
    );
    return (
      `Request sent to the coordinator. Do NOT change "${asset.name}" until you receive a grant. ` +
      `Continue with other work — the answer will show up in the result of your next Symbio tool call ` +
      `(or call check_messages) — or end your turn and it will wake you. Don't ask for it again.`
    );
  }

  async grantAsset(project: Project, coordinator: Agent, to: Agent, assetName: string, note?: string): Promise<string> {
    const reg = await this.assets(project);
    const asset = await reg.grant(assetName, to.id, note);
    this.assetsChanged(project);
    if (to.id !== coordinator.id) {
      await this.deliver(
        project,
        coordinator,
        to,
        "asset-granted",
        `You may now change the shared asset "${asset.name}".${note ? ` ${note}` : ""}\nCall release_asset when you are done.`,
      );
    }
    return `Granted "${asset.name}" to ${to.name}.`;
  }

  async denyAsset(project: Project, coordinator: Agent, to: Agent, assetName: string, reason: string): Promise<string> {
    const reg = await this.assets(project);
    const asset = await reg.deny(assetName, to.id, reason);
    this.assetsChanged(project);
    await this.deliver(project, coordinator, to, "asset-denied", `Your request for "${asset.name}" was denied: ${reason}`);
    return `Denied "${asset.name}" to ${to.name}.`;
  }

  async releaseAsset(project: Project, agent: Agent, assetName: string, summary: string): Promise<string> {
    const reg = await this.assets(project);
    const asset = await reg.release(assetName, agent.id, summary);
    this.assetsChanged(project);
    const coordinator = this.coordinator(project);
    if (coordinator && coordinator.id !== agent.id) {
      const waiting = asset.queue.map((q) => this.agentName(project, q.agentId)).join(", ");
      await this.deliver(
        project,
        agent,
        coordinator,
        "asset-released",
        `${agent.name} released "${asset.name}": ${summary}${waiting ? `\nStill waiting for it: ${waiting}.` : ""}`,
      );
    }
    return `Released "${asset.name}".`;
  }

  /**
   * Wakes agents that stopped because every allowed model failed: after the human
   * added models (or with `forgetFailures`, when they want to retry the same ones).
   */
  async resumeStuck(project: Project, forgetFailures: boolean): Promise<string[]> {
    const resumed: string[] = [];
    const now = Date.now();
    for (const agent of project.agents.filter((a) => a.problem && active(a))) {
      const failed = this.failedModels.get(agent.id) ?? new Map<string, number>();
      if (forgetFailures) failed.clear();
      const usable = (m: string) => !(failed.has(m) && now - failed.get(m)! < FAILED_MODEL_COOLDOWN_MS);
      const model = usable(agent.model) && project.allowedModels.includes(agent.model)
        ? agent.model
        : project.allowedModels.find(usable);
      if (!model) continue;
      agent.problem = null;
      if (model !== agent.model) await this.setModel(project, agent, model);
      await this.store.update(project);
      await this.system(project, agent, `Symbio: models are available again (you're on ${model}). Continue where you left off.`);
      resumed.push(agent.name);
    }
    if (resumed.length) bus.publish({ type: "project.updated", projectId: project.id });
    return resumed;
  }

  /**
   * Stops a project's agents, their processes and workspaces, and forgets the
   * project. With `deleteData`, also deletes its agent conversations and Symbio
   * data. Branches the helpers created stay in the repository.
   */
  async removeProject(project: Project, deleteData: boolean): Promise<void> {
    const client = this.runtime.client;
    for (const agent of project.agents) {
      if (client) {
        await client.interrupt(agent.sessionId).catch(() => {});
        if (agent.directory !== project.directory) await this.stopAllProcesses(agent).catch(() => {});
      }
      if (agent.branch) await removeWorkspace(project, agent).catch(() => {});
      if (deleteData && client) await client.request("DELETE", `/api/session/${agent.sessionId}`).catch(() => {});
      this.interrupted.delete(agent.id);
      this.inbox.delete(agent.id);
    }
    if (project.agents.some((a) => a.branch)) {
      await fs.rm(path.join(globalDir, "worktrees", project.id), { recursive: true, force: true }).catch(() => {});
      await git(project.directory, "worktree", "prune").catch(() => {});
    }
    this.registers.delete(project.id);
    this.plans.delete(project.id);
    for (const [token, t] of this.mcpTokens) if (t.projectId === project.id) this.mcpTokens.delete(token);
    await this.store.remove(project, deleteData);
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  // ---------------------------------------------------------------- permission requests

  /** Open OpenCode permission requests (e.g. "may I run pip install …?") for a project. */
  permissionRequests(project: Project): PendingPermission[] {
    return [...this.permissions.values()].filter((p) => p.projectId === project.id);
  }

  private async onPermissionAsked(project: Project, agent: Agent, req: any) {
    const action = String(req.action ?? "");
    const resources: string[] = Array.isArray(req.resources) ? req.resources.map(String) : [];
    // Already answered "always" for this kind of request in this project?
    const allowed = resources.length > 0 && resources.every((r) => project.allowedPatterns.some((a) => a.action === action && wildcardMatch(a.pattern, r)));
    if (allowed) {
      await this.client()
        .request("POST", `/api/session/${agent.sessionId}/permission/${req.id}/reply`, { decision: "once" })
        .catch(() => {});
      await this.log(project, { from: "symbio", to: "human", kind: "system", text: `Allowed ${agent.name} to ${action} \`${resources.join("; ")}\` (you chose “always” for this before).` });
      return;
    }
    this.permissions.set(req.id, {
      id: req.id,
      projectId: project.id,
      agentId: agent.id,
      agentName: agent.name,
      action,
      resources,
      save: Array.isArray(req.save) ? req.save.map(String) : [],
      time: Date.now(),
    });
    this.setStatus(project, agent, "waiting");
    await this.log(project, {
      from: agent.id,
      to: "human",
      kind: "permission",
      text: `${agent.name} asks to ${action}: \`${resources.join("; ")}\``,
    });
    bus.publish({ type: "approvals.updated", projectId: project.id });
  }

  /** The human's answer to a permission request. "always" also remembers the pattern for this project. */
  async answerPermission(project: Project, requestId: string, decision: "once" | "always" | "reject", note?: string) {
    const pending = this.permissions.get(requestId);
    if (!pending || pending.projectId !== project.id) throw new Error("That request is no longer open.");
    const agent = project.agents.find((a) => a.id === pending.agentId);
    if (!agent) throw new Error("Agent not found");
    if (decision === "always") {
      for (const pattern of pending.save.length ? pending.save : pending.resources) {
        if (!project.allowedPatterns.some((a) => a.action === pending.action && a.pattern === pattern)) {
          project.allowedPatterns.push({ action: pending.action, pattern });
        }
      }
      await this.store.update(project);
      bus.publish({ type: "project.updated", projectId: project.id });
    }
    await this.client().request("POST", `/api/session/${agent.sessionId}/permission/${requestId}/reply`, {
      // "always" is remembered by Symbio (per project); OpenCode only needs to let this one through.
      decision: decision === "reject" ? "reject" : "once",
      message: note?.trim() || (decision === "reject" ? "The human denied this." : null),
    });
    this.permissions.delete(requestId);
    bus.publish({ type: "approvals.updated", projectId: project.id });
  }

  // ---------------------------------------------------------------- pause / resume

  /** Stops the team from spending: interrupts working agents and holds messages between them. */
  async pause(project: Project): Promise<void> {
    if (project.paused) return;
    project.paused = true;
    project.pausedAgents = [];
    const client = this.client();
    for (const agent of project.agents) {
      if (agent.status !== "busy" && agent.status !== "stuck" && agent.status !== "waiting") continue;
      project.pausedAgents.push(agent.id);
      await client.interrupt(agent.sessionId).catch(() => {});
      this.setStatus(project, agent, "idle");
    }
    await this.store.update(project);
    await this.log(project, {
      from: "symbio",
      to: "human",
      kind: "system",
      text: `Team paused — ${project.pausedAgents.length} working agent(s) interrupted. Messages between agents are held until you resume.`,
    });
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  /** Delivers held messages and tells interrupted agents to continue. */
  async resume(project: Project): Promise<void> {
    if (!project.paused) return;
    project.paused = false;
    const held = project.heldMessages ?? [];
    const interrupted = project.pausedAgents ?? [];
    project.heldMessages = [];
    project.pausedAgents = [];
    await this.store.update(project);
    const client = this.client();
    const woken = new Set<string>();
    for (const m of held) {
      const agent = project.agents.find((a) => a.id === m.agentId && active(a));
      if (!agent) continue;
      await this.ensureTools(project, agent.directory);
      await client.prompt(agent.sessionId, m.text, "queue").catch((err) => console.error("[resume]", err.message));
      this.setStatus(project, agent, "busy");
      woken.add(agent.id);
    }
    for (const id of interrupted) {
      const agent = project.agents.find((a) => a.id === id && active(a));
      if (!agent || woken.has(id)) continue;
      await this.system(
        project,
        agent,
        "Symbio: the human paused the team while you were working and has resumed it. Check where you were and continue your task.",
      );
    }
    await this.log(project, { from: "symbio", to: "human", kind: "system", text: `Team resumed — ${held.length} held message(s) delivered.` });
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  private async hold(project: Project, agent: Agent, text: string) {
    project.heldMessages = [...(project.heldMessages ?? []), { agentId: agent.id, text }];
    await this.store.update(project);
  }

  // ---------------------------------------------------------------- usage

  /** Reads the agent's cumulative token/cost totals from its OpenCode session. */
  private async refreshUsage(project: Project, agent: Agent) {
    const res = await this.client()
      .request("GET", `/api/session/${agent.sessionId}`)
      .catch(() => null);
    const s = res?.data ?? res;
    if (!s?.tokens) return;
    agent.usage = {
      cost: Number(s.cost) || 0,
      input: s.tokens.input ?? 0,
      output: s.tokens.output ?? 0,
      reasoning: s.tokens.reasoning ?? 0,
      cacheRead: s.tokens.cache?.read ?? 0,
      cacheWrite: s.tokens.cache?.write ?? 0,
    };
    await this.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  /** Usage events come in bursts; read the totals at most every few seconds per agent. */
  private scheduleUsage(project: Project, agent: Agent) {
    if (this.usageTimers.has(agent.id)) return;
    this.usageTimers.set(
      agent.id,
      setTimeout(() => {
        this.usageTimers.delete(agent.id);
        void this.refreshUsage(project, agent);
      }, 3000),
    );
  }

  // ---------------------------------------------------------------- processes

  /** Background shells running in the agent's working folder. */
  async listProcesses(agent: Agent): Promise<string> {
    const shells = (await this.client().shells(agent.directory)).filter((s) => s.status === "running");
    if (shells.length === 0) return "You have no background processes running.";
    return shells
      .map((s) => `- ${s.id}: ${s.command} (pid ${s.pid ?? "?"}, started ${new Date(s.time.started).toLocaleTimeString()})`)
      .join("\n");
  }

  /** Stops one background shell — only ones started in the agent's own working folder. */
  async stopProcess(agent: Agent, shellId: string): Promise<string> {
    const shells = await this.client().shells(agent.directory);
    const shell = shells.find((s) => s.id === shellId.trim());
    if (!shell) {
      throw new Error(`No background process "${shellId}" in your folder. Use list_processes to see yours.`);
    }
    if (shell.status !== "running") return `${shell.id} already ${shell.status}.`;
    await this.client().stopShell(agent.directory, shell.id);
    return `Stopped ${shell.id} (${shell.command}).`;
  }

  /** Stops every background shell an agent left running (used when the agent is stopped). */
  private async stopAllProcesses(agent: Agent) {
    const shells = await this.client()
      .shells(agent.directory)
      .catch(() => []);
    for (const s of shells.filter((s: any) => s.status === "running")) {
      await this.client()
        .stopShell(agent.directory, s.id)
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------- misc agent ops

  async interrupt(project: Project, agent: Agent) {
    await this.client().interrupt(agent.sessionId);
    this.setStatus(project, agent, "idle");
  }

  async setModel(project: Project, agent: Agent, model: string) {
    await this.client().switchModel(agent.sessionId, parseModel(model));
    agent.model = model;
    if (agent.role === "coordinator") project.coordinatorModel = model;
    await this.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  history(agent: Agent) {
    return this.client().messages(agent.sessionId);
  }

  /** Open interactive questions (OpenCode forms) the agent is waiting on. */
  async forms(agent: Agent): Promise<any[]> {
    const res = await this.client().request("GET", `/api/session/${agent.sessionId}/form`);
    return res?.data ?? [];
  }

  async answerForm(project: Project, agent: Agent, formId: string, answer: Record<string, unknown>, summary: string) {
    await this.client().request("POST", `/api/session/${agent.sessionId}/form/${formId}/reply`, { answer });
    // Logged as a human reply, which also closes the question in the Messages tab.
    await this.log(project, { from: "human", to: agent.id, kind: "chat", text: summary });
  }

  /** Re-sends an agent's brief and private docs (both live in session instruction entries). */
  async refreshInstructions(project: Project, agent: Agent) {
    const connections = this.remote?.describeFor(project) ?? "";
    const brief =
      agent.role === "coordinator"
        ? coordinatorBrief(project, connections)
        : workerBrief(project, agent, this.coordinator(project)?.name ?? "coordinator", connections);
    const client = this.client();
    await client.setInstruction(agent.sessionId, "symbio-role", brief);
    // Also covers sessions created before the guard existed.
    await client.setPermissions(agent.sessionId, AGENT_PERMISSIONS);
    this.docsSynced.delete(agent.id);
    await this.syncPrivateDocs(project, agent);
  }

  // ---------------------------------------------------------------- internals

  private client(): OpencodeClient {
    const client = this.runtime.client;
    if (!client) throw new Error(`OpenCode is not running (${this.runtime.state})`);
    return client;
  }

  /** Registers Symbio's MCP tool server for a working folder (in-memory in OpenCode). */
  private async registerTools(project: Project, directory: string) {
    let token = [...this.mcpTokens.entries()].find(
      ([, t]) => t.projectId === project.id && t.directory === directory,
    )?.[0];
    if (!token) {
      token = randomBytes(18).toString("base64url");
      this.mcpTokens.set(token, { projectId: project.id, directory });
    }
    await this.client().request(
      "PUT",
      `/api/experimental/mcp/symbio?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      { config: { type: "remote", url: `${this.mcpBaseUrl}/mcp/${token}` } },
    );
  }

  /**
   * OpenCode unloads a folder after a while idle, which also drops our tool server
   * (registrations are in memory). Re-register before waking an agent if it's gone.
   */
  private async ensureTools(project: Project, directory: string) {
    const res = await this.client()
      .request<{ data?: { name: string; status?: { status?: string } }[] }>(
        "GET",
        `/api/mcp?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      )
      .catch(() => null);
    if (res?.data?.some((s) => s.name === "symbio" && s.status?.status === "connected")) return;
    await this.registerTools(project, directory).catch((err) =>
      console.error(`[team] could not register tools for ${project.name} (${directory}):`, err.message),
    );
  }

  /** Before starting an agent's turn: make sure its tools and private docs are in place. */
  private async prepare(project: Project, agent: Agent) {
    await this.ensureTools(project, agent.directory);
    await this.syncPrivateDocs(project, agent);
  }

  private async refreshAll() {
    for (const project of this.store.list()) {
      const dirs = new Set(project.agents.filter(active).map((a) => a.directory));
      for (const dir of dirs) {
        await this.registerTools(project, dir).catch((err) =>
          console.error(`[team] could not register tools for ${project.name} (${dir}):`, err.message),
        );
      }
      for (const agent of project.agents.filter(active)) {
        await this.refreshInstructions(project, agent).catch((err) =>
          console.error(`[team] could not refresh instructions for ${project.name}/${agent.name}:`, err.message),
        );
      }
      // Usage totals (also for stopped agents, so project totals stay complete).
      for (const agent of project.agents.filter((a) => !a.usage || active(a))) {
        await this.refreshUsage(project, agent).catch(() => {});
      }
    }
  }

  /** Private docs aren't visible to OpenCode on its own; inject them, but only when they changed. */
  private async syncPrivateDocs(project: Project, agent: Agent) {
    const text = await privateDocsInstruction(project);
    if (this.docsSynced.get(agent.id) === (text ?? "")) return;
    const client = this.client();
    if (text) await client.setInstruction(agent.sessionId, "symbio-docs", text);
    else await client.removeInstruction(agent.sessionId, "symbio-docs").catch(() => {});
    this.docsSynced.set(agent.id, text ?? "");
  }

  /** Stops two agents from bouncing messages forever without the human noticing. */
  private guardLoop(from: Agent, to: Agent) {
    const key = [from.id, to.id].sort().join("|");
    const now = Date.now();
    const times = (this.pairTraffic.get(key) ?? []).filter((t) => now - t < PAIR_WINDOW_MS);
    if (times.length >= PAIR_LIMIT) {
      throw new Error(
        `Too many messages between ${from.name} and ${to.name} in the last 30 minutes. ` +
          `Stop the back-and-forth and use ask_human to bring the human in.`,
      );
    }
    times.push(now);
    this.pairTraffic.set(key, times);
  }

  private onEvent(e: OpencodeEvent) {
    const sessionId: string | undefined = e.data?.sessionID;
    if (!sessionId) return;
    const found = this.store.findAgentBySession(sessionId);
    if (!found) return;
    const { project, agent } = found;

    agent.lastActivity = Date.now();
    if (e.type === "session.usage.updated") this.scheduleUsage(project, agent);
    if (e.type === "permission.asked") {
      void this.onPermissionAsked(project, agent, e.data).catch((err) => console.error("[permission]", err.message));
    } else if (e.type === "permission.replied") {
      this.permissions.delete(e.data?.requestID);
      bus.publish({ type: "approvals.updated", projectId: project.id });
      if (agent.status === "waiting" && !this.pendingQuestion.has(agent.id) && !this.permissionRequests(project).some((p) => p.agentId === agent.id)) {
        this.setStatus(project, agent, "busy");
      }
    } else if (e.type === "session.inbox.delivered" || e.type === "session.inbox.cancelled") {
      this.inbox.get(agent.id)?.delete(e.data?.inboxID);
    } else if (e.type === "session.tool.input.started" && QUESTION_TOOLS.has(e.data?.name)) {
      // OpenCode's interactive question: the agent waits for the human, which is not a hang.
      this.pendingQuestion.set(agent.id, e.data.id);
      this.setStatus(project, agent, "waiting");
      void this.log(project, {
        from: agent.id,
        to: "human",
        kind: "form",
        text: `${agent.name} is asking you a question — answer it in ${agent.name}'s chat.`,
      });
    } else if (
      (e.type === "session.tool.success" || e.type === "session.tool.failed" || e.type === "session.tool.error") &&
      this.pendingQuestion.get(agent.id) === e.data?.id
    ) {
      this.pendingQuestion.delete(agent.id);
      this.setStatus(project, agent, "busy");
    } else if (e.type === "session.execution.started") {
      if (agent.status !== "stopped") this.setStatus(project, agent, "busy");
    } else if (e.type.startsWith("session.execution.")) {
      this.pendingQuestion.delete(agent.id);
      if (e.type === "session.execution.succeeded" && agent.problem) {
        agent.problem = null;
        bus.publish({ type: "project.updated", projectId: project.id });
      }
      if (agent.status !== "stopped") this.setStatus(project, agent, "idle");
      if (e.type === "session.execution.failed") void this.fallback(project, agent, e.data?.error);
    } else if (/retr/i.test(e.type)) {
      const attempt = Number(e.data?.attempt ?? e.data?.retry?.attempt ?? 0);
      const error = e.data?.error ?? e.data?.retry?.error ?? { message: "provider not responding" };
      // A timed-out attempt already cost minutes of waiting; don't sit through four of them.
      const timedOut = /timed? ?out/i.test(String(error?.message ?? ""));
      if (attempt >= (timedOut ? RETRIES_BEFORE_FALLBACK_ON_TIMEOUT : RETRIES_BEFORE_FALLBACK)) {
        void this.fallback(project, agent, error, true);
      }
    }

    // Known live-view events, plus anything about retries (event names aren't in the API spec).
    if (STREAMED.has(e.type) || e.type.startsWith("session.execution.") || /retr/i.test(e.type)) {
      bus.publish({ type: "agent.stream", projectId: project.id, agentId: agent.id, event: { type: e.type, data: e.data } });
    }
  }

  /**
   * When an agent's model fails for provider reasons (quota, outage, timeouts),
   * switch it to the next allowed model and tell it to continue.
   */
  private async fallback(project: Project, agent: Agent, error: any, interruptFirst = false) {
    if (agent.status === "stopped" || this.fallbackBusy.has(agent.id)) return;
    const message = String(error?.message ?? error ?? "unknown error");
    const type = String(error?.type ?? "");
    const status = Number(error?.status ?? 0);
    if (/interrupt|abort|cancel/i.test(`${type} ${message}`)) return; // our own interrupts
    const providerProblem =
      type.startsWith("provider") ||
      [401, 402, 403, 404, 408, 429].includes(status) ||
      status >= 500 ||
      /limit|quota|not available|unavailable|timed out|timeout|overloaded|rate|not responding/i.test(message);
    if (!providerProblem) return;

    this.fallbackBusy.add(agent.id);
    try {
      const failed = this.failedModels.get(agent.id) ?? new Map<string, number>();
      this.failedModels.set(agent.id, failed);
      failed.set(agent.model, Date.now());
      const now = Date.now();
      const next = project.allowedModels.find(
        (m) => m !== agent.model && !(failed.has(m) && now - failed.get(m)! < FAILED_MODEL_COOLDOWN_MS),
      );
      if (!next) {
        if (agent.problem) return; // already reported
        agent.problem = `Every allowed model failed recently. Last error (${agent.model}): ${message}`;
        this.setStatus(project, agent, "error");
        await this.store.update(project);
        bus.publish({ type: "project.updated", projectId: project.id });
        await this.log(project, {
          from: "symbio",
          to: "human",
          kind: "alert",
          text: `${agent.name} can't continue: ${agent.problem}\n\nAdd another model to the project (Models in the sidebar) — stuck agents resume automatically — or use “Retry now” once the quota resets.`,
        });
        return;
      }
      const previous = agent.model;
      if (interruptFirst) await this.client().interrupt(agent.sessionId).catch(() => {});
      await this.setModel(project, agent, next);
      await this.system(
        project,
        agent,
        `Symbio: your model (${previous}) failed — ${message}. You were switched to ${next}. Continue where you left off.`,
      );
    } catch (err) {
      console.error(`[fallback] ${project.name}/${agent.name}:`, (err as Error).message);
    } finally {
      this.fallbackBusy.delete(agent.id);
    }
  }

  private setStatus(project: Project, agent: Agent, status: Agent["status"]) {
    if (agent.status === status) return;
    agent.status = status;
    agent.lastActivity = Date.now();
    bus.publish({ type: "agent.status", projectId: project.id, agentId: agent.id, status });
    void this.store.update(project);
  }

  /** An agent that has been "busy" without any event for too long is hung: interrupt and nudge it. */
  private async checkStuck() {
    if (this.runtime.state !== "running") return;
    const now = Date.now();
    for (const project of this.store.list()) {
      for (const agent of project.agents) {
        if (agent.status !== "busy" || now - agent.lastActivity < STUCK_AFTER_MS) continue;
        const minutes = Math.round((now - agent.lastActivity) / 60_000);
        console.warn(`[watchdog] ${project.name}/${agent.name} silent for ${minutes} min, interrupting`);
        this.setStatus(project, agent, "stuck");
        try {
          await this.client().interrupt(agent.sessionId);
          await this.system(
            project,
            agent,
            `Symbio watchdog: you produced no activity for ${minutes} minutes, so your last step was interrupted. ` +
              `It was most likely a command that never returned (a server, a watcher, or something waiting for input). ` +
              `Do not run it the same way again — use non-interactive flags and never start long-running processes in the foreground. ` +
              `Continue your task.`,
          );
        } catch (err) {
          console.error("[watchdog] recovery failed:", (err as Error).message);
          this.setStatus(project, agent, "error");
        }
      }
    }
  }

  /**
   * Remembers which agents were in the middle of something when their runtime went
   * away (OpenCode crash or restart, or Symbio itself going down), so they can be
   * told to continue once OpenCode is back. Marks them idle meanwhile.
   */
  markInterrupted(reason: string) {
    // On a deliberate shutdown, leave statuses on disk as they are: the next start
    // sees who was working and wakes them then.
    if (this.shuttingDown) return;
    for (const project of this.store.list()) {
      let changed = false;
      for (const agent of project.agents) {
        if (agent.status !== "busy" && agent.status !== "stuck" && agent.status !== "waiting") continue;
        this.interrupted.set(agent.id, { reason, wasWaiting: agent.status === "waiting" });
        agent.status = "idle";
        changed = true;
      }
      if (changed) void this.store.update(project);
    }
  }

  /** Wakes up the agents interrupted by a crash/restart (after tools and briefs are re-registered). */
  private async recoverInterrupted() {
    for (const project of this.store.list()) {
      for (const agent of project.agents) {
        const info = this.interrupted.get(agent.id);
        if (!info) continue;
        this.interrupted.delete(agent.id);
        if (!active(agent)) continue;
        try {
          await this.system(
            project,
            agent,
            `Symbio: ${info.reason} while you were working. Your conversation is intact, but anything that was running ` +
              `(commands, servers, background processes) is gone. Check the state of your work (files, git status) and continue your task.` +
              (info.wasWaiting ? " You were waiting for the human's answer to a question — ask it again." : ""),
          );
        } catch (err) {
          console.error("[recovery] failed for", agent.name, (err as Error).message);
          this.setStatus(project, agent, "error");
        }
      }
    }
  }

  /**
   * A message from Symbio itself. With `wake` = false it is only added to the
   * conversation (the agent sees it on its next turn) instead of starting a turn.
   */
  private async system(project: Project, agent: Agent, text: string, wake = true) {
    await this.log(project, { from: "symbio", to: agent.id, kind: "system", text });
    await this.prepare(project, agent);
    if (wake && project.paused) {
      await this.hold(project, agent, text);
    } else if (wake) {
      await this.client().prompt(agent.sessionId, text, "queue");
      this.setStatus(project, agent, "busy");
    } else {
      await this.client().synthetic(agent.sessionId, text, false);
    }
  }

  /** Delivers a message from Symbio to an agent and wakes it (used by connection approvals). */
  notify(project: Project, agent: Agent, text: string) {
    return this.system(project, agent, text);
  }

  async log(project: Project, m: { from: string; to: string; kind: MessageKind; text: string }) {
    const message: LoggedMessage = { id: newId("msg"), time: Date.now(), ...m };
    await this.store.appendMessage(project, message);
    bus.publish({ type: "message", projectId: project.id, message });
  }
}

export interface PendingPermission {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  action: string;
  resources: string[];
  /** Pattern(s) OpenCode suggests for "always allow" (e.g. "pip install *"). */
  save: string[];
  time: number;
}
