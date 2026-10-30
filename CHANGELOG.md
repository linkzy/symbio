# Changelog

Notable changes to Symbio. The format follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Long chats load in pages: the latest messages first, earlier ones when scrolling up.
- The loop guard only counts conversation (not task or asset traffic), is configurable per project
  (Settings → Team) and tells the human when it blocks.
- Usage per agent and model, including cache reads, earlier sessions and stopped agents, with an
  estimated cost from editable model prices (Settings → Model prices).
- Rename helpers; the old name keeps working.
- Free shared assets are granted automatically; core only decides on contention.
- Fresh sessions for long-running agents (button, or automatically after each merged task), with
  a handoff note; earlier sessions stay readable.
- Leftover helper folders of removed projects are cleaned up at startup.
- After an update, each project's coordinator is told what changed for the agents (a note, it
  isn't woken up); the human sees the same list in Messages.

## [0.1.0]

First version.

- Projects from any folder: inspection, git setup, onboarding of existing folders, project docs in
  the project or private.
- core (lead agent) that scopes, plans, delegates, reviews and merges; helpers in their own git
  worktrees; stop and restart helpers.
- Messages between agents that wake the recipient; shared assets with core as gatekeeper.
- Plan approval and an animated kanban; *Needs you* inbox for questions, approvals and
  permission requests; pause and resume.
- GitHub and SSH connections with an encrypted vault and optional per-action approval.
- Model providers managed from Settings; allowed models per project; per-agent model switching;
  automatic model fallback.
- Supervisor, watchdog, memory recycling and tool re-registration for reliability.
- Safety rules for agents: no killing processes by name, no reading SSH keys or secrets, installs
  need approval.
- Security: a UI key on every API request, protection against cross-site requests and DNS
  rebinding, OpenCode's password kept out of agent shells, hardened GitHub push/pull, SSH host key
  pinning, approvals stored outside the project, symlink-safe paths, debug routes off by default.
