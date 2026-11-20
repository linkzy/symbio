// Opt-in settings for agent runtimes. Symbio keeps its own tested copies by default; using an
// executable from the PATH is a deliberate choice stored here (a module-owned file, like
// machine.json), so the CLI's doctor sees the same setting as the running server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fsutil.js";
import { globalDir } from "../store.js";

export interface RuntimeSettings {
  /** Run an OpenCode found on PATH instead of Symbio's tested copy. Off by default. */
  usePathOpenCode: boolean;
}

const defaults: RuntimeSettings = { usePathOpenCode: false };
const settingsFile = () => path.join(globalDir, "runtime-settings.json");

export function loadRuntimeSettings(): RuntimeSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8"));
    return { usePathOpenCode: raw?.usePathOpenCode === true };
  } catch {
    return { ...defaults };
  }
}

export async function saveRuntimeSettings(value: RuntimeSettings): Promise<RuntimeSettings> {
  const saved = { usePathOpenCode: value.usePathOpenCode === true };
  await writeFileAtomic(settingsFile(), JSON.stringify(saved, null, 2) + "\n");
  return saved;
}
