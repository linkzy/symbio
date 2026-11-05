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

test("raw docs files: PDFs show inline, other types download, nothing outside the docs is served", async () => {
  const { rawDoc } = await import("../src/server/docs.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-raw-"));
  mkdirSync(path.join(dir, "docs", "guias"), { recursive: true });
  mkdirSync(path.join(dir, ".symbio"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "guias", "manual.pdf"), "%PDF-1.4 test");
  writeFileSync(path.join(dir, "docs", "page.html"), "<script>alert(1)</script>");
  writeFileSync(path.join(dir, ".symbio", "project.json"), "{}");
  writeFileSync(path.join(dir, "secret.txt"), "no");
  const project: any = { directory: dir, docsLocation: "project" };

  const pdf = await rawDoc(project, "docs/guias/manual.pdf");
  assert.equal(pdf.type, "application/pdf");
  assert.equal(pdf.inline, true);
  const html = await rawDoc(project, "docs/page.html");
  assert.equal(html.inline, false, "HTML is never shown inline (it could run scripts)");
  for (const outside of ["secret.txt", ".symbio/project.json", "docs/../secret.txt", "../outside.pdf"]) {
    await assert.rejects(rawDoc(project, outside), /Not a docs file/, outside);
  }
});
