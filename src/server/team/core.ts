// What the team's parts (the other files in this folder) may use of the Team: its store, the
// OpenCode client and runtime, and the few primitives every part needs. Parts depend on this,
// not on the Team class, so their dependencies stay explicit and there are no import cycles.

import type { AssetRegister } from "../assets.js";
import type { OpencodeClient } from "../opencode/client.js";
import type { OpencodeRuntime } from "../opencode/runtime.js";
import type { PlanStore } from "../plan.js";
import type { Agent, MessageKind, Project, Store } from "../store.js";

export interface TeamCore {
  readonly store: Store;
  readonly runtime: OpencodeRuntime;
  /** Set when Symbio itself is shutting down on purpose. */
  readonly shuttingDown: boolean;
  /** The OpenCode client; throws when OpenCode isn't running. */
  client(): OpencodeClient;
  /** Adds an entry to the project's message log (Messages tab). */
  log(project: Project, m: { from: string; to: string; kind: MessageKind; text: string }): Promise<void>;
  /** A message from Symbio to an agent: wakes it (`wake`), or is only added to its conversation. */
  system(project: Project, agent: Agent, text: string, wake?: boolean): Promise<void>;
  /** Adds a line to an agent's conversation without starting a turn or logging it (the caller logs). */
  note(project: Project, agent: Agent, text: string): Promise<void>;
  /** A message between agents: logged, delivered (it wakes the recipient), loop-guarded. */
  deliver(project: Project, from: Agent, to: Agent, kind: MessageKind, text: string, opts?: { protocol?: boolean }): Promise<void>;
  setStatus(project: Project, agent: Agent, status: Agent["status"]): void;
  /** A message from the human to an agent (what they type in its chat). */
  sendFromHuman(project: Project, agent: Agent, text: string, urgent?: boolean): Promise<void>;
  /** With "after-task" renewal, a helper with no other task under way gets a fresh session. */
  renewAfterTask(project: Project, agent: Agent, reason: string): Promise<boolean>;
  /** Tells the browser the plan changed. */
  planChanged(project: Project): void;
  coordinator(project: Project): Agent | undefined;
  assets(project: Project): Promise<AssetRegister>;
  /** Tells the browser the shared assets changed. */
  assetsChanged(project: Project): void;
  agentName(project: Project, agentId: string): string | undefined;
  plan(project: Project): Promise<PlanStore>;
  setModel(project: Project, agent: Agent, model: string): Promise<void>;
  renewSession(project: Project, agent: Agent, reason: string): Promise<void>;
  /** Open interactive questions (OpenCode forms) the agent is waiting on. */
  forms(agent: Agent): Promise<any[]>;
  /** Messages from other agents still on their way to this agent (queued in OpenCode). */
  hasQueuedMessages(agent: Agent): boolean;
  /** Agents with an open interactive question (agentId → tool call id). */
  readonly pendingQuestion: Map<string, string>;
}

export const active = (a: Agent) => a.status !== "stopped";
