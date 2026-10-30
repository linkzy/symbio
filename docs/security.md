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

## What agents can't do

Every agent session gets permission rules from `src/server/guard.ts`:

| Rule | Why |
|---|---|
| **Deny** killing processes by name or PID (`taskkill`, `Stop-Process`, `kill`, `pkill`, `killall`, `wmic … process`…) | Your terminals, editors and Symbio itself run the same executables. An agent once ran `taskkill /F /IM node.exe /T` and closed all of them. Agents stop what they started with `stop_process`. |
| **Deny** reading or editing `~/.ssh`, Symbio's secret store, the UI key, the approvals store, Symbio's backups and OpenCode's provider logins (`auth.json`), and shell commands that mention them or private key files | Servers and GitHub are reached through Symbio's connection tools instead |
| **Ask** before installing software (`winget`, `choco`, `npm -g`, `pip install`…) and "download and run" commands (`… \| sh`, `… \| bash -s`, `… \| sudo bash`, `… \| iex`) | You approve installs from the *Needs you* inbox |

These are pattern rules, not a sandbox: an agent can still do damage with commands the patterns
don't catch, and any program running as your user, agents included, could in principle read the OS
credential store. Keep projects under version control, review what gets merged, and only give a
project the connections it needs.

## Credentials

- **Connections** (GitHub tokens, SSH passwords and keys) are encrypted with AES-256-GCM in
  `~/.symbio/secrets.enc`. The master key lives in your OS credential store (Windows Credential
  Manager, macOS Keychain, Secret Service). If that key can't be read, Symbio stops with an error
  instead of replacing it.
- Secrets never leave the Symbio server process: the API doesn't return them, and agents never see
  them. Agents call `git_push`, `github_api`, `remote_exec` and `remote_upload`, and Symbio performs
  the action.
- **GitHub pushes and pulls** happen in a repository the agent controls, so Symbio treats its config
  as untrusted. The token is passed only to git's HTTP layer, repository hooks are disabled, proxies
  and credential helpers are reset, pulls merge without the token, and Symbio refuses to use the
  token at all if the repository's config sets URL rewrites, proxies, hooks paths, credential
  helpers or includes.
- **SSH servers** are pinned on first use: the host key fingerprint seen on the first connection is
  stored, and a different key is refused. Editing and saving the connection clears the pin, for a
  reinstalled server.
- **Approvals** for remote actions are stored in `~/.symbio/approvals/`, outside the project, so an
  agent can't edit what you're about to approve. A connection set to **Ask me** makes every action
  wait for your approval; read-only GitHub API calls (GET) don't need approval.
- **Model provider keys** are passed straight to OpenCode, which stores them in its own data folder.
  Symbio doesn't keep them and only returns non-secret fields to the browser.
- File paths agents give Symbio (uploads, docs) are checked by their real path, so a symlink can't
  point outside the agent's folder.

## Things to know

- Agents work with your user's permissions. Run Symbio as a normal user, never as administrator or
  root.
- Agent conversations, including anything you paste into them, are stored by OpenCode and sent to
  the model providers you chose.
- Anyone who has the link with the UI key, or can read `~/.symbio/ui-token`, can control Symbio.
  Don't share it. Deleting the file and restarting Symbio creates a new key (open tabs then need the
  new link).

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
