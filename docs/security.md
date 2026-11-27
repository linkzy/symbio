# Security model

Symbio runs AI agents that execute shell commands **as you, on your machine**. It's a local,
single-user tool. These are the protections it has, and their limits. The main thing it defends
against is an agent (a confused model, or one following malicious instructions it read somewhere)
working around the human's control, and web pages in your browser reaching the local server.

## The local API

- Symbio listens on `127.0.0.1` only.
- **Every API request needs the UI key.** A random key is kept in `~/.symbio/ui-token`. The browser
  receives it once, in the link Symbio opens (`/?token=…`), keeps it in `localStorage` and removes
  it from the address bar. Without the key, an agent could `curl` the API to approve its own
  actions or answer its own permission prompts. Agents are denied reading the key file.
- Requests must name `127.0.0.1` or `localhost` as their Host (defeats DNS rebinding). Requests
  that change anything must come from Symbio's own page or carry no `Origin`
  (`src/server/origin.ts`).
- The agents' tool endpoint (`/mcp/<token>`) has its own unguessable per-folder token, and every call
  is matched to a live agent session; core-only tools check the caller's role.
- **New folders from the browser** (`POST /api/fs/mkdir`, the in-page folder browser used over remote access): one
  plain name inside an existing folder, no separators or characters Windows refuses, never recursive.
- **Project files in the browser** (links to paths agents mention, files they share, the Explorer
  tab, `src/server/files.ts`): only files inside the project folder or a helper's copy are served, checked
  on real paths so a symlink can't lead outside. Never git's internals (`.git/`), Symbio's own data
  in `.symbio/` (except attachments and docs), or files that look like secrets (`.env*`, private keys,
  `.pem`/`.pfx`/`.p12`, `.npmrc`, `.netrc`). Files are fetched with the UI key and shown from memory;
  the key never goes in a file URL. Only images, video, audio, PDFs and plain text are shown in the
  browser; anything else downloads. The Explorer lists folders under the same rules: hidden files and
  folders aren't listed and can't be opened, and it's read-only (no writing, renaming or deleting).
- **Imported color themes** (`web/src/vscodeTheme.ts`) stay in the browser and only plain hex colors
  from them reach the page's style; anything else in the file is ignored.
- Debug routes that pass OpenCode responses through (`/api/debug/opencode/*`, raw model data) are
  off unless Symbio is started with `SYMBIO_DEBUG=1`, because those responses can contain provider
  keys.

## Remote access (optional)

`sym remote` (or Settings → Remote access) opens a temporary Cloudflare quick tunnel, a
`https://….trycloudflare.com` link to this Symbio, so you can use it from another device. It's off
unless you turn it on, and it ends when you turn it off or Symbio stops. Through it, someone controls
agents that run commands on your computer, so:

- **Access code.** A new 8-character code (no look-alike characters) is made each time and shown
  only on this computer, never through the tunnel. Entering it gives the browser a session cookie
  (HttpOnly, Secure, SameSite=Strict, 12 hours).
- **Lockout.** Every wrong code waits 1.5 seconds; after 10 wrong codes the tunnel is shut down.
- **Two factors per request.** Remote API calls need both the session and the UI key; the key
  alone (say, leaked from this computer) isn't enough from outside.
- **Never through the tunnel:** the agents' tool endpoint (`/mcp`), debug routes, shutting Symbio
  down, opening a tunnel, and the native folder dialog.
- **Requests from other sites** (a different `Origin`) are refused, as locally.
- The in-page folder browser (used remotely instead of the native dialog) lists folder names only,
  never files or their contents.
- **Visible and easy to stop.** A banner shows that remote access is on, with a Turn off button
  (also for the remote visitor). Turning it off ends every remote session at once.
- Requests are recognized as remote by Cloudflare's headers or the tunnel's host name. If neither
  were present, a request would be treated as local, where it still needs the UI key.
- `cloudflared` is used from the PATH, or downloaded once from Cloudflare's official GitHub releases
  into `~/.symbio/bin`.

Use it on machines and networks where that's acceptable, and only share the link and code with
yourself.

## The OpenCode server

Symbio's private OpenCode server listens on `127.0.0.1` with a random port and password. It runs in
`--stdio` mode, in which OpenCode removes the password from its environment after reading it, so
agents' shells don't inherit it. Without that, an agent could call OpenCode directly and rewrite
its own permission rules. The server exits when Symbio does.

## GitHub Copilot CLI

Projects can run their agents on GitHub Copilot CLI instead of OpenCode. Symbio starts it through the
Copilot SDK over stdio (no network port), with its own data folder (`~/.symbio/copilot`), signed in
with the user's own GitHub login: Symbio points that folder at the login in `~/.copilot/config.json`;
the token stays in the OS credential store and is never copied; or the human signs in from Settings
with a GitHub device code. Copilot asks its host before running commands and writing files, so the
rules below are applied by Symbio itself (`guard.ts`'s `evaluate`); reads inside the working folder
don't ask, so Symbio checks every file read in a hook that runs before each tool. The same rules as
for OpenCode. Model providers set up for the Copilot CLI with your own key (`providers.json` in your
Copilot folder) are read where they are and handed to Copilot's process; Symbio doesn't copy them,
and only model names reach the browser.

## What agents can't do

Every agent session gets permission rules from `src/server/guard.ts`:

| Rule | Why |
|---|---|
| **Deny** killing processes by name or PID (`taskkill`, `Stop-Process`, `kill`, `pkill`, `killall`, `wmic … process`…) | Your terminals, editors and Symbio itself run the same executables. An agent once ran `taskkill /F /IM node.exe /T` and closed all of them. Agents stop what they started with `stop_process`; core can stop a program any agent started with `stop_program`, and you from the machine view in the top bar. Those stop by process id, and only processes Symbio recognizes as agents' programs (under a runtime's shells, or seen there before), never the rest of the machine. |
| **Deny** reading or editing `~/.ssh`, Symbio's secret store, the UI key, the approvals store, Symbio's backups and OpenCode's provider logins (`auth.json`), and shell commands that mention them or private key files | Servers, GitHub and Azure DevOps are reached through Symbio's connection tools instead |
| **Deny** editing what decides which programs Symbio runs: its settings and state (`runtime-settings.json`, `config.json`, `connections.json`, `machine.json`, `updates.json`, `notifications.json` (where notifications go), `opencode.pid`, and each project's `.symbio/project.json`, which holds its checks), the runtimes it installed (`runtimes/`), the downloaded `cloudflared` (`bin/`), its own Copilot folder, the skill library (`skills/`: instructions other agents follow; a skill's scripts may still run), and OpenCode shims anywhere (`opencode.cmd`, `.ps1`, `.bat`, `.exe`); shell commands that mention them are refused too. Reading them is allowed | Otherwise an agent could turn on "OpenCode from the PATH", put its own `opencode.cmd` there, and Symbio would run it as the runtime, outside these rules, with the runtime's server password. Shell commands are matched on their text, so for shell writes this is best effort, as for the secrets |
| **Ask** before installing software (`winget`, `choco`, `npm -g`, `pip install`…) and "download and run" commands (`… \| sh`, `… \| bash -s`, `… \| sudo bash`, `… \| iex`) | You approve installs from the *Needs you* inbox. A project can let its team install packages without asking (Project settings → *Install software without asking*): only the package managers' installs stop asking; running downloaded scripts, system installers (`msiexec`) and `| sudo` still ask, and every deny stays |
| **Refuse** reading image files (png, jpg, gif, webp, bmp) and PDFs with the read tool; Symbio answers with a pointer to `view_image` or `read_document` | The read tool puts the whole file in the conversation, re-sent every turn; a few large ones made one too big to send |

**Plan mode** (core's chat) adds `PLAN_MODE_PERMISSIONS` to core's session: every edit denied, and
the usual writing commands (redirects to a file, `git commit`/`push`/`checkout`…, deleting, moving,
copying, `Set-Content`…) denied, while reading stays allowed; Symbio's own tools refuse anything
that starts work. Like the rest, these are patterns that catch the usual ways, not a sandbox.

**Reviewers** (one-off helpers checking another helper's task, in that helper's folder) get
`REVIEWER_PERMISSIONS`: every edit denied, so they judge the work without changing it.

These are pattern rules, not a sandbox: an agent can still do damage with commands the patterns
don't catch, and any program running as your user, agents included, could in principle read the OS
credential store. Keep projects under version control, review what gets merged, and only give a
project the connections it needs.

## Credentials

- **Connections** (GitHub and Azure DevOps tokens, SSH passwords and keys) are encrypted with AES-256-GCM in
  `~/.symbio/secrets.enc`. The master key lives in your OS credential store (Windows Credential
  Manager, macOS Keychain, Secret Service). If that key can't be read, Symbio stops with an error
  instead of replacing it.
- Secrets never leave the Symbio server process: the API doesn't return them, and agents never see
  them. Agents call `git_push`, `git_pull`, `github_api`, `azure_devops_api`, `remote_exec` and
  `remote_upload`, and Symbio performs the action.
- **The project's own credentials are different.** Connection strings, `.env` files and the like
  that live in the project are part of the work: agents may use them for the task (connecting to a
  database the work needs), as any developer on the project would, and so may credentials the human
  gives them. What the briefs forbid is spreading them: putting one into anything committed or
  shared (new files, docs, the rules register, the plan, messages to other agents) or printing it.
  Systems the human calls read-only or production are only read unless the human OKs a change.
  (An earlier blanket rule, "never look for credentials", made agents refuse such work.)
- Symbio's own records stay on this machine: a project's `.symbio/` folder has its own
  `.gitignore` (`*`), so the message log, plan and agent data are never committed. Anything typed
  in a chat also lives in OpenCode's local database.
- **Pushes and pulls** (GitHub, Azure DevOps) happen in a repository the agent controls, so Symbio treats its config
  as untrusted. The token is passed only to git's HTTP layer, repository hooks are disabled, proxies
  and credential helpers are reset, pulls merge without the token, and Symbio refuses to use the
  token at all if the repository's config sets URL rewrites, proxies, hooks paths, credential
  helpers or includes. A token only goes to its own host: GitHub tokens to `github.com`, Azure
  DevOps tokens to `dev.azure.com` (or the older `<organization>.visualstudio.com`) and only for
  remotes of the connection's organization. Azure DevOps API calls are confined to that
  organization too (paths only, no full URLs).
- **SSH servers** are pinned on first use: the host key fingerprint seen on the first connection is
  stored, and a different key is refused. Editing and saving the connection clears the pin, for a
  reinstalled server.
- **FTP accounts** use FTPS (TLS, explicit or implicit) by default, with the certificate verified;
  "Accept the server's certificate as it is" turns verification off for hostings with self-signed or
  mismatched certificates, and *Plain FTP* sends the password and files unencrypted (the form says
  so). Uploads come only from inside the agent's working folder, like SSH uploads. `remote_exec` on
  an FTP account accepts only the file operations `ls`, `mkdir`, `rm`, `rmdir` and `mv`, checked before
  anything is queued; listing doesn't need approval (like read-only API calls), changes follow the
  connection's *Ask me* / *Allow*, and removing the account's top folder is refused.
- **Approvals** for remote actions are stored in `~/.symbio/approvals/`, outside the project, so an
  agent can't edit what you're about to approve. A connection set to **Ask me** makes every action
  wait for your approval; read-only API calls (GET, GitHub or Azure DevOps) don't need approval.
  When you approve you can also **allow the agent on that connection for a while** (30 minutes to
  until you stop it): its actions there run without asking, each one still logged in Messages, and
  Project settings → Connections lists who's allowed until when, with **Stop**; pausing the team
  ends them all. Or **always allow server commands like it** (`systemctl status *`): only plain
  commands match, so anything with `;`, `&&`, `|`, `$(…)`, backticks, redirects or line breaks still
  asks, and an allowed prefix can't carry another command along. The patterns are listed (and
  removable) in the same place; they're part of the project, which agents can't edit.
- **Model provider keys** are passed straight to OpenCode, which stores them in its own data folder.
  Symbio doesn't keep them and only returns non-secret fields to the browser.
- Agents can't read image files with OpenCode's read tool: those reads are refused (by Symbio,
  with a message pointing to `view_image`), because a full-size image stays in the conversation and
  is re-sent every turn. `view_image` returns a scaled-down copy and refuses secret paths.
- File paths agents give Symbio (uploads, docs) are checked by their real path, so a symlink can't
  point outside the agent's folder.
- The Docs tab can open any file in the docs locations (`AGENTS.md`, `docs/`, or the private docs),
  read-only, such as a PDF a rule cites. Only PDFs, images and plain text are shown in the browser;
  anything else (HTML, SVG…) is downloaded instead, so a file in the docs can't run script in
  Symbio's page. The page fetches it with its key, so the key never appears in a tab's address.

- **Attachments** are stored in the project's `.symbio/attachments` (git-ignored), up to 50 MB each,
  with names made safe for every OS. The browser opens them through the API with its key; only
  images, PDFs and plain text are shown inline, everything else downloads.
- **Updates** come from the npm registry, installed by npm like any global package; releases are
  built and published by GitHub Actions with provenance. Which version to update to comes from
  Symbio's update endpoint (see *Update checks* below). Its answer is only a version number,
  checked before it's used. Applying an update
  restarts Symbio, so it's never possible through remote access.
- **Agent runtimes** (OpenCode, the Copilot SDK) also come from the npm registry, by npm, at the
  exact versions Symbio is tested with, into `~/.symbio/runtimes`, when the human asks for one in
  Settings (or at startup, for one existing projects use). By default Symbio never runs one from the
  PATH, so another copy on the computer doesn't change what runs. In Settings → Agent runtimes the
  human can explicitly opt in to using an OpenCode already on PATH (there, or on the first run);
  that version may be unverified, and the Copilot SDK can't be swapped this way. To show a copy's
  version, Symbio runs `<command> --version` on what it finds on the PATH (once per file). Agents can't turn that option on (the guard above),
  only absolute folders on the PATH are searched, and the first `opencode` found there is what runs,
  so keep the PATH free of folders others can write to. An npm shim (`opencode.cmd`) is started
  through `cmd.exe`, which keeps the server password in its own environment (OpenCode itself removes
  it); programs running as you could read it from there.

## The installer

The one-line installers (`scripts/install/`, hosted unchanged by the website) download
Node.js from nodejs.org and check it against nodejs.org's published SHA-256 checksums before using
it, then install Symbio from npm like `npm install -g` does. Everything goes in `~/.symbio` (`node`,
`app`) without admin rights; agents can't change those folders (`guard.ts`), since Symbio runs from
them. Only `~/.symbio/app/launcher` is added to the user's PATH, not the private Node.js. On
Windows, git is installed with winget, or Git for Windows' installer from its GitHub releases,
unless `SYMBIO_NO_GIT=1`; Windows asks for permission. When Windows lacks the Microsoft Visual C++
runtime (a new Windows may), the installer installs it from Microsoft (`aka.ms/vs/17/release`,
signed): the module Symbio reaches Credential Manager with needs it. Without it Symbio still runs,
but can't store passwords and tokens, and says how to fix it. Piping a script into a shell trusts its
source: read it first at the address, or in this repository, if you prefer.

## Update checks

Installed copies ask `https://symbio.linkzy.dev/update` which version to update to, at start and
every hour while they run (npm when it doesn't answer). The request carries:

- Symbio's version, in its user agent (`symbio/0.35.0`);
- an **anonymous install id** (`x-symbio-install`): a random UUID made on this computer the first
  time Symbio runs, kept in `~/.symbio/updates.json`. It says nothing about you, your projects or
  the computer; it lets us count copies in use (per day, week and month), new installs, and
  whether people keep using Symbio.

Nothing else: no project data, no names, no paths. The endpoint keeps, per id, when it was seen
(date and time), the version, and the country the check came from, for 90 days after the last
check. The country is worked out from the connection's address when the check arrives; the address
itself isn't kept. The country tells us which translations to do next, the times tell real copies
from test runs. Installed copies tell the
human about the id once, in Messages. It's described, with the id itself, in **Settings → About**
(*Usage statistics*), where it's **turned off** (the id
is deleted; turning it on again makes a new one, which can't be linked to the old). Update checks
keep working without it. Development folders, the tests and CI ask npm directly and send nothing,
and `SYMBIO_UPDATE_URL=off` skips the endpoint altogether.

## Notifications

- They go only to the channels the human turns on in Settings → Notifications: the open Symbio
  tabs, and Telegram (their own bot), ntfy (ntfy.sh or their own server), a webhook address and an
  SMTP server. What they carry is the project's name and what happened (a question's text, a task's
  title, what core last said); with *Only that a project needs you*, nothing about the project's
  content leaves the computer.
- The bot token, the ntfy token, the webhook address (it holds Discord's and Slack's keys) and the
  e-mail password are kept in the vault like connections' secrets: the API says only whether each
  is set. Telegram's error replies can quote the request URL, which holds the token, so only their
  description is kept.
- On ntfy.sh, anyone who knows a topic can read it: Symbio suggests a random one, and the human can
  use their own server with a token.
- Agents can't change where notifications go: `notifications.json` is one of Symbio's own files
  (*What agents can't do*).

## Things to know

- Agents work with your user's permissions. Run Symbio as a normal user, never as administrator or
  root.
- Agent conversations, including anything you paste into them, are stored by OpenCode and sent to
  the model providers you chose.
- Anyone who has the link with the UI key, or can read `~/.symbio/ui-token`, can control Symbio.
  Don't share it. Deleting the file and restarting Symbio creates a new key (open tabs then need the
  new link).

- **Installing git** from the New project dialog runs `winget install --id Git.Git` on this computer,
  only when you press *Install git* (Windows, with winget). Windows may ask for permission on this
  computer's screen. Agents can't reach this: they don't have the UI key.

## Skills

A skill is instructions agents follow, sometimes with scripts they run, often written by someone
else. Symbio treats them that way:

- **Nothing is picked up silently.** Agents get only the skills Symbio gives them: core the ones in
  its project's settings, a helper the ones core or you gave it. Skills in other tools' folders on
  this computer (`~/.agents/skills`, `~/.claude/skills`, `~/.copilot/skills`) and the runtimes' own
  built-in skills are turned off for agents (OpenCode: permission rules on its skill tool; Copilot:
  the session's turned-off skills, verified live). They're listed in Settings → Skills so you can
  read one and add a copy.
- **You read before you add.** Adding a skill from another folder shows its `SKILL.md` first. The
  library keeps a **copy** (`~/.symbio/skills`): it doesn't change when the original does, so an
  update can't slip in. Links inside a skill's folder are refused, and folders over 2 MB.
- **Agents can't change skills.** The library is protected like Symbio's settings (`guard.ts`): an
  agent editing a skill would be writing instructions for the others. Running a skill's scripts is
  allowed, under the same rules as any command.
- **core gives only what the project allows.** You choose which skills core may give helpers
  (Project settings → Skills); skills you give a helper yourself, core can't change.
- **Third-party skills Symbio ships are reviewed copies.** Each is pinned to one commit of its
  repository, permissively licensed (MIT or Apache-2.0, its license file kept next to it), credited
  (author, link, source) and adapted only by a note on how it maps to Symbio. Ones that bundle
  servers, hooks, telemetry or many scripts were left out. They never update themselves; a new
  version comes with a Symbio release.
- **Skills core writes are instructions only.** `create_skill` writes a `SKILL.md`, no files to run,
  into your library with core as its author, where you can read or remove it.

## Checks

- **Only the commands you approve run.** A check is a command Symbio runs itself, through the
  system shell, in a helper's folder (with your environment, like the agents' own commands). You add
  them, or approve the ones core proposes, in the project's settings; agents can't change them
  (they're in the project's `.symbio/project.json`, which the guard keeps agents from editing), and
  a proposal never runs until you approve it.
- **Contained.** A check's folder must be inside the helper's folder; it runs at low priority, with
  a time limit after which its process tree is stopped (by pid). Its output goes to the helper and
  shows on the task, so don't write checks that print secrets.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
