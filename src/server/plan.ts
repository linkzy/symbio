// The project plan: tasks with dependencies, assignees and status. Drives the
// kanban. The coordinator proposes it, the human approves it, agents update it.

import { promises as fs } from "node:fs";
import path from "node:path";

export const TASK_STATUSES = ["todo", "in-progress", "blocked", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskNote {
  time: number;
  by: string; // agent name, "human" or "symbio"
  text: string;
}

export interface Task {
  id: string; // T1, T2…
  title: string;
  description: string;
  assignee: string | null; // agent id
  status: TaskStatus;
  dependsOn: string[];
  assets: string[];
  notes: TaskNote[];
  createdAt: number;
  updatedAt: number;
}

export interface Plan {
  goal: string;
  /** none: no plan yet · proposed: waiting for the human · approved · changes-requested */
  status: "none" | "proposed" | "approved" | "changes-requested";
  revision: number;
  feedback: string | null;
  tasks: Task[];
  updatedAt: number;
}

export interface TaskInput {
  key?: string;
  title: string;
  description?: string;
  depends_on?: string[];
  assets?: string[];
}

const emptyPlan = (): Plan => ({ goal: "", status: "none", revision: 0, feedback: null, tasks: [], updatedAt: Date.now() });

export class PlanStore {
  plan: Plan = emptyPlan();

  private constructor(private readonly file: string) {}

  static async load(projectDir: string): Promise<PlanStore> {
    const store = new PlanStore(path.join(projectDir, ".symbio", "plan.json"));
    try {
      store.plan = { ...emptyPlan(), ...JSON.parse(await fs.readFile(store.file, "utf8")) };
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    return store;
  }

  task(id: string): Task {
    const key = id.trim().toUpperCase();
    const task = this.plan.tasks.find((t) => t.id === key);
    if (!task) throw new Error(`No task "${id}". Tasks: ${this.plan.tasks.map((t) => t.id).join(", ") || "none"}.`);
    return task;
  }

  /**
   * Replaces the plan with a new proposal. Tasks that already started keep their
   * progress when a proposal reuses their id as key (revisions of an approved plan).
   */
  async propose(goal: string, inputs: TaskInput[]): Promise<Plan> {
    if (inputs.length === 0) throw new Error("A plan needs at least one task.");
    const now = Date.now();
    const previous = new Map(this.plan.tasks.map((t) => [t.id, t]));
    // Map the coordinator's keys (or existing ids) to task ids.
    const ids = new Map<string, string>();
    let next = Math.max(0, ...this.plan.tasks.map((t) => Number(t.id.slice(1)) || 0)) + 1;
    for (const input of inputs) {
      const key = (input.key ?? input.title).trim();
      const reuse = previous.has(key.toUpperCase()) ? key.toUpperCase() : null;
      ids.set(key, reuse ?? `T${next++}`);
    }
    const resolve = (ref: string) => ids.get(ref.trim()) ?? (previous.has(ref.trim().toUpperCase()) ? ref.trim().toUpperCase() : null);

    const tasks: Task[] = inputs.map((input) => {
      const id = ids.get((input.key ?? input.title).trim())!;
      const old = previous.get(id);
      const dependsOn = (input.depends_on ?? []).map((d) => {
        const r = resolve(d);
        if (!r) throw new Error(`Task "${input.title}" depends on unknown task "${d}".`);
        return r;
      });
      return {
        id,
        title: input.title.trim(),
        description: (input.description ?? "").trim(),
        assignee: old?.assignee ?? null,
        status: old?.status ?? "todo",
        dependsOn,
        assets: input.assets ?? [],
        notes: old?.notes ?? [],
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
    });
    this.assertNoCycles(tasks);

    this.plan = {
      goal: goal.trim(),
      status: "proposed",
      revision: this.plan.revision + 1,
      feedback: null,
      tasks,
      updatedAt: now,
    };
    await this.save();
    return this.plan;
  }

  async decide(approved: boolean, feedback: string | null): Promise<Plan> {
    if (this.plan.status !== "proposed") throw new Error("There is no proposed plan to decide on.");
    this.plan.status = approved ? "approved" : "changes-requested";
    this.plan.feedback = feedback?.trim() || null;
    this.plan.updatedAt = Date.now();
    await this.save();
    return this.plan;
  }

  async addTask(input: TaskInput): Promise<Task> {
    const next = Math.max(0, ...this.plan.tasks.map((t) => Number(t.id.slice(1)) || 0)) + 1;
    const now = Date.now();
    const task: Task = {
      id: `T${next}`,
      title: input.title.trim(),
      description: (input.description ?? "").trim(),
      assignee: null,
      status: "todo",
      dependsOn: (input.depends_on ?? []).map((d) => this.task(d).id),
      assets: input.assets ?? [],
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    this.plan.tasks.push(task);
    if (this.plan.status === "none") this.plan.status = "approved"; // ad-hoc tasks without a formal plan
    this.plan.updatedAt = now;
    await this.save();
    return task;
  }

  async update(id: string, change: { status?: TaskStatus; assignee?: string | null; note?: { by: string; text: string } }) {
    const task = this.task(id);
    if (change.status) {
      if (!TASK_STATUSES.includes(change.status)) throw new Error(`Status must be one of: ${TASK_STATUSES.join(", ")}.`);
      task.status = change.status;
    }
    if (change.assignee !== undefined) task.assignee = change.assignee;
    if (change.note?.text.trim()) task.notes.push({ time: Date.now(), by: change.note.by, text: change.note.text.trim() });
    task.updatedAt = Date.now();
    this.plan.updatedAt = task.updatedAt;
    await this.save();
    return task;
  }

  /** Dependencies of a task that aren't done yet. */
  openDependencies(task: Task): Task[] {
    return task.dependsOn.map((d) => this.plan.tasks.find((t) => t.id === d)).filter((t): t is Task => !!t && t.status !== "done");
  }

  private assertNoCycles(tasks: Task[]) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, trail: string[]) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) throw new Error(`Circular dependency: ${[...trail, id].join(" → ")}`);
      state.set(id, 1);
      for (const d of byId.get(id)?.dependsOn ?? []) visit(d, [...trail, id]);
      state.set(id, 2);
    };
    for (const t of tasks) visit(t.id, []);
  }

  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.plan, null, 2));
    await fs.rename(tmp, this.file);
  }
}

export function describeTask(t: Task, assigneeName: (id: string) => string | undefined): string {
  const who = t.assignee ? (assigneeName(t.assignee) ?? "?") : "unassigned";
  const deps = t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : "";
  const assets = t.assets.length ? ` · assets: ${t.assets.join(", ")}` : "";
  return `${t.id} [${t.status}] ${t.title} — ${who}${deps}${assets}`;
}
