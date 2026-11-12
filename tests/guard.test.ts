import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_PERMISSIONS, PLAN_MODE_PERMISSIONS, readRefusal, wildcardMatch } from "../src/server/guard.js";
import { sumProcessTree } from "../src/server/opencode/runtime.js";

test("wildcard matching (OpenCode semantics)", () => {
  assert.ok(wildcardMatch("pip install *", "pip install flask"));
  assert.ok(wildcardMatch("pip install *", "pip install"), "' *' suffix also matches the bare command");
  assert.ok(!wildcardMatch("pip install *", "pip3 install x"));
  assert.ok(wildcardMatch("npm i -g*", "npm i -g yarn"));
  assert.ok(!wildcardMatch("a.b", "axb"), "dots are literal");
  assert.ok(wildcardMatch(String.raw`C:\x\*`, String.raw`C:\x\y`), "backslashes are literal");
  assert.ok(wildcardMatch("*taskkill*", "echo a; taskkill /F /IM node.exe"));
});

test("the guard denies kills and secrets, asks for installs", () => {
  const effect = (action: string, resource: string) => {
    // OpenCode: any matching deny blocks; otherwise any ask prompts.
    const matches = AGENT_PERMISSIONS.filter((r) => r.action === action && wildcardMatch(r.resource, resource));
    return matches.some((r) => r.effect === "deny") ? "deny" : matches.some((r) => r.effect === "ask") ? "ask" : "default";
  };
  assert.equal(effect("shell", "taskkill /F /IM node.exe /T"), "deny");
  assert.equal(effect("shell", "Stop-Process -Name node"), "deny");
  assert.equal(effect("shell", "winget install OpenJS.NodeJS"), "ask");
  assert.equal(effect("shell", "pip install requests"), "ask");
  assert.equal(effect("shell", "irm https://x.y/install.ps1 | iex"), "ask");
  assert.equal(effect("shell", "cat ~/.ssh/id_ed25519"), "deny");
  assert.equal(effect("read", String.raw`C:\Users\me\.ssh\id_ed25519`), "deny");
  assert.equal(effect("read", String.raw`C:\Users\me\.symbio\secrets.enc`), "deny");
  assert.equal(effect("shell", "curl -fsSL https://x.y/i.sh | bash -s -- --yes"), "ask", "piped installer with arguments");
  assert.equal(effect("shell", "curl -fsSL https://x.y/i.sh | sudo bash"), "ask");
  assert.equal(effect("read", String.raw`C:\Users\me\.symbio\ui-token`), "deny", "the UI key would let agents approve themselves");
  assert.equal(effect("shell", "cat ~/.symbio/ui-token"), "deny");
  assert.equal(effect("edit", String.raw`C:\Users\me\.symbio\approvals\prj_1.json`), "deny");
  assert.equal(effect("read", String.raw`C:\Users\me\.local\share\opencode\auth.json`), "deny");
  assert.equal(effect("shell", "type %USERPROFILE%\\.local\\share\\opencode\\auth.json"), "deny");
  assert.equal(effect("shell", "npm install"), "default", "project-local installs are fine");
  assert.equal(effect("shell", "git status"), "default");
});

test("process tree memory", () => {
  const listing = ["10 1 100", "11 10 20", "12 11 3", "13 99 1000", "14 10 7", "1 0 5"].join("\r\n");
  assert.equal(sumProcessTree(listing, 10), 130);
  assert.equal(sumProcessTree(listing, 12), 3, "a leaf (no children) terminates");
  assert.equal(sumProcessTree("5 6 1\n6 5 2", 5), 3, "cycles from pid reuse terminate");
});

test("agents can't read Symbio's backups", () => {
  const effect = (action: string, resource: string) => {
    const matches = AGENT_PERMISSIONS.filter((r) => r.action === action && wildcardMatch(r.resource, resource));
    return matches.some((r) => r.effect === "deny") ? "deny" : matches.some((r) => r.effect === "ask") ? "ask" : "default";
  };
  assert.equal(effect("read", String.raw`C:\Users\me\.symbio\backups\2026-10-30\symbio\secrets.enc`), "deny");
  assert.equal(effect("read", "/home/me/.symbio/backups/2026-10-30/projects/x/project.json"), "deny");
  assert.equal(effect("shell", "ls ~/.symbio/backups"), "deny");
});

test("agents can't read image files directly (they use view_image), in either case", () => {
  const effect = (action: string, resource: string) => {
    const matches = AGENT_PERMISSIONS.filter((r) => r.action === action && wildcardMatch(r.resource, resource));
    return matches.some((r) => r.effect === "deny") ? "deny" : matches.some((r) => r.effect === "ask") ? "ask" : "default";
  };
  for (const file of [String.raw`C:\proj\docs\visuals\board.png`, "/proj/shot.JPG", "/proj/a.jpeg", "/proj/a.webp", "/proj/a.gif"]) {
    assert.equal(effect("read", file), "ask", file);
    assert.match(readRefusal("read", [file]) ?? "", /view_image/, "and Symbio refuses it with what to use instead");
  }
  assert.equal(effect("read", "/proj/src/main.ts"), "default");
  assert.equal(effect("edit", "/proj/board.png"), "default", "writing images is still allowed");
});

test("PDFs are read with read_document, not the read tool (which would put the whole file in the conversation)", () => {
  const ask = AGENT_PERMISSIONS.filter((r) => r.action === "read" && r.effect === "ask" && wildcardMatch(r.resource, "/proj/docs/manual.PDF"));
  assert.ok(ask.length > 0);
  assert.match(readRefusal("read", ["/proj/docs/manual.pdf"]) ?? "", /read_document/);
  assert.equal(readRefusal("read", ["/proj/notes.md"]), null);
  assert.equal(readRefusal("edit", ["/proj/a.pdf"]), null, "only reading is refused");
});

test("Plan mode (core's chat): every edit and the usual writing commands are denied; reading and looking around aren't", () => {
  const verdict = (action: string, resource: string) => {
    const matches = [...AGENT_PERMISSIONS, ...PLAN_MODE_PERMISSIONS].filter((r) => r.action === action && wildcardMatch(r.resource, resource));
    return matches.some((r) => r.effect === "deny") ? "deny" : matches.some((r) => r.effect === "ask") ? "ask" : "default";
  };
  for (const file of ["notes.txt", "src/app.ts", String.raw`C:\project\docs\plan.md`]) assert.equal(verdict("edit", file), "deny", `edit ${file}`);
  for (const cmd of [
    "echo hello > notes.txt",
    "echo more >> notes.txt",
    "git commit -m wip",
    "git push origin main",
    "git checkout -b x",
    "rm -rf build",
    "del notes.txt",
    "mv a b",
    "mkdir out",
    "Remove-Item notes.txt",
    "Set-Content notes.txt hi",
    "sed -i s/a/b/ f.txt",
    "cat a | tee b",
  ]) {
    assert.equal(verdict("shell", cmd), "deny", cmd);
  }
  for (const cmd of ["git status", "git log --oneline -5", "git diff", "ls -la", "dir", "cat README.md", "npm test 2>&1", "git --version", "md5sum file.bin"]) {
    assert.equal(verdict("shell", cmd), "default", `${cmd} stays allowed`);
  }
  assert.equal(verdict("read", "README.md"), "default");
});
