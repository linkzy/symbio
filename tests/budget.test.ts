import { test } from "node:test";
import assert from "node:assert/strict";
import { Budgets, localDay, money } from "../src/server/team/budget.js";
import { emptyUsage, type Price } from "../src/server/costs.js";
import type { Project } from "../src/server/store.js";

function setup(budget: Project["budget"], start = new Date(2026, 10, 25, 10).getTime()) {
  const project = { id: "p1", name: "Site", agents: [], budget } as unknown as Project;
  let cost = 0;
  let now = start;
  let reliable = true;
  // One token costs $1, so a cost reads as tokens.
  let price: Price | null = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 };
  const human: string[] = [];
  const core: { text: string; wake: boolean }[] = [];
  const events: string[] = [];
  const budgets = new Budgets(
    {
      projects: () => [project],
      spent: async () => ({ cost: price ? cost : 0, models: [{ model: "m", usage: { ...emptyUsage(), input: cost }, price }], reliable }),
      pause: async (p) => {
        p.paused = true;
        events.push("pause");
      },
      resume: async (p) => {
        budgets.resumed(p);
        p.paused = false;
        events.push("resume");
      },
      tellHuman: async (_p, text) => void human.push(text),
      tellCore: async (_p, text, wake) => void core.push({ text, wake }),
      save: async () => {},
    },
    () => now,
  );
  return {
    project,
    budgets,
    human,
    core,
    events,
    spend: async (to: number) => {
      cost = to;
      await budgets.check(project);
    },
    later: (ms: number) => (now += ms),
    unreliable: (on: boolean) => (reliable = !on),
    price: (p: Price | null) => (price = p),
  };
}

test("near the project's limit the human and core are told once; at it the team pauses, and resuming goes on past it", async () => {
  const s = setup({ total: 10 });
  await s.spend(5);
  assert.deepEqual(s.human, []);
  await s.spend(8.2);
  await s.spend(8.5);
  assert.deepEqual(s.human, ["82% of the project's budget is used ($8.20 of $10). At the limit, Symbio pauses the team."]);
  assert.equal(s.core.length, 1);
  assert.equal(s.core[0].wake, false, "a note for core's next turn, not a new turn");

  await s.spend(10.4);
  assert.deepEqual(s.events, ["pause"]);
  assert.equal(s.project.budgetState?.pausedFor, "total");
  assert.match(s.human[1], /^Paused: the project's budget is reached \(\$10\.40 of \$10\)\. Raise the limit/);
  assert.equal(s.core[1].wake, true, "held until the team goes on");

  // The human resumes past the limit: it doesn't pause the team again.
  s.project.paused = false;
  s.budgets.resumed(s.project);
  await s.spend(12);
  assert.deepEqual(s.events, ["pause"]);
  assert.equal(s.human.length, 2);
});

test("raising the limit while paused resumes the team; a new limit is checked again", async () => {
  const s = setup({ total: 1 });
  await s.spend(1.5);
  assert.deepEqual(s.events, ["pause"]);
  s.project.budget = { total: 3 };
  await s.budgets.check(s.project);
  assert.deepEqual(s.events, ["pause", "resume"]);
  assert.match(s.human.at(-1)!, /raised, so the team was resumed/);
  await s.spend(3.2);
  assert.deepEqual(s.events, ["pause", "resume", "pause"]);
});

test("a daily limit counts from the day's start, and its pause ends by itself the next day", async () => {
  const s = setup({ daily: 2 });
  await s.spend(40); // spent before today's first check: not today's
  await s.spend(41);
  assert.deepEqual(s.events, []);
  await s.spend(42.1);
  assert.deepEqual(s.events, ["pause"]);
  assert.match(s.human.at(-1)!, /today's budget is reached \(\$2\.10 of \$2\)\. The team resumes by itself tomorrow/);

  s.later(24 * 3600_000);
  await s.spend(42.1);
  assert.deepEqual(s.events, ["pause", "resume"]);
  assert.match(s.human.at(-1)!, /A new day/);
  assert.equal(s.project.budgetState?.day, localDay(new Date(2026, 10, 26, 10).getTime()));
  await s.spend(43.5);
  assert.deepEqual(s.events, ["pause", "resume"], "$1.40 today: under the limit");
  assert.equal((await s.budgets.status(s.project)).today, 43.5 - 42.1);
});

test("without the runtimes' prices (just restarted) nothing is judged; the day still starts from the tokens used", async () => {
  const s = setup({ daily: 1 });
  s.unreliable(true);
  await s.spend(30);
  await s.spend(31.5);
  assert.deepEqual(s.events, []);
  s.unreliable(false);
  await s.spend(31.5);
  assert.deepEqual(s.events, ["pause"], "$1.50 since the day began");
});

test("a price set later doesn't turn past use into today's spending", async () => {
  const s = setup({ daily: 5 });
  s.price(null);
  await s.spend(30); // 30 tokens, no price yet: not counted
  s.price({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 });
  await s.spend(31);
  assert.deepEqual(s.events, []);
  assert.equal((await s.budgets.status(s.project)).today, 1);
});

test("the project's limit reached during a daily pause keeps the team paused the next day", async () => {
  const s = setup({ daily: 2, total: 10 });
  await s.spend(0);
  await s.spend(2.5);
  assert.equal(s.project.budgetState?.pausedFor, "daily");
  await s.spend(10.5); // interrupted turns still report what they used
  assert.equal(s.project.budgetState?.pausedFor, "total");
  s.later(24 * 3600_000);
  await s.spend(10.5);
  assert.deepEqual(s.events, ["pause"]);
  assert.equal(s.project.paused, true);
});

test("money reads like money", () => {
  assert.equal(money(250), "$250");
  assert.equal(money(3.4), "$3.40");
  assert.equal(money(0.0021), "$0.0021");
  assert.equal(money(0), "$0");
  assert.equal(money(10), "$10");
});
