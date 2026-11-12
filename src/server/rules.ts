// Rules register: the project's rules, each with where it came from and how it's met. Kept as
// JSON next to the project docs so the Docs tab can show it as a filterable index. Agents change
// it only through Symbio's tools (validated, stable ids), never by editing the file.
//
// Domain-neutral on purpose: a "rule" is anything the project must respect (a requirement, a
// decision, a style rule, a constraint), whatever the project is about.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { docsRoot } from "./docs.js";
import type { Project } from "./store.js";
import { replaceFile } from "./fsutil.js";

export const CONFIRMATIONS = ["found", "checked-by-agent", "checked-by-human", "contested"] as const;
export const STATUSES = ["done", "partial", "missing", "not-applicable"] as const;
export type Confirmation = (typeof CONFIRMATIONS)[number];
export type RuleStatus = (typeof STATUSES)[number];

export interface RuleArea {
  /** Short prefix for the area's rule ids, e.g. "AP" → AP-001. */
  id: string;
  name: string;
  /** Optional larger group the area belongs to (a module, a part of the book…). */
  group?: string;
  description?: string;
  /** Steps or sections within the area, in order. */
  stages: { id: string; name: string }[];
}

/** Something rules come from: a document, a meeting, a person's decision. */
export interface RuleSource {
  /** Short code used when citing it, e.g. "MA" or "D38". */
  id: string;
  name: string;
  /** The file, relative to the project folder, when there is one. */
  file?: string;
  /** Who stands behind it (an authority code). */
  authority?: string;
}

export interface RuleAuthority {
  id: string;
  name: string;
}

export interface RuleCitation {
  source: string;
  /** Where in the source: "p.20", "l.10", "section 3". */
  location?: string;
  /** The source's words, copied literally. */
  excerpt?: string;
}

export interface Rule {
  id: string;
  area: string;
  stage?: string;
  /** What the rule says (Markdown). Only what the sources say; assumptions are marked as such. */
  text: string;
  /** What the work does about it (e.g. "blocks the submission", "warning only"). */
  action?: string;
  citations: RuleCitation[];
  /** Authority code of who imposes it. */
  imposedBy?: string;
  confirmation: Confirmation;
  status: RuleStatus;
  /** How things are today, especially where they differ from the rule. */
  current?: string;
  /** How to check that it's met. */
  check?: string;
  /** The rule that replaced this one; a superseded rule stays for the record. */
  supersededBy?: string;
  updatedAt: number;
  updatedBy?: string;
}

export interface Register {
  areas: RuleArea[];
  sources: RuleSource[];
  authorities: RuleAuthority[];
  rules: Rule[];
}

const empty = (): Register => ({ areas: [], sources: [], authorities: [], rules: [] });

export function registerPath(project: Project): string {
  return path.join(docsRoot(project), project.docsLocation === "private" ? "rules.json" : path.join("docs", "rules.json"));
}

export async function readRegister(project: Project): Promise<Register> {
  const file = registerPath(project);
  if (!existsSync(file)) return empty();
  const data = JSON.parse(await fs.readFile(file, "utf8")) as Partial<Register>;
  return { areas: data.areas ?? [], sources: data.sources ?? [], authorities: data.authorities ?? [], rules: data.rules ?? [] };
}

// Several agents may write at once: one write at a time per file.
const queues = new Map<string, Promise<unknown>>();

async function change<T>(project: Project, fn: (reg: Register) => T): Promise<T> {
  const file = registerPath(project);
  const run = (queues.get(file) ?? Promise.resolve()).then(async () => {
    const reg = await readRegister(project);
    const result = fn(reg);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(reg, null, 2) + "\n");
    await replaceFile(tmp, file);
    return result;
  });
  queues.set(file, run.catch(() => {}));
  return run;
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.]{0,15}$/;

function code(value: unknown, what: string): string {
  const s = String(value ?? "").trim();
  if (!CODE.test(s)) throw new Error(`${what} must be a short code (letters, digits, dots; up to 16), e.g. "AP" or "MA".`);
  return s;
}

const text = (value: unknown) => (value === undefined || value === null ? undefined : String(value).trim() || undefined);

export async function saveArea(project: Project, input: { id: unknown; name: unknown; group?: unknown; description?: unknown; stages?: unknown }): Promise<string> {
  const id = code(input.id, "The area id").toUpperCase();
  const name = text(input.name);
  if (!name) throw new Error("Give the area a name.");
  const stages = Array.isArray(input.stages)
    ? input.stages.map((s: any, i: number) => {
        const stageName = text(s?.name ?? s);
        if (!stageName) throw new Error(`Stage ${i + 1} needs a name.`);
        return { id: text(s?.id) ?? String.fromCharCode(65 + i), name: stageName };
      })
    : undefined;
  return change(project, (reg) => {
    if (reg.sources.some((s) => s.id === id)) throw new Error(`"${id}" is already a source code; an area prefix must differ from every source code.`);
    const existing = reg.areas.find((a) => a.id === id);
    const area: RuleArea = { id, name, group: text(input.group), description: text(input.description), stages: stages ?? existing?.stages ?? [] };
    if (existing) Object.assign(existing, area);
    else reg.areas.push(area);
    return `${existing ? "Updated" : "Added"} area ${id} "${name}"${area.stages.length ? ` with stages ${area.stages.map((s) => `${s.id}. ${s.name}`).join("; ")}` : ""}.`;
  });
}

export async function saveSource(
  project: Project,
  input: { id: unknown; name: unknown; file?: unknown; authority?: unknown; authority_name?: unknown },
): Promise<string> {
  const id = code(input.id, "The source id");
  const name = text(input.name);
  if (!name) throw new Error("Give the source a name.");
  const authority = input.authority === undefined || input.authority === "" ? undefined : code(input.authority, "The authority");
  return change(project, (reg) => {
    if (reg.areas.some((a) => a.id === id)) throw new Error(`"${id}" is already an area prefix; a source code must differ from every area prefix.`);
    const source: RuleSource = { id, name, file: text(input.file)?.replace(/\\/g, "/"), authority };
    const existing = reg.sources.find((s) => s.id === id);
    if (existing) Object.assign(existing, source);
    else reg.sources.push(source);
    const authorityName = text(input.authority_name);
    if (authority && authorityName) {
      const known = reg.authorities.find((a) => a.id === authority);
      if (known) known.name = authorityName;
      else reg.authorities.push({ id: authority, name: authorityName });
    }
    return `${existing ? "Updated" : "Added"} source ${id} "${name}".`;
  });
}

/** Creates a rule (id assigned in its area) or updates one; only the given fields change. */
export async function saveRule(project: Project, input: Record<string, unknown>, by: string): Promise<string> {
  return change(project, (reg) => {
    const id = text(input.id)?.toUpperCase();
    const existing = id ? reg.rules.find((r) => r.id === id) : undefined;
    if (id && !existing) throw new Error(`No rule ${id}. Leave id out to add a new rule (Symbio assigns the next id in its area).`);

    const areaId = text(input.area)?.toUpperCase() ?? existing?.area;
    const area = reg.areas.find((a) => a.id === areaId);
    if (!area) {
      throw new Error(
        areaId
          ? `No area ${areaId}. Define it first with save_rule_area.${reg.areas.length ? ` Areas: ${reg.areas.map((a) => a.id).join(", ")}.` : ""}`
          : "Say which area the rule belongs to (area).",
      );
    }
    const stage = input.stage === undefined ? existing?.stage : text(input.stage);
    if (stage && !area.stages.some((s) => s.id === stage)) {
      throw new Error(`Area ${area.id} has no stage "${stage}". Stages: ${area.stages.map((s) => s.id).join(", ") || "none (define them with save_rule_area)"}.`);
    }
    const ruleText = input.text === undefined ? existing?.text : text(input.text);
    if (!ruleText) throw new Error("Say what the rule is (text).");
    const confirmation = (input.confirmation ?? existing?.confirmation ?? "found") as Confirmation;
    if (!CONFIRMATIONS.includes(confirmation)) throw new Error(`confirmation must be one of: ${CONFIRMATIONS.join(", ")}.`);
    const status = (input.status ?? existing?.status ?? "missing") as RuleStatus;
    if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}.`);

    let citations = existing?.citations ?? [];
    if (input.citations !== undefined) {
      if (!Array.isArray(input.citations)) throw new Error("citations must be a list of {source, location, excerpt}.");
      citations = input.citations.map((c: any) => {
        const source = code(c?.source, "A citation's source");
        if (!reg.sources.some((s) => s.id === source)) throw new Error(`Unknown source "${source}". Define it first with save_rule_source.`);
        return { source, location: text(c?.location), excerpt: text(c?.excerpt) };
      });
    }
    const imposedBy = input.imposed_by === undefined ? existing?.imposedBy : text(input.imposed_by);
    const supersededBy = input.superseded_by === undefined ? existing?.supersededBy : text(input.superseded_by)?.toUpperCase();
    if (supersededBy && !reg.rules.some((r) => r.id === supersededBy)) throw new Error(`No rule ${supersededBy} to supersede this one.`);

    const rule: Rule = {
      id: existing?.id ?? nextId(reg, area.id),
      area: area.id,
      stage,
      text: ruleText,
      action: input.action === undefined ? existing?.action : text(input.action),
      citations,
      imposedBy,
      confirmation,
      status,
      current: input.current === undefined ? existing?.current : text(input.current),
      check: input.check === undefined ? existing?.check : text(input.check),
      supersededBy,
      updatedAt: Date.now(),
      updatedBy: by,
    };
    if (existing) Object.assign(existing, rule);
    else reg.rules.push(rule);
    const unsourced = rule.citations.length === 0 ? " It has no source yet: add one when you find it." : "";
    return `${existing ? "Updated" : "Added"} ${rule.id}.${unsourced}`;
  });
}

/** Numbers are never reused: the next one is above every number the area ever had. */
function nextId(reg: Register, area: string): string {
  const used = reg.rules.filter((r) => r.id.startsWith(`${area}-`)).map((r) => Number(r.id.slice(area.length + 1)) || 0);
  return `${area}-${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
}

/** A compact listing for agents. */
export async function listRules(project: Project, filter: { query?: unknown; area?: unknown; status?: unknown }): Promise<string> {
  const reg = await readRegister(project);
  const q = text(filter.query)?.toLowerCase();
  const area = text(filter.area)?.toUpperCase();
  const status = text(filter.status);
  const rules = reg.rules.filter(
    (r) =>
      (!area || r.area === area) &&
      (!status || r.status === status) &&
      (!q || [r.id, r.text, r.current, r.action, ...r.citations.map((c) => `${c.source} ${c.location ?? ""} ${c.excerpt ?? ""}`)].some((s) => s?.toLowerCase().includes(q))),
  );
  const head = [
    `Areas: ${reg.areas.map((a) => `${a.id} (${a.name}${a.stages.length ? `; stages ${a.stages.map((s) => `${s.id}. ${s.name}`).join(", ")}` : ""})`).join(" · ") || "none yet"}`,
    `Sources: ${reg.sources.map((s) => `${s.id} = ${s.name}${s.file ? ` [${s.file}]` : ""}`).join(" · ") || "none yet"}`,
  ];
  if (!rules.length) return [...head, reg.rules.length ? "No rules match." : "No rules yet."].join("\n");
  const shown = rules.slice(0, 200);
  return [
    ...head,
    `${rules.length} rule(s)${rules.length > shown.length ? ` (first ${shown.length}; narrow the filter for the rest)` : ""}:`,
    ...shown.map(
      (r) =>
        `- ${r.id}${r.stage ? ` [${r.stage}]` : ""} ${r.status}/${r.confirmation}${r.supersededBy ? ` superseded by ${r.supersededBy}` : ""}: ${r.text.replace(/\s+/g, " ").slice(0, 220)}` +
        (r.citations.length ? ` — ${r.citations.map((c) => `${c.source}${c.location ? ` ${c.location}` : ""}`).join(", ")}` : " — no source"),
    ),
  ].join("\n");
}
