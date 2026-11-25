// GitHub Copilot CLI as an agent runtime, driven through the Copilot SDK (docs/copilot-api.md).
//
// One Copilot runtime process (started by the SDK over stdio) holds every session. Unlike
// OpenCode, Copilot leaves tool permissions to its host, so Symbio's rules (guard.ts) are applied
// here; it has no "note without a turn", so notes wait for the agent's next prompt; and it speaks
// its own event vocabulary, translated here into the one the team and the chat use
// (runtime/types.ts).

import { lowerPriority } from "../machine.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyUsage, type Usage } from "../costs.js";
import { evaluate, type PermissionRule } from "../guard.js";
import { processTreeMemory } from "../opencode/runtime.js";
import { knownSkillNames, skillRoots } from "../skills.js";
import { importRuntime, NotInstalledError } from "../runtime/install.js";
import type {
  AgentRuntime,
  BackgroundShell,
  ChildSession,
  FileChange,
  NewSession,
  RuntimeEvent,
  RuntimeEvents,
  RuntimeModel,
  RuntimeState,
} from "../runtime/types.js";

/** Models are stored as "<provider>/<id>"; Copilot's own ids have no provider. */
export const COPILOT_PROVIDER = "copilot";
const NOT_SIGNED_IN = "Not signed in to GitHub Copilot. Sign in from Settings → Agent runtimes.";

/** A device code to enter on GitHub while signing in. */
export interface SignInCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}
const NOTES_OPEN = "<symbio-notes>";
/** Copilot's file-reading tools, and where their path is (`toolArgs.path`, verified for `view`). */
const READ_TOOLS = new Set(["view", "read", "read_file"]);
const NOTES_CLOSE = "</symbio-notes>";

// What Symbio uses of the SDK, so tests can stand in for it.
export interface SdkSession {
  readonly sessionId: string;
  send(options: { prompt: string; mode?: "enqueue" | "immediate" }): Promise<string>;
  abort(): Promise<void>;
  setModel(model: string, options?: { reasoningEffort?: string }): Promise<unknown>;
  getEvents(): Promise<any[]>;
  on(handler: (event: any) => void): () => void;
  disconnect(): Promise<void>;
  readonly rpc: any;
}

export interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getStatus(): Promise<{ version?: string }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }>;
  listModels(): Promise<any[]>;
  createSession(config: any): Promise<SdkSession>;
  resumeSession(sessionId: string, config: any): Promise<SdkSession>;
  deleteSession(sessionId: string): Promise<void>;
  getSessionMetadata(sessionId: string): Promise<any>;
}

export type SdkClientFactory = (options: { baseDirectory: string }) => Promise<SdkClient>;

/**
 * The SDK where it's installed (runtime/install.ts), or a stand-in module named by
 * SYMBIO_COPILOT_SDK (the end-to-end tests' tests/e2e/fake-copilot.mjs) exporting \`createClient(options)\`.
 */
const defaultFactory: SdkClientFactory = async (options) => {
  const sdk = await importRuntime("copilot");
  if (typeof sdk.createClient === "function") return sdk.createClient(options);
  const CopilotClient = sdk.CopilotClient ?? sdk.default?.CopilotClient;
  return new CopilotClient({ baseDirectory: options.baseDirectory, logLevel: "error" }) as SdkClient;
};

/** What Symbio knows about a session: enough to open it again (after a restart, or with new instructions). */
interface SessionState {
  directory: string | null;
  permissions: PermissionRule[];
  instructions: Map<string, string>;
  /** The skills it may use (unset: whatever Copilot finds). */
  skills?: string[];
  /** Instructions or tools changed since the session was opened: reopen it before its next turn. */
  stale: boolean;
  notes: string[];
  busy: boolean;
  turnError: { type: string; message: string; status?: number } | null;
  /** Prompts sent and not yet in the conversation, for taking them back (or sending them again). */
  queued: Map<string, { prompt: string; text: string; notes: string[] }>;
  usage: Usage;
  /**
   * While a prompt is being sent, the session's events wait: a quick turn can end before `send`
   * returns, and the caller marks the agent busy when it does (it would then stay busy).
   */
  sending: number;
  held: any[];
}

interface OpenQuestion {
  sessionId: string;
  form: { id: string; title: string; fields: any[] };
  choices: string[];
  resolve: (answer: { answer: string; wasFreeform: boolean }) => void;
}

interface OpenPermission {
  sessionId: string;
  resolve: (result: any) => void;
}

export class CopilotRuntime extends EventEmitter<RuntimeEvents> implements AgentRuntime {
  readonly kind = "copilot";
  readonly label = "GitHub Copilot CLI";
  commitCoauthors?: (directory: string) => boolean;
  state: RuntimeState = "stopped";
  version: string | null = null;
  lastError: string | null = null;
  restarts = 0;
  lastMemory: number | null = null;
  /** The GitHub login the runtime uses, when signed in. */
  login: string | null = null;

  private client: SdkClient | null = null;
  private open = new Map<string, { session: SdkSession; off: () => void }>();
  private opening = new Map<string, Promise<SdkSession>>();
  private sessions = new Map<string, SessionState>();
  private toolsByFolder = new Map<string, string>();
  private questions = new Map<string, OpenQuestion>();
  private permissionRequests = new Map<string, OpenPermission>();
  /** Tool calls whose read the pre-tool hook already let through. */
  private readsDecided = new Set<string>();
  /** A GitHub sign-in in progress (device code), and the scratch session it runs in. */
  private signIn: { session: SdkSession; flowId: string; code: SignInCode } | null = null;
  /** How the last sign-in ended, when it didn't work. */
  signInError: string | null = null;

  /**
   * @param home Copilot's data folder for Symbio's sessions (COPILOT_HOME), kept apart from the
   *   user's own Copilot history; the user's GitHub login is reused (see seedLogin).
   */
  constructor(
    private readonly home: string,
    private readonly factory: SdkClientFactory = defaultFactory,
  ) {
    super();
  }

  // ---------------------------------------------------------------- process

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return;
    this.setState("starting");
    try {
      mkdirSync(this.home, { recursive: true });
      seedLogin(this.home);
      const client = await this.factory({ baseDirectory: this.home });
      await client.start();
      this.watchExit(client);
      this.version = (await client.getStatus().catch(() => ({}) as { version?: string })).version ?? null;
      this.client = client;
      await this.checkLogin();
      this.setState("running");
      // Agents' commands run under it: at low priority, the computer stays usable (machine.ts).
      void lowerPriority(this.pid);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setState(err instanceof NotInstalledError ? "stopped" : "crashed");
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.cancelSignIn();
    const client = this.client;
    this.client = null;
    for (const { off, session } of this.open.values()) {
      off();
      await session.disconnect().catch(() => {});
    }
    this.open.clear();
    this.opening.clear();
    // Waiting permission requests and questions die with the process.
    for (const p of this.permissionRequests.values()) p.resolve({ kind: "user-not-available" });
    this.permissionRequests.clear();
    for (const q of this.questions.values()) q.resolve({ answer: "", wasFreeform: true });
    this.questions.clear();
    for (const s of this.sessions.values()) s.busy = false;
    if (client) await client.stop().catch(() => {});
    this.setState("stopped");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.restarts++;
    this.emit("restarted");
  }

  private recentCrashes: number[] = [];

  /**
   * If the runtime process dies on its own, sessions are gone from memory: mark it crashed (the team
   * marks its agents interrupted) and start it again, backing off if it keeps dying, like OpenCode's.
   */
  private watchExit(client: SdkClient) {
    const exited: Promise<unknown> | undefined = (client as any).processExitPromise;
    if (!exited?.then) return;
    void exited.then(
      () => this.onExit(client),
      () => this.onExit(client),
    );
  }

  private onExit(client: SdkClient) {
    if (this.client !== client || this.state !== "running") return; // stopped on purpose
    this.client = null;
    this.open.clear();
    this.opening.clear();
    for (const p of this.permissionRequests.values()) p.resolve({ kind: "user-not-available" });
    this.permissionRequests.clear();
    for (const q of this.questions.values()) q.resolve({ answer: "", wasFreeform: true });
    this.questions.clear();
    for (const s of this.sessions.values()) s.busy = false;
    this.signIn = null;
    this.lastError = "The GitHub Copilot CLI runtime exited.";
    console.error(`[copilot] ${this.lastError}`);
    this.setState("crashed");
    const now = Date.now();
    this.recentCrashes = [...this.recentCrashes.filter((t) => now - t < 5 * 60_000), now];
    if (this.recentCrashes.length > 5) return;
    setTimeout(() => {
      if (this.state !== "crashed") return;
      this.start()
        .then(() => {
          this.restarts++;
          this.emit("restarted");
        })
        .catch((err) => console.error("[copilot] restart failed:", err.message));
    }, 1000 * 2 ** (this.recentCrashes.length - 1));
  }

  /** The runtime process the SDK started (`cliProcess`: not public API, so it may go away; then null). */
  get pid(): number | null {
    const pid = (this.client as any)?.cliProcess?.pid;
    return typeof pid === "number" ? pid : null;
  }

  async memoryUsage(): Promise<number | null> {
    const pid = this.pid;
    if (!pid) return null;
    const bytes = await processTreeMemory(pid);
    if (bytes !== null) this.lastMemory = bytes;
    return bytes;
  }

  // ---------------------------------------------------------------- models

  async listModels(): Promise<RuntimeModel[]> {
    if (!this.login) await this.checkLogin();
    if (!this.login) throw new Error(NOT_SIGNED_IN);
    const models = await this.api().listModels();
    // The user's own providers (BYOK, e.g. Azure AI Foundry) come after Copilot's.
    const own: RuntimeModel[] = userProviders().models.map((m) => ({
      providerID: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      // Copilot doesn't list levels for the user's own models; it passes the level on (verified).
      efforts: [...OWN_MODEL_EFFORTS],
      raw: {
        providerID: m.provider,
        id: m.id,
        name: m.name ?? m.id,
        capabilities: { input: m.capabilities?.supports?.vision ? ["text", "image"] : ["text"] },
      },
    }));
    return [...models
      .filter((m: any) => m?.id && m.id !== "auto")
      .map((m: any) => ({
        providerID: COPILOT_PROVIDER,
        id: String(m.id),
        name: String(m.name ?? m.id),
        efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map(String) : [],
        raw: {
          ...m,
          providerID: COPILOT_PROVIDER,
          id: String(m.id),
          // Shaped like OpenCode's records where Symbio reads them (api.ts: vision; costs.ts: prices).
          capabilities: { ...m.capabilities, input: m.capabilities?.supports?.vision ? ["text", "image"] : ["text"] },
          ...(priceOf(m) ? { cost: priceOf(m) } : {}),
        },
      })), ...own];
  }

  // ---------------------------------------------------------------- sessions

  async createSession(opts: NewSession): Promise<string> {
    const sessionId = randomUUID();
    this.toolsByFolder.set(opts.directory, opts.toolsUrl);
    const state = this.state_(sessionId);
    state.directory = opts.directory;
    state.permissions = opts.permissions;
    state.skills = opts.skills;
    const session = await this.api().createSession({
      ...this.config(sessionId, state),
      sessionId,
      name: sessionName(opts.title),
      model: modelId(opts.model),
      ...(opts.effort ? { reasoningEffort: opts.effort } : {}),
    });
    this.attach(sessionId, session);
    await this.onlyItsSkills(session, state);
    return sessionId;
  }

  /**
   * Copilot also has skills of its own (built in, verified: customize-cloud-agent, github-pr-media,
   * pr-stack) that the session config can't name in advance: they're turned off once it's open, so
   * the session has exactly its skills (rpc.skills.list / disable, experimental).
   */
  private async onlyItsSkills(session: SdkSession, state: SessionState) {
    if (!state.skills) return;
    try {
      const listed = ((await (session as any).rpc.skills.list())?.skills ?? []) as { name: string; enabled?: boolean }[];
      for (const s of listed) {
        if (s.enabled !== false && !state.skills.includes(s.name)) await (session as any).rpc.skills.disable({ name: s.name });
      }
    } catch (err) {
      console.error("[copilot] couldn't limit a session's skills:", (err as Error).message);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.close(sessionId);
    this.sessions.delete(sessionId);
    await this.api().deleteSession(sessionId);
  }

  async setPermissions(sessionId: string, rules: PermissionRule[]): Promise<void> {
    // Applied by Symbio on each request (onPermission): nothing to send.
    this.state_(sessionId).permissions = rules;
  }

  /**
   * A skill added to the library shows up in open sessions at once (verified), on: those are reopened
   * before their next turn, with the new skill among the ones turned off.
   */
  skillsChanged(): void {
    for (const [id, state] of this.sessions) if (state.skills && this.live(id)) state.stale = true;
  }

  /** Copilot takes skills when a session is opened: an open one is reopened before its next turn. */
  async setSkills(sessionId: string, skills: string[]): Promise<void> {
    const state = this.state_(sessionId);
    if (state.skills && state.skills.length === skills.length && state.skills.every((s, i) => s === skills[i])) return;
    state.skills = [...skills];
    if (this.live(sessionId)) state.stale = true;
  }

  async setInstruction(sessionId: string, key: string, value: string | null): Promise<void> {
    const state = this.state_(sessionId);
    if ((state.instructions.get(key) ?? null) === value) return;
    if (value === null) state.instructions.delete(key);
    else state.instructions.set(key, value);
    // Copilot takes instructions when a session is opened: an open one is reopened before its next turn.
    if (this.live(sessionId)) state.stale = true;
  }

  async prompt(sessionId: string, text: string, delivery: "queue" | "steer"): Promise<string | undefined> {
    const state = this.state_(sessionId);
    if (state.stale && !state.busy) {
      // Still opening with the old config: let it open, then reopen it with the new one.
      await this.opening.get(sessionId)?.catch(() => {});
      if (state.stale) await this.close(sessionId);
    }
    const session = await this.session(sessionId);
    const notes = state.notes;
    const prompt = notes.length ? `${text}\n\n${NOTES_OPEN}\n${notes.join("\n\n")}\n${NOTES_CLOSE}` : text;
    state.notes = [];
    state.sending++;
    try {
      const id = await session.send({ prompt, mode: delivery === "steer" ? "immediate" : "enqueue" });
      if (id) state.queued.set(id, { prompt, text, notes });
      return id;
    } finally {
      // After the caller has seen the result (and marked the agent busy).
      setImmediate(() => {
        if (--state.sending > 0) return;
        for (const e of state.held.splice(0)) this.translate(sessionId, e);
      });
    }
  }

  async note(sessionId: string, text: string): Promise<void> {
    // Copilot can't add to a conversation without a turn: it goes with the next prompt.
    this.state_(sessionId).notes.push(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const live = this.open.get(sessionId);
    if (live) await live.session.abort();
  }

  async switchModel(sessionId: string, model: string, effort?: string | null): Promise<void> {
    const session = await this.session(sessionId);
    if (effort) {
      await session.setModel(modelId(model), { reasoningEffort: effort });
      return;
    }
    // A model change without a level keeps the session's last one (verified): back to the model's default.
    const info = (await this.listModels().catch(() => [])).find((m) => `${m.providerID}/${m.id}` === model || m.id === modelId(model));
    const fallback = info?.raw?.defaultReasoningEffort ?? (info?.efforts.includes("medium") ? "medium" : undefined);
    await session.setModel(modelId(model), fallback ? { reasoningEffort: fallback } : undefined);
  }

  async queued(sessionId: string): Promise<string[]> {
    const live = this.open.get(sessionId);
    if (!live) return [];
    const res = await live.session.rpc.queue.pendingItems();
    return (res?.items ?? []).map((i: any) => i.messageId).filter(Boolean);
  }

  async cancelQueued(sessionId: string, id: string): Promise<boolean> {
    const live = this.open.get(sessionId);
    const state = this.sessions.get(sessionId);
    const queued = state?.queued.get(id);
    if (!live || !state || !queued) return false;
    const res = await live.session.rpc.queue.withdrawMessage({ messageId: id, expectedPrompt: queued.prompt }).catch(() => null);
    if (res?.removed) {
      state.queued.delete(id);
      // The caller takes back only its own text: notes that rode along wait for the next prompt.
      state.notes = [...queued.notes, ...state.notes];
    }
    return !!res?.removed;
  }

  // ---------------------------------------------------------------- questions and permissions

  async forms(sessionId: string): Promise<any[]> {
    return [...this.questions.values()].filter((q) => q.sessionId === sessionId).map((q) => q.form);
  }

  async answerForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void> {
    const q = this.questions.get(formId);
    if (!q || q.sessionId !== sessionId) throw new Error("That question is no longer open.");
    const text = String(answer.answer ?? "");
    this.questions.delete(formId);
    q.resolve({ answer: text, wasFreeform: !q.choices.includes(text) });
  }

  async answerPermission(sessionId: string, requestId: string, decision: "once" | "reject", message?: string | null): Promise<void> {
    const p = this.permissionRequests.get(requestId);
    if (!p || p.sessionId !== sessionId) return;
    this.permissionRequests.delete(requestId);
    p.resolve(decision === "once" ? { kind: "approve-once" } : { kind: "reject", ...(message ? { feedback: message } : {}) });
    this.emitEvent(sessionId, "permission.replied", { requestID: requestId });
  }

  // ---------------------------------------------------------------- signing in

  /** Reads who the runtime is signed in as. */
  async checkLogin(): Promise<string | null> {
    // Also while starting (before "running").
    const auth = this.client ? await this.client.getAuthStatus().catch(() => null) : null;
    this.login = auth?.isAuthenticated ? (auth.login ?? "GitHub") : null;
    this.lastError = this.login ? null : NOT_SIGNED_IN;
    return this.login;
  }

  /** The sign-in in progress: the code to enter on GitHub. */
  get pendingSignIn(): SignInCode | null {
    return this.signIn?.code ?? null;
  }

  /**
   * Starts signing in to GitHub with a device code (verified: `rpc.accounts.login`, docs/copilot-api.md).
   * The human enters the code on GitHub; the sign-in completes in the background.
   */
  async beginSignIn(): Promise<SignInCode> {
    if (this.signIn) return this.signIn.code;
    this.signInError = null;
    // Signing in happens through a session; a scratch one, with no model turn and no tools.
    const session = await this.api().createSession({
      clientName: "symbio",
      workingDirectory: this.home,
      onPermissionRequest: () => ({ kind: "reject", feedback: "Not for this session." }),
    });
    try {
      const begun = await session.rpc.accounts.login.begin({ kind: "githubDotCom", method: "device-code" });
      const step = begun?.step;
      if (step?.kind !== "device-code") throw new Error(step?.kind === "error" ? step.message : "GitHub didn't give a sign-in code.");
      const code: SignInCode = { userCode: String(step.userCode), verificationUri: String(step.verificationUri), expiresAt: Date.now() + Number(step.expiresIn ?? 900) * 1000 };
      this.signIn = { session, flowId: begun.flowId, code };
      void this.finishSignIn(this.signIn);
      return code;
    } catch (err) {
      await this.dropScratch(session);
      throw err;
    }
  }

  async cancelSignIn(): Promise<void> {
    const flow = this.signIn;
    if (!flow) return;
    this.signIn = null;
    await flow.session.rpc.accounts.login.cancel({ flowId: flow.flowId }).catch(() => {});
    await this.dropScratch(flow.session);
  }

  /** `advance` returns once the human has authorized the device (or the code expired). */
  private async finishSignIn(flow: NonNullable<CopilotRuntime["signIn"]>) {
    try {
      const step = await flow.session.rpc.accounts.login.advance({ flowId: flow.flowId });
      if (this.signIn !== flow) return; // cancelled meanwhile
      if (step?.kind === "error") this.signInError = String(step.message ?? "The sign-in failed.");
      else if (step?.kind !== "completed") this.signInError = "The sign-in didn't complete.";
    } catch (err) {
      if (this.signIn === flow) this.signInError = (err as Error).message;
    }
    if (this.signIn !== flow) return;
    this.signIn = null;
    await this.dropScratch(flow.session);
    if (this.state === "running") await this.checkLogin();
    if (this.login) this.signInError = null;
  }

  private async dropScratch(session: SdkSession) {
    await session.disconnect().catch(() => {});
    await this.client?.deleteSession(session.sessionId).catch(() => {});
  }

  // ---------------------------------------------------------------- history, usage, changes

  async history(sessionId: string): Promise<any[]> {
    return toHistory(await (await this.session(sessionId)).getEvents());
  }

  async historyPage(sessionId: string, limit: number, before?: string): Promise<{ messages: any[]; hasMore: boolean }> {
    const all = await this.history(sessionId);
    const at = before ? all.findIndex((m) => m.id === before) : -1;
    const end = at < 0 ? all.length : at;
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0 };
  }

  async sessionUsage(sessionId: string): Promise<Usage | null> {
    const live = this.open.get(sessionId);
    const metrics = live ? await live.session.rpc.usage.getMetrics().catch(() => null) : null;
    const t = metrics?.tokenDetails;
    if (t) {
      return {
        cost: 0, // priced by Symbio from the model's prices
        input: t.input?.tokenCount ?? 0,
        output: t.output?.tokenCount ?? 0,
        reasoning: 0,
        cacheRead: t.cache_read?.tokenCount ?? 0,
        cacheWrite: t.cache_write?.tokenCount ?? 0,
      };
    }
    return this.sessions.get(sessionId)?.usage ?? null;
  }

  async childSessions(): Promise<ChildSession[]> {
    // Copilot's sub-agents run inside the session; their usage is in its totals.
    return [];
  }

  /**
   * Copilot diffs a whole session, not two given turns: its diff, kept to the files the turns from
   * `from` to `to` edited (each edit step lists its files). A file also edited earlier shows all
   * of the session's changes to it.
   */
  async changes(sessionId: string, from: string, to: string): Promise<FileChange[]> {
    const session = await this.session(sessionId);
    const res = await session.rpc.workspaces.diff({ mode: "session" });
    const all: FileChange[] = (res?.changes ?? []).map((c: any) => {
      const patch = String(c.diff ?? "");
      const lines = patch.split("\n");
      return {
        file: String(c.path),
        status: c.changeType === "added" || c.changeType === "deleted" ? c.changeType : "modified",
        additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
        deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
        patch,
      };
    });
    const directory = this.state_(sessionId).directory ?? "";
    const edited = editedBetween(await session.getEvents(), from, to, directory);
    return edited ? all.filter((c) => edited.has(fileKey(directory, c.file))) : all;
  }

  // ---------------------------------------------------------------- tools and processes

  async ensureTools(directory: string, url: string): Promise<void> {
    // Copilot's MCP servers are per session, given when one is opened.
    if (this.toolsByFolder.get(directory) === url) return;
    this.toolsByFolder.set(directory, url);
    for (const [id, state] of this.sessions) if (state.directory === directory && this.live(id)) state.stale = true;
  }

  /**
   * Background shells are Copilot tasks, listed per session (verified: `rpc.tasks.list`, then
   * `rpc.tasks.cancel` ends the process). Ids are "<session>:<task>", task ids being per session.
   */
  async shells(directory: string): Promise<BackgroundShell[]> {
    const out: BackgroundShell[] = [];
    for (const [sessionId, live] of this.open) {
      const dir = this.sessions.get(sessionId)?.directory;
      if (!dir || path.resolve(dir).toLowerCase() !== path.resolve(directory).toLowerCase()) continue;
      const list = await live.session.rpc.tasks.list().catch(() => null);
      for (const t of list?.tasks ?? []) {
        if (t?.type !== "shell") continue;
        out.push({
          id: `${sessionId}:${t.id}`,
          command: String(t.command ?? t.description ?? ""),
          pid: typeof t.pid === "number" ? t.pid : undefined,
          started: Date.parse(t.startedAt) || 0,
          running: t.status === "running",
          sessionId,
        });
      }
    }
    return out;
  }

  async stopShell(_directory: string, id: string): Promise<void> {
    const at = id.lastIndexOf(":");
    const live = at > 0 ? this.open.get(id.slice(0, at)) : undefined;
    if (!live) throw new Error(`No background process "${id}".`);
    const res = await live.session.rpc.tasks.cancel({ id: id.slice(at + 1) });
    if (!res?.cancelled) throw new Error(`Couldn't stop "${id}" (it may have ended already).`);
  }

  // ---------------------------------------------------------------- internals

  private api(): SdkClient {
    if (!this.client || this.state !== "running") throw new Error(`${this.label} is not running (${this.state})`);
    return this.client;
  }

  private state_(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        directory: null,
        permissions: [],
        instructions: new Map(),
        stale: false,
        notes: [],
        busy: false,
        turnError: null,
        queued: new Map(),
        usage: emptyUsage(),
        sending: 0,
        held: [],
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** The session's settings, as Copilot takes them when a session is created or opened. */
  private config(sessionId: string, state: SessionState) {
    const url = state.directory ? this.toolsByFolder.get(state.directory) : undefined;
    const instructions = [...state.instructions.values()].join("\n\n");
    // Read each time a session opens, so a provider added or a key changed in Copilot applies.
    const own = userProviders();
    return {
      ...(own.models.length ? { providers: own.providers, models: own.models } : {}),
      clientName: "symbio",
      // Copilot adds a Co-authored-by line to commits unless told not to (docs/copilot-api.md).
      coauthorEnabled: state.directory ? (this.commitCoauthors?.(state.directory) ?? false) : false,
      streaming: true,
      enableFileChangeTracking: true,
      ...(state.directory ? { workingDirectory: state.directory } : {}),
      ...(instructions ? { systemMessage: { mode: "append", content: instructions } } : {}),
      // Symbio's skill folders, and every other skill it knows of turned off, so the session has exactly its own.
      ...(state.skills ? { skillDirectories: skillRoots(), disabledSkills: knownSkillNames().filter((n) => !state.skills!.includes(n)) } : {}),
      mcpServers: url ? { symbio: { type: "http", url, headers: { "x-symbio-session": sessionId }, tools: ["*"] } } : {},
      onPermissionRequest: (request: any) => this.onPermission(sessionId, request),
      onUserInputRequest: (request: any) => this.onQuestion(sessionId, request),
      // Reads inside the working folder don't ask permission (verified): rules on reading are applied here.
      hooks: { onPreToolUse: (input: any) => this.onPreToolUse(sessionId, input) },
    };
  }

  /** An open session, opening it (after a Symbio or runtime restart, or with new instructions) when needed. */
  private async session(sessionId: string): Promise<SdkSession> {
    const live = this.open.get(sessionId);
    if (live) return live.session;
    let pending = this.opening.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const state = this.state_(sessionId);
        // After Symbio restarts, the folder (which Symbio's tools are registered for) comes from Copilot's
        // record of the session: `context.workingDirectory` (verified; docs/copilot-api.md).
        if (!state.directory) {
          const context = (await this.api().getSessionMetadata(sessionId).catch(() => null))?.context;
          state.directory = context?.workingDirectory ?? context?.cwd ?? null;
          if (!state.directory) console.error(`[copilot] no folder for session ${sessionId}: it opens without Symbio's tools`);
        }
        // Cleared before the config is read: a change while it opens marks it stale again (reopened before its next turn).
        state.stale = false;
        const session = await this.api().resumeSession(sessionId, this.config(sessionId, state));
        this.attach(sessionId, session);
        await this.onlyItsSkills(session, state);
        return session;
      })().finally(() => this.opening.delete(sessionId));
      this.opening.set(sessionId, pending);
    }
    return pending;
  }

  /** Open, or being opened: a change to its config needs a reopen. */
  private live(sessionId: string): boolean {
    return this.open.has(sessionId) || this.opening.has(sessionId);
  }

  private async close(sessionId: string) {
    const live = this.open.get(sessionId);
    if (!live) return;
    this.open.delete(sessionId);
    live.off();
    await live.session.disconnect().catch(() => {});
  }

  private attach(sessionId: string, session: SdkSession) {
    const off = session.on((e) => {
      const state = this.state_(sessionId);
      if (state.sending > 0) state.held.push(e);
      else this.translate(sessionId, e);
    });
    this.open.set(sessionId, { session, off });
  }

  private emitEvent(sessionId: string, type: string, data: Record<string, unknown> = {}) {
    const event: RuntimeEvent = { id: randomUUID(), type, data: { sessionID: sessionId, ...data } };
    this.emit("event", event);
  }

  /** Copilot's events in the vocabulary of runtime/types.ts. */
  private translate(sessionId: string, e: any) {
    const state = this.state_(sessionId);
    const d = e?.data ?? {};
    const started = () => {
      if (state.busy) return;
      state.busy = true;
      state.turnError = null;
      this.emitEvent(sessionId, "session.execution.started");
    };
    switch (e?.type) {
      case "user.message":
        if (d.messageId) {
          state.queued.delete(d.messageId);
          this.emitEvent(sessionId, "session.inbox.delivered", { inboxID: d.messageId });
        }
        started();
        break;
      case "assistant.turn_start":
        started();
        break;
      // The context window: what the conversation holds now and the model's limit (SDK UsageInfoData).
      case "session.usage_info":
        if (typeof d.currentTokens === "number") {
          this.emitEvent(sessionId, "session.context.updated", { tokens: d.currentTokens, limit: typeof d.tokenLimit === "number" ? d.tokenLimit : null });
        }
        break;
      case "assistant.message_start":
        this.emitEvent(sessionId, "session.text.started", { assistantMessageID: d.messageId });
        break;
      case "assistant.message_delta":
        this.emitEvent(sessionId, "session.text.delta", { assistantMessageID: d.messageId, delta: d.deltaContent ?? "" });
        break;
      case "assistant.message":
        if (d.content) this.emitEvent(sessionId, "session.text.ended", { assistantMessageID: d.messageId, text: d.content });
        break;
      case "assistant.reasoning_delta":
        this.emitEvent(sessionId, "session.reasoning.delta", { assistantMessageID: d.reasoningId ?? d.messageId, delta: d.deltaContent ?? "" });
        break;
      case "tool.execution_start": {
        const name = toolName(d.toolName, d.mcpServerName);
        this.emitEvent(sessionId, "session.tool.input.started", { id: d.toolCallId, name });
        this.emitEvent(sessionId, "session.tool.called", { id: d.toolCallId, name, input: d.arguments });
        break;
      }
      case "tool.execution_complete":
        if (d.success) this.emitEvent(sessionId, "session.tool.success", { id: d.toolCallId, content: [{ type: "text", text: resultText(d.result) }] });
        else this.emitEvent(sessionId, "session.tool.failed", { id: d.toolCallId, error: { message: d.error?.message ?? "The step failed." } });
        break;
      case "assistant.usage":
        state.usage = {
          ...state.usage,
          input: state.usage.input + (d.inputTokens ?? 0),
          output: state.usage.output + (d.outputTokens ?? 0),
          cacheRead: state.usage.cacheRead + (d.cacheReadTokens ?? 0),
          cacheWrite: state.usage.cacheWrite + (d.cacheWriteTokens ?? 0),
        };
        this.emitEvent(sessionId, "session.usage.updated");
        break;
      case "session.error":
        state.turnError = { type: String(d.errorType ?? "error"), message: String(d.message ?? "The turn failed."), status: d.statusCode };
        break;
      case "session.idle": {
        const error = d.aborted ? { type: "aborted", message: "The turn was interrupted." } : state.turnError;
        if (error && !d.aborted) {
          // A turn that fails before it starts (a model that isn't available) drops its prompt: it
          // isn't in the conversation. Keep what it carried for the next turn, as OpenCode would.
          const lost = [...state.queued.values()];
          state.queued.clear();
          state.notes = [...lost.flatMap((q) => [...q.notes, q.text]), ...state.notes];
        }
        state.busy = false;
        state.turnError = null;
        this.emitEvent(sessionId, error ? "session.execution.failed" : "session.execution.succeeded", error ? { error } : {});
        break;
      }
    }
  }

  /** Copilot asks before tool calls that leave the folder or change things: Symbio's rules decide, or the human does. */
  private async onPermission(sessionId: string, request: any): Promise<any> {
    // A read the pre-tool hook already decided (outside the folder, Copilot asks again).
    if (request?.toolCallId && this.readsDecided.delete(request.toolCallId)) return { kind: "approve-once" };
    const call = permissionCall(request);
    if (!call) return { kind: "approve-once" };
    const decision = await this.decide(sessionId, call);
    return decision.allow ? { kind: "approve-once" } : { kind: "reject", ...(decision.reason ? { feedback: decision.reason } : {}) };
  }

  /** Before every tool: file reads (the view tool) go through Symbio's read rules. */
  private async onPreToolUse(sessionId: string, input: any): Promise<any> {
    const target = READ_TOOLS.has(String(input?.toolName)) ? input?.toolArgs?.path : undefined;
    if (typeof target !== "string" || !target) return undefined;
    const decision = await this.decide(sessionId, { action: "read", resources: [target] });
    if (!decision.allow) return { permissionDecision: "deny", permissionDecisionReason: decision.reason ?? "Symbio blocks reading this file." };
    if (input?.toolCallId) this.readsDecided.add(String(input.toolCallId));
    return undefined;
  }

  /** The rules' answer for a call; "ask" waits for the human (or Symbio answers for them, permissions.ts). */
  private async decide(sessionId: string, call: { action: string; resources: string[] }): Promise<{ allow: boolean; reason?: string }> {
    const { effect } = evaluate(this.state_(sessionId).permissions, call.action, call.resources);
    if (effect === "allow") return { allow: true };
    if (effect === "deny") return { allow: false, reason: `Symbio blocks this (${call.action}: ${call.resources.join("; ")}). Your instructions say what to do instead.` };
    const id = randomUUID();
    const answer: any = await new Promise((resolve) => {
      this.permissionRequests.set(id, { sessionId, resolve });
      this.emitEvent(sessionId, "permission.asked", { id, action: call.action, resources: call.resources, save: [] });
    });
    return answer?.kind === "approve-once" ? { allow: true } : { allow: false, reason: answer?.feedback };
  }

  /** The agent's ask_user: a form the human answers in the chat. */
  private onQuestion(sessionId: string, request: any): Promise<{ answer: string; wasFreeform: boolean }> {
    const id = String(request?.requestId ?? randomUUID());
    const question = String(request?.question ?? "");
    const choices: string[] = Array.isArray(request?.choices) ? request.choices.map(String) : [];
    const field = {
      key: "answer",
      type: "string",
      title: question,
      required: true,
      ...(choices.length ? { options: choices.map((c) => ({ value: c, label: c })), custom: request?.allowFreeform !== false } : {}),
    };
    return new Promise((resolve) => this.questions.set(id, { sessionId, form: { id, title: question, fields: [field] }, choices, resolve }));
  }

  private setState(state: RuntimeState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

/**
 * A model's price in USD per million tokens, OpenCode-style (costs.ts). Copilot lists prices in AI
 * credits per million tokens, and 1 AI credit = $0.01 (docs.github.com, Models and pricing; checked
 * against a session's totalNanoAiu, docs/copilot-api.md).
 */
export function priceOf(model: any): { input: number; output: number; cache: { read: number; write: number } } | null {
  const p = model?.billing?.tokenPrices;
  if (!p || typeof p.inputPrice !== "number") return null;
  const usd = (credits: unknown) => (typeof credits === "number" ? credits / 100 : 0);
  return { input: usd(p.inputPrice), output: usd(p.outputPrice), cache: { read: usd(p.cacheReadPrice), write: usd(p.cacheWritePrice) } };
}

/**
 * The user's own model providers for Copilot (bring your own key: Azure AI Foundry, OpenAI…), from
 * Copilot's `providers.json` in their Copilot folder, read where it is (never copied: one place to
 * change, and no second copy of the key). The SDK doesn't load that file by itself; it takes the
 * same entries per session (`providers` + `models`), and a model is then chosen as
 * "<provider>/<id>", which is also how Symbio stores it (verified live, docs/copilot-api.md).
 * Keys stay on the server: only model names go to the browser.
 */
export function userProviders(userHome = process.env.SYMBIO_COPILOT_USER_HOME ?? path.join(os.homedir(), ".copilot")): {
  providers: { name: string; baseUrl: string; [k: string]: unknown }[];
  models: { id: string; provider: string; name?: string; capabilities?: any; [k: string]: unknown }[];
} {
  const file = path.join(userHome, "providers.json");
  if (!existsSync(file)) return { providers: [], models: [] };
  try {
    const parsed = parseConfig(readFileSync(file, "utf8"));
    const providers = (Array.isArray(parsed.providers) ? parsed.providers : []).filter(
      (p: any) => typeof p?.name === "string" && p.name && p.name !== COPILOT_PROVIDER && typeof p.baseUrl === "string",
    );
    const names = new Set(providers.map((p: any) => p.name));
    const models = (Array.isArray(parsed.models) ? parsed.models : []).filter(
      (m: any) => typeof m?.id === "string" && m.id && !m.id.includes("/") && names.has(m.provider),
    );
    return { providers, models };
  } catch (err) {
    console.warn("[copilot] couldn't read your Copilot providers.json:", (err as Error).message);
    return { providers: [], models: [] };
  }
}

/** "copilot/gpt-6-luna" → "gpt-6-luna"; the user's own models keep their "<provider>/<id>". */
/** Levels offered for the user's own (BYOK) models: Copilot lists none for them, and takes these (verified with Claude on Azure AI Foundry). */
export const OWN_MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function modelId(ref: string): string {
  return ref.startsWith(`${COPILOT_PROVIDER}/`) ? ref.slice(COPILOT_PROVIDER.length + 1) : ref;
}

/** Copilot's session names: at most 100 characters, no double quotes or control characters. */
function sessionName(title: string): string {
  return title.replace(/["\p{Cc}]/gu, "").trim().slice(0, 100) || "Symbio agent";
}

/** Tool names as the chat knows them: Symbio's MCP tools as "symbio_<tool>", ask_user as "question". */
export function toolName(name: unknown, server?: string): string {
  const n = String(name ?? "tool");
  if (server === "symbio") return `symbio_${n.replace(/^symbio-/, "")}`;
  if (n === "ask_user") return "question";
  return n;
}

function resultText(result: any): string {
  if (typeof result === "string") return result;
  return String(result?.content ?? result?.detailedContent ?? "");
}

/** A Copilot permission request as Symbio's rules see it (action + resources); null for ones no rule covers. */
export function permissionCall(request: any): { action: string; resources: string[] } | null {
  switch (request?.kind) {
    case "shell":
      return { action: "shell", resources: [String(request.fullCommandText ?? "")] };
    case "write":
      return { action: "edit", resources: [String(request.fileName ?? request.path ?? "")] };
    case "read":
      return { action: "read", resources: [String(request.path ?? request.fileName ?? "")] };
    default:
      // Symbio's own tools (mcp), web reads (url), memory.
      return null;
  }
}

/**
 * A session's stored events as conversation messages, in the shape the chat reads (OpenCode's):
 * user messages, and one assistant message per turn with its text, reasoning and tool parts.
 */
export function toHistory(events: any[]): any[] {
  const out: any[] = [];
  let assistant: any = null;
  const tools = new Map<string, any>();
  const turn = (id: string) => {
    if (!assistant) {
      assistant = { id, type: "assistant", content: [] };
      out.push(assistant);
    }
    return assistant;
  };
  for (const e of events) {
    const d = e?.data ?? {};
    const id = String(e?.id ?? randomUUID());
    switch (e?.type) {
      case "user.message": {
        assistant = null;
        const messageId = String(d.messageId ?? id);
        const { text, notes } = splitNotes(String(d.content ?? ""));
        notes.forEach((n, i) => out.push({ id: `${messageId}:note${i}`, type: "synthetic", text: n }));
        out.push({ id: messageId, type: "user", text });
        break;
      }
      case "assistant.reasoning":
        if (d.content) turn(id).content.push({ type: "reasoning", text: d.content });
        break;
      case "assistant.message":
        if (d.content) turn(String(d.messageId ?? id)).content.push({ type: "text", text: d.content });
        break;
      case "tool.execution_start": {
        const part = { type: "tool", name: toolName(d.toolName, d.mcpServerName), state: { status: "running", input: d.arguments } as any };
        tools.set(d.toolCallId, part);
        turn(id).content.push(part);
        break;
      }
      case "tool.execution_complete": {
        const part = tools.get(d.toolCallId);
        if (!part) break;
        part.state = d.success
          ? { ...part.state, status: "completed", content: [{ type: "text", text: resultText(d.result) }] }
          : { ...part.state, status: "error", error: { message: d.error?.message ?? "The step failed." } };
        break;
      }
      case "session.error":
        turn(id).error = { message: String(d.message ?? "The turn failed.") };
        break;
      case "session.model_change":
        assistant = null;
        if (d.newModel) out.push({ id, type: "model-switched", model: { providerID: COPILOT_PROVIDER, id: d.newModel } });
        break;
    }
  }
  return out.filter((m) => m.type !== "assistant" || m.content.length || m.error);
}

/** A prompt with Symbio's notes appended (see prompt) → the prompt, and the notes. */
export function splitNotes(text: string): { text: string; notes: string[] } {
  const at = text.lastIndexOf(`\n\n${NOTES_OPEN}\n`);
  const end = text.trimEnd();
  if (at < 0 || !end.endsWith(NOTES_CLOSE)) return { text, notes: [] };
  const body = end.slice(at + 2 + NOTES_OPEN.length + 1, end.length - NOTES_CLOSE.length).trim();
  return { text: text.slice(0, at), notes: body ? body.split("\n\n") : [] };
}

/**
 * A separate COPILOT_HOME starts signed out. The login itself is in the OS credential store, keyed
 * by the user, so pointing the new home's config at the user's login (as `~/.copilot/config.json`
 * does) signs it in without copying any secret (verified with CLI 1.0.112, docs/copilot-api.md).
 */
export function seedLogin(home: string, userHome = process.env.SYMBIO_COPILOT_USER_HOME ?? path.join(os.homedir(), ".copilot")) {
  const target = path.join(home, "config.json");
  const source = path.join(userHome, "config.json");
  if (!existsSync(source)) return;
  try {
    const ours = existsSync(target) ? parseConfig(readFileSync(target, "utf8")) : {};
    if (ours.loggedInUsers?.length) return;
    const theirs = parseConfig(readFileSync(source, "utf8"));
    if (!theirs.loggedInUsers?.length) return;
    writeFileSync(target, JSON.stringify({ ...ours, loggedInUsers: theirs.loggedInUsers, lastLoggedInUser: theirs.lastLoggedInUser }, null, 2));
  } catch (err) {
    console.warn("[copilot] couldn't reuse the GitHub login:", (err as Error).message);
  }
}

/** Copilot's config.json has `//` comment lines. */
function parseConfig(text: string): any {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").trim() || "{}");
}

const fileKey = (directory: string, file: string) => path.relative(directory, path.resolve(directory, file)).replace(/\\/g, "/").toLowerCase();

/**
 * Files edited by the turns from user message `from` to user message `to` (inclusive), from the
 * edit steps' `fileEdits`; null when the session's events don't say (nothing to filter on).
 */
export function editedBetween(events: any[], from: string, to: string, directory: string): Set<string> | null {
  const files = new Set<string>();
  let known = false;
  let inRange = false;
  let pastEnd = false;
  for (const e of events) {
    const d = e?.data ?? {};
    if (e?.type === "user.message") {
      const id = String(d.messageId ?? e.id);
      if (pastEnd) break;
      if (id === from) inRange = true;
      if (id === to) pastEnd = true;
      continue;
    }
    if (e?.type !== "tool.execution_complete" || !Array.isArray(d.fileEdits)) continue;
    known = true;
    if (inRange) for (const edit of d.fileEdits) if (edit?.path) files.add(fileKey(directory, String(edit.path)));
  }
  return known ? files : null;
}
