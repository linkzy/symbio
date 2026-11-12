# Changelog

Notable changes to Symbio. The format follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Review guides: helpers report each finished task with a guide for checking it (where to look, the
  steps, what you should see, and whether they ran it). New setting, Settings → Team → **Who reviews
  the work**: *core* (as before) or *me, every task*: then finished tasks wait in a **To review** list
  (Needs you and the Plan tab) until you approve them or send them back with a note, which goes to
  the helper that did the work.
## [0.10.0]

- Fixed: on Windows, saving Symbio's state could fail when another program (antivirus, search
  indexer) briefly held the file; saves now wait for it.
- Chat modes in core's chat box: **Auto** (as before), **Plan** (discuss and plan only: Symbio blocks
  creating helpers, assigning tasks, merging, pushing and editing files until you switch) and **Act**
  (get it done without a plan to approve). Messages show the mode they were sent in.
- Helpers that go quiet: a helper that ends its turn without reporting on the work core gave it is
  reminded once, and if it stays quiet core is told, instead of the work stalling unseen (seen with
  smaller models).
- `sym update --to <version>` installs a given version, e.g. to go back after a release that broke
  something. Automatic updates then skip the version you left and resume with the next release.
- Releases are only published when the unit tests, the OpenCode contract test and the new end-to-end
  tests (the whole app in a browser) all pass.
- *New project…* in the project switcher at the top opens the New project dialog.

## [0.9.0]

- Switch projects from the project name at the top (a list of your projects, and all projects).
- Questions an agent asks (multiple choice) can be answered right in *Needs you*, not only in its chat.
- No more focus ring inside the chat box; the box itself shows it has focus, subtly.
- Fixed: after removing a project (or opening a link to one that's gone), the page said "project
  not found"; it now goes back to the project list.
- Usable on phones (e.g. through remote access): one column, the team in a drawer opened from the
  button before the tabs, tabs that scroll sideways, the top bar and chat buttons as icons, dialogs
  that slide up from the bottom, and Enter for a new line on touch keyboards (the button sends).
- A new version available shows in the top bar as a green badge with its number, easier to notice.
- What you type in a chat is kept until you send it, with the files attached to it: switching tabs,
  opening another project or reloading the page no longer empties the message box.
- Automatic updates check for a new version every hour instead of every 6 hours, so a release no
  longer waits most of a day to arrive.
- The top bar shows Symbio's version next to its name.
- Leaving Settings: the button says where it goes ("Back to <project>"), clicking Settings again or
  pressing Escape also goes back, and the project opens on the same tab and agent you left.

## [0.8.0]

- Fixed: a multiple-choice question from an agent disappeared from its chat when another
  agent's message arrived while it waited (only *Needs you* remained), and ten minutes later the
  watchdog interrupted it as if it were hung. The agent now stays *waiting* until you answer, and
  the messages wait their turn.
- Attach files to a message: the paperclip, drag and drop onto the chat, or paste a screenshot.
  Agents get each file's path with how to open it; the sent message shows the files. Each project
  has a **Files** tab with everything sent (preview, open, download, resend to an agent, delete).
- `read_document`: agents read PDFs (by pages), Word, Excel, PowerPoint and OpenDocument text a part
  at a time. Reading PDFs with the read tool is refused like images, since it put the whole file in
  the conversation.
- Folders of several git repositories (e.g. `client/` and `server/` with their own remotes): the
  New project dialog shows them and no longer offers to create a repository on top, which hid
  their files from helpers. Each helper works in a copy of one of them (`repo` on `spawn_agent`),
  merges go back to that repository, `git_push` / `git_pull` take `repo`, and the daily check looks
  for unpushed work in each.
- Projects added with an earlier version over a folder of repositories (Symbio created one on top
  of them): after the update, core checks the project and switches it to the inner repositories on
  its own when the outer one is Symbio's and has no remote, or asks you otherwise. Nothing on disk
  changes, and Settings → Team switches back.

## [0.7.1]

- On a Node.js older than 22, `sym` says what to install instead of Symbio crashing at start
  (npm installs it anyway and only warns).
- Automatic updates and `sym update` don't install a version that needs a newer Node.js than the
  machine has.
- The image library loads when an agent first views an image, so a problem with it affects only
  `view_image`, not Symbio's start.

## [0.7.0]

- Updates: `sym update` installs the latest version and restarts Symbio once the team is idle
  (`--now` doesn't wait). Symbio also checks for new versions and, by default, updates itself while
  no agent is working and remote access is off: it backs up first, keeps (or restores) the old
  version if the install fails and doesn't retry it for a day, and tells you in Messages. Settings →
  Updates: automatic, tell me, or off, and what's new; a badge in the top bar when a version is
  available.
- Docs brought up to date; the roadmap is now a priority list with collected ideas; `sym doctor`
  prints Symbio's version.

## [0.6.0]

- Azure DevOps connections: add an organization with a personal access token in Settings; agents
  push and pull through it (HTTPS remotes of that organization) and call its REST API with the new
  `azure_devops_api` tool, e.g. to open pull requests. The token never reaches the agent and only
  goes to the connection's own organization.
- Credentials rule clarified: Symbio's own secrets stay off-limits to agents, but a project's own
  credentials (connection strings, `.env`…) and ones the human gives may be used for the task;
  agents must not copy them into anything committed or shared, and only read from systems the
  human calls read-only or production. Agents had refused legitimate work (querying a database
  with the app's connection string) under the old blanket rule.

## [0.5.0]

- Docs tab: a folder tree instead of a flat list; search across all docs (any case or accent) that
  opens the doc at the matching line; links and paths in backticks that point to another doc open
  it, with Back; an "On this page" outline for long docs; .txt sources shown with line numbers.
- Rules register (optional, per project; on by default for new projects): agents record rules with
  their sources, literal excerpts, who imposes them, confirmation and status through new tools, and
  the Docs tab shows them as a filterable index grouped by area and stage. A citation opens its
  source: a text doc at the cited line, a PDF in a new tab at the cited page.
- Links in docs to PDFs and images open them in a new tab.
- `view_image`: agents look at images through a scaled-down copy (or a full-resolution crop);
  reading image files directly is refused with a message pointing to it, so images can't bloat a
  conversation.
- An agent whose conversation becomes too large to send ("Timed out reading request body", often
  after reading full-size images) continues in a fresh session with a handoff note, instead of
  Symbio trying every other model.
- A helper's folder that was deleted outside Symbio is recreated from its branch (committed work
  kept), and the human and the helper are told.
- A project reopened from its folder takes the rules register choice made in the New project dialog.

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
