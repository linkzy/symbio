// Helpers that go quiet: a helper given work by core owes it a report (update_task, a message to
// core, a question to the human). If it ends its turn without one, it's reminded once, and if it
// stays quiet core is told, instead of the work stalling unseen (seen with smaller models).

import type { Agent, MessageKind, Project } from "../store.js";
import type { TeamCore } from "./core.js";

// Checked after this pause, since more turns may be queued.
const GRACE_MS = Number(process.env.SYMBIO_QUIET_HELPER_SECONDS ?? 20) * 1000;

export class QuietHelpers {
  /** Helpers given work by core that haven't reported since. */
  private owed = new Map<string, { nudged: boolean; timer: NodeJS.Timeout | null }>();

  constructor(private readonly team: TeamCore) {}

  /** Work from core starts a report owed by the helper; its own messages to core settle it. */
  track(from: Agent, to: Agent, kind: MessageKind) {
    if (from.role === "coordinator" && to.role === "worker" && (kind === "request" || kind === "blocking" || kind === "urgent")) {
      this.reported(to);
      this.owed.set(to.id, { nudged: false, timer: null });
    } else if (from.role === "worker" && to.role === "coordinator" && !kind.startsWith("asset-")) {
      this.reported(from);
    }
  }

  /** Nothing owed any more (it reported, the human took over, it was stopped…). */
  reported(agent: Agent) {
    const owed = this.owed.get(agent.id);
    if (owed?.timer) clearTimeout(owed.timer);
    this.owed.delete(agent.id);
  }

  /** After a helper's turn: if it still owes a report, check again shortly. */
  afterTurn(project: Project, agent: Agent) {
    const owed = this.owed.get(agent.id);
    if (!owed) return;
    if (owed.timer) clearTimeout(owed.timer);
    owed.timer = setTimeout(() => void this.check(project.id, agent.id).catch((err) => console.error("[quiet helper]", err.message)), GRACE_MS);
    owed.timer.unref?.();
  }

  /**
   * A helper still owing a report: nudge it once; if it stays quiet, tell core. Not while it waits
   * on something real: the human, a shared asset, messages on their way.
   */
  async check(projectId: string, agentId: string) {
    const owed = this.owed.get(agentId);
    const project = this.team.store.list().find((p) => p.id === projectId);
    const agent = project?.agents.find((a) => a.id === agentId);
    if (!owed || !project || !agent) return;
    owed.timer = null;
    if (agent.status !== "idle" || project.paused || this.team.shuttingDown) return;
    if (this.team.hasQueuedMessages(agent)) return;
    if ((await this.team.assets(project)).list().some((a) => a.queue.some((q) => q.agentId === agent.id))) return;
    const tasks = (await this.team.plan(project)).plan.tasks.filter((t) => t.assignee === agent.id);
    const open = tasks.find((t) => t.status === "in-progress");
    if (tasks.length && !open) return this.reported(agent); // its tasks are in review, blocked or done
    const coordinator = this.team.coordinator(project);
    const core = coordinator?.name ?? "the coordinator";
    const what = open ? ` (${open.id} "${open.title}")` : "";
    if (!owed.nudged) {
      owed.nudged = true;
      await this.team.system(
        project,
        agent,
        `Symbio: you ended your turn without reporting to ${core} on the work you were given${what}. If it's done, report it now: ` +
          (open ? `update_task("${open.id}", "review", <summary>)` : `send_message to ${core} (what you did, and where)`) +
          ". If you're blocked or waiting on something, say so the same way. If you're still working on it, carry on.",
      );
      return;
    }
    this.reported(agent);
    if (!coordinator || coordinator.status === "stopped") return;
    await this.team.system(
      project,
      coordinator,
      `Symbio: ${agent.name} has gone quiet: it ended its turn without reporting on the work you gave it${what}, even after a reminder. ` +
        `Check on it (send_message), or look at its chat; its work so far is in ${agent.branch ? `its own copy (branch ${agent.branch})` : "the project folder"}.`,
    );
  }
}
