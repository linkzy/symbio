// The tools agents get from Symbio's MCP server. Every tool runs as a
// specific agent (identified by its session); coordinator-only tools refuse
// other callers.

import type { ToolDef, ToolResult } from "./mcp.js";
import { describeTask, TASK_STATUSES } from "./plan.js";
import type { Agent, MessageKind, Project } from "./store.js";
import { CONFIRMATIONS, listRules, saveArea, saveRule, saveSource, STATUSES } from "./rules.js";
import { DEFAULT_IMAGE_SIZE, viewImage } from "./images.js";
import { readDocument } from "./documents.js";
import { describeOuterRepository, gitRepoFor } from "./repos.js";
import type { Team } from "./team.js";

export interface ToolContext {
  team: Team;
  project: Project;
  agent: Agent;
}

type Tool = ToolDef<ToolContext>;

const str = (description: string) => ({ type: "string", description });

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const SENDABLE_KINDS: MessageKind[] = ["info", "request", "blocking", "urgent"];

const sendMessage: Tool = {
  name: "send_message",
  description:
    "Send a message to another agent on your team (by name; 'core' is the coordinator). Delivery wakes the recipient. " +
    "Kinds: info (FYI), request (you need something), blocking (you can't continue without an answer), urgent (interrupts the recipient — use rarely).",
  inputSchema: obj(
    {
      to: str("Recipient agent name ('core' for the coordinator)"),
      message: str("The message. Be specific and self-contained."),
      kind: { type: "string", enum: SENDABLE_KINDS, description: "Default: info" },
    },
    ["to", "message"],
  ),
  async run({ to, message, kind }, { team, project, agent }) {
    const target = team.findAgent(project, to);
    if (!target) throw new Error(`No agent named "${to}". Use list_team to see the team.`);
    if (target.id === agent.id) throw new Error("You can't message yourself.");
    const k: MessageKind = SENDABLE_KINDS.includes(kind) ? kind : "info";
    await team.deliver(project, agent, target, k, String(message));
    return `Delivered to ${target.name}.`;
  },
};

const askHuman: Tool = {
  name: "ask_human",
  description:
    "Ask the human a question that only they can answer (a decision, missing information, an approval). " +
    "Their answer arrives later as a message; continue with other work or end your turn.",
  inputSchema: obj({ question: str("The question, with enough context to answer it") }, ["question"]),
  async run({ question }, { team, project, agent }) {
    await team.askHuman(project, agent, String(question));
    return "Your question was sent to the human. Their answer will arrive as a message.";
  },
};

const listTeam: Tool = {
  name: "list_team",
  description: "List the agents on this project: name, role, purpose, status and model.",
  inputSchema: obj({}),
  run(_args, { project }) {
    return project.agents
      .map(
        (a) =>
          `- ${a.name} (${a.role}${a.status === "stopped" ? ", stopped" : `, ${a.status}`}) — ${a.purpose ?? "coordinates the project"}${a.repo ? ` · repository ${a.repo}` : ""} · model ${a.model}`,
      )
      .join("\n");
  },
};

const listAssets: Tool = {
  name: "list_assets",
  description: "List the declared shared assets, who holds each one, and who is waiting.",
  inputSchema: obj({}),
  async run(_args, { team, project }) {
    const reg = await team.assets(project);
    if (reg.list().length === 0) return "No shared assets are declared yet.";
    return reg
      .list()
      .map((a) => {
        const holder = a.holder ? (team.agentName(project, a.holder) ?? "?") : "coordinator (unassigned)";
        const waiting = a.queue.map((q) => team.agentName(project, q.agentId)).join(", ");
        return `- ${a.name}: ${a.description}${a.paths.length ? ` [paths: ${a.paths.join(", ")}]` : ""} — held by ${holder}${waiting ? `; waiting: ${waiting}` : ""}`;
      })
      .join("\n");
  },
};

const requestAsset: Tool = {
  name: "request_asset",
  description:
    "Ask the coordinator for permission to change a shared asset. Do NOT change the asset until you receive a grant message.",
  inputSchema: obj({ asset: str("Asset name (see list_assets)"), reason: str("What you need to change and why") }, [
    "asset",
    "reason",
  ]),
  async run({ asset, reason }, { team, project, agent }) {
    if (agent.role === "coordinator") {
      return "You are the coordinator: assets nobody holds are yours. If another agent holds it, ask them to release it.";
    }
    return team.requestAsset(project, agent, String(asset), String(reason));
  },
};

const releaseAsset: Tool = {
  name: "release_asset",
  description: "Release a shared asset you hold, with a short summary of what you changed. The coordinator is notified.",
  inputSchema: obj({ asset: str("Asset name"), summary: str("What you changed") }, ["asset", "summary"]),
  async run({ asset, summary }, { team, project, agent }) {
    return team.releaseAsset(project, agent, String(asset), String(summary));
  },
};

// ---- coordinator-only ----

const spawnAgent: Tool = {
  name: "spawn_agent",
  description:
    "Create a helper agent. Give it a short name, its purpose, and its first task. In a git project it works either in its own copy " +
    "on its own branch (\"own\": parallel edits, merged with merge_work) or in the project folder itself (\"shared\": its files are " +
    "there at once for the next step, nothing to merge). Without workspace, the project's setting applies.",
  inputSchema: obj(
    {
      name: str("Short unique name, e.g. 'researcher' or 'chapter-writer'"),
      purpose: str("What this agent is responsible for"),
      task_id: str("The plan task to start with (e.g. 'T2'). Preferred when there is a plan."),
      task: str("Its first task as text (when there is no plan task), or extra instructions for task_id"),
      model: str("Optional provider/model from the allowed list; defaults to your own model"),
      workspace: { type: "string", enum: ["own", "shared"], description: "Where it works (git projects); defaults to the project's setting" },
      repo: str("In a project made of several repositories: the one it works in (e.g. 'server'); its own copy comes from it"),
    },
    ["name", "purpose"],
  ),
  async run(args, { team, project, agent }) {
    return team.spawnWorker(project, agent, {
      workspace: args.workspace === "own" || args.workspace === "shared" ? args.workspace : undefined,
      repo: args.repo ? String(args.repo) : undefined,
      name: String(args.name),
      purpose: String(args.purpose),
      task: args.task ? String(args.task) : undefined,
      taskId: args.task_id ? String(args.task_id) : undefined,
      model: args.model ? String(args.model) : undefined,
    });
  },
};

const taskShape = {
  type: "object",
  properties: {
    key: str("Short key other tasks can reference in depends_on (e.g. 'skeleton'); reuse an existing id (T3) to keep that task"),
    title: str("Short title"),
    description: str("What to do, the deliverable, and constraints — enough for a helper to start"),
    depends_on: { type: "array", items: { type: "string" }, description: "Keys/ids of tasks that must be done first" },
    assets: { type: "array", items: { type: "string" }, description: "Shared assets this task will change" },
  },
  required: ["title", "description"],
  additionalProperties: false,
};

const submitPlan: Tool = {
  name: "submit_plan",
  description:
    "Propose the project plan (or a revised one) for the human to approve: a goal and tasks with dependencies. " +
    "Tasks are done by helpers. The human's decision arrives as a message; don't assign work before approval.",
  inputSchema: obj(
    { goal: str("The agreed goal, in one or two sentences"), tasks: { type: "array", items: taskShape } },
    ["goal", "tasks"],
  ),
  async run({ goal, tasks }, { team, project, agent }) {
    if (!Array.isArray(tasks)) throw new Error("tasks must be a list");
    return team.submitPlan(project, agent, String(goal), tasks);
  },
};

const addTask: Tool = {
  name: "add_task",
  description: "Add a task to the approved plan (e.g. a follow-up request from the human). Small additions don't need re-approval.",
  inputSchema: taskShape,
  async run(input, { team, project }) {
    return team.addTask(project, input);
  },
};

const assignTask: Tool = {
  name: "assign_task",
  description: "Give a plan task to an existing helper. It is marked in progress and the helper receives it.",
  inputSchema: obj({ task_id: str("Task id, e.g. T3"), agent: str("Helper name"), note: str("Optional extra instructions") }, [
    "task_id",
    "agent",
  ]),
  async run({ task_id, agent: name, note }, { team, project, agent }) {
    const helper = team.findAgent(project, String(name));
    if (!helper) throw new Error(`No agent named "${name}". Use list_team, or spawn_agent with task_id.`);
    return team.assignTask(project, agent, String(task_id), helper, note ? String(note) : undefined);
  },
};

const listTasks: Tool = {
  name: "list_tasks",
  description: "Show the plan: goal, its approval status, and every task with status, assignee and dependencies.",
  inputSchema: obj({}),
  async run(_args, { team, project }) {
    const { plan } = await team.plan(project);
    if (plan.status === "none") return "There is no plan yet.";
    const name = (id: string) => team.agentName(project, id);
    return [
      `Goal: ${plan.goal}`,
      `Plan status: ${plan.status} (revision ${plan.revision})${plan.feedback ? ` — human feedback: ${plan.feedback}` : ""}`,
      ...plan.tasks.map((t) => `- ${describeTask(t, name)}`),
    ].join("\n");
  },
};

const updateTask: Tool = {
  name: "update_task",
  description:
    "Update one of your tasks: in-progress, blocked (say why), or review (finished — summarize what you did; this is your report to the coordinator). The coordinator can update any task, including done.",
  inputSchema: obj(
    {
      task_id: str("Task id, e.g. T3"),
      status: { type: "string", enum: [...TASK_STATUSES] },
      note: str("What happened: progress, blocker, or a summary of the finished work"),
      summary: str("Same as note (either name works)"),
    },
    ["task_id"],
  ),
  async run({ task_id, status, note, summary }, { team, project, agent }) {
    // Agents often call it "summary"; dropping it silently lost their review notes.
    const text = note ?? summary;
    return team.updateTask(project, agent, String(task_id), status, text ? String(text) : undefined);
  },
};

const stopAgent: Tool = {
  name: "stop_agent",
  description: "Stop a helper agent (its finished work should be merged first). Releases any assets it holds.",
  inputSchema: obj({ agent: str("Agent name"), reason: str("Why") }, ["agent"]),
  async run({ agent: name, reason }, { team, project }) {
    const target = team.findAgent(project, name);
    if (!target || target.role === "coordinator") throw new Error(`No helper agent named "${name}".`);
    return team.stopAgent(project, target, reason ? String(reason) : "work finished");
  },
};

const moveToProjectFolder: Tool = {
  name: "move_to_project_folder",
  description:
    "Move an idle helper from its own copy (branch) into the project folder, so it works on the project's files directly. " +
    "It continues in a fresh session with a handoff note. Refused while its own copy has work that isn't merged yet.",
  inputSchema: obj({ agent: str("Helper name") }, ["agent"]),
  async run({ agent: name }, { team, project }) {
    const target = team.findAgent(project, name);
    if (!target || target.role === "coordinator") throw new Error(`No helper agent named "${name}".`);
    return team.moveToProjectFolder(project, target, "moved by the coordinator");
  },
};

const cleanBuildOutputs: Tool = {
  name: "clean_build_outputs",
  description:
    "Free disk space in an idle helper's folder by deleting its build outputs (git-ignored folders such as bin, obj, node_modules). " +
    "Committed and uncommitted work is never touched; the outputs are rebuilt when needed.",
  inputSchema: obj({ agent: str("Helper name") }, ["agent"]),
  async run({ agent: name }, { team, project }) {
    const target = team.findAgent(project, name);
    if (!target || target.role === "coordinator") throw new Error(`No helper agent named "${name}".`);
    return team.cleanHelperFolder(project, target);
  },
};

const mergeWork: Tool = {
  name: "merge_work",
  description:
    "Merge a helper's committed work into the project. Refuses if it changed shared assets it wasn't granted, unless force is true.",
  inputSchema: obj(
    { agent: str("Agent name"), force: { type: "boolean", description: "Merge despite ungranted asset changes" } },
    ["agent"],
  ),
  async run({ agent: name, force }, { team, project }) {
    const target = team.findAgent(project, name);
    if (!target || target.role === "coordinator") throw new Error(`No helper agent named "${name}".`);
    return team.mergeWork(project, target, !!force);
  },
};

const declareAsset: Tool = {
  name: "declare_asset",
  description:
    "Declare (or update) a shared asset: something more than one agent might change. Use path patterns for files/folders (e.g. 'chapters/03/**', 'brand/palette.json'); leave paths empty for external things (a database, a spreadsheet).",
  inputSchema: obj(
    {
      name: str("Short name"),
      description: str("What it is"),
      paths: { type: "array", items: { type: "string" }, description: "Path patterns relative to the project root" },
    },
    ["name", "description"],
  ),
  async run({ name, description, paths }, { team, project }) {
    const reg = await team.assets(project);
    const asset = await reg.declare(String(name), String(description), Array.isArray(paths) ? paths.map(String) : []);
    team.assetsChanged(project);
    return `Declared "${asset.name}"${asset.paths.length ? ` (${asset.paths.join(", ")})` : ""}.`;
  },
};

const grantAsset: Tool = {
  name: "grant_asset",
  description: "Grant a shared asset to an agent. They are notified (and woken up) immediately.",
  inputSchema: obj({ asset: str("Asset name"), agent: str("Agent name"), note: str("Optional instructions") }, [
    "asset",
    "agent",
  ]),
  async run({ asset, agent: name, note }, { team, project, agent }) {
    const target = team.findAgent(project, name);
    if (!target) throw new Error(`No agent named "${name}".`);
    return team.grantAsset(project, agent, target, String(asset), note ? String(note) : undefined);
  },
};

const denyAsset: Tool = {
  name: "deny_asset",
  description: "Deny an agent's request for a shared asset, with a reason. They are notified.",
  inputSchema: obj({ asset: str("Asset name"), agent: str("Agent name"), reason: str("Why, and what to do instead") }, [
    "asset",
    "agent",
    "reason",
  ]),
  async run({ asset, agent: name, reason }, { team, project, agent }) {
    const target = team.findAgent(project, name);
    if (!target) throw new Error(`No agent named "${name}".`);
    return team.denyAsset(project, agent, target, String(asset), String(reason));
  },
};

const checkMessages: Tool = {
  name: "check_messages",
  description:
    "Check for messages from other agents that arrived while you were working (e.g. an asset grant). " +
    "Any Symbio tool call also includes them, so you only need this when you have nothing else to call.",
  inputSchema: obj({}),
  run: () => "No new messages.",
};

const listProcesses: Tool = {
  name: "list_processes",
  description: "List the background processes (servers, watchers) you started that are still running, with their ids.",
  inputSchema: obj({}),
  run: (_args, { team, project, agent }) => team.listProcesses(project, agent),
};

const stopProcess: Tool = {
  name: "stop_process",
  description:
    "Stop a background process you started (by its shell id, e.g. sh_…, shown when you started it or by list_processes). " +
    "This is the only way to stop processes — killing by name or PID is blocked.",
  inputSchema: obj({ shell_id: str("The background shell id, e.g. sh_179a…") }, ["shell_id"]),
  run: ({ shell_id }, { team, project, agent }) => team.stopProcess(project, agent, String(shell_id)),
};

// ---- connections (GitHub, servers): Symbio acts with the stored credentials

const reasonField = str("Why — the human sees this when approving");

const listConnections: Tool = {
  name: "list_connections",
  description: "List the connections (GitHub accounts, servers) this project may use, and whether actions need the human's approval.",
  inputSchema: obj({}),
  run: (_args, { team, project }) => team.remote.describeFor(project),
};

const remoteExec: Tool = {
  name: "remote_exec",
  description:
    "Run a non-interactive shell command on a server connection over SSH (e.g. deploy steps, checking a service). Returns exit code and output.",
  inputSchema: obj({ connection: str("Server connection name"), command: str("The command (bash on the server)"), reason: reasonField }, [
    "connection",
    "command",
    "reason",
  ]),
  run: ({ connection, command, reason }, { team, project, agent }) =>
    team.remote.request(project, agent, { kind: "remote_exec", connectionId: String(connection), command: String(command) }, String(reason)),
};

const remoteUpload: Tool = {
  name: "remote_upload",
  description:
    "Upload a file or folder from your working folder to a server connection (recursively; skips .git, node_modules, .symbio).",
  inputSchema: obj(
    {
      connection: str("Server connection name"),
      local_path: str("File or folder, relative to your working folder"),
      remote_path: str("Destination path on the server (absolute, or relative to the user's home)"),
      reason: reasonField,
    },
    ["connection", "local_path", "remote_path", "reason"],
  ),
  run: ({ connection, local_path, remote_path, reason }, { team, project, agent }) =>
    team.remote.request(
      project,
      agent,
      { kind: "remote_upload", connectionId: String(connection), localPath: String(local_path), remotePath: String(remote_path) },
      String(reason),
    ),
};

const gitFields = {
  connection: str("GitHub or Azure DevOps connection name"),
  remote: str("Remote name or HTTPS URL (github.com, dev.azure.com) (default: origin)"),
  branch: str("Branch (default: your current branch)"),
  repo: str("In a project made of several repositories, working in the project folder: which one (e.g. 'server')"),
  reason: reasonField,
};

const gitPush: Tool = {
  name: "git_push",
  description:
    "Push committed work from your working folder to GitHub or Azure DevOps (the token is applied by Symbio; plain `git push` may have no credentials).",
  inputSchema: obj(gitFields, ["connection", "reason"]),
  run: async ({ connection, remote, branch, repo, reason }, { team, project, agent }) =>
    team.remote.request(
      project,
      agent,
      {
        kind: "git_push",
        connectionId: String(connection),
        remote: remote ? String(remote) : null,
        branch: branch ? String(branch) : null,
        repo: await gitRepoFor(project, agent, repo ? String(repo) : undefined),
      },
      String(reason),
    ),
};

const gitPull: Tool = {
  name: "git_pull",
  description: "Pull from GitHub or Azure DevOps into your working folder (merge, no rebase).",
  inputSchema: obj(gitFields, ["connection", "reason"]),
  run: async ({ connection, remote, branch, repo, reason }, { team, project, agent }) =>
    team.remote.request(
      project,
      agent,
      {
        kind: "git_pull",
        connectionId: String(connection),
        remote: remote ? String(remote) : null,
        branch: branch ? String(branch) : null,
        repo: await gitRepoFor(project, agent, repo ? String(repo) : undefined),
      },
      String(reason),
    ),
};

const githubApi: Tool = {
  name: "github_api",
  description:
    "Call the GitHub REST API (e.g. POST /user/repos to create a repository, POST /repos/{owner}/{repo}/pulls for a pull request, GET /repos/{owner}/{repo}/issues). Read-only GET calls never need approval.",
  inputSchema: obj(
    {
      connection: str("GitHub connection name"),
      method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
      path: str("API path, e.g. /user/repos"),
      // Some endpoints take a list (e.g. Azure DevOps ref updates), others an object.
      body: { anyOf: [{ type: "object" }, { type: "array" }], description: "JSON body for POST/PATCH/PUT (an object, or a list where the API expects one)" },
      reason: reasonField,
    },
    ["connection", "method", "path", "reason"],
  ),
  run: ({ connection, method, path, body, reason }, { team, project, agent }) =>
    team.remote.request(
      project,
      agent,
      { kind: "github_api", connectionId: String(connection), method: String(method), path: String(path), body },
      String(reason),
    ),
};

const azureDevopsApi: Tool = {
  name: "azure_devops_api",
  description:
    "Call the Azure DevOps REST API of the connection's organization. The path is relative to https://dev.azure.com/<organization>/ " +
    "and api-version is added if missing. E.g. GET <project>/_apis/git/repositories to find a repository's id; " +
    "POST <project>/_apis/git/repositories/<repo>/pullrequests with {sourceRefName: 'refs/heads/<branch>', targetRefName: " +
    "'refs/heads/main', title, description} to open a pull request (push the branch first with git_push); " +
    "GET <project>/_apis/git/repositories/<repo>/pullrequests?searchCriteria.status=active to list them. Read-only GET calls never need approval.",
  inputSchema: obj(
    {
      connection: str("Azure DevOps connection name"),
      method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
      path: str("Path inside the organization, e.g. MyProject/_apis/git/repositories"),
      // Some endpoints take a list (e.g. Azure DevOps ref updates), others an object.
      body: { anyOf: [{ type: "object" }, { type: "array" }], description: "JSON body for POST/PATCH/PUT (an object, or a list where the API expects one)" },
      reason: reasonField,
    },
    ["connection", "method", "path", "reason"],
  ),
  run: ({ connection, method, path, body, reason }, { team, project, agent }) =>
    team.remote.request(
      project,
      agent,
      { kind: "azure_devops_api", connectionId: String(connection), method: String(method), path: String(path), body },
      String(reason),
    ),
};

// ---- rules register (only when the project keeps one)

function registerOn(project: Project) {
  if (!project.rulesRegister) throw new Error("This project doesn't keep a rules register (the human can turn it on in the project's Settings).");
}

// ---- images

const readDocumentTool: Tool = {
  name: "read_document",
  description:
    "Read the text of a document: PDF (by pages), Word (.docx, .odt), Excel (.xlsx, every sheet as tab-separated rows), " +
    "PowerPoint (.pptx, by slide) or a long text file. Returns a part at a time and says how to get the next one. " +
    "Reading PDFs with the read tool is blocked (it would put the whole file in your conversation), and Office files are binary to it.",
  inputSchema: obj(
    {
      path: str("The document (absolute, or relative to your folder)"),
      pages: str('PDF pages to read, e.g. "1-10" or "7" (default: from the first page, as many as fit)'),
      from: { type: "integer", description: "For other documents: the character to start from (given in the previous answer)" },
    },
    ["path"],
  ),
  run: (args, { agent }) => readDocument(agent.directory, args),
};

const viewImageTool: Tool = {
  name: "view_image",
  description:
    "Look at an image (png, jpg, gif, webp, bmp): returns a scaled-down copy, so it doesn't bloat your conversation. " +
    "Reading image files directly is blocked: a full-size image stays in your conversation and is re-sent every turn. " +
    "For details, ask for a crop: a region of the original, in its pixels, shown at full resolution.",
  inputSchema: obj(
    {
      path: str("The image file (absolute, or relative to your folder)"),
      max_size: { type: "integer", description: `Longest side of the copy in pixels (default ${DEFAULT_IMAGE_SIZE}, at most 2048)` },
      crop: obj(
        { left: { type: "integer" }, top: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } },
        ["left", "top", "width", "height"],
      ),
    },
    ["path"],
  ),
  run: (args, { agent }) => viewImage(agent.directory, args),
};

const listRulesTool: Tool = {
  name: "list_rules",
  description: "The project's rules register: its areas, sources and rules (id, status, confirmation, text, sources). Filter to keep it short.",
  inputSchema: obj({
    query: str("Words to look for in the id, text, current state or citations"),
    area: str("Only this area (its prefix, e.g. 'AP')"),
    status: { type: "string", enum: [...STATUSES] },
  }),
  async run(args, { project }) {
    registerOn(project);
    return listRules(project, args);
  },
};

const saveRuleTool: Tool = {
  name: "save_rule",
  description:
    "Add a rule to the register, or update one (give its id; only the fields you pass change). A new rule gets the next id in its " +
    "area. State only what the sources say; if nothing backs it yet, add it without citations (it shows as unsourced) rather than " +
    "inventing a source. Citations quote the source literally.",
  inputSchema: obj(
    {
      id: str("To update an existing rule, e.g. 'AP-031'. Leave out to add a new one."),
      area: str("Area prefix (define areas with save_rule_area)"),
      stage: str("Stage id within the area (e.g. 'B')"),
      text: str("What the rule says (Markdown)"),
      action: str("What the work does about it, e.g. 'blocks submission', 'warning only', 'none'"),
      citations: {
        type: "array",
        description: "Where it comes from. Each: source code (define sources with save_rule_source), location (p.20, l.10…), literal excerpt.",
        items: obj({ source: str("Source code, e.g. 'MA'"), location: str("Where in the source"), excerpt: str("The source's words, copied literally") }, ["source"]),
      },
      imposed_by: str("Who imposes it (an authority code)"),
      confirmation: { type: "string", enum: [...CONFIRMATIONS], description: "found = extracted, nobody checked; checked-by-agent; checked-by-human; contested" },
      status: { type: "string", enum: [...STATUSES], description: "Is it met by the work today?" },
      current: str("How things are today, especially where they differ from the rule"),
      check: str("How to check that it's met"),
      superseded_by: str("Id of the rule that replaced this one (the old rule stays for the record)"),
    },
    [],
  ),
  async run(args, { project, agent }) {
    registerOn(project);
    return saveRule(project, args, agent.name);
  },
};

const saveRuleAreaTool: Tool = {
  name: "save_rule_area",
  description: "Define or update an area of the rules register (a part of the project with its own rule ids) and its stages, in order.",
  inputSchema: obj(
    {
      id: str("Short prefix for its rule ids, e.g. 'AP' → AP-001. Must differ from every source code."),
      name: str("Name, e.g. 'Student — Submission'"),
      group: str("Optional larger group it belongs to"),
      description: str("What it covers"),
      stages: { type: "array", items: obj({ id: str("e.g. 'A'"), name: str("e.g. 'Access'") }, ["name"]), description: "Its steps or sections, in order" },
    },
    ["id", "name"],
  ),
  async run(args, { project }) {
    registerOn(project);
    return saveArea(project, args as any);
  },
};

const saveRuleSourceTool: Tool = {
  name: "save_rule_source",
  description: "Define or update a source rules are cited from (a document, a meeting, a decision), with the file when there is one.",
  inputSchema: obj(
    {
      id: str("Short code used in citations, e.g. 'MA' or 'D38'. Must differ from every area prefix."),
      name: str("e.g. 'Student manual 2026'"),
      file: str("The file, relative to the project folder (so the human can open it at the cited place)"),
      authority: str("Code of who stands behind it, e.g. 'EC'"),
      authority_name: str("Name of that authority, the first time you use its code"),
    },
    ["id", "name"],
  ),
  async run(args, { project }) {
    registerOn(project);
    return saveSource(project, args as any);
  },
};

const COMMON = [
  viewImageTool,
  readDocumentTool,
  listRulesTool,
  saveRuleTool,
  saveRuleAreaTool,
  saveRuleSourceTool,
  listConnections,
  remoteExec,
  remoteUpload,
  gitPush,
  gitPull,
  githubApi,
  azureDevopsApi,
  sendMessage,
  askHuman,
  listTeam,
  listAssets,
  requestAsset,
  releaseAsset,
  checkMessages,
  listTasks,
  updateTask,
  listProcesses,
  stopProcess,
];
const subRepositories: Tool = {
  name: "sub_repositories",
  description:
    "For a project folder that is a git repository containing other repositories (often created on top of them by an older Symbio): " +
    "check the situation, switch to working in the inner repositories (use), or back to the outer one (stop). Switching changes nothing on disk.",
  inputSchema: obj({ action: { type: "string", enum: ["check", "use", "stop"], description: "check (default), use or stop" } }),
  async run({ action }, { team, project }) {
    if (action === "use" || action === "stop") return team.useSubRepositories(project, action === "use", "the coordinator");
    return describeOuterRepository(project);
  },
};

const COORDINATOR_ONLY = [
  subRepositories,
  submitPlan,
  addTask,
  assignTask,
  spawnAgent,
  stopAgent,
  mergeWork,
  cleanBuildOutputs,
  moveToProjectFolder,
  declareAsset,
  grantAsset,
  denyAsset,
];

function coordinatorOnly(tool: Tool): Tool {
  return {
    ...tool,
    run(args, ctx) {
      if (ctx.agent.role !== "coordinator") throw new Error("Only the coordinator can use this tool.");
      return tool.run(args, ctx);
    },
  };
}

/**
 * Messages that reached the agent while it is mid-turn would otherwise wait until
 * its turn ends; hand them over in the result of any Symbio tool call instead.
 */
function withInbox(tool: Tool): Tool {
  return {
    ...tool,
    async run(args, ctx) {
      let result: ToolResult;
      try {
        result = await tool.run(args, ctx);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }
      const arrived = await ctx.team.takeInbox(ctx.agent).catch(() => []);
      if (arrived.length === 0) {
        if (typeof result === "string" && result.startsWith("Error: ")) throw new Error(result.slice(7));
        return result;
      }
      const inbox = `📬 Messages that arrived while you were working (already delivered — they won't be repeated):\n\n${arrived.join("\n\n---\n\n")}`;
      if (typeof result !== "string") return { content: [...result.content, { type: "text", text: inbox }] };
      const header = tool === checkMessages ? "" : `${result}\n\n`;
      return `${header}${inbox}`;
    },
  };
}

export const workerTools: Tool[] = COMMON.map(withInbox);
export const coordinatorTools: Tool[] = [...COMMON, ...COORDINATOR_ONLY.map(coordinatorOnly)].map(withInbox);
