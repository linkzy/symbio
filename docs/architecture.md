# Architecture

Symbio is a local web app that runs a team of AI agents (on OpenCode or GitHub Copilot CLI) on a project. You scope the work
with a lead agent (**core**), it plans and splits the work across helper agents only when that
helps, and you watch and steer everything from the browser.

## Principles

- **Domain-neutral.** A project is a folder plus a goal: software, writing, research, design, data
  work, operations. Symbio never assumes roles ("backend agent") or asset types ("the database").
  core decides how to organize the work; Symbio only provides mechanisms (messaging, isolation,
  asset ownership, safety).
- **Real events, not summaries.** The UI (status, kanban, inbox) is built from the runtimes' events and
  Symbio's own records, never from asking a model what happened.
- **The human is never bypassed.** Questions, plan approval, permission requests, remote actions and
  model failures surface in the UI; nothing waits silently. When the human lets core decide, its
  decisions still show in Needs you, to keep or change.
- **Plain files.** State is JSON/JSONL on disk, easy to inspect. The native dependencies are the OS
  keyring binding (secret vault) and `sharp` (scaling images for `view_image`), both with prebuilt
  binaries.

Non-goals for now: multiple users, remote hosting.

## Overview

```
Browser UI (React)  ⇄  Symbio server (Node, Hono)  ⇄  opencode serve (OpenCode v2 HTTP API)
     REST + SSE         team · store · bus · MCP           sessions = agents
                              ⇅
                    git worktrees, SSH, GitHub/Azure DevOps APIs
```

- **Agents run on OpenCode or GitHub Copilot CLI,** chosen per project (`Project.runtime`; each agent
  keeps the runtime it was created on, `Agent.runtime`). The team logic talks to both through one
  interface, `AgentRuntime` (`runtime/types.ts`), and the chat reads one event and history
  vocabulary. Copilot runs through the Copilot SDK in Symbio's own Copilot folder
  (`~/.symbio/copilot`); see [copilot-api.md](copilot-api.md). **Each runtime starts when something
  needs it** (an agent to wake, a project's page, New project's models, Settings), and at launch only
  if agents left active run on it. The rest of this page describes OpenCode, the default.
- **Symbio ships no runtime** (`runtime/install.ts`). The human installs the ones they use (the
  first-run cards on the Projects page, or Settings → Agent runtimes): Symbio runs
  `npm install <package>@<version>` into `~/.symbio/runtimes/<kind>`, the version being its own dev
  dependency (what it's developed and tested with), and records where the runtime starts in
  `runtime.json`; removing it deletes the folder. A runtime is found, in order: an environment
  variable (`SYMBIO_OPENCODE_BIN`, `SYMBIO_COPILOT_SDK`), an OpenCode on the PATH when the human opts
  in (Settings → Agent runtimes, stored in `~/.symbio/runtime-settings.json`), Symbio's copy, or a
  development checkout's `node_modules`. By default no PATH executable is used, and the Copilot SDK
  is never resolved from PATH. New projects can only pick an installed runtime; one that existing
  projects use but that's missing (Symbio used to ship OpenCode) is installed at startup.
- **OpenCode is the default runtime.** Symbio starts its *own* private `opencode serve`: a random port,
  a random `OPENCODE_SERVER_PASSWORD`, Basic auth user `opencode`, in `--stdio` mode so the password
  doesn't reach agents' shells and the server exits with Symbio. It doesn't touch any other
  OpenCode instance you run.
- **One agent = one OpenCode session**, with `location.directory` set to the agent's working folder
  (the project root for core and shared helpers, a git worktree for a helper with its own copy) and
  its own model.
- **Symbio is the post office.** Every agent-to-agent and agent-to-human message goes through
  Symbio, is logged to `messages.jsonl`, and is delivered with `session.prompt` (`delivery: queue`,
  or `steer` for urgent messages). Delivery wakes the agent; OpenCode's per-session inbox queues
  messages while it's busy.
- **Agents use Symbio through tools.** Symbio hosts a small MCP server (`/mcp/<token>`) and
  registers it with OpenCode for each working folder. The caller is identified by the session ID
  OpenCode sends with every call, and the tool set depends on the role. See
  [agent-protocol.md](agent-protocol.md).
- **The browser talks to Symbio only,** with the UI key on every request (see [security.md](security.md)):
  REST under `/api` and one SSE stream (`/api/events`) that
  carries Symbio's own events plus the live output of agents.

## Server modules (`src/server/`)

| Module | Responsibility |
|---|---|
| `index.ts` | Startup: store, connections, the runtimes (started when needed), team, HTTP server, static UI, shutdown |
| `api.ts` | REST routes for the UI |
| `bus.ts` | In-process event bus feeding the UI's SSE stream (and the polling fallback) |
| `origin.ts` | Host/Origin checks on every request (against DNS rebinding and cross-site requests) |
| `ui-token.ts` | The UI key (`~/.symbio/ui-token`) every API request must carry |
| `store.ts` | Projects and agents on disk (`~/.symbio/config.json`, `<project>/.symbio/`) and the message log |
| `team.ts` | The heart: creating, stopping and restarting agents, delivering messages, status, pause/resume, routing the runtime's events, and the wiring of its parts. The parts live in `team/` and use the `TeamCore` interface (`team/core.ts`), or a host interface naming the few more things they need (`SessionsHost`, `TaskFlowHost`, `VerifyHost`, `MachineWatchHost`) |
| `team/asset-protocol.ts` | The shared-asset protocol: request (free ones granted at once), grant, deny, release |
| `team/sessions.ts` | Fresh sessions: a new session for an agent with its identity kept, the handoff note Symbio writes from its records, the agent's own handoff (a last turn, when the human asks for it or a runtime switch does), and the fresh session after a task |
| `team/tasks.ts` | The plan's task flow: proposing and deciding the plan (approved as made when the project lets core decide), adding and assigning tasks (with their *Done when* and spec), a helper's report (`update_task`), merging a helper's work |
| `team/effort.ts` | Reasoning effort: the levels each model takes, the level a session runs at, changing it (the human's or core's) |
| `team/machine-watch.ts` | The load guard's side of the team: telling the human and core about an overloaded machine, delivering held messages after, and who started each program |
| `team/watchdog.ts` | Hung agents interrupted and told why, OpenCode restarted before its memory makes it crash, interrupted agents woken after a restart |
| `team/switch.ts` | Moving a project to another runtime: progress (the `runtime.switch` event), the handoff request |
| `team/fallback.ts` | Failing providers: switch to the next allowed model (or, for a pinned agent, wait and retry its own), a fresh session when the conversation is too large, resuming stuck agents |
| `team/review.ts` | The human's review of finished tasks (`reviewBy`): the gate on done, approve, send back |
| `team/verify.ts` | Between a helper's report and core: the project's checks (on reports and before merges) and reviewers (one-off helpers, by core's request or on every task); what fails goes back to the helper |
| `team/questions.ts` | The team's open questions for the human: asking (repeats refused; in a project that lets core decide, a decision to keep or change), answering several at once, setting aside; briefings (answered together, written as the feature's spec) |
| `team/quiet-helpers.ts` | Helpers that end their turn without reporting: reminded once, then core is told |
| `team/permissions.ts` | The runtimes' permission requests: answered from known rules, or held for the human |
| `team/housekeeper.ts` | The hourly and daily housekeeping run (see `housekeeping.ts`) and its reports |
| `team/usage.ts`, `team/processes.ts`, `team/loop-guard.ts` | Token usage per agent; agents' background processes; the message limit between two agents |
| `schedule.ts`, `team/schedules.ts` | Scheduled jobs: their schedules (next run, in words, checked), kept in `.symbio/schedules.json`; running them when due (core woken with the job), skipping and reporting |
| `team/budget.ts` | Spending limits per project: warnings near a limit, the team paused at it, a daily pause ended by a new day, a raised limit resuming the team |
| `tools.ts` | The MCP tools agents call (worker and coordinator sets) |
| `mcp.ts` | Minimal MCP server (Streamable HTTP, JSON responses) |
| `prompts.ts` | The briefs given to core and helpers |
| `updates.ts` | Agent-facing notes about what changed in Symbio, given once to each coordinator after an update |
| `machine.ts` | This computer: agents' work at below-normal priority (the runtime's process, inherited by what it starts), the programs agents started (under a runtime's shells, tracked after their parent exits, with who started each) to list and stop by pid, and the load guard (CPU and free memory sampled every 15 s; overloaded → the human and core are told, and messages between agents wait if the human chose so). Settings in `machine.json` |
| `housekeeping.ts` | Daily: backups of Symbio's state (`~/.symbio/backups`), commits no remote has, build outputs piling up in helpers' folders |
| `plan.ts` | The plan and its tasks (`plan.json`) |
| `checks.ts` | Project checks: validating the human's, running them in a folder (shell, low priority, time limit, process tree stopped past it), what a helper is told when they fail |
| `questions.ts` | The team's questions for the human and their answers (`questions.json`), and briefings (`briefings.json`) |
| `costs.ts` | Token usage per agent and model, model prices (`~/.symbio/prices.json`, and the runtimes' catalogs: `Pricing`) and estimated cost |
| `assets.ts` | Shared-asset register: holders, queues, history, merge-time checks (`assets.json`) |
| `workspaces.ts` | Where helpers work: git worktrees (create, merge, sync, remove, restore) or the shared project folder |
| `repos.ts` | Folders of several git repositories: finding them, which one a helper or a push works in, and a repository created on top of others (which a project can switch away from: `subRepositories`) |
| `git.ts` | Thin git wrapper |
| `inspect.ts` | Deterministic folder inspection for onboarding (no model cost) |
| `files.ts` | Project files for the browser: finding a path the way an agent meant it (its own copy first, then the project, then helpers' copies), serving it (with ranges), listing a folder for the Explorer tab (`listDir`), and the files agents shared (`share_file`, `.symbio/shared-files.json`, with their tag and task) |
| `attachments.ts` | Files the human attaches in the chat: stored in `.symbio/attachments` with an index (the Files tab), and the note telling the agent where they are and how to open them |
| `documents.ts` | `read_document`: text from PDF (`unpdf`), Word, Excel, PowerPoint and OpenDocument files (unzipped with `fflate`), a part at a time |
| `images.ts` | `view_image`: scaled-down copies of images (or full-resolution crops) for agents |
| `rules.ts` | The rules register (`docs/rules.json`, or `rules.json` in private docs): validated writes, one at a time, ids that are never reused |
| `docs.ts` | Project documentation (in the project, or private under `.symbio/docs`): list, read, write, search; the glossary |
| `skills.ts` | Skills: Symbio's (`skills/` in the package: its own and vetted third-party copies, with categories and credits in `skills/catalog.json`) and the human's library (`~/.symbio/skills`), others found on this computer (to add a copy of), creating, importing and removing. Each runtime is told an agent's skills (`setSkills`): OpenCode as permission rules on its skill tool, Copilot as the session's skill folders and turned-off skills |
| `guard.ts` | The permission rules for every agent (kill and secret denies, Symbio's own files, install asks, Plan mode's and reviewers' extra rules); OpenCode applies them, and the Copilot runtime evaluates them for each request |
| `connections.ts`, `secrets.ts` | GitHub, Azure DevOps, server (SSH) and FTP connections, and the encrypted secret vault |
| `remote.ts`, `ssh.ts`, `ftp.ts` | Running remote actions for agents (SSH exec/upload, FTP upload, git push/pull, GitHub and Azure DevOps APIs) with approvals |
| `providers.ts` | Listing, adding and removing OpenCode model providers |
| `self-update.ts` | Checks npm for a newer version, applies it when allowed (the team idle, remote access off) and reports the result; the install itself runs in `bin/update-runner.mjs`, a separate process that waits for Symbio to exit, installs, keeps or restores the old version on failure, and starts Symbio again |
| `notifier.ts`, `notifications.ts` | Notifications: what's worth telling the human (the messages logged for them, tasks done, the team stopping after working a while), gathered per project into one message and filtered by the project's choice (`notifier.ts`); the channels it goes to (the open tabs through the bus, Telegram, ntfy, a webhook, SMTP e-mail), their settings and their secrets in the vault (`notifications.ts`) |
| `remote-access.ts` | Optional remote access: Cloudflare quick tunnel, access code, remote sessions, the remote login page |
| `folder-picker.ts` | Native "choose a folder" dialog on the machine running Symbio |
| `fsutil.ts` | Writing files atomically (a temporary file, then a rename), so a crash never leaves half a file |
| `runtime/install.ts`, `runtime/settings.ts` | Installing and removing the runtimes Symbio runs (`~/.symbio/runtimes`), finding them, and the human's runtime settings (`runtime-settings.json`: e.g. an OpenCode on the PATH) |
| `runtime/types.ts` | `AgentRuntime`: what Symbio needs from an agent runtime (sessions, prompts, interrupts, models, instructions, permissions, questions, history, usage, changes, background shells) and the event vocabulary the team logic and the chat use. The team and the API call runtimes only through it |
| `opencode/runtime.ts` | The OpenCode runtime: starts, supervises and restarts `opencode serve`, measures its memory, and implements `AgentRuntime` over its API |
| `opencode/client.ts` | Typed wrapper over the OpenCode HTTP API |
| `copilot/runtime.ts` | The GitHub Copilot CLI runtime: `AgentRuntime` over the Copilot SDK, with Symbio's rules applied to each permission request, notes carried with the next prompt, and Copilot's events and stored conversation translated into Symbio's vocabulary (see [copilot-api.md](copilot-api.md)) |

The UI (`web/src/`) is React + Vite with Motion for animation and lucide icons. `api.ts` is its
client; `ProjectView.tsx` holds the project screen (team sidebar and tabs), `Chat.tsx` renders a
live session (with `steps.ts` labelling the team's steps in plain words, and `files.tsx` and `paths.ts` turning paths
into links, showing shared files as cards and the viewer page that opens them), `Machine.tsx` the computer's load and agents' programs (top bar), `Effort.tsx` reasoning effort (in a chat header and project settings), `Kanban.tsx` the plan, `Explorer.tsx` the project's folders and files (read-only), `Messages.tsx` the message log, `Attachments.tsx` attachments in the chat and the Files tab, `Docs.tsx` the Docs tab and
`Rules.tsx` the rules register in it, `Skills.tsx` skills (the library in Settings, a project's in its settings, an agent's in its chat), `Inbox.tsx` the *Needs you* drawer (with `Questions.tsx` the team's questions, briefings and decisions, and `Review.tsx` work waiting for the human's review), `Checks.tsx` checks and reviewers (project settings, and their results on a task), `ProjectSettings.tsx` a project's settings, `Usage.tsx` tokens and
costs, `Housekeeping.tsx` the daily check, `Remote.tsx` remote access, and
`Settings.tsx`/`Providers.tsx` the global settings. `styles.css` holds the design tokens (colors,
radii, fonts) and every rule uses them; `themes.css` overrides them per theme under
`html[data-theme="…"]`, and `i18n.ts` holds the interface's text per language (English, Portuguese (Brazil); English fills in
what's missing) and the language kept in the browser. `theme.ts`/`Appearance.tsx` pick a theme and keep it in the browser (`vscodeTheme.ts` reads an imported VS
Code color theme into token values), with the layout: `ProjectView.tsx`
draws a project as *Classic* (team sidebar, tabs) or *Workbench* (activity bar, side bar with the team
or the Explorer tree, closable tabs in the middle, the chat on the right, resizable columns, a status
bar), from the same pieces.

## Lifecycle of a project

1. **Create.** The user picks a folder. `inspect.ts` reports whether it's empty, whether it's a git
   repo, what kinds of files it holds and any existing guidance (`README`, `AGENTS.md`, `docs/`).
   Symbio offers to initialize git, unless subfolders are repositories (a folder of several
   repositories is kept as it is). Project state goes to `<project>/.symbio/` (git-ignored).
2. **Start.** Symbio registers its tools for the project folder and creates core's session with the
   coordinator brief, the inspection summary and the project settings.
3. **Onboarding.** For an existing folder, core studies it, writes up its understanding, confirms
   it with the human, and creates or updates `AGENTS.md` and `docs/` (or private docs).
4. **Plan.** core calls `submit_plan`; the Plan tab shows it for approval. The human approves or
   asks for changes (when the project lets core decide, it's approved as made). Bigger or vaguer
   requests can start with a briefing, whose answers become the feature's spec (`docs/specs/`).
5. **Work.** core spawns helpers (`spawn_agent`) on tasks. Each helper gets its own session, the
   worker brief, and a folder: a worktree on branch `symbio/<name>` (of the repository it was
   given, in a folder of several repositories), or the project folder itself
   (project setting `helperWorkspace`, or core's `workspace` choice). A helper moved into the
   project folder continues in a fresh session there, since OpenCode ties a session to its folder. Helpers report with `update_task`, talk
   to core and to each other with `send_message`, and request shared assets.
6. **Merge.** When a helper reports a task for review, Symbio runs the project's checks first (and a
   reviewer, when the human requires one; `team/verify.ts`); a failure goes back to the helper. Then
   core reviews and calls `merge_work`, which runs the checks again if the work changed (shared
   helpers have nothing to merge: core marks the task done). Changes
   to shared assets the helper wasn't granted are flagged instead of merged silently. After a merge
   the helper's branch is synced with the project.
7. **Stop / restart.** A finished helper is stopped: its tasks are unassigned and its worktree is
   removed unless it holds unmerged work. A stopped helper can be restarted on its old session, so
   it keeps its memory.

## Reliability

- **Supervisor.** If `opencode serve` (or the Copilot runtime) exits, Symbio restarts it, re-registers tools and briefs, and
  tells each agent that was working to continue.
- **Tool re-registration.** OpenCode unloads a folder's services after a while idle, which drops
  in-memory MCP registrations. Before starting any agent's turn, Symbio checks the folder still
  lists its tool server and registers it again if not.
- **Watchdog.** An agent that is busy with no events for `SYMBIO_STUCK_MINUTES` is interrupted and
  told what it was stuck on.
- **Model fallback.** When a model fails for provider reasons (quota, outage, repeated retries), the
  agent moves to the next model its role may use (`modelsFor` in `store.ts`: core the crowned models, helpers
  every allowed model except the core-only ones) and is told why. Retries count: four failed retries, or two
  when they timed out (each timeout already costs minutes of waiting). If every allowed model failed recently,
  the agent stops with a visible problem; adding a model resumes it.
  **Pinned agents** (`Agent.modelPinned`: the pin in an agent's chat, or core's `spawn_agent pin_model` /
  `pin_model`) never switch: they wait and retry the same model (15 s, 30 s, 1, 2, 5, then every 10 minutes;
  `Agent.modelWait`, rescheduled after a restart), with the human told once after an hour. Errors waiting
  won't fix (the model is gone, the key is refused) are reported at once. Unpinning a waiting agent
  switches it right away; only the human can unpin what they pinned; a runtime switch, or the model
  leaving the project's models, releases the pin.
- **Reasoning effort.** Each runtime lists the levels a model takes (`RuntimeModel.efforts`: OpenCode's
  variants, Copilot's `supportedReasoningEfforts`). A session runs at the agent's own level
  (`Agent.effort`: from its chat, or core's `spawn_agent effort` / `set_effort`; core can't change the
  human's), else the project's level for the model (`Project.modelEfforts`, in its settings), when the
  model takes it; otherwise at the model's default (`Team.effortFor`). It's given when a session is
  created and with every model change, so it survives fresh sessions, fallback and runtime switches.
- **AI co-authors in commits.** Unless the project allows them (`Project.aiCoauthors`, off by
  default), the briefs tell agents to leave `Co-authored-by` lines naming an AI out of commits, and
  Copilot sessions are opened with `coauthorEnabled: false` (`AgentRuntime.commitCoauthors`).
- **Machine load.** Runtimes run at below-normal priority, so everything agents start does too (`machine.ts`).
  Briefs say how big the computer is (on a small one: one heavy job at a time). The load guard samples
  CPU and free memory; when the machine stays overloaded it logs it for the human (with the heaviest
  agents' programs) and notes it to core, and with *hold* on, messages between agents wait
  (`Team.deliver`, like a pause) until it recovers, then go out. The top bar's machine view lists
  agents' programs and stops one by pid; core has `list_programs` / `stop_program`. Each program
  says who started it: the agent whose background shell it runs under (the runtimes record the
  session), otherwise the agents that were working on its runtime when its shell started (the team
  keeps each agent's recent turns), narrowed to the one whose folder its command line names.
  Windows keeps a process's parent id after the parent exits and reuses ids, so a process only
  counts as another's child when it started after it (`childOf`); stopping a program stops that
  checked tree pid by pid, never with `taskkill /T`.
- **Memory recycling.** Each runtime's memory is measured (its process tree, without the shells it
  runs agents' commands in and what runs under them: builds and servers agents start aren't the
  runtime's, and restarting it would only cut them off). Above
  `SYMBIO_RECYCLE_MB` it is restarted once every agent is idle; above `SYMBIO_RECYCLE_HARD_MB` it
  is restarted anyway and agents resume.
- **Loop guard.** Conversational messages between the same two agents are limited per 30 minutes
  (20 by default, set per project in Settings → Team, 0 = off). Protocol traffic (task
  assignments, shared-asset requests and grants, review reports) doesn't count. Past the limit,
  further messages are refused, the agents are told to bring the human in, and the human gets a
  notice.
- **Fresh sessions.** A long-running agent can continue in a fresh session (Fresh session in
  its chat, or automatically after each merged task: the default for new projects). It keeps its
  identity, folder, tasks and assets, and starts from a handoff note Symbio builds from the plan, the
  asset register and the message log, after the agent's own handoff when the human asks for one. Old sessions stay readable. This keeps each step cheaper (every
  step re-reads the conversation), avoids repeated compactions, and keeps OpenCode's memory down.
- **Switching runtimes** (Project settings → Agent runtime, `team/switch.ts`, `Team.switchRuntime`).
  Nothing is converted between runtimes: what the team knows is Symbio's (plan, tasks, messages,
  assets, docs) or git's (folders, branches), so a switch is a fresh session for every agent, on the
  other runtime. Symbio pauses the team, optionally gives each active agent a last turn on the old
  runtime to write its own handoff, stops background processes, creates every new session (all or
  nothing: if one fails, they're deleted and the project is unchanged), then switches the project's
  runtime and models (carried over by model name in the dialog), resumes and tells core. Earlier
  sessions keep their runtime (`previousSessions[].runtime`) and stay readable while it's installed.
  Stopped helpers move when restarted. Any runtime to any other works the same way.
- **Housekeeping.** Every day Symbio backs up each project's `.symbio` folder and its own small files
  to `~/.symbio/backups/<date>` (the last 7 days; `SYMBIO_BACKUP_DAYS`), and checks each project for
  commits that no remote has (the project's branch and helpers' `symbio/*` branches) and for build
  outputs piling up in helpers' folders (`SYMBIO_BUILD_ALERT_GB`, default 2). Findings go to the
  human (Messages) and to core, which can push and use `clean_build_outputs`.
- **Pause.** Pausing a team interrupts working agents and holds messages; resuming delivers them
  and tells interrupted agents to continue.

## Data

| What | Where | Committed to the project |
|---|---|---|
| Entry point for any agent: what the project is, conventions, where docs are | `AGENTS.md` | yes |
| Durable knowledge: overview, decisions, how-tos | `docs/` | yes |
| Agents, settings (incl. checks and how core runs the project), allowed models | `.symbio/project.json` | no |
| Every message (from, to, kind, text, time) | `.symbio/messages.jsonl` | no |
| Plan and tasks (with their checks' results, reviews and evidence links) | `.symbio/plan.json` | no |
| The team's questions for the human, and their answers | `.symbio/questions.json` | no |
| Files agents shared with the human (with their tag and task) | `.symbio/shared-files.json` | no |
| The glossary | `docs/glossary.md` (`.symbio/docs/glossary.md` with private docs) | yes (no, with private docs) |
| Features' specs (from briefings) | `docs/specs/` (`.symbio/docs/specs/` with private docs) | yes (no, with private docs) |
| Scheduled jobs and their runs | `.symbio/schedules.json` | no |
| Briefings | `.symbio/briefings.json` (their questions in `questions.json`; their specs in the docs, `specs/`) | no |
| Shared-asset register | `.symbio/assets.json` | no |
| Private docs (if chosen) | `.symbio/docs/` | no |
| Files attached in chats, and their index | `.symbio/attachments/`, `.symbio/attachments.json` | no |
| Rules register (if on) | `docs/rules.json` (`.symbio/docs/rules.json` with private docs) | yes (no, with private docs) |

Helpers' worktrees only contain *committed* files, so anything agents must read has to be committed
(or delivered by Symbio, as with private docs, which are injected as instructions).

Global data is in `~/.symbio/`: `config.json` (projects), `connections.json`, `secrets.enc`,
`ui-token`, `notifications.json` (where notifications go; their tokens are in `secrets.enc`), `prices.json` (model prices), `approvals/<project>.json` (remote-action approvals),
`worktrees/`, `backups/<date>/` (and `<date>-before-<version>/` before an update), `logs/symbio.log`
and `logs/update.log`, `updates.json` and `update-result.json` (update setting and the last
result), `machine.json` (what happens when the computer is overloaded), `bin/` (a downloaded `cloudflared`, for remote access),
`runtimes/` and `runtime.json` (the runtimes Symbio installed), `runtime-settings.json`, `copilot/` (Symbio's own
Copilot folder), `skills/` (the human's skill library) and `opencode.pid`.

Conversations live in the runtime's own storage (OpenCode's database, Copilot's session store). A
project opened on another machine keeps its docs and plan, but its agents' sessions would need to be
re-created.
