# Development

How to set up, run, test and change Symbio. If you're an AI agent, read [AGENTS.md](../AGENTS.md)
first.

## Setup

Requirements: Node.js 22+ and git. In a clone, `npm install` brings both agent runtimes as dev
dependencies (`@opencode/cli`, `@github/copilot-sdk`), and Symbio uses those; an installed Symbio has
none until the human installs one (`runtime/install.ts`, which installs exactly the dev dependency's
version). `SYMBIO_NO_DEV_RUNTIMES=1` makes a clone behave like a fresh install. OpenCode needs at least
one model provider connected (in Symbio's Settings, or with `opencode auth login`). Native modules (the OS keyring binding and `sharp`) install prebuilt
binaries; nothing compiles.

```sh
npm install
npm run build              # UI into dist/web, server into dist/server
node bin/symbio.js run     # foreground, http://127.0.0.1:4310
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server in watch mode (tsx) plus the Vite UI with hot reload on http://localhost:5173 (it proxies `/api` to the server) |
| `npm run dev:server` / `npm run dev:web` | The two halves of `npm run dev`, separately |
| `npm run build` | Production build: Vite for the UI, `tsc` for the server |
| `npm start` | Same as `sym`: starts the built app in the background and opens the browser (`node bin/symbio.js run` runs it in the foreground) |
| `npm test` | Unit tests (`node:test` via tsx, `tests/*.test.ts`) |
| `npm run test:contract` | The runtimes' APIs as Symbio uses them: a real `opencode serve`, and the real GitHub Copilot CLI when signed in (`tests/contract/`) |
| `npm run test:e2e` | The whole app (built first), driven in Edge/Chrome, once per runtime: against a stand-in OpenCode, then a stand-in Copilot (`tests/e2e/`, `scripts/e2e.mjs`) |
| `npm run typecheck` | Type-checks the server and the UI |
| `prepublishOnly` | Runs typecheck, tests and build before `npm publish` |

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, the OpenCode contract test, build and the
end-to-end tests on every push and pull request.
Releases (`.github/workflows/release.yml`) publish to npm when a `vX.Y.Z` tag is pushed (versions
with a `-` go to the `next` tag); the tag must match `package.json`.

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

- **Verify runtime behavior live.** Much of the OpenCode v2 API and of the Copilot SDK is new or
  experimental. Before relying on an endpoint, call or event, try it (`/api/debug/opencode/...`
  helps; for Copilot, a throwaway `scripts/_*.ts` with the SDK) and record what you found in
  [opencode-api.md](opencode-api.md) or [copilot-api.md](copilot-api.md).
- **Keep both runtimes working.** Agents run on OpenCode or GitHub Copilot CLI. The team logic, the
  API and the UI use `AgentRuntime` (`src/server/runtime/types.ts`), never one runtime's API; each
  runtime translates into Symbio's event and history vocabulary. Every end-to-end test runs on both
  runtimes and must pass on both. Something a runtime can't do yet is skipped there explicitly in
  the test, with the reason, and noted in that runtime's API page.
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
  new UI libraries. Never write a color in a rule: use a token (or `color-mix()` of tokens), so
  every theme follows. To add a theme, give its token values in `web/src/themes.css` under
  `html[data-theme="<id>"]` and list it in `THEMES` in `web/src/theme.ts`. Which VS Code colors
  an imported theme's tokens come from is the `MAP` in `web/src/vscodeTheme.ts`.
- **Tell the agents about changes.** When a change affects how agents work (tools, rules, messages
  they receive, what Symbio does on their behalf), add an entry to `src/server/updates.ts`. On the
  next start, each project's coordinator gets the entries it hasn't seen as a note (without being
  woken up), and the human sees them in Messages. New projects start with them marked as seen.
- **Keep state in plain files.** JSON/JSONL under `.symbio/` or `~/.symbio/`. Each module owns its
  file and writes it atomically (temporary file, then rename): `store.ts` for projects and the
  message log, and `plan.ts`, `assets.ts`, `rules.ts`, `costs.ts`, `connections.ts`, `remote.ts`
  for their own data.

## Testing

- `npm test` runs everything. Tests that touch the disk use a temporary `SYMBIO_HOME`, and the
  vault tests use their own keyring service (`SYMBIO_KEYRING_SERVICE`), so your real data and
  credentials are never touched.
- Git behavior (worktrees, merges, conflicts, restoring workspaces) is tested against real
  temporary repositories in `tests/workspaces.test.ts`.
- `tests/e2e/install.test.ts` covers the first-run install flow and the opt-in to an OpenCode found
  on PATH. The PATH test builds a temporary stand-in executable, so it never uses your own OpenCode.
- `npm run test:contract` starts the bundled OpenCode (or `SYMBIO_OPENCODE_BIN`) with its data in a
  temporary folder and checks every endpoint Symbio relies on that doesn't need a model. CI runs it
  on each push, and daily against the newest OpenCode too (`.github/workflows/opencode-contract.yml`).
  It also drives the real GitHub Copilot CLI through Symbio's Copilot runtime, with turns on a model
  that doesn't exist (they fail before reaching a provider, so nothing is billed). That part needs a
  GitHub login with Copilot: yours (`copilot login`, reused, not copied), or `COPILOT_GITHUB_TOKEN`
  (a fine-grained token with the Copilot Requests permission; CI's secret of that name). Without one
  it's skipped.
- A Symbio started with a temporary `SYMBIO_HOME` still uses your own OpenCode data (sessions,
  sign-ins) unless you also set the `XDG_*` folders (see [opencode-api.md](opencode-api.md)).
- For UI changes, add or extend an end-to-end test (below), and look at the result. `scripts/screenshot.mjs` captures screens with your installed
  Edge or Chrome (via `playwright-core`):

  ```sh
  node scripts/screenshot.mjs http://127.0.0.1:4310 ./shots "" "#/settings"
  ```

- To test server connections without a real server, `node scripts/ssh-test-server.mjs <folder>`
  starts a local SSH server (127.0.0.1:2222, user `deploy`, password `s3cret`).
- Files matching `scripts/_*` are git-ignored, which is handy for throwaway scripts.

## Releasing

1. Move the entries under `[Unreleased]` in `CHANGELOG.md` to a new version and set the same
   version in `package.json`.
2. If agents work differently, make sure `src/server/updates.ts` has entries for it.
3. `npm pack` and try the package from a temporary prefix before publishing:
   ```sh
   npm pack --pack-destination /tmp/symbio-pkg
   npm i -g --prefix /tmp/symbio-pkg/prefix /tmp/symbio-pkg/symbio-<version>.tgz
   SYMBIO_HOME=/tmp/symbio-pkg/home SYMBIO_PORT=4330 /tmp/symbio-pkg/prefix/sym doctor
   ```
4. Commit, tag the commit with the version (`git tag v<version>`) and push the tag. The **Release**
   workflow (`.github/workflows/release.yml`) checks that the tag matches `package.json`, runs the
   type-check, tests and build, and publishes to npm through trusted publishing: no npm token is
   stored anywhere, and the package gets provenance. It then creates the GitHub release, with the
   version's section of `CHANGELOG.md` (`scripts/release-notes.mjs`; pre-releases marked as such). It's authorized on npmjs.com → symbio →
   Settings → Trusted Publisher (GitHub Actions, user `linkzy`, repo `symbio`, workflow
   `release.yml`).

**Updates reach users by themselves.** Installed copies check npm and update automatically (see
`self-update.ts`), so a release goes out to everyone within hours: keep `CHANGELOG.md` current (its
section for the version is shown in Settings → Updates). A copy running from a clone (`npm link`)
never updates itself. To test updates without npm, install a packed version into a temporary
prefix and point it at a stand-in registry: `SYMBIO_UPDATE_REGISTRY` (serves `/symbio/latest`),
`SYMBIO_UPDATE_SPEC` (what to install, e.g. a `.tgz`) and `SYMBIO_UPDATE_CHANGELOG`.

The runtimes are pinned dev dependencies (`@opencode/cli`, patch updates only; `@github/copilot-sdk`,
exact), and they're the versions users install. Moving to a newer one means re-verifying the APIs in
[opencode-api.md](opencode-api.md) or [copilot-api.md](copilot-api.md) first; users get it with the
Symbio update (Settings → Agent runtimes reinstalls; a missing one is reinstalled at startup).

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

## End-to-end tests

`npm run test:e2e` (after `npm run build`) starts the real, built Symbio for each file in
`tests/e2e/`, with everything in temporary folders, and runs every test twice, once per runtime
(`SYMBIO_E2E_RUNTIME`; `node scripts/e2e.mjs --runtime copilot` runs one, and file paths pick some
tests):

- **OpenCode:** against `tests/e2e/fake-opencode.mjs`, a stand-in for `opencode serve` with the same
  API, events and stored messages (recorded from OpenCode 2.1.4 in
  `tests/e2e/fixtures/opencode-turns.json`).
- **GitHub Copilot CLI:** against `tests/e2e/fake-copilot.mjs`, loaded in place of the Copilot SDK
  (`SYMBIO_COPILOT_SDK`), with the same calls, permission and question callbacks, and events (as
  verified in [copilot-api.md](copilot-api.md)). It calls Symbio's tools through Symbio's real MCP
  server, and asks Symbio's rules before every tool call, as Copilot does.

Both have the same scripted "model". The tests drive Symbio through its API and a real browser
(Edge, or `BROWSER_CHANNEL=chrome`). Projects are created on the run's runtime with its models
(`MODEL`, `MODEL_2` in the harness). `startSymbio` gives the runtimes through the environment, as if
installed; `install.test.ts` starts with none (`SYMBIO_NO_DEV_RUNTIMES`) and installs them with
`tests/e2e/fake-installer.mjs` in place of npm (`SYMBIO_RUNTIME_INSTALLER`; `SYMBIO_FAKE_INSTALL_FAILS=<kind>`
makes it fail). Where the runtimes word things differently for the model (a
refused call, an answered question, how a tool call is written), the harness has helpers
(`refused`, `answered`, `RUNTIME`).

The script is written in the messages. A line `@<agent> <step>` is run by that agent (`core`, or a
helper's name), so a task given to a helper can carry the helper's own lines:

| Step | Does |
|---|---|
| `say <text>` | A text reply |
| `tool <name> <json>` | Calls one of Symbio's tools (`spawn_agent`, `merge_work`, `send_message`…), as a real model would |
| `shell <command>` | Runs a command in the agent's folder (e.g. `git commit`) |
| `write <path> <text>` | Writes a file in the agent's folder |
| `question <title> \| <option> \| …` | Asks through the runtime's question tool and waits for the answer |
| `wait <ms>` | Pauses |

A session on the model `UNAVAILABLE_MODEL` (`fake/unavailable`, `copilot/unavailable`) fails every
turn at once. `tests/e2e/harness.ts` has the helpers (`startSymbio`, `projectWithCore`, `idle`,
`history`, `openPage` for a desktop or phone page). When a runtime changes how a turn looks, record it
again with a real model and update its stand-in to match.

## Testing remote access

Set `SYMBIO_CLOUDFLARED_BIN` to a `.js` stand-in that prints a `https://….trycloudflare.com` line
and keeps running: Symbio runs it with Node instead of opening a real tunnel. Requests carrying a
`cf-ray` header (or the tunnel's host name) are then treated exactly as tunnel traffic.

## Platform notes

- **Windows** is where Symbio is developed. In Git Bash, prefix commands that pass `/api/...` paths
  with `MSYS_NO_PATHCONV=1`. git may warn about LF/CRLF conversion; that's harmless.
- **Never stop processes by name** while developing (`taskkill /IM node.exe` would close every Node
  program, including your editor's tooling). Stop the specific PID, for example the one listening
  on port 4310.
- macOS and Linux are untested. The folder picker uses `osascript` on macOS and `zenity` or
  `kdialog` on Linux; the vault needs a Secret Service on Linux.
