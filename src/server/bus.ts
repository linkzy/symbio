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

class Bus extends EventEmitter<{ ui: [UiEvent] }> {
  publish(event: UiEvent) {
    this.emit("ui", event);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
