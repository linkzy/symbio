// Average tokens per day for the price simulator: per project over its days, and split core / helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { averageDailyUsage } from "../src/server/costs.js";

const DAY = 86_400_000;
const usage = (cacheRead: number, output: number) => ({ cost: 0, input: 0, output, reasoning: 0, cacheRead, cacheWrite: 0 });

test("tokens per day, across projects and split between core and helpers", () => {
  const now = Date.now();
  const projects = [
    {
      name: "A",
      createdAt: now - 10 * DAY,
      agents: [
        { role: "coordinator", model: "m/core", usageByModel: { "m/core": usage(1000, 10) } },
        { role: "worker", model: "m/cheap", usageByModel: { "m/cheap": usage(2000, 20), "m/core": usage(500, 0) } },
      ],
    },
    { name: "B", createdAt: now - 2 * DAY, agents: [{ role: "coordinator", model: "m/core", usageByModel: { "m/core": usage(200, 2) } }] },
  ] as any[];
  const avg = averageDailyUsage(projects, now);
  // A: 3500 cache reads over 10 days = 350/day; B: 200 over 2 days = 100/day.
  assert.equal(Math.round(avg.perDay.cacheRead), 450);
  assert.equal(Math.round(avg.byRole.core.cacheRead), 200, "A's core 100/day + B's core 100/day");
  assert.equal(Math.round(avg.byRole.helpers.cacheRead), 250, "A's helper, both models");
  assert.equal(Math.round(avg.byRole.core.output + avg.byRole.helpers.output), Math.round(avg.perDay.output));
  assert.deepEqual(
    avg.projects.map((p) => [p.name, p.days]),
    [
      ["A", 10],
      ["B", 2],
    ],
  );
});
