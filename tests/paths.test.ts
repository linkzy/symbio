// Finding file paths in what agents write, so they can become links.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codePath, fileHref, findPaths, parseFileHref, remarkPaths } from "../web/src/paths.js";

const paths = (text: string) => findPaths(text).map((m) => (m.line ? `${m.path}@${m.line}` : m.path));

test("paths in plain text, with the line mentioned after them", () => {
  assert.deepEqual(paths("ONDE: docs/regras/checagem-ia.md (branch symbio/ia, commit 862c2812)"), ["docs/regras/checagem-ia.md"]);
  assert.deepEqual(paths("Abra docs/regras/checagem-ia.md. Linha 6: \"conferidas\""), ["docs/regras/checagem-ia.md@6"]);
  assert.deepEqual(paths("see src/Web/Program.cs:42 and C:\\repos\\Estagio\\README.md, line 3"), ["src/Web/Program.cs@42", "C:/repos/Estagio/README.md@3"]);
  assert.deepEqual(paths("the log at ./out/publicar.log#L10"), ["./out/publicar.log@10"]);
  assert.deepEqual(paths("version v0.12.0, 3.5/10 stars, https://example.com/docs/page.html, Node.js and e.g. this"), [], "no versions, ratios, URLs or words");
  assert.deepEqual(paths("ships in /AcessosDeTeste"), [], "a route without a file name isn't a file");
});

test("inline code that is a path or a file name", () => {
  assert.deepEqual(codePath("padrao.md"), { path: "padrao.md" });
  assert.deepEqual(codePath("docs/convencoes.md:12"), { path: "docs/convencoes.md", line: 12 });
  assert.equal(codePath("git merge main"), null);
  assert.equal(codePath("0.12.0"), null);
  assert.equal(codePath("https://x.io/a.js"), null);
});

test("links carry the path and line, and the plugin leaves code blocks and links alone", () => {
  assert.deepEqual(parseFileHref(fileHref("docs/a b.md", 6)), { path: "docs/a b.md", line: 6 });
  assert.equal(parseFileHref("https://example.com"), null);
  const tree: any = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "Open docs/x.md now" }, { type: "inlineCode", value: "y.cs" }] },
      { type: "code", value: "cat docs/x.md" },
      { type: "paragraph", children: [{ type: "link", url: "https://e.com", children: [{ type: "text", value: "docs/x.md" }] }] },
    ],
  };
  remarkPaths()(tree);
  const [p1, code, p2] = tree.children;
  assert.deepEqual(
    p1.children.map((c: any) => c.type),
    ["text", "link", "text", "link"],
  );
  assert.equal(p1.children[1].url, fileHref("docs/x.md"));
  assert.equal(p1.children[3].children[0].type, "inlineCode");
  assert.equal(code.value, "cat docs/x.md", "code blocks untouched");
  assert.equal(p2.children[0].url, "https://e.com", "existing links untouched");
});
