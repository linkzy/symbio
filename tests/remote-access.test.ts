import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CODE_LENGTH,
  codesMatch,
  cookieValue,
  isTunnelRequest,
  MAX_FAILURES,
  newAccessCode,
  RemoteAccess,
  remoteDecision,
} from "../src/server/remote-access.js";

test("access codes: 8 unambiguous characters, typed loosely", () => {
  for (let i = 0; i < 50; i++) {
    const code = newAccessCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^[A-HJKMNP-Z2-9]+$/, "no 0/O/1/I/L");
  }
  assert.equal(codesMatch("AB23CD45", "ab23 cd45"), true, "case and spaces don't matter");
  assert.equal(codesMatch("AB23CD45", "AB23-CD45"), true);
  assert.equal(codesMatch("AB23CD45", "AB23CD46"), false);
  assert.equal(codesMatch("AB23CD45", ""), false);
});

test("tunnel requests are recognized by Cloudflare's headers or the tunnel's host", () => {
  assert.equal(isTunnelRequest({ host: "127.0.0.1:4310" }, null), false);
  assert.equal(isTunnelRequest({ host: "127.0.0.1:4310", cfRay: "abc" }, null), true, "Cloudflare headers, whatever the Host");
  assert.equal(isTunnelRequest({ host: "x-y.trycloudflare.com" }, "x-y.trycloudflare.com"), true);
  assert.equal(isTunnelRequest({ host: "localhost:4310" }, "x-y.trycloudflare.com"), false);
});

test("what a remote request may reach", () => {
  const d = (path: string, hasSession = true, method = "GET", active = true) => remoteDecision({ method, path, hasSession, active });
  assert.equal(d("/", true, "GET", false), "deny", "nothing when remote access is off");
  assert.equal(d("/"), "allow");
  assert.equal(d("/api/projects"), "allow", "the API (the UI key is still required on top)");
  assert.equal(d("/", false), "login-page");
  assert.equal(d("/assets/index.js", false), "login-page", "no UI files before logging in");
  assert.equal(d("/api/projects", false), "need-login");
  assert.equal(d("/remote-login", false), "login-page");
  assert.equal(d("/remote-login", false, "POST"), "login-submit");
  for (const p of ["/mcp/tok", "/api/debug/opencode/x", "/api/shutdown", "/api/remote/start", "/api/pick-folder"]) {
    assert.equal(d(p), "deny", `${p} is never remote, even with a session`);
  }
  assert.equal(d("/api/remote/stop", true, "POST"), "allow", "a remote session may turn remote access off");
});

test("cookies", () => {
  assert.equal(cookieValue("a=1; symbio_remote=xyz; b=2", "symbio_remote"), "xyz");
  assert.equal(cookieValue("symbio_remote_x=1", "symbio_remote"), null);
  assert.equal(cookieValue(undefined, "symbio_remote"), null);
});

test(`sessions need the right code; ${MAX_FAILURES} wrong codes turn remote access off`, async () => {
  const remote: any = new RemoteAccess(path.join(os.tmpdir(), "sym-remote-test"));
  // Pretend a tunnel is open (no network in tests).
  remote.proc = { exitCode: null, kill() {} };
  remote.url = "https://test-tunnel.trycloudflare.com";
  remote.code = "AB23CD45";
  let changes = 0;
  remote.onChange = () => changes++;

  const ok = await remote.login("ab23cd45");
  assert.equal(ok.ok, true);
  assert.equal(remote.hasSession(`symbio_remote=${ok.session}`), true);
  assert.equal(remote.hasSession("symbio_remote=forged"), false);
  assert.equal(remote.status(false).code, undefined, "the code is never shown remotely");
  assert.equal(remote.status(true).code, "AB23CD45");

  remote.login = remote.login.bind(remote);
  const origSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void) => origSetTimeout(fn, 0); // skip the anti-guessing delay
  try {
    for (let i = 0; i < MAX_FAILURES - 1; i++) assert.equal((await remote.login("WRONG")).ok, false);
    assert.equal(remote.active, true, "still on after 9 wrong codes");
    await remote.login("WRONG");
    assert.equal(remote.active, false, "off after the 10th");
    assert.equal(remote.hasSession(`symbio_remote=${ok.session}`), false, "existing sessions end too");
    assert.match(remote.status(true).lastStop.reason, /wrong access codes/);
  } finally {
    (globalThis as any).setTimeout = origSetTimeout;
  }
  assert.ok(changes >= 2);
});
