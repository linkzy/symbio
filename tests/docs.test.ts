import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-docs-home-"));
const { searchDocs } = await import("../src/server/docs.js");

test("docs search: every word, any case or accent, with line numbers; only docs are searched", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-docs-"));
  mkdirSync(path.join(dir, "docs", "regras"), { recursive: true });
  writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\nRead the rules first.\n");
  writeFileSync(path.join(dir, "docs", "regras", "postagem.md"), "# Regras\n\n| AP-001 | Conclusão do curso exigida |\n| AP-002 | Assinatura digital aceita |\n");
  writeFileSync(path.join(dir, "docs", "email.txt"), "line one\nA CONCLUSAO veio por e-mail\n");
  writeFileSync(path.join(dir, "notes.md"), "conclusão outside the docs\n"); // not a doc
  const project: any = { directory: dir, docsLocation: "project" };

  const { matches } = await searchDocs(project, "conclusao");
  assert.deepEqual(
    matches.map((m) => `${m.path}:${m.line}`).sort(),
    ["docs/email.txt:2", "docs/regras/postagem.md:3"],
    "accent- and case-insensitive, docs only",
  );
  assert.equal((await searchDocs(project, "assinatura DIGITAL")).matches.length, 1, "all words must be on the line");
  assert.equal((await searchDocs(project, "assinatura conclusão")).matches.length, 0);
  assert.equal((await searchDocs(project, "   ")).matches.length, 0, "empty query finds nothing");
});
