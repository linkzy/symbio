import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "orq-ws-home-"));
const { git, initRepository } = await import("../src/server/git.js");
const { createWorkspace, mergeWorkspace, syncWorkspace, changedFiles, removeWorkspace, restoreWorkspace } = await import("../src/server/workspaces.js");

// git on Windows may convert line endings on checkout/merge.
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const commitAll = async (dir: string, msg: string) => {
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
};

test("two helpers change the same line: conflict is detected, aborted, then resolved", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orq-ws-"));
  writeFileSync(path.join(dir, "shared.css"), "body { color: black; }\n");
  await initRepository(dir);
  const project: any = { id: "prj_test", directory: dir };

  const mk = async (name: string) => {
    const ws = await createWorkspace(project, name);
    return { id: name, name, role: "worker", directory: ws.directory, branch: ws.branch, base: ws.base } as any;
  };
  const a = await mk("helper-a");
  const b = await mk("helper-b");

  writeFileSync(path.join(a.directory, "shared.css"), "body { color: red; }\n");
  await commitAll(a.directory, "a: red");
  writeFileSync(path.join(b.directory, "shared.css"), "body { color: blue; }\n");
  await commitAll(b.directory, "b: blue");

  const first = await mergeWorkspace(project, a);
  assert.equal(first.ok, true, "first merge succeeds");
  a.base = await syncWorkspace(project, a);

  const second = await mergeWorkspace(project, b);
  assert.equal(second.ok, false, "second merge conflicts");
  assert.ok(!second.ok && second.files?.includes("shared.css"), "conflicting file is reported");
  assert.match(!second.ok ? second.reason : "", /git merge master|git merge main/, "tells the helper what to do");
  assert.equal(await git(dir, "status", "--porcelain"), "", "project left clean (merge aborted)");
  assert.equal(read(path.join(dir, "shared.css")), "body { color: red; }\n", "project keeps the first merge");

  // The helper brings the latest project state into its branch and resolves the conflict there.
  const main = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  await git(b.directory, "merge", main).catch(() => {}); // conflicts
  writeFileSync(path.join(b.directory, "shared.css"), "body { color: red; }\nh1 { color: blue; }\n");
  await commitAll(b.directory, "b: resolve conflict");

  const third = await mergeWorkspace(project, b);
  assert.equal(third.ok, true, "merge succeeds after resolving");
  assert.equal(read(path.join(dir, "shared.css")), "body { color: red; }\nh1 { color: blue; }\n");
});

test("uncommitted work blocks a merge", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orq-ws-"));
  writeFileSync(path.join(dir, "a.txt"), "1\n");
  await initRepository(dir);
  const project: any = { id: "prj_test2", directory: dir };
  const ws = await createWorkspace(project, "helper");
  const agent: any = { name: "helper", directory: ws.directory, branch: ws.branch, base: ws.base };
  writeFileSync(path.join(ws.directory, "a.txt"), "2\n");
  assert.deepEqual((await changedFiles(agent)).uncommitted, ["a.txt"]);
  const res = await mergeWorkspace(project, agent);
  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.reason : "", /uncommitted/);
});

test("a restarted helper gets its workspace back", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orq-ws-"));
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  await initRepository(dir);
  const project: any = { id: "prj_restart", directory: dir };
  const ws = await createWorkspace(project, "helper");
  const agent: any = { id: "helper", name: "helper", role: "worker", directory: ws.directory, branch: ws.branch, base: ws.base };

  // Stopped with nothing unmerged: the workspace is removed; the project moves on.
  await removeWorkspace(project, agent);
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  await commitAll(dir, "project moves on");

  const restored = await restoreWorkspace(project, agent);
  assert.equal(restored.reset, true, "workspace recreated");
  assert.equal(read(path.join(agent.directory, "a.txt")), "two\n", "starts from the project's current state");
  assert.equal(restored.base, await git(dir, "rev-parse", "HEAD"));

  // A kept workspace (unmerged work) is reused as is.
  writeFileSync(path.join(agent.directory, "b.txt"), "draft\n");
  const again = await restoreWorkspace(project, agent);
  assert.equal(again.reset, false, "existing workspace reused");
  assert.equal(read(path.join(agent.directory, "b.txt")), "draft\n", "unmerged work kept");
});
