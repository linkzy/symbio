# Testing on other platforms

Symbio is developed on Windows, and CI runs on hosted runners that already have most of what a
person's computer may lack. The platform smoke tests put Symbio on a **clean machine** the way a new
user does (the one-line installer, a plain user, no Node.js, no developer tools) and check what such
a machine tends to break: the PATH edit, the private Node.js, shortcuts, git, the vault (the OS
credential store), the runtime downloads, Defender, update in place, uninstall.

Anyone can run them, on any Windows machine with the features below; nothing here depends on one
computer.

## When to run them

Not every release. Run them when a change touches what depends on the machine:

- the installers (`scripts/install/`), the update runner, self-update;
- installing runtimes, finding programs (`machine.ts`, `runtime/install.ts`), git detection;
- the vault (`secrets.ts`), paths and the data folder, starting and stopping (`bin/symbio.js`);
- a new Node.js major, or a release that says it supports a new platform.

| Level | What | When |
|---|---|---|
| CI, every push | unit and end-to-end tests on Windows | always (`ci.yml`) |
| CI, installer changes | the smoke tests on Windows (PowerShell 5.1 and 7), Ubuntu and macOS runners | `scripts/install/` or the smoke scripts change (`install.yml`) |
| Platform pass | the smoke tests on a clean headless Linux (WSL) and a clean Windows (Sandbox) | before a release with a change from the list above |

Hosted runners are **not** clean machines (they have libraries, compilers, a desktop session's
credential store on macOS): a pass in CI doesn't replace the platform pass. The first platform pass
found a Node.js library missing from a fresh Ubuntu that CI never would.

## Setting up a Windows machine

Windows 10/11 **Pro** or higher. In *Turn Windows features on or off* (Portuguese: *Ativar ou
desativar recursos do Windows*), turn on:

| Feature | Portuguese | For |
|---|---|---|
| Windows Subsystem for Linux | Subsistema do Windows para Linux | headless Linux |
| Virtual Machine Platform | Plataforma de Máquina Virtual | headless Linux (WSL 2) |
| Windows Sandbox | Área Restrita do Windows | clean Windows |

then restart. WSL also needs `wsl --update` once. No admin rights are needed after that: the
scripts create throwaway Linux distributions and Sandboxes and remove them when they finish.

Without these (Windows Home, a Mac, a Linux machine): run `scripts/platform/smoke.sh` in any fresh
Linux VM or container as a plain user, or rely on the CI level and say so in the release.

## Running them

From the repository, in PowerShell 7:

```powershell
# Headless Linux: a fresh Ubuntu 24.04 in WSL, a plain user, no Windows programs on its PATH.
pwsh scripts/platform/linux-wsl.ps1
pwsh scripts/platform/linux-wsl.ps1 -Distro Debian                     # any name from `wsl --list --online`
pwsh scripts/platform/linux-wsl.ps1 -Prepare "apt-get update && apt-get install -y libatomic1"
pwsh scripts/platform/linux-wsl.ps1 -Installer https://symbio.linkzy.dev/install   # the published one

# Clean Windows: Windows Sandbox, the installer through iex under the default execution policy.
pwsh scripts/platform/windows-sandbox.ps1
pwsh scripts/platform/windows-sandbox.ps1 -Installer https://symbio.linkzy.dev/install.ps1
```

Both test this checkout's installer by default, installing the latest published Symbio
(`-Version` for another one). `-Runtimes ""` skips the runtime downloads; `-Keep` leaves the machine
to look around (`wsl -d <name> -u tester`; the Sandbox window). `-Prepare` runs as root first: use
it to check that the installer's advice works (install what it said was missing).

Each prints one line per check and writes a report to `scripts/platform/results/` (ignored by git).
A Linux run takes about 2 minutes with the runtimes; a Sandbox run longer (it installs git too).

The installed copies never ask the update endpoint (`SYMBIO_UPDATE_URL=off`: they'd be counted as
users) and use port 4399, so they can't meet a Symbio running on the same computer.

**On a computer you use**, don't run `smoke.ps1` directly unless you keep it away from your Symbio:
set `SYMBIO_HOME` to a temporary folder and `SYMBIO_NO_PATH`, `SYMBIO_NO_SHORTCUT` and
`SYMBIO_NO_GIT` to `1` (see the script's header). The installer leaves an npm-installed Symbio alone
when `SYMBIO_HOME` is set, and the vault key goes to its own credential entry.

## What they check

`scripts/platform/smoke.sh` (Linux, macOS) and `smoke.ps1` (Windows) do the same steps:

1. The installer, as `curl … | sh` or `irm … | iex` runs it; the private Node.js runs; the launcher.
2. A new terminal finds `sym` (the profile lines; the user PATH on Windows), shortcuts, git.
3. Symbio starts with no screen; the API answers, and only with the UI key.
4. A secret saved in the vault (a notification webhook).
5. OpenCode and GitHub Copilot CLI installed through Symbio.
6. Symbio started again **from a new login** (`smoke.sh again`, after the distro restarts): the
   secret is still readable.
7. Defender flagged nothing (Windows); the installer again updates in place; uninstall removes
   everything it added.

What they don't check, and needs a person in the Sandbox or a VM with a screen: the shortcut opens
the browser, SmartScreen and Defender prompts while downloading, the folder picker, sign-in flows.
macOS runs on CI only for now: its Keychain there belongs to a logged-in runner, not a clean Mac.

## Recording a pass

Put the result in the release's pull request or issue: the platforms, the checkout, PASS/FAIL
counts, and every FAIL with its line from the report. A FAIL that isn't fixed before the release
becomes an issue and, if users can meet it, a line in [known-issues.md](known-issues.md).

## Results so far

| Date | Platform | Result |
|---|---|---|
| 2026-11-27 | Ubuntu 24.04, WSL 2, headless | Node.js 26 from nodejs.org needs `libatomic1`, which a minimal Ubuntu lacks: the installer now says so and how to install it. With it, everything passes but the vault after a restart: with no Secret Service, the key lands in the kernel's session keyring and is lost with the login (#9). |
| 2026-11-27 | CI: Windows (PowerShell 5.1, 7), Ubuntu, macOS | First CI run found that a new zsh (macOS) and a bash with `~/.bash_profile` didn't find `sym`: fixed. All pass after; Ubuntu's vault after a restart passes there only because the runner keeps one session keyring for the whole job. |
| 2026-11-27 | Windows 11 26300 (dry run on a used machine) | All pass, PowerShell 5.1. The Sandbox run is still to come. |
