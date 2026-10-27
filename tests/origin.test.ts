import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedRequest } from "../src/server/origin.js";

const PORT = 4310;
const ok = (method: string, host: string | null, origin: string | null = null) => isAllowedRequest({ method, host, origin }, PORT);

test("Symbio's own UI and local tools are allowed", () => {
  assert.equal(ok("GET", "127.0.0.1:4310"), true);
  assert.equal(ok("POST", "127.0.0.1:4310", "http://127.0.0.1:4310"), true);
  assert.equal(ok("POST", "localhost:4310", "http://localhost:4310"), true);
  assert.equal(ok("POST", "127.0.0.1:4310", "http://localhost:5173"), true, "Vite dev server");
  assert.equal(ok("POST", "127.0.0.1:4310"), true, "no Origin: curl, OpenCode's MCP calls");
});

test("other web pages and rebound hostnames are refused", () => {
  assert.equal(ok("POST", "127.0.0.1:4310", "https://evil.example"), false, "cross-site POST");
  assert.equal(ok("POST", "127.0.0.1:4310", "null"), false, "sandboxed/file origin");
  assert.equal(ok("GET", "evil.example:4310"), false, "DNS rebinding");
  assert.equal(ok("POST", "attacker.localhost.example:4310", "http://attacker.localhost.example:4310"), false);
  assert.equal(ok("GET", null), false, "no Host");
});
