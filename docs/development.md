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
| `npm run test:e2e` | The whole app (run `npm run build` first: it tests the built app), driven in Edge/Chrome, once per runtime (both at once, several files in parallel): against a stand-in OpenCode and a stand-in Copilot (`tests/e2e/`, `scripts/e2e.mjs`) |
| `npm run typecheck` | Type-checks the server and the UI |
| `npm run i18n:check` | Lists the interface texts each language lacks (shown in English until translated) and texts whose `{placeholders}` differ from English's; `-- --strict` fails on them |
| `prepublishOnly` | Runs typecheck, tests and build before `npm publish` |

CI (`.github/workflows/ci.yml`) runs typecheck, the translations check (as a warning), unit tests, the
contract tests, build and the end-to-end tests on every push and pull request.
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
src/server/            Node server (Hono): API, team logic, MCP tools
src/server/team/       The team's parts (task flow, checks and reviewers, questions, sessions…)
src/server/runtime/    AgentRuntime, installing the runtimes, their settings
src/server/opencode/   OpenCode process supervisor and HTTP client
src/server/copilot/    The GitHub Copilot CLI runtime (over the Copilot SDK)
web/src/               React UI (Vite); styles.css is the whole design system
skills/                The skills Symbio ships (its own and vetted third-party copies; catalog.json)
tests/                 Unit tests; tests/e2e/ end-to-end, tests/contract/ the real runtimes
scripts/               Dev helpers (dev runner, screenshots, a local SSH test server)
scripts/install/       The one-line installers (install.ps1, install.sh), served by the website
assets/                Shipped with the package: the icon the Windows installer's shortcuts use
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
- **The UI reflects real events.** Status, kanban and inbox come from the runtimes' events and
  Symbio's records, never from asking a model.
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
- **Interface text goes through `t()`** (`useI18n()` in components, `t` from `web/src/i18n.ts`
  elsewhere) with a key in `web/src/i18n/en.ts`; keys are typed, so a key that doesn't exist is a
  type error. Add the Portuguese (Brazil) text in `web/src/i18n/pt-BR.ts` too if you can; a text a
  language lacks shows in English (`npm run i18n:check` lists them). Agents' briefs and Symbio's
  messages to agents stay in English: they're instructions for models. See *Translations* below.
- **Tell the agents about changes.** When a change affects how agents work (tools, rules, messages
  they receive, what Symbio does on their behalf), add an entry to `src/server/updates.ts`. On the
  next start, each project's coordinator gets the entries it hasn't seen as a note (without being
  woken up), and the human sees them in Messages. New projects start with them marked as seen.
- **Keep state in plain files.** JSON/JSONL under `.symbio/` or `~/.symbio/`. Each module owns its
  file and writes it atomically (temporary file, then rename): `store.ts` for projects and the
  message log, and `plan.ts`, `assets.ts`, `questions.ts`, `files.ts`, `rules.ts`, `costs.ts`,
  `connections.ts`, `remote.ts` for their own data.
- **Skills Symbio ships** (`skills/`). Ours are written for any kind of project. A third-party one
  comes in only with a permissive license (MIT, Apache-2.0), as a copy pinned to one commit with its
  license file, credited in `skills/catalog.json` (author, source, license, what we changed), and
  adapted only by an "In Symbio" note on how it maps to Symbio. No skills that bundle servers,
  hooks, telemetry or many scripts. Frontmatter values with `: ` in them are quoted (Copilot skips
  a skill whose frontmatter isn't valid YAML); `tests/skills.test.ts` checks all of this.

## Translations

The interface's text is in `web/src/i18n/`: `en.ts` (the base, by screen) and one file per language
(`pt-BR.ts`). The language is the one chosen in Settings → This computer → Appearance, or else the
browser's. To add a language:

1. Copy `web/src/i18n/pt-BR.ts` to `web/src/i18n/<code>.ts` (e.g. `es.ts`), rename its export, and
   translate the texts from `en.ts` (keep the `{placeholders}`, and the words in
   [glossary.md](glossary.md): add a column for the language there).
2. Add it to `Locale`, `LOCALES` and `DICTS` in `web/src/i18n.ts`, and to `browserLocale` if its code
   needs mapping.
3. `npm run i18n:check` shows what's left; a text not translated yet shows in English.
4. Look at the main screens in that language (`scripts/screenshot.mjs`, also at a phone width): longer
   words can break a layout.

## Testing

- `npm test` runs the unit tests. Tests that touch the disk use a temporary `SYMBIO_HOME`, and the
  vault tests use their own keyring service (`SYMBIO_KEYRING_SERVICE`), so your real data and
  credentials are never touched.
- Git behavior (worktrees, merges, conflicts, restoring workspaces) is tested against real
  temporary repositories in `tests/workspaces.test.ts`.
- `tests/e2e/install.test.ts` covers the first run (each step, installing a runtime, using the
  computer's OpenCode, a Copilot CLI found on the computer) and the PATH opt-in. The PATH tests
  build temporary stand-in executables, so they never use your own OpenCode or Copilot.
- Adding a runtime: describe how it's found on the computer (`command` in `RUNTIME_PACKAGES`,
  `runtime/install.ts`) and whether Symbio can run on that copy (`computerUsable`).
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
- The one-line installers (`scripts/install/`) are tested on clean GitHub runners by
  `.github/workflows/install.yml` (Windows PowerShell 5.1 and 7, Ubuntu, macOS) whenever they change:
  install, `sym`, start, a second run, uninstall. To try one on your machine without touching your
  own install, use a temporary `SYMBIO_HOME`, another `SYMBIO_PORT`, and `SYMBIO_NO_PATH=1`,
  `SYMBIO_NO_SHORTCUT=1`, `SYMBIO_NO_GIT=1` (the installer otherwise edits your PATH and shortcuts).
  Also `SYMBIO_UPDATE_URL=off` before starting what it installed: an installed copy asks the update
  endpoint, which would count it as a user.
  The website hosts copies of them (symbio.linkzy.dev/install.ps1 and /install): when they change,
  the new files go to the website's team, which replaces its copies byte for byte.
- Files matching `scripts/_*` are git-ignored, which is handy for throwaway scripts.

## Releasing

The maintainers' checklist is in [releasing.md](releasing.md): who changes what (Symbio is also
developed by a Symbio team, on branches and pull requests), versions, the gated release workflow,
recovering from a failed one, and how updates and runtime versions reach users.

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
| `knows <text>` | Says `knows: yes` or `no`: whether the agent's instructions contain the text (its brief, glossary, private docs) |
| `skills` | Says the skills the agent's session has, as the runtime filters them |
| `coauthor` | Says whether the session may add AI co-author lines to commits |

A session on the model `UNAVAILABLE_MODEL` (`fake/unavailable`, `copilot/unavailable`) fails every
turn at once. `tests/e2e/harness.ts` has the helpers (`startSymbio`, `projectWithCore`, `idle`,
`history`, `openPage` for a desktop or phone page, `ownClipboard`). `projectWithCore` creates projects
that ask and wait (`autonomy: "ask"`) unless a test passes `autonomy: "decide"`. When a runtime changes how a turn looks, record it
again with a real model and update its stand-in to match.

### Running them fast, and keeping them steady

Each file starts its own Symbio, ports and folders, so files run several at a time: both runtimes at
once, each with a few files in parallel (`--jobs N` or `SYMBIO_E2E_JOBS`; by default from the CPU
threads and memory, at most 4 per runtime). On a 28-thread machine the whole suite takes about 1 min 45 s
(8 min one file at a time); on a 4-thread one, one file per runtime at a time. `--serial` runs one
runtime after the other, one file at a time, as before. Each runtime's lines are tagged
(`[opencode]`, `[copilot]`) and the end says how long each took.

Running several files at once makes a slow machine slower, so tests must not depend on timing:

- **Wait for what you check.** After an action, poll with `until(…)` (or a Playwright locator's
  `waitFor`) instead of asserting at once; the UI and the agents get there a moment later.
- **Wait for the team** with `idle(…)` before reading an agent's history; it waits until nobody has
  been working for half a second.
- **Never `page.waitForFunction` with a promise** (like `navigator.clipboard.readText()`): it doesn't
  wait for the promise, so it passes at once. Read the value in `until(…)`.
- **Copying**: give the page its own clipboard with `ownClipboard(context)` and read it with
  `clipboardText(page)`. The computer's clipboard is shared by every test running at the same time
  (and by whoever runs them).
- **Code run in the page** (`page.evaluate`, `addInitScript`): pass a string, or a function with
  no named inner functions. tsx adds a `__name` helper to those, which doesn't exist in the page.
- **Text that loads**: a label can show a placeholder until its data arrives (the project's name in
  Settings' Back); wait for the final text.
- The limits (`until` 30 s, `idle` 40 s) only matter when something is wrong; don't lower them, and
  give a test's slow step its own larger limit rather than adding sleeps.
- A long file is a long pole: when one grows past ~15 s, split it by theme (each file is one
  Symbio).

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
- macOS and Linux are less tried. The folder picker uses `osascript` on macOS and `zenity` or
  `kdialog` on Linux; the vault needs a Secret Service on Linux. To try a change on a clean headless
  Linux or a clean Windows, see [platform-testing.md](platform-testing.md).
