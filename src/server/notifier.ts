// What's worth telling the human when they aren't looking (notifications.ts sends it): what waits
// on them (a question, an approval, a plan or work to review, an agent that can't continue), and
// news (a task done, every task done, the team stopped working). It listens to the bus: the
// messages Symbio logs for the human, the plan, and agents' status. Things that happen close
// together go out as one notification per project, so a briefing of five questions is one ping.
// Each project chooses: everything (unset), only what waits on the human, or nothing; and the human
// chooses, for all projects, which kinds are sent (NOTIFY_KINDS: what needs them and what got
// finished by default). Messages are plain and short: no file paths or links to project files,
// which can't be opened where notifications are read.

import { bus, type UiEvent } from "./bus.js";
import type { Notification, NotifyKind } from "./notifications.js";
import type { Plan } from "./plan.js";
import type { Question } from "./questions.js";
import { BUDGET_PAUSED } from "./team/budget.js";
import { JOB_PREFIX } from "./team/schedules.js";
import { newId, type LoggedMessage, type NotifyLevel, type Project } from "./store.js";

export interface NotifierHost {
  project(id: string): Project | undefined;
  projects(): Project[];
  plan(project: Project): Promise<Plan>;
  question(project: Project, id: string): Promise<Question | undefined>;
}

export interface NotifyItem {
  key: string;
  kind: NotifyKind;
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
  /** Whether the human wants this kind of notification (Settings → Notifications). */
  wants: (kind: NotifyKind) => boolean;
}

const DEFAULTS: NotifierOptions = {
  groupMs: Number(process.env.SYMBIO_NOTIFY_GROUP_MS ?? 20_000),
  quietMs: Number(process.env.SYMBIO_NOTIFY_QUIET_MS ?? 60_000),
  minRunMs: Number(process.env.SYMBIO_NOTIFY_MIN_RUN_MS ?? 3 * 60_000),
  wants: () => true,
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

/**
 * What a notification can show of an agent's text: links as their words, paths to files as the
 * file's name (neither opens from a phone), and plain text cut at a sentence when it's long.
 */
export function readable(text: string, max = 300): string {
  const tidy = plain(text, 4000)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // (Not inside an address: "https://site.com/page.html" stays whole.)
    .replace(/(?<![\w/\\:.])(?:[A-Za-z]:[\\/]|\/)?(?:[\w.~-]+[\\/])+([\w.-]+\.\w{1,8})\b/g, "$1");
  if (tidy.length <= max) return tidy;
  const cut = tidy.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("\n"));
  return sentence >= 20 ? cut.slice(0, sentence + 1).trimEnd() : `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max).trimEnd()}…`;
}

const firstLine = (text: string, max: number) => readable(text.split("\n").find((l) => l.trim()) ?? "", max);

/** A spec's path as a feature's name: "docs/specs/contact-form.md" → "contact form". */
const featureName = (spec: string) => spec.split(/[\\/]/).pop()!.replace(/\.\w+$/, "").replace(/[-_]+/g, " ");

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
        if (briefing) return { key, kind: "question", title: `${who} started a briefing`, body: readable(briefing[1]), important: true };
        const id = m.text.match(/^(Q\d+): /)?.[1];
        const q = id ? await this.host.question(project, id) : undefined;
        if (q?.decided) return { key, kind: "decided", title: `${who} decided`, body: readable(`${q.question}\n→ ${q.decided}`), important: false };
        return { key, kind: "question", title: `${who} asks`, body: readable(q?.question ?? m.text.replace(/^Q\d+: /, "")), important: true };
      }
      case "form":
        return { key, kind: "question", title: `${who} asks you`, body: readable(m.text), important: true };
      case "approval":
        return { key, kind: "approval", title: `${who} wants to use a connection`, body: readable(m.text), important: true };
      case "permission":
        return { key, kind: "approval", title: `${who} asks permission`, body: readable(m.text), important: true };
      case "plan": {
        const goal = m.text.match(/\*\*Goal:\*\*\s*(.*)$/s)?.[1] ?? "";
        const proposed = m.text.startsWith("Proposed");
        return {
          key,
          kind: proposed ? "review" : "plan-started",
          title: proposed ? "Plan to review" : `${who} started on a plan`,
          body: readable(goal ? `Goal: ${goal}` : m.text),
          important: proposed,
        };
      }
      case "task-review":
        return { key, kind: "review", title: "Work to review", body: readable(m.text), important: true };
      case "alert":
        return { key, kind: "alert", title: "Symbio needs you", body: readable(m.text), important: true };
      case "job": {
        const kind = (Object.keys(JOB_PREFIX) as (keyof typeof JOB_PREFIX)[]).find((k) => m.text.startsWith(JOB_PREFIX[k]));
        const rest = kind ? m.text.slice(JOB_PREFIX[kind].length).trim() : m.text;
        const titles = { proposed: "Scheduled job to approve", scheduled: "Job scheduled", done: "Scheduled job done", failed: "Scheduled job failed", skipped: "Scheduled job skipped" };
        const attention = kind === "proposed" || kind === "failed";
        return { key, kind: attention ? "jobs" : "job-runs", title: kind ? titles[kind] : "Scheduled jobs", body: readable(rest), important: attention };
      }
      case "budget": {
        const paused = m.text.startsWith(BUDGET_PAUSED);
        return {
          key,
          kind: paused ? "budget" : "budget-warning",
          title: paused ? "Budget reached: team paused" : "Budget",
          body: readable(paused ? m.text.slice(BUDGET_PAUSED.length) : m.text),
          important: paused,
        };
      }
      // Shared files: in the Files tab and with their task, not on the human's phone.
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
      this.add(project, { key: `done:${task.id}`, kind: "task", title: `${task.id} done`, body: readable(task.title), important: false });
      // The last task of a feature (the tasks of one spec): the feature is done.
      const feature = task.spec ? plan.tasks.filter((t) => t.spec === task.spec) : [];
      const all = plan.tasks.length > 0 && plan.tasks.every((t) => t.status === "done");
      if (feature.length && !all && feature.every((t) => t.status === "done")) {
        this.add(project, {
          key: `feature:${task.spec}:${plan.revision}`,
          kind: "feature",
          title: `Feature done: ${featureName(task.spec!)}`,
          body: readable(feature.map((t) => t.title).join("; ")),
          important: false,
        });
      }
    }
    // Tasks that went back (sent back, reopened) count again when they're done again.
    for (const id of [...done]) if (!plan.tasks.some((t) => t.id === id && t.status === "done")) done.delete(id);
    if (finishedOne && plan.status === "approved" && plan.tasks.length && plan.tasks.every((t) => t.status === "done")) {
      const run = this.runs.get(project.id);
      if (run) run.finished = true;
      this.add(project, {
        key: `finished:${plan.revision}:${Date.now()}`,
        kind: "finished",
        title: `All ${plan.tasks.length} tasks done`,
        body: readable(plan.goal ? `Goal: ${plan.goal}` : ""),
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
        kind: "stopped",
        title: "The team stopped working",
        body: run.lastReply ? readable(run.lastReply) : "Nothing is waiting for you.",
        important: true,
      });
    }, this.opts.quietMs);
  }

  private add(project: Project, item: NotifyItem) {
    // A kind the human turned off isn't sent, and doesn't count as having told them.
    if (!this.opts.wants(item.kind)) return;
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
    body: ordered.map((i) => `• ${i.title}${i.body ? `: ${firstLine(i.body, 120)}` : ""}`).join("\n"),
  };
}
