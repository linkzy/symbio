# Changelog

Notable changes to Symbio. The format follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- **OpenCode 2.4 lists its models.** Newer OpenCode loads its model list a few seconds after it starts; Symbio asked
  at once and got none (for people using OpenCode from their computer, or once Symbio moves to 2.4). It now waits for the
  list, briefly, after a start.

- **Saved passwords and tokens survive a restart on a Linux without a desktop** (#9). A server or WSL has no keyring
  service, only the kernel's keyring, which forgets everything when the login ends: secrets saved there were lost, and
  Settings → Notifications didn't load. There the key now goes in `~/.symbio/secrets.key`, readable only by you (a key
  still in the kernel's keyring from this login is moved there). `SYMBIO_VAULT=file` asks for the file anywhere.
- **Settings → About says where the key to your saved passwords and tokens is kept** (Credential Manager, the Keychain,
  the desktop's keyring, or that file). When saved secrets can't be read, Notifications and Connections still load and
  say why.

## [0.38.0]

- **Symbio starts on a new Windows.** The module Symbio reaches Windows' Credential Manager with needs the Microsoft
  Visual C++ runtime, which a new Windows may not have; Symbio then stopped at once on start. It now starts anyway and,
  when a password or token is saved, says to install the runtime; the Windows installer installs it when it's missing
  (Windows asks for permission). Found by the new clean-Windows test.
- **The Windows installer doesn't stop on an npm notice.** A note from npm that a newer npm exists could end the install
  when its output was captured; npm's exit code is what counts now.
- **The Linux and macOS installer says what Node.js is missing.** On a minimal Linux (a fresh WSL Ubuntu, a slim
  server) Node.js needs `libatomic1`, which isn't there: the installer now checks that Node.js runs before going on, and
  says what to install (`sudo apt install libatomic1`) instead of failing inside npm.
- **`sym` works in new terminals on a Mac, and with a `~/.bash_profile`.** zsh, the Mac's shell, doesn't read
  `~/.profile`, and a new Mac has no zsh files yet: the installer now adds `sym` to `~/.zprofile` on macOS (and for zsh
  users on Linux), and to an existing `~/.bash_profile`, which bash reads instead of `~/.profile`. A profile it can't
  write is skipped with a warning instead of stopping the install.
- **The Windows installer leaves another Symbio alone.** With `SYMBIO_HOME` set (a second copy), it no longer updates and
  stops the Symbio installed with npm, and uninstalling removes only its own shortcuts.
- **Tested on clean machines.** Platform smoke tests install Symbio like a new user on a fresh Windows (Windows
  Sandbox), a fresh headless Linux (WSL) and CI's Windows, Ubuntu and macOS, and check the PATH, the vault, the runtime
  installs, updating and uninstalling ([docs/platform-testing.md](docs/platform-testing.md)). The installers are served
  by the website: `irm https://symbio.linkzy.dev/install.ps1 | iex` and `curl -fsSL https://symbio.linkzy.dev/install | sh`.

## [0.37.0]

- **Notifications you choose, and can read** (#73). Settings → Notifications lists the kinds, each on or off. On by
  default: what needs you (questions and briefings, approvals, a plan or work to review, an agent that can't continue,
  the budget pausing the team, a scheduled job to approve or that failed) and what got finished (a **feature done**, new:
  every task of its spec; every task done; the team stopping). Off by default: each task done, core's own decisions, core
  starting a plan, budget warnings, routine scheduled-job runs. Shared files no longer notify at all. Messages are short
  and plain: links as their words, files by name instead of paths, long text cut at a sentence.

- **Settings → About**, the last tab: what Symbio is (version, license, links), what leaves your computer and where it
  goes, and the usage statistics the update checks carry (the version and this copy's random id; the website notes the
  time and the country, not the address), with this copy's id and the switch to turn them off. The switch moved there
  from Updates, which now links to it.

- **A first run that explains itself** (#58). With no project yet, the Projects page walks through what Symbio needs, in
  order: what agents run on (an agent runtime, said in one line), installed for Symbio, which says plainly that it's a
  separate copy in Symbio's folder that doesn't touch one already on the computer, or the one already on the computer;
  then the models (a provider for OpenCode, the GitHub sign-in for Copilot, checked right away); then git, optional,
  installable from there on Windows; then **New project**.
- **A runtime already on the computer, per runtime** (#59). Each runtime's card says when one is on the computer, with
  its version and the one Symbio is tested with. OpenCode's can be used instead of Symbio's copy (as before, now also
  from the first run). A GitHub Copilot CLI is mentioned but can't be used: Symbio's Copilot SDK only talks to the
  runtime version it was built with (checked live: the installed CLI speaks a newer protocol); the sign-in is shared
  either way. The setting is now stored per runtime; the earlier one still counts.

- `sym update` checks with this copy's install id, like the running Symbio does; without it, it counted as an older copy.

- **Install with one line, without Node.js** (#71): `irm https://symbio.linkzy.dev/install.ps1 | iex` on Windows, and
  `curl -fsSL https://symbio.linkzy.dev/install | sh` on macOS and Linux (still being tested there). It puts a private
  Node.js (checked against nodejs.org's checksums) and Symbio in `~/.symbio`, `sym` on your PATH and, on Windows, Symbio
  in the Start menu and on the desktop, and installs git if it's missing. Symbio keeps updating itself from npm; running
  the line again repairs the install, and `SYMBIO_UNINSTALL=1` removes it. A copy installed with npm is updated in place.

## [0.36.0]

- **Fixed: a server connection that failed could stop Symbio.** When an SSH server didn't answer and then hung up,
  the second error had no listener and Symbio exited, stopping every team. Now the command fails with the reason, and
  a connection lost in the middle of a command or upload is reported instead of leaving it waiting.

- **Git missing, shown where you choose it.** In the New project dialog, the "Set up version history (git)" option now
  stays visible when git isn't installed: off, disabled, and with the reason underneath. On Windows, **Install git**
  installs it for you (with winget; Windows may ask for permission), and there's **Download git** for its website.
  **Check again** also finds a git installed while Symbio was running, without restarting Symbio.

- **Notifications are set up in order.** Each channel shows its next step where you are: after a change, its own
  **Save** takes the place of the test; **Send a test** stays off until the channel can work, with what's missing next to
  it ("Connect your chat first (step 2)").
  - **Telegram**, step by step: 1. create the bot and save its token (checked at once: a wrong token is said there, and
    the bot's name shows); 2. open that bot, send /start, **Find my chat**; then the test. The chat used to be a text
    box, where people typed a test message, which Telegram answered with "chat not found"; a chat like that saved by an
    earlier version is dropped. When the bot can't reach the chat, the error names the bot to open, and a new token
    clears the old chat.
  - **ntfy** makes up a topic nobody guesses when it's turned on, and says what to do in the app.
  - **E-mail** says that most providers want an app password, with Gmail's settings.
- **Helpers at a time** (Project settings → Team): a cap on how many helpers core may have at once, to spend less.
  Past it, core is told to give the work to a helper it has or stop one first; one-off reviewers don't count, and you
  can still add helpers yourself.
- **core keeps independent work moving.** After each merge, core hears which tasks could start now (dependencies done,
  nothing held in their way) and which helpers are free, and its brief asks it to start independent work in parallel
  instead of queuing it behind the longest lane. Found in a long project where a whole part and the deployment waited
  two days next to an idle helper.
- **core can tell a long task from a stuck one:** its team list shows, for each working agent, for how long, its last
  activity and the programs it runs.
- **Merging a helper that brought in the project's later work** (as asked after a conflict) no longer blames it for
  everyone else's files: only its own changes are checked against shared assets.
- **Stopping a program** says whether it had already ended or isn't an agent's, instead of one answer for both.
- core is told not to `git add -A` while a helper works in the project folder (it swept a helper's unfinished work
  into its commits).

## [0.35.0]

- **Projects without git** (#72): creating a project no longer fails when git is there but doesn't work; the project is
  made without it, and you're told why. With git missing, the New project dialog says what that changes (helpers share
  the folder instead of working in their own copies), how to install it, and checks again once you have.

- **An anonymous install id with update checks**, so we can tell how many people use Symbio and whether they keep using
  it (counting checks couldn't: one copy left on all day looked like many). It's a random number made on your computer,
  sent with the version; nothing about your projects or your computer. Symbio says so once in Messages, and you can turn
  it off in Settings → This computer → Updates (where it's shown). Details in `docs/security.md` → *Update checks*.

## [0.34.0]

- **Update checks go to Symbio's update endpoint** (`symbio.linkzy.dev/update`) instead of npm, which still answers when
  the endpoint doesn't. It says which version to update to (npm's latest, unless a release is held back) and counts the
  checks, so we can see how many copies of Symbio are in use; it gets no project data and no id, only Symbio's version.
  Development folders, the tests and CI keep asking npm. `SYMBIO_UPDATE_URL=off` turns it off.

- **The whole interface in Portuguese (Brazil)** (#13): every screen now goes through translations (about 1,350 texts),
  and Symbio starts in the browser's language (English when it doesn't have it); the choice in the top bar still wins.
  The texts live in one file per language (`web/src/i18n/`), keys are typed, `npm run i18n:check` lists what a language
  lacks (CI shows it as a warning), and `docs/development.md` explains how to add a language. Spanish, French and German
  are open for translators (#68, #69, #70).

- **Settings in groups** (#62): tabs across the top (Agents, Notifications, Connections, Usage and costs, This computer,
  Help), each with its own address (`#/settings/usage`), so a reload stays there and links into Settings open the right
  group (the update badge opens This computer, "add a price" opens Usage and costs: #35). A project's settings are grouped
  too (General, Team, Quality, Connections, Budget and usage, Maintenance); "Add a model" opens Team. On a phone the tabs
  scroll sideways.

- **Scheduled work** (#8): ask core for recurring (or one-off) jobs, "refresh the data every night", "check the site every
  Monday". core sets one up with its instructions and when (every few hours, every day, some weekdays, a day of the
  month, or once, in the computer's time); when it's due, Symbio wakes core with it, and core reports how it went.
  - The Plan tab lists them (Scheduled jobs), with each one's next run, its latest result and earlier runs, and **Run
    now**, pause / resume and remove.
  - In a project that asks, a job core sets up waits for your approval (Needs you); in one that decides, it starts at once.
  - A run due while the team is paused, or while the previous one is still going, is skipped and you're told why; one
    missed while Symbio was off runs when it's back. Results reach you as notifications (a failure as something that needs you).

- A helper's skills changed by you now apply to its very next turn: Symbio saved the change before telling the agent
  runtime, so a message sent right then could still run with the old skills (on GitHub Copilot CLI; an end-to-end test
  caught it now and then). Also on Copilot, a change made while an agent's session was still opening applies on its next
  turn.
- **Budgets per project** (#7), in the project's settings: a spending limit for the whole project and per day, in the
  estimated cost Symbio already shows in Usage.
  - Near a limit (80%, or the share you set) you're told, and core gets a note to spend carefully.
  - At the limit the team is paused, and the banner says why. A daily pause ends by itself the next day; raising the
    limit resumes the team; resuming it past the limit means you want it to go on, and that limit doesn't pause it again.
  - Every agent's brief states the limits. The messages reach you as notifications too (a pause as something that needs
    you).
  - Models without a price don't count (the settings say which), as in the usage report.

## [0.33.0]

- **Notifications** (#5): Symbio tells you when something waits on you and what got done, where you are.
  - **What:** an open question or a briefing, a decision core made, an approval or a permission request, a plan or work to
    review, an agent that can't continue, a file shared with you, each task done, every task done, and the team stopping
    after a stretch of work (with what core last said). What happens close together arrives as one message
    ("My site: needs you (3)"), what waits on you first.
  - **Where** (Settings → Notifications): this browser, while a Symbio tab is open in the background; **Telegram** (your
    own bot: paste its token, send it /start, *Find my chat*); **ntfy** (the phone app, on ntfy.sh with a random topic or
    your own server); a **webhook** (Discord's and Slack's incoming webhooks work as they are); **e-mail** through your
    SMTP server. Each has *Send a test* and shows how its last message went. Tokens, the webhook address and the password
    are kept in the encrypted vault, and a notification can say only "My site needs you".
  - **Per project** (its settings): everything, only what needs you, or nothing.
- **Remote access: copy and share the link and code together** (#61), by @TariQMah (#64). The copy button next to the
  link copies the link and the access code, ready to paste into a message; a Share button opens the system share sheet
  with them (or copies them where the browser has none), and the code has its own copy button.
- The end-to-end tests' copy checks use a clipboard of their own instead of the computer's: tests running side by side
  overwrote each other's copies (and the clipboard of whoever ran them).

## [0.32.0]

- **Runs on its own, or asks: a project setting** (Project settings → How core runs the project).
  - *Decide and tell me* (the default for new projects): core picks the option it would recommend and keeps going. The
    question shows in Needs you as a decision with **Keep it**, or you write what to do instead (that reaches core as a
    change to make). Its plan is approved as it makes it. It waits only for what can't be undone, costs more than you allow,
    legal or safety matters, or requirements that contradict each other. *Ask me and wait* keeps the previous behavior;
    existing projects stay on it.
  - **What the team may do without asking**, in your words (spending, deploying, deleting…): every agent gets it.
  - **Install software without asking**: package installs (pip, npm -g, winget…) stop asking in that project; running
    downloaded scripts, system installers and `| sudo` still ask, and every other guard stays.
  - **Briefing or grilling**: how core questions you about a feature. Grilling asks in rounds, each with core's recommended
    answer, until nothing is open.
- **A bigger skill library, by category.** About 25 skills grouped as planning, software, design, writing, data, operations
  and media, searchable:
  - Symbio's own, now with project planning, long-form writing, research method, server administration and video production.
  - Popular skills by other authors, each a reviewed copy pinned to a commit, with its license and a credit linking the
    author and the source: grilling, tdd and code-review (Matt Pocock); brainstorming, writing-plans, systematic-debugging
    and verification-before-completion (Jesse Vincent); write-spec, explore-data, incident-response, frontend-design and
    webapp-testing (Anthropic); security-and-hardening (Addy Osmani); incident-postmortem (GitHub); humanizer (Siqi Chen);
    copywriting (Corey Haines).
  - core gives helpers the skills their work needs on its own, and can write one for its team (`create_skill`,
    instructions only, credited to core in the library).
- The machine view (and stopping agents' programs) failed on Windows when any program's command line held a control
  character.
- GitHub Copilot CLI skips a skill whose frontmatter isn't valid YAML without saying so; Symbio's skills are checked for it.

## [0.31.0]

- **Evidence** (#56). Files agents share (`share_file`) carry a tag (evidence, report) and the task they belong to; evidence
  without a task goes to the one its helper is working on. The Files tab filters by kind (evidence, reports, the files you
  sent) and task, a task's details list its evidence, reviewers get it with their review, and agents find it with
  `list_shared_files`. This completes *Core as lead*'s planned phases.

## [0.30.0]

- **Briefings** (#55). For a new, big or vague request, core asks the questions about it together (`start_briefing`), or you
  ask it to. Needs you shows them grouped under the feature with how many are answered; core gets the answers together once
  all are in, and Symbio writes them to the feature's spec (`docs/specs/…`), which core completes and links from the
  feature's tasks. Helpers get the spec with their task, reviewers check against it, and the Plan tab links it.
- The chat names the new tools' steps in plain words (briefings, checks, reviews).

## [0.29.0]

- **Checks Symbio runs itself** (#53). Commands you approve in the project's settings (a build, tests, a spellcheck, a link
  check…) run on a helper's work when it reports a task, and again before a merge if the work changed since. A failure goes
  back to the helper with the output, without taking core's or your attention; core only hears of tasks whose checks passed,
  and `merge_work` refuses failing work unless forced (you're told). core can propose checks; they run once you approve them.
  The latest run shows on the task, each failure's output a click away.
- **A reviewer before core** (#54). A fresh, one-off helper that didn't do the work checks a task against its *Done when*,
  the rules and the glossary, with the review skill, in the folder of the helper who did it, and can't change anything. core
  asks for one on big or risky tasks (`request_review`), or you require one for every task (project settings → Checks). Its
  findings go back to the helper; its verdict shows on the task and reaches core. A task that keeps coming back is brought to
  core.
- Agents can't edit a project's `.symbio/project.json` anymore (it holds the checks Symbio runs).

- An agent whose turn ended very quickly could stay shown as working until its next turn (the turn's end arrived
  before Symbio heard back from the message it sent).

## [0.28.0]

- **Skills** (#52). Packaged methods agents load when a task calls for one (the `SKILL.md` format the agent runtimes share).
  - Symbio comes with four for leading: *briefing* (questioning the human about one feature), *glossary*, *handoff* and
    *review* (checking work against its Done when, the rules and the glossary).
  - **Settings → Skills** is the library: read any skill, write your own, or add a copy of one from a folder. Skills other
    tools keep on this computer (`~/.agents/skills`, `~/.claude/skills`, `~/.copilot/skills`) are listed to read and add.
  - **Each agent has only the skills it's given.** core gets the ones chosen in the project's settings (Symbio's four by
    default); core gives each helper the ones its work needs (`spawn_agent` `skills`, `set_skills`), from the ones the
    project allows; you can change a helper's in its chat (core can't change those). Skills found elsewhere and the
    runtimes' own are turned off for agents, on both runtimes.
  - Agents can't edit skills (they'd be writing instructions for the others); a skill's scripts run like any command.

## [0.27.0]

First steps of *Core as lead* (core is the strategic layer; helpers are tactical):

- **A glossary in every project** (#47). core keeps `docs/glossary.md` (or `glossary.md` in private docs): the project's
  terms, what each means and the words not to use. Symbio gives it to every agent with their instructions and sends it
  again when it changes; when two words are used for one thing, core asks you which to keep. It's listed right after
  `AGENTS.md` in the Docs tab.
- **Done when on every task** (#51). core writes each task's acceptance criteria when it plans; the helper gets them with
  the task and reports against each; you see and edit them in the task's details on the board (cards with one show a
  checklist icon), and the helper working on it is told when they change.
- **A fresh session can start from the agent's own handoff** (#49). *Fresh session* in a chat asks whether the agent
  should write its handoff first (one more turn: what it's in the middle of, decisions, what isn't written anywhere), on
  by default. Each chat now shows how big the conversation is (the share of its model's limit; the tokens too when you
  show token counts), amber past 60% and red past 85%.
- **New projects:** the rules register is on (#48), and helpers get a fresh session after each finished task (#50), so
  each task starts from a clean conversation and the project's documents. Existing projects keep their settings.
- `team.ts` split: fresh sessions and handoffs, the task flow, reasoning effort and the load guard now live in their own
  modules under `src/server/team/` (no change in behavior) (#44).
- **A glossary for Symbio itself** ([docs/glossary.md](docs/glossary.md)): one word per thing across the interface, docs and
  briefs. The agent's *New session* button is now *Fresh session*, like the setting; the Portuguese interface says
  *auxiliar* everywhere (#43).
- Fixed: Settings' Back button read "Back to Back to the project" for a moment, until the project's name loaded.
- The end-to-end tests run both runtimes at once, several files in parallel: about 1 min 45 s instead of 8 min on a
  28-thread machine, and about 5 min on a small one (#45).
- The secret vault reads its key from the OS credential store once per run instead of on every read and write: on
  Windows a repeated read could come back empty under load, which looked like a lost key. The end-to-end tests also
  remove the test keys they create (they were piling up in Windows Credential Manager).

## [0.26.0]

- **Copy buttons in the chat**: on each code block, and on each message (its text as written, Markdown included). They show
  on hover, and stay faintly visible on touch screens. By [@Veeramanikandanr48](https://github.com/Veeramanikandanr48) (#42).

## [0.25.0]

- **The machine view says who started each program**: the project and the agent (or the agents that were working when it
  started, when Symbio can't tell which one), with a filter by project. `list_programs` says it to core too.
- **Fixed: system programs listed as agents' programs** on Windows (Windows Defender, Task Manager, the search indexer…), which
  made the list long and the counts wrong. Windows keeps a program's parent id after the parent exits and gives the id to new
  programs; a program now only counts as another's child when it started after it. Stopping a program also stops only its
  checked children (no more `taskkill /T`), and agents' work is lowered in priority on the same checked tree. The same
  mistake could count those programs in a runtime's memory (restarting it to free memory for nothing) and stop them along
  with the runtime; both use the checked tree now.
- Dependencies updated (Hono, Vite, React plugin, Lucide, Motion, Playwright) (#40).

## [0.24.0]

- **Approve connection requests without being there for each one.** In Needs you, a request to use a connection
  can be approved once, **for a while** (the agent acts on that connection without asking for 30 minutes, 1 hour,
  4 hours or until you stop it; pausing the team ends it), or with **always allow** for plain server commands like it
  (`systemctl status *`; chained commands still ask). **Approve all** approves every request waiting. Project
  settings → Connections shows who's allowed until when (with **Stop**) and the always-allowed commands (removable).
  Agents now group the commands they need into one request, so you approve once.

## [0.23.1]

- **Report a problem** opens the new bug report form, with your Symbio version, agent runtimes and operating system
  in their fields.
- The README is shorter, with why Symbio exists, how it works (a diagram), engineering highlights, limitations and
  an FAQ; the details moved to `docs/usage.md`, `docs/features.md`, `docs/configuration.md` and
  `docs/known-issues.md`. Maintainers get `docs/releasing.md`.

## [0.23.0]

- **Use an OpenCode already on your computer.** Settings → Agent runtimes has an opt-in to run the
  `opencode` found on PATH instead of Symbio's tested copy. It's off by default, the PATH version can
  differ from the tested one, and Copilot is unaffected. By [@wesleyhjpr](https://github.com/wesleyhjpr) (#36).
- **Interface in Portuguese (Brazil).** Settings → Appearance and the top bar choose the interface language, kept
  in this browser: English (the default) or Português (Brasil), the first step of translations (#13). The main
  screens are translated; the rest shows English for now. By [@wesleyhjpr](https://github.com/wesleyhjpr) (#37).
- **Agents can't change what decides which programs Symbio runs**: its settings and state files, the runtimes it
  installed, the downloaded `cloudflared`, its Copilot folder, and OpenCode shims anywhere (so none can be put on
  the PATH). Reading them is still allowed. Only absolute folders on the PATH are searched for OpenCode.
- A new reasoning effort level applies to the agent's session before the setting shows as saved, so a message sent
  right after already runs at it.

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
