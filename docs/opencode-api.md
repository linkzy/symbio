# OpenCode API notes

Symbio drives OpenCode v2 through its HTTP API. Much of that API is new or marked experimental, so
everything here was **verified against OpenCode 2.1.4** by calling it, not taken from memory.
When OpenCode changes, re-verify before relying on a behavior, and update this page.

`tests/contract/opencode.test.ts` (`npm run test:contract`) checks the endpoints below that don't
need a model turn, plus the inbox and failed-turn behaviors, against a real `opencode serve`. CI
runs it on every push and every day, also against the newest OpenCode release (2.2.7 passed on
2026-11-11). Extend it when Symbio starts relying on another endpoint or behavior.

The live OpenAPI document is served by OpenCode itself at `/openapi.json`. With Symbio running you
can read it, and any other GET endpoint, through Symbio's read-only debug proxy (start Symbio with
`SYMBIO_DEBUG=1`, and send the UI key as shown in [development.md](development.md)):
`http://127.0.0.1:4310/api/debug/opencode/openapi.json`.

## The private server

`src/server/opencode/runtime.ts` starts `opencode serve --hostname 127.0.0.1 --port <random> --stdio`
with `OPENCODE_SERVER_PASSWORD=<random>`; requests use Basic auth with user `opencode`.

`--stdio` matters for security. Without it, the password stays in OpenCode's environment and every
agent shell inherits it, so an agent could call the OpenCode API itself and rewrite its own
permission rules. In stdio mode OpenCode deletes `OPENCODE_SERVER_PASSWORD`/`OPENCODE_PASSWORD`
from its environment after reading them, prints `{"url": …}` on stdout, and exits when its stdin
closes, so it never outlives Symbio. (Verified: an agent shell sees an empty variable.)

Agents' shells inherit `CI=1`, `npm_config_yes=true`, `GIT_TERMINAL_PROMPT=0` and `PIP_NO_INPUT=1`
so commands don't hang waiting for input. The PID is stored in `~/.symbio/opencode.pid`; on start,
Symbio stops a server left behind by a previous run, if it's still running.

## Endpoints Symbio uses

| Need | Endpoint |
|---|---|
| Server version | `GET /api/info` |
| Create an agent | `POST /api/session` `{title, location: {directory}, model: {providerID, id}, permissions}` |
| Read a session / its messages | `GET /api/session/{id}`, `GET /api/session/{id}/message?limit=&cursor=` (newest first) |
| Update permissions | `PATCH /api/session/{id}` |
| Deliver a message (wakes the agent) | `POST /api/session/{id}/prompt` `{text, delivery: "queue" \| "steer"}` |
| A session's file changes over a range of turns | `GET /api/session/{id}/diff?from=<user message id>&to=<user message id>&context=<lines>` → `data: [{file, status, additions, deletions, patch}]` |
| Add to the conversation without a turn | `POST /api/session/{id}/synthetic` `{text, delivery, resume}` |
| Interrupt (watchdog, pause) | `POST /api/session/{id}/interrupt` |
| Switch model | `POST /api/session/{id}/model` `{model: {providerID, id}}` |
| Pending inbox items / cancel one | `GET /api/session/{id}/inbox`, `DELETE /api/session/{id}/inbox/{itemID}` |
| Briefs (per-session instructions) | `PUT` / `DELETE /api/experimental/session/{id}/instructions/entries/{key}` `{value}` |
| Permission requests | events `permission.asked` / `permission.replied`; reply `POST /api/session/{id}/permission/{requestID}/reply` with `once`, `always` or `reject` |
| Forms (the `question` tool) | `GET /api/session/{id}/form`, `POST /api/session/{id}/form/{formID}/reply` `{answer}` |
| Background shells | `GET /api/shell?location[directory]=…`, `DELETE /api/shell/{id}?location[directory]=…`; a shell an agent started has `metadata.sessionID` (verified 2.1.4), which is how Symbio tells agents' processes apart in a shared folder |
| Register Symbio's tools | `PUT /api/experimental/mcp/symbio?location[directory]=…` `{config: {type: "remote", url}}` |
| Check tool registration | `GET /api/mcp?location[directory]=…` → `data: [{name, status: {status: "connected"}}]` |
| Models / providers | `GET /api/model`, `GET /api/provider` |
| Provider catalog | `GET /api/integration` (each with `methods` and current `connections`) |
| Connect by key | `POST /api/integration/{id}/connect/key` `{key, answer}` |
| Connect by browser sign-in | `POST /api/integration/{id}/connect/oauth` `{methodID, answer}` → `{attemptID, url, instructions, mode}`; poll `GET …/oauth/{attemptID}`; `POST …/complete {code}` for `mode: "code"`; `DELETE` to cancel |
| Saved logins | `POST /api/credential`, `DELETE /api/credential/{id}` |
| Events | `GET /api/event` (SSE: `data:` JSON lines, `: heartbeat` comments) |

Event types Symbio reacts to include `session.execution.started` / `.succeeded` / `.failed` (busy
and idle), `session.text.*`, `session.reasoning.*`, `session.tool.*` (live output), retry events,
`session.usage.updated` (tokens and cost), `permission.asked` and form events.

## Behaviors worth knowing

- **Code mode: Symbio's tools are called from a script.** Agents often call MCP tools through
  OpenCode's `execute` tool: `input.code` is a JavaScript snippet (`await tools.symbio.send_message({…})`,
  sometimes several calls in one step), and the stored part's `state.metadata.toolCalls` lists what it
  called: `[{tool: "symbio.send_message", status: "completed", input: {…}}]`. The output is the calls'
  text results joined. Shell steps store only `input.command` (plus `timeout`, `workdir`): no
  description of what the command is for. Each model step is its own assistant message, so a run
  of tool steps is a run of messages. Verified on the user's real sessions (2.1.4, 2026-11-13); the
  chat labels steps from these (`web/src/steps.ts`) and falls back to reading the script's code
  while a step runs.
- **A session's changes, turn by turn** (`GET /api/session/{id}/diff`): the files its turns changed,
  with unified patches, whether or not anything was committed (so also for agents sharing a folder,
  each with its own changes). `from` and `to` are user message ids; the id `POST …/prompt` returns is
  the id of the user message it becomes. It only works in a git repository: in a folder without git
  it returns nothing (verified live on 2.1.4 with a real model, 2026-11-12). Symbio's changes view per
  task is built on it.
- **An `edit` deny on `*` takes the editing tools away.** With `{action: "edit", resource: "*",
  effect: "deny"}` in a session's rules, the model isn't offered its write/edit tools at all ("I
  don't have a write or edit tool"); shell denies such as `* > *` refuse those commands
  ("Permission denied: shell") while `git --version` or reading files still work (verified live with
  Haiku on 2.1.4; Plan mode relies on it). There is no built-in read-only "plan" agent to switch a
  session to in 2.1.4: `GET /api/agent` lists none, and turns run as the implicit `build` agent.
- **Notes wait in the inbox.** `synthetic` with `resume: false` doesn't add to the conversation
  at once: the note sits in the session's inbox (`GET …/inbox`) and joins the conversation when the
  next turn starts, which is how Symbio tells core something without waking it.
- **A turn takes one inbox item, the oldest.** After a turn that *fails*, the rest stay queued until
  something starts another turn (a new prompt): they are not delivered on their own.
- **A model that doesn't exist fails each turn at once** (`idle` message with `outcome: "failed"`,
  `error.type: "provider.no-route"`, "Model unavailable: …"), with no network call. The contract
  test uses that to exercise turns without a model or a sign-in.
- **OpenCode's data follows the XDG folders** (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`) on every platform, Windows included; set them to keep a test's sessions out of
  your own OpenCode database. Without sign-ins it still offers its free `opencode/…` models.
- **Images read with the read tool stay in the conversation as data** and are sent with every
  request. A session with eight 2–4 MB images (about 25 MB) failed on every model with "Timed out
  reading request body. Try again, or use a smaller request size." (GitHub Copilot), even with
  1M-token models: the limit is the request's size, not tokens. Symbio treats that error as "start a
  fresh session", not as a model failure.
- **Images from an MCP tool reach the model.** A tool result with `{type: "image", data, mimeType}`
  content shows up as a `file` part with a data URI, and a vision model describes it (verified
  2.1.4). That's how `view_image` works.
- **A deny rule can't carry a message** (`Permission.Rule` is only action, resource, effect), so the
  agent just sees "Permission denied: read" and may give up. An `ask` rule that Symbio answers with
  `reject` and a `message` reaches the agent as the tool's error, so it learns what to do instead
  (verified 2.1.4: the agent then used `view_image`).

- **Code mode's catalog notices don't list MCP tools.** OpenCode posts "The Code Mode tool catalog
  has changed … The catalog is complete" into a session, listing only its own `opencode` tools.
  Symbio's tools still work (`tools.symbio.<name>` inside `execute`, discoverable with
  `search({ namespace: "symbio" })`): one coordinator kept making Symbio calls for days after such a
  notice, while another took it literally and told the human its tools were gone. The briefs say so.
- **A runtime-registered MCP server is "pending" right after the `PUT`** and "connected" a moment
  later; a prompt sent while it's pending still gets its tools (verified 2.1.4).

- **Tool calls carry the session.** Every MCP call from OpenCode includes
  `params._meta["ai.opencode/sessionID"]`, which is how Symbio knows which agent is calling.
  Tool *listing* has no session, so the listing for the project root (core's folder) returns the
  coordinator tools; calls are still checked against the caller's role.
- **MCP registrations are in memory and per folder.** They're lost when OpenCode restarts, and also
  when OpenCode **evicts an idle folder** ("location services evicted" in its log, after roughly an
  hour without activity). Symbio re-registers on runtime start and checks before every turn it
  starts (`ensureTools` in `team.ts`).
- **Permission rules** are `{action: "shell" | "read" | "edit", resource: <wildcard>, effect}`. Any
  matching `deny` blocks the call; the shell scanner splits compound commands and matches each
  part. Matching can be case-sensitive, so `guard.ts` lists spelling variants.
- **Form field types** are `string` (with optional single-choice `options`), `multiselect` (the
  answer must be a string array), `boolean`, `integer`, `number` and `external` (a link). Fields
  may have `description` (often the actual question text), `maxItems`, `custom` (free text
  allowed) and `when` conditions on other answers.
- **Provider connect flows.** `connect/key` only exists for integrations with a plugin; plain
  catalog providers (OpenRouter, Anthropic…) return 404 "Integration not found", and saving a
  credential with `POST /api/credential {integrationID, value: {type: "key", key, metadata}}` is
  how they're connected. Extra form answers (like Azure's `resourceName`) go in `metadata`.
- **Message pages.** `GET /api/session/{id}/message` returns newest first, with `cursor.next` for
  older pages. The cursor is base64url JSON `{"id": <message id>, "order": "desc", "direction":
  "next"}`, meaning "older than that message", so Symbio builds it itself to fetch "the N messages
  before X" (verified: identical to OpenCode's own cursor). An invalid cursor returns 400.
- **Secrets in responses.** `GET /api/credential` and `GET /api/provider` can return API keys in
  full. Never forward them to the browser; `providers.ts` copies whitelisted fields only.
- **Quota errors.** OpenCode's own free tier limit is per account, not per model, so falling back to
  another free OpenCode model doesn't help; fall back to another provider.
