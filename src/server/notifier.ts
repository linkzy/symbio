// What's worth telling the human when they aren't looking (notifications.ts sends it): what waits
// on them (a question, an approval, a plan or work to review, an agent that can't continue), and
// news (a task done, every task done, the team stopped working). It listens to the bus: the
// messages Symbio logs for the human, the plan, and agents' status. Things that happen close
// together go out as one notification per project, so a briefing of five questions is one ping.
// Each project chooses: everything (unset), only what waits on the human, or nothing.

import { bus, type UiEvent } from "./bus.js";
import type { Notification } from "./notifications.js";
import type { Plan } from "./plan.js";
import type { Question } from "./questions.js";
import { BUDGET_PAUSED } from "./team/budget.js";
import { newId, type LoggedMessage, type NotifyLevel, type Project } from "./store.js";

export interface NotifierHost {
  project(id: string): Project | undefined;
  projects(): Project[];
  plan(project: Project): Promise<Plan>;
  question(project: Project, id: string): Promise<Question | undefined>;
}

export interface NotifyItem {
  key: string;
  title: string;
  body: string;
  /** Waits on the human (sent even when the project wants only those). */
  important: boolean;
}

export interface NotifierOptions {
  /** How long to gather what happens together before sending it (from the first thing). */
  groupMs: number;
  /** How long nobody works before the team counts as stopped. */
  quietMs: number;
  /** Shorter runs (a quick reply in the chat) don't count as the team stopping. */
  minRunMs: number;
}

const DEFAULTS: NotifierOptions = {
  groupMs: Number(process.env.SYMBIO_NOTIFY_GROUP_MS ?? 20_000),
  quietMs: Number(process.env.SYMBIO_NOTIFY_QUIET_MS ?? 60_000),
  minRunMs: Number(process.env.SYMBIO_NOTIFY_MIN_RUN_MS ?? 3 * 60_000),
};

const MAX_BODY = 600;

/** Markdown markers out, spaces tidied, cut to size: notifications are plain text. */
export function plain(text: string, max = MAX_BODY): string {
  const clean = text
    .replace(/\*\*|__|`/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const firstLine = (text: string, max: number) => plain(text.split("\n").find((l) => l.trim()) ?? "", max);

interface Run {
  since: number;
  /** Something that waits on the human was sent meanwhile: that already says the work stopped. */
  asked: boolean;
  finished: boolean;
  /** The latest thing an agent said to the human. */
  lastReply?: string;
  timer?: NodeJS.Timeout;
}

export class Notifier {
  private queues = new Map<string, { items: NotifyItem[]; timer: NodeJS.Timeout }>();
  private doneTasks = new Map<string, Set<string>>();
  private runs = new Map<string, Run>();
  // One event at a time, in order: looking a question up mustn't let a later event overtake it.
  private chain: Promise<void> = Promise.resolve();
  private listener = (e: UiEvent) => {
    if (e.type !== "message" && e.type !== "plan.updated" && e.type !== "agent.status") return;
    this.chain = this.chain.then(() => this.onEvent(e)).catch((err) => console.error("[notifier]", err.message));
  };
  private readonly opts: NotifierOptions;

  constructor(
    private readonly host: NotifierHost,
    private readonly send: (n: Notification) => Promise<void>,
    private readonly detail: () => "full" | "short",
    opts: Partial<NotifierOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Remembers which tasks are already done (so only new ones count), then listens. */
  async start() {
    for (const project of this.host.projects()) await this.knownDone(project);
    bus.on("ui", this.listener);
  }

  stop() {
    bus.off("ui", this.listener);
    for (const q of this.queues.values()) clearTimeout(q.timer);
    for (const r of this.runs.values()) clearTimeout(r.timer);
    this.queues.clear();
    this.runs.clear();
  }

  private async knownDone(project: Project): Promise<Set<string>> {
    let done = this.doneTasks.get(project.id);
    if (!done) {
      done = new Set((await this.host.plan(project).catch(() => null))?.tasks.filter((t) => t.status === "done").map((t) => t.id) ?? []);
      this.doneTasks.set(project.id, done);
    }
    return done;
  }

  private async onEvent(e: UiEvent) {
    if (e.type === "message") {
      const project = this.host.project(e.projectId);
      if (!project) return;
      const m = e.message as LoggedMessage;
      if (m.to !== "human" || m.from === "human") return;
      if (m.kind === "chat") {
        const run = this.runs.get(project.id);
        if (run) run.lastReply = m.text;
        return;
      }
      const item = await this.fromMessage(project, m);
      if (item) this.add(project, item);
    } else if (e.type === "plan.updated") {
      const project = this.host.project(e.projectId);
      if (project) await this.planChanged(project);
    } else if (e.type === "agent.status") {
      const project = this.host.project(e.projectId);
      if (project) this.statusChanged(project, e.agentId, e.status);
    }
  }

  /** A message Symbio logged for the human, as a notification (null: not worth one). */
  async fromMessage(project: Project, m: LoggedMessage): Promise<NotifyItem | null> {
    const who = m.from === "symbio" ? "Symbio" : (project.agents.find((a) => a.id === m.from)?.name ?? m.from);
    const key = `${m.kind}:${m.id}`;
    switch (m.kind) {
      case "question": {
        const briefing = m.text.match(/^B\d+: (.*)$/s);
        if (briefing) return { key, title: `${who} started a briefing`, body: plain(briefing[1]), important: true };
        const id = m.text.match(/^(Q\d+): /)?.[1];
        const q = id ? await this.host.question(project, id) : undefined;
        if (q?.decided) return { key, title: `${who} decided`, body: plain(`${q.question}\n→ ${q.decided}`), important: false };
        return { key, title: `${who} asks`, body: plain(q?.question ?? m.text.replace(/^Q\d+: /, "")), important: true };
      }
      case "form":
        return { key, title: `${who} asks you`, body: plain(m.text), important: true };
      case "approval":
        return { key, title: `${who} wants to use a connection`, body: plain(m.text), important: true };
      case "permission":
        return { key, title: `${who} asks permission`, body: plain(m.text), important: true };
      case "plan": {
        const goal = m.text.match(/\*\*Goal:\*\*\s*(.*)$/s)?.[1] ?? "";
        const proposed = m.text.startsWith("Proposed");
        return { key, title: proposed ? "Plan to review" : `${who} started on a plan`, body: plain(goal ? `Goal: ${goal}` : m.text), important: proposed };
      }
      case "task-review":
        return { key, title: "Work to review", body: plain(m.text), important: true };
      case "alert":
        return { key, title: "Symbio needs you", body: plain(m.text), important: true };
      case "budget": {
        const paused = m.text.startsWith(BUDGET_PAUSED);
        return { key, title: paused ? "Budget reached: team paused" : "Budget", body: plain(paused ? m.text.slice(BUDGET_PAUSED.length) : m.text), important: paused };
      }
      case "file":
        return { key, title: `${who} shared a file`, body: plain(m.text), important: false };
      default:
        return null;
    }
  }

  private async planChanged(project: Project) {
    const done = await this.knownDone(project);
    const plan = await this.host.plan(project);
    let finishedOne = false;
    for (const task of plan.tasks) {
      if (task.status !== "done" || done.has(task.id)) continue;
      done.add(task.id);
      finishedOne = true;
      // The human approved it themselves: nothing to tell them.
      if (task.humanReview?.state === "approved") continue;
      this.add(project, { key: `done:${task.id}`, title: `${task.id} done`, body: plain(task.title), important: false });
    }
    // Tasks that went back (sent back, reopened) count again when they're done again.
    for (const id of [...done]) if (!plan.tasks.some((t) => t.id === id && t.status === "done")) done.delete(id);
    if (finishedOne && plan.status === "approved" && plan.tasks.length && plan.tasks.every((t) => t.status === "done")) {
      const run = this.runs.get(project.id);
      if (run) run.finished = true;
      this.add(project, {
        key: `finished:${plan.revision}:${Date.now()}`,
        title: `All ${plan.tasks.length} tasks done`,
        body: plain(plan.goal ? `Goal: ${plan.goal}` : ""),
        important: true,
      });
    }
  }

  /** Runs of work: when the team stops after working a while, and nothing else said so, that's news. */
  private statusChanged(project: Project, agentId: string, status: string) {
    // The event's status: the agent may have moved on by the time this runs.
    const working = status === "busy" || project.agents.some((a) => a.id !== agentId && a.status === "busy");
    let run = this.runs.get(project.id);
    if (working) {
      if (!run) this.runs.set(project.id, (run = { since: Date.now(), asked: false, finished: false }));
      // Back at work: what was asked earlier has been answered (or doesn't hold the work).
      if (status === "busy") run.asked = false;
      clearTimeout(run.timer);
      run.timer = undefined;
      return;
    }
    if (!run || run.timer) return;
    run.timer = setTimeout(() => {
      const current = this.runs.get(project.id);
      if (current !== run) return;
      this.runs.delete(project.id);
      const latest = this.host.project(project.id);
      if (!latest || latest.paused || latest.agents.some((a) => a.status === "busy")) return;
      // Waiting on the human, finished, or a quick reply: already said, or not news.
      if (run.asked || run.finished || latest.agents.some((a) => a.status === "waiting")) return;
      if (Date.now() - this.opts.quietMs - run.since < this.opts.minRunMs) return;
      this.add(latest, {
        key: `stopped:${run.since}`,
        title: "The team stopped working",
        body: run.lastReply ? plain(run.lastReply) : "Nothing is waiting for you.",
        important: true,
      });
    }, this.opts.quietMs);
  }

  private add(project: Project, item: NotifyItem) {
    const run = this.runs.get(project.id);
    if (run && item.important && !item.key.startsWith("stopped:")) run.asked = true;
    const queue = this.queues.get(project.id);
    if (queue) {
      if (!queue.items.some((i) => i.key === item.key)) queue.items.push(item);
      return;
    }
    this.queues.set(project.id, { items: [item], timer: setTimeout(() => void this.flush(project.id), this.opts.groupMs) });
  }

  private async flush(projectId: string) {
    const queue = this.queues.get(projectId);
    this.queues.delete(projectId);
    const project = this.host.project(projectId);
    if (!queue || !project) return;
    const level: NotifyLevel = project.notify ?? "all";
    const items = level === "off" ? [] : level === "important" ? queue.items.filter((i) => i.important) : queue.items;
    if (!items.length) return;
    await this.send(compose(project, items, this.detail())).catch((err) => console.error("[notifier]", err.message));
  }
}

/** One notification for what a project gathered. */
export function compose(project: Pick<Project, "id" | "name">, items: NotifyItem[], detail: "full" | "short"): Notification {
  const important = items.some((i) => i.important);
  const base = { id: newId("ntf"), projectId: project.id, important, at: Date.now() };
  if (detail === "short") {
    return { ...base, title: "Symbio", body: important ? `${project.name} needs you` : `${project.name}: ${items.length === 1 ? "news" : `${items.length} updates`}` };
  }
  if (items.length === 1) return { ...base, title: `${project.name}: ${items[0].title}`, body: items[0].body };
  // What waits on the human first.
  const ordered = [...items.filter((i) => i.important), ...items.filter((i) => !i.important)];
  return {
    ...base,
    title: `${project.name}: ${important ? "needs you" : "updates"} (${items.length})`,
    body: ordered.map((i) => `• ${i.title}${i.body ? `: ${firstLine(i.body, 140)}` : ""}`).join("\n"),
  };
}
