// Spending limits per project (Project.budget): for the whole project and per day, in USD of the
// estimated cost Symbio already tracks (costs.ts). At a share of a limit (80% unless set) the human
// and core are told; at the limit the team is paused and the human told. A daily pause ends by itself
// when the day changes; a raised limit resumes the team; resuming it past the limit means the human
// wants to go on, so that limit doesn't pause it again.
//
// Symbio keeps totals, not a history: "today" is the tokens used since the day's first check, per
// model, at today's prices (so a price set later doesn't turn past use into today's spending). Models
// without a price don't count, as in the usage report.

import { costOf, emptyUsage, type Price, type Usage } from "../costs.js";
import type { Budget, BudgetState, Project } from "../store.js";

export interface Spending {
  /** The project's estimated cost so far. */
  cost: number;
  /** Its use per model, and the price it's counted at (none: not counted). */
  models: { model: string; usage: Usage; price: Price | null }[];
  /** The runtimes' prices are known (after a restart they may not be yet): until then nothing is judged. */
  reliable: boolean;
}

export interface BudgetHost {
  projects(): Project[];
  spent(project: Project): Promise<Spending>;
  pause(project: Project): Promise<void>;
  resume(project: Project): Promise<void>;
  /** A line for the human (Messages, and a notification). */
  tellHuman(project: Project, text: string): Promise<void>;
  /** A note for core: `wake` starts a turn (held while the team is paused). */
  tellCore(project: Project, text: string, wake: boolean): Promise<void>;
  save(project: Project): Promise<void>;
}

/** The computer's local day, as "2026-11-25". */
export function localDay(t = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Dollars as people read them: $12, $3.40, $0.0021. */
export function money(n: number): string {
  if (n >= 100 || Number.isInteger(n)) return `$${n.toFixed(0)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${Number(n.toPrecision(2))}`;
}

/** What a pause notice starts with (notifier.ts tells a pause from a warning by it). */
export const BUDGET_PAUSED = "Paused:";

const USAGE_KEYS = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cost"] as const;

/** Today's cost: each model's tokens since the day began, at its price now. */
export function todayCost(spending: Spending, dayTokens: BudgetState["dayTokens"]): number {
  let total = 0;
  for (const m of spending.models) {
    if (!m.price) continue;
    const start = dayTokens[m.model] ?? emptyUsage();
    const since = emptyUsage();
    // An agent removed since the morning takes its tokens with it: never below zero.
    for (const k of USAGE_KEYS) since[k] = Math.max(0, (m.usage[k] ?? 0) - (start[k] ?? 0));
    total += costOf(since, m.price) ?? 0;
  }
  return total;
}

const snapshot = (spending: Spending): BudgetState["dayTokens"] => Object.fromEntries(spending.models.map((m) => [m.model, { ...m.usage }]));

interface Limit {
  kind: "total" | "daily";
  spent: number;
  limit: number;
  key: string;
  label: string;
}

const CHECK_EVERY_MS = 60_000;

export class Budgets {
  private running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: BudgetHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks every minute: the day changes even when nobody works. */
  start() {
    this.timer ??= setInterval(() => {
      for (const project of this.host.projects()) if (project.budget || project.budgetState?.pausedFor) void this.check(project).catch(() => {});
    }, CHECK_EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Where the project stands: what it spent in all and today, against its limits. */
  async status(project: Project) {
    const spending = await this.host.spent(project);
    const state = project.budgetState;
    const today = state?.day === localDay(this.now()) && state.dayTokens ? todayCost(spending, state.dayTokens) : 0;
    return { budget: project.budget ?? null, spent: spending.cost, today, pausedFor: state?.pausedFor ?? null };
  }

  /** One check at a time per project (usage arrives in bursts); a check asked for meanwhile runs after. */
  check(project: Project): Promise<void> {
    const previous = this.running.get(project.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.run(project));
    this.running.set(project.id, next);
    void next.finally(() => {
      if (this.running.get(project.id) === next) this.running.delete(project.id);
    });
    return next;
  }

  /** The human resumes the team: past the limit that paused it, that's their choice to go on. */
  resumed(project: Project) {
    const state = project.budgetState;
    if (!state?.pausedFor) return;
    const key = this.limits(project, 0, 0).find((l) => l.kind === state.pausedFor)?.key;
    if (key && !state.overridden.includes(key)) state.overridden.push(key);
    state.pausedFor = undefined;
  }

  private limits(project: Project, cost: number, today: number): Limit[] {
    const budget: Budget = project.budget ?? {};
    const day = project.budgetState?.day ?? localDay(this.now());
    const out: Limit[] = [];
    if (budget.total) out.push({ kind: "total", spent: cost, limit: budget.total, key: `total:${budget.total}`, label: "the project's budget" });
    if (budget.daily) out.push({ kind: "daily", spent: today, limit: budget.daily, key: `daily:${day}:${budget.daily}`, label: "today's budget" });
    return out;
  }

  /** A limit that holds the team: reached, and not one the human chose to go past. */
  private holding(state: BudgetState, l: Limit) {
    return l.spent >= l.limit && !state.overridden.includes(l.key);
  }

  private async run(project: Project) {
    const spending = await this.host.spent(project);
    const { cost, reliable } = spending;
    const day = localDay(this.now());
    let state: BudgetState | undefined = project.budgetState;
    let changed = false;

    if (!state || state.day !== day || !state.dayTokens) {
      const pausedDaily = state?.pausedFor === "daily" && project.paused;
      const keep = (keys: string[] | undefined) => (keys ?? []).filter((k) => !k.startsWith("daily:"));
      state = {
        day,
        dayTokens: snapshot(spending),
        warned: keep(state?.warned),
        reached: keep(state?.reached),
        overridden: keep(state?.overridden),
        ...(state?.pausedFor === "total" ? { pausedFor: "total" as const } : {}),
      };
      project.budgetState = state;
      changed = true;
      if (pausedDaily) {
        // A new day ends a daily pause, unless the project's own limit holds the team too.
        const total = this.limits(project, cost, 0).find((l) => l.kind === "total");
        if (reliable && total && this.holding(state, total)) {
          state.pausedFor = "total";
        } else {
          await this.host.save(project);
          await this.host.tellHuman(project, "A new day: today's budget starts again, so the team was resumed.");
          await this.host.resume(project);
          changed = false;
        }
      }
    }
    if (!reliable) {
      if (changed) await this.host.save(project);
      return;
    }

    const limits = this.limits(project, cost, todayCost(spending, state.dayTokens));

    // Paused for a limit that was raised (or removed) since: the team goes on, unless another holds it.
    if (state.pausedFor && project.paused) {
      const limit = limits.find((l) => l.kind === state!.pausedFor);
      if (!limit || limit.spent < limit.limit) {
        const other = limits.find((l) => l.kind !== state!.pausedFor && this.holding(state!, l));
        if (other) state.pausedFor = other.kind;
        else {
          state.pausedFor = undefined;
          await this.host.save(project);
          await this.host.tellHuman(project, `The budget was ${limit ? "raised" : "removed"}, so the team was resumed.`);
          await this.host.resume(project);
        }
        changed = true;
      }
    }

    const warnAt = (project.budget?.warnAt ?? 80) / 100;
    for (const l of limits) {
      if (l.spent >= l.limit) {
        if (state.reached.includes(l.key) || state.overridden.includes(l.key)) continue;
        state.reached.push(l.key);
        if (!state.warned.includes(l.key)) state.warned.push(l.key);
        changed = true;
        const pausing = !project.paused;
        // Whatever paused the team, it's held by this limit now (the project's own outlasts a day's).
        if (state.pausedFor !== "total") state.pausedFor = l.kind;
        await this.host.save(project);
        if (pausing) await this.host.pause(project);
        const then =
          l.kind === "daily"
            ? "The team resumes by itself tomorrow, or now if you raise the limit (the project's settings) or resume it."
            : "Raise the limit in the project's settings to go on, or resume the team to keep going past it.";
        await this.host.tellHuman(project, `${BUDGET_PAUSED} ${l.label} is reached (${money(l.spent)} of ${money(l.limit)}). ${then}`);
        // Held while the team is paused: core reads it when the work goes on.
        await this.host.tellCore(
          project,
          `Symbio: ${l.label} (${money(l.limit)}) was reached and the team was paused; it's running again now. Spend carefully: finish ` +
            "what's under way, prefer cheaper models and fewer helpers, and leave large new work for the human to decide.",
          true,
        );
      } else if (l.spent >= l.limit * warnAt && !state.warned.includes(l.key)) {
        state.warned.push(l.key);
        changed = true;
        const pct = Math.round((l.spent / l.limit) * 100);
        await this.host.save(project);
        await this.host.tellHuman(project, `${pct}% of ${l.label} is used (${money(l.spent)} of ${money(l.limit)}). At the limit, Symbio pauses the team.`);
        await this.host.tellCore(
          project,
          `Symbio: ${pct}% of ${l.label} is used (${money(l.spent)} of ${money(l.limit)}); at the limit Symbio pauses the team. Finish ` +
            "what's under way first, prefer cheaper models and fewer helpers, and don't start large new work unless it's needed.",
          false,
        );
      }
    }
    if (changed) await this.host.save(project);
  }
}
