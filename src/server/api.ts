// HTTP API for the browser UI. JSON over REST, live updates over SSE.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bus, type UiEvent } from "./bus.js";
import type { OpencodeRuntime } from "./opencode/runtime.js";
import type { Store, Project, DocsLocation, ProjectConnection } from "./store.js";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describeInspection, inspectFolder } from "./inspect.js";
import { gitAvailable, initRepository } from "./git.js";
import { pickFolder } from "./folder-picker.js";
import { beginOauth, cancelOauth, completeOauth, connectWithKey, listProviders, oauthStatus, removeLogin } from "./providers.js";
import { docsRoot, listDocs, readDoc, writeDoc } from "./docs.js";
import type { Team } from "./team.js";
import type { Connections } from "./connections.js";
import { PriceBook, projectUsage, resolvePrices, type Price } from "./costs.js";
import { globalDir } from "./store.js";

// Debug routes pass OpenCode responses through, which can contain provider keys.
const DEBUG = process.env.SYMBIO_DEBUG === "1";

export function createApi(store: Store, runtime: OpencodeRuntime, team: Team, connections: Connections) {
  const api = new Hono();

  // ---- usage and prices (estimated cost = tokens × the price per model)
  const priceBook = PriceBook.at(globalDir);
  const priceBookLoaded = priceBook.load();
  let catalog: { at: number; models: any[] } | null = null;
  const catalogModels = async () => {
    if (!runtime.client) return catalog?.models ?? [];
    if (!catalog || Date.now() - catalog.at > 10 * 60_000) catalog = { at: Date.now(), models: await runtime.client.listModels() };
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

  const runtimeInfo = () => ({
    state: runtime.state,
    version: runtime.version,
    error: runtime.lastError,
    restarts: runtime.restarts,
    memoryMB: runtime.lastMemory ? Math.round(runtime.lastMemory / 1024 / 1024) : null,
  });

  api.get("/runtime", (c) => c.json(runtimeInfo()));

  api.post("/runtime/restart", async (c) => {
    await runtime.restart();
    return c.json(runtimeInfo());
  });

  api.get("/models", async (c) => {
    if (!runtime.client) return c.json({ error: "OpenCode is not running" }, 503);
    const models = await runtime.client.listModels();
    if (c.req.query("raw") && DEBUG) return c.json(models);
    return c.json(
      models.map((m: any) => ({
        ref: `${m.providerID}/${m.id}`,
        providerID: m.providerID,
        id: m.id,
        name: m.name ?? m.id,
        vision: modelSupportsImages(m),
        free: isFree(m),
      })),
    );
  });

  // ---- Model providers (connected to OpenCode; keys are passed on, never stored or returned)
  const oc = () => {
    if (!runtime.client) throw new Error("OpenCode is not running");
    return runtime.client;
  };
  const fail = (c: any, err: unknown) => c.json({ error: (err as Error).message }, 400);

  api.get("/providers", async (c) => {
    try {
      const { connected, catalog } = await listProviders(oc());
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
      await connectWithKey(oc(), c.req.param("id"), body.key ?? "", body.answer ?? {});
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.post("/providers/:id/oauth", async (c) => {
    const body = await c.req.json<{ methodID: string; answer?: Record<string, string> }>();
    try {
      return c.json(await beginOauth(oc(), c.req.param("id"), body.methodID, body.answer ?? {}));
    } catch (err) {
      return fail(c, err);
    }
  });

  api.get("/providers/:id/oauth/:attemptId", async (c) => {
    try {
      return c.json(await oauthStatus(oc(), c.req.param("id"), c.req.param("attemptId")));
    } catch (err) {
      return fail(c, err);
    }
  });

  api.post("/providers/:id/oauth/:attemptId/complete", async (c) => {
    const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
    try {
      await completeOauth(oc(), c.req.param("id"), c.req.param("attemptId"), body.code?.trim() || null);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.delete("/providers/:id/oauth/:attemptId", async (c) => {
    await cancelOauth(oc(), c.req.param("id"), c.req.param("attemptId"));
    return c.json({ ok: true });
  });

  api.delete("/providers/logins/:loginId", async (c) => {
    try {
      await removeLogin(oc(), c.req.param("loginId"));
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
    }>();
    if (!body.name?.trim() || !body.directory?.trim()) return c.json({ error: "name and directory are required" }, 400);
    if (!path.isAbsolute(body.directory.trim())) return c.json({ error: "directory must be a full path" }, 400);
    if (!body.coordinatorModel) return c.json({ error: "coordinatorModel is required" }, 400);
    const allowed = body.allowedModels?.length ? body.allowedModels : [body.coordinatorModel];
    if (!allowed.includes(body.coordinatorModel)) allowed.unshift(body.coordinatorModel);

    const directory = body.directory.trim();
    await fs.mkdir(directory, { recursive: true });
    let inspection = await inspectFolder(directory);
    if (body.initGit && !inspection.isGit) {
      await initRepository(directory);
      inspection = { ...inspection, isGit: true };
    }

    const project = await store.create({
      name: body.name.trim(),
      directory,
      allowedModels: allowed,
      coordinatorModel: body.coordinatorModel,
      docsLocation: body.docsLocation === "private" ? "private" : "project",
      origin: inspection.empty ? "new" : "existing",
      inspectionSummary: describeInspection(inspection),
      connections: cleanLinks(body.connections),
    });
    return c.json(project, 201);
  });

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
    }>();
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
    if (body.allowedModels?.length) project.allowedModels = body.allowedModels;
    if (body.coordinatorModel) {
      // Switch the live session first so a rejected model doesn't leave the project half-updated.
      const coordinator = project.agents.find((a) => a.role === "coordinator");
      if (coordinator && coordinator.model !== body.coordinatorModel) {
        await team.setModel(project, coordinator, body.coordinatorModel);
      }
      project.coordinatorModel = body.coordinatorModel;
      if (!project.allowedModels.includes(body.coordinatorModel)) project.allowedModels.unshift(body.coordinatorModel);
    }
    // Agents on a model that is no longer allowed move to core's model.
    for (const agent of project.agents) {
      if (agent.status === "stopped" || project.allowedModels.includes(agent.model)) continue;
      await team.setModel(project, agent, project.coordinatorModel).catch((err) => console.error(`[models] ${agent.name}:`, err.message));
    }
    await store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    if (body.allowedModels?.length || body.name?.trim() || body.connections) {
      // Briefs mention the project name and allowed models.
      for (const agent of project.agents.filter((a) => a.status !== "stopped")) {
        await team.refreshInstructions(project, agent).catch(() => {});
      }
    }
    // Agents stuck without a working model can resume.
    if (modelsAdded) await team.resumeStuck(project, false);
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
    return c.json({ resumed: await team.resumeStuck(project, true) });
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
    return c.json(team.permissionRequests(project));
  });

  api.post("/projects/:id/permissions/:requestId", async (c) => {
    const project = withProject(c.req.param("id"));
    const body = await c.req.json<{ decision?: string; note?: string }>();
    if (body.decision !== "once" && body.decision !== "always" && body.decision !== "reject") {
      return c.json({ error: "decision must be once, always or reject" }, 400);
    }
    try {
      await team.answerPermission(project, c.req.param("requestId"), body.decision, body.note);
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
    return c.json(team.housekeepingReport(project) ?? (await team.checkProject(project, false)));
  });

  api.post("/projects/:id/housekeeping/check", async (c) => {
    const project = withProject(c.req.param("id"));
    return c.json(await team.checkProject(project, false));
  });

  api.post("/projects/:id/agents/:agentId/clean", async (c) => {
    const project = withProject(c.req.param("id"));
    const agent = withAgent(project, c.req.param("agentId"));
    try {
      return c.json({ result: await team.cleanHelperFolder(project, agent) });
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
    if (!model || !project.allowedModels.includes(model)) return c.json({ error: "Pick one of the project's models." }, 400);
    if (agent.status === "stopped") return c.json({ error: `${agent.name} is stopped.` }, 400);
    if (model !== agent.model) await team.setModel(project, agent, model);
    return c.json(project);
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
    const body = await c.req.json<{ text?: string; urgent?: boolean }>();
    if (!body.text?.trim()) return c.json({ error: "text is required" }, 400);
    await team.sendFromHuman(project, agent, body.text.trim(), !!body.urgent);
    return c.json({ ok: true });
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
      const onState = () => send({ type: "runtime", ...runtimeInfo() });
      runtime.on("state", onState);
      stream.onAbort(() => {
        bus.off("ui", send);
        runtime.off("state", onState);
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
          runtime.off("state", onState);
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
        runtime.on("state", onState);
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
