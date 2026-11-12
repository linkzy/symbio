import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Brain, Check, CircleAlert, CircleStop, Folder, FolderInput, GitBranch, Info, Loader2, Pencil, RefreshCw, Repeat, RotateCcw, Wrench, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, subscribe, type Agent, type Project, type CoreMode } from "./api";
import { PendingForms } from "./FormCard";
import { AttachButton, DropOverlay, MessageAttachments, PendingFiles, splitAttachmentNote, usePendingFiles } from "./Attachments";
import { Avatar, statusText } from "./ui";

type Block =
  | { kind: "text" | "reasoning"; key: string; text: string }
  | { kind: "tool"; key: string; name: string; input?: unknown; status: "running" | "done" | "failed"; output?: string };

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
      return update(data.id, (b) => ({ ...b, status: "done", output: contentText(data.content) }));
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

const KIND_LABEL: Record<string, string> = {
  request: "Request",
  info: "Update",
  blocking: "Blocking",
  urgent: "Urgent",
  "asset-request": "Asset request",
  "asset-granted": "Asset granted",
  "asset-denied": "Asset denied",
  "asset-released": "Asset released",
  "task-review": "Ready for review",
  "task-blocked": "Blocked",
};
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
          title="Rename"
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
      {dragging && <DropOverlay label={`Drop to attach to your message to ${agent.name}`} />}
      <div className="chat-head">
        <Avatar name={agent.name} status={agent.status} size="lg" />
        <div className="grow">
          <AgentName project={project} agent={agent} />
          <div className="sub ellipsis">
            {statusText(agent.status)} ·{" "}
            {agent.status === "stopped" ? (
              agent.model
            ) : (
              <select
                className="inline-select"
                value={agent.model}
                title={`Model ${agent.name} runs on — applies from its next turn`}
                onChange={(e) => api.setAgentModel(project.id, agent.id, e.target.value).catch((err) => alert(err.message))}
              >
                {[...new Set([agent.model, ...project.allowedModels])].map((m) => (
                  <option key={m} value={m} disabled={!project.allowedModels.includes(m)}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            {agent.branch ? (
              <>
                {" · "}
                <GitBranch size={11} style={{ verticalAlign: -1 }} /> {agent.repo ? `${agent.repo} · ${agent.branch}` : agent.branch}
              </>
            ) : (
              agent.role !== "coordinator" && (
                <span title={`Works in the project folder itself: ${project.directory}`}>
                  {" · "}
                  <Folder size={11} style={{ verticalAlign: -1 }} /> project folder{agent.repo ? ` · ${agent.repo}` : ""}
                </span>
              )
            )}
            {(agent.previousSessions?.length ?? 0) > 0 && (
              <>
                {" · "}
                <select
                  className="inline-select"
                  value={viewSession ?? ""}
                  title="Earlier sessions stay readable after the agent got a fresh one"
                  onChange={(e) => setViewSession(e.target.value || null)}
                >
                  <option value="">current session</option>
                  {[...agent.previousSessions!].reverse().map((s, i) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      earlier session {agent.previousSessions!.length - i} (until {new Date(s.endedAt).toLocaleString()})
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
            title={busy ? "Available when the agent is idle" : "Continue in a fresh session: lighter and cheaper; a handoff note carries the essentials over"}
            onClick={() => {
              if (!confirm(`Give ${agent.name} a fresh session? It keeps its name, folder, tasks and assets, and starts from a handoff note. The current conversation stays readable.`)) return;
              setRenewing(true);
              setViewSession(null);
              api
                .renewSession(project.id, agent.id)
                .catch((e) => alert(e.message))
                .finally(() => setRenewing(false));
            }}
          >
            <RefreshCw size={14} />
            <span className="btn-label">{renewing ? "Renewing…" : "New session"}</span>
          </button>
        )}
        {agent.role !== "coordinator" && agent.branch && agent.status !== "stopped" && (
          <button
            className="btn ghost sm"
            disabled={moving || busy || agent.status === "waiting"}
            title={
              busy
                ? "Available when the agent is idle"
                : "Work in the project folder itself instead of its own copy: what it writes is there at once, nothing to merge"
            }
            onClick={() => {
              if (
                !confirm(
                  `Move ${agent.name} into the project folder? Its own copy (branch ${agent.branch}) is removed, so its work must be merged first. ` +
                    "It continues in a fresh session with a handoff note; the current conversation stays readable.",
                )
              )
                return;
              setMoving(true);
              setViewSession(null);
              api
                .moveToProjectFolder(project.id, agent.id)
                .catch((e) => alert(e.message))
                .finally(() => setMoving(false));
            }}
          >
            <FolderInput size={14} />
            <span className="btn-label">{moving ? "Moving…" : "Move to project folder"}</span>
          </button>
        )}
        {agent.role !== "coordinator" && agent.status !== "stopped" && (
          <button
            className="btn ghost sm"
            onClick={() => {
              if (confirm(`Stop ${agent.name}? Any assets it holds are released; unmerged work is kept.`)) {
                api.stopAgent(project.id, agent.id).catch((e) => alert(e.message));
              }
            }}
          >
            <CircleStop size={14} />
            <span className="btn-label">Stop agent</span>
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
            {restarting ? "Restarting…" : "Restart agent"}
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
          {history === null && <div className="subtle center">Loading conversation…</div>}
          {hasOlder && (
            <button className="btn ghost sm load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          )}
          {history?.length === 0 && live.length === 0 && (
            <div className="chat-empty">
              <h2>Let's talk about the project</h2>
              <p>Tell core what you want to build. It will ask questions, agree on the scope with you, and then plan the work.</p>
            </div>
          )}
          <AnimatePresence initial={false}>
            {history?.map((m) => <HistoryItem key={m.id} message={m} projectId={project.id} />)}
            {live.length > 0 && (
              <motion.div key="live" className="msg-assistant" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {live.map((b) => (
                  <BlockView key={b.key} block={b} />
                ))}
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
            You're reading an earlier session of {agent.name} (read-only).
            <button className="btn sm" onClick={() => setViewSession(null)}>
              Back to the current session
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
                ? `${agent.name} is working — your message will be queued`
                : agent.role === "coordinator" && project.coreMode === "plan"
                  ? `Message ${agent.name}… (Plan: nothing starts)`
                  : `Message ${agent.name}…`
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
              <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> for a new line
            </span>
            <span className="spacer" />
            {busy && (
              <button className="btn ghost sm" onClick={() => api.interrupt(project.id, agent.id)} title="Interrupt the current turn">
                <CircleStop size={14} />
                Stop
              </button>
            )}
            <button className="btn primary icon sm" onClick={send} disabled={(!draft.trim() && !pending.ready.length) || pending.uploading || sending} title={pending.uploading ? "Waiting for the files to upload" : "Send"} aria-label="Send">
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

const MODES: { id: CoreMode; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "core decides whether to talk, plan or start the work" },
  { id: "plan", label: "Plan", hint: "Discuss and plan only: core can't start work, edit files or push until you switch" },
  { id: "act", label: "Act", hint: "Get it done without a plan to approve" },
];

/** How core handles your messages; applies at once (switch to Plan to stop it starting things). */
function ModeSelector({ project }: { project: Project }) {
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
    <div className="seg mode-seg" role="radiogroup" aria-label="How core handles your messages">
      {MODES.map((m) => (
        <button key={m.id} role="radio" aria-checked={mode === m.id} className={`${mode === m.id ? "on" : ""} mode-${m.id}`} title={m.hint} onClick={() => choose(m.id)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

function HistoryItem({ message: m, projectId }: { message: any; projectId: string }) {
  const anim = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.15 } };

  if (m.type === "user" || m.type === "synthetic") {
    const text: string = m.text ?? "";
    const fromAgent = text.match(AGENT_HEADER);
    if (fromAgent && fromAgent[1] !== "human") {
      const kind = fromAgent[2];
      return (
        <motion.div className="msg-agent" {...anim}>
          <div className="msg-agent-head">
            <Avatar name={fromAgent[1]} size="sm" />
            <strong>{fromAgent[1]}</strong>
            <span className={`tag ${KIND_TONE[kind] ?? ""}`}>{KIND_LABEL[kind] ?? kind}</span>
          </div>
          <div className="msg-agent-body md">
            <Markdown remarkPlugins={[remarkGfm]}>{text.slice(fromAgent[0].length)}</Markdown>
          </div>
        </motion.div>
      );
    }
    if (fromAgent) {
      const { body, files } = splitAttachmentNote(text.slice(fromAgent[0].length));
      return (
        <motion.div className="msg-user" {...anim}>
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
        {mode && (
          <span className={`mode-tag ${mode.toLowerCase()}`} title={`Sent in ${mode} mode`}>
            {mode}
          </span>
        )}
        {body}
        <MessageAttachments projectId={projectId} files={files} />
      </motion.div>
    );
  }

  if (m.type === "assistant") {
    const parts: any[] = m.content ?? [];
    if (parts.length === 0 && !m.error) return null;
    return (
      <motion.div className="msg-assistant" {...anim}>
        {parts.map((p, i) => (
          <BlockView key={i} block={partToBlock(p, i)} />
        ))}
        {m.error && (
          <div className="msg-failure">
            <CircleAlert size={14} />
            {m.error.message ?? String(m.error)}
          </div>
        )}
      </motion.div>
    );
  }

  if (m.type === "model-switched") {
    return (
      <motion.div className="msg-note" {...anim}>
        <span>
          <Repeat size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
          Switched to {m.model?.providerID}/{m.model?.id}
        </span>
      </motion.div>
    );
  }

  return null;
}

function partToBlock(p: any, i: number): Block {
  if (p.type === "text") return { kind: "text", key: String(i), text: p.text ?? "" };
  if (p.type === "reasoning") return { kind: "reasoning", key: String(i), text: p.text ?? "" };
  // Tool parts look like { type: "tool", name, state: { status, input, content: [{type:"text",text}] } }.
  const state = p.state ?? {};
  const status = state.status ?? p.status;
  return {
    kind: "tool",
    key: String(i),
    name: p.name ?? p.type,
    input: state.input ?? p.input,
    status: status === "error" || status === "failed" ? "failed" : status === "running" || status === "pending" ? "running" : "done",
    output: contentText(state.content) || state.error?.message || undefined,
  };
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "text") {
    return (
      <div className="md">
        <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
      </div>
    );
  }
  if (block.kind === "reasoning") {
    if (!block.text.trim()) return null;
    return (
      <details className="reasoning">
        <summary>
          <Brain size={13} />
          Thinking
        </summary>
        <div className="reasoning-body">{block.text}</div>
      </details>
    );
  }
  return <ToolView block={block as Extract<Block, { kind: "tool" }>} />;
}

function ToolView({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const summary = toolSummary(block.input);
  return (
    <details className="tool">
      <summary>
        <span className={`tool-state ${block.status}`}>
          {block.status === "running" ? <Loader2 size={13} className="spin" /> : block.status === "failed" ? <X size={13} /> : <Check size={13} />}
        </span>
        <Wrench size={12} className="subtle" />
        <span className="tool-name">{block.name}</span>
        {summary && <span className="tool-arg">{summary}</span>}
      </summary>
      {block.input !== undefined && <pre className="tool-io">{JSON.stringify(block.input, null, 2)}</pre>}
      {block.output && <pre className="tool-io out">{block.output.slice(0, 4000)}</pre>}
    </details>
  );
}

function toolSummary(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  // OpenCode "code mode": the model calls tools from a script; show which ones.
  if (typeof i.code === "string") {
    const called = [...new Set([...i.code.matchAll(/tools\.([\w$]+)\.([\w$]+)/g)].map((m) => `${m[1]}.${m[2]}`))];
    if (called.length) return called.join(", ");
    return i.code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim().slice(0, 120) ?? null;
  }
  const v = i.command ?? i.filePath ?? i.path ?? i.pattern ?? i.url ?? i.query;
  return typeof v === "string" ? v.slice(0, 120) : null;
}

/** The failed turn's error is already rendered from history; don't repeat it in the live banner. */
function lastTurnHasError(history: any[] | null): boolean {
  const lastAssistant = history?.findLast((m) => m.type === "assistant" || m.type === "user");
  return lastAssistant?.type === "assistant" && !!lastAssistant.error;
}

function retryLabel(data: any): string {
  const r = data?.retry ?? data;
  const reason = r?.error?.message ?? r?.message ?? "provider error";
  return `Provider not responding — retrying${r?.attempt ? ` (attempt ${r.attempt})` : ""}: ${reason}`;
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
      {stuck ? "Looked stuck — recovering…" : (retry ?? "Working…")}
    </div>
  );
}
