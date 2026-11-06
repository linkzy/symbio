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
  {
    id: "2026-11-03-tool-catalog",
    text:
      "Finding Symbio's tools: OpenCode sometimes posts a \"tool catalog has changed\" notice that lists only its own tools and says " +
      "the catalog is complete. Symbio's tools are still there: call them inside execute as tools.symbio.<name>(…), or find them " +
      "with search({ namespace: \"symbio\" }). Never conclude they're gone without calling one; if a call really fails, tell the " +
      "human what the error said.",
  },
  {
    id: "2026-11-05-rules-register",
    text:
      "Rules register: a project can keep a register of its rules (requirements, decisions, constraints), each with its source, " +
      "a literal excerpt, who imposes it, how confirmed it is and whether the work meets it; the human browses it in the Docs tab. " +
      "It's on only when the human turns it on in the project's Settings (new projects have it on by default); then your " +
      "instructions explain the tools (list_rules, save_rule, save_rule_area, save_rule_source). Until then, nothing changes.",
  },
  {
    id: "2026-11-05-conversation-size",
    text:
      "Keep conversations small: whatever an agent reads stays in its conversation and is sent to the model again every turn. " +
      "Reading several full-size images made a coordinator's conversation too large to send at all (\"Timed out reading request " +
      "body\"), whatever the model. So reading image files directly is now refused: look at images with the new view_image tool " +
      "(a scaled-down copy; ask for a crop to see details at full resolution). Read only the part of a big file you need, and " +
      "leave reviewing many images to a helper. If a conversation still becomes too large, Symbio moves that agent to a fresh " +
      "session with a handoff note instead of trying other models.",
  },
  {
    id: "2026-11-06-credentials",
    text:
      "Credentials, clarified: the old rule \"never look for credentials or put secrets in commands\" was meant for Symbio's own " +
      "secrets (its vault, connections, SSH keys), and it stopped agents from doing legitimate work. Now: Symbio's secrets stay " +
      "off-limits (use connections only through the tools). The project's own credentials (connection strings, .env, Web.config…) " +
      "and credentials the human gives you may be used for the task, e.g. querying a database the work needs. Don't spread them: " +
      "never put one into anything committed or shared (new files, docs, the rules register, the plan, messages to other agents), " +
      "and prefer commands that read it from the config file. If the human says a system is a read-only mirror or production, only " +
      "read from it unless they explicitly OK changes. If you refused such a task before, you can do it now.",
  },
  {
    id: "2026-11-06-azure-devops",
    text:
      "Azure DevOps connections: the human can now add an Azure DevOps organization (with a personal access token) in Settings and " +
      "enable it per project. git_push and git_pull work with it (HTTPS remotes of that organization; SSH remotes must be switched to " +
      "HTTPS), and the new azure_devops_api tool calls its REST API, e.g. to open a pull request after pushing the branch. Reading " +
      "(GET) never needs approval. If a push or a pull request failed for lack of credentials, ask the human to add the connection.",
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
