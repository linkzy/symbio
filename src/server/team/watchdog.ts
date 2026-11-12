// Recovering from hangs and restarts: agents silent for too long are interrupted and told why;
// OpenCode is restarted before its memory makes it crash; agents interrupted by a crash or
// restart are woken once OpenCode is back.

import type { Agent, Project } from "../store.js";
import { active, type TeamCore } from "./core.js";

const STUCK_AFTER_MS = Number(process.env.SYMBIO_STUCK_MINUTES ?? 10) * 60_000;
const CHECK_STUCK_MS = 30_000;
// Memory recycling of the OpenCode process (MB), checked every minute.
const MEMORY_SOFT_MB = Number(process.env.SYMBIO_RECYCLE_MB ?? 1500);
const MEMORY_HARD_MB = Number(process.env.SYMBIO_RECYCLE_HARD_MB ?? 3000);
const MEMORY_CHECK_MS = Number(process.env.SYMBIO_MEMORY_CHECK_SECONDS ?? 60) * 1000;

export class Watchdog {
  private stuckTimer: NodeJS.Timeout | null = null;
  private memoryTimer: NodeJS.Timeout | null = null;
  private recycling = false;
  private lastRecycle = 0;
  /** Agents to wake once OpenCode is running again, and why they stopped. */
  private interrupted = new Map<string, { reason: string; wasWaiting: boolean }>();

  /** @param openPermissions how many permission requests wait for the human (a restart would lose them). */
  constructor(
    private readonly team: TeamCore,
    private readonly openPermissions: () => number,
  ) {}

  start() {
    this.stuckTimer ??= setInterval(() => void this.checkStuck(), CHECK_STUCK_MS);
    this.memoryTimer ??= setInterval(() => void this.checkMemory(), MEMORY_CHECK_MS);
  }

  stop() {
    if (this.stuckTimer) clearInterval(this.stuckTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.stuckTimer = null;
    this.memoryTimer = null;
  }

  /** An agent that has been "busy" without any event for too long is hung: interrupt and nudge it. */
  async checkStuck() {
    if (this.team.runtime.state !== "running") return;
    const now = Date.now();
    for (const project of this.team.store.list()) {
      for (const agent of project.agents) {
        if (agent.status !== "busy" || now - agent.lastActivity < STUCK_AFTER_MS) continue;
        // Silent because it's waiting for the human's answer (an event may have been missed): not a hang.
        const forms = await this.team.forms(agent).catch(() => []);
        if (forms.length) {
          if (forms[0]?.id) this.team.pendingQuestion.set(agent.id, String(forms[0].id));
          this.team.setStatus(project, agent, "waiting");
          continue;
        }
        const minutes = Math.round((now - agent.lastActivity) / 60_000);
        console.warn(`[watchdog] ${project.name}/${agent.name} silent for ${minutes} min, interrupting`);
        this.team.setStatus(project, agent, "stuck");
        try {
          await this.team.client().interrupt(agent.sessionId);
          await this.team.system(
            project,
            agent,
            `Symbio watchdog: you produced no activity for ${minutes} minutes, so your last step was interrupted. ` +
              `It was most likely a command that never returned (a server, a watcher, or something waiting for input). ` +
              `Do not run it the same way again — use non-interactive flags and never start long-running processes in the foreground. ` +
              `Continue your task.`,
          );
        } catch (err) {
          console.error("[watchdog] recovery failed:", (err as Error).message);
          this.team.setStatus(project, agent, "error");
        }
      }
    }
  }

  /**
   * OpenCode's memory grows over long sessions until it crashes. Restart it before that: above
   * the soft limit only when every agent is idle (nobody notices); above the hard limit regardless
   * (interrupted agents are told to continue).
   */
  private async checkMemory() {
    const runtime = this.team.runtime;
    if (runtime.state !== "running" || this.recycling) return;
    const bytes = await runtime.memoryUsage();
    if (!bytes) return;
    const mb = Math.round(bytes / 1024 / 1024);
    const everyoneIdle = this.team.store.list().every((p) => p.agents.every((a) => a.status === "idle" || a.status === "stopped" || a.status === "error"));
    const quiet = everyoneIdle && this.openPermissions() === 0 && this.team.pendingQuestion.size === 0;
    // Quiet restarts at most every 10 minutes, in case the limit is set below OpenCode's baseline.
    const softAllowed = Date.now() - this.lastRecycle > 10 * 60_000;
    const reason = mb >= MEMORY_HARD_MB ? "hard" : mb >= MEMORY_SOFT_MB && quiet && softAllowed ? "soft" : null;
    if (!reason) return;
    this.recycling = true;
    this.lastRecycle = Date.now();
    console.warn(`[recycle] OpenCode uses ${mb} MB (${reason} limit) — restarting it`);
    try {
      await runtime.restart(); // stopped → markInterrupted; running → refresh → recover
      for (const project of this.team.store.list().filter((p) => p.agents.some((a) => a.status !== "stopped"))) {
        await this.team.log(project, {
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

  /**
   * Remembers which agents were in the middle of something when their runtime went away
   * (OpenCode crash or restart, or Symbio itself going down), so they can be told to continue
   * once OpenCode is back. Marks them idle meanwhile.
   */
  markInterrupted(reason: string) {
    // On a deliberate shutdown, leave statuses on disk as they are: the next start sees who was
    // working and wakes them then.
    if (this.team.shuttingDown) return;
    for (const project of this.team.store.list()) {
      let changed = false;
      for (const agent of project.agents) {
        if (agent.status !== "busy" && agent.status !== "stuck" && agent.status !== "waiting") continue;
        this.interrupted.set(agent.id, { reason, wasWaiting: agent.status === "waiting" });
        agent.status = "idle";
        changed = true;
      }
      if (changed) this.team.store.update(project).catch((err) => console.error("[store] couldn't save", project.name, err.message));
    }
  }

  /** Wakes up the agents interrupted by a crash/restart (after tools and briefs are re-registered). */
  async recoverInterrupted() {
    for (const project of this.team.store.list()) {
      for (const agent of project.agents) {
        const info = this.interrupted.get(agent.id);
        if (!info) continue;
        this.interrupted.delete(agent.id);
        if (!active(agent)) continue;
        await this.wake(project, agent, info);
      }
    }
  }

  private async wake(project: Project, agent: Agent, info: { reason: string; wasWaiting: boolean }) {
    try {
      await this.team.system(
        project,
        agent,
        `Symbio: ${info.reason} while you were working. Your conversation is intact, but anything that was running ` +
          `(commands, servers, background processes) is gone. Check the state of your work (files, git status) and continue your task.` +
          (info.wasWaiting ? " You were waiting for the human's answer to a question — ask it again." : ""),
      );
    } catch (err) {
      console.error("[recovery] failed for", agent.name, (err as Error).message);
      this.team.setStatus(project, agent, "error");
    }
  }

  /** The agent's project is gone: nothing to wake. */
  forget(agentId: string) {
    this.interrupted.delete(agentId);
  }
}
