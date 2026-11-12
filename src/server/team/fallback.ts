// Failing providers: an agent whose model fails (quota, outage, timeouts) is switched to the next
// allowed model; one whose conversation got too large to send continues in a fresh session; when
// nothing is left, the human is told, and resumeStuck wakes the agents once models are back.

import { bus } from "../bus.js";
import type { Agent, Project } from "../store.js";
import { active, type TeamCore } from "./core.js";

// A failed model is skipped for this long; switch after this many provider retries.
const FAILED_MODEL_COOLDOWN_MS = 30 * 60_000;
const RETRIES_BEFORE_FALLBACK = 4;
const RETRIES_BEFORE_FALLBACK_ON_TIMEOUT = 2;

export class ModelFallback {
  private failedModels = new Map<string, Map<string, number>>(); // agentId → model → failedAt
  private busy = new Set<string>();
  /** When each agent last got a fresh session because its conversation was too large to send. */
  private oversizedAt = new Map<string, number>();

  constructor(private readonly team: TeamCore) {}

  /** A provider retry event: after a few, stop waiting and fall back. */
  onRetry(project: Project, agent: Agent, data: any) {
    const attempt = Number(data?.attempt ?? data?.retry?.attempt ?? 0);
    const error = data?.error ?? data?.retry?.error ?? { message: "provider not responding" };
    // A timed-out attempt already cost minutes of waiting; don't sit through four of them.
    const timedOut = /timed? ?out/i.test(String(error?.message ?? ""));
    if (attempt >= (timedOut ? RETRIES_BEFORE_FALLBACK_ON_TIMEOUT : RETRIES_BEFORE_FALLBACK)) {
      void this.onFailure(project, agent, error, true);
    }
  }

  /**
   * When an agent's model fails for provider reasons (quota, outage, timeouts), switch it to the
   * next allowed model and tell it to continue.
   */
  async onFailure(project: Project, agent: Agent, error: any, interruptFirst = false) {
    if (agent.status === "stopped" || this.busy.has(agent.id)) return;
    const message = String(error?.message ?? error ?? "unknown error");
    const type = String(error?.type ?? "");
    const status = Number(error?.status ?? 0);
    if (/interrupt|abort|cancel/i.test(`${type} ${message}`)) return; // our own interrupts
    // The conversation itself is too big to send (seen with Copilot: "Timed out reading request
    // body", after an agent read several large images). Another model won't help; a fresh session will.
    if (status === 413 || /request body|request size|payload too large|request too large|request entity too large/i.test(message)) {
      // Still retrying the same oversized request: stop it before moving on.
      if (interruptFirst) await this.team.client().interrupt(agent.sessionId).catch(() => {});
      await this.renewOversized(project, agent, message);
      return;
    }
    const providerProblem =
      type.startsWith("provider") ||
      [401, 402, 403, 404, 408, 429].includes(status) ||
      status >= 500 ||
      /limit|quota|not available|unavailable|timed out|timeout|overloaded|rate|not responding/i.test(message);
    if (!providerProblem) return;

    this.busy.add(agent.id);
    try {
      const failed = this.failedModels.get(agent.id) ?? new Map<string, number>();
      this.failedModels.set(agent.id, failed);
      failed.set(agent.model, Date.now());
      const now = Date.now();
      const next = project.allowedModels.find((m) => m !== agent.model && !(failed.has(m) && now - failed.get(m)! < FAILED_MODEL_COOLDOWN_MS));
      if (!next) {
        if (agent.problem) return; // already reported
        const problem = `Every allowed model failed recently. Last error (${agent.model}): ${message}`;
        agent.problem = problem;
        this.team.setStatus(project, agent, "error");
        await this.team.store.update(project);
        bus.publish({ type: "project.updated", projectId: project.id });
        await this.team.log(project, {
          from: "symbio",
          to: "human",
          kind: "alert",
          text: `${agent.name} can't continue: ${problem}\n\nAdd another model to the project (Models in the sidebar) — stuck agents resume automatically — or use “Retry now” once the quota resets.`,
        });
        return;
      }
      const previous = agent.model;
      if (interruptFirst) await this.team.client().interrupt(agent.sessionId).catch(() => {});
      await this.team.setModel(project, agent, next);
      await this.team.system(project, agent, `Symbio: your model (${previous}) failed — ${message}. You were switched to ${next}. Continue where you left off.`);
    } catch (err) {
      console.error(`[fallback] ${project.name}/${agent.name}:`, (err as Error).message);
    } finally {
      this.busy.delete(agent.id);
    }
  }

  /**
   * An agent whose conversation got too large to send continues in a fresh session (with the
   * usual handoff note) and is told why. Once per 15 minutes: if the fresh one fails the same
   * way, the human is told instead of looping.
   */
  private async renewOversized(project: Project, agent: Agent, message: string) {
    const last = this.oversizedAt.get(agent.id) ?? 0;
    const cantContinue = async (problem: string) => {
      agent.problem = problem;
      this.team.setStatus(project, agent, "error");
      await this.team.store.update(project);
      bus.publish({ type: "project.updated", projectId: project.id });
      await this.team.log(project, { from: "symbio", to: "human", kind: "alert", text: `${agent.name} can't continue: ${agent.problem}` });
    };
    if (Date.now() - last < 15 * 60_000) {
      if (agent.problem) return;
      await cantContinue(`Its conversation is too large to send, even after a fresh session (${message}).`);
      return;
    }
    this.oversizedAt.set(agent.id, Date.now());
    this.busy.add(agent.id);
    try {
      agent.problem = null;
      if (agent.status !== "idle") this.team.setStatus(project, agent, "idle");
      await this.team.renewSession(project, agent, "its conversation had grown too large to send");
      await this.team.system(
        project,
        agent,
        "Symbio: your previous conversation had grown too large to send to the model (the provider said: " +
          `"${message}"), so you continue in this fresh session; the handoff note above has what carries over. ` +
          "Usually it's images read in full: each one stays in the conversation and is sent again every turn. " +
          "To look at an image, read a small copy (scaled down to about 1000 px wide) or have a helper review it. " +
          "Continue where you left off.",
      );
    } catch (err) {
      await cantContinue(`Its conversation is too large to send (${message}), and a fresh session couldn't start: ${(err as Error).message}. Use New session in its chat.`);
    } finally {
      this.busy.delete(agent.id);
    }
  }

  /**
   * Wakes agents that stopped because every allowed model failed: after the human added models
   * (or with `forgetFailures`, when they want to retry the same ones).
   */
  async resumeStuck(project: Project, forgetFailures: boolean): Promise<string[]> {
    const resumed: string[] = [];
    const now = Date.now();
    for (const agent of project.agents.filter((a) => a.problem && active(a))) {
      const failed = this.failedModels.get(agent.id) ?? new Map<string, number>();
      if (forgetFailures) failed.clear();
      const usable = (m: string) => !(failed.has(m) && now - failed.get(m)! < FAILED_MODEL_COOLDOWN_MS);
      const model = usable(agent.model) && project.allowedModels.includes(agent.model) ? agent.model : project.allowedModels.find(usable);
      if (!model) continue;
      agent.problem = null;
      if (model !== agent.model) await this.team.setModel(project, agent, model);
      await this.team.store.update(project);
      await this.team.system(project, agent, `Symbio: models are available again (you're on ${model}). Continue where you left off.`);
      resumed.push(agent.name);
    }
    if (resumed.length) bus.publish({ type: "project.updated", projectId: project.id });
    return resumed;
  }
}
