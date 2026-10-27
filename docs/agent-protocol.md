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
  project. Each works in its own git worktree on branch `symbio/<name>` (or in the project folder
  when there's no git). One helper is the default; each extra helper must be justified by
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

**Loop guard:** after 12 messages between the same two agents within 30 minutes, further messages
are refused and the agents are told to use `ask_human`.

## Shared assets

A **shared asset** is anything more than one agent could change: a file or folder pattern
(`chapters/03/**`, `brand/palette.json`) or something outside the folder (a database, a
spreadsheet, a mailing list), identified by name. Symbio tracks only ownership and never interprets
what the asset is.

core is the gatekeeper:

1. core declares the assets (`declare_asset`, or in the plan) and holds any asset nobody else holds.
2. A helper that needs one calls `request_asset(asset, reason)`; the request goes to core.
3. The helper does **not** touch the asset until granted. It continues with other work or ends its
   turn.
4. core answers with `grant_asset` or `deny_asset` (with a reason), or leaves the request queued.
   The decision is delivered as a message and wakes the helper.
5. When done, the helper calls `release_asset(asset, summary)`, and core can grant the next request.

At merge, changes to path-pattern assets the helper wasn't granted are reported to core instead of
being merged (unless core forces the merge).

## Plan and tasks

- core proposes the plan with `submit_plan`: a goal and tasks with dependencies. The human
  approves or requests changes in the Plan tab. No work is assigned before approval.
- `spawn_agent` with a `task_id`, or `assign_task`, gives a task to a helper and moves it to
  *in progress*. Tasks with unfinished dependencies can't be assigned.
- Helpers report with `update_task`: `in-progress`, `blocked` (with the reason) or `review`
  (finished, with a summary, which is their report to core).
- core reviews, calls `merge_work`, and marks the task done. Small follow-ups go in with `add_task`
  without re-approval.

## Tools

All agents:

| Tool | What it does |
|---|---|
| `send_message` | Message another agent by name (`core` is the coordinator); wakes the recipient |
| `ask_human` | Ask the human something only they can answer; the answer arrives later as a message |
| `list_team` | Agents on the project: name, role, purpose, status, model |
| `list_assets` | Declared shared assets, holders and queues |
| `request_asset` | Ask core for a shared asset; don't touch it until granted |
| `release_asset` | Release a held asset with a summary of the changes |
| `check_messages` | Collect messages that arrived mid-turn (any Symbio tool call also includes them) |
| `list_tasks` | The plan: goal, approval status, tasks with status, assignee, dependencies |
| `update_task` | Report progress on a task: in-progress, blocked, review |
| `list_processes` | Background processes (servers, watchers) the agent started |
| `stop_process` | Stop one of them by shell id; the only way agents may stop processes |
| `list_connections` | Connections the project may use and whether actions need approval |
| `remote_exec` | Run a non-interactive command on a server over SSH |
| `remote_upload` | Upload files from the working folder to a server |
| `git_push` / `git_pull` | Push or pull with GitHub; Symbio applies the token |
| `github_api` | Call the GitHub REST API (GET calls never need approval) |

core only:

| Tool | What it does |
|---|---|
| `submit_plan` | Propose (or revise) the plan for approval |
| `add_task` | Add a task to the approved plan |
| `assign_task` | Give a task to an existing helper |
| `spawn_agent` | Create a helper with a name, purpose, first task and optionally a model |
| `stop_agent` | Stop a helper; its assets are released |
| `merge_work` | Merge a helper's committed work; refuses ungranted asset changes unless forced |
| `declare_asset` | Declare or update a shared asset |
| `grant_asset` / `deny_asset` | Answer an asset request |

Agents also have OpenCode's built-in tools (read, edit, shell, search…), restricted by the
permission rules in [security.md](security.md). OpenCode's own `question` tool shows up in the UI as
a form the human answers.

## Remote actions

Connections are GitHub accounts or SSH servers configured in Settings and enabled per project.
Agents never see their credentials: they call `git_push`, `github_api`, `remote_exec` or
`remote_upload`, and Symbio runs the action itself. A connection set to **Ask me** queues an
approval in the human's inbox; once approved, the result is delivered to the agent as a message.
