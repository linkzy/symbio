// End-to-end harness: a real Symbio (the built dist/) against the stand-in OpenCode
// (fake-opencode.mjs, a scripted "model"), everything in temporary folders, driven through its
// API and a real browser (Edge or Chrome via playwright-core). Run `npm run build` first.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const repo = path.resolve(import.meta.dirname, "../..");

export interface Symbio {
  base: string;
  token: string;
  root: string;
  /** Symbio's API (JSON in, JSON out); throws on an error status. */
  call<T = any>(method: string, route: string, body?: unknown): Promise<T>;
  /** A new folder under the instance's temporary root. */
  folder(name: string): string;
  /** Symbio's output so far, for failure messages. */
  output(): string;
  stop(): Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

export async function startSymbio(env: Record<string, string> = {}): Promise<Symbio> {
  if (!existsSync(path.join(repo, "dist/server/index.js")) || !existsSync(path.join(repo, "dist/web/index.html"))) {
    throw new Error("Build Symbio first: npm run build");
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "sym-e2e-"));
  const port = await freePort();
  const fullEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SYMBIO_HOME: path.join(root, "home"),
    SYMBIO_PORT: String(port),
    SYMBIO_OPENCODE_BIN: path.join(repo, "tests/e2e/fake-opencode.mjs"),
    SYMBIO_NO_OPEN: "1",
    // Keeps the vault's test entries apart from real credentials.
    SYMBIO_KEYRING_SERVICE: `symbio-e2e-${port}`,
    ...env,
  };
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) fullEnv[k] = path.join(root, k);
  const proc: ChildProcess = spawn(process.execPath, [path.join(repo, "dist/server/index.js")], { env: fullEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(root, "home", "ui-token");
  await until("Symbio to start", () => existsSync(tokenFile), 30_000, () => log);
  const token = readFileSync(tokenFile, "utf8").trim();
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${base}/api${route}`, {
      method,
      headers: { "x-symbio-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${JSON.stringify(data)}`);
    return data;
  };
  await until("OpenCode (stand-in) to run", async () => (await call("GET", "/runtime").catch(() => null))?.state === "running", 30_000, () => log);

  return {
    base,
    token,
    root,
    call,
    folder(name) {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    output: () => log,
    async stop() {
      await call("POST", "/shutdown").catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) proc.kill();
    },
  };
}

/** Polls until `check` is true. */
export async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000, context?: () => string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}${context ? `\n--- Symbio output ---\n${context().slice(-3000)}` : ""}`);
}

export const MODEL = "fake/scripted";

/** A project with core started and its greeting turn done. */
export async function projectWithCore(symbio: Symbio, name: string, opts: { directory?: string; models?: string[] } = {}) {
  const directory = opts.directory ?? symbio.folder(name.toLowerCase().replace(/\W+/g, "-"));
  const models = opts.models ?? [MODEL];
  const project = await symbio.call("POST", "/projects", { name, directory, coordinatorModel: models[0], allowedModels: models });
  const { coordinator } = await symbio.call("POST", `/projects/${project.id}/start`);
  await idle(symbio, project.id);
  return { project, core: coordinator, directory };
}

/** Waits until no agent of the project is working. */
export async function idle(symbio: Symbio, projectId: string, ms = 20_000) {
  let quiet = 0;
  await until(
    "the team to be idle",
    async () => {
      const p = await symbio.call("GET", `/projects/${projectId}`);
      quiet = p.agents.every((a: any) => a.status !== "busy") ? quiet + 1 : 0;
      return quiet >= 3;
    },
    ms,
    symbio.output,
  );
}

/** An agent's conversation as plain text (messages and tool calls), for assertions. */
export async function history(symbio: Symbio, projectId: string, agentId: string): Promise<string> {
  const page = await symbio.call("GET", `/projects/${projectId}/agents/${agentId}/history?limit=100`);
  return (page.messages ?? []).map((m: any) => JSON.stringify(m)).join("\n");
}

/** A git repository with one commit. */
export function gitRepo(dir: string, files: Record<string, string> = { "README.md": "# repo\n" }) {
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "start");
  return dir;
}

let browser: Browser | null = null;
/** A logged-in page (desktop by default, or a phone). */
export async function openPage(symbio: Symbio, opts: { phone?: boolean } = {}): Promise<{ page: Page; context: BrowserContext }> {
  browser ??= await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome") });
  const context = await browser.newContext(
    opts.phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  (page as any).errors = errors;
  await page.goto(`${symbio.base}/?token=${symbio.token}`);
  return { page, context };
}

export async function closeBrowser() {
  await browser?.close();
  browser = null;
}
