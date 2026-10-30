// Fan-out of events to connected browser clients.

import { EventEmitter } from "node:events";

export type UiEvent =
  | { type: "runtime"; state: string; version: string | null; error: string | null }
  | { type: "project.updated"; projectId: string }
  | { type: "prices.updated" }
  | { type: "remote.updated" }
  | { type: "assets.updated"; projectId: string }
  | { type: "plan.updated"; projectId: string }
  | { type: "approvals.updated"; projectId: string }
  | { type: "agent.status"; projectId: string; agentId: string; status: string }
  | { type: "agent.stream"; projectId: string; agentId: string; event: { type: string; data: any } }
  | { type: "message"; projectId: string; message: unknown };

// Recent events are also kept, numbered, for clients that can't hold a stream open (some
// proxies, like Cloudflare quick tunnels, don't pass Server-Sent Events): they poll instead.
const KEEP = 5000;

class Bus extends EventEmitter<{ ui: [UiEvent] }> {
  private seq = 0;
  private recent: { seq: number; event: UiEvent }[] = [];

  publish(event: UiEvent) {
    this.seq++;
    this.recent.push({ seq: this.seq, event });
    if (this.recent.length > KEEP) this.recent.splice(0, this.recent.length - KEEP);
    this.emit("ui", event);
  }

  get lastSeq() {
    return this.seq;
  }

  /** Events after `after`; `gap` when some were already dropped (the client should refresh). */
  since(after: number): { seq: number; events: UiEvent[]; gap: boolean } {
    const first = this.recent[0]?.seq ?? this.seq + 1;
    return {
      seq: this.seq,
      events: this.recent.filter((r) => r.seq > after).map((r) => r.event),
      gap: after < first - 1 && after < this.seq,
    };
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
