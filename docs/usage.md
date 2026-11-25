# Using Symbio

How to install, start and run Symbio, and work with a team. For every feature in detail, see
[features.md](features.md); for settings and where data lives, [configuration.md](configuration.md).

## Starting Symbio

```sh
npm install -g symbio
sym                  # starts Symbio in the background and opens it in your browser
```

Symbio opens its page with a private key in the link (it also prints the link). The browser
remembers the key, so after that `http://127.0.0.1:4310` is enough. The key stops other programs
on your computer, including the agents, from using Symbio's API behind your back.

| Command | |
|---|---|
| `sym` | Start Symbio in the background and open it (or just open it, if it's running). Closing the terminal doesn't stop it. |
| `sym stop` | Stop Symbio. Agents that were working pick up where they left off on the next start. |
| `sym status` | Whether it's running, the agent runtimes' state, and each project's agents. |
| `sym open` | Open Symbio in the browser. |
| `sym logs` | The last lines of the log (`~/.symbio/logs/symbio.log`). |
| `sym doctor` | Check Node.js, git, the installed agent runtimes, the port and model providers. |
| `sym run` | Run in the foreground, with the log in the terminal. |
| `sym remote` | Open a temporary link and access code to use Symbio from another device (see below). `sym remote off` closes it. |
| `sym update` | Install the latest version and restart Symbio, once no agent is working (`--now` doesn't wait). |
| `sym update --to 0.9.0` | Install that version instead, e.g. to go back after a release that broke something; automatic updates then skip the version you left and resume with the next release. |

**Updates.** Symbio checks for new versions and, by default, installs them by itself while the team
is idle: never while an agent is working or waiting for you, or while remote access is on. It backs
up first, restarts in a minute or two, and tells you in Messages. In Settings → Updates you can
choose to be only told instead, or turn checking off, and see what's new. If a release breaks
something, `sym update --to <version>` goes back to the one before.

**From another device.** `sym remote` opens a temporary Cloudflare link to your Symbio and prints it
with an access code. Open the link anywhere (phone, another computer), enter the code, and you're
in. In Settings → Remote access, one button copies the link and code together and another shares them
(to e-mail them to yourself, say). A banner shows it's on, with a button to turn it off; after 10 wrong codes it turns off by
itself. Whoever gets in controls your agents, so keep the link and code to yourself. Details in
[docs/security.md](security.md#remote-access-optional).

`symbio` works too, as the long name of `sym`. To run from a clone instead: `npm install`,
`npm run build`, then `npm link` once to get the commands.

## Your first project

1. **Install an agent runtime.** The first time, the Projects page offers them (later: **Settings →
   Agent runtimes**). Then connect its models:
   - **OpenCode:** in **Settings → Model providers**, check that the providers you use are there.
     Add one with an API key or a browser sign-in, and remove the ones you don't use so the model
     list stays short.
   - **GitHub Copilot CLI:** sign in with GitHub from its card (or Symbio reuses your
     `copilot login`). Models you added to the Copilot CLI with your own key show up too.
2. **Create a project.** On the Projects page, click **New project**:
   - **Folder:** browse for or paste a folder. An empty folder starts a new project; an existing
     one is studied first. Symbio offers to set up git if the folder doesn't have it.
   - **Setup:** choose where the project documentation goes (in the project, or private), and which
     connections (GitHub, Azure DevOps, servers) the agents may use.
   - **Models:** pick the agent runtime (among the installed ones), the models agents may use, and
     the one core runs on (the crown).
3. **Talk to core.** Describe what you want. core asks questions, proposes a plan, and waits for
   your approval in the **Plan** tab (it shows a *Review* badge).
4. **Watch and steer.** Helpers appear in the sidebar as core creates them. Click any agent to read
   its conversation or message it directly, change its model from its header, or stop and restart
   it. The **Messages** tab shows all traffic between agents. To move the project to another agent
   runtime later: its **Settings → Agent runtime**.
5. **Answer what needs you.** Questions, approvals and permission requests show up in **Needs you**
   (top right) and in the relevant chat.

## Words used in the app

| Term | Meaning |
|---|---|
| **core** | The project's lead agent. It plans, delegates, reviews and merges; it coordinates rather than doing the work itself. |
| **Helper** | An agent core creates for a piece of work. It works in its own git worktree (branch `symbio/<name>`) or, if the project is set to, in the project folder itself. |
| **Shared asset** | Something more than one agent could change. Access goes through core: request, grant, release. |
| **Connection** | A GitHub account, Azure DevOps organization, server (SSH, SFTP) or FTP account agents can use through Symbio, without ever seeing its credentials. |
| **Allowed models** | The models a project's agents may run on. If one fails, agents fall back to the next. Some can be kept for core only, and core can be limited to some. |
