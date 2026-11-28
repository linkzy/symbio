# Glossary

Symbio's words, one per thing. Use these in the interface (en and pt-BR), the docs, the agents'
briefs and commit messages. Where the code uses another name (older, or more technical), it's in the
last column: the code can keep it, but nothing a person or an agent reads should.

When you add a concept, add it here first. When you notice two words for one thing, pick one here
and align the rest.

## People and agents

| Term | Means | pt-BR | In the code |
|---|---|---|---|
| **the human** | The person using Symbio. The interface says "you"; briefs say "the human" | você / o humano | `"human"` |
| **agent** | Any AI member of a team: core or a helper | agente | `Agent` |
| **core** | The agent that leads a project's team: talks with the human, plans, delegates, reviews and merges. Shown with a *lead* badge. Not "the coordinator" in anything a person reads | core (badge: *líder*) | role `"coordinator"`, `coordinatorBrief` |
| **helper** | An agent core (or the human) creates to do work: one purpose, tasks from the plan | auxiliar | role `"worker"`, `workerBrief` |
| **team** | A project's agents | equipe | |
| **project** | A folder Symbio runs a team on, with its plan, messages and settings | projeto | `Project`, data in `<folder>/.symbio/` |

## Conversations

| Term | Means | pt-BR | In the code |
|---|---|---|---|
| **runtime** | The program that runs the agents' conversations: OpenCode or GitHub Copilot CLI | runtime | `AgentRuntime`, `RuntimeKind` |
| **model** | The AI model an agent runs on (`provider/model`) | modelo | |
| **reasoning effort** | How much a model thinks before answering (low, medium, high…) | esforço de raciocínio | `effort`, `modelEfforts` |
| **session** | One conversation of an agent with its runtime. Earlier ones stay readable | sessão | `sessionId`, `previousSessions` |
| **conversation size** | How much the model reads on an agent's next step, and the share of its model's limit; shown in its chat | tamanho da conversa (contexto) | `Agent.context`, `session.context.updated` |
| **fresh session** | Continuing an agent in a new session, from a handoff note. Not "renew", "refresh" or "new session" in anything a person reads | sessão nova | `renewSession`, `renewSessions` (`"manual"` / `"after-task"`) |
| **handoff note** | What a fresh session starts from: the agent's own note (when it wrote one) plus the facts Symbio has (plan, assets, recent messages) | nota de handoff | `handoffNote`, `lastWords` |
| **brief** | The instructions Symbio gives an agent: its role, the project's rules, its tools | instruções | `prompts.ts` |
| **mode** | How core takes the human's message: *Auto*, *Plan* or *Act* | modo | `coreMode` |
| **Symbio update** | A note to running projects' core when an update changes how agents work | atualização do Symbio | `updates.ts` |

## The work

| Term | Means | pt-BR | In the code |
|---|---|---|---|
| **plan** | The project's goal and tasks, proposed by core and approved by the human (or approved as made, when the human lets core decide); shown as a board in the Plan tab | plano | `PlanStore`, `Kanban.tsx` |
| **task** | One piece of the plan (`T3`): what to do, who does it, what it depends on | tarefa | `Task` |
| **report** | A helper telling core a task is finished (its task moves to *review*), with a summary and a guide | relatório | `update_task(…, "review")` |
| **guide** | With a report: where to look and how to check the work | guia | `guide` |
| **review** | Checking finished work: by core (with a reviewer when it asks for one, or the human requires it), and also by the human (*To review*) per the project's setting | revisão | `reviewBy` (`"core"`, `"every"`, `"marked"`) |
| **send back** | The human returning reviewed work to its helper, with a note | devolver | |
| **merge** | Bringing a helper's committed work from its own copy into the project | mesclar | `merge_work`, `mergeWorkspace` |
| **own copy** | A helper's separate copy of a git project, on its own branch | a própria cópia | workspace `"own"`, git worktree |
| **project folder** | The project itself, where core (and helpers that share it) work | pasta do projeto | workspace `"shared"` |
| **shared asset** | Anything more than one agent could change (files, data, a spreadsheet, a database). One holder at a time; core decides | recurso compartilhado | asset register, `asset-protocol.ts` |
| **rules register** | The project's rules (requirements, decisions, constraints), each with its source and whether the work meets it | registro de regras | `rules*` |
| **project documentation** | What agents (and people) need to work on the project: `AGENTS.md` and `docs/`, or private docs | documentação do projeto | `docs.ts` |
| **skill** | A packaged method (a folder with a `SKILL.md`) an agent loads when a task calls for it. Symbio's, or the human's **library** (`~/.symbio/skills`); each agent has only the ones it's given | skill (biblioteca de skills) | `skills.ts`, `Agent.skills`, `Project.coreSkills` |
| **glossary** | A project's terms, what each means and the words not to use; core keeps it, every agent gets it (`docs/glossary.md`) | glossário | `glossaryPath`, `symbio-glossary` |
| **Done when** | A task's acceptance criteria: what the helper reports against and the review checks | Pronto quando | `doneWhen`, `done_when` |
| **briefing** | The questions about one feature, asked together before work starts; the answers become its spec. Not "grilling" or "interview" | briefing | `start_briefing`, `Briefing`, `briefings.json` |
| **spec** | A feature's document of what the human decided (often a briefing's result, in `docs/specs/`); its tasks link to it | especificação | `Task.spec` |
| **check** | A command Symbio runs itself on a helper's work (build, tests, spellcheck…) when it reports a task and before a merge; the human approves each | verificação | `Project.checks`, `checks.ts`, `propose_check` |
| **reviewer** | A one-off helper that checks a task's work against *Done when*, the rules and the glossary, and gives a verdict | revisor | `Agent.reviewer`, `team/verify.ts`, `request_review`, `submit_review` |
| **autonomy** | How much core decides on its own (a project setting): *Decide and tell me*, or *Ask me and wait* | autonomia (*Decida e me avise* / *Pergunte e espere*) | `Project.autonomy` (`"decide"` / `"ask"`) |
| **decision** | What an agent decided meanwhile, shown in Needs you for the human to keep or change | decisão | `Question.decided` |
| **what the team may do without asking** | The human's standing permissions for a project (spending, deploying, deleting…) | o que a equipe pode fazer sem pedir | `standingPermissions`, `allowInstalls` |
| **light / thorough** | How much process a project puts around the work: light (new projects) starts quickly and adds specs, a glossary and documentation when needed; thorough has them from the start. Not "mode" (that's the chat's Auto / Plan / Act) | leve / completo | `Project.depth` |
| **grilling** | Questioning in rounds, each with a recommended answer, until nothing is open; the alternative to a briefing | sabatina | `questionStyle: "grill"`, the `grilling` skill |
| **shared file** | A file an agent showed the human (in the chat and the Files tab), tagged with what it is and its task | arquivo compartilhado | `share_file` |
| **evidence** | Shared files that show a task's work was done (screenshots, outputs, results), tied to the task | evidência | `share_file` `tag: "evidence"`, `list_shared_files` |
| **program** | Something an agent started that keeps running (a server, a tunnel, a build) | programa | `AgentProcess`, `list_programs` |

## The human's side

| Term | Means | pt-BR | In the code |
|---|---|---|---|
| **Needs you** | Everything waiting for the human: questions, approvals, work to review, the plan | Precisa de você | `Inbox.tsx` |
| **question** | Something only the human can answer, asked by an agent; in Needs you | pergunta | `ask_human`, `questions.ts` |
| **approval** | The human allowing an action: a remote action on a connection that asks, or a permission request | aprovação | `remote.ts`, `permissions.ts` |
| **connection** | A GitHub account, Azure DevOps organization, server or FTP account agents use through Symbio, never seeing its credentials. *Ask me* or *Allowed* | conexão | `Connections`, `policy` (`"ask"` / `"allow"`) |
| **pause** | Stopping a team (or every team) from starting new turns until resumed | pausar | `paused` |
| **scheduled job** | Recurring (or one-off) work core set up at the human's request; Symbio wakes core with it when it's due. Not "cron", "task" (a task is part of the plan) | rotina agendada | `Job`, `schedule.ts`, `team/schedules.ts` |
| **budget** | A project's spending limit, for the whole project and per day, in estimated cost; at the limit the team is paused | orçamento | `Project.budget`, `team/budget.ts` |
| **notification** | A message about what waits on the human or got done, sent where they are (browser, Telegram, ntfy, a webhook, e-mail) | notificação | `notifier.ts`, `notifications.ts` |
| **This computer** | The machine view in the top bar: load, and the programs agents started | Este computador | `machine.ts`, `Machine.tsx` |
