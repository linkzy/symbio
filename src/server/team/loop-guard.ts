// Loop guard: stops two agents from bouncing messages forever without the human noticing. Only
// conversation counts (per project, Project.messageLimit); protocol traffic (task assignments,
// asset requests/grants/releases, review reports) comes from real progress and isn't counted.

import { DEFAULT_MESSAGE_LIMIT, type Agent, type Project } from "../store.js";
import type { TeamCore } from "./core.js";

const WINDOW_MS = 30 * 60_000;

export class LoopGuard {
  private traffic = new Map<string, number[]>(); // pair → message times
  private noticed = new Map<string, number>(); // pair → when the human was last told

  constructor(private readonly team: TeamCore) {}

  /** Throws (and tells the human once per window) when the pair is past the limit. */
  async check(project: Project, from: Agent, to: Agent) {
    const limit = project.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
    if (limit <= 0) return;
    const key = [from.id, to.id].sort().join("|");
    const now = Date.now();
    const times = (this.traffic.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (times.length >= limit) {
      if (!this.noticed.has(key) || now - this.noticed.get(key)! > WINDOW_MS) {
        this.noticed.set(key, now);
        await this.team.log(project, {
          from: "symbio",
          to: "human",
          kind: "system",
          text:
            `${from.name} and ${to.name} exchanged ${limit} messages in 30 minutes, so further messages between them are paused ` +
            `until older ones age out. If they're doing real work, raise the limit in the project's Settings → Team.`,
        });
      }
      throw new Error(
        `Too many messages between ${from.name} and ${to.name} in the last 30 minutes (limit ${limit}). ` +
          `Stop the back-and-forth and use ask_human to bring the human in.`,
      );
    }
    times.push(now);
    this.traffic.set(key, times);
  }
}
