# What Symbio does

- **Your choice of agent runtime.** OpenCode or GitHub Copilot CLI, per project, each with its own
  models; Symbio's rules, tools, plan and messages work the same on both. Install them from Symbio
  (nothing else on your machine changes), and move a project from one to the other in its settings:
  every agent writes a handoff and continues on the other runtime with its tasks and work.
- **One conversation, a whole team.** You chat with core. It asks what you want, studies an
  existing folder before touching it, and makes a plan of tasks: for you to approve, or, when you
  let it decide, started right away for you to change if you want.
- **Helpers that work in parallel without collisions.** Each helper gets its own git worktree and
  branch, and core reviews and merges their work. For step-by-step work (each step using the
  previous one's files), helpers can share the project folder instead, with nothing to merge.
  Helpers are only created when work can really run in parallel; one helper is the default.
- **Agents talk to each other.** Messages go straight from agent to agent through Symbio, and
  delivering a message wakes the recipient. No copy-pasting between terminals.
- **Shared assets with a gatekeeper.** Anything several agents could change (a file pattern, a
  database, a spreadsheet) can be declared a *shared asset*. Agents request it from core, wait for
  the grant and release it when done. Changes to an asset an agent wasn't granted are flagged at
  merge.
- **Review the work your way.** Helpers report each finished task with a guide for checking it:
  where to look, the steps and what you should see. Let core review (the default), or review every
  task yourself from a "To review" list (approve it, or send it back with a note to the helper), or
  only the tasks marked in the plan. Each task's changed files and diffs are a click away.
- **Notifications where you are.** Symbio tells you when something waits on you (a question, an
  approval, a plan or work to review, an agent that can't continue) and what got done (a task, every
  task, the team stopping after a stretch of work): in the browser while a tab is open, and on your
  phone or inbox through Telegram, ntfy, a webhook (Discord, Slack…) or e-mail. What happens close
  together arrives as one message. Each project sends everything, only what needs you, or nothing.
- **Questions in one list, not lost in the chat.** When the team needs a decision from you, it goes
  to your open questions (numbered, with context and suggested answers). Answer several at once
  when you have a moment; each agent gets its answers, and the same question isn't asked twice.
- **Choose how core takes your message.** A selector in the chat box: *Auto* (core decides),
  *Plan* (discuss and plan only: Symbio blocks starting work and editing files until you switch)
  or *Act* (get it done without a plan to approve).
- **Attach files to a message.** Upload, drag in or paste images and documents into the chat, as in
  other AI chats. Agents get them as files they can open (images as scaled-down copies, PDF, Word,
  Excel and PowerPoint as text), and each project's **Files** tab keeps everything sent, to open,
  resend or delete.
- **One word per thing.** Every project has a glossary core keeps: the project's terms, what each
  means and the words not to use. Every agent gets it, so the work, the reports and what you read
  use the same words; when two words are used for one thing, core asks you which to keep.
- **Runs on its own, or asks: your choice per project.** *Decide and tell me* (new projects): core
  picks the option it would recommend, keeps going, and shows it in Needs you as a decision you keep
  or change; it approves its own plan, and waits only for what can't be undone, costs more than you
  allow, legal or safety matters, or contradictory requirements. *Ask me and wait*: core asks and
  waits, and the plan waits for your approval. You also write what the team may do without asking
  (spending, deploying, deleting…), and whether it may install packages.
- **Skills.** Packaged methods agents load when a task calls for one, in a library grouped by
  category (planning, software, design, writing, data, operations, media…): Symbio's own, a few
  popular ones by other authors (Matt Pocock, Jesse Vincent, Anthropic, Addy Osmani and others,
  credited with a link and their license, each a reviewed copy), yours (write one, or add a copy of
  one from another folder after reading it), and the ones other tools keep on this computer, listed
  to add. core gives each helper the ones its work needs, and writes one when none fits; you can
  change a helper's in its chat.
- **Briefings, or grilling.** For a new, big or vague request, core asks the questions about it together (or
  you ask it to): Needs you shows them grouped under the feature, you answer them in one sitting,
  and the answers become the feature's spec, which its tasks link to and helpers and reviewers
  work from. If you prefer more questions and fewer surprises, choose *grilling*: rounds of
  questions, each with core's recommended answer, until nothing is open.
- **Evidence you can find.** Files a helper shares to show its work (a screenshot, an output, a
  test result) are tagged with their task: the task lists them, reviewers get them, and the Files
  tab filters by kind (evidence, reports, yours) and task.
- **Checks Symbio runs itself.** Commands you approve in the project's settings (a build, tests, a
  spellcheck, a link check…) run on a helper's work when it reports a task, and again before it's
  merged if it changed since. A failure goes back to the helper with the output, without taking
  core's or your attention; core can propose checks for you to approve.
- **A reviewer before core.** A fresh helper that didn't do the work checks it against its *Done
  when*, the rules and the glossary, and can't change it: core asks for one on big or risky tasks,
  or you require one for every task. Its findings go back to the helper and show on the task.
- **Documentation you can find your way in.** core keeps the project's docs up to date, and the
  Docs tab shows them as a folder tree with search across every doc, links between docs that open
  in place, an outline of long docs, and plain-text sources (e-mails, transcripts) with line
  numbers.
- **A rules register** (on for new projects; you can turn it off). Agents record the project's rules (requirements, decisions,
  constraints) with where each came from, a literal excerpt, who imposes it, how confirmed it is
  and whether it's met. The Docs tab shows them as an index you can filter and search, with each
  citation opening its source at the cited line.
- **A live plan.** The Plan tab is an animated kanban that moves by itself as helpers pick up
  tasks, ask for review and get merged. Each task says what *done* means (*Done when*): core writes
  it, the helper reports against it, and you can change it on the board.
- **You stay in control.** Questions, decisions to keep or change, plan approvals, work to review,
  permission requests (like installing software) and deploy approvals collect in a **Needs you**
  inbox. Pause one team or everything at once.
- **Connections without exposing secrets.** Give agents a GitHub account, an Azure DevOps
  organization, a server (SSH, SFTP) or an FTP account. They ask Symbio to push, open pull requests, call the API or deploy, and Symbio does it with credentials the agents never
  see. Each connection can require your approval for every action; when it does, you can approve
  several at once, let an agent act without asking for a while, or always allow plain server
  commands like one (`systemctl status *`).
- **Resilient.** A supervisor restarts the agent runtime if it crashes, a watchdog unsticks hung agents, and
  when a model fails (quota, outage) the agent switches to the next allowed model and carries on. Want
  an agent to stay on its model (say, to see how that model does)? Pin it in its chat: it then waits and
  retries that model instead.
- **Long-running teams stay healthy.** Agents continue in a fresh session with a handoff note
  (helpers after each finished task, by default for new projects; any agent when you ask, or
  automatically when a conversation grows too large to send). When you ask, the agent can write its
  own handoff first. Each chat shows how big the conversation is, so you can tell when it's time.
  A daily check backs up Symbio's state and tells you and core about work that exists only on this
  machine and build outputs filling the disk.
- **Explorer.** The project's folders and files in a tab, read-only, to look at what the team wrote
  without leaving the browser (secrets stay hidden).
- **Use it from another device.** Remote access opens a temporary link with an access code; copy
  both at once or share them (to e-mail them to yourself, say), and the interface adapts to a
  phone.
- **Copy from the chat.** A whole answer as written, a code block, or your own message, with one
  click.
- **Two languages, more coming.** The whole interface in English or Portuguese (Brazil): your browser's language at first, or the one you choose in the top bar. Spanish, French and German are being translated (#68, #69, #70).
- **Themes and layouts.** The default look, or the colors of VS Code's Dark Modern and Light Modern
  themes, and a *Workbench* layout like an editor's: tools on the left, the work in the middle, the
  chat on the right (Settings → Appearance, kept per browser). Bring your own by importing a VS Code
  color theme file.
- **Reasoning effort.** How hard each model thinks, per model in a project and per agent from its
  chat (core can set it for its helpers).
- **Costs in view.** Tokens and estimated cost per agent and model, with prices you can set (and
  GitHub Copilot's own prices, in AI credits).
- **Scheduled work.** Ask core for recurring jobs ("refresh the data every night", "check the site
  every Monday"): Symbio wakes core at the set time with the job, and you see each run and its
  result in the Plan tab, with Run now, pause and remove. In a project that asks, you approve a job
  first.
- **Budgets.** A spending limit per project, for the whole project and per day. Near a limit you
  and core are told (core then spends carefully); at the limit Symbio pauses the team. A daily pause
  ends by itself the next day, raising the limit resumes the team, and resuming it past the limit
  means you want it to go on.
- **Helpers at a time.** A cap on how many helpers core may have at once (Project settings → Team),
  to spend less: past it, core gives new work to the helpers it has or stops one first. You can
  still add helpers yourself.
- **Kind to small computers.** Agents' programs run at low priority, so the computer stays usable and
  reachable; the machine view in the top bar lists what they started and which project and agent
  started each (filter by project; Stop works from a phone too),
  and an overloaded machine is reported to you and core, optionally holding new turns until it recovers.
- **Safety rails.** Agents can't kill processes by name (which would take down your terminals and
  editors), can't read your SSH keys or Symbio's secret store, can't change Symbio's own settings,
  and must ask before installing software (unless you let a project install packages). They look at images through scaled-down copies, so a few large pictures can't make a
  conversation too big to send.

See also: [usage.md](usage.md) to get started, [configuration.md](configuration.md) for settings and where
data lives, and [security.md](security.md) for the safety rules in detail.
