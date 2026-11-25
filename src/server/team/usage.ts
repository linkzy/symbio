// Token usage and cost per agent, read from its sessions (and their sub-agent sessions).

import { bus } from "../bus.js";
import { accountChildUsage, accountUsage } from "../costs.js";
import type { Agent, Project } from "../store.js";
import { runtimeOf } from "../runtime/types.js";
import type { TeamCore } from "./core.js";

export class Usage {
  private timers = new Map<string, NodeJS.Timeout>();
  private childrenCheckedAt = new Map<string, number>(); // agent → last sub-agent usage check

  constructor(private readonly team: TeamCore) {}

  /** Usage events come in bursts; read the totals at most every few seconds per agent. */
  schedule(project: Project, agent: Agent) {
    if (this.timers.has(agent.id)) return;
    this.timers.set(
      agent.id,
      setTimeout(() => {
        this.timers.delete(agent.id);
        // OpenCode may be restarting; the next burst of usage events reads the totals again.
        this.refresh(project, agent).catch(() => {});
      }, 3000),
    );
  }

  /** Reads the agent's cumulative token/cost totals from its session. */
  async refresh(project: Project, agent: Agent) {
    const usage = await this.team
      .rt(agent)
      .sessionUsage(agent.sessionId)
      .catch(() => null);
    if (!usage) return;
    agent.usage = usage;
    accountUsage(agent, agent.usage);
    await this.refreshChildren(agent).catch(() => {});
    await this.team.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    await this.team.budgets.check(project).catch((err) => console.error("[budget]", err.message));
  }

  /** Sub-agent sessions (and theirs), under the agent's current and earlier sessions. */
  private async refreshChildren(agent: Agent) {
    const now = Date.now();
    if (now - (this.childrenCheckedAt.get(agent.id) ?? 0) < 60_000) return; // at most once a minute
    this.childrenCheckedAt.set(agent.id, now);
    // Only sessions in the agent's runtime now (earlier ones elsewhere were counted before it switched).
    const queue = [agent.sessionId, ...(agent.previousSessions ?? []).filter((s) => (s.runtime ?? runtimeOf(agent)) === runtimeOf(agent)).map((s) => s.sessionId)];
    const visited = new Set<string>();
    while (queue.length) {
      const parent = queue.shift()!;
      if (visited.has(parent) || visited.size > 200) continue;
      visited.add(parent);
      for (const child of await this.team.rt(agent).childSessions(parent)) {
        if (child.usage) accountChildUsage(agent, child.id, child.model ?? agent.model, child.usage);
        queue.push(child.id);
      }
    }
  }
}
