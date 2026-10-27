# Development

How to set up, run, test and change Symbio. If you're an AI agent, read [AGENTS.md](../AGENTS.md)
first.

## Setup

Requirements: Node.js 22+, OpenCode 2.x (`npm i -g @opencode/cli`) with at least one provider
connected, and git.

```sh
npm install
npm run build      # UI into dist/web, server into dist/server
npm start          # http://127.0.0.1:4310
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server in watch mode (tsx) plus the Vite UI with hot reload on http://localhost:5173 (it proxies `/api` to the server) |
| `npm run build` | Production build: Vite for the UI, `tsc` for the server |
| `npm start` | Runs the built app (`bin/symbio.js` → `dist/server/index.js`) |
| `npm test` | Unit tests (`node:test` via tsx, `tests/*.test.ts`) |
| `npm run typecheck` | Type-checks the server and the UI |

**Keep your real data separate while developing.** The dev server uses the same port and data
folder as a normal Symbio. To run both side by side:

```sh
SYMBIO_HOME=/tmp/symbio-dev SYMBIO_PORT=4320 npm run dev
```

The Vite proxy follows `SYMBIO_PORT`.

## Layout

```
bin/symbio.js          CLI entry (symbio / sym)
src/server/            Node server (Hono): API, team logic, MCP tools, OpenCode runtime
src/server/opencode/   OpenCode process supervisor and HTTP client
web/src/               React UI (Vite); styles.css is the whole design system
tests/                 Unit tests
scripts/               Dev helpers (dev runner, screenshots, a local SSH test server)
docs/                  This documentation
```

[architecture.md](architecture.md) describes what each server module does.

## Making changes

- **Verify OpenCode behavior live.** Much of the OpenCode v2 API is new or experimental. Before
  relying on an endpoint or event, call it (`/api/debug/opencode/...` helps) and record what you
  found in [opencode-api.md](opencode-api.md).
- **Stay domain-neutral.** Nothing in Symbio, including the agent briefs in `prompts.ts`, should
  assume the project is software. Use "shared asset", "helper", "work", not "database", "backend",
  "code".
- **The UI reflects real events.** Status, kanban and inbox come from OpenCode events and Symbio's
  records, never from asking a model.
- **Secrets stay on the server.** Nothing secret goes back to the browser or into an agent's context.
  When you proxy an OpenCode response, copy the fields you need instead of passing it through.
- **Safety rules have tests.** If you touch `guard.ts`, extend `tests/guard.test.ts`.
- **Match the surrounding code.** TypeScript (ESM), 2-space indent, double quotes, lines up to about
  140 characters. Comments explain *why*, not what. The UI uses the existing tokens and components
  in `styles.css` and `ui.tsx` (Dialog, Drawer, EmptyState, Avatar) and lucide icons; avoid adding
  new UI libraries.
- **Keep state in plain files.** JSON/JSONL under `.symbio/` or `~/.symbio/`, written through `store.ts`.

## Testing

- `npm test` runs everything. Tests that touch the disk use a temporary `SYMBIO_HOME`, and the
  vault tests use their own keyring service (`SYMBIO_KEYRING_SERVICE`), so your real data and
  credentials are never touched.
- Git behavior (worktrees, merges, conflicts, restoring workspaces) is tested against real
  temporary repositories in `tests/workspaces.test.ts`.
- For UI changes, look at the result. `scripts/screenshot.mjs` captures screens with your installed
  Edge or Chrome (via `playwright-core`):

  ```sh
  node scripts/screenshot.mjs http://127.0.0.1:4310 ./shots "" "#/settings"
  ```

- To test server connections without a real server, `node scripts/ssh-test-server.mjs <folder>`
  starts a local SSH server (127.0.0.1:2222, user `deploy`, password `s3cret`).
- Files matching `scripts/_*` are git-ignored, which is handy for throwaway scripts.

## Debugging

- **Calling the API yourself** (curl, scripts): every `/api` request needs the UI key, from
  `~/.symbio/ui-token`, in an `x-symbio-token` header:
  `curl -H "x-symbio-token: $(cat ~/.symbio/ui-token)" http://127.0.0.1:4310/api/projects`.
- With `SYMBIO_DEBUG=1`, `GET /api/debug/opencode/<path>` proxies read-only requests to the private
  OpenCode server, for example `/api/debug/opencode/api/session/<id>/message` or
  `/api/debug/opencode/openapi.json`. It's off by default because OpenCode responses can contain
  provider keys.
- OpenCode logs to its own data folder (`~/.local/share/opencode/log/` on every platform).
- Every agent is an OpenCode session; `opencode -s <session-id>` opens one in the terminal.
- The message log of a project is `<project>/.symbio/messages.jsonl`.

## Platform notes

- **Windows** is where Symbio is developed. In Git Bash, prefix commands that pass `/api/...` paths
  with `MSYS_NO_PATHCONV=1`. git may warn about LF/CRLF conversion; that's harmless.
- **Never stop processes by name** while developing (`taskkill /IM node.exe` would close every Node
  program, including your editor's tooling). Stop the specific PID, for example the one listening
  on port 4310.
- macOS and Linux are untested. The folder picker uses `osascript` on macOS and `zenity` or
  `kdialog` on Linux; the vault needs a Secret Service on Linux.
