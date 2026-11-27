# Configuration and data

## Environment variables

All optional, set as environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `SYMBIO_PORT` | `4310` | Port for the UI and API (bound to 127.0.0.1 only) |
| `SYMBIO_HOME` | `~/.symbio` | Where Symbio keeps its global data |
| `SYMBIO_NO_OPEN` | | Set to `1` to not open the browser on start (use the link Symbio prints) |
| `SYMBIO_DEBUG` | | Set to `1` to enable the read-only OpenCode debug routes (for development) |
| `SYMBIO_OPENCODE_BIN` | installed | Path to an `opencode` executable to use instead of the one Symbio installed; it also takes precedence over the PATH opt-in |
| `SYMBIO_CLOUDFLARED_BIN` | auto | Path to `cloudflared` for remote access (otherwise the PATH, or a copy downloaded once) |
| `SYMBIO_STUCK_MINUTES` | `10` | Silence before the watchdog interrupts a working agent |
| `SYMBIO_RECYCLE_MB` | `1500` | Restart an agent runtime above this memory use once its agents are idle |
| `SYMBIO_RECYCLE_HARD_MB` | `3000` | Restart an agent runtime above this memory use regardless (agents resume) |
| `SYMBIO_MEMORY_CHECK_SECONDS` | `60` | How often the agent runtimes' memory use is checked |
| `SYMBIO_AGENT_PRIORITY` | `low` | Set to `normal` to run the agents' work at normal priority instead of below normal |
| `SYMBIO_OVERLOAD_CPU` | `90` | The computer counts as overloaded when CPU use averages this (%) or more… |
| `SYMBIO_OVERLOAD_SECONDS` | `180` | …over this many seconds (or free memory stays under 10% of it, at least 600 MB) |
| `SYMBIO_OVERLOAD_FREE_MB` | | A different free-memory floor, in MB |
| `SYMBIO_BACKUP_DAYS` | `7` | How many daily backups of Symbio's state to keep |
| `SYMBIO_BUILD_ALERT_GB` | `2` | Build outputs in a helper's folder above this size are reported by the daily check |
| `SYMBIO_UPDATE_URL` | `https://symbio.linkzy.dev/update` | Where installed copies ask which version to update to; `off` asks npm directly |
| `SYMBIO_GIT_SEARCH` | the usual install folders | Where to look for a git that isn't on Symbio's PATH (installed while it runs), separated like the PATH; empty looks nowhere (the tests use it) |
| `SYMBIO_TELEGRAM_API` | `https://api.telegram.org` | Where Telegram notifications are sent (the tests use a stand-in) |
| `SYMBIO_NOTIFY_GROUP_MS` | `20000` | How long notifications gather what happens together before sending it as one message |
| `SYMBIO_NOTIFY_QUIET_MS` | `60000` | How long no agent works before the team counts as stopped (a notification) |
| `SYMBIO_NOTIFY_MIN_RUN_MS` | `180000` | Shorter stretches of work (a quick reply) don't count as the team stopping |

## Where your data lives

| Location | What |
|---|---|
| `~/.symbio/config.json` | The list of projects |
| `~/.symbio/runtime-settings.json` | Which runtimes run from the copy already on the computer (on the PATH) instead of Symbio's own (`fromComputer`; OpenCode only, for now) |
| `~/.symbio/skills/` | Your skills (one folder with a `SKILL.md` each), added in Settings → Skills |
| `~/.symbio/connections.json` | Connection settings (no secrets) |
| `~/.symbio/secrets.enc` | Connection secrets and notification tokens (Telegram, ntfy, the webhook address, the e-mail password), encrypted with a key kept in your OS credential store |
| `~/.symbio/notifications.json` | Where notifications go, which kinds are sent, and what they say (no secrets) |
| `~/.symbio/worktrees/` | Helpers' working copies |
| `~/.symbio/runtimes/` | The agent runtimes you installed from Symbio |
| `~/.symbio/copilot/` | GitHub Copilot CLI's sessions for Symbio's agents (kept apart from your own Copilot history) |
| `~/.symbio/backups/` | Daily backups of Symbio's state (the last 7 days) |
| `~/.symbio/approvals/` | Remote actions waiting for (or decided by) your approval |
| `~/.symbio/prices.json` | Model prices used for cost estimates |
| `~/.symbio/ui-token` | The key that unlocks the UI (it's in the link Symbio opens) |
| `~/.symbio/logs/symbio.log` | Symbio's log when started in the background (`sym logs`); `update.log` next to it for updates |
| `~/.symbio/updates.json` | Your update setting (automatic, tell me, off), and the anonymous install id sent with update checks (`false` when turned off) |
| `~/.symbio/machine.json` | What happens when the computer is overloaded |
| `<project>/.symbio/` | Project state: agents and settings (`project.json`, including its checks), plan, message log, shared assets, questions and briefings, files agents shared, and the files attached in chats (`attachments/`) — git-ignored automatically |
| `<project>/AGENTS.md`, `<project>/docs/` | Project documentation for agents (unless you chose *private*), `docs/glossary.md` (the project's glossary), `docs/specs/` (features' specs, from briefings), and `docs/rules.json` if the rules register is on |
| The runtime's own storage | The conversations themselves: each agent is a session of its runtime. OpenCode keeps them in its database (open one with `opencode -s <session-id>`); GitHub Copilot CLI in `~/.symbio/copilot/`. |

Symbio never deletes your project files. Removing a project from Symbio only forgets it, and can
optionally delete its `.symbio/` folder.
