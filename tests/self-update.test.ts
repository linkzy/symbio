import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-upd-home-"));
const { compareVersions, installInfo, parseChangelog, SelfUpdate } = await import("../src/server/self-update.js");

test("versions compare numerically, a pre-release before its release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.3"), 1);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  assert.equal(compareVersions("0.6.0", "0.6.1"), -1);
  assert.equal(compareVersions("0.3.0", "0.3.0-beta.2"), 1);
  assert.equal(compareVersions("0.3.0-beta.2", "0.3.0-beta.1"), 1);
  assert.equal(compareVersions("v1.0.0", "0.99.0"), 1);
});

test("changelog sections and their items, with wrapped lines joined", () => {
  const notes = parseChangelog("# Changelog\n\n## [Unreleased]\n\n## [0.7.0]\n\n- A thing\n  that wraps.\n- Another.\n\n## [0.6.0]\n\n- Old.\n");
  assert.deepEqual(notes, [
    { version: "0.7.0", items: ["A thing that wraps.", "Another."] },
    { version: "0.6.0", items: ["Old."] },
  ]);
});

test("a global npm install can update itself; a clone (npm link) is a development copy", () => {
  const prefix = mkdtempSync(path.join(os.tmpdir(), "sym-prefix-"));
  const root = path.join(prefix, process.platform === "win32" ? "" : "lib", "node_modules", "symbio");
  mkdirSync(root, { recursive: true });
  const npm = installInfo(root);
  assert.equal(npm.kind, "npm");
  assert.equal(path.resolve(npm.prefix!), path.resolve(prefix));

  const clone = mkdtempSync(path.join(os.tmpdir(), "sym-clone-"));
  mkdirSync(path.join(clone, ".git"));
  assert.equal(installInfo(clone).kind, "dev");
});

test("automatic updates wait for an idle team, remote access off, and skip a version that just failed", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sym-upd-"));
  let busy: string | null = "core in P is working";
  let remote = false;
  const announced: string[] = [];
  const host = {
    version: "0.6.0",
    home,
    port: 1,
    busy: () => busy,
    remoteActive: () => remote,
    backup: async () => {},
    announce: async (t: string) => void announced.push(t),
    shutdown: async () => {},
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) =>
    String(url).endsWith("/symbio/latest") ? new Response(JSON.stringify({ version: "0.7.0" })) : new Response("", { status: 404 })) as any;
  try {
    const up = new SelfUpdate(host as any, { kind: "npm", root: home, prefix: home });
    await up.load();
    const s = await up.check();
    assert.equal(s.available, true);
    assert.match(s.waiting!, /Waiting for the team to be idle \(core in P is working\)/);
    busy = null;
    remote = true;
    assert.match(up.state().waiting!, /Remote access is on/);
    remote = false;
    assert.equal(up.state().waiting, null, "nothing in the way");
    await up.setMode("notify");
    assert.match(up.state().waiting!, /notify only/);

    // The runner reported a failure: the human is told once, and that version waits a day.
    writeFileSync(path.join(home, "update-result.json"), JSON.stringify({ from: "0.6.0", to: "0.7.0", ok: false, error: "EPERM", finishedAt: Date.now(), seen: false }));
    const again = new SelfUpdate(host as any, { kind: "npm", root: home, prefix: home });
    await again.load();
    await again.setMode("auto");
    await again.check();
    assert.match(announced.at(-1)!, /couldn't update to 0.7.0.*EPERM/);
    assert.match(again.state().waiting!, /failed recently/);
    const third = new SelfUpdate(host as any, { kind: "npm", root: home, prefix: home });
    await third.load();
    assert.equal(announced.filter((a) => /couldn't update/.test(a)).length, 1, "told only once");

    // A development copy never updates itself.
    const dev = new SelfUpdate(host as any, { kind: "dev", root: home, prefix: null });
    await dev.check();
    await assert.rejects(dev.apply(true), /development folder/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a release that needs a newer Node.js is never installed (npm would install it and it wouldn't start)", async () => {
  const { nodeSatisfies } = await import("../src/server/self-update.js");
  assert.equal(nodeSatisfies(">=22", "18.18.0"), false);
  assert.equal(nodeSatisfies(">=22", "22.0.0"), true);
  assert.equal(nodeSatisfies(">=20.9.0", "20.8.1"), false);
  assert.equal(nodeSatisfies(null, "18.0.0"), true);
  assert.equal(nodeSatisfies("^22 || ^24", "18.0.0"), true, "unknown forms are assumed met");

  const home = mkdtempSync(path.join(os.tmpdir(), "sym-upd-node-"));
  const host = { version: "0.6.0", home, port: 1, busy: () => null, remoteActive: () => false, backup: async () => {}, announce: async () => {}, shutdown: async () => {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) =>
    String(url).endsWith("/symbio/latest") ? new Response(JSON.stringify({ version: "9.0.0", engines: { node: ">=999" } })) : new Response("", { status: 404 })) as any;
  try {
    const up = new SelfUpdate(host as any, { kind: "npm", root: home, prefix: home });
    await up.load();
    await up.check();
    assert.match(up.state().waiting!, /needs Node\.js >=999/);
    await assert.rejects(up.apply(true), /update Node\.js first/, "not even when the human asks");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("going back to an earlier version (sym update --to): installed, and automatic updates wait for the next release", async () => {
  const { readFileSync } = await import("node:fs");
  const home = mkdtempSync(path.join(os.tmpdir(), "sym-upd-back-"));
  let latest = "0.10.0";
  const announced: string[] = [];
  const host = (version: string) => ({ version, home, port: 1, busy: () => null, remoteActive: () => false, backup: async () => {}, announce: async (t: string) => void announced.push(t), shutdown: async () => {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/symbio/latest")) return new Response(JSON.stringify({ version: latest, engines: { node: ">=22" } }));
    const v = u.match(/\/symbio\/([\d.]+)$/)?.[1];
    return v && ["0.9.0", "0.10.0", "0.10.1"].includes(v) ? new Response(JSON.stringify({ version: v, engines: { node: ">=22" } })) : new Response("", { status: 404 });
  }) as any;
  try {
    const up = new SelfUpdate(host("0.10.0") as any, { kind: "npm", root: home, prefix: home });
    const runs: any[] = [];
    up.runRunner = async (opts: any) => void runs.push(opts);
    await up.load();
    await up.check();
    await assert.rejects(up.apply(true, "9.9.9"), /There's no Symbio 9\.9\.9 on npm/);
    await assert.rejects(up.apply(true, "0.10.0"), /already the one running/);
    assert.match(await up.apply(true, "0.9.0"), /Installing 0\.9\.0/);
    assert.equal(runs[0].to, "0.9.0", "the updater installs that version");
    assert.match(announced.at(-1)!, /going back from 0\.10\.0 to 0\.9\.0/);
    const settings = JSON.parse(readFileSync(path.join(home, "updates.json"), "utf8"));
    assert.deepEqual([settings.skip.version, settings.skip.reason], ["0.10.0", "went-back"]);

    // Back on 0.9.0: 0.10.0 is still the latest, and isn't installed again automatically.
    const after = new SelfUpdate(host("0.9.0") as any, { kind: "npm", root: home, prefix: home });
    await after.load();
    await after.check();
    assert.equal(after.state().available, true, "still shown as available");
    assert.match(after.state().waiting!, /You went back from 0\.10\.0/);
    // A fix comes out: automatic updates resume.
    latest = "0.10.1";
    await after.check();
    assert.equal(after.state().waiting, null, "the next release installs as usual");
  } finally {
    globalThis.fetch = realFetch;
  }
});
