// The key the browser UI must present on every API request.
//
// Binding to 127.0.0.1 isn't enough: agents run shell commands on this machine, and
// without a key one could `curl` the API to approve its own pending actions, answer
// its own permission prompts or loosen a connection. The key lives in
// ~/.symbio/ui-token (agents are denied reading it, see guard.ts) and reaches the
// browser once, through the link Symbio opens; the UI keeps it in localStorage.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function loadUiToken(dir: string): string {
  const file = path.join(dir, "ui-token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token.length >= 32) return token;
  }
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
