// Agents: creating them, delivering messages between them, the shared-asset
// protocol, merging work, and recovering from hangs (watchdog), opencode crashes
// (runtime restarts) and failing providers (model fallback).

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AssetRegister } from "./assets.js";
import { AGENT_PERMISSIONS, readRefusal, wildcardMatch } from "./guard.js";
import { bus } from "./bus.js";
import { privateDocsInstruction } from "./docs.js";
import type { McpResolver } from "./mcp.js";
import { parseModel, type OpencodeClient, type OpencodeEvent } from "./opencode/client.js";
import type { OpencodeRuntime } from "./opencode/runtime.js";
import { PlanStore, type TaskInput, type TaskStatus } from "./plan.js";
import type { RemoteOps } from "./remote.js";
import { coordinatorBrief, kickoffMessage, workerBrief } from "./prompts.js";
import { git } from "./git.js";
import { DEFAULT_MESSAGE_LIMIT, globalDir, newId, type Agent, type HelperWorkspace, type LoggedMessage, type MessageKind, type Project, type Store } from "./store.js";
import { accountChildUsage, accountUsage, emptyUsage, sessionUsage } from "./costs.js";
import { AGENT_UPDATES, unseenUpdates, updatesNote } from "./updates.js";
import { cleanBuildOutputs, dailyBackup, gb, helperFolders, lastBackup, unpushedWork, type FolderUsage, type UnpushedBranch } from "./housekeeping.js";
import { coordinatorTools, workerTools, type ToolContext } from "./tools.js";
import { SharedAssets } from "./team/asset-protocol.js";
import { active, type TeamCore } from "./team/core.js";
import { ModelFallback } from "./team/fallback.js";
import { Housekeeper } from "./team/housekeeper.js";
import { LoopGuard } from "./team/loop-guard.js";
import { Permissions } from "./team/permissions.js";
import { Processes } from "./team/processes.js";
import { QuietHelpers } from "./team/quiet-helpers.js";
import { Usage } from "./team/usage.js";
import { Watchdog } from "./team/watchdog.js";
import { describeOuterRepository, listRepositories, projectRepositories, repoRoot, resolveRepository, swallowedRepositories } from "./repos.js";
import { changedFiles, createWorkspace, inProjectFolder, isGitRepo, leaveWorkspace, mergeWorkspace, reattachWorkspace, removeWorkspace, restoreWorkspace, syncWorkspace } from "./workspaces.js";

const PROTOCOL_KINDS = new Set<MessageKind>([
  "asset-request",
  "asset-granted",
  "asset-denied",
  "asset-released",
  "task-review",
  "task-blocked",
]);
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

export class Team implements TeamCore {
  /** Last private-docs text sent to each agent, to avoid re-sending unchanged docs. */
  private docsSynced = new Map<string, string>();
  private registers = new Map<string, Promise<AssetRegister>>();
  private plans = new Map<string, Promise<PlanStore>>();
  /** MCP URL token → which project/folder it serves. Valid for this run only. */
  private mcpTokens = new Map<string, { projectId: string; directory: string }>();
  /** agentId → tool call id of an open interactive question. */
  readonly pendingQuestion = new Map<string, string>();
  /** Connection actions (SSH, git, GitHub API) and their approvals. Set at startup. */
  remote!: RemoteOps;
  /** Set when Symbio itself is shutting down on purpose. */
  shuttingDown = false;
  /** agentId → agent-to-agent messages queued in OpenCode's inbox, not yet delivered (inboxID → text). */
  private inbox = new Map<string, Map<string, string>>();

  // The team's parts (src/server/team/): each keeps its own state and uses only TeamCore.
  readonly permissions = new Permissions(this);
  readonly processes = new Processes(this);
  readonly housekeeper = new Housekeeper(this);
  readonly fallback = new ModelFallback(this);
  readonly usage = new Usage(this);
  readonly quiet = new QuietHelpers(this);
  readonly sharedAssets = new SharedAssets(this);
  readonly watchdog = new Watchdog(this, () => this.permissions.size);
  private loopGuard = new LoopGuard(this);

  constructor(
    readonly store: Store,
    readonly runtime: OpencodeRuntime,
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
      else if (state === "running") void this.refreshAll().then(() => this.watchdog.recoverInterrupted());
    });
  }

  /** Starts the background checks: the watchdog (hangs, memory) and the hourly housekeeping. */
  startWatchdog() {
    this.watchdog.start();
    this.housekeeper.start();
  }

  /**
   * What would be interrupted by a restart right now (null = nothing): an agent working or waiting
   * for an answer, a permission request, or activity in the last `quietMs`.
   */
  busyReason(quietMs: number): string | null {
    const now = Date.now();
    for (const project of this.store.list()) {
      for (const agent of project.agents.filter(active)) {
        if (agent.status === "busy" || agent.status === "stuck") return `${agent.name} in ${project.name} is working`;
        if (agent.status === "waiting") return `${agent.name} in ${project.name} is waiting for an answer`;
        if (now - agent.lastActivity < quietMs) return `${agent.name} in ${project.name} was active in the last ${Math.round(quietMs / 60_000)} minutes`;
      }
    }
    if (this.permissions.size) return "a permission request is waiting for an answer";
    return null;
  }

  /** A note for the human in every project's Messages (e.g. "Symbio was updated"). */
  async announce(text: string) {
    for (const project of this.store.list()) {
      await this.log(project, { from: "symbio", to: "human", kind: "system", text });
      bus.publish({ type: "project.updated", projectId: project.id });
    }
  }

  stopWatchdog() {
    this.watchdog.stop();
  }

  // ---------------------------------------------------------------- lookups

  findAgent(project: Project, name: string): Agent | undefined {
    const key = name.trim().toLowerCase();
    // "coordinator" (and "core") always reach the lead agent, whatever it is called.
    if (key === "coordinator" || key === "core") return this.coordinator(project);
    return (
      project.agents.find((a) => a.name.toLowerCase() === key && active(a)) ??
      // After a rename, others may still use the old name.
      project.agents.find((a) => a.aliases?.includes(key) && active(a))
    );
  }

  /** Names in use (current and earlier names, stopped agents included) can't be reused. */
  private nameTaken(project: Project, name: string, except?: Agent): boolean {
    if (name === "core" || name === "coordinator" || name === "human" || name === "symbio") return true;
    return project.agents.some((a) => a !== except && (a.name === name || a.aliases?.includes(name)));
  }

  /** The human chose where new helpers work; core's brief describes it, so it's told too. */
  async setHelperWorkspace(project: Project, mode: HelperWorkspace): Promise<void> {
    if ((project.helperWorkspace ?? "own") === mode) return;
    project.helperWorkspace = mode;
    await this.store.update(project);
    const coordinator = this.coordinator(project);
    if (!coordinator || coordinator.status === "stopped") return;
    await this.refreshInstructions(project, coordinator).catch(() => {});
    await this.system(
      project,
      coordinator,
      mode === "shared"
        ? "Symbio: the human set this project's helpers to work in the project folder itself. New helpers work there by default " +
            "(what they write is there at once; nothing to merge). Helpers that already have their own copy keep it: when one is idle " +
            "and its work merged, move it with move_to_project_folder if it should share the folder too."
        : "Symbio: the human set this project's helpers to work in their own copy (own branch) by default. Helpers already in the " +
            "project folder stay there.",
      false,
    );
  }

  /** The human turned the rules register on or off; every brief mentions it, and core is told. */
  /**
   * Works in the inner repositories of a repository created over them (on), or back in the outer
   * one (off). Refused while active helpers have copies of the repository being left: their work
   * would have nowhere to be merged.
   */
  async useSubRepositories(project: Project, on: boolean, by: "the coordinator" | "the human"): Promise<string> {
    if (!!project.subRepositories === on) {
      return on ? "Symbio already works in the inner repositories." : "Symbio already works in the outer repository.";
    }
    if (on && !listRepositories(project.directory).length) throw new Error("The project folder doesn't contain other git repositories.");
    const leaving = project.agents.filter((a) => a.role === "worker" && a.status !== "stopped" && a.branch && (on ? !a.repo : !!a.repo));
    if (leaving.length) {
      throw new Error(
        `${leaving.map((a) => a.name).join(", ")} ${leaving.length === 1 ? "has its" : "have their"} own copy of ${on ? "the outer repository" : "an inner repository"}. ` +
          `Merge their work, then move them to the project folder (${by === "the human" ? "from their chat" : "move_to_project_folder"}) or stop them, and switch again.`,
      );
    }
    project.subRepositories = on;
    await this.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    for (const agent of project.agents.filter(active)) await this.refreshInstructions(project, agent).catch(() => {});
    const repos = listRepositories(project.directory);
    await this.log(project, {
      from: "symbio",
      to: "human",
      kind: "system",
      text: on
        ? `Symbio now works in this project's repositories (${repos.join(", ")}) instead of the repository on top of them (switched by ${by}). Nothing on disk changed; Settings → Team switches back.`
        : `Symbio works in the project folder's own repository again (switched by ${by}).`,
    });
    return on
      ? `Done: helpers' own copies now come from one of ${repos.join(", ")} (spawn_agent repo), merges and pushes go there. Your instructions were updated.`
      : "Done: Symbio works in the outer repository again. Your instructions were updated.";
  }

  async setRulesRegister(project: Project, on: boolean): Promise<void> {
    if (!!project.rulesRegister === on) return;
    project.rulesRegister = on;
    await this.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    for (const agent of project.agents.filter(active)) await this.refreshInstructions(project, agent).catch(() => {});
    const coordinator = this.coordinator(project);
    if (!coordinator || coordinator.status === "stopped") return;
    await this.system(
      project,
      coordinator,
      on
        ? "Symbio: the human turned on the rules register for this project. Your instructions now explain it (save_rule, list_rules…). " +
            "Record rules as they come up in the work; if the project already has rules written down somewhere, offer the human to " +
            "bring them into the register as a planned task."
        : "Symbio: the human turned off the rules register for this project. Stop recording rules; what's recorded stays in the file.",
      false,
    );
  }

  /** Renames a helper. Its branch and folder keep their names; the old name keeps working. */
  async renameAgent(project: Project, agent: Agent, newName: string): Promise<void> {
    if (agent.role === "coordinator") throw new Error("core keeps its name.");
    const name = newName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new Error("Use a short name with letters, digits and dashes (e.g. 'catalogo-web').");
    if (name === agent.name) return;
    if (this.nameTaken(project, name, agent)) throw new Error(`The name "${name}" is taken.`);
    const old = agent.name;
    agent.aliases = [...new Set([...(agent.aliases ?? []), old])].filter((a) => a !== name);
    agent.name = name;
    await this.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    await this.log(project, { from: "symbio", to: "human", kind: "system", text: `${old} was renamed to ${name}.` });
    // Everyone learns the new name without being woken up; briefs mention names too.
    for (const other of project.agents.filter(active)) {
      await this.refreshInstructions(project, other).catch(() => {});
      const text =
        other === agent
          ? `Symbio: the human renamed you from "${old}" to "${name}". Your branch and folder are unchanged.`
          : `Symbio: the human renamed the agent "${old}" to "${name}". Use "${name}" from now on (the old name still reaches it).`;
      await this.system(project, other, text, false).catch(() => {});
    }
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
        `When it's done, ${helper.branch ? "commit your work and " : ""}call update_task("${task.id}", "review", <summary>) — that is your report. ` +
        `If you get stuck, update_task("${task.id}", "blocked", <why>).`,
      { protocol: true },
    );
    return `Assigned ${task.id} to ${helper.name}.`;
  }

  async updateTask(project: Project, agent: Agent, taskId: string, status: TaskStatus | undefined, note: string | undefined): Promise<string> {
    const store = await this.plan(project);
    const task = store.task(taskId);
    if (agent.role !== "coordinator" && task.assignee !== agent.id) {
      throw new Error(`${task.id} isn't assigned to you. Ask the coordinator.`);
    }
    if (agent.role === "worker") this.quiet.reported(agent); // any update on its task is news for core
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
          (status === "review"
            ? agent.branch
              ? `\nMerge with merge_work("${agent.name}") when it looks right.`
              : `\nIts work is already in the project folder; check it there, then mark the task done (update_task) or send it back.`
            : ""),
      );
      return `${task.id} is now ${status}. The coordinator has been notified — no separate report needed.`;
    }
    // Helpers without a branch have nothing to merge: the coordinator marking their task done
    // is the moment a fresh session fits (what merging is for the others).
    const helper = task.assignee ? project.agents.find((a) => a.id === task.assignee) : undefined;
    if (agent.role === "coordinator" && status === "done" && helper && !helper.branch && helper.role !== "coordinator") {
      await this.renewAfterTask(project, helper, "its task was done");
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
    // A new coordinator starts with today's rules in its brief; earlier changes aren't news to it.
    project.updatesSeen = AGENT_UPDATES.map((u) => u.id);
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
    opts: { name: string; purpose: string; task?: string; taskId?: string; model?: string; workspace?: HelperWorkspace; repo?: string },
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
    if (this.nameTaken(project, name)) {
      throw new Error(`The name "${name}" is taken. Choose another.`);
    }
    const model = opts.model?.trim() || coordinator.model;
    if (!project.allowedModels.includes(model)) {
      throw new Error(`Model "${model}" is not allowed for this project. Allowed: ${project.allowedModels.join(", ")}`);
    }

    // A folder of several repositories: an own copy comes from one of them, so it must be named.
    const mode = opts.workspace ?? project.helperWorkspace ?? "own";
    const repo = opts.repo?.trim() ? await resolveRepository(project, opts.repo) : undefined;
    const repos = await projectRepositories(project);
    if (repos.length && mode === "own" && !repo) {
      throw new Error(
        `This project is made of several repositories (${repos.join(", ")}). Say which one the helper works in with repo ` +
          "(it gets its own copy of that repository), or use workspace \"shared\" to have it work in the project folder.",
      );
    }
    const workspace = await createWorkspace(project, name, mode, repo);
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
      ...(repo ? { repo } : {}),
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
    else await this.deliver(project, coordinator, agent, "request", opts.task!, { protocol: true });
    const where = workspace.branch
      ? `It works in its own copy of ${repo ? `the "${repo}" repository` : "the project"} on branch ${workspace.branch} (${workspace.directory}); merge its work with merge_work.`
      : (await isGitRepo(project.directory)) || repos.length
        ? "It works in the project folder itself, alongside you: what it writes is there at once, and there is nothing to merge. " +
          "Shared-asset grants keep it from colliding with others; it doesn't commit unless you ask."
        : "It works directly in the project folder (no git), so rely on shared-asset grants to avoid conflicts.";
    return [`Created ${name} on ${model} and sent it the task. ${where}`, workspace.warning].filter(Boolean).join("\n");
  }

  async stopAgent(project: Project, agent: Agent, reason: string): Promise<string> {
    this.quiet.reported(agent);
    await this.client()
      .interrupt(agent.sessionId)
      .catch(() => {});
    const reg = await this.assets(project);
    await reg.forget(agent.id);
    this.assetsChanged(project);
    // Helpers have their own folder; the project root is shared, so leave its processes alone.
    await this.processes.stopAll(project, agent);
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

  /**
   * Gives an agent a fresh OpenCode session, keeping its identity (name, folder, branch,
   * tasks, assets). Long sessions get slow, costly (every step re-reads the context) and
   * lossy (compactions), and they inflate OpenCode's memory. The new session starts from
   * a handoff note built from what Symbio knows; the old one stays readable.
   */
  async renewSession(project: Project, agent: Agent, reason: string, opts: { moved?: boolean } = {}): Promise<void> {
    if (agent.status === "busy" || agent.status === "waiting" || agent.status === "stuck") {
      throw new Error(`${agent.name} is working; renew its session when it's idle.`);
    }
    if (agent.status === "stopped") throw new Error(`${agent.name} is stopped.`);
    const client = this.client();
    const oldSession = agent.sessionId;

    // Count everything the old session used before leaving it.
    await this.usage.refresh(project, agent).catch(() => {});
    const handoff = await this.handoffNote(project, agent, oldSession, opts.moved);

    await this.registerTools(project, agent.directory);
    const session = await client.createSession({
      title: `${project.name} · ${agent.name}`,
      directory: agent.directory,
      model: parseModel(agent.model),
      permissions: AGENT_PERMISSIONS,
    });
    agent.previousSessions = [...(agent.previousSessions ?? []), { sessionId: oldSession, endedAt: Date.now() }];
    agent.sessionId = session.id;
    accountUsage(agent, agent.usage ?? emptyUsage());
    agent.usage = emptyUsage();
    agent.usageSeen = emptyUsage();
    agent.status = "idle";
    agent.lastActivity = Date.now();
    this.inbox.delete(agent.id);
    this.pendingQuestion.delete(agent.id);
    await this.store.update(project);
    await this.refreshInstructions(project, agent);
    await client.setInstruction(agent.sessionId, "symbio-handoff", handoff);
    await this.log(project, {
      from: "symbio",
      to: "human",
      kind: "system",
      text: `${agent.name} continues in a fresh session (${reason}). Its earlier conversation is still readable in its chat.`,
    });
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  /**
   * Moves a helper from its own worktree into the project folder (for pipeline-style work
   * where each step reads the previous step's files). OpenCode ties a session to its folder,
   * so the helper continues in a fresh session there, with the usual handoff note.
   */
  async moveToProjectFolder(project: Project, agent: Agent, reason: string): Promise<string> {
    if (agent.role === "coordinator") throw new Error("core already works in the project folder.");
    if (inProjectFolder(project, agent)) return `${agent.name} already works in the project folder.`;
    if (agent.status === "stopped") throw new Error(`${agent.name} is stopped; restart it first.`);
    if (agent.status === "busy" || agent.status === "waiting" || agent.status === "stuck") {
      throw new Error(`${agent.name} is working; move it when it's idle.`);
    }
    // Its processes run in the folder about to go away (and would keep files open on Windows).
    await this.processes.stopAll(project, agent);
    await leaveWorkspace(project, agent);
    const branch = agent.branch;
    agent.directory = project.directory;
    agent.branch = null;
    agent.base = null;
    agent.workSince = Date.now();
    await this.store.update(project);
    try {
      await this.renewSession(project, agent, reason, { moved: true });
    } catch (err) {
      agent.status = "error";
      agent.problem = `It moved to the project folder but its new session couldn't start (${(err as Error).message}). Give it a fresh session to retry.`;
      await this.store.update(project);
      bus.publish({ type: "project.updated", projectId: project.id });
      throw new Error(agent.problem);
    }
    await this.log(project, {
      from: "symbio",
      to: "human",
      kind: "system",
      text: `${agent.name} now works in the project folder (${reason}); its own copy${branch ? ` on ${branch}` : ""} was removed.`,
    });
    const coordinator = this.coordinator(project);
    if (coordinator && reason !== "moved by the coordinator") {
      await this.system(
        project,
        coordinator,
        `Symbio: the human moved ${agent.name} into the project folder. It now works on the project's files directly: nothing of its to merge from now on.`,
        false,
      );
    }
    return `${agent.name} now works in the project folder, in a fresh session with a handoff note. Its own copy was removed.`;
  }

  /** What an agent needs to carry on in a fresh session, from Symbio's own records. */
  private async handoffNote(project: Project, agent: Agent, oldSession: string, moved = false): Promise<string> {
    const plan = (await this.plan(project)).plan;
    const reg = await this.assets(project);
    const mine = plan.tasks.filter((t) => t.assignee === agent.id);
    const open = mine.filter((t) => t.status !== "done");
    const done = mine.filter((t) => t.status === "done").slice(-8);
    const lastNote = (t: (typeof mine)[number]) => t.notes?.filter((n) => n.by === agent.name).at(-1)?.text;
    const held = reg.list().filter((a) => a.holder === agent.id).map((a) => a.name);
    const log = (await this.store.readMessages(project)).filter((m) => m.from === agent.id || m.to === agent.id).slice(-8);
    const nameOf = (id: string) => (id === "human" ? "human" : id === "symbio" ? "Symbio" : this.agentName(project, id) ?? id);
    const lastText = await this.client()
      .messagePage(oldSession, 30)
      .then(({ messages }) => {
        const last = messages.filter((m) => m.type === "assistant" && (m.content ?? []).some((c: any) => c.type === "text" && c.text)).at(-1);
        return (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      })
      .catch(() => "");
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

    const parts = [
      `# Handoff: you are continuing as ${agent.name} in a fresh session`,
      (moved
        ? `You now work in the project folder itself instead of your own copy, so Symbio started a new session there. ` +
          `Nothing else about your role changed. `
        : `Your previous session had grown long, so Symbio started a new one. Nothing about your role changed. `) +
        `This note is what carries over; the project's docs (AGENTS.md, docs/) hold the durable knowledge, ` +
        `and your work is in your folder.`,
      agent.purpose ? `**Your purpose:** ${agent.purpose}` : "",
      agent.role === "coordinator"
        ? `**Plan:** ${plan.status}${plan.goal ? ` — ${plan.goal}` : ""}\n${plan.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignee ? ` (${nameOf(t.assignee)})` : ""}`).join("\n")}`
        : "",
      agent.role === "coordinator"
        ? ""
        : agent.branch
          ? `**Your folder:** ${agent.directory} (branch ${agent.branch}).`
          : `**Your folder:** ${agent.directory} (the project folder, shared with the team).`,
      open.length ? `**Your open tasks:**\n${open.map((t) => `- ${t.id} [${t.status}] ${t.title}\n  ${cut(t.description, 600)}`).join("\n")}` : "**Open tasks:** none right now; wait for the next one.",
      done.length ? `**Recently finished:**\n${done.map((t) => `- ${t.id} ${t.title}${lastNote(t) ? ` — ${cut(lastNote(t)!, 300)}` : ""}`).join("\n")}` : "",
      held.length ? `**Shared assets you hold:** ${held.join(", ")} (release them when done).` : "",
      log.length ? `**Latest messages:**\n${log.map((m) => `- ${nameOf(m.from)} → ${nameOf(m.to)} (${m.kind}): ${cut(m.text.replace(/\s+/g, " "), 400)}`).join("\n")}` : "",
      lastText ? `**Your last answer in the previous session:**\n${cut(lastText, 2500)}` : "",
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  /** With "after-task" renewal, a helper with no other task under way gets a fresh session. */
  private async renewAfterTask(project: Project, agent: Agent, reason: string): Promise<boolean> {
    const plan = await this.plan(project);
    const renew =
      project.renewSessions === "after-task" &&
      agent.status === "idle" &&
      !plan.plan.tasks.some((t) => t.assignee === agent.id && t.status !== "done" && t.status !== "todo");
    if (!renew) return false;
    await this.renewSession(project, agent, reason).catch((err) => console.error(`[renew] ${agent.name}:`, err.message));
    return true;
  }

  async mergeWork(project: Project, agent: Agent, force: boolean): Promise<string> {
    const { committed, uncommitted } = await changedFiles(agent);
    const reg = await this.assets(project);
    // Asset patterns are relative to the project folder; a sub-repository's paths are relative to it.
    const inProject = (f: string) => (agent.repo ? `${agent.repo}/${f}` : f);
    const violations = reg.violations([...committed, ...uncommitted].map(inProject), agent.id, agent.workSince ?? agent.createdAt);
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
    if (!(completed.length > 0 && (await this.renewAfterTask(project, agent, "its task was merged")))) {
      await this.system(
        project,
        agent,
        "Symbio: your committed work was merged into the project, and your workspace now includes the latest project state.",
        false,
      );
    }
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
  async deliver(project: Project, from: Agent, to: Agent, kind: MessageKind, text: string, opts: { protocol?: boolean } = {}) {
    if (to.status === "stopped") throw new Error(`${to.name} is stopped.`);
    if (!opts.protocol && !PROTOCOL_KINDS.has(kind)) await this.loopGuard.check(project, from, to);
    await this.log(project, { from: from.id, to: to.id, kind, text });
    this.quiet.track(from, to, kind);
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
  hasQueuedMessages(agent: Agent): boolean {
    return !!this.inbox.get(agent.id)?.size;
  }

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
    // The human is talking to the helper directly: its answer goes to them, not to core.
    if (agent.role === "worker") this.quiet.reported(agent);
    await this.log(project, { from: "human", to: agent.id, kind: urgent ? "urgent" : "chat", text });
    await this.prepare(project, agent);
    // The coordinator talks with the human directly; for helpers, say who is speaking.
    const body = agent.role === "coordinator" ? text : `[from: human · ${urgent ? "urgent" : "chat"}]\n${text}`;
    await this.client().prompt(agent.sessionId, body, urgent ? "steer" : "queue");
    this.setStatus(project, agent, "busy");
  }

  async askHuman(project: Project, from: Agent, question: string) {
    if (from.role === "worker") this.quiet.reported(from); // it's waiting on the human, not quiet
    await this.log(project, { from: from.id, to: "human", kind: "needs-human", text: question });
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
        await this.processes.stopAll(project, agent).catch(() => {});
      }
      if (agent.branch) await removeWorkspace(project, agent).catch(() => {});
      if (deleteData && client) await client.request("DELETE", `/api/session/${agent.sessionId}`).catch(() => {});
      this.watchdog.forget(agent.id);
      this.inbox.delete(agent.id);
    }
    if (project.agents.some((a) => a.branch)) {
      await fs.rm(path.join(globalDir, "worktrees", project.id), { recursive: true, force: true }).catch(() => {});
      const roots = new Set(project.agents.filter((a) => a.branch).map((a) => repoRoot(project, a)));
      for (const root of roots) await git(root, "worktree", "prune").catch(() => {});
    }
    this.registers.delete(project.id);
    this.plans.delete(project.id);
    for (const [token, t] of this.mcpTokens) if (t.projectId === project.id) this.mcpTokens.delete(token);
    await this.store.remove(project, deleteData);
    bus.publish({ type: "project.updated", projectId: project.id });
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

  /** One page of an agent's conversation (for long chats), oldest first. */
  historyPage(agent: Agent, limit: number, before?: string, sessionId?: string) {
    // Earlier sessions (after a renewal) stay readable, but only the agent's own.
    const session = sessionId && agent.previousSessions?.some((s) => s.sessionId === sessionId) ? sessionId : agent.sessionId;
    return this.client().messagePage(session, limit, before);
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

  client(): OpencodeClient {
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
    await this.reattach(project, agent);
    await this.ensureTools(project, agent.directory);
    await this.syncPrivateDocs(project, agent);
  }

  /** A helper whose folder disappeared gets it back from its branch (see reattachWorkspace). */
  private async reattach(project: Project, agent: Agent) {
    if (agent.status === "stopped") return;
    const recreated = await reattachWorkspace(project, agent).catch((err) => {
      console.error(`[team] could not recreate ${agent.name}'s folder:`, err.message);
      return false;
    });
    if (!recreated) return;
    const text =
      `${agent.name}'s folder (${agent.directory}) had disappeared; Symbio recreated it from its branch ${agent.branch}. ` +
      "Everything it committed is there; changes it hadn't committed were in the folder and are gone.";
    await this.log(project, { from: "symbio", to: "human", kind: "system", text });
    await this.system(project, agent, `Symbio: ${text.replace(`${agent.name}'s folder`, "Your folder")} Check your state before continuing.`, false);
  }

  private async refreshAll() {
    for (const project of this.store.list()) {
      for (const agent of project.agents.filter(active)) await this.reattach(project, agent);
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
        await this.usage.refresh(project, agent).catch(() => {});
      }
      await this.tellAboutUpdates(project).catch((err) => console.error(`[updates] ${project.name}:`, err.message));
    }
  }

  /** After Symbio is updated, the coordinator learns what changed (a note; it isn't woken up). */
  private async tellAboutUpdates(project: Project) {
    const coordinator = this.coordinator(project);
    const updates = unseenUpdates(project.updatesSeen);
    if (!coordinator || updates.length === 0) return;
    const note = updatesNote(updates);
    await this.note(project, coordinator, note);
    await this.log(project, { from: "symbio", to: coordinator.id, kind: "system", text: note });
    project.updatesSeen = [...(project.updatesSeen ?? []), ...updates.map((u) => u.id)];
    await this.store.update(project);
    // Some changes ask for action in the projects they apply to: those wake core up with a task.
    for (const u of updates) {
      const task = await u.task?.(project).catch(() => null);
      if (task) await this.system(project, coordinator, task);
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

  private onEvent(e: OpencodeEvent) {
    const sessionId: string | undefined = e.data?.sessionID;
    if (!sessionId) return;
    const found = this.store.findAgentBySession(sessionId);
    if (!found) return;
    const { project, agent } = found;

    agent.lastActivity = Date.now();
    if (e.type === "session.usage.updated") this.usage.schedule(project, agent);
    if (e.type === "permission.asked") {
      void this.permissions.asked(project, agent, e.data).catch((err) => console.error("[permission]", err.message));
    } else if (e.type === "permission.replied") {
      this.permissions.replied(e.data?.requestID);
      bus.publish({ type: "approvals.updated", projectId: project.id });
      if (agent.status === "waiting" && !this.pendingQuestion.has(agent.id) && !this.permissions.waitsFor(agent)) {
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
      if (e.type === "session.execution.failed") void this.fallback.onFailure(project, agent, e.data?.error);
      else if (agent.role === "worker") this.quiet.afterTurn(project, agent);
    } else if (/retr/i.test(e.type)) {
      this.fallback.onRetry(project, agent, e.data);
    }

    // Known live-view events, plus anything about retries (event names aren't in the API spec).
    if (STREAMED.has(e.type) || e.type.startsWith("session.execution.") || /retr/i.test(e.type)) {
      bus.publish({ type: "agent.stream", projectId: project.id, agentId: agent.id, event: { type: e.type, data: e.data } });
    }
  }

  setStatus(project: Project, agent: Agent, status: Agent["status"]) {
    if (agent.status === status) return;
    // A message arriving while the agent waits on the human (a question, a permission request) is
    // queued until it's answered. Turning "busy" here hid the question from the chat and let the
    // watchdog interrupt it as a hang ten minutes later.
    if (status === "busy" && agent.status === "waiting" && this.waitsOnHuman(project, agent)) return;
    agent.status = status;
    agent.lastActivity = Date.now();
    bus.publish({ type: "agent.status", projectId: project.id, agentId: agent.id, status });
    void this.store.update(project);
  }

  private waitsOnHuman(project: Project, agent: Agent): boolean {
    return this.pendingQuestion.has(agent.id) || this.permissions.waitsFor(agent);
  }

  /** Agents working when their runtime went away are woken once OpenCode is back (see Watchdog). */
  markInterrupted(reason: string) {
    this.watchdog.markInterrupted(reason);
  }

  /**
   * A message from Symbio itself. With `wake` = false it is only added to the
   * conversation (the agent sees it on its next turn) instead of starting a turn.
   */
  async system(project: Project, agent: Agent, text: string, wake = true) {
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

  /** Adds a line to an agent's conversation without starting a turn or logging it (the caller logs). */
  async note(project: Project, agent: Agent, text: string) {
    await this.prepare(project, agent).catch(() => {});
    await this.client().synthetic(agent.sessionId, text, false).catch(() => {});
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

export type { PendingPermission } from "./team/permissions.js";
export type { HousekeepingReport } from "./team/housekeeper.js";
