// Symbio's API has no login: it relies on listening on 127.0.0.1 only. That alone
// doesn't stop web pages open in the user's browser from sending it requests
// (browsers allow simple cross-site POSTs, and a DNS-rebinding page can even look
// same-origin). So every request must name this machine as its Host, and changes
// must come from Symbio's own UI (or carry no Origin, like OpenCode's MCP calls).

const DEV_UI_PORT = 5173; // Vite dev server, which proxies /api here

export function isAllowedRequest(req: { method: string; host?: string | null; origin?: string | null }, port: number): boolean {
  const hostname = (req.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  if (req.method === "GET" || req.method === "HEAD" || !req.origin) return true;
  const allowed = [port, DEV_UI_PORT].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
  return allowed.includes(req.origin.toLowerCase());
}
