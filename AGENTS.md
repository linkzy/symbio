# AGENTS.md

You're working on **Symbio**, a local web app that runs a team of AI agents (on OpenCode or GitHub Copilot CLI) on a user's
project: a lead agent (core) plans and delegates to helper agents in git worktrees, agents message
each other through Symbio, and the human steers from the browser.

## Start here

- [docs/architecture.md](docs/architecture.md): how it fits together and what each module does.
- [docs/development.md](docs/development.md): setup, scripts, testing, conventions.
- [docs/glossary.md](docs/glossary.md): Symbio's words, one per thing; use them in the UI, docs and briefs.
- Read the doc for the area you touch: [agent-protocol](docs/agent-protocol.md) (briefs, tools,
  shared assets), [opencode-api](docs/opencode-api.md) (anything calling OpenCode),
  [copilot-api](docs/copilot-api.md) (anything calling GitHub Copilot CLI),
  [security](docs/security.md) (permissions, credentials, the local API).

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e   # the whole app in a browser, on each runtime: stand-in OpenCode and stand-in Copilot (after build)
npm run test:contract  # the runtimes' APIs as Symbio uses them: the real OpenCode, and the real Copilot CLI (with a login)
npm run dev        # server (watch) + UI on http://localhost:5173
```

Before you finish: `npm run typecheck`, `npm test`, `npm run build` and `npm run test:e2e` must pass
(and `npm run test:contract` when you touch how Symbio calls a runtime). A user-visible change gets an
end-to-end test in `tests/e2e/` (see [docs/development.md](docs/development.md#end-to-end-tests)).

**Both runtimes, always.** Agents run on OpenCode or GitHub Copilot CLI (`src/server/runtime/types.ts`).
The end-to-end suite runs every test on both, and both must pass: what starts working on one side must
not break the other. Team logic talks to `AgentRuntime`, never to one runtime's API. When a runtime
can't support something yet, skip it there explicitly in the test, with the reason, and note it in
[docs/copilot-api.md](docs/copilot-api.md) or [docs/opencode-api.md](docs/opencode-api.md).

## Rules

- **Domain-neutral.** Symbio is for any kind of project. Never assume software in code, UI text or
  agent briefs ("shared asset", not "database").
- **Verify runtime behavior live** before relying on it, and record what you learn in
  `docs/opencode-api.md` or `docs/copilot-api.md`. Both APIs are partly experimental.
- **No secrets to the browser or to agents.** Copy whitelisted fields from runtime responses;
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

## If you're an agent in a Symbio team

Symbio is developed with Symbio too. If you're core or a helper in a Symbio project working on this
repository:

- **The Symbio running you is the installed version, not this code.** Its tools, rules and briefs
  come from that version; this folder may be ahead of it. Don't assume a change here affects you.
- **Never touch the running Symbio**: don't start this code on its port (4310) or with its data
  (`~/.symbio`), and don't install or link this folder globally. Manual runs use a temporary
  `SYMBIO_HOME` and `SYMBIO_PORT`; the tests already do.
- **Work on branches, and open pull requests.** One branch per issue (`symbio/<issue>-<short-name>`),
  never pushed to `main` or `next` directly. CI checks the pull request; the maintainers review and
  merge it.
- **Never create tags or releases**: a version tag publishes to npm. Releases are cut by the
  maintainers.
- **Claim an issue before working on it** with the `in progress: symbio` label, and leave issues
  that have it (or are assigned to someone) to whoever has them.
- Heavy work (the end-to-end suite, builds) runs one helper at a time: it starts browsers and several
  Symbio instances.
