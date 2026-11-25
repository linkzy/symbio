import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeSchedule, nextRun, parseSchedule } from "../src/server/schedule.js";
import { Schedules } from "../src/server/team/schedules.js";
import type { Agent, Project } from "../src/server/store.js";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("next runs: daily, weekly, monthly, every few hours and once, in the computer's time", () => {
  const wed10 = local(2026, 11, 25, 10); // a Wednesday
  assert.equal(nextRun({ every: "day", at: "07:00" }, wed10), local(2026, 11, 26, 7));
  assert.equal(nextRun({ every: "day", at: "23:30" }, wed10), local(2026, 11, 25, 23, 30));
  assert.equal(nextRun({ every: "week", days: [1, 4], at: "09:00" }, wed10), local(2026, 11, 26, 9), "Thursday comes first");
  assert.equal(nextRun({ every: "week", days: [3], at: "09:00" }, wed10), local(2026, 12, 2, 9), "today's 09:00 is past: next Wednesday");
  assert.equal(nextRun({ every: "month", day: 1, at: "08:00" }, wed10), local(2026, 12, 1, 8));
  assert.equal(nextRun({ every: "month", day: 25, at: "12:00" }, wed10), local(2026, 11, 25, 12));
  assert.equal(nextRun({ every: "hours", interval: 6 }, wed10), wed10 + 6 * 3_600_000);
  assert.equal(nextRun({ once: "2026-11-26T09:00" }, wed10), local(2026, 11, 26, 9));
  assert.equal(nextRun({ once: "2026-11-24T09:00" }, wed10), null);
});

test("schedules core describes are checked, and read back in words", () => {
  const now = local(2026, 11, 25, 10);
  assert.deepEqual(parseSchedule({ every: "week", days: ["thu", "Mon"], at: "9:05" }, now), { every: "week", days: [1, 4], at: "09:05" });
  assert.equal(describeSchedule({ every: "week", days: [1, 4], at: "09:05" }), "every Monday and Thursday at 09:05");
  assert.equal(describeSchedule({ every: "hours", interval: 1 }), "every hour");
  assert.throws(() => parseSchedule({ every: "day" }, now), /Give `at`/);
  assert.throws(() => parseSchedule({ every: "day", at: "25:00" }, now), /HH:MM/);
  assert.throws(() => parseSchedule({ every: "month", day: 31, at: "08:00" }, now), /1 to 28/);
  assert.throws(() => parseSchedule({ every: "once", date: "2026-11-24", at: "08:00" }, now), /already passed/);
  assert.throws(() => parseSchedule({ every: "fortnight" }, now), /`every` is/);
});

function setup(autonomy: "ask" | "decide") {
  const core = { id: "a1", name: "core", role: "coordinator", status: "idle" } as Agent;
  const project = { id: "p1", name: "Site", directory: mkdtempSync(path.join(os.tmpdir(), "symbio-jobs-")), agents: [core], autonomy } as unknown as Project;
  const woken: string[] = [];
  const notes: string[] = [];
  const human: string[] = [];
  let now = local(2026, 11, 25, 10);
  const team = {
    store: { list: () => [project] },
    shuttingDown: false,
    coordinator: () => core,
    log: async (_p: Project, m: { to: string; kind: string; text: string }) => void (m.kind === "job" && human.push(m.text)),
    system: async (_p: Project, _a: Agent, text: string, wake = true) => void (wake ? woken : notes).push(text),
  };
  const schedules = new Schedules(team as any, () => now);
  return { project, schedules, woken, notes, human, at: (t: number) => (now = t) };
}

test("a job runs when it's due: core gets its instructions, reports, and the human hears how it went", async () => {
  const s = setup("decide");
  const said = await s.schedules.create(s.project, { title: "Refresh the data", instructions: "Download the new figures and update the charts.", every: "day", at: "07:00" });
  assert.match(said, /Scheduled as J1 \(every day at 07:00\)/);
  assert.match(s.human[0], /^Scheduled: J1 "Refresh the data", every day at 07:00/);

  await s.schedules.tick();
  assert.equal(s.woken.length, 0, "not due yet");
  s.at(local(2026, 11, 26, 7, 1));
  await s.schedules.tick();
  assert.equal(s.woken.length, 1);
  assert.match(s.woken[0], /scheduled job J1 "Refresh the data" is due \(run 1, every day at 07:00\)/);
  assert.match(s.woken[0], /Download the new figures/);
  const job = (await s.schedules.store(s.project)).job("J1");
  assert.equal(job.nextRun, local(2026, 11, 27, 7));

  // Started again while the run is still going: refused. Due again: skipped, and still skipped after that.
  await assert.rejects(s.schedules.runNow(s.project, "J1"), /the previous run is still going/);
  s.at(local(2026, 11, 26, 8, 0));
  (await s.schedules.store(s.project)).job("J1").nextRun = local(2026, 11, 26, 8, 0);
  await s.schedules.tick();
  s.at(local(2026, 11, 26, 9, 0));
  (await s.schedules.store(s.project)).job("J1").nextRun = local(2026, 11, 26, 9, 0);
  await s.schedules.tick();
  assert.equal(s.woken.length, 1, "never two runs at once");
  assert.match(s.human.at(-1)!, /^Skipped: J1 .* the previous run is still going/);

  assert.match(await s.schedules.report(s.project, "J1", "done", "12 charts updated."), /Recorded run 1 of J1 as done/);
  assert.match(s.human.at(-1)!, /^Done: J1 "Refresh the data" \(run 1\): 12 charts updated\./);
  await assert.rejects(s.schedules.report(s.project, "J1", "done", "again"), /No run of J1 is under way/);

  // Paused team: skipped, and the human is told why.
  s.project.paused = true;
  s.at(local(2026, 11, 27, 7, 1));
  await s.schedules.tick();
  assert.match(s.human.at(-1)!, /^Skipped: J1 "Refresh the data" was due, but the team is paused/);
  assert.equal(s.woken.length, 1);

  // A run core never reported is closed after a while, so the next one can start.
  s.project.paused = false;
  s.at(local(2026, 11, 28, 7, 1));
  await s.schedules.tick();
  assert.equal(s.woken.length, 2);
  s.at(local(2026, 11, 29, 7, 1));
  await s.schedules.tick();
  assert.equal(s.woken.length, 3);
  assert.equal(job.runs.at(-2)!.status, "no-report");
});

test("in a project that asks, a job waits for the human's approval; Run now starts one at once", async () => {
  const s = setup("ask");
  assert.match(await s.schedules.create(s.project, { title: "Weekly check", instructions: "Check every link.", every: "week", days: ["mon"], at: "09:00" }), /Proposed as J1/);
  assert.match(s.human[0], /^Proposed: J1 "Weekly check", every Monday at 09:00/);
  s.at(local(2026, 12, 7, 9, 5));
  await s.schedules.tick();
  assert.equal(s.woken.length, 0, "not approved: never runs");
  await assert.rejects(s.schedules.runNow(s.project, "J1"), /waiting for approval/);

  await s.schedules.approve(s.project, "J1");
  assert.match(s.notes[0], /approved scheduled job J1/);
  await s.schedules.runNow(s.project, "J1");
  assert.match(s.woken[0], /the human started it now/);
  const job = (await s.schedules.store(s.project)).job("J1");
  assert.equal(job.nextRun, local(2026, 12, 14, 9), "a manual run doesn't move the schedule");
});
