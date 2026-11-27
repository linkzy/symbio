# Known issues and limitations

What doesn't work yet, or works with a catch. Bugs go to the
[issue tracker](https://github.com/linkzy/symbio/issues); this page keeps the ones worth knowing
before you start, and the limits that come from how Symbio is built.

## Known issues

Problems people ran into, to fix.

- **OpenCode restarts often on long projects.** Its memory grows with long sessions; on one project
  it was restarted 15+ times in a day. Symbio recovers and agents continue, but turns are cut
  short. Fresh sessions help; the cause is in OpenCode.
- **Copilot costs don't match on OpenCode.** For GitHub Copilot models used through OpenCode, the cost Symbio shows differs a lot
  from OpenCode's own figure.

## Known limitations

- Tested on clean Windows 11 and headless Ubuntu machines; macOS only on CI's Macs so far, not a new user's Mac.
- On a Windows without the Microsoft Visual C++ runtime, passwords and tokens can't be stored until it's installed
  (the Windows installer does it; otherwise https://aka.ms/vs/17/release/vc_redist.x64.exe).
- On a minimal Linux, the installer may ask for `libatomic1` (Node.js needs it): `sudo apt install libatomic1`.
- One person per Symbio: no accounts or sharing; each person runs their own.
- Two agent runtimes: OpenCode and GitHub Copilot CLI (preview); the roadmap's [Ideas](roadmap.md#ideas) has Claude Code and Codex.
- Agent safety rules are pattern-based, not a sandbox (see [security.md](security.md)): agents run as
  your user.
- No hard CPU or memory limits for what agents start: they run at low priority, and the load guard
  tells you and core when the computer is overloaded.
- Conversations live in each runtime's storage on this computer. A project opened on another
  machine keeps its docs and plan, but its agents' sessions don't come along.
- The interface is in English, and in Portuguese (Brazil) for the main screens
  ([#13](https://github.com/linkzy/symbio/issues/13)).
- Relies on experimental OpenCode APIs (instructions, MCP registration), which may change between
  OpenCode releases. Symbio installs the OpenCode version it's tested with (2.1.x); a newer one on
  the PATH (the opt-in) may not work: 2.4 changed the models and sessions API
  ([#57](https://github.com/linkzy/symbio/issues/57)).
