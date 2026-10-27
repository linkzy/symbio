// Thin client for the OpenCode v2 HTTP API (verified against opencode 2.1.4).

export interface ModelRef {
  providerID: string;
  id: string;
}

export interface OpencodeEvent {
  id: string;
  type: string;
  created?: number;
  location?: { directory: string };
  data: any;
}

export class OpencodeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class OpencodeClient {
  private readonly auth: string;

  constructor(
    readonly baseUrl: string,
    password: string,
  ) {
    this.auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  }

  async request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        authorization: this.auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const msg = (parsed as any)?.message ?? text ?? res.statusText;
      throw new OpencodeError(`${method} ${path} → ${res.status}: ${msg}`, res.status, parsed);
    }
    return parsed as T;
  }

  info() {
    return this.request<{ version: string; pid: number }>("GET", "/api/info");
  }

  async listModels(): Promise<any[]> {
    const res = await this.request("GET", "/api/model");
    return res?.data ?? res ?? [];
  }

  async createSession(opts: {
    title: string;
    directory: string;
    model: ModelRef;
    permissions?: { action: string; resource: string; effect: string }[];
  }): Promise<{ id: string }> {
    const res = await this.request("POST", "/api/session", {
      title: opts.title,
      location: { directory: opts.directory },
      model: opts.model,
      permissions: opts.permissions,
    });
    return res.data;
  }

  setPermissions(sessionId: string, permissions: { action: string; resource: string; effect: string }[]) {
    return this.request("PATCH", `/api/session/${sessionId}`, { permissions });
  }

  /** Background shells started by agents working in a folder. */
  async shells(directory: string): Promise<any[]> {
    const res = await this.request("GET", `/api/shell?location%5Bdirectory%5D=${encodeURIComponent(directory)}`);
    return res?.data ?? [];
  }

  stopShell(directory: string, id: string) {
    return this.request("DELETE", `/api/shell/${encodeURIComponent(id)}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`);
  }

  setInstruction(sessionId: string, key: string, value: string) {
    return this.request(
      "PUT",
      `/api/experimental/session/${sessionId}/instructions/entries/${encodeURIComponent(key)}`,
      { value },
    );
  }

  removeInstruction(sessionId: string, key: string) {
    return this.request(
      "DELETE",
      `/api/experimental/session/${sessionId}/instructions/entries/${encodeURIComponent(key)}`,
    );
  }

  prompt(sessionId: string, text: string, delivery: "queue" | "steer" = "queue") {
    return this.request("POST", `/api/session/${sessionId}/prompt`, { text, delivery });
  }

  /** Adds a message to the conversation; with resume=false it doesn't start a model turn. */
  synthetic(sessionId: string, text: string, resume: boolean) {
    return this.request("POST", `/api/session/${sessionId}/synthetic`, { text, delivery: "queue", resume });
  }

  interrupt(sessionId: string) {
    return this.request("POST", `/api/session/${sessionId}/interrupt`);
  }

  switchModel(sessionId: string, model: ModelRef) {
    return this.request("POST", `/api/session/${sessionId}/model`, { model });
  }

  /** Messages, oldest first. */
  async messages(sessionId: string): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await this.request("GET", `/api/session/${sessionId}/message${q}`);
      const data: any[] = res?.data ?? [];
      all.push(...data);
      cursor = res?.cursor?.next;
      if (!cursor || data.length === 0) break;
    }
    // The API returns newest first.
    return all.reverse();
  }

  /**
   * Streams server events until the signal aborts or the connection drops.
   * Resolves when the stream ends; callers decide whether to reconnect.
   */
  async subscribe(onEvent: (e: OpencodeEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(this.baseUrl + "/api/event", {
      headers: { authorization: this.auth, accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new OpencodeError(`event stream → ${res.status}`, res.status, null);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const evt = safeJson(line.slice(5).trim());
        if (evt && typeof evt === "object") onEvent(evt as OpencodeEvent);
      }
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseModel(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid model "${ref}", expected provider/model`);
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
