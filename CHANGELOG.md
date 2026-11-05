# Changelog

Notable changes to Symbio. The format follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- An agent whose conversation becomes too large to send ("Timed out reading request body", often
  after reading full-size images) continues in a fresh session with a handoff note, instead of
  Symbio trying every other model.
- `view_image`: agents look at images through a scaled-down copy (or a full-resolution crop);
  reading image files directly is refused with a message pointing to it, so images can't bloat a
  conversation.
- A helper's folder that was deleted outside Symbio is recreated from its branch (committed work
  kept), and the human and the helper are told.

- Rules register (optional, per project; on by default for new projects): agents record rules with
  their sources, literal excerpts, who imposes them, confirmation and status through new tools, and
  the Docs tab shows them as a filterable index grouped by area and stage. A citation opens its
  source: a text doc at the cited line, a PDF in a new tab at the cited page.
- Links in docs to PDFs and images open them in a new tab.

- Docs tab: a folder tree instead of a flat list; search across all docs (any case or accent) that
  opens the doc at the matching line; links and paths in backticks that point to another doc open
  it, with Back; an "On this page" outline for long docs; .txt sources shown with line numbers.

## [0.4.0]

- Helpers can work in the project folder itself instead of their own copy on a branch: what one
  writes, the next sees at once, with nothing to merge (for pipelines and step-by-step work).
  Settings → Team sets the default for new helpers; core can choose per helper; existing helpers
  can be moved into the project folder from their chat (or by core) once their work is merged.
- Background processes belong to the agent that started them: in a shared folder, agents only
  see and stop their own, and stopping a helper stops only its processes.
- Agents are told that OpenCode's "tool catalog changed" notices don't list Symbio's tools, so they
  keep using them instead of reporting them missing.
- update_task accepts summary as well as note, so review notes aren't lost.
- Symbio no longer crashes when OpenCode is restarted (to free memory) while it was reading usage;
  errors in background work are logged instead of stopping the app.
- Long chats: asking for a 200-message page no longer fails.

## [0.3.0]

- Remote access: `sym remote` (or Settings → Remote access) opens a temporary Cloudflare link with an
  8-character access code; remote sessions need the code, 10 wrong codes shut it down, the agents'
  tools and shutdown are never reachable through it, and a banner with a Turn off button shows it's on.
- Live updates work through proxies that hold event streams back (such as Cloudflare quick tunnels):
  the page falls back to polling when the stream stays silent.
- Through remote access, Browse opens a folder browser inside the page instead of the native dialog.

## [0.2.1]

- Releases are published from GitHub Actions with npm trusted publishing (no tokens), with
  provenance.

## [0.2.0]

- Installable with `npm install -g symbio`; brings its own OpenCode (pinned to 2.1.x).
- Commands: `sym` (start in the background and open), `sym stop`, `sym status`, `sym open`,
  `sym logs`, `sym doctor`, `sym run`.
- The projects page points to Settings → Model providers when no provider is connected.

- Costs include sub-agents (OpenCode's own subagents such as "explore"), under their own model.
- Daily housekeeping: backups of Symbio's state (last 7 days), a check for work that exists only on
  this machine and for helpers' build outputs; the human and core are told, core can push and clean
  with the new `clean_build_outputs` tool, and Project settings → Storage & backups shows it all.

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
