import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-img-home-"));
const { viewImage } = await import("../src/server/images.js");

test("view_image: a scaled-down copy, crops at full resolution, only images, never secrets", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-img-"));
  writeFileSync(path.join(dir, "big.png"), await sharp({ create: { width: 3000, height: 2000, channels: 4, background: "#dd2222" } }).png().toBuffer());
  writeFileSync(path.join(dir, "notes.txt"), "hi");

  const res: any = await viewImage(dir, { path: "big.png" });
  const img = res.content.find((c: any) => c.type === "image");
  const meta = await sharp(Buffer.from(img.data, "base64")).metadata();
  assert.equal(Math.max(meta.width!, meta.height!), 1024, "longest side 1024 by default");
  assert.equal(img.mimeType, "image/jpeg");
  assert.match(res.content[0].text, /3000×2000 px, shown at 1024×683\. For details, ask for a crop/);

  const crop: any = await viewImage(dir, { path: path.join(dir, "big.png"), crop: { left: 100, top: 100, width: 300, height: 200 } });
  const cropMeta = await sharp(Buffer.from(crop.content[1].data, "base64")).metadata();
  assert.deepEqual([cropMeta.width, cropMeta.height], [300, 200], "a crop keeps full resolution");
  await assert.rejects(viewImage(dir, { path: "big.png", crop: { left: 2990, top: 0, width: 0, height: 10 } }), /inside the 3000×2000 image/);

  await assert.rejects(viewImage(dir, { path: "notes.txt" }), /Not an image/);
  await assert.rejects(viewImage(dir, { path: "missing.png" }), /No such file/);
  mkdirSync(path.join(dir, ".ssh"));
  writeFileSync(path.join(dir, ".ssh", "key.png"), "x");
  await assert.rejects(viewImage(dir, { path: ".ssh/key.png" }), /Not allowed/);
});
