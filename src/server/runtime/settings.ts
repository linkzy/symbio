// Opt-in settings for agent runtimes. Symbio keeps its own tested copies by default; using a copy
// already on the computer (found on the PATH) is a deliberate choice per runtime, stored here (a
// module-owned file, like machine.json), so the CLI's doctor sees the same setting as the server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fsutil.js";
import { globalDir } from "../store.js";
import type { RuntimeKind } from "./types.js";

export interface RuntimeSettings {
  /** Per runtime: run the copy on the computer instead of Symbio's tested one. Off by default. */
  fromComputer: Partial<Record<RuntimeKind, boolean>>;
  /** OpenCode's choice under its first name (0.23.0), still written for older versions. */
  usePathOpenCode: boolean;
}

const settingsFile = () => path.join(globalDir, "runtime-settings.json");

function normalize(raw: any): RuntimeSettings {
  const fromComputer: Partial<Record<RuntimeKind, boolean>> = {};
  for (const [kind, on] of Object.entries(raw?.fromComputer ?? {})) if (on === true) fromComputer[kind as RuntimeKind] = true;
  if (raw?.usePathOpenCode === true && raw?.fromComputer?.opencode === undefined) fromComputer.opencode = true;
  return { fromComputer, usePathOpenCode: fromComputer.opencode === true };
}

export function loadRuntimeSettings(): RuntimeSettings {
  try {
    return normalize(JSON.parse(readFileSync(settingsFile(), "utf8")));
  } catch {
    return normalize({});
  }
}

/** Sets one runtime's choice; the others stay as they are. */
export async function setFromComputer(kind: RuntimeKind, on: boolean): Promise<RuntimeSettings> {
  const current = loadRuntimeSettings();
  const next = normalize({ fromComputer: { ...current.fromComputer, [kind]: on } });
  await writeFileAtomic(settingsFile(), JSON.stringify(next, null, 2) + "\n");
  return next;
}
