// End-to-end harness: a real Symbio (the built dist/) against a stand-in agent runtime with a
// scripted "model", everything in temporary folders, driven through its API and a real browser
// (Edge or Chrome via playwright-core). Run `npm run build` first.
//
// Every test runs on each runtime: SYMBIO_E2E_RUNTIME picks which ("opencode", the default:
// fake-opencode.mjs; "copilot": fake-copilot.mjs in place of the Copilot SDK). Projects are
// created on that runtime, with its models (MODEL, MODEL_2). `npm run test:e2e` runs both.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { Entry } from "@napi-rs/keyring";

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
    SYMBIO_COPILOT_SDK: path.join(repo, "tests/e2e/fake-copilot.mjs"),
    // Never the user's own Copilot login.
    SYMBIO_COPILOT_USER_HOME: path.join(root, "no-copilot-login"),
    SYMBIO_NO_OPEN: "1",
    // Keeps the vault's test entries apart from real credentials.
    SYMBIO_KEYRING_SERVICE: `symbio-e2e-${port}`,
    ...env,
  };
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) fullEnv[k] = env[k] ?? path.join(root, k);
  const proc: ChildProcess = spawn(process.execPath, [path.join(repo, "dist/server/index.js")], { env: fullEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(fullEnv.SYMBIO_HOME!, "ui-token");
  // A started Symbio that never answers would keep the test file from ending: stop it.
  const fail = (err: unknown) => {
    if (proc.exitCode === null) proc.kill();
    throw err;
  };
  // The file can exist a moment before the key is written into it.
  const readToken = () => (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
  await until("Symbio to start", () => readToken() !== "", 30_000, () => log).catch(fail);
  const token = readToken();
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
  // Runtimes start when needed (on a first run, OpenCode at once): wait for the API, and for OpenCode
  // when it was started.
  await until(
    "Symbio's API (and OpenCode, when started)",
    async () => {
      const info = await call("GET", "/runtime").catch(() => null);
      return !!info && info.state !== "starting";
    },
    30_000,
    () => log,
  ).catch(fail);

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
      // The vault's test key, so the OS credential store doesn't collect one per run.
      try {
        new Entry(fullEnv.SYMBIO_KEYRING_SERVICE!, "vault-master-key").deletePassword();
      } catch {
        // never created
      }
    },
  };
}

/**
 * Polls until `check` is true. The limit only matters when something is wrong: test files run
 * several at a time (scripts/e2e.mjs), so a busy machine gets room before a wait counts as failed.
 */
export async function until(what: string, check: () => boolean | Promise<boolean>, ms = 30_000, context?: () => string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}${context ? `\n--- Symbio output ---\n${context().slice(-3000)}` : ""}`);
}

/** The runtime this run's projects use. */
export const RUNTIME: "opencode" | "copilot" = process.env.SYMBIO_E2E_RUNTIME === "copilot" ? "copilot" : "opencode";
const PROVIDER = RUNTIME === "copilot" ? "copilot" : "fake";
/** The stand-in runtime's scripted models, and one that fails every turn at once. */
export const MODEL = `${PROVIDER}/scripted`;
export const MODEL_2 = `${PROVIDER}/scripted-2`;
export const UNAVAILABLE_MODEL = `${PROVIDER}/unavailable`;
/** Overloaded for each session's first turn, then answers: a passing outage. */
export const FLAKY_MODEL = `${PROVIDER}/flaky`;

// What each runtime tells the model, in its own words, for assertions on an agent's history.
/** A tool call Symbio's rules refused ("edit", "shell"). */
export const refused = (action: string) => (RUNTIME === "copilot" ? new RegExp(`Symbio blocks this \\(${action}`) : new RegExp(`Permission denied: ${action}`));
/** The human's answer to the runtime's own question tool. */
export const answered = (answer: string) =>
  RUNTIME === "copilot" ? new RegExp(`User responded: ${answer}`) : new RegExp(`User has answered your questions.*${answer}`);

/** A project with core started and its greeting turn done. */
export async function projectWithCore(
  symbio: Symbio,
  name: string,
  opts: { directory?: string; models?: string[]; autonomy?: "ask" | "decide"; depth?: "light" | "thorough" } = {},
) {
  const directory = opts.directory ?? symbio.folder(name.toLowerCase().replace(/\W+/g, "-"));
  const models = opts.models ?? [MODEL];
  // Tests ask and wait unless they test deciding (new projects in the app decide on their own).
  const project = await symbio.call("POST", "/projects", { name, directory, coordinatorModel: models[0], allowedModels: models, runtime: RUNTIME, autonomy: opts.autonomy ?? "ask", ...(opts.depth ? { depth: opts.depth } : {}) });
  const { coordinator } = await symbio.call("POST", `/projects/${project.id}/start`);
  await idle(symbio, project.id);
  return { project, core: coordinator, directory };
}

/** Waits until no agent of the project is working. */
export async function idle(symbio: Symbio, projectId: string, ms = 40_000) {
  // Quiet for a moment, not just once: a message can wake an agent right after its turn ends.
  let quietSince = 0;
  let busy = "";
  await until(
    "the team to be idle",
    async () => {
      const p = await symbio.call("GET", `/projects/${projectId}`);
      busy = p.agents.filter((a: any) => a.status === "busy").map((a: any) => a.name).join(", ");
      const quiet = !busy;
      if (!quiet) quietSince = 0;
      else quietSince ||= Date.now();
      return quiet && Date.now() - quietSince >= 500;
    },
    ms,
    () => `still working: ${busy}\n${symbio.output()}`,
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
  // In English whatever the computer's language: the interface follows the browser's (i18n.ts), and the tests read English.
  const context = await browser.newContext({
    locale: "en-US",
    ...(opts.phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } }),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  (page as any).errors = errors;
  await page.goto(`${symbio.base}/?token=${symbio.token}`);
  return { page, context };
}

/**
 * Gives a test's pages a clipboard of their own: test files run in parallel, and the system
 * clipboard is shared by the whole machine (copy tests overwrote each other, and the clipboard of
 * whoever ran them). Read it with `clipboardText(page)`.
 */
export async function ownClipboard(context: BrowserContext) {
  // A string, not a function: tsx's helpers (__name) don't exist in the page.
  const script = `(() => {
    let text = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t) => { text = String(t); }, readText: async () => text },
    });
  })();`;
  await context.addInitScript(script);
  // Pages already open (moving to another #/… route doesn't load the page again).
  for (const page of context.pages()) await page.evaluate(script);
}

/** What the page last copied (with `ownClipboard`), with Windows line ends as \n. */
export const clipboardText = (page: Page) => page.evaluate("navigator.clipboard.readText()").then((t) => String(t).replace(/\r\n/g, "\n"));

/** A project's settings (its Settings tab), at one group of them. */
export async function openProjectSettings(page: Page, group: "general" | "team" | "quality" | "connections" | "usage" | "maintenance") {
  await page.locator("button.tab", { hasText: "Settings" }).click();
  await page.locator(`.settings-tab[data-group="${group}"]`).click();
}

export async function closeBrowser() {
  await browser?.close();
  browser = null;
}
