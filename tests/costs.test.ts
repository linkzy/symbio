import assert from "node:assert/strict";
import { test } from "node:test";
import { accountUsage, costOf, projectUsage, resolvePrices, type Usage } from "../src/server/costs.js";

const u = (input: number, output: number, cacheRead: number, cacheWrite: number): Usage => ({ cost: 0, input, output, reasoning: 0, cacheRead, cacheWrite });

test("usage is attributed to the model the agent was on, across model switches and new sessions", () => {
  // An agent from before per-model tracking: its whole history goes to its current model.
  const agent: any = { id: "a", name: "regras", model: "foundry/opus", usage: u(10, 100, 1000, 50), status: "idle" };
  accountUsage(agent, agent.usage);
  assert.deepEqual(agent.usageByModel["foundry/opus"], u(10, 100, 1000, 50));

  // More work on the same session, same model: only the increase is added.
  accountUsage(agent, u(12, 150, 1500, 60));
  assert.deepEqual(agent.usageByModel["foundry/opus"], u(12, 150, 1500, 60));

  // Switched to Sonnet: what comes next is Sonnet's.
  agent.model = "foundry/sonnet";
  accountUsage(agent, u(13, 170, 1700, 70));
  assert.deepEqual(agent.usageByModel["foundry/sonnet"], u(1, 20, 200, 10));
  assert.deepEqual(agent.usageByModel["foundry/opus"], u(12, 150, 1500, 60), "earlier usage stays with Opus");

  // A fresh session starts counting from zero again: totals going down mean a new session.
  accountUsage(agent, u(1, 5, 30, 2));
  assert.deepEqual(agent.usageByModel["foundry/sonnet"], u(2, 25, 230, 12));
});

test("cost: output includes reasoning, prices are per million tokens", () => {
  const price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
  assert.equal(costOf({ ...u(1_000_000, 1_000_000, 10_000_000, 1_000_000), reasoning: 1_000_000 }, price), 4 + 40 + 2 + 5);
  assert.equal(costOf(u(1, 1, 1, 1), undefined), null, "unknown price → no estimate");
});

test("prices: the user's own first, then OpenCode's, then a suggestion from the same model name", () => {
  const catalog = [
    { providerID: "opencode", id: "claude-opus-5-5", cost: [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }] },
    { providerID: "anthropic", id: "claude-opus-5-5", cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }] },
    { providerID: "foundry", id: "code-claude-opus-5-5", cost: [] },
    { providerID: "foundry", id: "code-claude-sonnet-5-5", cost: [] },
    { providerID: "nvidia", id: "glm-5.3", cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
  ];
  const r = resolvePrices(
    ["foundry/code-claude-opus-5-5", "foundry/code-claude-sonnet-5-5", "nvidia/glm-5.3", "x/mine"],
    { "x/mine": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    catalog,
  );
  assert.equal(r["foundry/code-claude-opus-5-5"].source, "suggested");
  assert.equal(r["foundry/code-claude-opus-5-5"].from, "anthropic/claude-opus-5-5", "prefers the model maker's own price");
  assert.equal(r["foundry/code-claude-sonnet-5-5"].source, "none", "no price anywhere → none");
  assert.equal(r["nvidia/glm-5.3"].source, "opencode");
  assert.equal(r["x/mine"].source, "yours");
});

test("project usage sums every agent, including stopped ones, and lists unpriced models", () => {
  const project: any = {
    agents: [
      { id: "1", name: "core", status: "idle", model: "p/a", usageByModel: { "p/a": u(0, 1_000_000, 0, 0) } },
      { id: "2", name: "old", status: "stopped", model: "p/b", usageByModel: { "p/b": u(0, 0, 2_000_000, 0) } },
    ],
  };
  const report = projectUsage(project, {
    "p/a": { price: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }, source: "yours" },
    "p/b": { price: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, source: "suggested", from: "x/b" },
  });
  assert.equal(report.tokens, 3_000_000);
  assert.equal(report.cost, 10);
  assert.deepEqual(report.unpriced, ["p/b"], "a suggestion isn't a price until the user accepts it");
});
