// Background processes (OpenCode shells) agents start: listed and stopped per agent, and all of an
// agent's stopped when the agent is.

import type { Agent, Project } from "../store.js";
import { inProjectFolder } from "../workspaces.js";
import type { TeamCore } from "./core.js";

export class Processes {
  constructor(private readonly team: TeamCore) {}

  /**
   * The agent's running background shells. An agent alone in its folder owns everything there;
   * in the project folder (shared by the coordinator and shared helpers) a shell belongs to the
   * session that started it, which OpenCode records in its metadata.
   */
  private async own(project: Project, agent: Agent): Promise<any[]> {
    const running = (await this.team.client().shells(agent.directory)).filter((s) => s.status === "running");
    if (!inProjectFolder(project, agent)) return running;
    const sessionsOf = (a: Agent) => [a.sessionId, ...(a.previousSessions ?? []).map((p) => p.sessionId), ...Object.keys(a.childSessions ?? {})];
    const mine = new Set(sessionsOf(agent));
    const others = new Set(project.agents.filter((a) => a.id !== agent.id).flatMap(sessionsOf));
    return running.filter((s) => {
      const owner = s.metadata?.sessionID;
      if (owner) return mine.has(owner) || (agent.role === "coordinator" && !others.has(owner));
      // No owner recorded (started outside an agent session): the coordinator manages it.
      return agent.role === "coordinator";
    });
  }

  /** Background shells the agent started that are still running. */
  async list(project: Project, agent: Agent): Promise<string> {
    const shells = await this.own(project, agent);
    if (shells.length === 0) return "You have no background processes running.";
    return shells.map((s) => `- ${s.id}: ${s.command} (pid ${s.pid ?? "?"}, started ${new Date(s.time.started).toLocaleTimeString()})`).join("\n");
  }

  /** Stops one background shell, only one the agent itself started. */
  async stop(project: Project, agent: Agent, shellId: string): Promise<string> {
    const shell = (await this.own(project, agent)).find((s) => s.id === shellId.trim());
    if (!shell) throw new Error(`No running background process "${shellId}" of yours. Use list_processes to see yours.`);
    await this.team.client().stopShell(agent.directory, shell.id);
    return `Stopped ${shell.id} (${shell.command}).`;
  }

  /** Stops every background shell an agent left running (used when the agent is stopped). */
  async stopAll(project: Project, agent: Agent) {
    const shells = await this.own(project, agent).catch(() => []);
    for (const s of shells) {
      await this.team
        .client()
        .stopShell(agent.directory, s.id)
        .catch(() => {});
    }
  }
}
