# OpenCode API notes

Symbio drives OpenCode v2 through its HTTP API. Much of that API is new or marked experimental, so
everything here was **verified against OpenCode 2.1.4** by calling it, not taken from memory.
When OpenCode changes, re-verify before relying on a behavior, and update this page.

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
| Read a session / its messages | `GET /api/session/{id}`, `GET /api/session/{id}/message` |
| Update permissions | `PATCH /api/session/{id}` |
| Deliver a message (wakes the agent) | `POST /api/session/{id}/prompt` `{text, delivery: "queue" \| "steer"}` |
| Add to the conversation without a turn | `POST /api/session/{id}/synthetic` `{text, delivery, resume}` |
| Interrupt (watchdog, pause) | `POST /api/session/{id}/interrupt` |
| Switch model | `POST /api/session/{id}/model` `{model: {providerID, id}}` |
| Pending inbox items / cancel one | `GET /api/session/{id}/inbox`, `DELETE /api/session/{id}/inbox/{itemID}` |
| Briefs (per-session instructions) | `PUT` / `DELETE /api/experimental/session/{id}/instructions/entries/{key}` `{value}` |
| Permission requests | events `permission.asked` / `permission.replied`; reply `POST /api/session/{id}/permission/{requestID}/reply` with `once`, `always` or `reject` |
| Forms (the `question` tool) | `GET /api/session/{id}/form`, `POST /api/session/{id}/form/{formID}/reply` `{answer}` |
| Background shells | `GET /api/shell?location[directory]=…`, `DELETE /api/shell/{id}?location[directory]=…` |
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
- **Secrets in responses.** `GET /api/credential` and `GET /api/provider` can return API keys in
  full. Never forward them to the browser; `providers.ts` copies whitelisted fields only.
- **Quota errors.** OpenCode's own free tier limit is per account, not per model, so falling back to
  another free OpenCode model doesn't help; fall back to another provider.
