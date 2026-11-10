# Roadmap

What we're working on, what comes next and ideas we've collected, in priority order rather than
by date: priorities change as people use Symbio, and items move up or down. Suggestions are
welcome (open an issue). Items marked *(good first contribution)* are small and self-contained.

## Now

Nothing in progress; the top of Next is what comes up.

## Next

1. **Usable on phones.** The layout breaks on small screens (useful with remote access): the team
   sidebar, tabs, chat and dialogs need a mobile layout.
2. **Linux and macOS.** Test on both. The secret vault uses the OS keyring (Secret Service on Linux,
   Keychain on macOS); headless Linux (a server or container) has no keyring, so it needs a
   fallback, such as a key file readable only by the user.
3. **Create a project from a git repository.** In the New project dialog, an option to clone a
   repository (GitHub, Azure DevOps or any git URL, using the matching connection when it's private)
   into a folder and open it as a project, e.g. to continue on another computer. Tucked under an
   advanced option, so it doesn't get in the way of people who don't use git.
4. **Switch projects from the breadcrumb.** A dropdown on the project name at the top
   (Symbio › Projects › *name*) to jump to another project. *(good first contribution)*
5. **No focus outline on the chat box.** Remove the outline that appears when clicking into it, or
   make it subtle. *(good first contribution)*
6. **Speech to text** in the chat box, using the browser's speech recognition where available.
7. **Rules register on import.** When importing an existing project, offer to build the register
   from the project and from sources the human points to (e-mails, meeting notes, manuals), marking
   rules found only in the work as unsourced.
8. **Translations.** The UI in other languages, starting with Portuguese. *(good first
   contribution, once the strings are extracted)*
9. **A project site.** A GitHub Pages site that explains Symbio, with screenshots and a short video.
10. **A public demo.** A container on a VPS with a light model, connections and other sensitive
    options disabled, and visitors' data reset every few minutes (needs item 2's headless support).

## Ideas

Collected, not sorted or promised yet.

- **Answer questions from *Needs you*.** The inbox says an agent asked something; it could show the
  question itself, to answer right there instead of in the agent's chat.
- **Other agent CLIs.** Run teams on other agent runtimes besides OpenCode, and switch between them
  (e.g. from the OpenCode menu at the top). Big: Symbio is built on OpenCode's HTTP API (sessions,
  tools, permissions, events), so each runtime would need an adapter.
- **Richer answers in the chat.** Show results visually when they fit: a chart for numbers, steps
  for a procedure, a live counter while tests run.
- **Files from agents, in the chat.** When an agent produces a file (an image, a report, a
  spreadsheet), show it in the chat (images inline) with a link to download it, instead of the
  human going to find it in a folder; and keep it in the project's gallery next to the files the
  human sent.
- **Agent graph.** A live view of agents and the messages flowing between them.
- **Moving projects between machines.** Docs and plan travel with the folder, but agent sessions
  live in the local OpenCode database; reopening a project elsewhere should re-create its agents
  cleanly.
- **Eyes for agents.** Screenshots of what they build, routed to vision-capable models (agents can
  already look at images with `view_image`).
- **Per-task model routing.** Cheap models for simple tasks, strong ones for hard ones.
- **Installing without Node.js.** An installer or a single download for people who don't have
  Node.js and npm (today Symbio needs Node 22+ and `npm install -g symbio`).
- **Jira and Trello connections** *(low priority)*. Connect a board, like GitHub or Azure DevOps
  today, so core can read the work from it (issues, cards, their details) and turn it into the
  local plan for helpers, then mark items done on the board as their tasks finish.

## Done

Newest first; details per version in [CHANGELOG.md](../CHANGELOG.md).

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

## Known issues

Problems people ran into, to fix. Those marked *(good first contribution)* are small.

- **Removing a project shows "project not found".** After removing the project you're looking at,
  the page stays on its address and says it doesn't exist; it should go back to the projects list.
  *(good first contribution)*

## Known limitations

- Tested on Windows 11 only.
- Agent safety rules are pattern-based, not a sandbox (see [security.md](security.md)).
- Relies on experimental OpenCode APIs (instructions, MCP registration), which may change between
  OpenCode releases.
