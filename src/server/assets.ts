// Shared-asset register. An asset is anything more than one agent could change:
// path patterns inside the project, or a named external thing. Symbio never
// interprets what an asset is; it tracks who holds it and who is waiting.
//
// Protocol: agents request → coordinator grants/denies → holder releases.
// No holder means the coordinator holds it.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface AssetRequest {
  agentId: string;
  reason: string;
  time: number;
}

export interface AssetEvent {
  time: number;
  type: "declared" | "requested" | "granted" | "denied" | "released";
  agentId?: string;
  note?: string;
}

export interface Asset {
  name: string;
  description: string;
  /** Glob-like patterns relative to the project root (`chapters/03/**`). Empty for external assets. */
  paths: string[];
  holder: string | null; // agent id; null = coordinator
  queue: AssetRequest[];
  history: AssetEvent[];
}

export class AssetRegister {
  private assets: Asset[] = [];

  private constructor(private readonly file: string) {}

  static async load(projectDir: string): Promise<AssetRegister> {
    const reg = new AssetRegister(path.join(projectDir, ".symbio", "assets.json"));
    try {
      reg.assets = JSON.parse(await fs.readFile(reg.file, "utf8"));
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    return reg;
  }

  list(): Asset[] {
    return this.assets;
  }

  get(name: string): Asset | undefined {
    const key = name.trim().toLowerCase();
    return this.assets.find((a) => a.name.toLowerCase() === key);
  }

  private require(name: string): Asset {
    const asset = this.get(name);
    if (!asset) {
      const known = this.assets.map((a) => a.name).join(", ") || "none";
      throw new Error(`Unknown shared asset "${name}". Declared assets: ${known}.`);
    }
    return asset;
  }

  async declare(name: string, description: string, paths: string[] = []): Promise<Asset> {
    const existing = this.get(name);
    if (existing) {
      existing.description = description || existing.description;
      if (paths.length) existing.paths = paths;
      await this.save();
      return existing;
    }
    const asset: Asset = {
      name: name.trim(),
      description,
      paths: paths.map(normalizePattern),
      holder: null,
      queue: [],
      history: [{ time: Date.now(), type: "declared" }],
    };
    this.assets.push(asset);
    await this.save();
    return asset;
  }

  /** Queues a request. Returns the asset; the coordinator decides. */
  async request(name: string, agentId: string, reason: string): Promise<{ asset: Asset; alreadyHeld: boolean }> {
    const asset = this.require(name);
    if (asset.holder === agentId) return { asset, alreadyHeld: true };
    if (!asset.queue.some((r) => r.agentId === agentId)) {
      asset.queue.push({ agentId, reason, time: Date.now() });
      asset.history.push({ time: Date.now(), type: "requested", agentId, note: reason });
      await this.save();
    }
    return { asset, alreadyHeld: false };
  }

  async grant(name: string, agentId: string, note?: string): Promise<Asset> {
    const asset = this.require(name);
    if (asset.holder && asset.holder !== agentId) {
      throw new Error(`"${asset.name}" is held by another agent. Ask them to release it first (or wait for their release).`);
    }
    asset.holder = agentId;
    asset.queue = asset.queue.filter((r) => r.agentId !== agentId);
    asset.history.push({ time: Date.now(), type: "granted", agentId, note });
    await this.save();
    return asset;
  }

  async deny(name: string, agentId: string, reason: string): Promise<Asset> {
    const asset = this.require(name);
    asset.queue = asset.queue.filter((r) => r.agentId !== agentId);
    asset.history.push({ time: Date.now(), type: "denied", agentId, note: reason });
    await this.save();
    return asset;
  }

  async release(name: string, agentId: string, summary: string): Promise<Asset> {
    const asset = this.require(name);
    if (asset.holder !== agentId) throw new Error(`You don't hold "${asset.name}".`);
    asset.holder = null;
    asset.history.push({ time: Date.now(), type: "released", agentId, note: summary });
    await this.save();
    return asset;
  }

  /** Releases everything an agent holds and drops its queued requests (agent stopped). */
  async forget(agentId: string): Promise<void> {
    for (const asset of this.assets) {
      if (asset.holder === agentId) {
        asset.holder = null;
        asset.history.push({ time: Date.now(), type: "released", agentId, note: "agent stopped" });
      }
      asset.queue = asset.queue.filter((r) => r.agentId !== agentId);
    }
    await this.save();
  }

  /**
   * Assets (with path patterns) touched by the given changed files that the agent
   * was not granted at any point since `since`.
   */
  violations(changedFiles: string[], agentId: string, since: number): { asset: Asset; files: string[] }[] {
    const result: { asset: Asset; files: string[] }[] = [];
    for (const asset of this.assets) {
      if (asset.paths.length === 0) continue;
      const files = changedFiles.filter((f) => asset.paths.some((p) => matchPattern(p, f)));
      if (files.length === 0) continue;
      const granted =
        asset.holder === agentId ||
        asset.history.some((h) => h.type === "granted" && h.agentId === agentId && h.time >= since);
      if (!granted) result.push({ asset, files });
    }
    return result;
  }

  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.assets, null, 2));
    await fs.rename(tmp, this.file);
  }
}

function normalizePattern(p: string) {
  return p.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
}

/** Minimal glob: `**` any path, `*` any segment chars, a trailing `/` means the whole folder. */
export function matchPattern(pattern: string, file: string): boolean {
  let p = normalizePattern(pattern);
  const f = file.replace(/\\/g, "/");
  if (p.endsWith("/")) p += "**";
  if (!/[*?]/.test(p)) return f === p || f.startsWith(p + "/");
  const re = p
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*");
  return new RegExp(`^${re}$`, "i").test(f);
}
