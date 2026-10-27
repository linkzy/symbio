// Minimal MCP server (Streamable HTTP transport, JSON responses) that exposes
// Symbio's tools to agents. Registrations are per working folder (URL token);
// the calling agent is identified by the session ID OpenCode sends in
// `params._meta["ai.opencode/sessionID"]` with every tool call.

import type { Context } from "hono";

export interface ToolDef<Ctx> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Return text shown to the model. Throw to report an error to the model. */
  run: (args: any, ctx: Ctx) => Promise<string> | string;
}

/**
 * Maps a URL token (and, for tool calls, the caller's session ID) to the tools
 * and context for that caller. Return null for unknown tokens.
 */
export type McpResolver<Ctx> = (token: string, sessionId?: string) => { ctx: Ctx; tools: ToolDef<Ctx>[] } | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

const SERVER_INFO = { name: "symbio", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

/**
 * Handles one MCP HTTP request. `resolve` maps the URL token to the caller's
 * context and tool list (or null if the token is unknown).
 */
export async function handleMcp<Ctx>(c: Context, resolve: McpResolver<Ctx>): Promise<Response> {
  if (c.req.method === "GET") return c.body(null, 405, { allow: "POST" }); // no server-initiated stream
  if (c.req.method === "DELETE") return c.body(null, 200);

  const token = c.req.param("token") ?? "";
  if (!resolve(token)) {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown token" } }, 404);
  }

  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }

  const requests = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(requests.map((r) => handleOne(r, token, resolve)))).filter((r) => r !== null);
  if (responses.length === 0) return c.body(null, 202); // notifications only
  return c.json(Array.isArray(body) ? responses : responses[0]);
}

async function handleOne<Ctx>(req: JsonRpcRequest, token: string, resolve: McpResolver<Ctx>) {
  const isNotification = req.id === undefined || req.id === null;
  const reply = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: req.id, result });
  const fail = (code: number, message: string) =>
    isNotification ? null : { jsonrpc: "2.0", id: req.id, error: { code, message } };
  const sessionId: string | undefined = req.params?._meta?.["ai.opencode/sessionID"];
  const caller = resolve(token, sessionId);
  if (!caller) return fail(-32001, "unknown token");

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: req.params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: caller.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const tool = caller.tools.find((t) => t.name === req.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${req.params?.name}`);
      if (caller.ctx == null) return fail(-32001, "could not identify the calling agent");
      try {
        const text = await tool.run(req.params?.arguments ?? {}, caller.ctx);
        return reply({ content: [{ type: "text", text }] });
      } catch (err) {
        // Tool errors go back to the model as a result, so it can react.
        return reply({ content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true });
      }
    }
    default:
      if (req.method.startsWith("notifications/")) return null;
      return fail(-32601, `method not found: ${req.method}`);
  }
}
