// OpenCode permission requests ("may I run pip install …?"): answered at once when Symbio already
// knows the answer (image/PDF reads refused with a pointer, patterns the human chose "always"
// for), otherwise held for the human in Needs you.

import { bus } from "../bus.js";
import { readRefusal, wildcardMatch } from "../guard.js";
import type { Agent, Project } from "../store.js";
import type { TeamCore } from "./core.js";

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

export class Permissions {
  /** Open requests, by request id. They die with the OpenCode process. */
  private open = new Map<string, PendingPermission>();

  constructor(private readonly team: TeamCore) {}

  get size() {
    return this.open.size;
  }

  clear() {
    this.open.clear();
  }

  /** Open requests in a project. */
  requests(project: Project): PendingPermission[] {
    return [...this.open.values()].filter((p) => p.projectId === project.id);
  }

  waitsFor(agent: Agent): boolean {
    return [...this.open.values()].some((p) => p.agentId === agent.id);
  }

  /** OpenCode says it was answered (by us, or because the session ended). */
  replied(requestId: string) {
    this.open.delete(requestId);
  }

  async asked(project: Project, agent: Agent, req: any) {
    const action = String(req.action ?? "");
    const resources: string[] = Array.isArray(req.resources) ? req.resources.map(String) : [];
    const reply = (body: unknown) => this.team.client().request("POST", `/api/session/${agent.sessionId}/permission/${req.id}/reply`, body).catch(() => {});
    // Image files: refused at once, with what to use instead (never a question for the human).
    const refusal = readRefusal(action, resources);
    if (refusal) {
      await reply({ decision: "reject", message: refusal });
      return;
    }
    // Already answered "always" for this kind of request in this project?
    const allowed = resources.length > 0 && resources.every((r) => project.allowedPatterns.some((a) => a.action === action && wildcardMatch(a.pattern, r)));
    if (allowed) {
      await reply({ decision: "once" });
      await this.team.log(project, { from: "symbio", to: "human", kind: "system", text: `Allowed ${agent.name} to ${action} \`${resources.join("; ")}\` (you chose “always” for this before).` });
      return;
    }
    this.open.set(req.id, {
      id: req.id,
      projectId: project.id,
      agentId: agent.id,
      agentName: agent.name,
      action,
      resources,
      save: Array.isArray(req.save) ? req.save.map(String) : [],
      time: Date.now(),
    });
    this.team.setStatus(project, agent, "waiting");
    await this.team.log(project, { from: agent.id, to: "human", kind: "permission", text: `${agent.name} asks to ${action}: \`${resources.join("; ")}\`` });
    bus.publish({ type: "approvals.updated", projectId: project.id });
  }

  /** The human's answer. "always" also remembers the pattern for this project. */
  async answer(project: Project, requestId: string, decision: "once" | "always" | "reject", note?: string) {
    const pending = this.open.get(requestId);
    if (!pending || pending.projectId !== project.id) throw new Error("That request is no longer open.");
    const agent = project.agents.find((a) => a.id === pending.agentId);
    if (!agent) throw new Error("Agent not found");
    if (decision === "always") {
      for (const pattern of pending.save.length ? pending.save : pending.resources) {
        if (!project.allowedPatterns.some((a) => a.action === pending.action && a.pattern === pattern)) {
          project.allowedPatterns.push({ action: pending.action, pattern });
        }
      }
      await this.team.store.update(project);
      bus.publish({ type: "project.updated", projectId: project.id });
    }
    await this.team.client().request("POST", `/api/session/${agent.sessionId}/permission/${requestId}/reply`, {
      // "always" is remembered by Symbio (per project); OpenCode only needs to let this one through.
      decision: decision === "reject" ? "reject" : "once",
      message: note?.trim() || (decision === "reject" ? "The human denied this." : null),
    });
    this.open.delete(requestId);
    bus.publish({ type: "approvals.updated", projectId: project.id });
  }
}
