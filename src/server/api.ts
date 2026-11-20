// HTTP API for the browser UI. JSON over REST, live updates over SSE.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bus, type UiEvent } from "./bus.js";
import type { OpencodeRuntime } from "./opencode/runtime.js";
import { runtimeOf, type AgentRuntime, type RuntimeKind } from "./runtime/types.js";
import { findOnPath, hasInstalledCopy, isInstalled, locate, NotInstalledError, RUNTIME_PACKAGES, RuntimeInstaller } from "./runtime/install.js";
import { loadRuntimeSettings, saveRuntimeSettings } from "./runtime/settings.js";
import { CopilotRuntime } from "./copilot/runtime.js";
import type { CoreMode, ReviewBy, Store, Project, DocsLocation, HelperWorkspace, ProjectConnection } from "./store.js";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describeInspection, inspectFolder } from "./inspect.js";
import { gitAvailable, initRepository } from "./git.js";
import { pickFolder } from "./folder-picker.js";
import { beginOauth, cancelOauth, completeOauth, connectWithKey, listProviders, oauthStatus, removeLogin } from "./providers.js";
import { docsRoot, listDocs, rawDoc, readDoc, searchDocs, writeDoc } from "./docs.js";
import { readRegister } from "./rules.js";
import { addAttachment, attachmentNote, getAttachments, listAttachments, markSent, removeAttachment } from "./attachments.js";
import { fileResponse, listDir, listShared, resolveFile, type ResolvedFile } from "./files.js";
import type { Team } from "./team.js";
import type { Connections } from "./connections.js";
import { averageDailyUsage, PriceBook, projectUsage, resolvePrices, type Price } from "./costs.js";
import { defaultModel, globalDir, modelsFor } from "./store.js";

// Debug routes pass OpenCode responses through, which can contain provider keys.
const DEBUG = process.env.SYMBIO_DEBUG === "1";

export function createApi(store: Store, runtime: OpencodeRuntime, team: Team, connections: Connections, installer = new RuntimeInstaller()) {
  const api = new Hono();
  // A project's page reads its agents' conversations, forms and processes: their runtimes must be up.
  api.use("/projects/:id/*", async (c, next) => {
    const project = store.get(c.req.param("id"));
    if (project) await team.startRuntimesOf(project);
    await next();
  });

  // ---- usage and prices (estimated cost = tokens × the price per model)
  const priceBook = PriceBook.at(globalDir);
  const priceBookLoaded = priceBook.load();
  let catalog: { at: number; kinds: string; models: any[] } | null = null;
  const catalogModels = async () => {
    const running = [...team.runtimes.values()].filter((r) => r.state === "running");
    if (!running.length) return catalog?.models ?? [];
    if (!catalog || catalog.kinds !== running.map((r) => r.kind).join() || Date.now() - catalog.at > 10 * 60_000) {
      const lists = await Promise.all(running.map((r) => r.listModels().catch(() => [])));
      catalog = { at: Date.now(), kinds: running.map((r) => r.kind).join(), models: lists.flat().map((m) => m.raw) };
    }
    return catalog.models;
  };
  const pricesFor = async (refs: string[]) => {
    await priceBookLoaded;
    return resolvePrices([...new Set(refs)], priceBook.prices, await catalogModels().catch(() => []));
  };
  const modelsUsed = (projects: Project[]) =>
    projects.flatMap((p) => [...p.allowedModels, ...p.agents.flatMap((a) => [a.model, ...Object.keys(a.usageByModel ?? {})])]);

  api.get("/prices", async (c) => {
    await priceBookLoaded;
    return c.json(await pricesFor([...modelsUsed(store.list()), ...Object.keys(priceBook.prices)]));
  });

  api.put("/prices", async (c) => {
    const body = await c.req.json<{ model?: string; price?: Price | null }>();
    if (!body.model || !/^[\w.-]+\/[\w./:-]+$/.test(body.model)) return c.json({ error: "model is required (provider/model)" }, 400);
    const p = body.price;
    if (p && ![p.input, p.output, p.cacheRead, p.cacheWrite].every((v) => typeof v === "number" && v >= 0 && v < 10_000)) {
      return c.json({ error: "Prices must be numbers (USD per million tokens)." }, 400);
    }
    await priceBookLoaded;
    await priceBook.set(body.model, p ?? null);
    bus.publish({ type: "prices.updated" });
    return c.json({ ok: true });
  });

  // Average tokens per day across projects, by kind (the price simulator in Settings).
  api.get("/usage/average", (c) => c.json(averageDailyUsage(store.list())));

  api.get("/projects/:id/usage", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(projectUsage(project, await pricesFor(modelsUsed([project]))));
  });

  // ---- global connections (secrets are write-only: never returned)
  api.get("/connections", async (c) => c.json(await connections.views()));

  api.post("/connections", async (c) => {
    try {
      const conn = await connections.create(await c.req.json());
      return c.json(await connections.view(conn), 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  api.patch("/connections/:id", async (c) => {
    try {
      const conn = await connections.update(c.req.param("id"), await c.req.json());
      return c.json(await connections.view(conn));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  api.delete("/connections/:id", async (c) => {
    const id = c.req.param("id");
    await connections.remove(id);
    // Projects lose access to it.
    for (const project of store.list().filter((p) => p.connections.some((l) => l.id === id))) {
      project.connections = project.connections.filter((l) => l.id !== id);
      await store.update(project);
      for (const agent of project.agents.filter((a) => a.status !== "stopped")) await team.refreshInstructions(project, agent).catch(() => {});
      bus.publish({ type: "project.updated", projectId: project.id });
    }
    return c.json({ ok: true });
  });

  const cleanLinks = (links: ProjectConnection[] | undefined): ProjectConnection[] =>
    (links ?? [])
      .filter((l) => connections.get(l.id))
      .map((l) => ({ id: l.id, policy: l.policy === "allow" ? "allow" : "ask" }));

  api.post("/connections/:id/test", async (c) => c.json(await connections.test(c.req.param("id"))));

  // Only while it runs: the last reading of a stopped runtime is history.
  const memoryMB = (r: AgentRuntime) => (r.state === "running" && r.lastMemory ? Math.round(r.lastMemory / 1024 / 1024) : null);
  // OpenCode's status (the default runtime), plus every runtime's, for the top bar: a project's page
  // shows the runtime its agents run on.
  const runtimeInfo = () => ({
    state: runtime.state,
    version: runtime.version,
    error: runtime.lastError,
    restarts: runtime.restarts,
    memoryMB: memoryMB(runtime),
    runtimes: [...team.runtimes.values()].map((r) => ({
      kind: r.kind,
      label: r.label,
      installed: isInstalled(r.kind),
      installing: installer.state(r.kind).installing,
      state: r.state,
      version: r.version,
      error: r.lastError,
      memoryMB: memoryMB(r),
    })),
  });
  /** Calls `fn` when any runtime's state changes; returns the way to stop. */
  const onAnyRuntimeState = (fn: () => void) => {
    for (const r of team.runtimes.values()) r.on("state", fn);
    installer.on("change", fn);
    return () => {
      for (const r of team.runtimes.values()) r.off("state", fn);
      installer.off("change", fn);
    };
  };

  api.get("/runtime", (c) => c.json(runtimeInfo()));

  // Opt-in to an OpenCode on the PATH. A runtime event makes the cards reload right away.
  const pathSettings = () => ({ ...loadRuntimeSettings(), pathAvailable: !!findOnPath("opencode") });
  api.get("/runtime/settings", (c) => c.json(pathSettings()));
  api.put("/runtime/settings", async (c) => {
    const body = await c.req.json<{ usePathOpenCode?: boolean }>();
    if (typeof body.usePathOpenCode !== "boolean") return c.json({ error: "usePathOpenCode must be true or false." }, 400);
    const saved = await saveRuntimeSettings({ usePathOpenCode: body.usePathOpenCode });
    bus.publish({ type: "runtime", ...runtimeInfo() });
    return c.json({ ...saved, pathAvailable: !!findOnPath("opencode") });
  });

  // Every agent runtime Symbio can use: whether it's installed (and installing it), for choosing one
  // (a project's runtime), and Copilot's sign-in.
  const runtimeView = (r: AgentRuntime) => {
    const copilot = r instanceof CopilotRuntime ? r : null;
    const pkg = RUNTIME_PACKAGES[r.kind];
    const found = locate(r.kind);
    const install = installer.state(r.kind);
    return {
      kind: r.kind,
      label: r.label,
      description: pkg.description,
      needs: pkg.needs,
      sizeMB: pkg.sizeMB,
      installed: !!found,
      installedVersion: found?.version ?? null,
      source: found?.source ?? null,
      // Symbio's copy can be removed even while a PATH OpenCode is preferred (not a dev checkout's).
      removable: hasInstalledCopy(r.kind),
      installing: install.installing,
      installLog: install.log,
      installError: install.error,
      projects: store.list().filter((p) => (p.runtime ?? "opencode") === r.kind).length,
      state: r.state,
      version: r.version,
      error: r.lastError,
      login: copilot?.login ?? null,
      signIn: copilot?.pendingSignIn ?? null,
      signInError: copilot?.signInError ?? null,
    };
  };
  api.get("/runtimes", (c) => c.json([...team.runtimes.values()].map(runtimeView)));

  const runtimeKind = (kind: string) => {
    const r = team.runtimes.get(kind as RuntimeKind);
    if (!r) throw new HttpError(404, `Unknown runtime "${kind}".`);
    return r;
  };
  // Installs a runtime into Symbio's folder; it takes minutes, so this returns at once and the
  // runtime events tell how it goes.
  api.post("/runtimes/:kind/install", (c) => {
    const r = runtimeKind(c.req.param("kind"));
    const found = locate(r.kind);
    // A PATH OpenCode is already usable: a stale install error must not trigger a download.
    if (!found || (installer.state(r.kind).error && found.source !== "path")) {
      installer.install(r.kind).catch((err) => console.error(`[runtime] installing ${r.kind}:`, err.message));
    }
    return c.json(runtimeView(r), 202);
  });
  api.delete("/runtimes/:kind", async (c) => {
    const r = runtimeKind(c.req.param("kind"));
    if (!hasInstalledCopy(r.kind)) return c.json({ error: `${r.label} wasn't installed by Symbio here: there's nothing to remove.` }, 400);
    const busy = store.list().filter((p) => p.agents.some((a) => runtimeOf(a) === r.kind && a.status !== "stopped"));
    if (busy.length) {
      return c.json({ error: `Agents of ${busy.map((p) => p.name).join(", ")} run on ${r.label}: stop them first.` }, 409);
    }
    await r.stop();
    try {
      await installer.remove(r.kind);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    return c.json(runtimeView(r));
  });

  const copilotRuntime = () => {
    const r = team.runtimes.get("copilot");
    if (!(r instanceof CopilotRuntime)) throw new HttpError(404, "GitHub Copilot CLI isn't available in this Symbio.");
    return r;
  };
  // Starts Copilot (it otherwise starts with the first project that uses it) and reads its sign-in.
  api.post("/runtimes/copilot/check", async (c) => {
    const r = copilotRuntime();
    try {
      await team.runtimeFor({ runtime: "copilot" });
      await r.checkLogin();
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
    return c.json(runtimeView(r));
  });
  // Signing in to GitHub with a device code: the code to enter on GitHub; it completes in the background.
  api.post("/runtimes/copilot/sign-in", async (c) => {
    const r = copilotRuntime();
    try {
      await team.runtimeFor({ runtime: "copilot" });
      await r.beginSignIn();
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(runtimeView(r));
  });
  api.delete("/runtimes/copilot/sign-in", async (c) => {
    const r = copilotRuntime();
    await r.cancelSignIn();
    return c.json(runtimeView(r));
  });

  api.post("/runtime/restart", async (c) => {
    await runtime.restart();
    return c.json(runtimeInfo());
  });

  // ---- This computer: its load, the programs agents started (to stop one), the load guard's setting (machine.ts)
  const machineOf = () => {
    if (!team.machine) throw new HttpError(503, "not available");
    return team.machine;
  };
  api.get("/machine", (c) => c.json(machineOf().state()));
  api.get("/machine/processes", async (c) => {
    try {
      return c.json(await machineOf().processes());
    } catch (err) {
      return c.json({ error: `Could not list processes: ${(err as Error).message}` }, 500);
    }
  });
  api.post("/machine/processes/:pid/stop", async (c) => {
    const pid = Number(c.req.param("pid"));
    if (!Number.isInteger(pid) || pid <= 0) return c.json({ error: "pid is required" }, 400);
    try {
      const stopped = await machineOf().stopProcess(pid);
      console.log(`[machine] the human stopped ${stopped.name} (pid ${pid})`);
      return c.json({ ok: true, stopped });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  api.put("/machine/settings", async (c) => {
    const body = await c.req.json<{ holdTurns?: boolean }>();
    if (typeof body.holdTurns !== "boolean") return c.json({ error: "holdTurns (true/false) is required" }, 400);
    await machineOf().setSettings({ holdTurns: body.holdTurns });
    return c.json(machineOf().state());
  });

  // A runtime's models (?runtime=copilot); the runtime is started if it isn't yet.
  api.get("/models", async (c) => {
    const kind = c.req.query("runtime") === "copilot" ? "copilot" : "opencode";
    let models;
    try {
      models = await (await team.runtimeFor({ runtime: kind })).listModels();
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
    if (c.req.query("raw") && DEBUG) return c.json(models.map((m) => m.raw));
    return c.json(
      models.map((m) => ({
        ref: `${m.providerID}/${m.id}`,
        providerID: m.providerID,
        id: m.id,
        name: m.name,
        vision: modelSupportsImages(m.raw),
        free: isFree(m.raw),
        efforts: m.efforts,
      })),
    );
  });

  // ---- Model providers (connected to OpenCode; keys are passed on, never stored or returned)
  // OpenCode starts when something needs it (here: its providers), like Copilot.
  const oc = async () => {
    await team.runtimeFor({ runtime: "opencode" });
    if (!runtime.client) throw new Error("OpenCode is not running");
    return runtime.client;
  };
  const fail = (c: any, err: unknown) => c.json({ error: (err as Error).message }, 400);

  api.get("/providers", async (c) => {
    try {
      const { connected, catalog } = await listProviders(await oc());
      const projects = store.list();
      return c.json({
        connected: connected.map((p) => ({
          ...p,
          usedBy: projects.filter((x) => x.allowedModels.some((m) => m.startsWith(`${p.id}/`))).map((x) => x.name),
        })),
        catalog,
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.post("/providers/:id/key", async (c) => {
    const body = await c.req.json<{ key?: string; answer?: Record<string, string> }>();
    try {
      await connectWithKey(await oc(), c.req.param("id"), body.key ?? "", body.answer ?? {});
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.post("/providers/:id/oauth", async (c) => {
    const body = await c.req.json<{ methodID: string; answer?: Record<string, string> }>();
    try {
      return c.json(await beginOauth(await oc(), c.req.param("id"), body.methodID, body.answer ?? {}));
    } catch (err) {
      return fail(c, err);
    }
  });

  api.get("/providers/:id/oauth/:attemptId", async (c) => {
    try {
      return c.json(await oauthStatus(await oc(), c.req.param("id"), c.req.param("attemptId")));
    } catch (err) {
      return fail(c, err);
    }
  });

  api.post("/providers/:id/oauth/:attemptId/complete", async (c) => {
    const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
    try {
      await completeOauth(await oc(), c.req.param("id"), c.req.param("attemptId"), body.code?.trim() || null);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.delete("/providers/:id/oauth/:attemptId", async (c) => {
    await cancelOauth(await oc(), c.req.param("id"), c.req.param("attemptId"));
    return c.json({ ok: true });
  });

  api.delete("/providers/logins/:loginId", async (c) => {
    try {
      await removeLogin(await oc(), c.req.param("loginId"));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  // Read-only passthrough to the OpenCode API, for debugging. Off unless SYMBIO_DEBUG=1:
  // OpenCode responses can contain provider keys.
  api.get("/debug/opencode/*", async (c) => {
    if (!DEBUG) return c.json({ error: "Debug routes are off. Start Symbio with SYMBIO_DEBUG=1." }, 404);
    if (!runtime.client) return c.json({ error: "OpenCode is not running" }, 503);
    const url = new URL(c.req.url);
    const target = url.pathname.replace(/^.*\/debug\/opencode/, "") + url.search;
    return c.json(await runtime.client.request("GET", target));
  });

  api.get("/projects", (c) => c.json(store.list()));

  api.get("/inspect", async (c) => {
    const dir = c.req.query("dir")?.trim();
    if (!dir) return c.json({ error: "dir is required" }, 400);
    if (!path.isAbsolute(dir)) return c.json({ error: "Use a full path, e.g. C:\\Users\\you\\project" }, 400);
    const [inspection, hasGit] = await Promise.all([inspectFolder(dir), gitAvailable()]);
    const existing = store.list().find((p) => path.resolve(p.directory).toLowerCase() === inspection.directory.toLowerCase());
    return c.json({ ...inspection, gitAvailable: hasGit, existingProject: existing ? { id: existing.id, name: existing.name } : null });
  });

  // Folder browser inside the page (works through remote access, where the native dialog
  // would open on this computer's screen). Lists subfolder names only, never files.
  api.get("/fs/dirs", async (c) => {
    const requested = c.req.query("path")?.trim();
    const dir = requested && path.isAbsolute(requested) ? path.resolve(requested) : os.homedir();
    const roots =
      process.platform === "win32"
        ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((d) => `${d}:\\`).filter((d) => existsSync(d))
        : ["/"];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("$") && e.name !== "System Volume Information")
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        .slice(0, 1000);
      const parent = path.dirname(dir);
      return c.json({ path: dir, parent: parent === dir ? null : parent, dirs, roots, home: os.homedir(), sep: path.sep });
    } catch (err) {
      return c.json({ error: `Can't open ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` }, 400);
    }
  });

  // A new folder inside one the browser shows (the in-page folder browser, used over remote access).
  api.post("/fs/mkdir", async (c) => {
    const body = await c.req.json<{ parent?: string; name?: string }>().catch(() => ({}) as { parent?: string; name?: string });
    const parent = body.parent?.trim();
    const name = body.name?.trim() ?? "";
    if (!parent || !path.isAbsolute(parent)) return c.json({ error: "Open a folder first." }, 400);
    // One plain name: no separators, nothing Windows refuses, not "." or "..".
    if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^\.+$/.test(name) || /[. ]$/.test(name)) {
      return c.json({ error: "Use a plain folder name (no / \\ : * ? \" < > |, not ending in a dot or space)." }, 400);
    }
    const dir = path.join(path.resolve(parent), name);
    try {
      if (!(await fs.stat(parent)).isDirectory()) return c.json({ error: `${parent} isn't a folder.` }, 400);
      await fs.mkdir(dir); // not recursive: the parent must exist
      return c.json({ path: dir });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return c.json({ error: code === "EEXIST" ? `${name} already exists here.` : `Can't create ${dir}: ${code ?? (err as Error).message}` }, 400);
    }
  });

  // Opens the native folder dialog on this machine; path is null when cancelled.
  api.post("/pick-folder", async (c) => {
    const body = await c.req.json<{ initial?: string }>().catch(() => ({}) as { initial?: string });
    const initial = body.initial?.trim();
    try {
      return c.json({ path: await pickFolder(initial && path.isAbsolute(initial) ? initial : undefined) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  api.post("/projects", async (c) => {
    const body = await c.req.json<{
      name?: string;
      directory?: string;
      allowedModels?: string[];
      coordinatorModel?: string;
      docsLocation?: DocsLocation;
      initGit?: boolean;
      connections?: ProjectConnection[];
      rulesRegister?: boolean;
      coreModels?: string[];
      coreOnlyModels?: string[];
      runtime?: RuntimeKind;
    }>();
    if (!body.name?.trim() || !body.directory?.trim()) return c.json({ error: "name and directory are required" }, 400);
    if (body.runtime !== undefined && !team.runtimes.has(body.runtime)) return c.json({ error: `Unknown runtime "${body.runtime}"` }, 400);
    if (!isInstalled(body.runtime ?? "opencode")) return c.json({ error: new NotInstalledError(body.runtime ?? "opencode").message }, 400);
    if (!path.isAbsolute(body.directory.trim())) return c.json({ error: "directory must be a full path" }, 400);
    if (!body.coordinatorModel) return c.json({ error: "coordinatorModel is required" }, 400);
    const allowed = body.allowedModels?.length ? body.allowedModels : [body.coordinatorModel];
    if (!allowed.includes(body.coordinatorModel)) allowed.unshift(body.coordinatorModel);
    let roles: ReturnType<typeof modelRoles>;
    try {
      roles = modelRoles({ allowedModels: allowed, coordinatorModel: body.coordinatorModel }, body.coreModels, body.coreOnlyModels);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const directory = body.directory.trim();
    await fs.mkdir(directory, { recursive: true });
    let inspection = await inspectFolder(directory);
    // A folder of repositories keeps them as they are: one on top would swallow them.
    if (body.initGit && !inspection.isGit && !inspection.repos.length) {
      await initRepository(directory);
      inspection = { ...inspection, isGit: true };
    }

    const project = await store.create({
      name: body.name.trim(),
      directory,
      allowedModels: allowed,
      coordinatorModel: body.coordinatorModel,
      docsLocation: body.docsLocation === "private" ? "private" : "project",
      rulesRegister: body.rulesRegister === true,
      origin: inspection.empty ? "new" : "existing",
      inspectionSummary: describeInspection(inspection),
      connections: cleanLinks(body.connections),
      runtime: body.runtime,
    });
    if (roles.coreModels || roles.coreOnlyModels) {
      Object.assign(project, roles);
      if (!modelsFor(project, "coordinator").includes(project.coordinatorModel)) project.coordinatorModel = defaultModel(project, "coordinator");
      await store.update(project);
    }
    return c.json(project, 201);
  });

  /**
   * Which allowed models core may use and which are core-only, cleaned up: only allowed models,
   * core-only ones count as core's, core keeps at least one, helpers too (a model can't be locked
   * when it's the last one helpers have). Unset lists stay unset (everything for everyone).
   */
  function modelRoles(p: { allowedModels: string[]; coordinatorModel: string }, core?: string[] | null, coreOnly?: string[] | null) {
    const keep = (list?: string[] | null) => (list ? [...new Set(list.filter((m) => p.allowedModels.includes(m)))] : undefined);
    const only = keep(coreOnly);
    let crowned = keep(core);
    if (crowned && only) crowned = [...new Set([...crowned, ...only])];
    if (crowned && crowned.length === 0) throw new Error("Choose at least one model core may use (the crown).");
    if (only && only.length >= p.allowedModels.length) throw new Error("Leave at least one model for helpers (not locked to core).");
    // Everything crowned and nothing locked is the same as no roles at all.
    const allCrowned = crowned && crowned.length === p.allowedModels.length;
    return { coreModels: crowned && !allCrowned ? crowned : undefined, coreOnlyModels: only?.length ? only : undefined };
  }

  const withProject = (id: string): Project => {
    const project = store.get(id);
    if (!project) throw new HttpError(404, "project not found");
    return project;
  };

  const withAgent = (project: Project, agentId: string) => {
    const agent = project.agents.find((a) => a.id === agentId);
    if (!agent) throw new HttpError(404, "agent not found");
    return agent;
  };

  api.get("/projects/:id", (c) => c.json(withProject(c.req.param("id"))));

  // ---- moving a project to another agent runtime (team/switch.ts)
  api.get("/projects/:id/switch-runtime", (c) => c.json(team.switches.get(withProject(c.req.param("id")).id)));
  // Starts the switch and returns at once: its progress comes as runtime.switch events (and from the GET).
  api.post("/projects/:id/switch-runtime", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{
      to?: RuntimeKind;
      allowedModels?: string[];
      coordinatorModel?: string;
      coreModels?: string[];
      coreOnlyModels?: string[];
      askHandoffs?: boolean;
    }>();
    const target = body.to ? team.runtimes.get(body.to) : undefined;
    if (!body.to || !target) return c.json({ error: `Unknown runtime "${body.to}".` }, 400);
    if (!isInstalled(body.to)) return c.json({ error: new NotInstalledError(body.to).message }, 400);
    if (team.switches.running(project.id)) return c.json({ error: "This project is already switching runtimes." }, 409);
    try {
      team.checkSwitch(project, body.to);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const allowedModels = [...new Set(body.allowedModels ?? [])];
    const coordinatorModel = body.coordinatorModel ?? "";
    if (!allowedModels.length || !allowedModels.includes(coordinatorModel)) return c.json({ error: `Choose the project's models on ${target.label}, and core's.` }, 400);
    let roles: ReturnType<typeof modelRoles>;
    try {
      roles = modelRoles({ allowedModels, coordinatorModel }, body.coreModels, body.coreOnlyModels);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    // The models must be the new runtime's own.
    try {
      const known = new Set((await (await team.runtimeFor({ runtime: body.to })).listModels()).map((m) => `${m.providerID}/${m.id}`));
      const unknown = allowedModels.filter((m) => !known.has(m));
      if (unknown.length) return c.json({ error: `${target.label} doesn't have ${unknown.join(", ")}.` }, 400);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
    const busy = project.agents.filter((a) => a.status === "busy" || a.status === "waiting" || a.status === "stuck").map((a) => a.name);
    const start = team.switchRuntime(project, {
      to: body.to,
      allowedModels,
      coordinatorModel,
      coreModels: roles.coreModels,
      coreOnlyModels: roles.coreOnlyModels,
      askHandoffs: body.askHandoffs !== false,
    });
    start.catch((err) => console.error(`[switch] ${project.name}:`, err.message));
    return c.json({ progress: team.switches.get(project.id), interrupted: busy }, 202);
  });

  api.patch("/projects/:id", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{
      name?: string;
      allowedModels?: string[];
      coordinatorModel?: string;
      connections?: ProjectConnection[];
      allowedPatterns?: { action: string; pattern: string }[];
      messageLimit?: number;
      renewSessions?: "manual" | "after-task";
      helperWorkspace?: HelperWorkspace;
      rulesRegister?: boolean;
      subRepositories?: boolean;
      coreMode?: CoreMode;
      reviewBy?: ReviewBy;
      coreModels?: string[];
      coreOnlyModels?: string[];
      modelEfforts?: Record<string, string | null>;
      aiCoauthors?: boolean;
    }>();
    if (body.modelEfforts && typeof body.modelEfforts === "object") {
      try {
        const runtime = await team.runtimeFor(project);
        for (const [model, level] of Object.entries(body.modelEfforts)) {
          if (!project.allowedModels.includes(model) && !body.allowedModels?.includes(model)) throw new Error(`${model} isn't one of the project's models.`);
          if (level === null) continue;
          const levels = await team.levelsOf(runtime, model);
          if (typeof level !== "string" || !levels.includes(level)) {
            throw new Error(levels.length ? `${model} takes these reasoning effort levels: ${levels.join(", ")}.` : `${model} has no reasoning effort levels to choose.`);
          }
        }
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
      await team.setModelEfforts(project, body.modelEfforts);
    }
    const coauthorsChanged = typeof body.aiCoauthors === "boolean" && body.aiCoauthors !== (project.aiCoauthors === true);
    if (coauthorsChanged) {
      if (body.aiCoauthors) project.aiCoauthors = true;
      else delete project.aiCoauthors;
    }
    if (body.reviewBy === "core" || body.reviewBy === "every" || body.reviewBy === "marked") await team.setReviewBy(project, body.reviewBy);
    if (body.coreMode === "auto" || body.coreMode === "plan" || body.coreMode === "act") await team.setCoreMode(project, body.coreMode);
    if (typeof body.subRepositories === "boolean") {
      try {
        await team.useSubRepositories(project, body.subRepositories, "the human");
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }
    if (typeof body.rulesRegister === "boolean") await team.setRulesRegister(project, body.rulesRegister);
    if (body.helperWorkspace === "own" || body.helperWorkspace === "shared") await team.setHelperWorkspace(project, body.helperWorkspace);
    if (body.name?.trim()) project.name = body.name.trim();
    if (body.renewSessions === "manual" || body.renewSessions === "after-task") project.renewSessions = body.renewSessions;
    if (body.messageLimit !== undefined) {
      const limit = Number(body.messageLimit);
      if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return c.json({ error: "The message limit must be a whole number from 0 to 1000." }, 400);
      project.messageLimit = limit;
    }
    // Only removals make sense from the UI ("always" answers add entries).
    if (body.allowedPatterns) {
      project.allowedPatterns = project.allowedPatterns.filter((a) =>
        body.allowedPatterns!.some((b) => b.action === a.action && b.pattern === a.pattern),
      );
    }
    if (body.connections) project.connections = cleanLinks(body.connections);
    const modelsAdded = !!body.allowedModels?.some((m) => !project.allowedModels.includes(m));
    const rolesChanged = body.coreModels !== undefined || body.coreOnlyModels !== undefined;
    if (body.allowedModels?.length || rolesChanged) {
      const allowedModels = body.allowedModels?.length ? body.allowedModels : project.allowedModels;
      let roles: ReturnType<typeof modelRoles>;
      try {
        roles = modelRoles(
          { allowedModels, coordinatorModel: body.coordinatorModel ?? project.coordinatorModel },
          body.coreModels !== undefined ? body.coreModels : project.coreModels,
          body.coreOnlyModels !== undefined ? body.coreOnlyModels : project.coreOnlyModels,
        );
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
      project.allowedModels = allowedModels;
      project.coreModels = roles.coreModels;
      project.coreOnlyModels = roles.coreOnlyModels;
      if (!project.coreModels) delete project.coreModels;
      if (!project.coreOnlyModels) delete project.coreOnlyModels;
    }
    if (body.coordinatorModel) {
      // Switch the live session first so a rejected model doesn't leave the project half-updated.
      const coordinator = project.agents.find((a) => a.role === "coordinator");
      if (coordinator && coordinator.model !== body.coordinatorModel) {
        await team.setModel(project, coordinator, body.coordinatorModel);
      }
      project.coordinatorModel = body.coordinatorModel;
      if (!project.allowedModels.includes(body.coordinatorModel)) project.allowedModels.unshift(body.coordinatorModel);
    }
    if (!modelsFor(project, "coordinator").includes(project.coordinatorModel)) project.coordinatorModel = defaultModel(project, "coordinator");
    // Agents on a model their role may no longer use move to their role's default.
    for (const agent of project.agents) {
      if (agent.status === "stopped" || modelsFor(project, agent.role).includes(agent.model)) continue;
      // Its pinned model was taken away: the pin goes with it.
      if (agent.modelPinned) await team.pinModel(project, agent, false, "human").catch(() => {});
      await team.setModel(project, agent, defaultModel(project, agent.role)).catch((err) => console.error(`[models] ${agent.name}:`, err.message));
    }
    await store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    if (body.allowedModels?.length || rolesChanged || body.name?.trim() || body.connections || coauthorsChanged) {
      // Briefs mention the project name, allowed models and whether commits may name the AI.
      for (const agent of project.agents.filter((a) => a.status !== "stopped")) {
        await team.refreshInstructions(project, agent).catch(() => {});
      }
    }
    // Agents stuck without a working model can resume.
    if (modelsAdded) await team.fallback.resumeStuck(project, false);
    return c.json(project);
  });

  api.delete("/projects/:id", async (c) => {
    const project = withProject(c.req.param("id"));
    await team.removeProject(project, c.req.query("deleteData") === "true");
    return c.json({ ok: true });
  });

  /** "Retry now" for agents stuck because every model failed (e.g. after a quota reset). */
  api.post("/projects/:id/retry-models", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json({ resumed: await team.fallback.resumeStuck(project, true) });
  });

  api.post("/projects/:id/start", async (c) => {
    const project = withProject(c.req.param("id"));
    const coordinator = await team.ensureCoordinator(project);
    return c.json({ project, coordinator });
  });

  api.get("/projects/:id/docs", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json({ location: project.docsLocation, root: docsRoot(project), files: await listDocs(project) });
  });

  api.get("/projects/:id/rules", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json({ enabled: !!project.rulesRegister, ...(await readRegister(project)) });
  });

  // Any file in the docs (a PDF cited by a rule, an image), read-only.
  api.get("/projects/:id/docs/raw", async (c) => {
    const project = withProject(c.req.param("id"));
    try {
      const file = await rawDoc(project, c.req.query("path") ?? "");
      return new Response(new Uint8Array(file.data), {
        headers: {
          "content-type": file.type,
          "content-disposition": `${file.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; img-src 'self' blob: data:; style-src 'unsafe-inline'",
        },
      });
    } catch (err: any) {
      if (err.code === "ENOENT") throw new HttpError(404, "file not found");
      throw new HttpError(400, err.message);
    }
  });

  api.get("/projects/:id/docs/search", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(await searchDocs(project, (c.req.query("q") ?? "").slice(0, 200)));
  });

  api.get("/projects/:id/docs/file", async (c) => {
    const project = withProject(c.req.param("id"));
    const rel = c.req.query("path") ?? "";
    try {
      return c.json({ path: rel, content: await readDoc(project, rel) });
    } catch (err: any) {
      if (err.code === "ENOENT") throw new HttpError(404, "file not found");
      throw new HttpError(400, err.message);
    }
  });

  api.put("/projects/:id/docs/file", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ path?: string; content?: string }>();
    if (!body.path || typeof body.content !== "string") return c.json({ error: "path and content are required" }, 400);
    try {
      await writeDoc(project, body.path, body.content);
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    return c.json({ ok: true });
  });

  api.get("/projects/:id/plan", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json((await team.plan(project)).plan);
  });

  api.post("/projects/:id/plan/decision", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ approved?: boolean; feedback?: string }>();
    if (typeof body.approved !== "boolean") return c.json({ error: "approved (true/false) is required" }, 400);
    if (!body.approved && !body.feedback?.trim()) return c.json({ error: "Say what should change" }, 400);
    try {
      await team.decidePlan(project, body.approved, body.feedback ?? null);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    return c.json((await team.plan(project)).plan);
  });

  // A task's changes (the files its helper's turns changed, with diffs), and its mark for the human's review.
  api.get("/projects/:id/plan/tasks/:taskId/changes", async (c) => {
    const project = withProject(c.req.param("id"));
    try {
      return c.json(await team.reviews.changes(project, c.req.param("taskId")));
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
  });

  api.post("/projects/:id/plan/tasks/:taskId/mark", async (c) => {
    const project = withProject(c.req.param("id"));
    const { review } = await c.req.json<{ review?: boolean }>();
    if (typeof review !== "boolean") return c.json({ error: "review (true/false) is required" }, 400);
    try {
      await team.reviews.mark(project, c.req.param("taskId"), review);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    return c.json((await team.plan(project)).plan);
  });

  // The human's review of a finished task (team/review.ts): approve it, or send it back with a note.
  api.post("/projects/:id/plan/tasks/:taskId/review", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ decision?: "approve" | "send-back"; note?: string; attachments?: unknown[] }>();
    const attachments = (body.attachments ?? []).filter((x): x is string => typeof x === "string").slice(0, 20);
    try {
      if (body.decision === "approve") await team.reviews.approve(project, c.req.param("taskId"), body.note);
      else if (body.decision === "send-back") await team.reviews.sendBack(project, c.req.param("taskId"), body.note ?? "", attachments);
      else return c.json({ error: 'decision must be "approve" or "send-back"' }, 400);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    return c.json((await team.plan(project)).plan);
  });

  // The team's questions for the human (team/questions.ts): all of them, newest last.
  api.get("/projects/:id/questions", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json((await team.questions.store(project)).questions);
  });

  // Answers to several questions at once; each agent that asked gets its answers in one message.
  api.post("/projects/:id/questions/answers", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ answers?: { id?: string; answer?: string; attachments?: unknown[] }[] }>();
    const answers = (body.answers ?? [])
      .filter((a) => typeof a.id === "string")
      .map((a) => ({
        id: a.id as string,
        answer: typeof a.answer === "string" ? a.answer : "",
        attachments: (a.attachments ?? []).filter((x): x is string => typeof x === "string").slice(0, 20),
      }));
    try {
      await team.questions.answer(project, answers);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    return c.json((await team.questions.store(project)).questions);
  });

  api.post("/projects/:id/questions/:qid/set-aside", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
    try {
      await team.questions.setAside(project, c.req.param("qid"), body.note);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    return c.json((await team.questions.store(project)).questions);
  });

  api.get("/projects/:id/approvals", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(await team.remote.list(project));
  });

  api.post("/projects/:id/approvals/:approvalId", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ approved?: boolean; note?: string }>();
    if (typeof body.approved !== "boolean") return c.json({ error: "approved (true/false) is required" }, 400);
    const approval = (await team.remote.list(project)).find((a) => a.id === c.req.param("approvalId"));
    if (!approval) return c.json({ error: "Approval not found" }, 404);
    if (approval.status !== "pending") return c.json({ error: `Already ${approval.status}` }, 409);
    const agent = project.agents.find((a) => a.id === approval.agentId && a.status !== "stopped");
    // Runs the action (if approved) in the background — a deploy can take minutes — and
    // delivers the result to the agent as a message.
    void team.remote
      .decide(project, agent, approval.id, body.approved, body.note ?? null)
      .catch((err) => console.error("[approvals]", err.message));
    return c.json({ ok: true });
  });

  api.post("/projects/:id/pause", async (c) => {
    const project = withProject(c.req.param("id"));
    await team.pause(project);
    return c.json(project);
  });

  api.post("/projects/:id/resume", async (c) => {
    const project = withProject(c.req.param("id"));
    await team.resume(project);
    return c.json(project);
  });

  /** Emergency stop: pauses every project that has working agents. */
  api.post("/pause-all", async (c) => {
    const paused: string[] = [];
    for (const project of store.list()) {
      if (project.paused || !project.agents.some((a) => a.status === "busy" || a.status === "waiting" || a.status === "stuck")) continue;
      await team.pause(project);
      paused.push(project.name);
    }
    return c.json({ paused });
  });

  api.get("/projects/:id/permissions", (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(team.permissions.requests(project));
  });

  api.post("/projects/:id/permissions/:requestId", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ decision?: string; note?: string }>();
    if (body.decision !== "once" && body.decision !== "always" && body.decision !== "reject") {
      return c.json({ error: "decision must be once, always or reject" }, 400);
    }
    try {
      await team.permissions.answer(project, c.req.param("requestId"), body.decision, body.note);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    return c.json({ ok: true });
  });

  api.get("/projects/:id/assets", async (c) => {
    const project = withProject(c.req.param("id"));
    const reg = await team.assets(project);
    return c.json(reg.list());
  });

  api.get("/projects/:id/agents/:agentId/forms", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    return c.json(await team.forms(agent));
  });

  api.post("/projects/:id/agents/:agentId/forms/:formId", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    const body = await c.req.json<{ answer?: Record<string, unknown>; summary?: string }>();
    if (!body.answer) return c.json({ error: "answer is required" }, 400);
    await team.answerForm(project, agent, c.req.param("formId"), body.answer, body.summary ?? JSON.stringify(body.answer));
    return c.json({ ok: true });
  });

  // Housekeeping: backups, work not on the remote, helpers' disk use.
  api.get("/projects/:id/housekeeping", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(team.housekeeper.report(project) ?? (await team.housekeeper.check(project, false)));
  });

  api.post("/projects/:id/housekeeping/check", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(await team.housekeeper.check(project, false));
  });

  api.post("/projects/:id/agents/:agentId/clean", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    try {
      return c.json({ result: await team.housekeeper.cleanHelperFolder(project, agent) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Moves a helper from its own copy (branch) into the project folder.
  api.post("/projects/:id/agents/:agentId/move-to-project-folder", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    try {
      await team.moveToProjectFolder(project, agent, "moved by the human");
      return c.json(project);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // A fresh session for a long-running agent (keeps its identity; the old session stays readable).
  api.post("/projects/:id/agents/:agentId/renew", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    try {
      await team.renewSession(project, agent, "renewed by the human");
      return c.json(project);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  api.post("/projects/:id/agents/:agentId/rename", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    const { name } = await c.req.json<{ name?: string }>();
    try {
      await team.renameAgent(project, agent, name ?? "");
      return c.json(project);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Switch one agent's model (takes effect from its next turn).
  api.post("/projects/:id/agents/:agentId/model", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    const { model } = await c.req.json<{ model?: string }>();
    if (!model || !modelsFor(project, agent.role).includes(model)) {
      return c.json({ error: agent.role === "coordinator" ? "Pick one of the models core may use." : "Pick one of the models helpers may use." }, 400);
    }
    if (agent.status === "stopped") return c.json({ error: `${agent.name} is stopped.` }, 400);
    if (model !== agent.model) await team.setModel(project, agent, model);
    return c.json(project);
  });

  // A helper the human creates from the team list, to talk to directly (like a new chat).
  api.post("/projects/:id/agents", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ name?: string; purpose?: string; model?: string; workspace?: string }>();
    const coordinator = project.agents.find((a) => a.role === "coordinator");
    if (!coordinator || coordinator.status === "stopped") return c.json({ error: "Start core first." }, 400);
    try {
      await team.spawnWorker(project, coordinator, {
        name: body.name ?? "",
        purpose: body.purpose?.trim() || "Works with you directly",
        model: body.model,
        workspace: body.workspace === "own" ? "own" : body.workspace === "shared" ? "shared" : undefined,
        byHuman: true,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const name = (body.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    return c.json(project.agents.find((a) => a.name === name), 201);
  });

  // Pins an agent to its model (it waits and retries instead of switching when the model fails), or unpins it.
  api.post("/projects/:id/agents/:agentId/pin", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    const body = await c.req.json<{ pinned?: boolean }>();
    if (typeof body.pinned !== "boolean") return c.json({ error: "pinned (true/false) is required" }, 400);
    try {
      await team.pinModel(project, agent, body.pinned, "human");
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(agent);
  });

  // An agent's own reasoning effort level (null: the project's level for its model).
  api.post("/projects/:id/agents/:agentId/effort", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    const body = await c.req.json<{ level?: string | null }>();
    if (body.level !== null && typeof body.level !== "string") return c.json({ error: "level (a level the model takes, or null) is required" }, 400);
    try {
      await team.setEffort(project, agent, body.level || null, "human");
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(agent);
  });

  api.post("/projects/:id/agents/:agentId/stop", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    if (agent.role === "coordinator") return c.json({ error: "The coordinator can't be stopped" }, 400);
    return c.json({ result: await team.stopAgent(project, agent, "stopped by the human") });
  });

  api.post("/projects/:id/agents/:agentId/restart", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    try {
      await team.restartAgent(project, agent);
      return c.json(project);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  api.get("/projects/:id/log", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(await store.readMessages(project));
  });

  api.get("/projects/:id/agents/:agentId/history", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    // With ?limit: one page ({messages, hasMore}), older pages via ?before=<message id>.
    // Without: the whole conversation as an array (kept for compatibility).
    const limit = Number(c.req.query("limit"));
    if (limit > 0) {
      const before = c.req.query("before");
      if (before && !/^msg_[A-Za-z0-9]+$/.test(before)) return c.json({ error: "invalid message id" }, 400);
      return c.json(await team.historyPage(agent, Math.min(limit, 200), before, c.req.query("session") || undefined));
    }
    return c.json(await team.history(agent));
  });

  api.post("/projects/:id/agents/:agentId/messages", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    const body = await c.req.json<{ text?: string; urgent?: boolean; attachments?: string[] }>();
    const ids = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
    if (!body.text?.trim() && !ids.length) return c.json({ error: "text is required" }, 400);
    let files;
    try {
      files = await getAttachments(project, ids);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const text = (body.text?.trim() || (files.length === 1 ? "Here's a file." : "Here are some files.")) + attachmentNote(files);
    await team.sendFromHuman(project, agent, text, !!body.urgent);
    if (ids.length) {
      await markSent(project, ids, agent.id);
      bus.publish({ type: "attachments.updated", projectId: project.id });
    }
    return c.json({ ok: true });
  });

  // ---- attachments: files the human sends in the chat, and the project's gallery of them
  api.get("/projects/:id/attachments", async (c) => {
    const project = withProject(c.req.param("id"));
    // Paths stay on the server: the browser gets names, sizes and who received each file.
    const list = await listAttachments(project);
    return c.json(list.map(({ file: _file, ...rest }) => rest).reverse());
  });

  api.post("/projects/:id/attachments", async (c) => {
    const project = withProject(c.req.param("id"));
    const form = await c.req.parseBody({ all: true }).catch(() => null);
    const files = ([] as unknown[]).concat(form?.files ?? form?.file ?? []).filter((f): f is File => f instanceof File);
    if (!files.length) return c.json({ error: "Send the files as multipart form data (field \"files\")." }, 400);
    try {
      const added = [];
      for (const f of files) added.push(await addAttachment(project, f.name || "pasted", new Uint8Array(await f.arrayBuffer()), f.type));
      bus.publish({ type: "attachments.updated", projectId: project.id });
      return c.json(added.map(({ file: _file, ...rest }) => rest));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  api.get("/projects/:id/attachments/:aid/file", async (c) => {
    const project = withProject(c.req.param("id"));
    const [a] = await getAttachments(project, [c.req.param("aid")]).catch(() => [null]);
    if (!a) throw new HttpError(404, "attachment not found");
    // Shown inline only for types a browser displays safely; anything else downloads.
    const inline = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/.test(a.mime);
    return new Response(new Uint8Array(await fs.readFile(a.file)), {
      headers: {
        "content-type": inline ? a.mime : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' blob: data:; style-src 'unsafe-inline'",
      },
    });
  });

  api.delete("/projects/:id/attachments/:aid", async (c) => {
    const project = withProject(c.req.param("id"));
    try {
      await removeAttachment(project, c.req.param("aid"));
      bus.publish({ type: "attachments.updated", projectId: project.id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // ---- project files: paths agents mention become links, files they share show in the chat (files.ts)
  const fileView = (f: ResolvedFile) => ({ rel: f.rel, where: f.where, agentId: f.agentId, kind: f.kind, size: f.size });
  const agentOf = (project: ReturnType<typeof withProject>, id?: string | null) => (id ? project.agents.find((a) => a.id === id) ?? null : null);

  // Which of these paths exist (looked up as the agent that mentioned them meant them).
  api.post("/projects/:id/files/resolve", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ paths?: unknown[]; agentId?: string }>();
    const agent = agentOf(project, body.agentId);
    const paths = (body.paths ?? []).filter((p): p is string => typeof p === "string").slice(0, 100);
    const out = await Promise.all(
      paths.map(async (p) => {
        try {
          const f = await resolveFile(project, p, agent);
          return f ? { path: p, found: true, ...fileView(f) } : { path: p, found: false };
        } catch (err) {
          return { path: p, found: false, refused: (err as Error).message };
        }
      }),
    );
    return c.json(out);
  });

  const fileFor = async (c: { req: { param: (k: string) => string; query: (k: string) => string | undefined } }) => {
    const project = withProject(c.req.param("id"));
    let f: ResolvedFile | null;
    try {
      f = await resolveFile(project, c.req.query("path") ?? "", agentOf(project, c.req.query("agent")));
    } catch (err) {
      throw new HttpError(403, (err as Error).message);
    }
    if (!f) throw new HttpError(404, "file not found");
    return f;
  };

  // The file itself: shown in the browser when it can be (images, video, audio, PDF, text), else downloaded.
  api.get("/projects/:id/files/raw", async (c) => fileResponse(await fileFor(c), { download: c.req.query("download") === "1", range: c.req.header("range") }));

  // One folder of the project or of a helper's copy, for the Explorer tab (read-only).
  api.get("/projects/:id/files/tree", async (c) => {
    const project = withProject(c.req.param("id"));
    try {
      return c.json(await listDir(project, c.req.query("path") ?? "", agentOf(project, c.req.query("agent"))));
    } catch (err) {
      const message = (err as Error).message;
      throw new HttpError(/not found|ENOENT|ENOTDIR/.test(message) ? 404 : 403, message);
    }
  });

  // A text file's content, for the viewer page (Markdown formatted, code with line numbers).
  api.get("/projects/:id/files/text", async (c) => {
    const f = await fileFor(c);
    if (f.kind !== "markdown" && f.kind !== "text") throw new HttpError(400, "not a text file");
    if (f.size > 3 * 1024 * 1024) throw new HttpError(413, "too large to show; download it instead");
    return c.json({ ...fileView(f), content: await fs.readFile(f.abs, "utf8") });
  });

  // Files agents shared with the human (share_file), newest first, with whether they're still there.
  api.get("/projects/:id/shared-files", async (c) => {
    const project = withProject(c.req.param("id"));
    const list = await listShared(project);
    const out = await Promise.all(
      list.map(async (s) => {
        const f = await resolveFile(project, s.rel, agentOf(project, s.agentId)).catch(() => null);
        return { ...s, path: undefined, available: !!f };
      }),
    );
    return c.json(out.reverse());
  });

  api.post("/projects/:id/agents/:agentId/interrupt", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    await team.interrupt(project, agent);
    return c.json({ ok: true });
  });

  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: UiEvent) => void stream.writeSSE({ data: JSON.stringify(event) });
      send({ type: "runtime", ...runtimeInfo() });
      bus.on("ui", send);
      const stopWatching = onAnyRuntimeState(() => send({ type: "runtime", ...runtimeInfo() }));
      stream.onAbort(() => {
        bus.off("ui", send);
        stopWatching();
      });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    }),
  );

  // The same events by long polling, for connections that can't hold a stream open (e.g. remote
  // access through a Cloudflare quick tunnel). Waits up to 25 s for something new.
  api.get("/events/poll", async (c) => {
    const after = Number(c.req.query("after"));
    if (!c.req.query("after") || !Number.isFinite(after)) {
      return c.json({ seq: bus.lastSeq, events: [{ type: "runtime", ...runtimeInfo() }], gap: false });
    }
    let runtimeChanged = false;
    if (bus.since(after).events.length === 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          bus.off("ui", onEvent);
          stopWatching();
          c.req.raw.signal.removeEventListener("abort", done);
          resolve();
        };
        const onEvent = () => setTimeout(done, 50); // let a burst of events arrive together
        const onState = () => {
          runtimeChanged = true;
          done();
        };
        const timer = setTimeout(done, 25_000);
        bus.on("ui", onEvent);
        const stopWatching = onAnyRuntimeState(onState);
        c.req.raw.signal.addEventListener("abort", done);
      });
    }
    const r = bus.since(after);
    if (runtimeChanged) r.events.push({ type: "runtime", ...runtimeInfo() });
    return c.json(r);
  });

  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 404);
    console.error("[api]", err.message);
    return c.json({ error: err.message }, 500);
  });
  app.route("/", api);
  return app;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isFree(m: any): boolean {
  if (/-free$|:free$/.test(m?.id ?? "")) return true;
  // cost is a list of pricing tiers; a model is free only if every tier is zero. Missing cost = unknown.
  const tiers: any[] = Array.isArray(m?.cost) ? m.cost : m?.cost ? [m.cost] : [];
  return tiers.length > 0 && tiers.every((t) => !t.input && !t.output);
}

function modelSupportsImages(m: any): boolean {
  const input = m?.capabilities?.input;
  return Array.isArray(input) && input.includes("image");
}
