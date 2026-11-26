import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
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
    // Just installed while Symbio runs: the installer changed the PATH of new terminals, not
    // ours. Find it where installers put it and use it from now on, so no restart is needed.
    for (const dir of gitInstallDirs()) {
      const exe = path.join(dir, process.platform === "win32" ? "git.exe" : "git");
      if (!existsSync(exe)) continue;
      try {
        await run(exe, ["--version"], { windowsHide: true });
      } catch {
        continue;
      }
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
      return true;
    }
    return false;
  }
}

// Where git's installers put it. SYMBIO_GIT_SEARCH replaces the list (the tests use it to
// stand for a machine without git, since theirs has one).
function gitInstallDirs(): string[] {
  const override = process.env.SYMBIO_GIT_SEARCH;
  if (override !== undefined) return override.split(path.delimiter).filter(Boolean);
  if (process.platform !== "win32") return ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")];
  return roots.filter((r): r is string => !!r).map((r) => path.join(r, "Git", "cmd"));
}

/** How Symbio can install git on this machine for the human: winget on Windows, else none. */
export async function gitInstaller(): Promise<"winget" | null> {
  if (process.platform !== "win32") return null;
  try {
    await run("winget", ["--version"], { windowsHide: true, timeout: 15_000 });
    return "winget";
  } catch {
    return null;
  }
}

/**
 * Installs git with winget, when the human asks for it from the New project dialog. Windows may
 * ask for permission on this computer's screen. Resolves when git can be used.
 */
export async function installGit(): Promise<void> {
  if ((await gitInstaller()) !== "winget") throw new Error("Git can't be installed from here on this computer.");
  try {
    await run(
      "winget",
      ["install", "--id", "Git.Git", "--exact", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
      { windowsHide: true, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    const e = err as { stdout?: string; message: string };
    // winget explains itself on stdout; keep its last line, not the whole progress output.
    const said = (e.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /[a-z]/i.test(l)).pop();
    throw new Error(said || e.message);
  }
  if (!(await gitAvailable())) throw new Error("Git was installed, but Symbio can't find it yet. Restart Symbio, then check again.");
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
