import { useEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { api, subscribe, type LoggedMessage, type Project } from "./api";
import { Md } from "./files";
import { Avatar, EmptyState, clock } from "./ui";
import { useI18n, type MessageKey } from "./i18n";

const KIND: Record<string, { label: MessageKey | "Symbio"; tone?: string }> = {
  chat: { label: "work.messages.kind.chat" },
  info: { label: "chat.kind.info" },
  request: { label: "chat.kind.request", tone: "accent" },
  blocking: { label: "chat.kind.blocking", tone: "red" },
  urgent: { label: "chat.kind.urgent", tone: "red" },
  "needs-human": { label: "work.messages.kind.question", tone: "amber" },
  question: { label: "work.messages.kind.question", tone: "amber" },
  form: { label: "work.messages.kind.question", tone: "amber" },
  alert: { label: "work.messages.kind.alert", tone: "red" },
  budget: { label: "work.messages.kind.budget", tone: "amber" },
  job: { label: "work.messages.kind.job", tone: "blue" },
  approval: { label: "work.messages.kind.approval", tone: "amber" },
  permission: { label: "work.messages.kind.permission", tone: "amber" },
  remote: { label: "work.messages.kind.remote", tone: "blue" },
  system: { label: "Symbio" },
  "asset-request": { label: "chat.kind.asset-request", tone: "accent" },
  "asset-granted": { label: "chat.kind.asset-granted", tone: "green" },
  "asset-denied": { label: "chat.kind.asset-denied", tone: "red" },
  "asset-released": { label: "chat.kind.asset-released" },
  plan: { label: "work.messages.kind.plan", tone: "amber" },
  "task-review": { label: "chat.kind.task-review", tone: "amber" },
  "task-blocked": { label: "work.messages.kind.taskBlocked", tone: "red" },
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
  const { t } = useI18n();
  const [hideChat, setHideChat] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const name = (id: string) => (id === "human" ? t("common.you") : id === "symbio" ? "Symbio" : (project.agents.find((a) => a.id === id)?.name ?? id));

  const shown = (log ?? []).filter((m) => !(hideChat && m.kind === "chat"));
  const open = new Set(openQuestions(log ?? []).map((m) => m.id));

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className="chat">
      <div className="timeline-toolbar">
        <span>{t("work.messages.intro")}</span>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={hideChat} onChange={(e) => setHideChat(e.target.checked)} /> {t("work.messages.hideChats")}
        </label>
      </div>
      <div className="timeline" ref={scroller}>
        {log && shown.length === 0 && (
          <EmptyState icon={<MessagesSquare size={20} />} title={t("work.messages.empty.title")}>
            {t("work.messages.empty.body")}
          </EmptyState>
        )}
        <div className="timeline-inner">
          {shown.map((m) => {
            const known = KIND[m.kind];
            const kind = known ? { ...known, label: known.label === "Symbio" ? known.label : t(known.label) } : { label: m.kind, tone: undefined };
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
                    <Md text={m.text} projectId={project.id} agentId={m.from} className="" />
                  </div>
                  {open.has(m.id) && m.kind === "needs-human" && <Reply project={project} agentId={m.from} />}
                  {open.has(m.id) && m.kind === "form" && onOpenAgent && (
                    <button className="btn primary sm" style={{ marginTop: 8 }} onClick={() => onOpenAgent(m.from)}>
                      {t("work.messages.answerIn", { name: from })}
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
  const { t } = useI18n();
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
        placeholder={t("work.messages.reply.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="btn primary sm" onClick={send} disabled={!text.trim() || sending}>
        {t("work.messages.reply")}
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
