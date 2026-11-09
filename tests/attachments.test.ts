import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-att-home-"));
const { addAttachment, attachmentNote, getAttachments, listAttachments, markSent, removeAttachment, safeName } = await import("../src/server/attachments.js");
const { readDocument } = await import("../src/server/documents.js");

/** A minimal one-page PDF per text. */
function pdf(pages: string[]): Buffer {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  pages.forEach((t, i) => {
    const stream = `BT /F1 18 Tf 20 70 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("read_document: PDF by pages, Word, Excel and PowerPoint as text", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-docs-"));
  writeFileSync(path.join(dir, "report.pdf"), pdf(["First page text", "Second page text", "Third page"]));
  writeFileSync(
    path.join(dir, "notes.docx"),
    zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t><w:tab/><w:t>para</w:t></w:r></w:p></w:body></w:document>') }),
  );
  writeFileSync(
    path.join(dir, "data.xlsx"),
    zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Paper</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row></sheetData></worksheet>'),
    }),
  );
  writeFileSync(
    path.join(dir, "deck.pptx"),
    zipSync({
      "ppt/slides/slide2.xml": strToU8("<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>"),
      "ppt/slides/slide1.xml": strToU8("<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Subtitle</a:t></a:r></a:p></p:sld>"),
    }),
  );

  const all = await readDocument(dir, { path: "report.pdf" });
  assert.match(all, /3 pages, showing 1–3/);
  assert.match(all, /--- page 2 ---\nSecond page text/);
  const one = await readDocument(dir, { path: "report.pdf", pages: "3" });
  assert.match(one, /showing 3–3/);
  assert.doesNotMatch(one, /First page/);

  assert.match(await readDocument(dir, { path: "notes.docx" }), /Hello & welcome\nSecond\tpara/);
  assert.match(await readDocument(dir, { path: "data.xlsx" }), /## Budget\nItem\tCost\nPaper\t\t12\.5/);
  assert.match(await readDocument(dir, { path: "deck.pptx" }), /--- slide 1 ---\nTitle\nSubtitle\n\n--- slide 2 ---\nSecond slide/);

  // Long texts come a part at a time.
  writeFileSync(path.join(dir, "long.txt"), "x".repeat(45_000));
  assert.match(await readDocument(dir, { path: "long.txt" }), /call read_document with from=40000/);
  assert.match(await readDocument(dir, { path: "long.txt", from: 40000 }), /characters 40001–45000 of 45000/);

  await assert.rejects(readDocument(dir, { path: "missing.pdf" }), /No such file/);
  await assert.rejects(readDocument(dir, { path: "tool.exe" }), /Not a document/);
  mkdirSync(path.join(dir, ".ssh"));
  writeFileSync(path.join(dir, ".ssh", "keys.txt"), "secret");
  await assert.rejects(readDocument(dir, { path: ".ssh/keys.txt" }), /Not allowed/);
});

test("attachments: stored in the project with safe names, listed, noted for the agent, sent, removed", async () => {
  const project: any = { id: "prj_att", directory: mkdtempSync(path.join(os.tmpdir(), "sym-attp-")) };
  assert.equal(safeName("../../etc/pass:wd?.png"), "pass_wd_.png");
  assert.equal(safeName("C:\\Users\\me\\shot.png"), "shot.png");
  assert.equal(safeName(".hidden"), "hidden");

  const img = await addAttachment(project, "screen shot.png", new Uint8Array([1, 2, 3]), "image/png");
  const doc = await addAttachment(project, "spec.pdf", new Uint8Array(2048), "application/pdf");
  assert.ok(existsSync(img.file) && img.file.startsWith(path.join(project.directory, ".symbio", "attachments")));
  assert.match(path.basename(img.file), /^[a-z0-9]{8}-screen shot\.png$/);
  assert.equal((await listAttachments(project)).length, 2);

  const note = attachmentNote([img, doc]);
  assert.match(note, /\[Attached by the human — 2 files, saved in the project:\]/);
  assert.match(note, new RegExp(`- ${img.file.replace(/[\\.]/g, "\\$&")} \\(screen shot\\.png, 1 KB; image: look at it with view_image\\)`));
  assert.match(note, /spec\.pdf, 2 KB; document: read it with read_document/);

  await markSent(project, [img.id], "agt_core");
  assert.equal((await getAttachments(project, [img.id]))[0].sentTo[0].agentId, "agt_core");
  await assert.rejects(getAttachments(project, ["att_nope"]), /not found/);

  await removeAttachment(project, img.id);
  assert.ok(!existsSync(img.file));
  assert.deepEqual((await listAttachments(project)).map((a) => a.name), ["spec.pdf"]);
  await assert.rejects(addAttachment(project, "huge.bin", new Uint8Array(51 * 1024 * 1024), ""), /larger than 50 MB/);
});
