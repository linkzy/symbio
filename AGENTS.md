# AGENTS.md

You're working on **Symbio**, a local web app that runs a team of OpenCode agents on a user's
project: a lead agent (core) plans and delegates to helper agents in git worktrees, agents message
each other through Symbio, and the human steers from the browser.

## Start here

- [docs/architecture.md](docs/architecture.md): how it fits together and what each module does.
- [docs/development.md](docs/development.md): setup, scripts, testing, conventions.
- Read the doc for the area you touch: [agent-protocol](docs/agent-protocol.md) (briefs, tools,
  shared assets), [opencode-api](docs/opencode-api.md) (anything calling OpenCode),
  [security](docs/security.md) (permissions, credentials, the local API).

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev        # server (watch) + UI on http://localhost:5173
```

Before you finish: `npm run typecheck`, `npm test` and `npm run build` must pass.

## Rules

- **Domain-neutral.** Symbio is for any kind of project. Never assume software in code, UI text or
  agent briefs ("shared asset", not "database").
- **Verify OpenCode behavior live** before relying on it, and record what you learn in
  `docs/opencode-api.md`. The v2 API is partly experimental.
- **No secrets to the browser or to agents.** Copy whitelisted fields from OpenCode responses;
  never pass them through.
- **Safety first on the user's machine.** Never stop processes by name (`taskkill /IM`, `pkill`);
  use specific PIDs. Don't weaken `src/server/guard.ts` rules; extend `tests/guard.test.ts` when you
  change them.
- **Don't touch the user's data while developing.** Use a temporary `SYMBIO_HOME` (and
  `SYMBIO_PORT`) for manual runs; tests already do.
- **Match the surrounding code**: TypeScript ESM, 2-space indent, double quotes, comments that
  explain why. In the UI, reuse `styles.css` tokens and `ui.tsx` components; no new UI libraries
  without a reason.
- **Look at UI changes** (screenshot with `scripts/screenshot.mjs`) instead of assuming they render.
- **Keep docs true.** If your change makes a doc wrong, fix the doc in the same change.
- **Tell the agents.** If a change affects how agents work (tools, rules, what Symbio does for them),
  add an entry to `src/server/updates.ts`: running projects' coordinators get it after the update.
