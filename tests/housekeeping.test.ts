import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-hk-home-"));
const { git, initRepository } = await import("../src/server/git.js");
const { backupsDir, cleanBuildOutputs, dailyBackup, helperFolders, unpushedWork } = await import("../src/server/housekeeping.js");
const { createWorkspace } = await import("../src/server/workspaces.js");

const commitAll = async (dir: string, msg: string) => {
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
};

test("daily backup: one per day, project state and Symbio's files, oldest days pruned", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-hk-proj-"));
  mkdirSync(path.join(dir, ".symbio"));
  writeFileSync(path.join(dir, ".symbio", "project.json"), "{}");
  writeFileSync(path.join(process.env.SYMBIO_HOME!, "config.json"), "{}");
  writeFileSync(path.join(process.env.SYMBIO_HOME!, "ui-token"), "secret-key");
  const project: any = { id: "prj_bk", directory: dir };

  const first = await dailyBackup([project], new Date("2026-01-01T10:00:00Z"));
  assert.ok(first && existsSync(path.join(first, "projects", `${path.basename(dir)}-prj_bk`, "project.json")), "project state copied");
  assert.ok(existsSync(path.join(first!, "symbio", "config.json")), "Symbio's config copied");
  assert.ok(!existsSync(path.join(first!, "symbio", "ui-token")), "the UI key isn't");
  assert.equal(await dailyBackup([project], new Date("2026-01-01T18:00:00Z")), null, "once per day");

  for (let d = 2; d <= 10; d++) await dailyBackup([project], new Date(`2026-01-${String(d).padStart(2, "0")}T10:00:00Z`));
  const days = readdirSync(backupsDir()).sort();
  assert.equal(days.length, 7, "keeps the last 7 days");
  assert.equal(days[0], "2026-01-04");
});

test("unpushed work and build outputs of a helper", async () => {
  const remote = mkdtempSync(path.join(os.tmpdir(), "sym-hk-remote-"));
  await git(remote, "init", "-q", "--bare");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-hk-repo-"));
  writeFileSync(path.join(dir, ".gitignore"), "bin/\nobj/\n.env\n");
  writeFileSync(path.join(dir, "a.txt"), "1\n");
  await initRepository(dir); // first snapshot, .gitignore included
  await git(dir, "remote", "add", "origin", remote);
  const main = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  await git(dir, "push", "-q", "origin", main);
  const project: any = { id: "prj_hk", directory: dir, agents: [] };
  assert.deepEqual((await unpushedWork(project)).branches, [], "everything pushed");

  // A helper commits on its own branch; the project's branch moves on locally too.
  const ws = await createWorkspace(project, "builder");
  const agent: any = { id: "agt_b", name: "builder", role: "worker", status: "idle", directory: ws.directory, branch: ws.branch };
  project.agents.push(agent);
  writeFileSync(path.join(ws.directory, "b.txt"), "work\n");
  await commitAll(ws.directory, "helper work");
  writeFileSync(path.join(dir, "a.txt"), "2\n");
  await commitAll(dir, "local only");
  const { remote: name, branches } = await unpushedWork(project);
  assert.equal(name, "origin");
  assert.deepEqual(branches.map((b) => [b.branch, b.commits]).sort(), [[main, 1], ["symbio/builder", 1]].sort());

  // Build outputs: ignored bin/obj go; work and other ignored files (like .env) stay.
  mkdirSync(path.join(ws.directory, "src", "App", "bin", "Debug"), { recursive: true });
  writeFileSync(path.join(ws.directory, "src", "App", "bin", "Debug", "app.dll"), "x".repeat(5000));
  mkdirSync(path.join(ws.directory, "obj"));
  writeFileSync(path.join(ws.directory, "obj", "cache"), "x".repeat(3000));
  writeFileSync(path.join(ws.directory, ".env"), "SECRET=1");
  writeFileSync(path.join(ws.directory, "draft.txt"), "uncommitted work");
  const [folder] = await helperFolders(project);
  assert.ok(folder.buildBytes >= 8000, `build outputs measured (${folder.buildBytes})`);
  await cleanBuildOutputs(project, agent);
  assert.ok(!existsSync(path.join(ws.directory, "src", "App", "bin")), "bin removed");
  assert.ok(!existsSync(path.join(ws.directory, "obj")), "obj removed");
  assert.ok(existsSync(path.join(ws.directory, ".env")), "other ignored files kept");
  assert.ok(existsSync(path.join(ws.directory, "draft.txt")), "uncommitted work kept");
  assert.ok(existsSync(path.join(ws.directory, "b.txt")), "committed work kept");

  agent.status = "busy";
  await assert.rejects(cleanBuildOutputs(project, agent), /working/);
  await assert.rejects(cleanBuildOutputs(project, { ...agent, status: "idle", branch: null, directory: dir }), /only helpers/);
});
