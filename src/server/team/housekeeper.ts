// Hourly housekeeping: today's backup, and once a day per project, work that exists only on this
// machine and build outputs piling up in helpers' folders (told to the human and core).

import { bus } from "../bus.js";
import { cleanBuildOutputs, dailyBackup, gb, helperFolders, lastBackup, unpushedWork, type FolderUsage, type UnpushedBranch } from "../housekeeping.js";
import type { Agent, Project } from "../store.js";
import type { TeamCore } from "./core.js";

// Warn when helpers' build outputs pass this size.
const BUILD_ALERT_BYTES = Number(process.env.SYMBIO_BUILD_ALERT_GB ?? 2) * 1024 ** 3;

export interface HousekeepingReport {
  checkedAt: number;
  remote: string | null;
  unpushed: UnpushedBranch[];
  folders: FolderUsage[];
  lastBackup: string | null;
}

export class Housekeeper {
  private reports = new Map<string, HousekeepingReport>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly team: TeamCore) {}

  start() {
    if (this.timer) return;
    setTimeout(() => void this.run(), 5 * 60_000);
    this.timer = setInterval(() => void this.run(), 60 * 60_000);
  }

  /** Hourly: today's backup, and (once a day per project) work-not-pushed and disk checks. */
  async run() {
    const backup = await dailyBackup(this.team.store.list()).catch((err) => console.error("[backup]", err.message));
    if (backup) console.log(`[backup] ${backup}`);
    for (const project of this.team.store.list()) {
      if (Date.now() - (project.housekeptAt ?? 0) < 24 * 3600_000) continue;
      await this.check(project, true).catch((err) => console.error(`[housekeeping] ${project.name}:`, err.message));
    }
  }

  /** Measures the project's unpushed work and helper folders; with notify, tells the human and core. */
  async check(project: Project, notify: boolean): Promise<HousekeepingReport> {
    const [{ remote, branches }, folders] = await Promise.all([unpushedWork(project), helperFolders(project)]);
    const report: HousekeepingReport = { checkedAt: Date.now(), remote, unpushed: branches, folders, lastBackup: await lastBackup() };
    this.reports.set(project.id, report);
    if (!notify) return report;

    project.housekeptAt = Date.now();
    await this.team.store.update(project);
    const buildBytes = folders.reduce((s, f) => s + f.buildBytes, 0);
    const parts: string[] = [];
    if (branches.length) {
      parts.push(
        `Work that exists only on this machine (not on ${remote === "each repository's remote" ? "each repository's remote" : `the remote "${remote}"`}):\n` +
          branches.map((b) => `- ${b.branch}: ${b.commits} commit(s), latest "${b.latest}"`).join("\n") +
          `\nIf it's ready to share, push it (git_push; in a project of several repositories, with repo); if a branch shouldn't go to the remote, tell the human.`,
      );
    }
    if (buildBytes > BUILD_ALERT_BYTES) {
      parts.push(
        `Helpers' folders hold ${gb(buildBytes)} of build outputs:\n` +
          folders.filter((f) => f.buildBytes > 0).map((f) => `- ${f.name} (${f.status}): ${gb(f.buildBytes)} of ${gb(f.bytes)}`).join("\n") +
          `\nFor idle helpers that don't need them right now, free the space with clean_build_outputs (work is never touched).`,
      );
    }
    if (!parts.length) return report;
    const text = `Symbio housekeeping (daily check):\n\n${parts.join("\n\n")}`;
    await this.team.log(project, { from: "symbio", to: "human", kind: "system", text });
    const coordinator = this.team.coordinator(project);
    if (coordinator) await this.team.system(project, coordinator, text).catch(() => {});
    bus.publish({ type: "project.updated", projectId: project.id });
    return report;
  }

  report(project: Project): HousekeepingReport | undefined {
    return this.reports.get(project.id);
  }

  async cleanHelperFolder(project: Project, agent: Agent): Promise<string> {
    const freed = await cleanBuildOutputs(project, agent);
    const folder = this.reports.get(project.id)?.folders.find((f) => f.agentId === agent.id);
    if (folder) {
      folder.bytes = Math.max(0, folder.bytes - freed);
      folder.buildBytes = 0;
    }
    await this.team.log(project, { from: "symbio", to: "human", kind: "system", text: `Cleaned ${agent.name}'s build outputs: ${gb(freed)} freed.` });
    bus.publish({ type: "project.updated", projectId: project.id });
    return `Freed ${gb(freed)} in ${agent.name}'s folder (build outputs only).`;
  }
}
