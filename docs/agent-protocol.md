# Agent protocol

How the agents Symbio runs are organized, what they're told, and the tools they use. The briefs
themselves are in `src/server/prompts.ts`; the tools in `src/server/tools.ts`.

## Roles

There are no predefined roles like "frontend" or "writer". There are only two kinds of agent:

- **core** (the coordinator): one per project, working in the project folder. It scopes the work
  with the human, proposes the plan, creates and directs helpers, gatekeeps shared assets, reviews
  and merges. It **coordinates rather than doing the work**: work, including the human's follow-up
  requests, goes to helpers so core stays responsive. core does work itself only for reading and
  review, project docs, merging, trivial setup, or when the human explicitly asks it to.
- **Helpers** (workers): created by core for a piece of work, named for what they do in *this*
  project. In a git project a helper works either in its own git worktree on branch `symbio/<name>`
  ("own": parallel work, merged by core) or in the project folder itself ("shared": what it
  writes is there at once for the next step, nothing to merge, no commits). The project setting
  (Settings → Team, default "own") decides unless core passes `workspace` to `spawn_agent`; without
  git, helpers always share the project folder. In a folder of several repositories (not one
  itself; `repos.ts`), an "own" helper needs `repo` on `spawn_agent`: its worktree comes from
  that repository, and its work is merged there; shared helpers may get a `repo` as their default
  for pushes. A project folder that is itself a repository holding others (older Symbio versions
  created one on top) can be switched to the inner ones (`subRepositories`): after the update,
  Symbio wakes core in such projects to check and switch on its own when the outer repository is
  Symbio's and has no remote, or ask the human otherwise. One helper is the default; each extra helper must be justified by
  independent work. Idle helpers cost nothing and keep their context, so they're reused for
  follow-ups and stopped only when their area is finished.

## Messages

Every message goes through Symbio, is logged, and wakes its recipient. Agents see messages from
others as `[from: <name> · <kind>]` followed by the text.

| Kind | Use |
|---|---|
| `info` | FYI, no answer needed |
| `request` | The sender needs something |
| `blocking` | The sender can't continue without an answer |
| `urgent` | Interrupts the recipient mid-turn (`steer` delivery); use rarely |

Symbio also sends system notices (prefixed `Symbio:`): a model switch, a resume after a crash or
pause, a restart, results of approved remote actions. Messages that arrive while an agent is
working are handed over with its next Symbio tool call, so it doesn't have to finish its turn to
see them.

**Loop guard:** conversational messages between the same two agents are limited per 30 minutes
(20 by default; Settings → Team, 0 = off). Task assignments, shared-asset traffic and review
reports don't count. Past the limit, further messages are refused, the agents are told to use
`ask_human`, and the human is notified.

**Renaming:** the human can rename a helper. Its branch and folder keep their names, the old name
keeps reaching it, and every agent is told (without being woken up).

## Shared assets

A **shared asset** is anything more than one agent could change: a file or folder pattern
(`chapters/03/**`, `brand/palette.json`) or something outside the folder (a database, a
spreadsheet, a mailing list), identified by name. Symbio tracks only ownership and never interprets
what the asset is.

core is the gatekeeper:

1. core declares the assets (`declare_asset`, or in the plan) and holds any asset nobody else holds.
2. A helper that needs one calls `request_asset(asset, reason)`. If nobody holds it and nobody else
   is waiting, Symbio grants it immediately (the answer comes back in the tool result) and leaves
   core a note without waking it. Otherwise the request goes to core.
3. The helper does **not** touch the asset until granted. It continues with other work or ends its
   turn.
4. core answers contended requests with `grant_asset` or `deny_asset` (with a reason), or leaves
   them queued. The decision is delivered as a message and wakes the helper.
5. When done, the helper calls `release_asset(asset, summary)`. core is woken only if someone is
   waiting for the asset; otherwise it just gets a note.

At merge, changes to path-pattern assets the helper wasn't granted are reported to core instead of
being merged (unless core forces the merge).

## Plan and tasks

- core proposes the plan with `submit_plan`: a goal and tasks with dependencies. The human
  approves or requests changes in the Plan tab. No work is assigned before approval.
- `spawn_agent` with a `task_id`, or `assign_task`, gives a task to a helper and moves it to
  *in progress*. Tasks with unfinished dependencies can't be assigned.
- Helpers report with `update_task`: `in-progress`, `blocked` (with the reason) or `review`
  (finished, with a summary, which is their report to core).
- **Review guides and the human's review** (`Project.reviewBy`, `team/review.ts`). A helper reporting a
  task for review gives a guide (`update_task` `guide`): where to look, the steps to check it and what
  should be seen, and whether it ran them. *core* (the default): core's review is enough, done is
  done. *every*: a task merged or marked done waits in the human's "To review" list (Needs you, the
  Plan tab) and is done only when they approve it; reporting without a guide is refused; tasks that
  depend on it wait. *Send back* reopens the task and gives the human's note to its helper (core is
  told). *marked*: only the tasks marked for the human (`review: true` in `submit_plan` /
  `add_task`, which core sets when it proposes the plan; the human ticks or unticks them in the Plan
  tab, `POST …/plan/tasks/:id/mark`) wait; the others work as with *core*.
- **Open questions** (`team/questions.ts`, `.symbio/questions.json`). Questions for the human go to
  their list instead of the chat: `ask_human` adds one, numbered Q1, Q2… Asking what's already open
  (near-identical wording, any case or accents) is refused with the open one's number. The human
  answers from Needs you, several at once (`POST …/questions/answers`), and each agent that asked
  gets its answers in one message from the human; for a helper's, core gets a note that doesn't
  wake it. *Set aside* (`POST …/questions/:id/set-aside`) closes one without an answer and tells the
  asker. Core's brief keeps questions and pending lists out of the chat, and its replies to helpers'
  reports to one line.
- **A task's changes** (`Reviews.changes`, `GET …/plan/tasks/:id/changes`): the files the task
  changed and their diffs, from OpenCode's session diff (`docs/opencode-api.md`) over the helper's
  turns on that task. Symbio records them as `Task.work`: the assignment's message starts a segment,
  the helper's review report ends it, and a later assignment or send-back starts another. Only in a
  git repository; without git the Plan tab says so.
- **Chat modes** (the selector in core's chat box, `Project.coreMode`). **Plan**: core discusses and
  proposes but starts nothing. Symbio enforces it: core's tools refuse creating helpers, assigning
  tasks, merging, moving helpers, cleaning folders, connection actions that change things (pushes,
  deploys, non-GET API calls) and asking helpers to do things (`send_message` of kind request,
  blocking or urgent); and core's session gets `PLAN_MODE_PERMISSIONS` (`guard.ts`): every edit and
  the usual writing commands are denied, reading and read-only commands stay allowed. **Act**: the
  human wants it done without a plan to approve. Messages to core in Plan or Act end with a
  `[Mode: …]` note (`modeNote` in `prompts.ts`), shown as a label in the chat. The mode applies at
  once and stays until changed; helpers already working carry on.
- A helper given work by core (a task, or a `request`/`blocking`/`urgent` message) owes core a
  report: an `update_task`, a message to core, or a question to the human. If it ends its turn
  without one, Symbio waits a moment (`SYMBIO_QUIET_HELPER_SECONDS`, default 20, in case more turns
  are queued), reminds it once, and if it stays quiet tells core it has gone quiet. Not while it
  waits for a shared asset, for the human, or for messages on their way, nor when its tasks are
  already in review or done; the human talking to the helper directly clears it.
- core reviews, calls `merge_work` (helpers with their own copy; that marks the task done) or checks
  the files in the project folder and marks the task done with `update_task` (shared helpers). Small follow-ups go in with `add_task`
  without re-approval.

## Tools

All agents:

| Tool | What it does |
|---|---|
| `send_message` | Message another agent by name (`core` is the coordinator); wakes the recipient |
| `ask_human` | Add a question to the human's open questions (Needs you): one per call, with context, options, the task and whether work is blocked; the answer arrives later as a message |
| `list_questions` | The open questions, and the ones closed recently with their answers |
| `close_question` | Close an open question: with the answer the human gave in the chat, or without one when it's no longer needed |
| `share_file` | Show the human a file (image, video, report…): a card in the chat, shown in place or with a download button, and in the Files tab |
| `list_team` | Agents on the project: name, role, purpose, status, model |
| `list_assets` | Declared shared assets, holders and queues |
| `request_asset` | Ask core for a shared asset; don't touch it until granted |
| `release_asset` | Release a held asset with a summary of the changes |
| `check_messages` | Collect messages that arrived mid-turn (any Symbio tool call also includes them) |
| `list_tasks` | The plan: goal, approval status, tasks with status, assignee, dependencies |
| `update_task` | Report progress on a task: in-progress, blocked, review |
| `read_document` | The text of a document: PDF by pages, Word (.docx, .odt), Excel (every sheet as rows), PowerPoint (by slide), long text files; a part at a time. Reading PDFs with the read tool is refused |
| `view_image` | Look at an image as a scaled-down copy (1024 px by default, at most 2048), or a crop at full resolution; reading image files directly is refused |
| `list_rules` | The rules register (when the project keeps one): areas, sources, rules, with filters |
| `save_rule` | Add or update a rule: text, citations (source, location, literal excerpt), who imposes it, confirmation, status, current state |
| `save_rule_area` / `save_rule_source` | Define an area (id prefix and its stages) or a source (code, name, file, authority) |
| `list_processes` | Background processes (servers, watchers) the agent started; in the shared project folder, only its own (OpenCode records the starting session) |
| `stop_process` | Stop one of them by shell id; the only way agents may stop processes |
| `list_connections` | Connections the project may use and whether actions need approval |
| `remote_exec` | Run a non-interactive command on a server over SSH; on an FTP account, file operations (`ls`, `mkdir`, `rm`, `rmdir`, `mv`) |
| `remote_upload` | Upload files from the working folder to a server (SFTP) or an FTP account |
| `git_push` / `git_pull` | Push or pull with GitHub or Azure DevOps; Symbio applies the token. From the project folder of a folder of several repositories, `repo` says which |
| `github_api` | Call the GitHub REST API (GET calls never need approval) |
| `azure_devops_api` | Call the Azure DevOps REST API of the connection's organization, e.g. to open a pull request (GET calls never need approval) |

core only:

| Tool | What it does |
|---|---|
| `submit_plan` | Propose (or revise) the plan for approval |
| `add_task` | Add a task to the approved plan |
| `assign_task` | Give a task to an existing helper |
| `spawn_agent` | Create a helper with a name, purpose, first task, and optionally a model, where it works (`workspace`: own / shared) and, in a folder of several repositories, which one (`repo`) |
| `stop_agent` | Stop a helper; its assets are released |
| `clean_build_outputs` | Delete an idle helper's git-ignored build folders (bin, obj, node_modules…) to free disk space |
| `merge_work` | Merge a helper's committed work; refuses ungranted asset changes unless forced |
| `sub_repositories` | For a project folder that is a repository holding other repositories (one an older Symbio created on top of them): check the situation, switch to working in the inner repositories (`use`) or back (`stop`). Nothing on disk changes |
| `move_to_project_folder` | Move an idle helper whose work is merged from its own copy into the project folder (fresh session, handoff note) |
| `declare_asset` | Declare or update a shared asset |
| `grant_asset` / `deny_asset` | Answer an asset request |

Agents also have OpenCode's built-in tools (read, edit, shell, search…), restricted by the
permission rules in [security.md](security.md). OpenCode's own `question` tool shows up in the UI as
a form the human answers.

## Remote actions

Connections are GitHub accounts, Azure DevOps organizations, servers (SSH; SFTP-only hosting tests as
such) or FTP accounts (FTP or FTPS: uploads and file operations, no shell) configured in Settings and enabled per project.
The brief puts the project's own tools first: a deploy script or a configured CLI is run like any
command, and agents don't ask for a connection when the project already has its own access.
Agents never see their credentials: they call `git_push`, `github_api`, `azure_devops_api`, `remote_exec` or
`remote_upload`, and Symbio runs the action itself. Credentials that belong to the project (its
config files) or that the human gives are a different matter: agents may use them for the task, but
never copy them into anything committed or shared (see [security.md](security.md#credentials)). A connection set to **Ask me** queues an
approval in the human's inbox; once approved, the result is delivered to the agent as a message.
