// Scheduled jobs (schedule.ts keeps them): core sets them up at the human's request, Symbio wakes
// core when one is due, and core reports how each run went. In a project that asks, a job core sets
// up waits for the human's approval first. A run that's due while the team is paused, while the
// previous run is still going, or with core stopped is skipped (and says why); one missed while
// Symbio was off runs once when it's back.

import { bus } from "../bus.js";
import { describeSchedule, nextRun, parseSchedule, ScheduleStore, type Job } from "../schedule.js";
import type { Project } from "../store.js";
import { active, type TeamCore } from "./core.js";

/** A run core didn't report within this long is closed as not reported, so the next ones can start. */
const NO_REPORT_MS = 6 * 3_600_000;
const CHECK_EVERY_MS = 30_000;

/** What the human's message about a job starts with (notifier.ts tells them apart by it). */
export const JOB_PREFIX = { proposed: "Proposed:", scheduled: "Scheduled:", done: "Done:", failed: "Failed:", skipped: "Skipped:" } as const;

const when = (t: number | null) =>
  t === null ? "no further runs" : new Date(t).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export class Schedules {
  private stores = new Map<string, Promise<ScheduleStore>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly team: TeamCore,
    private readonly now: () => number = Date.now,
  ) {}

  store(project: Project): Promise<ScheduleStore> {
    let store = this.stores.get(project.id);
    if (!store) {
      store = ScheduleStore.load(project.directory);
      this.stores.set(project.id, store);
    }
    return store;
  }

  start() {
    this.timer ??= setInterval(() => void this.tick().catch((err) => console.error("[schedules]", err.message)), CHECK_EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs what's due in every project. */
  async tick() {
    if (this.ticking || this.team.shuttingDown) return;
    this.ticking = true;
    try {
      for (const project of this.team.store.list()) {
        const store = await this.store(project).catch(() => null);
        if (!store) continue;
        for (const job of store.jobs) {
          if (job.state === "active" && job.nextRun !== null && job.nextRun <= this.now()) await this.due(project, job, "schedule");
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private changed(project: Project) {
    bus.publish({ type: "schedules.updated", projectId: project.id });
  }

  private human(project: Project, text: string) {
    return this.team.log(project, { from: "symbio", to: "human", kind: "job", text });
  }

  /** A run: core is woken with the job. Returns why it couldn't start, if it couldn't. */
  private async due(project: Project, job: Job, by: "schedule" | "manual"): Promise<string | null> {
    const store = await this.store(project);
    const now = this.now();
    // The open run, not the last entry: skipped runs come after it.
    const last = [...job.runs].reverse().find((r) => r.status === "running");
    if (last) {
      if (now - last.at < NO_REPORT_MS) return this.skip(project, job, by, "the previous run is still going");
      last.status = "no-report";
      last.endedAt = now;
      last.note = "core didn't report how it went";
    }
    if (project.paused) return this.skip(project, job, by, "the team is paused");
    const core = this.team.coordinator(project);
    if (!core || !active(core)) return this.skip(project, job, by, "core isn't running");
    const run = await store.startRun(job, { at: now, by, status: "running" }, now, by === "schedule");
    this.changed(project);
    await this.team.log(project, { from: "symbio", to: "human", kind: "system", text: `Started ${job.id} "${job.title}" (run ${run.n}${by === "manual" ? ", started by you" : ""}).` });
    await this.team.system(
      project,
      core,
      `Symbio: scheduled job ${job.id} "${job.title}" is due (run ${run.n}, ${describeSchedule(job.schedule)}${by === "manual" ? "; the human started it now" : ""}).\n\n` +
        `What to do:\n${job.instructions}\n\n` +
        `Do it (with helpers if it needs them), then call report_job with ${job.id}, done or failed, and a short summary of what happened ` +
        "for the human (what changed, what you found, anything they should look at).",
    );
    return null;
  }

  private async skip(project: Project, job: Job, by: "schedule" | "manual", why: string): Promise<string> {
    if (by === "manual") return why;
    const store = await this.store(project);
    await store.startRun(job, { at: this.now(), by, status: "skipped", note: why, endedAt: this.now() }, this.now());
    this.changed(project);
    await this.human(project, `${JOB_PREFIX.skipped} ${job.id} "${job.title}" was due, but ${why}. Next: ${when(job.nextRun)}.`);
    return why;
  }

  // ---- core's tools

  async create(project: Project, input: { title: string; instructions: string; every?: unknown; at?: unknown; days?: unknown; day?: unknown; interval?: unknown; date?: unknown }): Promise<string> {
    const schedule = parseSchedule(input, this.now());
    const store = await this.store(project);
    const asks = project.autonomy !== "decide";
    const job = await store.add({ title: input.title, instructions: input.instructions, schedule, state: asks ? "proposed" : "active" }, this.now());
    this.changed(project);
    const said = describeSchedule(schedule);
    if (asks) {
      await this.human(project, `${JOB_PREFIX.proposed} ${job.id} "${job.title}", ${said}. Approve it in the Plan tab (Scheduled jobs) or in Needs you.`);
      return `Proposed as ${job.id} (${said}): it starts once the human approves it; you'll get a note. Tell them briefly what it does.`;
    }
    await this.human(project, `${JOB_PREFIX.scheduled} ${job.id} "${job.title}", ${said}; first run ${when(job.nextRun)}. It's in the Plan tab (Scheduled jobs).`);
    return `Scheduled as ${job.id} (${said}); first run ${when(job.nextRun)}. Symbio wakes you with it when it's due; report each run with report_job.`;
  }

  async change(project: Project, id: string, input: { title?: unknown; instructions?: unknown; every?: unknown; at?: unknown; days?: unknown; day?: unknown; interval?: unknown; date?: unknown; paused?: unknown }): Promise<string> {
    const store = await this.store(project);
    const job = store.job(id);
    if (typeof input.title === "string" && input.title.trim()) job.title = input.title.trim().slice(0, 200);
    if (typeof input.instructions === "string" && input.instructions.trim()) job.instructions = input.instructions.trim().slice(0, 4000);
    if (input.every !== undefined) {
      job.schedule = parseSchedule(input, this.now());
      job.nextRun = nextRun(job.schedule, this.now());
    }
    if (typeof input.paused === "boolean" && job.state !== "proposed") {
      job.state = input.paused ? "paused" : "active";
      if (!input.paused) job.nextRun = nextRun(job.schedule, this.now());
    }
    await store.save();
    this.changed(project);
    return `${job.id} "${job.title}": ${describeSchedule(job.schedule)}, ${job.state}${job.state === "active" ? `, next run ${when(job.nextRun)}` : ""}.`;
  }

  async remove(project: Project, id: string, by: "core" | "human"): Promise<string> {
    const store = await this.store(project);
    const job = store.job(id);
    await store.remove(job);
    this.changed(project);
    if (by === "human") await this.tellCore(project, `Symbio: the human removed scheduled job ${job.id} "${job.title}".`);
    else await this.human(project, `Removed ${job.id} "${job.title}" from the scheduled jobs.`);
    return `Removed ${job.id}.`;
  }

  async report(project: Project, id: string, outcome: "done" | "failed", summary: string): Promise<string> {
    const store = await this.store(project);
    const job = store.job(id);
    const run = [...job.runs].reverse().find((r) => r.status === "running");
    if (!run) throw new Error(`No run of ${job.id} is under way: Symbio starts runs when they're due (or the human starts one).`);
    run.status = outcome;
    run.note = summary.trim().slice(0, 4000) || undefined;
    run.endedAt = this.now();
    await store.save();
    this.changed(project);
    await this.human(project, `${outcome === "done" ? JOB_PREFIX.done : JOB_PREFIX.failed} ${job.id} "${job.title}" (run ${run.n})${run.note ? `: ${run.note}` : "."}`);
    return `Recorded run ${run.n} of ${job.id} as ${outcome}. ${job.state === "active" ? `Next run ${when(job.nextRun)}.` : ""}`.trim();
  }

  async describe(project: Project): Promise<string> {
    const jobs = (await this.store(project)).jobs;
    if (!jobs.length) return "No scheduled jobs.";
    return jobs
      .map((j) => {
        const last = j.runs.at(-1);
        return (
          `${j.id} "${j.title}" — ${describeSchedule(j.schedule)}, ${j.state}${j.state === "active" ? `, next ${when(j.nextRun)}` : ""}` +
          (last ? `\n  last run ${last.n}: ${last.status}${last.note ? ` — ${last.note.slice(0, 200)}` : ""}` : "") +
          `\n  instructions: ${j.instructions.slice(0, 300)}${j.instructions.length > 300 ? "…" : ""}`
        );
      })
      .join("\n");
  }

  // ---- the human's actions

  async approve(project: Project, id: string) {
    const store = await this.store(project);
    const job = store.job(id);
    if (job.state !== "proposed") throw new Error(`${job.id} isn't waiting for approval.`);
    job.state = "active";
    job.nextRun = nextRun(job.schedule, this.now());
    await store.save();
    this.changed(project);
    await this.tellCore(project, `Symbio: the human approved scheduled job ${job.id} "${job.title}"; first run ${when(job.nextRun)}.`);
  }

  async setPaused(project: Project, id: string, paused: boolean) {
    const store = await this.store(project);
    const job = store.job(id);
    if (job.state === "proposed") throw new Error(`${job.id} is waiting for approval.`);
    job.state = paused ? "paused" : "active";
    if (!paused) job.nextRun = nextRun(job.schedule, this.now());
    await store.save();
    this.changed(project);
  }

  async runNow(project: Project, id: string) {
    const store = await this.store(project);
    const job = store.job(id);
    if (job.state === "proposed") throw new Error(`${job.id} is waiting for approval.`);
    const why = await this.due(project, job, "manual");
    if (why) throw new Error(`It can't start now: ${why}.`);
  }

  private async tellCore(project: Project, text: string) {
    const core = this.team.coordinator(project);
    // A note for its next turn: nothing to do about it now.
    if (core && active(core)) await this.team.system(project, core, text, false).catch(() => {});
  }
}
