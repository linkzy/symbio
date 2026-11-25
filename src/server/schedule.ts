// Scheduled jobs: recurring (or one-off) work core set up at the human's request ("refresh the data
// every night", "check the site every Monday"). When one is due, Symbio wakes core with it (see
// team/schedules.ts); core reports how the run went. Kept in .symbio/schedules.json. Times are the
// computer's local time.

import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export type JobSchedule =
  | { every: "hours"; interval: number }
  | { every: "day"; at: string }
  | { every: "week"; days: number[]; at: string }
  | { every: "month"; day: number; at: string }
  | { once: string }; // local date and time, "2026-11-26T09:00"

export interface JobRun {
  n: number;
  /** When it started (or was skipped). */
  at: number;
  /** "manual": the human's Run now. */
  by?: "schedule" | "manual";
  status: "running" | "done" | "failed" | "skipped" | "no-report";
  /** core's report, or why it was skipped. */
  note?: string;
  endedAt?: number;
}

export interface Job {
  id: string; // J1, J2…
  title: string;
  /** What core should do on each run, written so it can start from it alone. */
  instructions: string;
  schedule: JobSchedule;
  /** "proposed": waits for the human's approval (projects that ask). "paused": by the human. */
  state: "proposed" | "active" | "paused";
  nextRun: number | null;
  runs: JobRun[];
  createdAt: number;
}

const KEEP_RUNS = 20;
const MAX_INSTRUCTIONS = 4000;
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "07:30" → [7, 30]. */
function hm(at: string): [number, number] {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at.trim());
  if (!m) throw new Error(`"${at}" isn't a time of day: write it as HH:MM (24 hours), e.g. 07:30.`);
  return [Number(m[1]), Number(m[2])];
}

const at = (base: Date, [h, m]: [number, number]) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0);

/** The next time a schedule is due, strictly after `after` (null: a one-off already past). */
export function nextRun(s: JobSchedule, after: number): number | null {
  if ("once" in s) {
    const t = parseLocal(s.once);
    return t > after ? t : null;
  }
  if (s.every === "hours") return after + s.interval * 3_600_000;
  const time = hm(s.at);
  const from = new Date(after);
  if (s.every === "day" || s.every === "week") {
    for (let i = 0; i <= 8; i++) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      if (s.every === "week" && !s.days.includes(day.getDay())) continue;
      const t = at(day, time).getTime();
      if (t > after) return t;
    }
    return null;
  }
  for (let i = 0; i <= 2; i++) {
    const t = at(new Date(from.getFullYear(), from.getMonth() + i, s.day), time).getTime();
    if (t > after) return t;
  }
  return null;
}

/** "2026-11-26T09:00" (local) → ms. */
function parseLocal(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" isn't a date and time: write it as YYYY-MM-DD HH:MM.`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

/** How a person would say it: "every day at 07:00", "every Monday and Thursday at 09:30". */
export function describeSchedule(s: JobSchedule): string {
  if ("once" in s) return `once, on ${s.once.replace("T", " at ")}`;
  if (s.every === "hours") return s.interval === 1 ? "every hour" : `every ${s.interval} hours`;
  if (s.every === "day") return `every day at ${s.at}`;
  if (s.every === "week") {
    const names = [...s.days].sort().map((d) => WEEKDAY_NAMES[d]);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    return `every ${list} at ${s.at}`;
  }
  return `every month on day ${s.day} at ${s.at}`;
}

/** The schedule core described (the schedule_job tool's fields), checked. */
export function parseSchedule(input: { every?: unknown; at?: unknown; days?: unknown; day?: unknown; interval?: unknown; date?: unknown }, now = Date.now()): JobSchedule {
  const every = String(input.every ?? "");
  const time = () => {
    const text = typeof input.at === "string" && input.at.trim() ? input.at.trim() : "";
    if (!text) throw new Error("Give `at`, the time of day (HH:MM, 24 hours, the computer's time).");
    const [h, m] = hm(text);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  switch (every) {
    case "hours": {
      const interval = Number(input.interval ?? 1);
      if (!Number.isInteger(interval) || interval < 1 || interval > 24) throw new Error("`interval` is a whole number of hours from 1 to 24.");
      return { every: "hours", interval };
    }
    case "day":
      return { every: "day", at: time() };
    case "week": {
      const given = Array.isArray(input.days) ? input.days : typeof input.days === "string" ? input.days.split(/[,\s]+/) : [];
      const days = [...new Set(given.map((d) => WEEKDAYS.indexOf(String(d).trim().slice(0, 3).toLowerCase() as (typeof WEEKDAYS)[number])))];
      if (!days.length || days.includes(-1)) throw new Error("`days` lists weekdays: mon, tue, wed, thu, fri, sat, sun.");
      return { every: "week", days: days.sort(), at: time() };
    }
    case "month": {
      const day = Number(input.day);
      if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error("`day` is the day of the month, 1 to 28 (every month has those).");
      return { every: "month", day, at: time() };
    }
    case "once": {
      const date = typeof input.date === "string" ? input.date.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Give `date` (YYYY-MM-DD) with `at` for a one-off job.");
      const once = `${date}T${time()}`;
      if (parseLocal(once) <= now) throw new Error(`${once.replace("T", " ")} has already passed.`);
      return { once };
    }
    default:
      throw new Error('`every` is "hours", "day", "week", "month" or "once".');
  }
}

export class ScheduleStore {
  jobs: Job[] = [];

  private constructor(private readonly file: string) {}

  static async load(projectDir: string): Promise<ScheduleStore> {
    const store = new ScheduleStore(path.join(projectDir, ".symbio", "schedules.json"));
    try {
      store.jobs = JSON.parse(await fs.readFile(store.file, "utf8")).jobs ?? [];
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    return store;
  }

  job(id: string): Job {
    const job = this.jobs.find((j) => j.id.toLowerCase() === id.trim().toLowerCase());
    if (!job) throw new Error(`No job ${id}. Jobs: ${this.jobs.map((j) => j.id).join(", ") || "none"}.`);
    return job;
  }

  async add(input: { title: string; instructions: string; schedule: JobSchedule; state: Job["state"] }, now = Date.now()): Promise<Job> {
    const title = input.title.trim().slice(0, 200);
    const instructions = input.instructions.trim().slice(0, MAX_INSTRUCTIONS);
    if (!title) throw new Error("A job needs a title.");
    if (!instructions) throw new Error("A job needs instructions: what to do on each run.");
    const n = Math.max(0, ...this.jobs.map((j) => Number(j.id.slice(1)) || 0)) + 1;
    const job: Job = { id: `J${n}`, title, instructions, schedule: input.schedule, state: input.state, nextRun: nextRun(input.schedule, now), runs: [], createdAt: now };
    this.jobs.push(job);
    await this.save();
    return job;
  }

  /** A run starts (or is skipped); the job moves on to its next time. */
  async startRun(job: Job, run: Omit<JobRun, "n">, now = Date.now(), advance = true): Promise<JobRun> {
    const entry: JobRun = { n: (job.runs.at(-1)?.n ?? 0) + 1, ...run };
    job.runs.push(entry);
    // The oldest go, but never a run that's still under way (its report must find it).
    while (job.runs.length > KEEP_RUNS) {
      const old = job.runs.findIndex((r) => r.status !== "running");
      if (old < 0) break;
      job.runs.splice(old, 1);
    }
    if (advance) job.nextRun = nextRun(job.schedule, now);
    await this.save();
    return entry;
  }

  async remove(job: Job) {
    this.jobs = this.jobs.filter((j) => j !== job);
    await this.save();
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify({ jobs: this.jobs }, null, 2));
  }
}
