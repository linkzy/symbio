// What changed in Symbio, written for the agents. When Symbio starts on a newer version,
// each project's coordinator gets the entries it hasn't seen as a note in its conversation
// (it isn't woken up for it), and the human sees the same list in Messages.
//
// Add an entry whenever a change affects how agents work: tools, rules, messages they
// receive, what Symbio does on their behalf. Ids never change; keep the newest last.

export interface AgentUpdate {
  id: string;
  /** For the coordinator: what changed and what it means for its work. */
  text: string;
}

export const AGENT_UPDATES: AgentUpdate[] = [
  {
    id: "2026-10-30-free-assets",
    text:
      "Shared assets: when a helper requests an asset nobody holds and nobody else is waiting for, Symbio grants it immediately " +
      "and you only get a note. You still decide when there's contention (someone holds it or others are waiting): then the request " +
      "comes to you as before. A release with nobody waiting is also just a note; you're woken only if someone is waiting.",
  },
  {
    id: "2026-10-30-message-limit",
    text:
      "Message limit: only conversation between two agents counts now (task assignments, asset traffic and review reports don't). " +
      "The human sets the limit per project (default 20 per 30 minutes) and is told when it blocks someone.",
  },
  {
    id: "2026-10-30-fresh-sessions",
    text:
      "Fresh sessions: a long-running agent can continue in a new session (the human's New session button, or automatically after " +
      "each merged task if the project is set so). It keeps its name, folder, branch, tasks and assets, and starts from a handoff " +
      "note (its open tasks, recent work, latest messages). So a helper may not remember details of earlier tasks: put what matters " +
      "in task descriptions and in the project docs rather than relying on its memory.",
  },
  {
    id: "2026-10-30-rename",
    text: "Renaming: the human can rename helpers. You'll get a note; the old name keeps working, but use the new one.",
  },
  {
    id: "2026-10-30-usage",
    text:
      "Costs are visible: the human now sees tokens and estimated cost per agent and model. Prefer cheaper allowed models for simple " +
      "work (spawn_agent's model parameter) and keep the most capable ones for hard tasks.",
  },
];

/** Entries a project hasn't been told about yet. */
export function unseenUpdates(seen: string[] | undefined): AgentUpdate[] {
  const known = new Set(seen ?? []);
  return AGENT_UPDATES.filter((u) => !known.has(u.id));
}

export function updatesNote(updates: AgentUpdate[]): string {
  return [
    `Symbio update: Symbio was updated, and ${updates.length === 1 ? "this changes" : "these change"} how the team works:`,
    ...updates.map((u) => `- ${u.text}`),
    "Take it into account from now on. If any of it affects this project's plan or how you've organized the work, tell the human.",
  ].join("\n");
}
