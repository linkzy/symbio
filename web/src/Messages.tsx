import { useEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, subscribe, type LoggedMessage, type Project } from "./api";
import { Avatar, EmptyState, clock } from "./ui";

const KIND: Record<string, { label: string; tone?: string }> = {
  chat: { label: "Chat" },
  info: { label: "Update" },
  request: { label: "Request", tone: "accent" },
  blocking: { label: "Blocking", tone: "red" },
  urgent: { label: "Urgent", tone: "red" },
  "needs-human": { label: "Question for you", tone: "amber" },
  form: { label: "Question for you", tone: "amber" },
  alert: { label: "Needs your action", tone: "red" },
  approval: { label: "Approval requested", tone: "amber" },
  permission: { label: "Permission request", tone: "amber" },
  remote: { label: "Connection action", tone: "blue" },
  system: { label: "Symbio" },
  "asset-request": { label: "Asset request", tone: "accent" },
  "asset-granted": { label: "Asset granted", tone: "green" },
  "asset-denied": { label: "Asset denied", tone: "red" },
  "asset-released": { label: "Asset released" },
  plan: { label: "Plan proposed", tone: "amber" },
  "task-review": { label: "Ready for review", tone: "amber" },
  "task-blocked": { label: "Task blocked", tone: "red" },
};

/** Questions addressed to the human that haven't been answered by a later human message to that agent. */
export function openQuestions(log: LoggedMessage[]): LoggedMessage[] {
  return log.filter(
    (m) =>
      (m.kind === "needs-human" || m.kind === "form") &&
      m.from !== "symbio" &&
      !log.some((r) => r.from === "human" && r.to === m.from && r.time > m.time),
  );
}

export function useProjectLog(projectId: string) {
  const [log, setLog] = useState<LoggedMessage[] | null>(null);
  useEffect(() => {
    api
      .log(projectId)
      .then(setLog)
      .catch(() => setLog([]));
    return subscribe((e) => {
      if (e.type === "message" && e.projectId === projectId) {
        setLog((l) => (l && !l.some((m) => m.id === e.message.id) ? [...l, e.message] : l));
      }
    });
  }, [projectId]);
  return log;
}

export function Messages({ project, log, onOpenAgent }: { project: Project; log: LoggedMessage[] | null; onOpenAgent?: (agentId: string) => void }) {
  const [hideChat, setHideChat] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const name = (id: string) => (id === "human" ? "You" : id === "symbio" ? "Symbio" : (project.agents.find((a) => a.id === id)?.name ?? id));

  const shown = (log ?? []).filter((m) => !(hideChat && m.kind === "chat"));
  const open = new Set(openQuestions(log ?? []).map((m) => m.id));

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className="chat">
      <div className="timeline-toolbar">
        <span>Everything agents say to each other and to you, and what Symbio tells them.</span>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={hideChat} onChange={(e) => setHideChat(e.target.checked)} /> Hide your direct chats
        </label>
      </div>
      <div className="timeline" ref={scroller}>
        {log && shown.length === 0 && (
          <EmptyState icon={<MessagesSquare size={20} />} title="No team messages yet">
            Requests, handoffs and questions between agents show up here as they happen.
          </EmptyState>
        )}
        <div className="timeline-inner">
          {shown.map((m) => {
            const kind = KIND[m.kind] ?? { label: m.kind };
            const quiet = m.kind === "system" || m.kind === "chat";
            const from = name(m.from);
            return (
              <div key={m.id} className={`event ${quiet ? "quiet" : ""} ${open.has(m.id) ? "open" : ""}`}>
                <Avatar name={from} kind={m.from === "human" ? "human" : m.from === "symbio" ? "system" : "agent"} />
                <div style={{ minWidth: 0 }}>
                  <div className="event-head">
                    <strong>{from}</strong>
                    <span className="subtle">→</span>
                    <span>{name(m.to)}</span>
                    <span className={`tag ${kind.tone ?? ""}`}>{kind.label}</span>
                    <span className="when">{clock(m.time)}</span>
                  </div>
                  <div className="event-body md">
                    <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
                  </div>
                  {open.has(m.id) && m.kind === "needs-human" && <Reply project={project} agentId={m.from} />}
                  {open.has(m.id) && m.kind === "form" && onOpenAgent && (
                    <button className="btn primary sm" style={{ marginTop: 8 }} onClick={() => onOpenAgent(m.from)}>
                      Answer in {from}'s chat
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Reply({ project, agentId }: { project: Project; agentId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await api.send(project.id, agentId, text.trim());
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="reply">
      <textarea
        value={text}
        rows={2}
        placeholder="Write your answer…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="btn primary sm" onClick={send} disabled={!text.trim() || sending}>
        Reply
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
