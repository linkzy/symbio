# GitHub Copilot CLI notes

Work in progress: Symbio is getting a second agent runtime, GitHub Copilot CLI, next to OpenCode
(see the roadmap). The team logic talks to runtimes through one interface,
`src/server/runtime/types.ts`; this page is what the Copilot side of it relies on.

Symbio drives Copilot through the official **Copilot SDK** (`@github/copilot-sdk`, MIT), a JSON-RPC
client that starts the Copilot runtime (the CLI in headless mode, shipped with the SDK as a
platform package, e.g. `@github/copilot-sdk-win32-x64`) over stdio. Everything below was
**verified live against SDK 1.0.34 / Copilot CLI 1.0.112 on Windows** (2026-11-16) with a throwaway
script, unless marked otherwise. Re-verify when either changes, and update this page.

## The runtime process

- `new CopilotClient({ baseDirectory })` starts one runtime process for any number of sessions.
  `baseDirectory` sets `COPILOT_HOME` (default `~/.copilot`): sessions, config and logs live there.
- **Sign-in.** A runtime with its own empty `COPILOT_HOME` is not signed in. One whose
  `config.json` names the user's login (`loggedInUsers`, `lastLoggedInUser`, copied from
  `~/.copilot/config.json`, which has `//` comment lines) is: the token itself is in the OS credential
  store, keyed by the login. So Symbio can keep its sessions out of the user's own Copilot history
  and still use their login. Other ways in: `gitHubToken` (client or session option; `gho_`, `ghu_`
  or fine-grained `github_pat_` tokens with the Copilot Requests permission, not classic `ghp_`),
  the `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` variables, or `copilot login`.
- `client.getAuthStatus()` → `{ isAuthenticated, authType, login }`. `client.getStatus()` →
  `{ version, protocolVersion }`.
- `client.listModels()` → `[{ id, name, billing: { tokenPrices: { inputPrice, outputPrice,
  cacheReadPrice, cacheWritePrice, contextMax, … } }, capabilities: { supports: { vision,
  reasoningEffort, … } } }]`, plus `auto`. Not available before signing in.

## Sessions

- `client.createSession({ sessionId?, model, workingDirectory, systemMessage, mcpServers,
  onPermissionRequest, onUserInputRequest, streaming, … })`. Each session has its own working
  folder: two sessions in one runtime ran `pwd` in their own folders.
- `client.resumeSession(id, config)` continues a session, also from a new runtime process (it
  remembered a file it created and an answer it got). Handlers and MCP servers are given again.
- `client.listSessions()`, `client.deleteSession(id)` (removes it from disk).
- `client.getSessionMetadata(id)` → `{ sessionId, startTime, modifiedTime, summary, isRemote,
  context: { workingDirectory }, clientName, … }` (verified): after Symbio restarts, the session's
  folder comes from `context.workingDirectory` (not `cwd`, which is the name in the session's own
  `workspace.yaml`). Symbio's tools are registered per folder, so without it a reopened session
  would have none.
- **New instructions for an open session:** `resumeSession(id, { systemMessage, … })` on a
  session that is already open returns a new session object that uses them from the next turn
  ("Your name is Alpha" → resumed with "Bravo" → it answered Bravo). Symbio reopens a session
  this way before its next turn when its brief, private docs or skills change, including a change
  made while the session was still opening (it opened with the old config; a prompt waits for it to
  open, then reopens it).
- `session.getEvents()` is the stored conversation: `session.start`, `user.message`,
  `system.message`, `assistant.turn_start`, `assistant.message` (`content`, `toolRequests`),
  `tool.execution_start` / `_complete`, `permission.*`, `assistant.turn_end`, `abort`,
  `system.notification`… Streaming deltas are not stored.

## Turns and messages

- `session.send({ prompt, mode })` returns the user message's id. `mode: "enqueue"` (default)
  waits for the running turn: FIRST then SECOND, in order. `mode: "immediate"` reaches the running
  turn: asked mid-command to reply STEERED, it did, right after the command.
- `session.abort()` stops the turn: an `abort` event (`reason: "user_initiated"`), then
  `session.idle` with `aborted: true`.
- **Long commands go to the background on their own** (`initial_wait`), and their completion starts
  a new turn by itself (a `system.notification`, then the model reads the output). A turn can
  therefore start without Symbio prompting.
- **No "add to the conversation without a turn"** (OpenCode's `synthetic` with `resume: false`) was
  found in the SDK. Symbio keeps such notes and puts them before the next prompt instead.

## Events

`session.on(handler)` (every event) or `session.on(type, handler)`. What a turn looks like:

| Event | Data Symbio uses |
|---|---|
| `user.message` | the prompt as stored |
| `assistant.turn_start` / `assistant.turn_end` | one model step |
| `assistant.message_start`, `assistant.message_delta` (`deltaContent`), `assistant.message` (`content`, `toolRequests`) | text (streamed with `streaming: true`) |
| `assistant.reasoning`, `assistant.reasoning_delta` | reasoning |
| `tool.execution_start` (`toolCallId`, `toolName`, `arguments`, `mcpServerName`), `tool.execution_complete` (`success`, `result.content`, `error.message`) | tool calls; Symbio's MCP tools are named `symbio-<tool>` |
| `permission.requested` / `permission.completed` | see below |
| `user_input.requested` / `user_input.completed` | the agent asks the human (`ask_user`) |
| `assistant.usage` (`model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost`) | per model call |
| (skills) | session config `skillDirectories` (folders with skills) and `disabledSkills` (names); `session.rpc.skills.list()` lists them with `enabled` and `source` (`custom`, `builtin`), `disable({name})` turns one off (experimental). Verified: Symbio's folders listed as `custom`, the disabled ones off, and Copilot's own built-in skills (`customize-cloud-agent`, `github-pr-media`, `pr-stack`) on until disabled, so Symbio disables every skill not given once a session opens. A skill added to a folder shows up in an open session at once, on: Symbio reopens those sessions before their next turn. A `SKILL.md` whose frontmatter isn't valid YAML (an unquoted value containing `: `) is skipped without an error, so Symbio quotes such values (a unit test checks its own skills) |
| `session.usage_info` (`currentTokens`, `tokenLimit`, `messagesLength`) | the context window's use; the adapter turns it into `session.context.updated` (from the SDK's types; not yet seen in a real turn: the chat shows no size until it comes) |
| `session.idle` (`aborted?`) | the turn ended |
| `session.error` (`errorType`, `message`, `statusCode?`) | the turn failed |

Built-in tools seen on Windows: `powershell` (with `read_powershell` for background shells),
`apply_patch`, `ask_user`; others exist (`view`, `grep`, `glob`, `task`…).

## Symbio's tools

Per-session MCP servers: `mcpServers: { symbio: { type: "http", url, headers, tools: ["*"] } }`.
Tool calls carry `_meta["com.github.copilot/toolCallId"]` but **not the session**, so Symbio gives
each session its own header (or URL) to know who is calling. The headers arrived on every call.

## Instructions

`AGENTS.md` in the working folder is loaded as instructions by itself:
`session.rpc.instructions.getSources()` lists it (`{ id: "model-agents-md", sourcePath: "AGENTS.md",
type: "model", location: "repository" }`).

## Permissions and questions

- `onPermissionRequest(request)` is called before each tool runs, with `kind` (`shell`, `write`,
  `read`, `mcp`, `url`, …) and, for shells, `fullCommandText` (and `shellType: "powershell"`); for
  writes, `fileName` (absolute). Returning `{ kind: "approve-once" }` lets it run;
  `{ kind: "reject", feedback }` refuses it, and the model sees the feedback ("The user rejected
  this tool call. User feedback: …") and acts on it. So Symbio applies its own rules (`guard.ts`)
  here and holds "ask" ones for the human.
- **Reading a file inside the working folder doesn't ask** (no permission request for the `view`
  tool there). The `hooks.onPreToolUse(input)` hook runs before every tool, with `toolName`,
  `toolArgs` (`view`: `{ path }`, absolute) and `toolCallId`; returning `{ permissionDecision: "deny",
  permissionDecisionReason }` refuses it, and the model sees the reason (it then said to use
  `view_image`). Symbio applies its read rules (secrets, images, PDFs) there.
- `onUserInputRequest({ question, choices, allowFreeform })` → `{ answer, wasFreeform }`.

## Background processes

A long command can run in the background (the agent asks for it, or Copilot moves it there).
`session.rpc.tasks.list()` → `{ tasks: [{ type: "shell", id: "0", command, description, status:
"running", attachmentMode: "detached", pid, startedAt, logPath }] }` (ids are per session);
`session.rpc.tasks.cancel({ id })` → `{ cancelled: true }`, and the process is gone (checked with
`tasklist`). Symbio's `list_processes` / `stop_process` use these.

## Your own providers (bring your own key)

Providers set up for the Copilot CLI by hand (e.g. Azure AI Foundry) live in `providers.json` in the
user's Copilot folder: `{ providers: [{ name, type, baseUrl, apiKey, modelProvider }], models: [{ id,
provider, modelId, name, capabilities }] }` (`//` comment lines allowed). **The SDK doesn't load that
file**: `listModels()` and a session's `rpc.model.list()` didn't show them, even with the user's own
`~/.copilot`. A session takes the same entries as `providers` + `models` (experimental, additive to
Copilot's own models); its model list then has them as `<provider>/<id>`
(`foundry/code-claude-haiku-5-5`), and `model: "foundry/code-claude-haiku-5-5"` runs on it. Verified
with one turn on Azure AI Foundry: it answered, `assistant.usage` named the model, and Copilot billed
nothing (`totalNanoAiu: 0`; the provider bills). Symbio reads the file where it is each time a
session opens (never copied), gives its entries to every session, and lists its models after
Copilot's; keys never leave the server.

## Reasoning effort

- `listModels()`: models that take levels have `capabilities.supports.reasoningEffort: true` and
  `supportedReasoningEfforts` (e.g. `["low","medium","high","xhigh","max"]`, some with `"none"`);
  `defaultReasoningEffort` was absent for all of them (1.0.112). Your own providers' models list
  neither.
- A session takes a level when created (`reasoningEffort`) and when its model changes
  (`session.setModel(id, { reasoningEffort })`); `rpc.model.getCurrent()` reports it (contract test).
  Resuming a session keeps its level.
- `setModel(id)` without a level **keeps the session's last one**, so Symbio passes `medium` (or the
  model's default, when listed) to go back to the default. A new session with no level ran at
  `medium` (seen in `assistant.usage`).
- Your own providers' models take a level too (verified with Claude Haiku on Azure AI Foundry:
  `assistant.usage.reasoningEffort` was the level given, `low` through `max`, and higher levels
  produced more output tokens). Copilot doesn't check the level for them (an unknown one was
  passed on as is), so Symbio offers `low` … `max` for them.

## No "from the PATH" option

Unlike OpenCode, Copilot isn't a command Symbio starts but the SDK's module, loaded from Symbio's own
copy; so Settings → Agent runtimes' "use the one on the PATH" is OpenCode-only, and its end-to-end
test is skipped on the Copilot run.

## Co-author lines in commits

The runtime tells its agent to add a `Co-authored-by` trailer to commits it writes unless the
session is created or opened with `coauthorEnabled: false` (SDK `SessionConfig`; default `true`).
Symbio passes `false` unless the project allows AI co-authors (`Project.aiCoauthors`).

## Signing in

`session.rpc.accounts.login.begin({ kind: "githubDotCom", method: "device-code" })` →
`{ flowId, step: { kind: "device-code", userCode: "XXXX-XXXX", verificationUri:
"https://github.com/login/device", expiresIn, interval } }`; `advance({ flowId })` returns once the
user has authorized the device (`{ kind: "completed", result: { status, login } }`), and
`cancel({ flowId })` ends it. It needs a session, but works signed out (a scratch session, no
model). `method: "web"` gives an `open-url` step instead. Symbio's Settings → Agent runtimes → GitHub Copilot CLI uses
the device code.

## Usage and cost

- `session.rpc.usage.getMetrics()` → `{ totalPremiumRequestCost, totalUserRequests, totalNanoAiu,
  tokenDetails: { input, cache_read, cache_write, output }, modelMetrics: { <model>: { requests:
  { count, cost }, usage } }, codeChanges }`. After 7 prompts: `totalUserRequests: 7`,
  `totalPremiumRequestCost: 7`: every prompt Symbio sends counts as a request.
- `listModels()` gives each model's `billing.tokenPrices` in **AI credits per million tokens**
  (1 AI credit = $0.01, docs.github.com → Models and pricing for GitHub Copilot: GPT-6 Luna's
  `inputPrice: 10` is $0.10). Checked against a session's `totalNanoAiu`: tokens × price × 1000.
  Symbio shows them as dollars per million tokens, like OpenCode's prices.

## Changes

`session.rpc.workspaces.diff({ mode: "session" })` gives the files the session changed, with unified
diffs, when the session was created with `enableFileChangeTracking: true` (`isFallback: false`);
without it, it falls back to the folder's uncommitted git diff (`unavailableReason:
"file-change-tracking-disabled"`). There is no diff between two given turns, so a task's changes
are the whole session's.

## Failures

A model that doesn't exist (or isn't enabled) fails the turn at once: `session.error` with
`errorType: "query"`, `message: 'Execution failed: Model "…" is not available.'`, then
`session.idle`, with **no `user.message`: the prompt isn't recorded** (and no request is billed:
`totalPremiumRequests: 0`). Symbio carries such a prompt to the next turn, as OpenCode keeps it in the
conversation. `session.setModel(id)` switches a live session (it then said it was the new model).

MCP servers are connected when a session is opened (`server/discover`, `initialize`,
`tools/list`), each request with the session's headers, again when it's reopened after a restart.

`tests/contract/copilot.test.ts` checks these against the real CLI, with turns on a missing model
only, so it costs nothing.

## How Symbio maps it (`src/server/copilot/runtime.ts`)

| Symbio needs | With Copilot |
|---|---|
| A session per agent, in its folder | `createSession` with a Symbio-made `sessionId`, `workingDirectory`, `enableFileChangeTracking` |
| Symbio's tools | the `symbio` MCP server per session, with an `x-symbio-session` header (`mcp.ts` reads it) |
| Briefs and private docs | `systemMessage` (`append`), reopened before the next turn when they change |
| Permission rules | `onPermissionRequest`: `guard.ts`'s `evaluate` decides; deny → reject with a reason, ask → `permission.asked` for the human |
| Notes without a turn | kept, and appended to the next prompt in `<symbio-notes>`; the history shows them as notes again |
| Queued messages taken back mid-turn | `rpc.queue.pendingItems` / `rpc.queue.withdrawMessage` |
| Questions to the human | `onUserInputRequest` → a form with one `answer` field |
| Events and history | translated into OpenCode's vocabulary (`runtime/types.ts`); a quick turn's events wait until the prompt call has returned |
| A task's changes | the session's diff, kept to the files the task's turns edited (`fileEdits` of edit steps) |
| Signing in | its own `COPILOT_HOME` (given by Symbio) pointed at the user's GitHub login, or a device-code sign-in from Settings |
| Read rules | the `onPreToolUse` hook for `view` (and `read`, `read_file`) |
| Background processes | `rpc.tasks.list` / `rpc.tasks.cancel`, ids `<session>:<task>` |
| Prices | `billing.tokenPrices` / 100, as dollars per million tokens; your own providers' models from the price book |
| Your own providers | `providers.json` in your Copilot folder, read as it is, given to every session (`providers` + `models`) |
| Reasoning effort | `reasoningEffort` on `createSession` / `setModel`; levels from `supportedReasoningEfforts` (`low` … `max` for your own providers' models) |
| Co-author lines | `coauthorEnabled: false` unless the project allows them |
| Briefs | Symbio's tools named as Copilot shows them (`symbio-<name>`) |

| Memory, crashes | the runtime process (`copilot-runtime.exe --headless --stdio`, the client's `cliProcess`, not public API) measured like OpenCode's and recycled by the watchdog; `processExitPromise` marks it crashed and starts it again |

Verified live: killing the runtime process (by its PID) → crashed → started again (`restarts: 1`,
a new process); about 50 MB when idle.
