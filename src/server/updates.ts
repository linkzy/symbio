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
  {
    id: "2026-10-30-housekeeping",
    text:
      "Daily housekeeping: once a day Symbio checks for work that exists only on this machine (commits on the project's branch or " +
      "helpers' branches that no remote has) and for build outputs piling up in helpers' folders. If it finds either, you get a " +
      "'Symbio housekeeping' message: push work that's ready to share, tell the human if a branch shouldn't go to the remote, and " +
      "free disk space in idle helpers' folders with the new clean_build_outputs tool (it only deletes git-ignored build folders " +
      "like bin, obj and node_modules; work is never touched). Symbio also backs up its own state every day.",
  },
  {
    id: "2026-10-30-shared-folder",
    text:
      "Where helpers work: in a git project a helper can now work in the project folder itself instead of its own copy on its own " +
      "branch. spawn_agent has a workspace option: \"own\" (as before: parallel work, merged with merge_work) or \"shared\" (the " +
      "project folder: what it writes is there at once for you and the next helper; nothing to merge, and it doesn't commit). " +
      "Use shared for step-by-step work where each step uses the previous one's files. Without the option, the project's setting " +
      "applies (the human sets it in Settings; it stays \"own\" unless they change it). A shared helper's finished task arrives for " +
      "review as usual; check its files in the project folder and mark the task done. move_to_project_folder moves an idle helper " +
      "whose work is merged into the project folder (it continues in a fresh session). Background processes now belong to the agent " +
      "that started them: list_processes and stop_process only show and stop your own, even in a shared folder.",
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
