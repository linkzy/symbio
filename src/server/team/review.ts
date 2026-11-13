// The human's review of the team's work (Project.reviewBy). With "core" (the default) nothing waits
// on the human. With "every" (or "marked", for the tasks marked in the plan), a task whose work is
// finished (merged, or marked done by core) waits in the human's "To review" list, with the guide
// its helper wrote, until they approve it or send it back. The gate holds the task's done, not its
// merge: the work is already in the project, and tasks that depend on it wait meanwhile.

import { attachmentNote, getAttachments, markSent } from "../attachments.js";
import { bus } from "../bus.js";
import type { Task } from "../plan.js";
import { projectRepositoriesSync } from "../repos.js";
import type { Agent, Project } from "../store.js";
import { isGitRepo } from "../workspaces.js";
import { active, type TeamCore } from "./core.js";

/** One file a task changed. */
export interface TaskChange {
  file: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch: string;
}

const MAX_PATCH = 200_000;

export class Reviews {
  constructor(private readonly team: TeamCore) {}

  /** Whether the human reviews this task before it's done. */
  gated(project: Project, task: Task): boolean {
    const by = project.reviewBy ?? "core";
    return by === "every" || (by === "marked" && !!task.review);
  }

  /**
   * A task's work is finished (merged, or marked done by core or its helper): done, or waiting for
   * the human's review. Returns which.
   */
  async complete(project: Project, taskId: string, by: string): Promise<"done" | "waiting"> {
    const plan = await this.team.plan(project);
    const task = plan.task(taskId);
    if (!this.gated(project, task) || task.humanReview?.state === "approved") {
      await plan.update(task.id, { status: "done", note: { by, text: "done" } });
      this.team.planChanged(project);
      return "done";
    }
    if (task.humanReview?.state === "waiting") return "waiting";
    await plan.update(task.id, { status: "review", humanReview: { state: "waiting", at: Date.now() }, note: { by: "symbio", text: "waiting for the human's review" } });
    this.team.planChanged(project);
    await this.team.log(project, {
      from: "symbio",
      to: "human",
      kind: "task-review",
      text: `${task.id} "${task.title}" is ready for your review${task.guide ? ", with a guide" : " (no guide was given)"}: see Needs you or the Plan tab.`,
    });
    return "waiting";
  }

  /** The human approved the task: it's done, and core carries on (tasks that depend on it can start). */
  async approve(project: Project, taskId: string, note?: string): Promise<void> {
    const plan = await this.team.plan(project);
    const task = plan.task(taskId);
    if (task.humanReview?.state !== "waiting") throw new Error(`${task.id} isn't waiting for your review.`);
    await plan.update(task.id, {
      status: "done",
      humanReview: { state: "approved", at: Date.now(), ...(note?.trim() ? { note: note.trim() } : {}) },
      note: { by: "human", text: note?.trim() ? `approved: ${note.trim()}` : "approved" },
    });
    this.team.planChanged(project);
    const helper = task.assignee ? project.agents.find((a) => a.id === task.assignee) : undefined;
    const core = this.team.coordinator(project);
    if (core && active(core)) {
      await this.team.system(
        project,
        core,
        `Symbio: the human approved ${task.id} "${task.title}"${note?.trim() ? ` (${note.trim()})` : ""}. It's done; tasks that depended on it can start.`,
      );
    }
    if (helper && helper.role === "worker" && active(helper)) await this.team.renewAfterTask(project, helper, "its task was approved");
    bus.publish({ type: "project.updated", projectId: project.id });
  }

/** Marks (or unmarks) a task for the human's review, for projects reviewed "marked". */
  async mark(project: Project, taskId: string, review: boolean): Promise<void> {
    const plan = await this.team.plan(project);
    const task = plan.task(taskId);
    if (task.status === "done") throw new Error(`${task.id} is already done.`);
    await plan.update(task.id, { review, note: { by: "human", text: review ? "marked for my review" : "no review by me" } });
    this.team.planChanged(project);
  }

  /**
   * A helper reported the task for review: the turn it reported in ends the task's work in its
   * session (a fix round after "send back" extends it). A session started since the assignment (a
   * fresh session) adds its own range.
   */
  async recordReport(project: Project, agent: Agent, taskId: string): Promise<void> {
    const plan = await this.team.plan(project);
    const task = plan.task(taskId);
    const page = await this.team.client().messagePage(agent.sessionId, 40);
    const users = page.messages.filter((m: any) => m.type === "user").map((m: any) => String(m.id));
    if (!users.length) return;
    const work = [...(task.work ?? [])];
    const current = work.find((w) => w.sessionId === agent.sessionId);
    if (current) current.to = users[users.length - 1];
    else work.push({ sessionId: agent.sessionId, from: users[0], to: users[users.length - 1] });
    await plan.update(task.id, { work });
  }

  /**
   * What a task changed: the files its helper's turns changed, with their diffs (OpenCode's session
   * diff, which needs git). Only the fields the browser needs are passed on.
   */
  async changes(project: Project, taskId: string): Promise<{ files: TaskChange[]; note?: string }> {
    const task = (await this.team.plan(project)).task(taskId);
    const ranges = (task.work ?? []).filter((w) => w.to);
    if (!ranges.length) return { files: [], note: "Nothing recorded yet: the changes show once the helper reports the task." };
    const byFile = new Map<string, TaskChange>();
    for (const w of ranges) {
      const res = await this.team
        .client()
        .request("GET", `/api/session/${w.sessionId}/diff?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to!)}&context=3`)
        .catch(() => null);
      for (const f of res?.data ?? []) {
        const patch = String(f.patch ?? "");
        byFile.set(String(f.file), {
          file: String(f.file),
          status: f.status === "added" || f.status === "deleted" ? f.status : "modified",
          additions: Number(f.additions) || 0,
          deletions: Number(f.deletions) || 0,
          patch: patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… (cut: the change is too large to show here)` : patch,
        });
      }
    }
    const files = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
    if (!files.length && !(await isGitRepo(project.directory)) && !projectRepositoriesSync(project).length) {
      return { files, note: "The changes view needs git: this project folder isn't a git repository." };
    }
    return { files };
  }

  /** The human sent the task back: it reopens, and their note goes to the helper that did it (core is told). */
  async sendBack(project: Project, taskId: string, note: string, attachmentIds: string[] = []): Promise<void> {
    if (!note.trim()) throw new Error("Say what needs to change.");
    const files = attachmentIds.length ? await getAttachments(project, attachmentIds) : [];
    const plan = await this.team.plan(project);
    const task = plan.task(taskId);
    if (task.humanReview?.state !== "waiting") throw new Error(`${task.id} isn't waiting for your review.`);
    await plan.update(task.id, {
      status: "in-progress",
      humanReview: { state: "sent-back", at: Date.now(), note: note.trim() },
      note: { by: "human", text: `sent back: ${note.trim()}` },
    });
    this.team.planChanged(project);
    const helper = task.assignee ? project.agents.find((a) => a.id === task.assignee) : undefined;
    const core = this.team.coordinator(project);
    const back = `${task.id} "${task.title}" was sent back by the human after their review:\n${note.trim()}`;
    if (helper && helper.role === "worker" && active(helper)) {
      await this.team.sendFromHuman(
        project,
        helper,
        `${back}\n\nFix it${helper.branch ? ", commit" : ""}, then report it again with update_task("${task.id}", "review", <summary>) and a guide.` +
          attachmentNote(files),
      );
      if (files.length) await markSent(project, attachmentIds, helper.id);
      if (core && active(core)) await this.team.system(project, core, `Symbio: ${back}\nIt went back to ${helper.name}, who fixes it and reports again.`, false);
    } else if (core && active(core)) {
      await this.team.system(project, core, `Symbio: ${back}\nIts helper is no longer active: give it to someone (assign_task).` + attachmentNote(files));
      if (files.length) await markSent(project, attachmentIds, core.id);
    }
    bus.publish({ type: "project.updated", projectId: project.id });
  }
}
