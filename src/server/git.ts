import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await run("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns a folder into a git repository with a first snapshot of whatever is in it,
 * so worktrees (which only contain committed files) have the project's content.
 */
export async function initRepository(dir: string): Promise<void> {
  await git(dir, "init");
  await git(dir, "add", "-A");
  // Use a fallback identity only if the user has none configured.
  const identity: string[] = [];
  const name = await git(dir, "config", "user.name").catch(() => "");
  const email = await git(dir, "config", "user.email").catch(() => "");
  if (!name) identity.push("-c", "user.name=Symbio");
  if (!email) identity.push("-c", "user.email=symbio@localhost");
  await git(dir, ...identity, "commit", "--allow-empty", "-m", "Initial snapshot (created by Symbio)");
}
