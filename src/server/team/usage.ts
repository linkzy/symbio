// Token usage and cost per agent, read from its OpenCode sessions (and their sub-agent sessions).

import { bus } from "../bus.js";
import { accountChildUsage, accountUsage, sessionUsage } from "../costs.js";
import type { Agent, Project } from "../store.js";
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

  /** Reads the agent's cumulative token/cost totals from its OpenCode session. */
  async refresh(project: Project, agent: Agent) {
    const res = await this.team
      .client()
      .request("GET", `/api/session/${agent.sessionId}`)
      .catch(() => null);
    const usage = sessionUsage(res?.data ?? res);
    if (!usage) return;
    agent.usage = usage;
    accountUsage(agent, agent.usage);
    await this.refreshChildren(agent).catch(() => {});
    await this.team.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  /** Sub-agent sessions (and theirs), under the agent's current and earlier sessions. */
  private async refreshChildren(agent: Agent) {
    const now = Date.now();
    if (now - (this.childrenCheckedAt.get(agent.id) ?? 0) < 60_000) return; // at most once a minute
    this.childrenCheckedAt.set(agent.id, now);
    const queue = [agent.sessionId, ...(agent.previousSessions ?? []).map((s) => s.sessionId)];
    const visited = new Set<string>();
    while (queue.length) {
      const parent = queue.shift()!;
      if (visited.has(parent) || visited.size > 200) continue;
      visited.add(parent);
      const res = await this.team.client().request("GET", `/api/session?parentID=${encodeURIComponent(parent)}&limit=100`);
      for (const child of res?.data ?? []) {
        const usage = sessionUsage(child);
        const model = child.model?.providerID && child.model?.id ? `${child.model.providerID}/${child.model.id}` : agent.model;
        if (usage) accountChildUsage(agent, child.id, model, usage);
        queue.push(child.id);
      }
    }
  }
}
