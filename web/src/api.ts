export type AgentStatus = "idle" | "busy" | "waiting" | "stuck" | "error" | "stopped";

export interface Agent {
  id: string;
  name: string;
  role: "coordinator" | "worker";
  purpose?: string;
  sessionId: string;
  directory: string;
  branch?: string | null;
  model: string;
  status: AgentStatus;
  problem?: string | null;
  usage?: { cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  lastActivity: number;
}

/** "12.3k" style token counts. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Tokens the model actually processed (cache reads are cheap and listed separately). */
export function usageTokens(u: NonNullable<Agent["usage"]>) {
  return u.input + u.output + u.reasoning + u.cacheWrite;
}

export interface Asset {
  name: string;
  description: string;
  paths: string[];
  holder: string | null;
  queue: { agentId: string; reason: string; time: number }[];
  history: { time: number; type: string; agentId?: string; note?: string }[];
}

interface ConnectionBase {
  id: string;
  name: string;
  lastTest: { ok: boolean; message: string; time: number } | null;
  secrets: Record<string, boolean>;
}

export type ConnectionView =
  | (ConnectionBase & { type: "github"; account: string | null })
  | (ConnectionBase & {
      type: "server";
      host: string;
      port: number;
      username: string;
      auth: "key" | "password";
      keyPath: string | null;
    });

export type TaskStatus = "todo" | "in-progress" | "blocked" | "review" | "done";

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  status: TaskStatus;
  dependsOn: string[];
  assets: string[];
  notes: { time: number; by: string; text: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface Plan {
  goal: string;
  status: "none" | "proposed" | "approved" | "changes-requested";
  revision: number;
  feedback: string | null;
  tasks: Task[];
  updatedAt: number;
}

export interface LoggedMessage {
  id: string;
  time: number;
  from: string;
  to: string;
  kind: string;
  text: string;
}

export type DocsLocation = "project" | "private";

export interface ProjectConnection {
  id: string;
  policy: "ask" | "allow";
}

export interface PermissionRequest {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  resources: string[];
  save: string[];
  time: number;
}

export interface Approval {
  id: string;
  agentId: string;
  agentName: string;
  connectionName: string;
  action: { kind: string; [k: string]: unknown };
  summary: string;
  reason: string;
  status: "pending" | "approved" | "denied";
  note: string | null;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  directory: string;
  allowedModels: string[];
  coordinatorModel: string;
  docsLocation: DocsLocation;
  origin: "new" | "existing";
  connections: ProjectConnection[];
  allowedPatterns: { action: string; pattern: string }[];
  paused?: boolean;
  heldMessages?: { agentId: string; text: string }[];
  agents: Agent[];
  createdAt: number;
}

export interface Inspection {
  directory: string;
  exists: boolean;
  empty: boolean;
  isGit: boolean;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
  kinds: Record<string, number>;
  topExtensions: { ext: string; count: number }[];
  topLevel: string[];
  guidance: string[];
  gitAvailable: boolean;
  existingProject: { id: string; name: string } | null;
}

export interface DocFile {
  path: string;
  size: number;
  modified: number;
}

export interface ModelInfo {
  ref: string;
  providerID: string;
  id: string;
  name: string;
  vision: boolean;
  free: boolean;
}

export interface RuntimeInfo {
  state: "stopped" | "starting" | "running" | "crashed";
  version: string | null;
  error: string | null;
  memoryMB?: number | null;
}

export type UiEvent =
  | ({ type: "runtime" } & RuntimeInfo)
  | { type: "project.updated"; projectId: string }
  | { type: "assets.updated"; projectId: string }
  | { type: "plan.updated"; projectId: string }
  | { type: "approvals.updated"; projectId: string }
  | { type: "agent.status"; projectId: string; agentId: string; status: AgentStatus }
  | { type: "agent.stream"; projectId: string; agentId: string; event: { type: string; data: any } }
  | { type: "message"; projectId: string; message: LoggedMessage };

export interface ProviderFormField {
  key: string;
  title: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  pattern?: string;
  default?: string;
  hidden?: boolean;
  options?: { value: string; label: string; description?: string }[];
  when?: { key: string; op: string; value: string }[];
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  methods: { type: "key" | "oauth"; id?: string; label: string; form: ProviderFormField[] }[];
  other: string[];
}

export interface ConnectedProvider {
  id: string;
  name: string;
  models: number;
  logins: { id: string; label: string; method: string }[];
  source: "login" | "config" | "environment" | "other";
  usedBy: string[];
}

export interface OauthAttempt {
  attemptID: string;
  url: string;
  instructions: string;
  mode: "auto" | "code";
}

// The server's API key arrives once in the link Symbio opens (?token=…); keep it and
// take it out of the address bar so it isn't bookmarked or shared by accident.
const TOKEN_KEY = "symbio:token";
const token = (() => {
  const url = new URL(location.href);
  const fromLink = url.searchParams.get("token");
  if (fromLink) {
    localStorage.setItem(TOKEN_KEY, fromLink);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  return localStorage.getItem(TOKEN_KEY) ?? "";
})();

/** Fired when the server rejects our key; the app shows how to get back in. */
export const LOCKED_EVENT = "symbio:locked";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-symbio-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === "locked") dispatchEvent(new Event(LOCKED_EVENT));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const api = {
  runtime: () => call<RuntimeInfo>("GET", "/runtime"),
  models: () => call<ModelInfo[]>("GET", "/models"),
  projects: () => call<Project[]>("GET", "/projects"),
  project: (id: string) => call<Project>("GET", `/projects/${id}`),
  inspect: (dir: string) => call<Inspection>("GET", `/inspect?dir=${encodeURIComponent(dir)}`),
  pickFolder: (initial?: string) => call<{ path: string | null }>("POST", "/pick-folder", { initial }),
  providers: () => call<{ connected: ConnectedProvider[]; catalog: ProviderCatalogEntry[] }>("GET", "/providers"),
  connectProviderKey: (id: string, key: string, answer: Record<string, string>) =>
    call<{ ok: true }>("POST", `/providers/${encodeURIComponent(id)}/key`, { key, answer }),
  beginProviderOauth: (id: string, methodID: string, answer: Record<string, string>) =>
    call<OauthAttempt>("POST", `/providers/${encodeURIComponent(id)}/oauth`, { methodID, answer }),
  providerOauthStatus: (id: string, attemptId: string) =>
    call<{ status: "pending" | "complete" | "failed" | "expired"; message?: string }>(
      "GET",
      `/providers/${encodeURIComponent(id)}/oauth/${encodeURIComponent(attemptId)}`,
    ),
  completeProviderOauth: (id: string, attemptId: string, code: string) =>
    call<{ ok: true }>("POST", `/providers/${encodeURIComponent(id)}/oauth/${encodeURIComponent(attemptId)}/complete`, { code }),
  cancelProviderOauth: (id: string, attemptId: string) =>
    call<{ ok: true }>("DELETE", `/providers/${encodeURIComponent(id)}/oauth/${encodeURIComponent(attemptId)}`),
  removeProviderLogin: (loginId: string) => call<{ ok: true }>("DELETE", `/providers/logins/${encodeURIComponent(loginId)}`),
  createProject: (input: {
    name: string;
    directory: string;
    allowedModels: string[];
    coordinatorModel: string;
    docsLocation: DocsLocation;
    initGit: boolean;
    connections: ProjectConnection[];
  }) => call<Project>("POST", "/projects", input),
  permissions: (projectId: string) => call<PermissionRequest[]>("GET", `/projects/${projectId}/permissions`),
  answerPermission: (projectId: string, requestId: string, decision: "once" | "always" | "reject", note?: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/permissions/${requestId}`, { decision, note }),
  approvals: (projectId: string) => call<Approval[]>("GET", `/projects/${projectId}/approvals`),
  decideApproval: (projectId: string, approvalId: string, approved: boolean, note?: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/approvals/${approvalId}`, { approved, note }),
  docs: (id: string) => call<{ location: DocsLocation; root: string; files: DocFile[] }>("GET", `/projects/${id}/docs`),
  readDoc: (id: string, path: string) =>
    call<{ path: string; content: string }>("GET", `/projects/${id}/docs/file?path=${encodeURIComponent(path)}`),
  writeDoc: (id: string, path: string, content: string) =>
    call<{ ok: true }>("PUT", `/projects/${id}/docs/file`, { path, content }),
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "allowedModels" | "coordinatorModel" | "connections" | "allowedPatterns">>) =>
    call<Project>("PATCH", `/projects/${id}`, patch),
  connections: () => call<ConnectionView[]>("GET", "/connections"),
  createConnection: (body: Record<string, unknown>) => call<ConnectionView>("POST", "/connections", body),
  updateConnection: (id: string, body: Record<string, unknown>) => call<ConnectionView>("PATCH", `/connections/${id}`, body),
  deleteConnection: (id: string) => call<{ ok: true }>("DELETE", `/connections/${id}`),
  testConnection: (id: string) => call<{ ok: boolean; message: string }>("POST", `/connections/${id}/test`),
  deleteProject: (id: string, deleteData: boolean) =>
    call<{ ok: true }>("DELETE", `/projects/${id}?deleteData=${deleteData}`),
  start: (id: string) => call<{ project: Project; coordinator: Agent }>("POST", `/projects/${id}/start`),
  history: (projectId: string, agentId: string) => call<any[]>("GET", `/projects/${projectId}/agents/${agentId}/history`),
  send: (projectId: string, agentId: string, text: string, urgent = false) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/agents/${agentId}/messages`, { text, urgent }),
  interrupt: (projectId: string, agentId: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/agents/${agentId}/interrupt`),
  setAgentModel: (projectId: string, agentId: string, model: string) =>
    call<Project>("POST", `/projects/${projectId}/agents/${agentId}/model`, { model }),
  restartAgent: (projectId: string, agentId: string) => call<Project>("POST", `/projects/${projectId}/agents/${agentId}/restart`),
  stopAgent: (projectId: string, agentId: string) =>
    call<{ result: string }>("POST", `/projects/${projectId}/agents/${agentId}/stop`),
  forms: (projectId: string, agentId: string) => call<unknown[]>("GET", `/projects/${projectId}/agents/${agentId}/forms`),
  answerForm: (projectId: string, agentId: string, formId: string, answer: Record<string, unknown>, summary: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/agents/${agentId}/forms/${formId}`, { answer, summary }),
  log: (projectId: string) => call<LoggedMessage[]>("GET", `/projects/${projectId}/log`),
  assets: (projectId: string) => call<Asset[]>("GET", `/projects/${projectId}/assets`),
  retryModels: (projectId: string) => call<{ resumed: string[] }>("POST", `/projects/${projectId}/retry-models`),
  pauseTeam: (projectId: string) => call<Project>("POST", `/projects/${projectId}/pause`),
  resumeTeam: (projectId: string) => call<Project>("POST", `/projects/${projectId}/resume`),
  pauseAll: () => call<{ paused: string[] }>("POST", "/pause-all"),
  plan: (projectId: string) => call<Plan>("GET", `/projects/${projectId}/plan`),
  decidePlan: (projectId: string, approved: boolean, feedback?: string) =>
    call<Plan>("POST", `/projects/${projectId}/plan/decision`, { approved, feedback }),
};

type Listener = (e: UiEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

/** One shared SSE connection for the whole app; EventSource reconnects on its own. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) {
    source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (msg) => {
      if (!msg.data) return;
      const event = JSON.parse(msg.data) as UiEvent;
      for (const l of listeners) l(event);
    };
  }
  return () => listeners.delete(listener);
}
