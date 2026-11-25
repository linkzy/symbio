# Contributing to Symbio

Thanks for your interest! Bug reports, ideas, documentation and code are all welcome, whether you
write them yourself or with an AI agent.

Looking for something to work on? Each item of the [roadmap](docs/roadmap.md) has an issue, with
where to start in the code: [good first issues](https://github.com/linkzy/symbio/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small and self-contained,
[help wanted](https://github.com/linkzy/symbio/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) are bigger. Comment on the issue to say you're taking it (and ask anything
there), so two people don't do the same work. The `area:` labels say which part of Symbio an issue
is about.

You don't need any API key or subscription to work on Symbio: the end-to-end tests run against
stand-ins for OpenCode and GitHub Copilot CLI, and so does CI on your pull request.

## Reporting bugs, asking and suggesting

Questions and ideas go to [Discussions](https://github.com/linkzy/symbio/discussions) (Q&A, Ideas).
For a bug, open an issue with the bug report form (Symbio's **Report a problem** button opens it with
your versions filled in), and include:

- what you did, what you expected, and what happened instead;
- your OS, Node.js version and Symbio version, and the agent runtime the project uses with its
  version (`sym doctor` prints them);
- relevant errors from the browser console or the terminal running Symbio.

Please don't paste API keys, tokens or private project content. For security issues, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Making a change

1. **Discuss bigger changes first.** For anything beyond a small fix, open an issue describing the
   problem and your approach, so the work doesn't get lost to a different direction.
2. **Fork and branch.** Branch from `main` with a descriptive name (`fix/form-multiselect`,
   `feat/agent-graph`).
3. **Set up.** Follow [docs/development.md](docs/development.md). Use a separate `SYMBIO_HOME` so
   your experiments don't touch your real projects.
4. **Make the change**, following the conventions in [docs/development.md](docs/development.md):
   domain-neutral, runtime behavior (OpenCode, Copilot) verified live, no secrets reaching the browser or agents, code
   that matches its surroundings.
5. **Check it.**
   ```sh
   npm run typecheck
   npm test
   npm run build
   npm run test:e2e
   ```
   Add or update tests for logic you change (especially `guard.ts`, workspaces, the plan and the
   asset register), and an end-to-end test in `tests/e2e/` for what users see or do. For UI changes, run the app and look at it; include before/after screenshots in
   the pull request.
6. **Update the docs** your change affects (`README.md`, `docs/`, `AGENTS.md`), and add an entry to
   `CHANGELOG.md` under *Unreleased* for what users will notice. Adding a skill to the ones Symbio
   ships follows the rules in [docs/development.md](docs/development.md) (license, credit, pinned
   copy).
7. **Open a pull request** that explains what changed and why, how you tested it, and any follow-up
   work. Keep pull requests focused: one topic each.

## Working with AI agents

This project is built with AI agents, and contributions made that way are welcome on the same
terms as any other. You're responsible for what you submit:

- point your agent at [AGENTS.md](AGENTS.md); it has the rules and links to the docs;
- review the diff yourself before opening the pull request; don't submit changes you don't
  understand;
- make sure claims in the pull request ("tested", "works on macOS") are things you actually
  verified.

## Commit messages

Write the subject in the imperative and say what changed for the user or the code
("Restart a stopped helper from its chat header"). Use the body for the why. You don't need to
credit AI tools in commits; mentioning in the pull request that a change was AI-assisted is enough.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
