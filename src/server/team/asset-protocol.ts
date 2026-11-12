// The shared-asset protocol: helpers request an asset before changing it; a free one is granted at
// once (core gets a note), a held one goes to core to decide; releasing hands it on. The register
// itself (holders, queues, history) is assets.ts.

import type { Agent, Project } from "../store.js";
import type { TeamCore } from "./core.js";

export class SharedAssets {
  constructor(private readonly team: TeamCore) {}

  async request(project: Project, agent: Agent, assetName: string, reason: string): Promise<string> {
    const reg = await this.team.assets(project);
    const { asset, alreadyHeld } = await reg.request(assetName, agent.id, reason);
    if (alreadyHeld) return `You already hold "${asset.name}".`;
    this.team.assetsChanged(project);
    const coordinator = this.team.coordinator(project);
    if (!coordinator) throw new Error("This project has no coordinator.");

    // Free and nobody else waiting: grant now, without spending a coordinator turn.
    // The coordinator only decides when there is contention.
    if (!asset.holder && asset.queue.length === 1 && asset.queue[0].agentId === agent.id && agent.id !== coordinator.id) {
      await reg.grant(asset.name, agent.id, "granted automatically (it was free)");
      this.team.assetsChanged(project);
      await this.team.log(project, { from: coordinator.id, to: agent.id, kind: "asset-granted", text: `"${asset.name}" granted automatically — it was free. Reason given: ${reason}` });
      await this.team.note(project, coordinator, `Symbio: granted the shared asset "${asset.name}" to ${agent.name} automatically (it was free). Reason: ${reason}`);
      return `Granted: "${asset.name}" was free, so it's yours now. Change it, then call release_asset with a summary when you're done.`;
    }
    const holder = asset.holder ? this.team.agentName(project, asset.holder) : null;
    const waiting = asset.queue.map((q) => this.team.agentName(project, q.agentId)).join(", ");
    await this.team.deliver(
      project,
      agent,
      coordinator,
      "asset-request",
      `${agent.name} requests the shared asset "${asset.name}": ${reason}\n` +
        `Currently held by: ${holder ?? "nobody (you)"}. Waiting: ${waiting}.\n` +
        `Answer with grant_asset or deny_asset.`,
    );
    return (
      `Request sent to the coordinator. Do NOT change "${asset.name}" until you receive a grant. ` +
      `Continue with other work — the answer will show up in the result of your next Symbio tool call ` +
      `(or call check_messages) — or end your turn and it will wake you. Don't ask for it again.`
    );
  }

  async grant(project: Project, coordinator: Agent, to: Agent, assetName: string, note?: string): Promise<string> {
    const asset = await (await this.team.assets(project)).grant(assetName, to.id, note);
    this.team.assetsChanged(project);
    if (to.id !== coordinator.id) {
      await this.team.deliver(
        project,
        coordinator,
        to,
        "asset-granted",
        `You may now change the shared asset "${asset.name}".${note ? ` ${note}` : ""}\nCall release_asset when you are done.`,
      );
    }
    return `Granted "${asset.name}" to ${to.name}.`;
  }

  async deny(project: Project, coordinator: Agent, to: Agent, assetName: string, reason: string): Promise<string> {
    const asset = await (await this.team.assets(project)).deny(assetName, to.id, reason);
    this.team.assetsChanged(project);
    await this.team.deliver(project, coordinator, to, "asset-denied", `Your request for "${asset.name}" was denied: ${reason}`);
    return `Denied "${asset.name}" to ${to.name}.`;
  }

  async release(project: Project, agent: Agent, assetName: string, summary: string): Promise<string> {
    const asset = await (await this.team.assets(project)).release(assetName, agent.id, summary);
    this.team.assetsChanged(project);
    const coordinator = this.team.coordinator(project);
    if (coordinator && coordinator.id !== agent.id) {
      const waiting = asset.queue.map((q) => this.team.agentName(project, q.agentId)).join(", ");
      const text = `${agent.name} released "${asset.name}": ${summary}${waiting ? `\nStill waiting for it: ${waiting}.` : ""}`;
      // Only wake the coordinator when someone is waiting for it to decide; otherwise a note.
      if (waiting) await this.team.deliver(project, agent, coordinator, "asset-released", text);
      else {
        await this.team.log(project, { from: agent.id, to: coordinator.id, kind: "asset-released", text });
        await this.team.note(project, coordinator, `Symbio: ${text}`);
      }
    }
    return `Released "${asset.name}".`;
  }
}
