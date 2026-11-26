// What changed in Symbio, written for the agents. When Symbio starts on a newer version,
// each project's coordinator gets the entries it hasn't seen as a note in its conversation
// (it isn't woken up for it), and the human sees the same list in Messages.
//
// Add an entry whenever a change affects how agents work: tools, rules, messages they
// receive, what Symbio does on their behalf. Ids never change; keep the newest last. An entry
// whose change asks for action in some projects can add a task: those coordinators are woken with it.

import { swallowedRepositories } from "./repos.js";
import type { Project } from "./store.js";

export interface AgentUpdate {
  id: string;
  /** For the coordinator: what changed and what it means for its work. */
  text: string;
  /** When the change asks for action in this project: a message that wakes the coordinator up with it. */
  task?: (project: Project) => Promise<string | null>;
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
  {
    id: "2026-11-09-attachments",
    text:
      "Attachments and documents: the human can now attach files to a message (upload, drag and drop, paste). They arrive as full " +
      "paths below the message and are kept in the project (.symbio/attachments; the human sees them in the Files tab), so you can " +
      "come back to them. Look at images with view_image; read documents (PDF, Word, Excel, PowerPoint) with the new read_document " +
      "tool, which returns their text a part at a time. Reading PDFs with the read tool is now refused like images: it would put the " +
      "whole file in your conversation.",
  },
  {
    id: "2026-11-09-multi-repo",
    text:
      "Folders of several git repositories (e.g. client/ and server/, each with its own remote, in a folder that isn't a repository " +
      "itself) are now handled as such: spawn_agent takes repo (the helper gets its own copy of that repository, and merge_work merges " +
      "into it), and git_push / git_pull from the project folder take repo. Never git init the project folder over them.",
    async task(project) {
      if (project.subRepositories !== undefined) return null;
      const { inner, createdBySymbio } = await swallowedRepositories(project.directory);
      if (!inner.length) return null;
      return (
        `Symbio update, for this project: the project folder is a git repository that contains other repositories (${inner.join(", ")}) ` +
        `without their files${createdBySymbio ? " (Symbio created it on top of them when the project was added)" : ""}. So far helpers' own ` +
        "copies had those repositories as empty folders, their commits went to the outer repository, and pushes had no remote of their own. " +
        "Symbio can now work in each inner repository instead.\n\n" +
        "Look at it with sub_repositories (action check). If the outer repository was created by Symbio and has no remote, switch on " +
        "your own (action use): nothing on disk changes and it can be switched back. Before switching, bring any unmerged work of helpers " +
        "with their own copy of the outer repository into the project (merge_work), then move them to the project folder or stop them. " +
        "Don't interrupt work in progress: if helpers are busy, do it once they've finished. Then tell the human in a sentence or two what " +
        "changed for them. If instead the outer repository has a remote or wasn't created by Symbio, someone may rely on it: explain the " +
        "situation to the human briefly and ask whether to switch."
      );
    },
  },
  {
    id: "2026-11-12-quiet-helpers",
    text:
      "Helpers that go quiet: when a helper you gave work to ends its turn without reporting (no update_task, no message to you), " +
      "Symbio reminds it once; if it still doesn't report, Symbio tells you it has gone quiet, so check on it. Waiting for a shared " +
      "asset or for the human doesn't count as going quiet.",
  },
  {
    id: "2026-11-12-chat-modes",
    text:
      "Chat modes: the human can now choose how you handle their messages, with a selector in your chat box. A message in Plan " +
      "or Act mode ends with a [Mode: …] note. Plan: discuss, study and propose, but start nothing; Symbio refuses creating " +
      "helpers, assigning tasks, merging, pushing and editing files until the human switches mode (reading and read-only commands " +
      "still work). Act: the human wants it done without a plan to approve, so do it or delegate it right away and report. No " +
      "note means Auto, as before.",
  },
  {
    id: "2026-11-12-human-review",
    text:
      "Review guides and the human's review: helpers now report a task for review with a guide (update_task guide=…): where to look " +
      "(URLs, files or folders), the steps to check it and what should be seen, and whether they ran it themselves. Ask helpers " +
      "for one. The human can choose, per project, to review the work themselves (Settings → Team → Who reviews the work): then a " +
      "task you merge or mark done waits in their \"To review\" list with its guide, and is done only when they approve it; tasks " +
      "that depend on it wait meanwhile. If they send it back, their note goes straight to the helper and you're told. When they " +
      "review, don't send them review lists in the chat: the list and the guides are in Symbio. Your brief says which applies.",
  },
  {
    id: "2026-11-12-marked-review",
    text:
      "Tasks marked for the human's review: a project can be set so the human reviews only some tasks (Settings → Team → Who " +
      "reviews the work → marked tasks). Then mark those tasks with review: true in submit_plan or add_task (e.g. the " +
      "checkpoints of a pipeline; ask the human when unsure); the human can change the marks in the Plan tab. Only marked tasks " +
      "wait for their approval. The human can also see each task's changed files and diffs in Symbio, so you don't need to " +
      "list them in the chat.",
  },
  {
    id: "2026-11-12-own-tools-and-ftp",
    text:
      "The project's own tools come first: if the project already has a way to deploy or publish (a script, a configured CLI, " +
      "a task in its build files), run it like any other command; don't ask the human for a connection for it. When the human " +
      "asks for the deploy, that is their OK for changing production. Connections are for when the project has no access of " +
      "its own; they can now also be FTP accounts (FTP or FTPS): remote_upload replaces files that are there, and remote_exec " +
      "runs FTP file operations (ls, mkdir, rm, rmdir, mv; not shell commands). Tell your helpers " +
      "if one of them is waiting on a connection for something the project's own script can do.",
  },
  {
    id: "2026-11-13-open-questions",
    text:
      "Questions for the human now go to their list, not the chat: ask_human adds one question per call (with context, options " +
      "when there are clear ones, the task, and whether work is blocked on it) to their open questions in Needs you, numbered " +
      "Q1, Q2…; they answer when they can, often several at once, and the answers arrive as one message. Asking what's already " +
      "open is refused. list_questions shows them; close_question records an answer they gave in the chat, or drops one that's no " +
      "longer needed. Don't put questions for them in the chat or re-list pending ones (one short clarifying question in a reply to " +
      "their own message is fine). If questions of yours are still waiting for an answer in the chat, add each with ask_human now. " +
      "And replies to helpers' reports stay short: act on them, then one line on what changed at most; the human may be away.",
  },
  {
    id: "2026-11-13-files-in-chat",
    text:
      "Files in the chat: share_file(path, caption) shows the human a file you or a helper made (an image, a video, a report, a " +
      "page) right in the chat, played or displayed in place or with a download button, and in the Files tab. Use it instead of " +
      "giving a path they must go and find. Paths of project files written in replies, guides, questions and reports now " +
      "become links that open the file (Markdown formatted, at the line mentioned), so write them out in full. Tell your " +
      "helpers when you next write to them.",
  },
  {
    id: "2026-11-13-core-models",
    text:
      "Models for core and for helpers: a project can now keep some models for core only, and let core use only some (the human " +
      "sets this in Settings → Models). spawn_agent refuses a core-only model for a helper and, without a model, starts helpers on " +
      "one they may use; your instructions list the models helpers may use. Also, the human's answers to questions and their " +
      "notes when sending a task back can come with files: they arrive as attachments, like files sent in the chat.",
  },
  {
    id: "2026-11-14-human-helpers",
    text:
      "The human can now create helpers themselves (the + in the team list), to talk to directly in their own chat. You're told " +
      "when they do. Those helpers are part of the team (they follow the shared-asset rules, and you can see them in list_team), " +
      "but don't give them work unless the human asks you to.",
  },
  {
    id: "2026-11-17-agent-runtimes",
    text:
      "A project's agents can now run on GitHub Copilot CLI as well as OpenCode (the human chooses), and the human can move a " +
      "project from one to the other. If that happens, you get one last turn to write your own handoff, then every agent continues " +
      "in a new session on the other runtime from a handoff note, with its name, folder, branch, tasks and assets. Tool names and " +
      "behavior differ between runtimes, and background processes are stopped by the move: start again the ones you need.",
  },
  {
    id: "2026-11-19-model-pins",
    text:
      "Helpers can be pinned to their model: when it fails, a pinned helper waits and retries the same model (pauses growing up " +
      "to 10 minutes) instead of being switched to another allowed model. spawn_agent takes pin_model, and pin_model pins or " +
      "unpins a helper; use it when the human wants a specific model for the work. The human can pin from the helper's chat, " +
      "and only they can unpin what they pinned. list_team shows pins.",
  },
  {
    id: "2026-11-19-reasoning-effort",
    text:
      "Reasoning effort: many models can think less or more (low, medium, high…). The human can set a level per model in the " +
      "project's settings and per agent from its chat. spawn_agent takes effort, and set_effort changes a helper's level (or " +
      "'default' for the project's setting); a level the model doesn't take is refused with the ones it does. Higher levels cost " +
      "more tokens: save them for hard work. You can't change a level the human set. list_team shows each agent's level.",
  },
  {
    id: "2026-11-19-no-ai-coauthors",
    text:
      "Commits: unless the human allows it in the project's settings, commit messages must not have Co-authored-by (or similar) " +
      "lines naming an AI tool or model. On GitHub Copilot CLI, Symbio also turns off the line Copilot adds by itself.",
  },
  {
    id: "2026-11-20-machine-load",
    text:
      "This computer: programs agents start now run at low priority, so the machine stays usable. Your brief says how big the " +
      "machine is; on a small one, run heavy jobs (3D tools, builds, browsers, simulations) one at a time across the team. When " +
      "the machine is overloaded, Symbio tells the human and core (with the heaviest programs) and may hold messages between " +
      "agents until it recovers. core: list_programs shows the load and the programs agents started; stop_program stops one by pid.",
  },
  {
    id: "2026-11-20-path-opencode",
    text:
      "The human can opt in, in Settings → Agent runtimes, to running an OpenCode found on this computer's PATH instead of " +
      "Symbio's tested copy. When that happens your runtime may be a different version: if an API behavior looks unfamiliar, " +
      "tell the human which OpenCode version is in use.",
  },
  {
    id: "2026-11-21-approvals-allow",
    text:
      "Connection approvals: the human can now approve a request and let you use that connection without asking for a while, " +
      "or always allow plain server commands like it (list_connections shows them). On a connection that needs approval, " +
      "group the commands you need into one remote_exec (one per line, or with &&) so the human approves once.",
  },
  {
    id: "2026-11-21-program-owners",
    text:
      "list_programs now says which project and agent started each program (and it no longer lists system programs by mistake). " +
      "The human sees the same in the machine view: when you leave a server or a tunnel running on purpose, say so in your report, " +
      "and stop what you no longer need.",
  },
  {
    id: "2026-11-23-glossary-done-when",
    text:
      "Three changes in how you lead. (1) Every project keeps a glossary (docs/glossary.md, or glossary.md in private docs): " +
      "the project's terms, what each means and the words not to use. You keep it (start it now if this project has none, from " +
      "what you know so far); Symbio gives it to every agent with their instructions. When two words are used for one thing, ask " +
      "the human which to keep. (2) Tasks have a Done when (done_when in submit_plan, add_task, and update_task to change it): " +
      "the checks that tell the work is finished, specific enough for someone who didn't do it. Write one for every new task; " +
      "helpers report against it, and the human sees and can edit it on the board. (3) When the human gives an agent a fresh " +
      "session, they can ask it to write its own handoff first: if you're asked, answer with what you're in the middle of, " +
      "decisions and what isn't written anywhere yet.",
  },
  {
    id: "2026-11-23-skills",
    text:
      "Skills: packaged methods an agent loads with its skill tool when a task matches one. You have Symbio's skills for leading " +
      "(briefing, glossary, handoff, review); the human can change them in the project's settings. Give each helper the skills its " +
      "work needs: spawn_agent takes skills, set_skills changes them, list_skills shows the ones you may give (the human chooses " +
      "which). Agents only have the skills they're given.",
  },
  {
    id: "2026-11-24-checks-reviewers",
    text:
      "Checks and reviewers. A project can have checks: commands Symbio runs itself in a helper's folder when it reports a task " +
      "and before merge_work (a build, tests, a spellcheck…). A failing check sends the task back to the helper with the output; " +
      "you only get reports whose checks passed, and merge_work refuses when they fail on changed work (force overrides it, and " +
      "the human is told). Propose useful checks with propose_check; the human approves them. For big or risky tasks, " +
      "request_review starts a reviewer: a fresh, one-off helper that checks the task against its Done when, the rules and the " +
      "glossary without changing anything; its findings go back to the helper, its verdict comes to you. The human can require " +
      "a reviewer for every task; then reports reach you once it passed.",
  },
  {
    id: "2026-11-24-briefings",
    text:
      "Briefings: for a request that is new, big, risky or vague, ask the questions about it together with start_briefing (your " +
      "briefing skill has the method) instead of one by one among other subjects; the human can ask for one too. They're grouped " +
      "in Needs you, and the answers arrive together once all are in, written by Symbio to the feature's spec (docs/specs/). " +
      "Complete the spec, summarize it to the human, and link the feature's tasks to it with spec (submit_plan, add_task, " +
      "update_task): helpers get it with the task, and reviewers check against it.",
  },
  {
    id: "2026-11-24-evidence",
    text:
      "Evidence: share_file takes a tag (evidence, report, other) and a task_id. Helpers share what shows a task's work was done " +
      "as evidence; the task lists it, reviewers get it, and the human filters the Files tab by it. list_shared_files finds the " +
      "team's shared files by task and tag.",
  },
  {
    id: "2026-11-24-skills-library",
    text:
      "More skills: the library now has categories (planning, software, design, writing, data, operations, media) and about 25 " +
      "skills, Symbio's own and popular ones by other authors (grilling, brainstorming, writing-plans, write-spec, tdd, code-review, " +
      "systematic-debugging, frontend-design, server-administration, video-production, research-method…). list_skills shows them " +
      "by category. After a briefing or when planning, give each helper the skills its task benefits from, without asking the " +
      "human; when none fits a recurring kind of work, write one with create_skill.",
  },
  {
    id: "2026-11-24-autonomy",
    text:
      "How you run the project is now a setting the human chooses: 'Decide and tell me' or 'Ask me and wait' (your instructions say " +
      "which applies). When you decide: submit_plan is approved as you make it; ask_human takes decided (what you do meanwhile, " +
      "shown to the human as a decision to keep or change), and waiting needs a wait_reason. The human can also write what the team " +
      "may do without asking, and whether it may install software; it's in your instructions. They may also choose grilling instead " +
      "of briefings: then you have the grilling skill.",
  },
  {
    id: "2026-11-26-budgets",
    text:
      "Budgets: the human can set a spending limit per project (for the whole project and per day), in the estimated cost of the " +
      "models' use. When one is set, your brief says it. Near a limit Symbio tells you (a note); at the limit it pauses the team, and " +
      "a daily pause ends by itself the next day. Spend where it matters: no extra helpers or expensive models for work that doesn't need them.",
  },
  {
    id: "2026-11-26-scheduled-jobs",
    text:
      "Scheduled jobs: when the human asks for recurring (or one-off) work (\"refresh the data every night\", \"check the site every " +
      "Monday\"), set it up with schedule_job (title, instructions you can start from alone, and when). In a project that asks, the " +
      "human approves it first. When it's due, Symbio wakes you with its instructions; do it, then report the run with report_job. " +
      "list_jobs, change_job and remove_job manage them. Times are the computer's.",
  },
  {
    id: "2026-11-26-parallel-lanes",
    text:
      "Parallel work, and seeing it: after a merge, merge_work's answer lists the tasks that could start now (dependencies done, no " +
      "asset of theirs held) and the helpers with nothing under way. Start what's independent (another part, publishing it) instead " +
      "of queuing it behind the current lane, unless the computer is overloaded. list_team now shows, for each working agent, for how " +
      "long, its last activity and the programs it runs, so a long task can be told from a stuck one. merge_work also no longer blames " +
      "a helper for files it brought in from the project (git merge of the main branch): only its own changes are checked against " +
      "assets. stop_program says whether a program had already ended or isn't an agent's. When a helper works in the project folder, " +
      "commit only your own files (git add <paths>), never git add -A or git commit -a: it would sweep the helper's unfinished work into your commit.",
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
