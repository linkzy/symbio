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

// Installing software on the machine needs the human's OK (asked in the UI).
const INSTALL_PATTERNS = [
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
  "msiexec*",
  "*Install-Module*",
  "*Install-Package*",
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
  "*opencode*auth.json*",
];

const rules = (action: string, effect: PermissionRule["effect"], patterns: string[]): PermissionRule[] =>
  patterns.map((resource) => ({ action, resource, effect }));

// Any matching deny blocks a call; otherwise any ask prompts. Deny rules come last
// so they also win under "last match wins".
export const AGENT_PERMISSIONS: PermissionRule[] = [
  ...rules("shell", "ask", INSTALL_PATTERNS),
  ...rules("shell", "deny", KILL_PATTERNS),
  ...rules("shell", "deny", SECRET_SHELL),
  ...rules("read", "deny", SECRET_PATHS),
  ...rules("edit", "deny", SECRET_PATHS),
];

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

/** OpenCode-style wildcard: "*" any run, "?" one char; "x *" also matches bare "x". */
export function wildcardMatch(pattern: string, value: string): boolean {
  const body = pattern
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  if (new RegExp(`^${body}$`, "s").test(value)) return true;
  return pattern.endsWith(" *") && value === pattern.slice(0, -2);
}
