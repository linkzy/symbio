# Changelog

Notable changes to Symbio. The format follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- **Use an OpenCode already on your computer.** Settings → Agent runtimes has an opt-in to run the
  `opencode` found on PATH instead of Symbio's tested copy. It's off by default, the PATH version can
  differ from the tested one, and Copilot is unaffected.

## [0.22.0]

- **Small computers stay usable.** The agents' runtime runs at below-normal priority, and everything agents start
  inherits it (builds, Blender, browsers…): they use whatever CPU is free, but the system, remote desktop tools and
  you come first, even at 100% CPU.
- **The machine view.** A CPU indicator in the top bar opens the computer's load and the programs agents started,
  heaviest first, each with **Stop** (by process id, only agents' programs), from a phone too. Programs that detach
  from the command that started them (browsers) are still recognized. core gets the same: `list_programs` and
  `stop_program`.
- **Load guard.** When the computer stays overloaded (CPU around 90% or more for 3 minutes, or memory nearly full),
  you and core are told, with the heaviest programs; the indicator turns red. Optionally (in the machine view),
  messages between agents wait until it recovers, so tokens aren't spent while it struggles.
- Agents' briefs say how big the computer is; on a small one, heavy jobs run one at a time across the team.

## [0.21.0]

- **Reasoning effort.** Models that can think less or more (low, medium, high…, as each lists them) get a level per
  model in Project settings → **Reasoning effort**, and agents can have their own from the menu next to the model in
  their chat. core can give helpers a level too (`spawn_agent effort`, `set_effort`), but not change one you set.
  The level survives fresh sessions, model fallback and moving the project to another runtime; a model that doesn't
  take it runs at its default. Works on both runtimes (OpenCode's model *variants*; Copilot's `reasoningEffort`,
  including your own providers' models).
- **No AI co-author lines in commits.** Agents are told not to add `Co-authored-by` lines naming an AI, and GitHub
  Copilot CLI's own line is turned off. To allow them, Project settings → Team → **AI co-authors in commits**.

## [0.20.0]

- **Workbench, more like an editor.** The plan, messages, docs, files and settings are icons in the activity bar
  and open as tabs in the middle; every tab closes (×), like a file's, and several files can be open at once. The
  side bar and the chat are resized by dragging their border (or with the arrow keys when it has focus;
  double-click puts it back), and the widths are kept in the browser.

## [0.19.0]

- **Import a VS Code color theme.** Settings → Appearance → **Import a VS Code theme…** takes a color theme's `.json`
  file (from a theme extension's `themes` folder, or what VS Code's *Developer: Generate Color Theme From Current
  Settings* writes) and maps its workbench colors onto Symbio's; what it doesn't set comes from Dark Modern or Light
  Modern. Imported themes are kept in this browser and can be removed from their card.

## [0.18.0]

- **Workbench layout.** Settings → Appearance now has a layout too: **Classic** (as before) or **Workbench**, laid out
  like an editor: an activity bar with the team and the Explorer in a side bar, the plan, messages, docs, files,
  settings or a file from the Explorer in the middle (as tabs), the chat always on the right with a switcher for who
  you're talking to, and a status bar (runtime, who's working, plan progress, *Needs you*). **Developer look** sets
  Dark Modern with the Workbench in one click. Windows narrower than 1100 pixels, and phones, keep the classic layout.

## [0.17.0]

- **Explorer tab.** Next to Plan, the project's folders and files as a tree (or a helper's own copy, where its branch's
  work is before it's merged). Folders open on a click, Markdown and text show beside the tree, images preview, other
  files open or download. Read-only, and under the same rules as files in the chat: no `.git`, none of Symbio's own
  files, nothing that looks like a secret.

## [0.16.0]

- **Themes.** Settings → **Appearance** has a choice of looks, kept in this browser: **Symbio** (the default, as
  before), **Dark Modern** and **Light Modern** (the colors of VS Code's default dark and light themes, with squarer
  corners and the system font). Every color in the UI now comes from a theme's tokens, so adding a theme is a set of
  token values in `web/src/themes.css`. Coming next: an Explorer tab, a VS Code-like *Workbench* layout and importing
  a VS Code color theme.

## [0.15.1]

- **Pin an agent to its model.** The pin next to the model in an agent's chat keeps it on that model: when the model
  fails, the agent waits and tries it again (after 15 seconds, then longer, up to every 10 minutes) instead of being
  switched to another allowed model. A notice in its chat counts down to the next try, with **Retry now** and
  **Unpin**; the team list marks pinned agents. core can pin too (asking for a model "to see how it does" now carries
  through: `spawn_agent` takes `pin_model`), but can't undo your pins. A model that can't be used at all (removed, key
  refused) is reported at once instead of retried, and you're told if a pinned model is still failing after an hour.
  Switching is still the default.

## [0.15.0]

- **GitHub Copilot CLI as an agent runtime** (preview): in New project → Models, choose whether the agents run on
  OpenCode or on GitHub Copilot CLI, with its own models and your Copilot subscription. Symbio uses your existing
  Copilot login (`copilot login`), or you sign in from Settings → **Agent runtimes** with a code on GitHub; it keeps its
  sessions apart from your own Copilot history. Symbio's rules still apply to every command an agent runs and every
  file it reads or writes; background processes, model prices and the chat's steps work as with OpenCode. Models you
  added to the Copilot CLI with your own key (e.g. Azure AI Foundry, in Copilot's `providers.json`) are offered too.
- **Symbio no longer comes with OpenCode: you install the agent runtimes you use.** On the first run, the Projects page
  asks for one and offers OpenCode and GitHub Copilot CLI, each with an Install button (also in Settings → **Agent
  runtimes**, where you can remove them). Symbio downloads the version it's tested with into its own folder; nothing
  else on the computer changes. New projects offer only the installed runtimes. **If you have OpenCode projects,
  Symbio installs OpenCode again by itself on the first start after this update** (a few minutes). `sym doctor` lists
  the installed runtimes.
- **Move a project to another agent runtime**: Project settings → **Agent runtime** → *Switch runtime…* moves the whole
  team, e.g. from OpenCode to GitHub Copilot CLI. Each agent first writes its own handoff (optional), then continues in a
  new session on the other runtime with its name, folder, branch, tasks and assets; the project's models are carried
  over where the other runtime has them. A progress bar shows how it goes; if a session can't be created there, nothing
  changes. Earlier conversations stay readable. Best done when the team is idle; agents will behave differently there.
- **OpenCode and Copilot start only when needed**: when a project's agents run on them, or when something asks for them
  (a project's page, New project's models, Settings). Using only Copilot no longer keeps OpenCode running. The top bar
  shows the runtime of the project you're looking at, and elsewhere the ones running.
- A project's usage can be grouped **by agent, provider or model**, and narrowed to one provider, with the total for what
  is shown. Thanks [@P1LOTRX](https://github.com/P1LOTRX) (#15)!
- **Report a problem**: a link in the top bar and in Settings opens a new GitHub bug report with Symbio's version, the
  agent runtimes installed and your OS filled in. Nothing about your projects (names, paths, logs, keys) is added.
  Thanks [@P1LOTRX](https://github.com/P1LOTRX) (#22)!
- **Give feedback**: Settings → Feedback links to the repository's Discussions (Ideas for suggestions, Q&A for
  questions), so you can share what you think without filing a bug. Thanks [@P1LOTRX](https://github.com/P1LOTRX) (#21)!
- Fixed: **agent runtimes were restarted for memory their agents' commands used.** Builds, dev servers and compiler
  servers agents start were counted as the runtime's memory, so on a busy project it was restarted again and again
  (four times in five minutes on a real one), interrupting every agent and stopping those commands. Only the runtime's
  own memory counts now. This is likely much of why OpenCode restarted so often on long projects.
- Fixed: **a tool call could fail with "ENOENT … rename …"** when an agent called several of Symbio's tools at once
  (shared assets, questions, the plan): two saves of the same file used the same temporary file. Saves of a file now
  run one after the other, each with its own.

(Pre-releases 0.15.0-beta.1 to beta.3 had these changes as they were made.)

## [0.14.3]

- **Costs and token counts are hidden by default**, so people passing by don't see what projects spend: the line under the
  team is gone, and the project's usage shows `•••`. Turn them on in Settings → **Costs and tokens** (kept in this browser).
  While hidden, the price simulator doesn't fill in your real usage.
- Fixed: the daily check measured helpers' build outputs far too low (87 GB counted as under 4 GB on a real project), so it
  never warned that their folders were filling the disk, and "freed" amounts after cleaning were understated.

## [0.14.2]

(0.14.1 was never published: its release stopped on a test. Same content.)

- **Your own helpers**: the **+** next to the team's count creates a helper you talk to directly, in its own chat (a
  name, what it's for, a model and where it works), like opening a new chat. It's a full team member; core is told
  and leaves it to you. *Stop agent* in its chat moves it to the stopped ones.
- **Simulate core and helpers separately** in Settings → Model prices: a model for core and one for helpers (*Same as
  core* copies it), each with its own share of your tokens, and what each costs and the total per day, week and month.

## [0.14.0]

- **Models for core and for helpers**: in a project's models, the crown now marks every model core may use (click it on
  several), and a new lock keeps a model for core only. E.g. Kimi and GLM for core, GLM and DeepSeek for helpers; or
  everything for everyone, as before (the default). Fallback, new helpers and the model menu in each chat follow it.
- **Select all** and **None** in the model picker.
- **Working agents first**: in the team list, agents that need attention, are working or waiting move up under core, so
  a long team shows at a glance who's still busy.
- **New folder** in the in-page folder browser (New project over remote access).
- **Files with answers and send-backs**: attach files (screenshots, a document) when answering an open question or
  sending a task back; they reach the agent like files sent in the chat.
- **Simulate** in Settings → Model prices: type a model's prices and see what it would cost per day, week and month at
  your average usage (or amounts you type).

## [0.13.0]

- **A chat you can follow**: the team's work reads in plain words instead of the commands and
  scripts the model typed ("Message to setor", "Merged modulo-professor's work", "Waited for the app
  on port 7343", "Ran the tests"), and a run of steps folds into one line that leads with what
  mattered ("Message to setor · Checked git status and 1 more · 3 steps"); the raw command and its
  output stay a click away. Helpers' reports show as cards, with the task and its title on top and a
  long summary folded; the instructions Symbio adds for core are left out.
- **Files from the team, in the chat**: agents share files with you (`share_file`), and they show in
  the chat (images, video and audio play in place, PDFs and documents open in a new tab, anything else
  has a Download button) and in the Files tab, under *From the team*. Paths of project files in the
  chat, *Needs you*, the Plan and Messages tabs become links: Markdown and code open on their own page,
  formatted and at the line mentioned ("docs/regras/checagem-ia.md, linha 6"); a file still on a
  helper's branch opens from the helper's copy. Downloads work over remote access too.

## [0.12.0]

- **Open questions**: the team's questions for you now wait in a list in *Needs you* instead of
  scrolling away in the chat. Each is numbered (Q1, Q2…), with its context, suggested answers and
  whether work is blocked on it. Answer several and send them together; each agent gets its own
  answers. A question that's already open isn't asked again, and you can set one aside. Answered
  questions stay listed with their answers.
- core keeps its replies to helpers' reports short, and no longer re-lists what's pending in the
  chat.

## [0.11.0]

- Review guides: helpers report each finished task with a guide for checking it (where to look, the
  steps, what you should see, and whether they ran it). New setting, Settings → Team → **Who reviews
  the work**: *core* (as before) or *me, every task*: then finished tasks wait in a **To review** list
  (Needs you and the Plan tab) until you approve them or send them back with a note, which goes to
  the helper that did the work. Or *me, the tasks marked in the plan*: core marks the tasks you'll
  review when it proposes the plan (e.g. a few checkpoints in a pipeline), and you tick or untick
  them in the Plan tab.
- **Show changes** on a task in review or done (Plan tab and Needs you): the files it changed, with
  their diffs a click away (projects in a git repository).
- **FTP connections** (FTP and FTPS) in Settings → Connections, for hostings that only offer FTP:
  agents publish to them with `remote_upload` (replacing files that are there) and can list, create,
  move and delete files and folders; changes need your OK when the connection is set to *Ask me*. Server connections whose hosting allows SFTP but no
  commands now test as "SFTP only" instead of failing.
- Agents run the project's own deploy or publish scripts directly instead of asking for a
  connection; when you ask for the deploy, that's the go-ahead.

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
