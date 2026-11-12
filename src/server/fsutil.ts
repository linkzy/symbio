// Saving files safely: written to a temporary file next to the target, then moved over it, so a
// crash never leaves half a file.

import { promises as fs } from "node:fs";

// Windows refuses to replace a file another process has open (an antivirus scan, the search
// indexer, a backup tool) with EPERM/EBUSY/EACCES for a moment; seen on CI machines with real-time
// scanning. Retried with growing pauses, about 6 seconds in all.
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const ATTEMPTS = 8;

/** Moves `tmp` over `dest`, retrying while Windows briefly holds `dest`. Removes `tmp` if it gives up. */
export async function replaceFile(tmp: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, dest);
      return;
    } catch (err: any) {
      if (attempt + 1 >= ATTEMPTS || !TRANSIENT.has(err?.code)) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}
