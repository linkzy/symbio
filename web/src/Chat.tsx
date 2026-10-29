import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Brain, Check, CircleAlert, CircleStop, GitBranch, Info, Loader2, Repeat, RotateCcw, Wrench, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, subscribe, type Agent, type Project } from "./api";
import { PendingForms } from "./FormCard";
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
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [restarting, setRestarting] = useState(false);
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
        .historyPage(project.id, agent.id, PAGE)
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
    [project.id, agent.id],
  );

  const loadOlder = useCallback(async () => {
    const { messages, hasOlder: older } = historyRef.current;
    if (!older || !messages?.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.historyPage(project.id, agent.id, PAGE, messages[0].id);
      keepOffset.current = scroller.current?.scrollHeight ?? null;
      showHistory([...page.messages, ...messages], page.hasMore);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [project.id, agent.id, loadingOlder]);

  // After prepending older messages, keep the reader's place instead of jumping.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && keepOffset.current !== null) {
      el.scrollTop += el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    }
  }, [history]);

  useEffect(() => {
    void loadHistory();
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
  }, [agent.id, loadHistory]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [history, live, failure]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setDraft("");
    stickToBottom.current = true;
    try {
      await api.send(project.id, agent.id, text);
      void loadHistory();
    } catch (e) {
      setFailure((e as Error).message);
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  const busy = agent.status === "busy" || agent.status === "stuck";

  return (
    <div className="chat">
      <div className="chat-head">
        <Avatar name={agent.name} status={agent.status} size="lg" />
        <div className="grow">
          <div className="title">{agent.name}</div>
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
            {agent.branch && (
              <>
                {" · "}
                <GitBranch size={11} style={{ verticalAlign: -1 }} /> {agent.branch}
              </>
            )}
          </div>
        </div>
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
            Stop agent
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
            {history?.map((m) => <HistoryItem key={m.id} message={m} />)}
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

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={draft}
            placeholder={busy ? `${agent.name} is working — your message will be queued` : `Message ${agent.name}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={Math.min(10, Math.max(1, draft.split("\n").length))}
          />
          <div className="composer-bar">
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
            <button className="btn primary icon sm" onClick={send} disabled={!draft.trim() || sending} title="Send" aria-label="Send">
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryItem({ message: m }: { message: any }) {
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
      return (
        <motion.div className="msg-user" {...anim}>
          {text.slice(fromAgent[0].length)}
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
    return (
      <motion.div className="msg-user" {...anim}>
        {text}
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
