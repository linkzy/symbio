// Token usage per model and estimated cost.
//
// OpenCode reports totals per session, not per model, and agents can switch models (or
// get a fresh session). So each time a session's totals are read, the increase since
// the last read is attributed to the model the agent is on now (Agent.usageByModel).
// Data from before this existed is attributed to the agent's current model.
//
// Prices are USD per million tokens, kept in ~/.symbio/prices.json. Providers that don't
// publish prices to OpenCode (custom ones like an Azure deployment) get a suggestion from
// OpenCode's catalog for the same model, which the user can accept or correct.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Agent, Project } from "./store.js";

export interface Usage {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO: Usage = { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
const KEYS = ["cost", "input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

export const emptyUsage = (): Usage => ({ ...ZERO });

export function addUsage(a: Usage, b: Usage): Usage {
  const out = emptyUsage();
  for (const k of KEYS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/** Records a session's latest totals, attributing what's new to the agent's current model. */
export function accountUsage(agent: Agent, sessionTotals: Usage): void {
  if (!agent.usageByModel) {
    // First time (or data from before per-model tracking): all of it goes to the current model.
    agent.usageByModel = { [agent.model]: addUsage(agent.pastUsage ?? ZERO, sessionTotals) };
    agent.usageSeen = { ...sessionTotals };
    return;
  }
  const seen = agent.usageSeen ?? ZERO;
  const delta = emptyUsage();
  let reset = false;
  for (const k of KEYS) {
    const d = (sessionTotals[k] ?? 0) - (seen[k] ?? 0);
    if (d < 0) reset = true;
    delta[k] = Math.max(0, d);
  }
  // Totals going down means a different session than the one last seen: all of it is new.
  const add = reset ? sessionTotals : delta;
  agent.usageByModel[agent.model] = addUsage(agent.usageByModel[agent.model] ?? ZERO, add);
  agent.usageSeen = { ...sessionTotals };
}

/** Everything the agent has used, across sessions and models. */
export function agentUsageByModel(agent: Agent): Record<string, Usage> {
  if (agent.usageByModel) return agent.usageByModel;
  const total = addUsage(agent.pastUsage ?? ZERO, agent.usage ?? ZERO);
  return total.input + total.output + total.cacheRead + total.cacheWrite > 0 ? { [agent.model]: total } : {};
}

export function costOf(u: Usage, price: Price | undefined): number | null {
  if (!price) return null;
  return (u.input * price.input + (u.output + u.reasoning) * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) / 1e6;
}

export const tokensOf = (u: Usage) => u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite;

// ---------------------------------------------------------------- prices

export class PriceBook {
  prices: Record<string, Price> = {};
  constructor(private readonly file: string) {}

  static at(dir: string) {
    return new PriceBook(path.join(dir, "prices.json"));
  }

  async load() {
    try {
      this.prices = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.prices = {};
    }
    return this;
  }

  async set(model: string, price: Price | null) {
    if (price) this.prices[model] = price;
    else delete this.prices[model];
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.prices, null, 2));
  }
}

/** OpenCode's base price for a model (first tier), USD per million tokens, if it has one. */
export function catalogPrice(model: any): Price | null {
  const c = Array.isArray(model?.cost) ? model.cost[0] : model?.cost;
  if (!c || typeof c.input !== "number") return null;
  return { input: c.input, output: c.output ?? 0, cacheRead: c.cache?.read ?? 0, cacheWrite: c.cache?.write ?? 0 };
}

/**
 * Price for every model ref: the user's own, else OpenCode's, else a suggestion from a
 * catalog model with the same name (e.g. "foundry/code-claude-opus-5-5" → "claude-opus-5-5").
 */
export function resolvePrices(refs: string[], book: Record<string, Price>, catalog: any[]) {
  const byRef = new Map(catalog.map((m) => [`${m.providerID}/${m.id}`, m]));
  const priced = catalog.filter((m) => catalogPrice(m));
  const out: Record<string, { price: Price | null; source: "yours" | "opencode" | "suggested" | "none"; from?: string }> = {};
  for (const ref of refs) {
    if (book[ref]) {
      out[ref] = { price: book[ref], source: "yours" };
      continue;
    }
    const own = catalogPrice(byRef.get(ref));
    if (own) {
      out[ref] = { price: own, source: "opencode" };
      continue;
    }
    const id = ref.split("/").slice(1).join("/").toLowerCase();
    const match = priced
      .filter((m) => id.includes(String(m.id).toLowerCase()) && String(m.id).length >= 6)
      .sort((a, b) => String(b.id).length - String(a.id).length || rank(a.providerID) - rank(b.providerID))[0];
    out[ref] = match ? { price: catalogPrice(match), source: "suggested", from: `${match.providerID}/${match.id}` } : { price: null, source: "none" };
  }
  return out;
}

const rank = (provider: string) => (provider === "anthropic" ? 0 : provider === "openai" ? 0 : provider === "opencode" ? 1 : 2);

/** Usage report for a project: per agent and model, with estimated costs. */
export function projectUsage(project: Project, prices: ReturnType<typeof resolvePrices>) {
  let total = emptyUsage();
  let totalCost = 0;
  const unpriced = new Set<string>();
  const agents = project.agents.map((agent) => {
    const byModel = Object.entries(agentUsageByModel(agent)).map(([model, usage]) => {
      // A suggestion only counts once the user accepts it: the same model can cost something else (or
      // nothing) at another provider.
      const info = prices[model];
      const cost = costOf(usage, info && (info.source === "yours" || info.source === "opencode") ? (info.price ?? undefined) : undefined);
      if (cost === null && tokensOf(usage) > 0) unpriced.add(model);
      total = addUsage(total, usage);
      totalCost += cost ?? 0;
      return { model, usage, tokens: tokensOf(usage), cost };
    });
    const usage = byModel.reduce((s, m) => addUsage(s, m.usage), emptyUsage());
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      sessions: 1 + (agent.previousSessions?.length ?? 0),
      byModel,
      tokens: tokensOf(usage),
      cost: byModel.reduce((s, m) => s + (m.cost ?? 0), 0),
    };
  });
  return { agents, total, tokens: tokensOf(total), cost: totalCost, unpriced: [...unpriced] };
}
