// view_image: agents look at images through scaled-down copies. A full-size image read into a
// conversation stays there and is re-sent every turn; a few large ones made a conversation too
// big to send at all. A crop shows one region at full resolution when details matter.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type SharpModule from "sharp";
import { IMAGE_EXTENSIONS, isSecretPath } from "./guard.js";
import type { ToolResult } from "./mcp.js";

export const DEFAULT_IMAGE_SIZE = 1024;
const MAX_IMAGE_SIZE = 2048;
const MAX_BYTES = 1_500_000; // what we send back, after scaling

/**
 * The image library is native and loaded on first use, so a problem with it (a platform without
 * prebuilt binaries, an old Node) costs only view_image, not Symbio's startup.
 */
async function loadSharp(): Promise<typeof SharpModule> {
  try {
    return (await import("sharp")).default;
  } catch (err) {
    throw new Error(`Images can't be viewed on this machine: the image library didn't load (${(err as Error).message.split("\n")[0]}).`);
  }
}

export async function viewImage(
  folder: string,
  input: { path?: unknown; max_size?: unknown; crop?: unknown },
): Promise<ToolResult> {
  const given = String(input.path ?? "").trim();
  if (!given) throw new Error("Give the image's path.");
  const file = path.resolve(folder, given);
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Not an image (${IMAGE_EXTENSIONS.join(", ")}): ${given}`);
  if (isSecretPath(file)) throw new Error(`Not allowed: ${given}`);
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);

  const size = Math.min(MAX_IMAGE_SIZE, Math.max(64, Math.round(Number(input.max_size) || DEFAULT_IMAGE_SIZE)));
  const sharp = await loadSharp();
  let image = sharp(await fs.readFile(file), { animated: false }).rotate(); // apply EXIF orientation
  const meta = await image.metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new Error(`Couldn't read the image: ${given}`);

  let note = `${given}: ${width}×${height} px`;
  const crop = input.crop as { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | undefined;
  if (crop && typeof crop === "object") {
    const left = Math.max(0, Math.floor(Number(crop.left) || 0));
    const top = Math.max(0, Math.floor(Number(crop.top) || 0));
    const w = Math.min(width - left, Math.floor(Number(crop.width) || 0));
    const h = Math.min(height - top, Math.floor(Number(crop.height) || 0));
    if (w <= 0 || h <= 0) throw new Error(`The crop must lie inside the ${width}×${height} image (left, top, width, height in pixels).`);
    image = image.extract({ left, top, width: w, height: h });
    note += `, region ${w}×${h} at (${left}, ${top})`;
  }
  image = image.resize({ width: size, height: size, fit: "inside", withoutEnlargement: true });

  // JPEG keeps it small; flatten transparency onto white so it stays readable.
  let quality = 82;
  let out = await image.clone().flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
  while (out.data.length > MAX_BYTES && quality > 40) {
    quality -= 15;
    out = await image.clone().flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
  }
  note += `, shown at ${out.info.width}×${out.info.height}.`;
  if (!crop && (out.info.width < width || out.info.height < height)) note += " For details, ask for a crop (a region in the original's pixels), shown at full resolution.";
  return { content: [{ type: "text", text: note }, { type: "image", data: out.data.toString("base64"), mimeType: "image/jpeg" }] };
}
