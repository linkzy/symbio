// The team's work in plain words: a label for each tool step in the chat, instead of the command or
// code the model typed. Symbio's own tools are labelled from their arguments (in OpenCode's "code
// mode" a step is a script, and its metadata lists the tools it called); OpenCode's file tools by
// the file; shell commands by what they run, since OpenCode records no description for them.
// Pure functions (no React), so they're unit-tested in tests/steps.test.ts.

/** How much a step matters when summarizing a run of them: changes > runs > looking around. */
export type StepWeight = 3 | 2 | 1;

export interface StepLabel {
  label: string;
  /** A second line: the start of a message, the question asked… */
  detail?: string;
  weight: StepWeight;
}

/** A tool OpenCode's code mode called, as listed in the step's metadata.toolCalls. */
export interface ToolCall {
  tool: string;
  status?: string;
  input?: Record<string, unknown>;
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const firstLine = (v: unknown, max = 140) => {
  const line = s(v).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
/** The last part of a path, for labels ("C:\\a\\b\\Foo.cs" → "Foo.cs"). */
export const fileName = (p: unknown) => s(p).replace(/^["']|["']$/g, "").split(/[\\/]/).filter(Boolean).pop() ?? s(p);

/** One step → its label(s). A code-mode step that called several tools gets one label per call. */
export function stepLabels(name: string, input: unknown, calls?: ToolCall[]): StepLabel[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === "execute" || typeof i.code === "string") {
    const list = calls?.length ? calls : callsFromCode(s(i.code));
    if (list.length) return list.map((c) => toolLabel(c.tool.replace(/^symbio\./, ""), c.input ?? {}));
    return [{ label: "Ran a script", detail: firstLine(i.code), weight: 2 }];
  }
  return [toolLabel(name.replace(/^symbio[._]/, ""), i)];
}

/** Without metadata (a step still running), the tools a script calls, from its code. */
export function callsFromCode(code: string): ToolCall[] {
  return [...code.matchAll(/tools\.([\w$]+)\.([\w$]+)\s*\(\s*(\{[^]*?\})\s*\)/g)].map((m) => ({
    tool: `${m[1]}.${m[2]}`,
    input: looseArgs(m[3]),
  }));
}

/** Pulls simple `key: "value"` pairs out of an object literal the model wrote (no eval). */
function looseArgs(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of text.matchAll(/([\w$]+)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|[\w.$-]+)/g)) {
    const raw = m[2];
    out[m[1]] = /^["'`]/.test(raw) ? raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\(["'\\])/g, "$1") : raw;
  }
  return out;
}

function toolLabel(tool: string, i: Record<string, unknown>): StepLabel {
  const task = s(i.task_id).toUpperCase();
  switch (tool) {
    // The team
    case "send_message":
      return { label: `Message to ${s(i.to) || "an agent"}`, detail: firstLine(i.message), weight: 3 };
    case "check_messages":
      return { label: "Checked for messages", weight: 1 };
    case "ask_human":
      return { label: "Added a question for you", detail: firstLine(i.question), weight: 3 };
    case "list_questions":
      return { label: "Checked your open questions", weight: 1 };
    case "close_question":
      return { label: `Closed question ${s(i.question_id).toUpperCase()}`, detail: firstLine(i.answer), weight: 2 };
    case "spawn_agent":
      return { label: `Created helper ${s(i.name)}`, detail: firstLine(i.purpose), weight: 3 };
    case "stop_agent":
      return { label: `Stopped helper ${s(i.agent ?? i.name)}`, weight: 3 };
    case "list_team":
      return { label: "Checked the team", weight: 1 };
    case "move_to_project_folder":
      return { label: `Moved ${s(i.agent)} into the project folder`, weight: 3 };
    // The plan
    case "submit_plan":
      return { label: `Proposed a plan${Array.isArray(i.tasks) ? ` (${i.tasks.length} tasks)` : ""}`, detail: firstLine(i.goal), weight: 3 };
    case "add_task":
      return { label: `Added task ${s(i.key) && /^T\d+$/i.test(s(i.key)) ? `${s(i.key).toUpperCase()} ` : ""}"${firstLine(i.title, 80)}"`, weight: 3 };
    case "assign_task":
      return { label: `Gave ${task} to ${s(i.agent)}`, detail: firstLine(i.note), weight: 3 };
    case "update_task": {
      const status = s(i.status);
      const verb = status === "done" ? `Marked ${task} done` : status === "review" ? `Reported ${task} for review` : status === "blocked" ? `${task} is blocked` : `${task} → ${status}`;
      return { label: verb, detail: firstLine(i.summary ?? i.note), weight: 3 };
    }
    case "list_tasks":
      return { label: "Checked the plan", weight: 1 };
    case "merge_work":
      return { label: `Merged ${s(i.agent)}'s work`, weight: 3 };
    case "clean_build_outputs":
      return { label: "Cleaned build outputs", weight: 2 };
    case "sub_repositories":
      return { label: "Checked the repositories", weight: 1 };
    // Shared assets
    case "declare_asset":
      return { label: `Declared shared asset ${s(i.name ?? i.asset)}`, weight: 2 };
    case "request_asset":
      return { label: `Asked for ${s(i.asset)}`, detail: firstLine(i.reason), weight: 2 };
    case "grant_asset":
      return { label: `Gave ${s(i.asset)} to ${s(i.agent)}`, weight: 2 };
    case "deny_asset":
      return { label: `Refused ${s(i.asset)} to ${s(i.agent)}`, detail: firstLine(i.reason), weight: 2 };
    case "release_asset":
      return { label: `Released ${s(i.asset)}`, detail: firstLine(i.summary), weight: 2 };
    case "list_assets":
      return { label: "Checked the shared assets", weight: 1 };
    // Documents, rules, images
    case "read_document":
      return { label: `Read ${fileName(i.path ?? i.file)}`, weight: 1 };
    case "view_image":
      return { label: `Looked at ${fileName(i.path ?? i.file)}`, weight: 1 };
    case "save_rule":
    case "save_rule_area":
    case "save_rule_source":
      return { label: `Updated the rules register${s(i.id) ? ` (${s(i.id)})` : ""}`, weight: 2 };
    case "list_rules":
      return { label: "Checked the rules register", weight: 1 };
    // Processes and connections
    case "list_processes":
      return { label: "Checked running processes", weight: 1 };
    case "stop_process":
      return { label: "Stopped a process", weight: 2 };
    case "list_connections":
      return { label: "Checked the connections", weight: 1 };
    case "remote_exec":
      return { label: `Ran a command on ${s(i.connection)}`, detail: firstLine(i.command), weight: 3 };
    case "remote_upload":
      return { label: `Uploaded ${fileName(i.local_path)} to ${s(i.connection)}`, weight: 3 };
    case "git_push":
      return { label: `Pushed${s(i.branch) ? ` ${s(i.branch)}` : ""}${s(i.repo) ? ` (${s(i.repo)})` : ""}`, weight: 3 };
    case "git_pull":
      return { label: `Pulled${s(i.branch) ? ` ${s(i.branch)}` : ""}${s(i.repo) ? ` (${s(i.repo)})` : ""}`, weight: 2 };
    case "github_api":
    case "azure_devops_api": {
      const method = s(i.method).toUpperCase() || "GET";
      return { label: `${tool === "github_api" ? "GitHub" : "Azure DevOps"}: ${method === "GET" ? "looked up" : "changed"} ${firstLine(i.path, 60)}`, weight: method === "GET" ? 1 : 3 };
    }
    // OpenCode's own tools
    case "read":
      return { label: `Read ${fileName(i.path ?? i.filePath)}`, weight: 1 };
    case "write":
      return { label: `Wrote ${fileName(i.path ?? i.filePath)}`, weight: 3 };
    case "edit":
    case "multiedit":
    case "patch":
    case "apply_patch":
      return { label: `Edited ${fileName(i.path ?? i.filePath) || "files"}`, weight: 3 };
    case "grep":
    case "search":
      return { label: `Searched for "${firstLine(i.pattern ?? i.query, 50)}"`, weight: 1 };
    case "glob":
    case "list":
    case "ls":
      return { label: `Listed files${s(i.pattern) ? ` (${s(i.pattern)})` : ""}`, weight: 1 };
    case "webfetch":
    case "fetch":
      return { label: `Opened ${host(s(i.url))}`, weight: 1 };
    case "websearch":
      return { label: `Searched the web for "${firstLine(i.query, 60)}"`, weight: 1 };
    case "todowrite":
    case "todoread":
      return { label: "Updated its to-do list", weight: 1 };
    case "task":
      return { label: "Asked a subagent", detail: firstLine(i.description ?? i.prompt), weight: 2 };
    case "question":
      return { label: "Asked you a question", detail: firstLine(i.question), weight: 3 };
    case "shell":
    case "bash":
    case "powershell":
      return commandLabel(s(i.command));
    default:
      return { label: tool.replace(/_/g, " "), weight: 2 };
  }
}

function host(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * A shell command in plain words. A command line often chains several commands; each part gets a
 * label and the most telling ones are kept ("Waited for the app on port 7343 · Read publicar.log").
 */
export function commandLabel(command: string): StepLabel {
  const parts = splitCommand(command);
  const labels: StepLabel[] = [];
  // "Start-Sleep 20; Test-NetConnection localhost -Port 7343": one thing, waiting for the app.
  const port = /(?:-Port\s+|localhost:|127\.0\.0\.1:)(\d{2,5})/i.exec(command)?.[1];
  const sleeps = /\b(Start-Sleep|sleep|timeout(?:\.exe)?)\b/i.test(command);
  if (port && sleeps) labels.push({ label: `Waited for the app on port ${port}`, weight: 2 });
  for (const part of parts) {
    const l = partLabel(part, !!(port && sleeps));
    if (l && !labels.some((x) => x.label === l.label)) labels.push(l);
  }
  if (labels.length === 0) return { label: "Ran a command", detail: firstLine(command), weight: 2 };
  const top = [...labels].sort((a, b) => b.weight - a.weight).slice(0, 2);
  const kept = labels.filter((l) => top.includes(l));
  return { label: kept.map((l) => l.label).join(" · "), weight: Math.max(...kept.map((l) => l.weight)) as StepWeight };
}

/** Splits on ; && || and pipes, outside quotes. Pipes keep only the first command (its producer). */
function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let skipToNext = false;
  for (let k = 0; k < command.length; k++) {
    const c = command[k];
    if (quote) {
      if (c === quote) quote = null;
      if (!skipToNext) cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (!skipToNext) cur += c;
      continue;
    }
    const two = command.slice(k, k + 2);
    if (c === ";" || c === "\n" || two === "&&" || two === "||") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      skipToNext = false;
      if (two === "&&" || two === "||") k++;
      continue;
    }
    if (c === "|") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      skipToNext = true; // what a pipe feeds into (Select-String, head…) only filters the output
      continue;
    }
    if (!skipToNext) cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function partLabel(part: string, waiting: boolean): StepLabel | null {
  const words = part.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  // Skip assignments and "cd", which only set things up ($x = …; cd folder).
  if (/^\$[\w:]+\s*=/.test(part) || /^(cd|Set-Location|pushd|popd)\b/i.test(part)) return null;
  const cmd = (words[0] ?? "").replace(/^&\s*/, "").replace(/\.exe$/i, "").toLowerCase();
  const args = words.slice(1);
  const arg = (k = 0) => (args.filter((a) => !a.startsWith("-"))[k] ?? "").replace(/^["']|["']$/g, "");
  if (/^(start-sleep|sleep|timeout)$/.test(cmd)) return waiting ? null : { label: `Waited ${arg() || "a moment"}${/^\d+$/.test(arg()) ? "s" : ""}`, weight: 1 };
  if (/^(test-netconnection)$/.test(cmd)) return waiting ? null : { label: "Checked a network connection", weight: 1 };
  if (cmd === "git") return gitLabel(args);
  if (/^(npm|pnpm|yarn|bun|npx)$/.test(cmd)) return packageLabel(cmd, args);
  if (cmd === "dotnet") return dotnetLabel(args);
  if (/^(pytest|jest|vitest|mocha)$/.test(cmd) || (cmd === "go" && args[0] === "test") || (cmd === "cargo" && args[0] === "test")) return { label: "Ran the tests", weight: 2 };
  if (/^(tsc|msbuild|make|cmake|gradle|mvn)$/.test(cmd) || (cmd === "cargo" && args[0] === "build") || (cmd === "go" && args[0] === "build")) return { label: "Built the project", weight: 2 };
  if (/^(get-content|gc|cat|type|head|tail|less|more)$/.test(cmd)) return { label: `Read ${fileName(arg())}`, weight: 1 };
  if (/^(select-string|sls|grep|rg|findstr|ag)$/.test(cmd)) return { label: `Searched for "${firstLine(arg(), 40)}"`, weight: 1 };
  if (/^(get-childitem|gci|ls|dir|tree|find|get-item)$/.test(cmd)) return { label: `Listed files${arg() ? ` in ${fileName(arg())}` : ""}`, weight: 1 };
  if (/^(remove-item|rm|del|rmdir|rd)$/.test(cmd)) return { label: `Deleted ${fileName(arg())}`, weight: 3 };
  if (/^(copy-item|cp|copy|xcopy|robocopy)$/.test(cmd)) return { label: `Copied ${fileName(arg())}`, weight: 2 };
  if (/^(move-item|mv|move|rename-item|ren)$/.test(cmd)) return { label: `Moved ${fileName(arg())}`, weight: 2 };
  if (/^(new-item|mkdir|md|ni)$/.test(cmd)) return { label: `Created ${fileName(arg())}`, weight: 2 };
  if (/^(set-content|add-content|out-file|sc|ac)$/.test(cmd)) return { label: `Wrote ${fileName(arg())}`, weight: 3 };
  if (/^(stop-process|kill|taskkill)$/.test(cmd)) return { label: "Stopped a process", weight: 2 };
  if (/^(start-process|start)$/.test(cmd)) return { label: `Started ${fileName(arg())}`, weight: 2 };
  if (/^(get-process|ps|tasklist)$/.test(cmd)) return { label: "Checked running processes", weight: 1 };
  if (/^(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)$/.test(cmd)) {
    const url = args.find((a) => /^["']?https?:/.test(a))?.replace(/^["']|["']$/g, "") ?? arg();
    return { label: `Called ${host(url)}`, weight: 1 };
  }
  if (/^(sqlcmd|psql|mysql|sqlite3|mongosh)$/.test(cmd)) return { label: "Queried the database", weight: 2 };
  if (/^(node|python|python3|py|deno|ruby|php|pwsh|powershell)$/.test(cmd)) {
    // An inline script (node -e "…", python -c "…") has no file to name.
    if (args.some((a) => /^-(e|c|p|-eval|command)$/i.test(a))) return { label: "Ran a script", weight: 2 };
    return arg() ? { label: `Ran ${fileName(arg())}`, weight: 2 } : null;
  }
  if (/^(echo|write-output|write-host|out-null|out-string|select|select-object|sort|sort-object|measure-object|format-table|ft|fl)$/.test(cmd)) return null;
  return cmd ? { label: `Ran ${fileName(cmd)}`, weight: 2 } : null;
}

function gitLabel(args: string[]): StepLabel {
  const sub = args.find((a) => !a.startsWith("-")) ?? "";
  const rest = args.slice(args.indexOf(sub) + 1).filter((a) => !a.startsWith("-"));
  const target = (rest[0] ?? "").replace(/^["']|["']$/g, "");
  switch (sub) {
    case "merge":
      return { label: target ? `Merged ${target}` : "Merged", weight: 3 };
    case "commit":
      return { label: "Committed", weight: 3 };
    case "push":
      return { label: "Pushed", weight: 3 };
    case "pull":
    case "fetch":
      return { label: "Fetched changes", weight: 2 };
    case "checkout":
    case "switch":
      return { label: target ? `Switched to ${target}` : "Switched branch", weight: 2 };
    case "rebase":
      return { label: "Rebased", weight: 3 };
    case "reset":
    case "restore":
    case "revert":
      return { label: "Undid changes", weight: 3 };
    case "stash":
      return { label: "Stashed changes", weight: 2 };
    case "add":
      return { label: "Staged changes", weight: 2 };
    case "diff":
      return { label: "Compared changes", weight: 1 };
    case "status":
      return { label: "Checked git status", weight: 1 };
    case "log":
    case "show":
      return { label: "Looked at the history", weight: 1 };
    case "grep":
      return { label: `Searched the repository${target ? ` for "${firstLine(target, 40)}"` : ""}`, weight: 1 };
    case "branch":
      return { label: "Checked branches", weight: 1 };
    case "worktree":
      return { label: "Managed worktrees", weight: 2 };
    default:
      return { label: `git ${sub}`.trim(), weight: 1 };
  }
}

function packageLabel(cmd: string, args: string[]): StepLabel {
  const sub = args[0] === "run" ? args[1] ?? "" : args[0] ?? "";
  if (/test/.test(sub)) return { label: "Ran the tests", weight: 2 };
  if (/build|typecheck|tsc/.test(sub)) return { label: "Built the project", weight: 2 };
  if (/^(install|i|ci|add)$/.test(sub)) return { label: "Installed dependencies", weight: 2 };
  if (/^(start|dev|serve|preview)$/.test(sub)) return { label: "Started the app", weight: 2 };
  if (/lint|format/.test(sub)) return { label: "Checked the code style", weight: 1 };
  return { label: `Ran ${cmd} ${sub}`.trim(), weight: 2 };
}

function dotnetLabel(args: string[]): StepLabel {
  const sub = args[0] ?? "";
  if (sub === "test") return { label: "Ran the tests", weight: 2 };
  if (sub === "build" || sub === "publish") return { label: sub === "publish" ? "Published the app" : "Built the project", weight: 2 };
  if (sub === "run" || sub === "watch") return { label: "Started the app", weight: 2 };
  if (sub === "restore" || sub === "add") return { label: "Installed dependencies", weight: 2 };
  if (sub === "ef") return { label: "Ran a database migration", weight: 3 };
  return { label: `Ran dotnet ${sub}`.trim(), weight: 2 };
}

/** One line for a run of steps: the most telling labels first, and how many more there were. */
export function summarize(labels: StepLabel[], max = 2): string {
  if (labels.length === 0) return "";
  const distinct: StepLabel[] = [];
  for (const l of labels) if (!distinct.some((d) => d.label === l.label)) distinct.push(l);
  // Stable sort: among equally telling steps, the earlier one comes first.
  const kept = [...distinct]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map((l) => l.label);
  const rest = distinct.length - kept.length;
  return kept.join(" · ") + (rest > 0 ? ` and ${rest} more` : "");
}
