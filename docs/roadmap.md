# Roadmap

What we're working on, what comes next and ideas we've collected, in priority order rather than
by date: priorities change as people use Symbio, and items move up or down. Suggestions are
welcome (open an issue). Each item in Next has an issue with where to start; those labelled
[good first issue](https://github.com/linkzy/symbio/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small and self-contained.

## Now

**Core as lead** ([milestone](https://github.com/linkzy/symbio/milestone/5)). core is the strategic
layer: it plans, keeps the project's language, standards and decisions straight, and gates quality.
Helpers are tactical: one task, done well, checked. What the team knows lives in documents, so it
carries over between sessions and runtimes.

0. ✅ **Housekeeping first** (done), on Symbio itself: its own glossary ([#43](https://github.com/linkzy/symbio/issues/43)),
   `team.ts` split along the parts that change ([#44](https://github.com/linkzy/symbio/issues/44)), steadier and
   faster end-to-end tests ([#45](https://github.com/linkzy/symbio/issues/45)), and what in the agents' briefs
   contradicts the plan ([#46](https://github.com/linkzy/symbio/issues/46)).
1. ✅ **Foundation** (done in 0.27.0). A project glossary core keeps ([#47](https://github.com/linkzy/symbio/issues/47)); the rules
   register on by default ([#48](https://github.com/linkzy/symbio/issues/48)); a fresh session with the agent's own
   handoff, and its conversation size shown ([#49](https://github.com/linkzy/symbio/issues/49)); a fresh session
   after each task by default ([#50](https://github.com/linkzy/symbio/issues/50)); *Done when* on every task
   ([#51](https://github.com/linkzy/symbio/issues/51)).
2. ✅ **Skills** (done in 0.28.0). A skill library, and skills per agent: core's chosen by the human, helpers' by core
   ([#52](https://github.com/linkzy/symbio/issues/52)).
3. ✅ **Quality gate** (done in 0.29.0). Project checks Symbio runs itself ([#53](https://github.com/linkzy/symbio/issues/53)), then a
   separate reviewer against *Done when*, the rules and the glossary ([#54](https://github.com/linkzy/symbio/issues/54)).
4. ✅ **Briefings** (done in 0.30.0). The questions about one feature, asked together, becoming its spec
   ([#55](https://github.com/linkzy/symbio/issues/55)).
5. ✅ **Evidence** (done in 0.31.0). Files tagged by kind and task, easy to find ([#56](https://github.com/linkzy/symbio/issues/56)).
6. ✅ **Autopilot and skills** (done in 0.32.0). core decides on its own when the project lets it (decisions the
   human keeps or changes, what the team may do without asking), briefing or grilling, and a skill library by
   category with popular third-party skills core gives helpers by itself.

Later: how risky a change is to merge (can it be undone, how much it affects) deciding how closely
it's reviewed; a retro that turns review comments into rules and checks.

## Next

The issues are also grouped into [milestones](https://github.com/linkzy/symbio/milestones):
*Core as lead* (above), *Smarter teams*, *Never miss a thing*, *Everyday comfort* and *Show it to the world*.

In this order: first what lets a team run unattended (done: being told when it needs
you, spending limits and scheduled work), then the pieces that open up small issues for anyone (done: settings in
groups and the whole interface translatable, with a language per issue), then reaching more people (Linux and macOS, other runtimes, a clear
first run), then features.

1. **Linux and macOS.** ([#9](https://github.com/linkzy/symbio/issues/9)) Test on both. The secret vault uses the OS keyring (Secret Service on Linux,
   Keychain on macOS); headless Linux (a server or container) has no keyring, so it needs a
   fallback, such as a key file readable only by the user.
2. **Runtimes already on the computer, for every runtime.** ([#59](https://github.com/linkzy/symbio/issues/59)) What
   #36 did for OpenCode (use the one on the PATH instead of Symbio's copy), for GitHub Copilot CLI and the runtimes
   that come later.
3. **A clear first run.** ([#58](https://github.com/linkzy/symbio/issues/58)) With no agent runtime yet, Symbio says
   what one is and lets the human install one for Symbio (a separate copy that doesn't touch anything already on the
   computer) or use the one they already have.
4. **Task priorities.** ([#4](https://github.com/linkzy/symbio/issues/4)) A priority on each task in the plan (e.g. urgent, high, normal, low), shown
   on the Kanban cards and used to sort columns. core sets it when it plans or adds tasks and can
   change it (its plan tools take it), the human can change it on the board, and core is told when
   the human does, so it picks up urgent work first. Helpers see it with their task.
5. **Model fallback that fits the conversation.** ([#38](https://github.com/linkzy/symbio/issues/38)) Retry the same model on network errors
   before switching; prefer models whose context holds the conversation; when none does, ask the human
   (continue in a fresh session from a handoff note, go back to the original model, or pick another).
6. **Which skills were used.** ([#63](https://github.com/linkzy/symbio/issues/63)) Loading a skill shows as a step in
   the chat, and each agent's skills chip says which it used, so you can see whether skills pay off.
7. **Create a project from a git repository.** ([#11](https://github.com/linkzy/symbio/issues/11)) In the New project dialog, an option to clone a
   repository (GitHub, Azure DevOps or any git URL, using the matching connection when it's private)
   into a folder and open it as a project, e.g. to continue on another computer. Tucked under an
   advanced option, so it doesn't get in the way of people who don't use git.
8. **Rules register on import.** ([#12](https://github.com/linkzy/symbio/issues/12)) When importing an existing project, offer to build the register
   from the project and from sources the human points to (e-mails, meeting notes, manuals), marking
   rules found only in the work as unsourced.
9. **Make it showable.** ([#10](https://github.com/linkzy/symbio/issues/10)) Before inviting others: a sample project to try in five minutes, a
   two-minute video of core running a team on a non-coding project, and a short GitHub Pages site
   with screenshots ([#19](https://github.com/linkzy/symbio/issues/19)). First audience: the
   OpenCode and GitHub Copilot CLI communities. Done: the README's animation of a real session, and
   a social preview image.
10. **Talk to Symbio.** ([#6](https://github.com/linkzy/symbio/issues/6)) A spoken conversation with core, hands-free: e.g. from a phone connected to
    the car over Bluetooth, with Symbio working on the computer at home (remote access). Not just
    dictation into the chat box:
    - Only what core says to the human is read aloud: never tool calls, command output, messages
      between agents, restarts or other notices. Code, tables and long lists are summarized, with
      the details left in the chat.
    - core knows it's a voice conversation: short plain sentences, no formatting, one question at a
      time. Multiple-choice questions are read with their options and answered by voice.
    - *Needs you* by voice: questions and approvals are read out; anything risky (a push, a deploy,
      deleting things) waits for the screen or an explicit spoken confirmation.
    - Turn-taking without touching the phone: listening after core speaks, or a headset/car button.

    Builds on the phone layout and on telling apart, in core's replies, what's for the human from
    the team's work. To check first: the browsers' own speech recognition and voices (quality,
    languages, whether they keep working with the screen off) against a speech service.
11. **A public demo.** ([#14](https://github.com/linkzy/symbio/issues/14)) A container on a VPS with a light model, connections and other sensitive
    options disabled, and visitors' data reset every few minutes (needs Linux headless support).
12. **Filters for a project's skills.** ([#60](https://github.com/linkzy/symbio/issues/60)) Project settings → Skills
    gets the library's search and categories, and Select all / Clear for the skills shown.

**Small improvements**, also open to anyone, each with an issue and where to start: the browser tab showing what needs you (#24), unread markers on agents (#25), opening a
folder in VS Code (#26), day separators (#27), find in a chat (#28), keyboard shortcuts (#29),
filtering the plan board (#30), exporting a chat (#31) or usage (#32), an accessibility pass
(#33), the projects list showing what needs you in each project (#34); the Explorer keeping its
open folders when you leave it and come back (#41); for notifications, another channel (#65), quiet hours (#66)
and not pinging the phone while you're at Symbio (#67); the interface in Spanish (#68), French (#69) and
German (#70), three languages at a time (more once these are in). All [good first issues](https://github.com/linkzy/symbio/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## Ideas

Collected, not sorted or promised yet.

- **Images as before and after** in a task's changes, side by side, instead of a text diff.
- **Claude Code and Codex (other agent CLIs).** Run teams on the agent tools people already use and
  pay for, not only OpenCode, and switch between them (e.g. from the OpenCode menu at the top).
  The first question from almost everyone who has seen Symbio running: "can I use it with my Codex
  or Claude Code?"; most people won't install another agent runtime. Big: Symbio is built on
  OpenCode's HTTP API (sessions, tools, permissions, events), so each runtime needs an adapter.
  The runtime-neutral layer (`AgentRuntime`) came with GitHub Copilot CLI support (0.15.0), so the
  work is an adapter per runtime, and #59 (using an install already on the computer).
- **A generic connection** *(when a specific type isn't enough)*. Named secret values that Symbio
  hands to a command it runs as environment variables (e.g. `FTP_PASSWORD` for a project's deploy
  script, or any CLI), with the output scrubbed and *Ask me* by default. Weaker than the other
  types: the command could print or save the value, so only the approval protects it. Today the
  project's own scripts are run directly, and FTP has its own type.
- **Beta updates and feedback, opt-in** *(when people beyond the current users show up)*. In
  Settings → Updates, next to *Check now*, a choice to get beta versions: those who opt in get each
  release first (npm `next`, or the installer's beta channel), everyone else a few days later if
  nothing broke, like Claude Code's *latest* and *stable* channels. For beta users, a **Report a
  problem / Send feedback** button: a form with what they write plus Symbio's version and the
  operating system, nothing about their projects, shown to them before it's sent; it becomes a
  GitHub issue, or goes to a small form service for people without a GitHub account. No telemetry:
  the only sign that someone uses Symbio is what they choose to send. Maybe also one anonymous
  "hello" (the version, nothing else) when someone opts in, as the one count of real users: npm
  download numbers are mostly mirrors and bots.
- **A first-run experience.** A sample project and templates, so a new user sees the team at work in
  five minutes instead of starting from an empty folder.
- **Stronger isolation.** Optionally run agents in a container or sandbox (today they run with the
  user's own permissions, with pattern-based rules), for people who can't judge what an agent may
  do on their machine.
- **Agent graph.** A live view of agents and the messages flowing between them.
- **Moving projects between machines.** Docs and plan travel with the folder, but agent sessions
  live in the runtime's local storage; reopening a project elsewhere should re-create its agents
  cleanly.
- **Eyes for agents.** Screenshots of what they build, routed to vision-capable models (agents can
  already look at images with `view_image`).
- **Per-task model routing.** Cheap models for simple tasks, strong ones for hard ones.
- **Installing without Node.js** *(important before inviting people who aren't developers)*. Today
  Symbio needs Node 22+ and `npm install -g symbio`, so it only reaches people who have both. An
  install script per system family, run with one line in a terminal (`irm …/install.ps1 | iex` in
  PowerShell, `curl -fsSL …/install | bash` elsewhere), the way OpenCode and Claude Code install:
  - It downloads a private copy of Node (the official zip from nodejs.org) into `~/.symbio/runtime`:
    nothing installed system-wide, no admin rights, invisible to other programs, removed with
    Symbio. Then it installs Symbio with that copy's npm (OpenCode comes along, as today) and adds
    the `sym` command and a desktop / Start-menu shortcut, so the terminal is needed only once.
  - It's still the npm package underneath, so automatic updates, *Check now*, `sym update --to` and
    the release gate keep working; Symbio updates the private Node too when needed.
  - No executable to build per platform and no code-signing certificate: SmartScreen warns about
    files downloaded in a browser, not what a PowerShell script downloads (to confirm on a clean
    machine), and Node's and OpenCode's binaries are signed by their makers.
  - Hosted from the GitHub repository at first; on Symbio's own domain if the project grows
    (e.g. `curl -fsSL https://<domain>/install | bash`).
  - Node, not Bun: Symbio is built and tested on Node, and SSH, the keyring module and child
    processes are where Bun's compatibility gaps show.
- **Jira and Trello connections** *(low priority)*. Connect a board, like GitHub or Azure DevOps
  today, so core can read the work from it (issues, cards, their details) and turn it into the
  local plan for helpers, then mark items done on the board as their tasks finish.

## Done

Newest first; details per version in [CHANGELOG.md](../CHANGELOG.md).

- **Next release** — Budgets per project (#7): a limit for the whole project and per day, a warning near it, the team paused at it. Scheduled work (#8): recurring jobs core runs when they're due, with their runs in the Plan tab. Settings in groups, each with its own address (#62, #35). The whole interface translatable, in Portuguese (Brazil), and in the browser's language by default (#13).
- **0.33.0** — Notifications (#5): what waits on you and what got done, grouped per project, in the browser and through Telegram, ntfy, a webhook or e-mail; each project chooses what it sends. Also the remote link and code copied and shared together, by @TariQMah (#61).
- **0.32.0** — Runs on its own or asks, per project (decisions to keep or change, plans approved as made, what the team may do without asking, briefing or grilling), and a skill library by category with popular third-party skills, credited.
- **0.31.0** — Evidence: shared files tagged by kind and task, filtered in the Files tab, listed on their task and given to reviewers. *Core as lead* phases 0–5 are done.
- **0.30.0** — Briefings: the questions about one feature asked together, grouped in Needs you, answered into the feature's spec that its tasks link to.
- **0.29.0** — The quality gate: checks Symbio runs itself on every report and before merges (core proposes, you approve), and reviewers, one-off helpers that check a task against its *Done when* without changing it, by core's request or on every task.
- **0.28.0** — Skills: Symbio's four for leading, your library in Settings (write one, or add a copy after reading it), core's chosen per project, helpers' given by core or by you; each agent has only its own, on both runtimes.
- **0.27.0** — Core as lead, step 0 and phase 1: a glossary in every project, *Done when* on every task, fresh sessions from the agent's own handoff with the conversation's size shown, rules register and fresh session after each task on for new projects; end-to-end tests about 4× faster.
- **0.26.0** — Copy buttons in the chat, by @Veeramanikandanr48 (#42).
- **0.25.0** — The machine view says which project and agent started each program; system programs no longer listed as agents' (Windows pid reuse).
- **0.24.0** — Connection requests: Approve all, allow an agent for a while, always allow plain server commands; agents group commands into one request.
- **0.23.1** — Report a problem opens the new bug form with versions filled in; a shorter README with the details in `docs/`.
- **0.23.0** — Use an OpenCode already on the PATH (opt-in) and the interface in Portuguese (Brazil), both by
  [@wesleyhjpr](https://github.com/wesleyhjpr) (#36, #37); agents can't change Symbio's own settings and runtimes.
- **0.22.0** — Small computers stay usable: agents' programs at low priority, the machine view (list and stop
  what agents started, also from a phone), and a load guard that tells you and core when the computer is
  overloaded and can hold new turns.
- **0.21.0** — Reasoning effort per model and per agent (#1); AI co-author lines left out of commits unless
  the project allows them (#20).
- **0.20.0** — Workbench: views in the activity bar, closable tabs, resizable side bar and chat.
- **0.19.0** — Import a VS Code color theme (#2, step 4 of 4).
- **0.18.0** — The Workbench layout (activity bar, side bar, the work in the middle, the chat on the right,
  a status bar) and the Developer look (Dark Modern + Workbench).
- **0.17.0** — The Explorer tab: the project's folders and files, read-only, secrets hidden.
- **0.16.0** — Themes: Symbio (the default), Dark Modern and Light Modern, in Settings → Appearance.
- **0.15.1** — Pin an agent to its model: it waits and retries that model when it fails, instead of switching
  (the pin in its chat; core's `pin_model`).
- **0.15.0** — GitHub Copilot CLI as a second agent runtime, chosen per project; no bundled runtime
  (install the ones you use from Symbio); moving a project from one runtime to the other; runtimes
  start only when needed; every end-to-end test runs on both runtimes. Also usage by provider and
  model (#3, the first outside contribution), Report a problem (#16) and Give feedback (#17), all by
  [@P1LOTRX](https://github.com/P1LOTRX); runtimes no longer restarted for their agents' builds.
- **0.14.3** — Costs and token counts hidden by default; the daily disk check measures helpers' build outputs
  correctly.
- **0.14.2** — Your own helpers (create one from the team list and talk to it directly); the price simulator
  for core and helpers separately.
- **0.14** — Models for core and for helpers (crowns and core-only locks), select all / none; working agents
  first in the team list; new folders over remote access; files with answers and send-backs; a price
  simulator in Settings.
- **0.13** — A chat you can follow: the team's steps in plain words, runs of steps folded into one
  line, helpers' reports as cards; files from the team in the chat (`share_file`, shown in place or
  to download) and in the Files tab; paths as links everywhere, Markdown and code opening at the
  line mentioned.
- **0.12** — Open questions: the team's questions for the human wait in a list in *Needs you*
  (numbered, with context and suggested answers), answered several at once; repeats refused;
  core keeps its replies to helpers' reports short.
- **0.11** — Reviewing the team's work: helpers' guides for checking a task, *Who reviews the work*
  (core, me for every task, or me for the tasks marked in the plan), a To review list with approve
  and send back, and each task's changed files and diffs; FTP and FTPS connections (uploads and file
  operations), SFTP-only servers; agents run the project's own deploy scripts instead of asking for
  a connection.
- **0.10** — Chat modes (Auto, Plan, Act) with Plan enforced by Symbio; helpers that go quiet are
  reminded, then core is told; `sym update --to` to go back after a bad release; releases gated on
  unit, OpenCode contract and end-to-end tests; `team.ts` split into modules; *New project…* in the
  project switcher.
- **0.9** — Usable on phones (one column, the team in a drawer, scrolling tabs, bottom-sheet
  dialogs); switching projects from the name at the top; answering questions in *Needs you*;
  drafts kept until sent; Symbio's version in the top bar and a green badge for a new one; hourly
  update checks; clearer ways out of Settings.
- **0.8** — Attachments in the chat (upload, drag in or paste), with a Files tab per project, and
  `read_document` for PDF, Word, Excel and PowerPoint; folders of several git repositories, each
  kept as it is, with helpers' copies, merges and pushes per repository; questions no longer
  vanish when messages arrive while they wait for an answer.
- **0.7** — Updates: `sym update`, and automatic updates while the team is idle (backup first,
  the old version kept if the install fails), with a setting and what's new in Settings → Updates.
- **0.6** — Azure DevOps connections (push, pull, pull requests); a clearer credentials rule:
  Symbio's own secrets stay off-limits, a project's own credentials may be used but never spread.
- **0.5** — The Docs tab (folder tree, search, links between docs, numbered text sources); an
  optional rules register with sources, excerpts and status, whose citations open the cited place;
  images only through scaled-down copies (`view_image`); a conversation too large to send continues
  in a fresh session; helpers' deleted folders are recreated.
- **0.4** — Helpers can share the project folder instead of their own branch (for step-by-step
  work); processes belong to the agent that started them.
- **0.3** — Remote access: `sym remote` opens a temporary Cloudflare link with an access code.
- **0.2** — `npm install -g symbio` with a bundled OpenCode; `sym` start, stop, status, logs,
  doctor; fresh sessions with a handoff note, daily backups and housekeeping checks, token and cost
  tracking.
- **0.1** — The core: OpenCode runtime with crash recovery and memory recycling; onboarding of new
  and existing folders; the team (core and helpers, messages, git worktrees, shared assets with core
  as gatekeeper, model fallback); the plan and its live kanban; the *Needs you* inbox; GitHub and
  SSH connections with an encrypted vault and approvals; model providers from Settings.

## Known issues and limitations

In [known-issues.md](known-issues.md).
