# Symbio documentation

For people and AI agents working **on** Symbio. To *use* Symbio, start with the main
[README](../README.md), then [usage.md](usage.md), [features.md](features.md),
[configuration.md](configuration.md) and [known-issues.md](known-issues.md).

| Document | Read it when |
|---|---|
| [architecture.md](architecture.md) | You want the big picture: how the server, the agent runtimes (OpenCode, GitHub Copilot CLI) and the UI fit together, what each module does, project lifecycle, reliability, where data lives |
| [agent-protocol.md](agent-protocol.md) | You're changing how agents behave: roles, messages, shared assets, plan and tasks, checks and reviewers, questions and briefings, the tools they call |
| [glossary.md](glossary.md) | You're naming something people or agents read: the one word for each thing, in English and Portuguese, and its name in the code |
| [opencode-api.md](opencode-api.md) | You're calling OpenCode: the endpoints Symbio uses and the behaviors verified against 2.1.4 |
| [copilot-api.md](copilot-api.md) | You're working on GitHub Copilot CLI as a runtime: the Copilot SDK as Symbio uses it, verified live |
| [development.md](development.md) | You're setting up, running, testing or debugging Symbio, or want the code conventions |
| [security.md](security.md) | You're touching anything around agent permissions, credentials or the local API |
| [roadmap.md](roadmap.md) | You want to know what's being worked on, what's next in priority order, collected ideas and what's done |
| [known-issues.md](known-issues.md) | You want the known problems and limitations |
| [platform-testing.md](platform-testing.md) | You're changing what depends on the machine (installers, runtime installs, the vault, paths) and need to try it on a clean Linux or Windows |
| [releasing.md](releasing.md) | You're a maintainer cutting a release |

Keep these documents true: when a change makes one of them wrong, update it in the same pull
request.
