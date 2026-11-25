// Safety rules applied to every agent session (OpenCode permission rules).
//
// Agents run shell commands as the user, so a command like
// `taskkill /F /IM node.exe /T` kills every Node program on the machine — the
// user's terminals, editors, Claude Code and Symbio itself (this happened).
// Killing processes by name or PID is therefore denied for agents; they stop
// what they started through Symbio's stop_process tool instead.
//
// Patterns are whole-value wildcards over each command OpenCode's scanner
// extracts (compound commands are split; any deny blocks the call). Matching may
// be case-sensitive, hence the spelling variants.

const KILL_PATTERNS = [
  "*taskkill*",
  "*TASKKILL*",
  "*Taskkill*",
  "*tskill*",
  "*Stop-Process*",
  "*stop-process*",
  "*STOP-PROCESS*",
  "spps *",
  "kill *",
  "pkill *",
  "killall *",
  "*wmic*process*",
  "*WMIC*PROCESS*",
  "*Stop-Computer*",
  "*Restart-Computer*",
  "shutdown *",
];

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

// Installing software on the machine needs the human's OK (asked in the UI). A project can let its
// team install packages without asking (Project.allowInstalls, withoutInstallAsks): only the package
// managers' installs, never "download and run" or system installers (RUN_DOWNLOADED_PATTERNS).
const PACKAGE_INSTALL_PATTERNS = [
  "winget install*",
  "winget upgrade*",
  "choco install*",
  "choco upgrade*",
  "scoop install*",
  "npm install -g*",
  "npm i -g*",
  "npm install --global*",
  "npm i --global*",
  "pnpm add -g*",
  "yarn global add*",
  "pip install*",
  "pip3 install*",
  "py -m pip install*",
  "python -m pip install*",
  "python3 -m pip install*",
  "pipx install*",
  "cargo install*",
  "go install*",
  "dotnet tool install*",
  "*Install-Module*",
  "*Install-Package*",
];
const RUN_DOWNLOADED_PATTERNS = [
  "msiexec*",
  "*Add-AppxPackage*",
  // "download and run" installers
  "*| iex*",
  "*|iex*",
  "*Invoke-Expression*",
  "*| sh",
  "*| bash",
  "*|sh",
  "*|bash",
  "*| sh *",
  "*| bash *",
  "*|sh *",
  "*|bash *",
  "*| sudo *",
  "*|sudo *",
  "*| pwsh*",
  "*| powershell*",
];
const INSTALL_PATTERNS = [...PACKAGE_INSTALL_PATTERNS, ...RUN_DOWNLOADED_PATTERNS];

// Agents never read private keys, Symbio's secret store, the UI key (which would let
// them approve their own actions), their approvals or OpenCode's provider logins.
const SECRET_PATHS = [
  "*\\.ssh\\*",
  "*/.ssh/*",
  "*\\.symbio\\secrets*",
  "*/.symbio/secrets*",
  "*\\.symbio\\ui-token*",
  "*/.symbio/ui-token*",
  "*\\.symbio\\approvals*",
  "*/.symbio/approvals*",
  "*\\.symbio\\backups*",
  "*/.symbio/backups*",
  "*\\opencode\\auth.json",
  "*/opencode/auth.json",
];
const SECRET_SHELL = [
  "*.ssh/*",
  "*.ssh\\*",
  "*id_rsa*",
  "*id_ed25519*",
  "*id_ecdsa*",
  "*.ppk*",
  "*.symbio*secrets*",
  "*ui-token*",
  "*.symbio*approvals*",
  "*.symbio*backups*",
  "*opencode*auth.json*",
];

// What decides which programs Symbio runs and how (its settings, the runtimes it installed, the
// downloaded cloudflared, its own Copilot folder, its state): agents may read them but never change
// them. Otherwise an agent could, for example, turn on "OpenCode from the PATH" and put its own
// opencode.cmd there, and Symbio would run it as the runtime, outside these rules. The OpenCode
// executables are covered by name too, so none can be planted on the PATH. Shell commands are
// matched on their text, so like the secrets above this is best effort for shell writes. A project's
// own settings (.symbio/project.json in its folder) are covered too: they hold the checks Symbio runs.
const SYMBIO_FILES = ["runtime-settings.json", "config.json", "connections.json", "machine.json", "updates.json", "notifications.json", "opencode.pid", "project.json"];
const SYMBIO_FOLDERS = ["runtimes", "bin", "copilot", "skills"];
const RUNTIME_EXECUTABLES = ["opencode.cmd", "opencode.exe", "opencode.ps1", "opencode.bat"];
const SYMBIO_CONTROL_PATHS = [
  ...SYMBIO_FILES.flatMap((f) => [`*\\.symbio\\${f}`, `*/.symbio/${f}`]),
  ...SYMBIO_FOLDERS.flatMap((d) => [`*\\.symbio\\${d}\\*`, `*/.symbio/${d}/*`]),
  ...RUNTIME_EXECUTABLES.flatMap((f) => [`*\\${f}`, `*/${f}`]),
];
const SYMBIO_CONTROL_SHELL = [
  ...SYMBIO_FILES.flatMap((f) => [`*.symbio\\${f}*`, `*.symbio/${f}*`]),
  // Skills' own scripts run from their folder: only their files are protected (edit rules above).
  ...SYMBIO_FOLDERS.filter((d) => d !== "skills").flatMap((d) => [`*.symbio\\${d}\\*`, `*.symbio/${d}/*`]),
  // Running `opencode.exe --version` is harmless; the shims are only ever written.
  ...RUNTIME_EXECUTABLES.filter((f) => f !== "opencode.exe").map((f) => `*${f}*`),
];

// Images read with the read tool go into the conversation at full size and are re-sent every
// turn; a few large ones made a conversation too big to send at all. Agents look at images
// through Symbio's view_image tool instead, which scales them down. These reads are "ask", not
// "deny", only so the refusal can carry a message: Symbio rejects them itself, at once, telling
// the agent to use view_image (a bare deny just says "Permission denied", and a model gave up).
// Patterns are case-sensitive, hence both spellings.
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const IMAGE_PATHS = IMAGE_EXTENSIONS.flatMap((ext) => [`*.${ext}`, `*.${ext.toUpperCase()}`]);
// PDFs the same way (the read tool attaches the whole file as data; verified with OpenCode 2.1.4):
// agents read their text with read_document, a part at a time.
const PDF_PATHS = ["*.pdf", "*.PDF"];

/** A read Symbio refuses on the agent's behalf (an image or a PDF), with what to do instead. */
export function readRefusal(action: string, resources: string[]): string | null {
  if (action !== "read" || !resources.length) return null;
  const all = (patterns: string[]) => resources.every((r) => patterns.some((p) => wildcardMatch(p, r)));
  const file = JSON.stringify(resources[0]);
  if (all(IMAGE_PATHS)) {
    return (
      "Symbio blocks reading image files directly: a full-size image stays in your conversation and is sent again on every " +
      `turn. Use Symbio's view_image tool instead (in code mode: tools.symbio.view_image({ path: ${file} })); ` +
      "it returns a scaled-down copy, and a crop shows details at full resolution."
    );
  }
  if (all(PDF_PATHS)) {
    return (
      "Symbio blocks reading PDFs directly: the whole file would stay in your conversation and be sent again on every turn. " +
      `Use Symbio's read_document tool instead (in code mode: tools.symbio.read_document({ path: ${file} })); ` +
      'it returns the text, a few pages at a time (pages: "3-8").'
    );
  }
  return null;
}

const rules = (action: string, effect: PermissionRule["effect"], patterns: string[]): PermissionRule[] =>
  patterns.map((resource) => ({ action, resource, effect }));

// Plan mode (core's chat): it may read and look around, but not change anything. With every edit
// denied OpenCode doesn't even offer the write/edit tools; the shell keeps read-only commands
// (verified live, docs/opencode-api.md). Patterns, not a sandbox: they catch the usual ways.
const PLAN_MODE_SHELL = [
  "* > *",
  "* >> *",
  "*| tee *",
  "*|tee *",
  "tee *",
  "git commit*",
  "git push*",
  "git merge*",
  "git rebase*",
  "git reset*",
  "git checkout*",
  "git switch*",
  "git restore*",
  "git rm *",
  "git mv *",
  "git stash*",
  "git apply*",
  "git cherry-pick*",
  "git revert*",
  "git tag*",
  "git init*",
  "git clone*",
  "rm *",
  "rmdir *",
  "del *",
  "erase *",
  "rd *",
  "mv *",
  "move *",
  "cp *",
  "copy *",
  "xcopy *",
  "robocopy *",
  "mkdir *",
  "md *",
  "touch *",
  "sed -i*",
  "New-Item*",
  "Remove-Item*",
  "Move-Item*",
  "Copy-Item*",
  "Rename-Item*",
  "Set-Content*",
  "Add-Content*",
  "Out-File*",
  "Clear-Content*",
];
export const PLAN_MODE_PERMISSIONS: PermissionRule[] = [...rules("edit", "deny", ["*"]), ...rules("shell", "deny", PLAN_MODE_SHELL)];

/**
 * Session rules without the asks for installing packages (the project lets its team install). The
 * asks for running downloaded scripts, system installers and sudo stay.
 */
export function withoutInstallAsks(list: PermissionRule[]): PermissionRule[] {
  return list.filter((r) => !(r.action === "shell" && r.effect === "ask" && PACKAGE_INSTALL_PATTERNS.includes(r.resource)));
}

// A reviewer checks another helper's work in that helper's folder: it reads and runs things, but
// doesn't change the work it judges (team/verify.ts).
export const REVIEWER_PERMISSIONS: PermissionRule[] = rules("edit", "deny", ["*"]);

// Any matching deny blocks a call; otherwise any ask prompts. Deny rules come last
// so they also win under "last match wins".
export const AGENT_PERMISSIONS: PermissionRule[] = [
  ...rules("shell", "ask", INSTALL_PATTERNS),
  ...rules("read", "ask", [...IMAGE_PATHS, ...PDF_PATHS]), // refused by Symbio with a message (readRefusal)
  ...rules("shell", "deny", KILL_PATTERNS),
  ...rules("shell", "deny", SECRET_SHELL),
  ...rules("shell", "deny", SYMBIO_CONTROL_SHELL),
  ...rules("read", "deny", SECRET_PATHS),
  ...rules("edit", "deny", SECRET_PATHS),
  ...rules("edit", "deny", SYMBIO_CONTROL_PATHS),
];

/** Whether a path is one agents may never read (keys, Symbio's secrets…), for Symbio's own file tools. */
export function isSecretPath(file: string): boolean {
  return SECRET_PATHS.some((p) => wildcardMatch(p, file));
}

/** Text for agent briefs explaining the rule and the alternative. */
export const PROCESS_RULES = `- Never kill processes by name or PID (taskkill, Stop-Process, kill, pkill…):
  other programs on this machine — the human's terminals and editors, other
  agents, Symbio itself — run the same executables. Those commands are
  blocked.
- Run anything long-lived (a server, a watcher) as a background shell (the shell
  tool's \`background\` option). Stop it with Symbio's \`stop_process\` tool
  (see \`list_processes\` for what you have running). Stop what you started when
  you are done with it.
- Installing software on the machine (winget, choco, npm -g, pip install…) asks
  the human first; your command waits until they answer. Only install what the
  task really needs, and say why in your message before running it.
- Never read SSH keys or anything under ~/.ssh or Symbio's secret store —
  servers and GitHub are reached through Symbio's connection tools.`;

/**
 * The effect of a session's rules on a call, for runtimes that leave the decision to Symbio
 * (GitHub Copilot CLI): any matching deny wins, then any ask; otherwise it's allowed. A shell
 * command is checked whole and part by part (`a; b`, `a && b`, `a || b`, lines), as OpenCode's
 * scanner does, so a blocked command can't hide behind another.
 */
export function evaluate(rules: PermissionRule[], action: string, resources: string[]): { effect: PermissionRule["effect"]; rule?: PermissionRule } {
  const values = action === "shell" ? resources.flatMap((r) => [r, ...shellParts(r)]) : resources;
  const matching = rules.filter((r) => r.action === action && values.some((v) => wildcardMatch(r.resource, v)));
  const deny = matching.find((r) => r.effect === "deny");
  if (deny) return { effect: "deny", rule: deny };
  const ask = matching.find((r) => r.effect === "ask");
  if (ask) return { effect: "ask", rule: ask };
  return { effect: "allow" };
}

function shellParts(command: string): string[] {
  return command
    .split(/\r?\n|;|&&|\|\|/)
    .map((p) => p.trim())
    .filter((p) => p && p !== command.trim());
}

/** OpenCode-style wildcard: "*" any run, "?" one char; "x *" also matches bare "x". */
export function wildcardMatch(pattern: string, value: string): boolean {
  const body = pattern
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  if (new RegExp(`^${body}$`, "s").test(value)) return true;
  return pattern.endsWith(" *") && value === pattern.slice(0, -2);
}
