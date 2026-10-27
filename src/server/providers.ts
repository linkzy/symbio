// Model providers connected to OpenCode: list them, connect new ones (API key or
// browser sign-in) and remove saved logins. Credentials go straight to OpenCode;
// Symbio never stores them, and nothing secret is passed back to the browser
// (OpenCode's provider and credential responses can contain keys, so only
// whitelisted fields are copied).

import os from "node:os";
import type { OpencodeClient, OpencodeError } from "./opencode/client.js";

export interface FormField {
  key: string;
  title: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  pattern?: string;
  default?: string;
  hidden?: boolean;
  options?: { value: string; label: string; description?: string }[];
  when?: { key: string; op: string; value: string }[];
}

export interface ConnectMethod {
  type: "key" | "oauth";
  /** OAuth method ID (key methods have none). */
  id?: string;
  label: string;
  form: FormField[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  methods: ConnectMethod[];
  /** Ways it could also be connected that Symbio can't set up (environment variables…). */
  other: string[];
}

export interface ConnectedProvider {
  id: string;
  name: string;
  models: number;
  /** Saved logins that can be removed. */
  logins: { id: string; label: string; method: string }[];
  /** Where it comes from when it isn't a saved login. */
  source: "login" | "config" | "environment" | "other";
}

// Integration and attempt IDs are passed through to OpenCode URLs.
const ID = /^[A-Za-z0-9._-]+$/;
const checkId = (id: string) => {
  if (!ID.test(id)) throw new Error(`Invalid ID: ${id}`);
  return encodeURIComponent(id);
};
// Logins are global; any folder works as the location for the connect flows.
const where = () => `?location%5Bdirectory%5D=${encodeURIComponent(os.homedir())}`;
const dataOf = <T>(res: any): T => (res && typeof res === "object" && "data" in res ? res.data : res);

function toField(f: any): FormField {
  return {
    key: String(f.key),
    title: String(f.title ?? f.key),
    description: f.description,
    required: !!f.required,
    placeholder: f.placeholder,
    pattern: f.pattern,
    default: typeof f.default === "string" ? f.default : undefined,
    hidden: !!f.hidden,
    options: Array.isArray(f.options)
      ? f.options.map((o: any) => ({ value: String(o.value), label: String(o.label ?? o.value), description: o.description }))
      : undefined,
    when: Array.isArray(f.when) ? f.when.map((w: any) => ({ key: String(w.key), op: String(w.op), value: String(w.value) })) : undefined,
  };
}

function toCatalogEntry(i: any): CatalogEntry {
  const methods: ConnectMethod[] = [];
  const other: string[] = [];
  for (const m of i.methods ?? []) {
    if (m.type === "key") methods.push({ type: "key", label: m.label ?? "API key", form: (m.form ?? []).map(toField) });
    else if (m.type === "oauth" && m.id) methods.push({ type: "oauth", id: m.id, label: m.label ?? "Sign in", form: (m.form ?? []).map(toField) });
    else if (m.type === "env" && Array.isArray(m.names)) other.push(`environment variable ${m.names.join(" or ")}`);
    else if (m.label) other.push(m.label);
  }
  return { id: i.id, name: i.name ?? i.id, methods, other };
}

export async function listProviders(client: OpencodeClient): Promise<{ connected: ConnectedProvider[]; catalog: CatalogEntry[] }> {
  const [integrations, providers, models] = await Promise.all([
    client.request("GET", "/api/integration").then((r) => dataOf<any[]>(r) ?? []),
    client.request("GET", "/api/provider").then((r) => dataOf<any[]>(r) ?? []),
    client.listModels(),
  ]);
  const byIntegration = new Map(integrations.map((i: any) => [i.id, i]));
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.providerID, (counts.get(m.providerID) ?? 0) + 1);

  const connected: ConnectedProvider[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string, integration: any) => {
    if (seen.has(id)) return;
    seen.add(id);
    const logins = (integration?.connections ?? [])
      .filter((c: any) => c.type === "credential" && c.id)
      .map((c: any) => ({ id: String(c.id), label: String(c.label ?? "Login"), method: String(c.method ?? "") }));
    const source: ConnectedProvider["source"] = logins.length
      ? "login"
      : !integration
        ? "config"
        : (integration.connections ?? []).some((c: any) => c.type === "env")
          ? "environment"
          : "other";
    connected.push({ id, name, models: counts.get(id) ?? 0, logins, source });
  };
  for (const p of providers) add(p.id, p.name ?? p.id, p.integrationID ? byIntegration.get(p.integrationID) : null);
  // Saved logins whose provider isn't active (e.g. it failed to load) can still be removed.
  for (const i of integrations) if ((i.connections ?? []).length) add(i.id, i.name ?? i.id, i);
  connected.sort((a, b) => a.name.localeCompare(b.name));

  const catalog = integrations
    .map(toCatalogEntry)
    .filter((e: CatalogEntry) => e.methods.length > 0)
    .sort((a: CatalogEntry, b: CatalogEntry) => a.name.localeCompare(b.name));
  return { connected, catalog };
}

export async function connectWithKey(client: OpencodeClient, integrationID: string, key: string, answer: Record<string, string>) {
  if (!key.trim()) throw new Error("Enter the API key.");
  try {
    await client.request("POST", `/api/integration/${checkId(integrationID)}/connect/key${where()}`, {
      key: key.trim(),
      answer: Object.keys(answer).length ? answer : null,
    });
  } catch (err) {
    // Plain catalog providers (no plugin) have no connect flow; a saved key is all they need.
    if ((err as OpencodeError).status !== 404) throw err;
    await client.request("POST", "/api/credential", {
      integrationID,
      label: "API key",
      value: { type: "key", key: key.trim(), ...(Object.keys(answer).length ? { metadata: answer } : {}) },
      activate: true,
    });
  }
}

export interface OauthAttempt {
  attemptID: string;
  url: string;
  instructions: string;
  /** auto: finishes by itself after the user signs in; code: the user pastes a code back. */
  mode: "auto" | "code";
}

export async function beginOauth(client: OpencodeClient, integrationID: string, methodID: string, answer: Record<string, string>): Promise<OauthAttempt> {
  const res = await client.request("POST", `/api/integration/${checkId(integrationID)}/connect/oauth${where()}`, {
    methodID,
    answer: Object.keys(answer).length ? answer : null,
  });
  const d = dataOf<any>(res);
  return { attemptID: d.attemptID, url: d.url, instructions: d.instructions ?? "", mode: d.mode === "code" ? "code" : "auto" };
}

export async function oauthStatus(client: OpencodeClient, integrationID: string, attemptID: string) {
  const res = await client.request("GET", `/api/integration/${checkId(integrationID)}/connect/oauth/${checkId(attemptID)}${where()}`);
  const d = dataOf<any>(res);
  return { status: String(d.status) as "pending" | "complete" | "failed" | "expired", message: d.message as string | undefined };
}

export async function completeOauth(client: OpencodeClient, integrationID: string, attemptID: string, code: string | null) {
  await client.request("POST", `/api/integration/${checkId(integrationID)}/connect/oauth/${checkId(attemptID)}/complete${where()}`, { code });
}

export async function cancelOauth(client: OpencodeClient, integrationID: string, attemptID: string) {
  await client.request("DELETE", `/api/integration/${checkId(integrationID)}/connect/oauth/${checkId(attemptID)}${where()}`).catch(() => {});
}

export async function removeLogin(client: OpencodeClient, credentialID: string) {
  await client.request("DELETE", `/api/credential/${checkId(credentialID)}`);
}
