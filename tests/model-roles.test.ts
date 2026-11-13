// Which models core and helpers may use: crowns (core's) and locks (core only).
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultModel, modelsFor } from "../src/server/store.js";

const foundry = ["foundry/opus", "foundry/sonnet", "foundry/haiku"];
const home = ["openrouter/kimi", "openrouter/glm", "openrouter/deepseek"];

test("without roles, everyone may use every allowed model (as before)", () => {
  const p = { allowedModels: foundry, coordinatorModel: "foundry/opus" };
  assert.deepEqual(modelsFor(p, "coordinator"), foundry);
  assert.deepEqual(modelsFor(p, "worker"), foundry);
  assert.equal(defaultModel(p, "worker"), "foundry/opus", "helpers start on core's model, as before");
});

test("crowns are core's models, locks keep a model for core only", () => {
  // Kimi and GLM for core, GLM and DeepSeek for helpers.
  const p = { allowedModels: home, coordinatorModel: "openrouter/kimi", coreModels: ["openrouter/kimi", "openrouter/glm"], coreOnlyModels: ["openrouter/kimi"] };
  assert.deepEqual(modelsFor(p, "coordinator"), ["openrouter/kimi", "openrouter/glm"]);
  assert.deepEqual(modelsFor(p, "worker"), ["openrouter/glm", "openrouter/deepseek"]);
  assert.equal(defaultModel(p, "coordinator"), "openrouter/kimi");
  assert.equal(defaultModel(p, "worker"), "openrouter/glm", "core's model is locked, so helpers start on their first");

  // A locked model counts as core's even if not crowned; a stale core model falls back to core's first.
  const q = { allowedModels: home, coordinatorModel: "openrouter/deepseek", coreModels: ["openrouter/glm"], coreOnlyModels: ["openrouter/kimi"] };
  assert.deepEqual(modelsFor(q, "coordinator"), ["openrouter/kimi", "openrouter/glm"]);
  assert.equal(defaultModel(q, "coordinator"), "openrouter/kimi");
  // Never empty: everything locked still leaves helpers something.
  assert.deepEqual(modelsFor({ allowedModels: ["a/x"], coreOnlyModels: ["a/x"] }, "worker"), ["a/x"]);
});
