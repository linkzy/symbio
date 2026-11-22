import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EffortSelect } from "./Effort";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Brain, Check, CircleAlert, CircleStop, Folder, FolderInput, GitBranch, Info, Loader2, Pencil, Pin, PinOff, RefreshCw, Repeat, RotateCcw, Wrench, X } from "lucide-react";
import { api, subscribe, type Agent, type Project, type CoreMode } from "./api";
import { PendingForms } from "./FormCard";
import { AttachButton, DropOverlay, MessageAttachments, PendingFiles, splitAttachmentNote, usePendingFiles } from "./Attachments";
import { Avatar, RetryIn, statusText, waitsForPinnedModel } from "./ui";
import { callsFromCode, stepLabels, summarize, type StepLabel, type ToolCall } from "./steps";
import { FileCard, Md } from "./files";
import { modelsForRole } from "./ModelPicker";
import { t, useI18n } from "./i18n";
import { CopyButton } from "./ui";

type Block =
  | { kind: "text" | "reasoning"; key: string; text: string }
  | { kind: "error"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      name: string;
      input?: unknown;
      status: "running" | "done" | "failed";
      output?: string;
      /** Tools a code-mode script called (OpenCode's metadata.toolCalls). */
      calls?: ToolCall[];
    };
type ToolBlock = Extract<Block, { kind: "tool" }>;

/** Turns OpenCode's live session events into renderable blocks for the in-progress turn. */
function applyStreamEvent(blocks: Block[], type: string, data: any): Block[] {
  const msg = data.assistantMessageID ?? "";
  const textKey = (kind: string) => `${msg}:${kind}:${data.ordinal ?? 0}`;
  const update = (key: string, fn: (b: any) => Block) => blocks.map((b) => (b.key === key ? fn(b) : b));
  const ensure = (block: Block) => (blocks.some((b) => b.key === block.key) ? blocks : [...blocks, block]);

  switch (type) {
    case "session.text.started":
      return ensure({ kind: "text", key: textKey("text"), text: "" });
    case "session.text.delta": {
      const key = textKey("text");
      const next = ensure({ kind: "text", key, text: "" });
      return next.map((b) => (b.key === key ? { ...b, text: (b as any).text + (data.delta ?? "") } : b));
    }
    case "session.text.ended":
      return update(textKey("text"), (b) => ({ ...b, text: data.text ?? b.text }));
    case "session.reasoning.started":
      return ensure({ kind: "reasoning", key: textKey("reasoning"), text: "" });
    case "session.reasoning.delta": {
      const key = textKey("reasoning");
      const next = ensure({ kind: "reasoning", key, text: "" });
      return next.map((b) => (b.key === key ? { ...b, text: (b as any).text + (data.delta ?? "") } : b));
    }
    case "session.tool.input.started":
      return ensure({ kind: "tool", key: data.id, name: data.name ?? "tool", status: "running" });
    case "session.tool.called":
      return update(data.id, (b) => ({ ...b, input: data.input }));
    case "session.tool.success":
      return update(data.id, (b) => ({ ...b, status: "done", output: contentText(data.content), calls: data.metadata?.toolCalls ?? b.calls }));
    case "session.tool.failed":
    case "session.tool.error":
      return update(data.id, (b) => ({ ...b, status: "failed", output: data.error?.message ?? contentText(data.content) }));
    default:
      return blocks;
  }
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
  return content
    .map((c: any) => (c?.type === "text" ? c.text : ""))
    .join("")
    .trim();
}

const SYSTEM_PREFIX = /^Symbio( watchdog)?:\s*/;
/** Messages delivered by Symbio between agents start with "[from: name · kind]". */
const AGENT_HEADER = /^\[from: ([^\]·]+?) · ([\w-]+)\]\n?/;

function kindLabel(kind: string) {
  return t(`chat.kind.${kind}` as any) === `chat.kind.${kind}` ? kind : t(`chat.kind.${kind}` as any);
}
const KIND_TONE: Record<string, string> = {
  "asset-granted": "green",
  "task-review": "amber",
  "asset-denied": "red",
  blocking: "red",
  urgent: "red",
  "task-blocked": "red",
  request: "accent",
  "asset-request": "accent",
};

/** The agent's name; helpers can be renamed in place (the old name keeps working for other agents). */
function AgentName({ project, agent }: { project: Project; agent: Agent }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(agent.name);
  const [saving, setSaving] = useState(false);
  async function save() {
    const name = value.trim();
    if (!name || name === agent.name) return setEditing(false);
    setSaving(true);
    try {
      await api.renameAgent(project.id, agent.id, name);
      setEditing(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  if (editing) {
    return (
      <input
        className="title-input"
        autoFocus
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") {
            setValue(agent.name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div className="title row" style={{ gap: 6 }}>
      {agent.name}
      {agent.role !== "coordinator" && (
        <button
          className="btn ghost icon xs"
          title={t("chat.rename")}
          onClick={() => {
            setValue(agent.name);
            setEditing(true);
          }}
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  );
}

// Long conversations (thousands of messages) made the page sluggish. Only a window is
// loaded: the latest PAGE messages, earlier pages when scrolling up, and the oldest are
// dropped again past MAX_KEPT while the reader follows the end of the conversation.
const PAGE = 40;
const MAX_KEPT = 120;

/** Merges the latest page into what's loaded; a gap (many new messages) restarts the window. */
function mergeLatest(prev: any[] | null, page: { messages: any[]; hasMore: boolean }, prevHasOlder: boolean) {
  const fresh = page.messages;
  if (!prev?.length || !fresh.length) return { messages: fresh, hasOlder: page.hasMore };
  const freshIds = new Set(fresh.map((m) => m.id));
  const connects = !page.hasMore || prev.some((m) => m.id === fresh[0].id);
  if (!connects) return { messages: fresh, hasOlder: true };
  const oldestFresh = fresh[0].time?.created ?? 0;
  const kept = prev.filter((m) => !freshIds.has(m.id) && (m.time?.created ?? 0) < oldestFresh);
  return { messages: [...kept, ...fresh], hasOlder: kept.length ? prevHasOlder : page.hasMore };
}

export function Chat({ project, agent }: { project: Project; agent: Agent }) {
  const { t } = useI18n();
  const [history, setHistory] = useState<any[] | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyRef = useRef<{ messages: any[] | null; hasOlder: boolean }>({ messages: null, hasOlder: false });
  const keepOffset = useRef<number | null>(null); // scrollHeight before older messages were prepended
  const [live, setLive] = useState<Block[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState<string | null>(null);
  // What's being typed is kept in the browser per project and agent: leaving the chat (another tab,
  // another project, a reload) doesn't lose it. Cleared when the message is sent.
  const draftKey = `symbio:draft:${project.id}:${agent.id}`;
  const [draft, setDraftState] = useState(() => localStorage.getItem(draftKey) ?? "");
  const setDraft = (text: string) => {
    setDraftState(text);
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  };
  const [sending, setSending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const pending = usePendingFiles(project.id, `symbio:draft-files:${project.id}:${agent.id}`);
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState(false);
  // null = the current session; otherwise an earlier one (read-only), after a renewal.
  const [viewSession, setViewSession] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const showHistory = (messages: any[], older: boolean) => {
    historyRef.current = { messages, hasOlder: older };
    setHistory(messages);
    setHasOlder(older);
  };

  const loadHistory = useCallback(
    () =>
      api
        .historyPage(project.id, agent.id, PAGE, undefined, viewSession ?? undefined)
        .then((page) => {
          const current = historyRef.current;
          let { messages, hasOlder: older } = mergeLatest(current.messages, page, current.hasOlder);
          if (stickToBottom.current && messages.length > MAX_KEPT) {
            messages = messages.slice(-PAGE * 2);
            older = true;
          }
          showHistory(messages, older);
        })
        .catch((e) => setFailure(e.message)),
    [project.id, agent.id, viewSession],
  );

  const loadOlder = useCallback(async () => {
    const { messages, hasOlder: older } = historyRef.current;
    if (!older || !messages?.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.historyPage(project.id, agent.id, PAGE, messages[0].id, viewSession ?? undefined);
      keepOffset.current = scroller.current?.scrollHeight ?? null;
      showHistory([...page.messages, ...messages], page.hasMore);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [project.id, agent.id, loadingOlder, viewSession]);

  // After prepending older messages, keep the reader's place instead of jumping.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && keepOffset.current !== null) {
      el.scrollTop += el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    }
  }, [history]);

  useEffect(() => {
    // A different session (renewed, or picked to read): start the window over.
    historyRef.current = { messages: null, hasOlder: false };
    setHistory(null);
    setHasOlder(false);
    setLive([]);
    stickToBottom.current = true;
    void loadHistory();
    if (viewSession) return; // earlier sessions don't change
    return subscribe((e) => {
      if (e.type !== "agent.stream" || e.agentId !== agent.id) return;
      const { type, data } = e.event;
      if (/retr/i.test(type)) {
        setRetry(retryLabel(data));
        return;
      }
      if (type === "session.text.delta" || type === "session.tool.called") setRetry(null);
      if (type === "session.execution.started") {
        setFailure(null);
        void loadHistory(); // shows the user message that started this turn
        return;
      }
      if (type.startsWith("session.execution.")) {
        setRetry(null);
        if (type === "session.execution.failed") setFailure(data.error?.message ?? "The agent's turn failed.");
        void loadHistory().then(() => setLive([]));
        return;
      }
      setLive((blocks) => applyStreamEvent(blocks, type, data));
    });
  }, [agent.id, agent.sessionId, viewSession, loadHistory]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [history, live, failure]);

  async function send() {
    const text = draft.trim();
    const files = pending.ready;
    if ((!text && !files.length) || pending.uploading) return;
    setSending(true);
    setDraft("");
    stickToBottom.current = true;
    try {
      await api.send(project.id, agent.id, text, false, files);
      pending.clear();
      void loadHistory();
    } catch (e) {
      setFailure((e as Error).message);
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  const busy = agent.status === "busy" || agent.status === "stuck";
  // Files dropped anywhere on the chat (or pasted into the box) go with the next message.
  const drop = viewSession
    ? {}
    : {
        onDragOver: (e: React.DragEvent) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          setDragging(false);
          pending.add([...e.dataTransfer.files]);
        },
      };

  return (
    <div className="chat" {...drop}>
      {dragging && <DropOverlay label={t("chat.drop", { name: agent.name })} />}
      {waitsForPinnedModel(agent) && (
        <div className="banner amber pin-wait">
          <Pin size={14} />
          <div className="grow ellipsis" title={agent.problem ?? ""}>
            <strong>{t("chat.waitingModel.title", { model: agent.model })}</strong>{" "}
            <span className="muted">
              {/* keep RetryIn element */}
              {t("chat.waitingModel.desc").split("{until}")[0]}
              <RetryIn until={agent.modelWait!.until} />
              {t("chat.waitingModel.desc").split("{until}")[1] ?? ""}
            </span>
          </div>
          <button className="btn sm" onClick={() => api.retryModels(project.id).catch((e) => alert(e.message))}>
            {t("common.retryNow")}
          </button>
          <button className="btn sm ghost" onClick={() => api.pinAgentModel(project.id, agent.id, false).catch((e) => alert(e.message))}>
            {t("chat.pin.unpin")}
          </button>
        </div>
      )}
      <div className="chat-head">
        <Avatar name={agent.name} status={waitsForPinnedModel(agent) ? "waiting" : agent.status} size="lg" />
        <div className="grow">
          <AgentName project={project} agent={agent} />
          <div className="sub ellipsis">
            {waitsForPinnedModel(agent) ? t("chat.waitingForModel") : statusText(agent.status)} ·{" "}
            {agent.status === "stopped" ? (
              agent.model
            ) : (
              <select
                className="inline-select"
                value={agent.model}
                title={t("chat.model.title", { name: agent.name })}
                onChange={(e) => api.setAgentModel(project.id, agent.id, e.target.value).catch((err) => alert(err.message))}
              >
                {[...new Set([agent.model, ...modelsForRole(project, agent.role)])].map((m) => (
                  <option key={m} value={m} disabled={!modelsForRole(project, agent.role).includes(m)}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            {agent.status !== "stopped" && <EffortSelect project={project} agent={agent} />}
            {agent.status !== "stopped" && <PinButton project={project} agent={agent} />}
            {agent.branch ? (
              <>
                {" · "}
                <GitBranch size={11} style={{ verticalAlign: -1 }} /> {agent.repo ? `${agent.repo} · ${agent.branch}` : agent.branch}
              </>
            ) : (
              agent.role !== "coordinator" && (
                <span title={t("chat.projectFolder.title", { path: project.directory })}>
                  {" · "}
                  <Folder size={11} style={{ verticalAlign: -1 }} /> {t("chat.projectFolder")}{agent.repo ? ` · ${agent.repo}` : ""}
                </span>
              )
            )}
            {(agent.previousSessions?.length ?? 0) > 0 && (
              <>
                {" · "}
                <select
                  className="inline-select"
                  value={viewSession ?? ""}
                  title={t("chat.sessions.earlier")}
                  onChange={(e) => setViewSession(e.target.value || null)}
                >
                  <option value="">{t("chat.sessions.current")}</option>
                  {[...agent.previousSessions!].reverse().map((s, i) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {t("chat.sessions.earlierItem", { n: agent.previousSessions!.length - i, date: new Date(s.endedAt).toLocaleString() })}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
        {agent.status !== "stopped" && (
          <button
            className="btn ghost sm"
            disabled={renewing || busy || agent.status === "waiting"}
            title={busy ? t("chat.renew.disabled") : t("chat.renew.title")}
            onClick={() => {
              if (!confirm(t("chat.renew.confirm", { name: agent.name }))) return;
              setRenewing(true);
              setViewSession(null);
              api
                .renewSession(project.id, agent.id)
                .catch((e) => alert(e.message))
                .finally(() => setRenewing(false));
            }}
          >
            <RefreshCw size={14} />
            <span className="btn-label">{renewing ? t("chat.renewing") : t("chat.newSession")}</span>
          </button>
        )}
        {agent.role !== "coordinator" && agent.branch && agent.status !== "stopped" && (
          <button
            className="btn ghost sm"
            disabled={moving || busy || agent.status === "waiting"}
            title={busy ? t("chat.renew.disabled") : t("chat.move.title")}
            onClick={() => {
              if (!confirm(t("chat.move.confirm", { name: agent.name, branch: agent.branch ?? "" }))) return;
              setMoving(true);
              setViewSession(null);
              api
                .moveToProjectFolder(project.id, agent.id)
                .catch((e) => alert(e.message))
                .finally(() => setMoving(false));
            }}
          >
            <FolderInput size={14} />
            <span className="btn-label">{moving ? t("chat.moving") : t("chat.moveToProjectFolder")}</span>
          </button>
        )}
        {agent.role !== "coordinator" && agent.status !== "stopped" && (
          <button
            className="btn ghost sm"
            onClick={() => {
              if (confirm(t("chat.stop.confirm", { name: agent.name }))) {
                api.stopAgent(project.id, agent.id).catch((e) => alert(e.message));
              }
            }}
          >
            <CircleStop size={14} />
            <span className="btn-label">{t("chat.stopAgent")}</span>
          </button>
        )}
        {agent.role !== "coordinator" && agent.status === "stopped" && (
          <button
            className="btn sm"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              api
                .restartAgent(project.id, agent.id)
                .catch((e) => alert(e.message))
                .finally(() => setRestarting(false));
            }}
          >
            <RotateCcw size={14} />
            {restarting ? t("chat.restarting") : t("chat.restartAgent")}
          </button>
        )}
      </div>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 300) void loadOlder();
        }}
      >
        <div className="chat-col">
          {history === null && <div className="subtle center">{t("chat.loading")}</div>}
          {hasOlder && (
            <button className="btn ghost sm load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? t("common.loadingOlder") : t("common.loadOlder")}
            </button>
          )}
          {history?.length === 0 && live.length === 0 && (
            <div className="chat-empty">
              <h2>{t("chat.empty.title")}</h2>
              <p>{t("chat.empty.body")}</p>
            </div>
          )}
          <AnimatePresence initial={false}>
            {historyUnits(history ?? []).map((u) =>
              u.kind === "assistant" ? (
                <motion.div key={u.key} className="msg-assistant" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
                  <Blocks blocks={u.blocks} projectId={project.id} agentId={agent.id} />
                </motion.div>
              ) : (
                <HistoryItem key={u.message.id} message={u.message} project={project} />
              ),
            )}
            {live.length > 0 && (
              <motion.div key="live" className="msg-assistant" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <Blocks blocks={live} projectId={project.id} agentId={agent.id} />
              </motion.div>
            )}
          </AnimatePresence>
          {busy && live.length === 0 && <Thinking stuck={agent.status === "stuck"} retry={retry ?? pendingRetry(history)} />}
          <PendingForms project={project} agent={agent} />
          {failure && !lastTurnHasError(history) && (
            <div className="msg-failure">
              <CircleAlert size={14} />
              {failure}
            </div>
          )}
        </div>
      </div>

      {viewSession ? (
        <div className="composer-wrap">
          <div className="session-note">
            {t("chat.readingEarlier", { name: agent.name })}
            <button className="btn sm" onClick={() => setViewSession(null)}>
              {t("chat.backToCurrent")}
            </button>
          </div>
        </div>
      ) : (
      <div className="composer-wrap">
        <div className="composer">
          <PendingFiles projectId={project.id} files={pending.files} onRemove={pending.remove} />
          <textarea
            value={draft}
            placeholder={
              busy
                ? t("chat.composer.busy", { name: agent.name })
                : agent.role === "coordinator" && project.coreMode === "plan"
                  ? t("chat.composer.plan", { name: agent.name })
                  : t("chat.composer.placeholder", { name: agent.name })
            }
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              // A screenshot or copied files (not text that happens to come with an image).
              const files = [...e.clipboardData.files];
              if (files.length && !e.clipboardData.getData("text/plain")) {
                e.preventDefault();
                pending.add(files);
              }
            }}
            onKeyDown={(e) => {
              // Touch keyboards have no Shift+Enter: there Enter is a new line, and the button sends.
              if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
                e.preventDefault();
                void send();
              }
            }}
            rows={Math.min(10, Math.max(1, draft.split("\n").length))}
          />
          <div className="composer-bar">
            <AttachButton onFiles={pending.add} />
            {agent.role === "coordinator" && <ModeSelector project={project} />}
            <span className="composer-hint">
              <span className="kbd">Enter</span> {t("chat.composer.toSend")} <span className="kbd">Shift</span>+<span className="kbd">Enter</span> {t("chat.composer.newLine")}
            </span>
            <span className="spacer" />
            {busy && (
              <button className="btn ghost sm" onClick={() => api.interrupt(project.id, agent.id)} title={t("chat.interrupt")}>
                <CircleStop size={14} />
                {t("common.stop")}
              </button>
            )}
            <button className="btn primary icon sm" onClick={send} disabled={(!draft.trim() && !pending.ready.length) || pending.uploading || sending} title={pending.uploading ? t("chat.composer.uploading") : t("common.send")} aria-label={t("common.send")}>
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// The note Symbio adds to a message sent to core in Plan or Act mode (prompts.ts modeNote).
const MODE_NOTE = /\n\n\[Mode: (Plan|Act) — [^\]]*\]\s*$/;

/** A message to core without its mode note, and the mode it was sent in (null = Auto). */
function splitModeNote(text: string): { text: string; mode: "Plan" | "Act" | null } {
  const m = text.match(MODE_NOTE);
  return m ? { text: text.slice(0, m.index), mode: m[1] as "Plan" | "Act" } : { text, mode: null };
}

const MODE_IDS: CoreMode[] = ["auto", "plan", "act"];

/** How core handles your messages; applies at once (switch to Plan to stop it starting things). */
function ModeSelector({ project }: { project: Project }) {
  const { t } = useI18n();
  const mode = project.coreMode ?? "auto";
  const [saving, setSaving] = useState(false);
  async function choose(next: CoreMode) {
    if (next === mode || saving) return;
    setSaving(true);
    try {
      await api.updateProject(project.id, { coreMode: next });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="seg mode-seg" role="radiogroup" aria-label={t("chat.mode.aria")}>
      {MODE_IDS.map((id) => (
        <button key={id} role="radio" aria-checked={mode === id} className={`${mode === id ? "on" : ""} mode-${id}`} title={t(`chat.mode.${id}.hint` as any)} onClick={() => choose(id)}>
          {t(`chat.mode.${id}` as any)}
        </button>
      ))}
    </div>
  );
}

/**
 * A helper's report as Symbio delivers it to core: `T201 "Title" → review: summary`, then lines
 * meant for core ("Merge with merge_work(…) when it looks right."), which the human doesn't need.
 */
function parseReport(body: string): { task: string; title: string; summary: string } | null {
  const m = /^(T\d+) "(.*?)" → (?:review|blocked)(?::\s*)?([\s\S]*)$/.exec(body.trim());
  if (!m) return null;
  const forCore = /\n(Merge with merge_work\(|Its work is already in the project folder|Then it waits for the human's review)/;
  const cut = m[3].search(forCore);
  return { task: m[1], title: m[2], summary: (cut >= 0 ? m[3].slice(0, cut) : m[3]).trim() };
}

/** Long content folded to a few lines, with "Show all". */
function Folded({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 8);
  }, [children]);
  return (
    <div className={`folded${open ? " open" : ""}${long && !open ? " clipped" : ""}`}>
      <div ref={ref} className="folded-body">
        {children}
      </div>
      {(long || open) && (
        <button className="btn ghost sm folded-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? t("common.showLess") : t("common.showAll")}
        </button>
      )}
    </div>
  );
}

function HistoryItem({ message: m, project }: { message: any; project: Project }) {
  const projectId = project.id;
  const anim = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.15 } };

  if (m.type === "user" || m.type === "synthetic") {
    const text: string = m.text ?? "";
    const fromAgent = text.match(AGENT_HEADER);
    if (fromAgent && fromAgent[1] !== "human") {
      const kind = fromAgent[2];
      const body = text.slice(fromAgent[0].length);
      const report = kind === "task-review" || kind === "task-blocked" ? parseReport(body) : null;
      return (
        <motion.div className={`msg-agent${report ? " report" : ""}`} {...anim}>
          <div className="msg-agent-head">
            <Avatar name={fromAgent[1]} size="sm" />
            <strong>{fromAgent[1]}</strong>
            <span className={`tag ${KIND_TONE[kind] ?? ""}`}>{kindLabel(kind)}</span>
            {report && (
              <span className="report-task">
                <span className="task-id">{report.task}</span>
                <span className="report-title">{report.title}</span>
              </span>
            )}
          </div>
          <MessageCopy text={report ? report.summary || t("chat.noSummary") : body} />
      <Folded>
        <Md
          className="msg-agent-body md"
          text={report ? report.summary || t("chat.noSummary") : body}
          projectId={projectId}
          agentId={project.agents.find((a) => a.name === fromAgent[1])?.id}
        />
      </Folded>
        </motion.div>
      );
    }
    if (fromAgent) {
      const { body, files } = splitAttachmentNote(text.slice(fromAgent[0].length));
      return (
        <motion.div className="msg-user" {...anim}>
          <MessageCopy text={body} />
      {body}
      <MessageAttachments projectId={projectId} files={files} />
        </motion.div>
      );
    }
    if (SYSTEM_PREFIX.test(text)) {
      return (
        <motion.div className="msg-note" {...anim}>
          <span>
            <Info size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
            {text.replace(SYSTEM_PREFIX, "")}
          </span>
        </motion.div>
      );
    }
    const { text: plain, mode } = splitModeNote(text);
    const { body, files } = splitAttachmentNote(plain);
    return (
      <motion.div className="msg-user" {...anim}>
        <MessageCopy text={body} />
        {mode && (
          <span className={`mode-tag ${mode.toLowerCase()}`} title={t("chat.mode.sentIn", { mode: t(`chat.mode.${mode.toLowerCase()}` as any) })}>
            {t(`chat.mode.${mode.toLowerCase()}` as any)}
          </span>
        )}
        {body}
        <MessageAttachments projectId={projectId} files={files} />
      </motion.div>
    );
  }

  if (m.type === "model-switched") {
    return (
      <motion.div className="msg-note" {...anim}>
        <span>
          <Repeat size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
          {t("chat.modelSwitched", { model: `${m.model?.providerID}/${m.model?.id}` })}
        </span>
      </motion.div>
    );
  }

  return null;
}

function partToBlock(p: any, key: string): Block {
  if (p.type === "text") return { kind: "text", key, text: p.text ?? "" };
  if (p.type === "reasoning") return { kind: "reasoning", key, text: p.text ?? "" };
  // Tool parts look like { type: "tool", name, state: { status, input, content: [{type:"text",text}], metadata } }.
  const state = p.state ?? {};
  const status = state.status ?? p.status;
  return {
    kind: "tool",
    key,
    name: p.name ?? p.type,
    input: state.input ?? p.input,
    status: status === "error" || status === "failed" ? "failed" : status === "running" || status === "pending" ? "running" : "done",
    output: contentText(state.content) || state.error?.message || undefined,
    calls: Array.isArray(state.metadata?.toolCalls) ? state.metadata.toolCalls : undefined,
  };
}

type HistoryUnit = { kind: "assistant"; key: string; blocks: Block[] } | { kind: "other"; message: any };

function MessageCopy({ text }: { text: string }) {
  const copy = text.trim();
  if (!copy) return null;
  return <CopyButton text={copy} label={t("common.copy")} copiedLabel={t("common.copied")} className="msg-copy" />;
}

function messageText(blocks: Block[]): string {
  return blocks
    .flatMap((b) => (b.kind === "text" ? [b.text] : b.kind === "tool" && b.output ? [`${b.name}\n${b.output}`] : []))
    .join("\n\n")
    .trim();
}

/**
 * The conversation as the chat shows it. OpenCode stores each model step as its own assistant
 * message, so a run of 7 tool steps is 7 messages: consecutive ones are joined, and their steps
 * then fold into one line (see Blocks).
 */
function historyUnits(history: any[]): HistoryUnit[] {
  const units: HistoryUnit[] = [];
  for (const m of history) {
    if (m.type !== "assistant") {
      units.push({ kind: "other", message: m });
      continue;
    }
    const blocks: Block[] = (m.content ?? []).map((p: any, i: number) => partToBlock(p, `${m.id}:${i}`));
    if (m.error) blocks.push({ kind: "error", key: `${m.id}:error`, text: m.error.message ?? String(m.error) });
    if (blocks.length === 0) continue;
    const last = units[units.length - 1];
    if (last?.kind === "assistant") last.blocks.push(...blocks);
    else units.push({ kind: "assistant", key: m.id, blocks });
  }
  return units;
}

/** Files a step shared with the human (share_file), alone or among a code-mode script's calls. */
function sharedIn(b: ToolBlock): { path: string; caption?: string }[] {
  const input = (b.input ?? {}) as Record<string, unknown>;
  if (/(^|[._])share_file$/.test(b.name) && typeof input.path === "string") return [{ path: input.path, caption: input.caption as string | undefined }];
  const calls = b.calls?.length ? b.calls : typeof input.code === "string" ? callsFromCode(input.code) : [];
  return calls
    .filter((c) => /(^|\.)share_file$/.test(c.tool) && typeof c.input?.path === "string" && c.status !== "error")
    .map((c) => ({ path: c.input!.path as string, caption: c.input!.caption as string | undefined }));
}

/**
 * Text as it is (paths in it linked to the files), runs of steps (and the thinking between them)
 * folded into one line each, and files the agent shared shown as cards, outside the fold.
 */
function Blocks({ blocks, projectId, agentId }: { blocks: Block[]; projectId: string; agentId: string }) {
  const copy = messageText(blocks);
  type Group = Block | { kind: "steps"; key: string; items: Block[] } | { kind: "file"; key: string; path: string; caption?: string };
  const groups: Group[] = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    const inRun = last?.kind === "steps";
    if (b.kind === "tool" && b.status === "done" && sharedIn(b).length) {
      sharedIn(b).forEach((s, i) => groups.push({ kind: "file", key: `${b.key}:file:${i}`, ...s }));
      continue;
    }
    if (b.kind === "tool" || (b.kind === "reasoning" && inRun)) {
      if (inRun) (last as { items: Block[] }).items.push(b);
      else groups.push({ kind: "steps", key: b.key, items: [b] });
    } else groups.push(b);
  }
  return (
    <div className="msg-blocks">
      {copy && <MessageCopy text={copy} />}
      {groups.map((g) => {
        if (g.kind === "steps") return <StepGroup key={g.key} items={g.items} />;
        if (g.kind === "file") return <FileCard key={g.key} projectId={projectId} agentId={agentId} path={g.path} caption={g.caption} />;
        if (g.kind === "text") return <Md key={g.key} text={g.text} projectId={projectId} agentId={agentId} />;
        if (g.kind === "reasoning") return <Reasoning key={g.key} text={g.text} />;
        if (g.kind === "error") {
          return (
            <div key={g.key} className="msg-failure">
              <CircleAlert size={14} />
              {g.text}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <details className="reasoning">
      <summary>
        <Brain size={13} />
        {t("chat.thinking.label")}
      </summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

const labelsOf = (b: ToolBlock): StepLabel[] => stepLabels(b.name, b.input, b.calls);

/** A run of steps: one line saying what they did (or what's running now), the steps inside. */
function StepGroup({ items }: { items: Block[] }) {
  const tools = items.filter((b): b is ToolBlock => b.kind === "tool");
  if (items.length === 1 && tools.length === 1 && labelsOf(tools[0]).length === 1) return <StepRow block={tools[0]} />;
  const running = tools.find((t) => t.status === "running");
  const failed = tools.filter((t) => t.status === "failed").length;
  const all = tools.flatMap(labelsOf);
  const title = running ? `${labelsOf(running).map((l) => l.label).join(" · ")}…` : summarize(all);
  const state = running ? "running" : failed ? "failed" : "done";
  return (
    <details className="step-run">
      <summary>
        <span className={`tool-state ${state}`}>{running ? <Loader2 size={13} className="spin" /> : failed ? <X size={13} /> : <Check size={13} />}</span>
        <span className="step-run-title">{title}</span>
        <span className="step-run-count">
          {t("chat.steps.count", { n: all.length })}{failed ? t("chat.steps.failed", { n: failed }) : ""}
        </span>
      </summary>
      <div className="step-run-body">
        {items.map((b) => (b.kind === "tool" ? <StepRow key={b.key} block={b} /> : b.kind === "reasoning" ? <Reasoning key={b.key} text={b.text} /> : null))}
      </div>
    </details>
  );
}

/** One step in plain words; the raw input and output a click away. */
function StepRow({ block }: { block: ToolBlock }) {
  const labels = labelsOf(block);
  return (
    <details className="tool">
      <summary>
        <span className={`tool-state ${block.status}`}>
          {block.status === "running" ? <Loader2 size={13} className="spin" /> : block.status === "failed" ? <X size={13} /> : <Check size={13} />}
        </span>
        <span className="step-labels">
          {labels.map((l, i) => (
            <span key={i} className="step-label">
              <span className="step-text">{l.label}</span>
              {l.detail && <span className="tool-arg">{l.detail}</span>}
            </span>
          ))}
        </span>
      </summary>
      <div className="step-raw">
        <span className="small subtle">
          <Wrench size={11} /> {block.name}
        </span>
        {block.input !== undefined && <pre className="tool-io">{rawInput(block.input)}</pre>}
        {block.output && <pre className="tool-io out">{block.output.slice(0, 4000)}</pre>}
      </div>
    </details>
  );
}

/** What the model actually sent: a command or a script as text, anything else as JSON. */
function rawInput(input: unknown): string {
  const i = input as Record<string, unknown>;
  if (i && typeof i.command === "string") return i.command;
  if (i && typeof i.code === "string") return i.code;
  return JSON.stringify(input, null, 2);
}

/** The failed turn's error is already rendered from history; don't repeat it in the live banner. */
function lastTurnHasError(history: any[] | null): boolean {
  const lastAssistant = history?.findLast((m) => m.type === "assistant" || m.type === "user");
  return lastAssistant?.type === "assistant" && !!lastAssistant.error;
}

function retryLabel(data: any): string {
  const r = data?.retry ?? data;
  const reason = r?.error?.message ?? r?.message ?? "provider error";
  const attempt = r?.attempt ? t("chat.attempt", { n: r.attempt }) : "";
  return t("chat.retry", { attempt, reason });
}

/** A turn that is waiting on provider retries shows up in history as an empty assistant message with `retry`. */
function pendingRetry(history: any[] | null): string | null {
  const last = history?.[history.length - 1];
  return last?.type === "assistant" && last.retry && !last.content?.length ? retryLabel(last) : null;
}

function Thinking({ stuck, retry }: { stuck: boolean; retry: string | null }) {
  return (
    <div className={`thinking ${retry ? "retrying" : ""}`}>
      <span className="typing">
        <i />
        <i />
        <i />
      </span>
      {stuck ? t("chat.thinking.stuck") : (retry ?? t("chat.thinking"))}
    </div>
  );
}

/**
 * Pins the agent to its model: when the model fails it waits and retries it instead of switching to
 * another allowed model (the default).
 */
function PinButton({ project, agent }: { project: Project; agent: Agent }) {
  const pinned = !!agent.modelPinned;
  const by = agent.modelPinned?.by === "coordinator" ? t("chat.pin.byCore") : "";
  return (
    <button
      className={`btn ghost icon xs pin-model ${pinned ? "on" : ""}`}
      aria-label={pinned ? t("chat.pin.unpinModel") : t("chat.pin.pin")}
      aria-pressed={pinned}
      title={
        pinned
          ? t("chat.pin.pinnedTitle", { model: agent.model, by, name: agent.name })
          : t("chat.pin.unpinnedTitle", { name: agent.name, model: agent.model })
      }
      onClick={() => api.pinAgentModel(project.id, agent.id, !pinned).catch((e) => alert(e.message))}
    >
      {pinned ? <Pin size={12} /> : <PinOff size={12} />}
    </button>
  );
}
