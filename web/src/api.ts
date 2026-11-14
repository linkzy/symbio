export type AgentStatus = "idle" | "busy" | "waiting" | "stuck" | "error" | "stopped";

export interface Agent {
  id: string;
  name: string;
  role: "coordinator" | "worker";
  purpose?: string;
  sessionId: string;
  directory: string;
  /** Its repository, in a project made of several. */
  repo?: string;
  branch?: string | null;
  model: string;
  status: AgentStatus;
  problem?: string | null;
  usage?: { cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  /** Sessions used before the agent got a fresh one, oldest first. */
  previousSessions?: { sessionId: string; endedAt: number }[];
  aliases?: string[];
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
  return u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite;
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
  | (ConnectionBase & { type: "azure"; organization: string; account: string | null })
  | (ConnectionBase & {
      type: "server";
      host: string;
      port: number;
      username: string;
      auth: "key" | "password";
      keyPath: string | null;
    })
  | (ConnectionBase & {
      type: "ftp";
      host: string;
      port: number;
      username: string;
      security: FtpSecurity;
      acceptAnyCertificate: boolean;
    });

/** "explicit": FTPS via AUTH TLS (the usual), "implicit": FTPS from the start (port 990), "none": plain FTP. */
export type FtpSecurity = "explicit" | "implicit" | "none";

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
  /** How the human checks the work, from its helper's review report. */
  guide?: string;
  review?: boolean;
  humanReview?: { state: "waiting" | "approved" | "sent-back"; at: number; note?: string };
  createdAt: number;
  updatedAt: number;
}

/** One file a task changed, with its unified diff. */
/** A question the team has for the human (Needs you), open until answered or set aside. */
export interface Question {
  id: string;
  question: string;
  context?: string;
  options?: string[];
  taskId?: string;
  blocking: boolean;
  askedBy: string;
  askedAt: number;
  state: "open" | "answered" | "set-aside";
  answer?: string;
  answeredIn?: "human" | "chat";
  closedAt?: number;
}

export interface TaskChange {
  file: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch: string;
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

export type CoreMode = "auto" | "plan" | "act";

export interface Project {
  id: string;
  name: string;
  directory: string;
  allowedModels: string[];
  coordinatorModel: string;
  /** Models core may use (unset: all allowed) and models only core may use (store.ts modelsFor). */
  coreModels?: string[];
  coreOnlyModels?: string[];
  docsLocation: DocsLocation;
  origin: "new" | "existing";
  connections: ProjectConnection[];
  allowedPatterns: { action: string; pattern: string }[];
  paused?: boolean;
  /** Conversational messages two agents may exchange in 30 minutes; 0 = no limit; unset = default (20). */
  messageLimit?: number;
  renewSessions?: "manual" | "after-task";
  helperWorkspace?: "own" | "shared";
  rulesRegister?: boolean;
  subRepositories?: boolean;
  /** How core handles the human's messages (the selector in its chat box). Unset = auto. */
  coreMode?: CoreMode;
  /** Who reviews the team's work: core (unset), the human for every task, or for the tasks marked in the plan. */
  reviewBy?: "core" | "every" | "marked";
  heldMessages?: { agentId: string; text: string }[];
  agents: Agent[];
  createdAt: number;
}

export interface Inspection {
  directory: string;
  exists: boolean;
  empty: boolean;
  isGit: boolean;
  repos: string[];
  swallowed?: { inner: string[]; createdBySymbio: boolean };
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

export type RuleStatus = "done" | "partial" | "missing" | "not-applicable";
export type RuleConfirmation = "found" | "checked-by-agent" | "checked-by-human" | "contested";

export interface Rule {
  id: string;
  area: string;
  stage?: string;
  text: string;
  action?: string;
  citations: { source: string; location?: string; excerpt?: string }[];
  imposedBy?: string;
  confirmation: RuleConfirmation;
  status: RuleStatus;
  current?: string;
  check?: string;
  supersededBy?: string;
  updatedAt: number;
  updatedBy?: string;
}

export interface RulesRegister {
  enabled: boolean;
  areas: { id: string; name: string; group?: string; description?: string; stages: { id: string; name: string }[] }[];
  sources: { id: string; name: string; file?: string; authority?: string }[];
  authorities: { id: string; name: string }[];
  rules: Rule[];
}

export interface DocMatch {
  path: string;
  line: number;
  text: string;
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
  | { type: "prices.updated" }
  | { type: "remote.updated" }
  | { type: "attachments.updated"; projectId: string }
  | { type: "assets.updated"; projectId: string }
  | { type: "plan.updated"; projectId: string }
  | { type: "approvals.updated"; projectId: string }
  | { type: "questions.updated"; projectId: string }
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

/**
 * Opens a file from the project docs (a PDF a rule cites, an image) in a new tab, at a page for
 * PDFs; types a browser can't show are downloaded. Fetched with the key, so it never sits in a URL.
 */
/** A file in the project folder or a helper's copy, as the server found it (files.ts). */
export interface ProjectFile {
  path: string;
  found: boolean;
  rel?: string;
  /** "project", or the helper whose copy it's in. */
  where?: string;
  agentId?: string | null;
  kind?: "markdown" | "text" | "image" | "video" | "audio" | "pdf" | "other";
  size?: number;
  refused?: string;
}

export interface SharedFile {
  id: string;
  rel: string;
  where: string;
  agentId: string;
  caption?: string;
  kind: NonNullable<ProjectFile["kind"]>;
  size: number;
  at: number;
  available: boolean;
}

const fileQuery = (rel: string, agentId?: string | null) => `path=${encodeURIComponent(rel)}${agentId ? `&agent=${encodeURIComponent(agentId)}` : ""}`;
export const projectFileUrl = (projectId: string, rel: string, agentId?: string | null) => `/api/projects/${projectId}/files/raw?${fileQuery(rel, agentId)}`;

/** Opens a project file: shown in a new tab when the browser can, else downloaded (fetched with the key). */
export function openProjectFile(projectId: string, f: { rel: string; agentId?: string | null }, download = false) {
  openFile(projectFileUrl(projectId, f.rel, f.agentId) + (download ? "&download=1" : ""), f.rel.split("/").pop() ?? "file", { download });
}

// Previews (images, video, audio): fetched once with the key, then shown from memory.
const fileBlobs = new Map<string, Promise<string>>();
export function projectFileBlob(projectId: string, rel: string, agentId?: string | null): Promise<string> {
  const url = projectFileUrl(projectId, rel, agentId);
  let p = fileBlobs.get(url);
  if (!p) {
    p = fetch(url, { headers: { "x-symbio-token": token } }).then(async (res) => {
      if (!res.ok) throw new Error(res.statusText);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => fileBlobs.delete(url));
    fileBlobs.set(url, p);
  }
  return p;
}

export function openDocFile(projectId: string, path: string, page?: number) {
  openFile(`/api/projects/${projectId}/docs/raw?path=${encodeURIComponent(path)}`, path.split("/").pop() ?? "file", { page });
}

/** Opens a file Symbio serves (shown in a new tab when the browser can, else downloaded), fetched with the key. */
function openFile(url: string, name: string, opts: { page?: number; download?: boolean } = {}) {
  // Open the tab now, while the click still counts: after the download, a popup would be blocked.
  const win = opts.download ? null : window.open("", "_blank");
  fetch(url, { headers: { "x-symbio-token": token } })
    .then(async (res) => {
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText);
      const inline = (res.headers.get("content-disposition") ?? "").startsWith("inline");
      const blobUrl = URL.createObjectURL(await res.blob());
      if (inline && win) {
        win.location.href = blobUrl + (opts.page ? `#page=${opts.page}` : "");
        return;
      }
      win?.close();
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    })
    .catch((err) => {
      win?.close();
      alert(`Couldn't open ${name}: ${(err as Error).message}`);
    });
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  addedAt: number;
  sentTo: { agentId: string; at: number }[];
}

export const attachmentUrl = (projectId: string, id: string) => `/api/projects/${projectId}/attachments/${id}/file`;

export function openAttachment(projectId: string, a: { id: string; name: string }, download = false) {
  openFile(attachmentUrl(projectId, a.id), a.name, { download });
}

// Thumbnails: the file fetched once with the key, then shown from memory.
const thumbs = new Map<string, Promise<string>>();
export function attachmentBlob(projectId: string, id: string): Promise<string> {
  let p = thumbs.get(id);
  if (!p) {
    p = fetch(attachmentUrl(projectId, id), { headers: { "x-symbio-token": token } }).then(async (res) => {
      if (!res.ok) throw new Error(res.statusText);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => thumbs.delete(id));
    thumbs.set(id, p);
  }
  return p;
}

/** Uploads files to the project's gallery, reporting progress (0–1). */
export function uploadAttachments(projectId: string, files: File[], onProgress?: (fraction: number) => void): Promise<Attachment[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name || "pasted.png");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${projectId}/attachments`);
    xhr.setRequestHeader("x-symbio-token", token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      const data = (() => {
        try {
          return JSON.parse(xhr.responseText);
        } catch {
          return {};
        }
      })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment[]);
      else reject(new Error(data.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed (connection)"));
    xhr.send(form);
  });
}

/** Fired when the server rejects our key; the app shows how to get back in. */
export const LOCKED_EVENT = "symbio:locked";

export interface Usage {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceInfo = { price: Price | null; source: "yours" | "opencode" | "suggested" | "none"; from?: string };

export type UpdateMode = "auto" | "notify" | "off";

export interface UpdateState {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: number | null;
  error: string | null;
  mode: UpdateMode;
  install: "npm" | "dev";
  busy: string | null;
  waiting: string | null;
  notes: { version: string; items: string[] }[];
  lastResult: { from: string; to: string; ok: boolean; error: string | null; finishedAt: number } | null;
}

export interface RemoteStatus {
  active: boolean;
  url: string | null;
  startedAt: number | null;
  sessions: number;
  /** Only present on this computer, never through the tunnel. */
  code?: string | null;
  lastStop?: { at: number; reason: string } | null;
}

export interface HousekeepingReport {
  checkedAt: number;
  remote: string | null;
  unpushed: { branch: string; commits: number; latest: string }[];
  folders: { agentId: string; name: string; status: string; bytes: number; buildBytes: number }[];
  lastBackup: string | null;
}

export interface ProjectUsage {
  agents: { id: string; name: string; status: string; sessions: number; tokens: number; cost: number; byModel: { model: string; usage: Usage; tokens: number; cost: number | null }[] }[];
  total: Usage;
  tokens: number;
  cost: number;
  unpriced: string[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-symbio-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === "locked") dispatchEvent(new Event(LOCKED_EVENT));
  // Through remote access, without a session (or after it ended): back to the code page.
  if (res.status === 401 && data.code === "remote-login") location.href = "/remote-login";
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
  makeDir: (parent: string, name: string) => call<{ path: string }>("POST", "/fs/mkdir", { parent, name }),
  listDirs: (path?: string) =>
    call<{ path: string; parent: string | null; dirs: string[]; roots: string[]; home: string; sep: string }>(
      "GET",
      `/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
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
    rulesRegister?: boolean;
  }) => call<Project>("POST", "/projects", input),
  permissions: (projectId: string) => call<PermissionRequest[]>("GET", `/projects/${projectId}/permissions`),
  answerPermission: (projectId: string, requestId: string, decision: "once" | "always" | "reject", note?: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/permissions/${requestId}`, { decision, note }),
  approvals: (projectId: string) => call<Approval[]>("GET", `/projects/${projectId}/approvals`),
  decideApproval: (projectId: string, approvalId: string, approved: boolean, note?: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/approvals/${approvalId}`, { approved, note }),
  rules: (id: string) => call<RulesRegister>("GET", `/projects/${id}/rules`),
  searchDocs: (id: string, q: string) =>
    call<{ matches: DocMatch[]; truncated: boolean }>("GET", `/projects/${id}/docs/search?q=${encodeURIComponent(q)}`),
  docs: (id: string) => call<{ location: DocsLocation; root: string; files: DocFile[] }>("GET", `/projects/${id}/docs`),
  readDoc: (id: string, path: string) =>
    call<{ path: string; content: string }>("GET", `/projects/${id}/docs/file?path=${encodeURIComponent(path)}`),
  writeDoc: (id: string, path: string, content: string) =>
    call<{ ok: true }>("PUT", `/projects/${id}/docs/file`, { path, content }),
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "allowedModels" | "coordinatorModel" | "connections" | "allowedPatterns" | "messageLimit" | "renewSessions" | "helperWorkspace" | "rulesRegister" | "subRepositories" | "coreMode" | "reviewBy">>) =>
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
  projectUsage: (projectId: string) => call<ProjectUsage>("GET", `/projects/${projectId}/usage`),
  prices: () => call<Record<string, PriceInfo>>("GET", "/prices"),
  usageAverage: () =>
    call<{
      perDay: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
      byRole?: Record<"core" | "helpers", { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }>;
      projects: { name: string; days: number; tokensPerDay: number }[];
    }>("GET", "/usage/average"),
  update: () => call<UpdateState>("GET", "/update"),
  checkUpdate: () => call<UpdateState>("POST", "/update/check"),
  setUpdateMode: (mode: UpdateMode) => call<UpdateState>("PUT", "/update/settings", { mode }),
  applyUpdate: () => call<{ message: string }>("POST", "/update/apply", { force: true }),
  remote: () => call<RemoteStatus>("GET", "/remote"),
  startRemote: () => call<RemoteStatus>("POST", "/remote/start"),
  stopRemote: () => call<RemoteStatus>("POST", "/remote/stop"),
  housekeeping: (projectId: string) => call<HousekeepingReport>("GET", `/projects/${projectId}/housekeeping`),
  checkHousekeeping: (projectId: string) => call<HousekeepingReport>("POST", `/projects/${projectId}/housekeeping/check`),
  cleanHelper: (projectId: string, agentId: string) => call<{ result: string }>("POST", `/projects/${projectId}/agents/${agentId}/clean`),
  setPrice: (model: string, price: Price | null) => call<{ ok: true }>("PUT", "/prices", { model, price }),
  historyPage: (projectId: string, agentId: string, limit: number, before?: string, session?: string) =>
    call<{ messages: any[]; hasMore: boolean }>(
      "GET",
      `/projects/${projectId}/agents/${agentId}/history?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}${session ? `&session=${encodeURIComponent(session)}` : ""}`,
    ),
  renewSession: (projectId: string, agentId: string) => call<Project>("POST", `/projects/${projectId}/agents/${agentId}/renew`),
  send: (projectId: string, agentId: string, text: string, urgent = false, attachments: string[] = []) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/agents/${agentId}/messages`, { text, urgent, attachments }),
  attachments: (projectId: string) => call<Attachment[]>("GET", `/projects/${projectId}/attachments`),
  deleteAttachment: (projectId: string, id: string) => call<{ ok: true }>("DELETE", `/projects/${projectId}/attachments/${id}`),
  interrupt: (projectId: string, agentId: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/agents/${agentId}/interrupt`),
  renameAgent: (projectId: string, agentId: string, name: string) =>
    call<Project>("POST", `/projects/${projectId}/agents/${agentId}/rename`, { name }),
  setAgentModel: (projectId: string, agentId: string, model: string) =>
    call<Project>("POST", `/projects/${projectId}/agents/${agentId}/model`, { model }),
  restartAgent: (projectId: string, agentId: string) => call<Project>("POST", `/projects/${projectId}/agents/${agentId}/restart`),
  moveToProjectFolder: (projectId: string, agentId: string) =>
    call<Project>("POST", `/projects/${projectId}/agents/${agentId}/move-to-project-folder`),
  createHelper: (projectId: string, body: { name: string; purpose?: string; model?: string; workspace?: "shared" | "own" }) =>
    call<Agent>("POST", `/projects/${projectId}/agents`, body),
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
  taskChanges: (projectId: string, taskId: string) => call<{ files: TaskChange[]; note?: string }>("GET", `/projects/${projectId}/plan/tasks/${taskId}/changes`),
  resolveFiles: (projectId: string, paths: string[], agentId?: string | null) =>
    call<ProjectFile[]>("POST", `/projects/${projectId}/files/resolve`, { paths, agentId: agentId ?? undefined }),
  fileText: (projectId: string, rel: string, agentId?: string | null) =>
    call<{ rel: string; where: string; agentId: string | null; kind: string; size: number; content: string }>("GET", `/projects/${projectId}/files/text?${fileQuery(rel, agentId)}`),
  sharedFiles: (projectId: string) => call<SharedFile[]>("GET", `/projects/${projectId}/shared-files`),
  questions: (projectId: string) => call<Question[]>("GET", `/projects/${projectId}/questions`),
  answerQuestions: (projectId: string, answers: { id: string; answer: string; attachments?: string[] }[]) =>
    call<Question[]>("POST", `/projects/${projectId}/questions/answers`, { answers }),
  setAsideQuestion: (projectId: string, id: string, note?: string) => call<Question[]>("POST", `/projects/${projectId}/questions/${id}/set-aside`, { note }),
  markTask: (projectId: string, taskId: string, review: boolean) => call<Plan>("POST", `/projects/${projectId}/plan/tasks/${taskId}/mark`, { review }),
  reviewTask: (projectId: string, taskId: string, decision: "approve" | "send-back", note?: string, attachments?: string[]) =>
    call<Plan>("POST", `/projects/${projectId}/plan/tasks/${taskId}/review`, { decision, note, attachments }),
  decidePlan: (projectId: string, approved: boolean, feedback?: string) =>
    call<Plan>("POST", `/projects/${projectId}/plan/decision`, { approved, feedback }),
};

type Listener = (e: UiEvent) => void;
const listeners = new Set<Listener>();
let started = false;
const dispatch = (event: UiEvent) => {
  for (const l of listeners) l(event);
};

/**
 * One shared event connection for the whole app. Server-Sent Events first (EventSource
 * reconnects on its own); the server sends an event as soon as the stream opens, so if
 * nothing arrives within a few seconds the stream is being held up by something in between
 * (Cloudflare quick tunnels, for remote access, don't pass SSE) and we poll instead.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    let alive = false;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (msg) => {
      alive = true;
      if (msg.data) dispatch(JSON.parse(msg.data) as UiEvent);
    };
    source.addEventListener("ping", () => (alive = true));
    setTimeout(() => {
      if (alive) return;
      source.close();
      void poll();
    }, 6000);
  }
  return () => listeners.delete(listener);
}

async function poll() {
  let after: number | null = null;
  for (;;) {
    try {
      const path: string = after === null ? "/events/poll" : `/events/poll?after=${after}`;
      const r: { seq: number; events: UiEvent[]; gap: boolean } = await call("GET", path);
      if (r.gap) location.reload(); // missed too much to patch up
      after = r.seq;
      r.events.forEach(dispatch);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
