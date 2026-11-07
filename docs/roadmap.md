# Roadmap

## Done (0.6)

1. **Core runtime.** Private OpenCode server, projects, core's session, streaming chat, watchdog,
   crash recovery, memory recycling.
2. **Onboarding.** Folder inspection, new and existing projects, project study with confirmation,
   `AGENTS.md`/`docs/` or private docs.
3. **Team.** MCP tools, message delivery that wakes agents, git worktrees, shared assets with core
   as gatekeeper, helpers, model fallback, forms for agents' questions, stop and restart.
4. **Plan.** `submit_plan`, approval, the animated kanban, automatic task moves, mid-turn message
   handover.
5. **Human inbox.** *Needs you*: questions, plan approval, permission requests, remote-action
   approvals, alerts. Pause and resume per project or globally.
6. **Connections.** GitHub, Azure DevOps and SSH servers with an encrypted vault and per-connection
   approval; agents never see the credentials.
7. **Providers.** Add and remove OpenCode model providers from Settings; per-agent model switching.
8. **Packaging.** `npm i -g symbio` with a bundled, pinned OpenCode; `sym` start/stop/status/logs/doctor;
   first-run guidance.
9. **Remote access.** `sym remote`: a temporary Cloudflare link with an access code, lockout, a banner
   and a button to turn it off.
10. **Shared project folder.** Helpers can work in the project folder instead of their own branch,
    for step-by-step work; processes belong to the agent that started them.
11. **Documentation for humans.** The Docs tab with a folder tree, search, links between docs and
    numbered text sources; an optional rules register with sources, excerpts and status, shown as
    a filterable index whose citations open the cited place.
12. **Conversation size.** Images only through scaled-down copies (`view_image`); a conversation
    too large to send continues in a fresh session.
13. **Long-running teams.** Fresh sessions with a handoff note, daily backups and housekeeping
    checks, token and cost tracking per agent and model.
14. **Credentials.** Symbio's own secrets stay off-limits to agents; a project's own credentials
    may be used for the task but never spread.

## Next

- **Rules register on import.** When importing an existing project, offer to build the register
  from the project and from sources the human points to (e-mails, meeting notes, manuals), marking
  rules found only in the work as unsourced.

- **Moving projects between machines.** Docs and plan travel with the folder, but agent sessions
  live in the local OpenCode database; reopening a project elsewhere should re-create its agents
  cleanly.
- **Agent graph.** A live view of agents and the messages flowing between them.
- **Eyes for agents.** Screenshots of what they build, routed to vision-capable models (agents can
  already look at images with `view_image`).
- **Per-task model routing.** Cheap models for simple tasks, strong ones for hard ones.

## Known limitations

- Tested on Windows 11 only.
- Agent safety rules are pattern-based, not a sandbox (see [security.md](security.md)).
- Relies on experimental OpenCode APIs (instructions, MCP registration), which may change between
  OpenCode releases.
