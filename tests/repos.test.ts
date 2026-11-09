import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-repos-home-"));
const { git, initRepository } = await import("../src/server/git.js");
const { findRepositories, gitRepoFor, resolveRepository, swallowedRepositories } = await import("../src/server/repos.js");
const { createWorkspace, mergeWorkspace, syncWorkspace, removeWorkspace } = await import("../src/server/workspaces.js");
const { inspectFolder, describeInspection } = await import("../src/server/inspect.js");
const { unpushedWork } = await import("../src/server/housekeeping.js");
const { coordinatorBrief, workerBrief } = await import("../src/server/prompts.js");

const commitAll = async (dir: string, msg: string) => {
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
};

/** game/ with client/ and server/ (repositories), apps/admin/ (one level deeper) and notes/ (plain). */
async function folderOfRepos() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-multi-"));
  for (const repo of ["client", "server", "apps/admin"]) {
    const abs = path.join(dir, ...repo.split("/"));
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, "README.md"), `# ${repo}\n`);
    await initRepository(abs);
  }
  mkdirSync(path.join(dir, "notes"));
  writeFileSync(path.join(dir, "notes", "ideas.txt"), "ideas\n");
  mkdirSync(path.join(dir, "node_modules", "lib"), { recursive: true });
  await initRepository(path.join(dir, "node_modules", "lib")).catch(() => {});
  return dir;
}

test("a folder of repositories: found, described, never initialized on top", async () => {
  const dir = await folderOfRepos();
  assert.deepEqual(await findRepositories(dir), ["apps/admin", "client", "server"]);
  const i = await inspectFolder(dir);
  assert.equal(i.isGit, false);
  assert.deepEqual(i.repos, ["apps/admin", "client", "server"]);
  assert.match(describeInspection(i), /holds 3 git repositories: apps\/admin, client, server/);

  const project: any = { id: "prj_multi", name: "game", directory: dir, allowedModels: ["a/b"], agents: [], connections: [] };
  assert.equal(await resolveRepository(project, "./server/"), "server");
  assert.equal(await resolveRepository(project, "apps\\admin"), "apps/admin");
  await assert.rejects(resolveRepository(project, "notes"), /isn't one of this project's repositories: apps\/admin, client, server/);
  await assert.rejects(resolveRepository(project, "../elsewhere"), /isn't one of/);

  assert.match(coordinatorBrief(project), /made of \*\*3 git repositories\*\*/);
  assert.match(coordinatorBrief(project), /never create one on top of them/);
});

test("a helper's own copy comes from its repository, and merges go back there", async () => {
  const dir = await folderOfRepos();
  const project: any = { id: "prj_multi2", name: "game", directory: dir, agents: [] };
  const ws = await createWorkspace(project, "api-dev", "own", "server");
  assert.ok(ws.branch && ws.directory !== dir);
  assert.ok(existsSync(path.join(ws.directory, "README.md")));
  assert.equal(readFileSync(path.join(ws.directory, "README.md"), "utf8").replace(/\r\n/g, "\n"), "# server\n");
  const agent: any = { id: "agt_x", name: "api-dev", role: "worker", repo: "server", directory: ws.directory, branch: ws.branch, base: ws.base };

  writeFileSync(path.join(ws.directory, "api.txt"), "endpoints\n");
  await commitAll(ws.directory, "api");
  const merged = await mergeWorkspace(project, agent);
  assert.equal(merged.ok, true);
  assert.ok(existsSync(path.join(dir, "server", "api.txt")), "merged into the server repository");
  assert.ok(!existsSync(path.join(dir, "client", "api.txt")));
  assert.equal(await syncWorkspace(project, agent), await git(path.join(dir, "server"), "rev-parse", "HEAD"));
  assert.ok(!existsSync(path.join(dir, ".git")), "no repository was created on top");

  // A shared helper or core pushes from the project folder: it names the repository.
  const inFolder = { directory: dir };
  await assert.rejects(gitRepoFor(project, inFolder), /several repositories \(apps\/admin, client, server\); say which one with repo/);
  assert.equal(await gitRepoFor(project, inFolder, "client"), "client");
  assert.equal(await gitRepoFor(project, { directory: dir, repo: "server" }), "server");
  assert.equal(await gitRepoFor(project, agent), null, "an own copy pushes itself");
  await assert.rejects(gitRepoFor(project, agent, "client"), /own copy/);

  assert.match(workerBrief(project, agent, "core"), /isolated copy of the "server" repository/);
  await removeWorkspace(project, agent);
  assert.ok(!existsSync(ws.directory));
});

test("unpushed work is checked in each repository", async () => {
  const dir = await folderOfRepos();
  const remote = mkdtempSync(path.join(os.tmpdir(), "sym-remote-"));
  await git(remote, "init", "-q", "--bare");
  const client = path.join(dir, "client");
  await git(client, "remote", "add", "origin", remote);
  const branch = await git(client, "rev-parse", "--abbrev-ref", "HEAD");
  await git(client, "push", "-q", "origin", branch);
  writeFileSync(path.join(client, "new.txt"), "x\n");
  await commitAll(client, "local only");
  const found = await unpushedWork({ directory: dir } as any);
  assert.equal(found.remote, "origin");
  assert.deepEqual(found.branches.map((b) => [b.branch, b.commits, b.latest]), [[`client: ${branch}`, 1, "local only"]]);
});

test("a repository created on top of others is recognized", async () => {
  const dir = await folderOfRepos();
  await initRepository(dir); // what older versions did: inner repositories become bare pointers
  const s = await swallowedRepositories(dir);
  assert.deepEqual(s.inner, ["apps/admin", "client", "server"]);
  assert.equal(s.createdBySymbio, true);
  const i = await inspectFolder(dir);
  assert.equal(i.isGit, true);
  assert.deepEqual(i.repos, []);
  assert.deepEqual(i.swallowed?.inner, ["apps/admin", "client", "server"]);
});

test("a repository on top of others: the update wakes core with a task, and the project can switch to the inner ones", async () => {
  const { describeOuterRepository, projectRepositoriesSync } = await import("../src/server/repos.js");
  const { AGENT_UPDATES } = await import("../src/server/updates.js");
  const dir = await folderOfRepos();
  await initRepository(dir);
  const project: any = { id: "prj_sw", name: "game", directory: dir, allowedModels: ["a/b"], connections: [], agents: [
    { name: "writer", role: "worker", status: "idle", branch: "symbio/writer", directory: "x" },
  ] };

  const update = AGENT_UPDATES.find((u) => u.id === "2026-11-09-multi-repo")!;
  const task = await update.task!(project);
  assert.match(task!, /contains other repositories \(apps\/admin, client, server\)/);
  assert.match(task!, /Symbio created it on top of them/);
  assert.match(task!, /sub_repositories \(action check\)/);
  assert.equal(await update.task!({ ...project, subRepositories: false }), null, "already decided");
  assert.equal(await update.task!({ ...project, directory: await folderOfRepos() }), null, "not this situation");

  const report = await describeOuterRepository(project);
  assert.match(report, /created by Symbio/);
  assert.match(report, /It has no remote/);
  assert.match(report, /own copy of the outer repository: writer \(idle\)/);

  assert.deepEqual(projectRepositoriesSync(project), []);
  assert.match(coordinatorBrief(project), /check with sub_repositories/);
  project.subRepositories = true;
  assert.deepEqual(projectRepositoriesSync(project), ["apps/admin", "client", "server"]);
  assert.match(coordinatorBrief(project), /repository created on top of them earlier; leave it alone/);
  await assert.rejects(gitRepoFor(project, { directory: dir }), /say which one with repo/);
  const ws = await createWorkspace(project, "api-dev", "own", "server");
  assert.equal(await git(ws.directory, "remote").catch(() => ""), "");
  assert.ok(existsSync(path.join(ws.directory, "README.md")), "the copy comes from the inner repository, with its files");
});
