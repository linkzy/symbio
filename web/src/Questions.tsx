import { useEffect, useState } from "react";
import { History, MessageCircleQuestion, Send } from "lucide-react";
import { api, subscribe, type Project, type Question } from "./api";
import { Md } from "./files";
import { Avatar, timeAgo } from "./ui";

// The team's open questions for the human (Needs you): kept in Symbio instead of the chat, where
// they scrolled away. Answer several and send them together; each agent that asked gets its
// answers in one message.

/** All of a project's questions, kept current. */
export function useQuestions(projectId: string | undefined): Question[] {
  const [questions, setQuestions] = useState<Question[]>([]);
  useEffect(() => {
    if (!projectId) return;
    const load = () => api.questions(projectId).then(setQuestions).catch(() => {});
    load();
    return subscribe((e) => {
      if (e.type === "questions.updated" && e.projectId === projectId) load();
    });
  }, [projectId]);
  return questions;
}

/** Drafts survive closing the drawer (and a reload), until sent. */
const draftKey = (projectId: string) => `symbio:answers:${projectId}`;
function loadDrafts(projectId: string): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey(projectId)) ?? "{}");
  } catch {
    return {};
  }
}

export function OpenQuestions({ project, questions }: { project: Project; questions: Question[] }) {
  const open = questions.filter((q) => q.state === "open");
  const closed = questions.filter((q) => q.state !== "open").slice(-15).reverse();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => loadDrafts(project.id));
  const [sending, setSending] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const nameOf = (id: string) => project.agents.find((a) => a.id === id)?.name ?? "a helper";

  useEffect(() => {
    sessionStorage.setItem(draftKey(project.id), JSON.stringify(drafts));
  }, [project.id, drafts]);

  const ready = open.filter((q) => drafts[q.id]?.trim());
  const setDraft = (id: string, text: string) => setDrafts((d) => ({ ...d, [id]: text }));

  async function send() {
    setSending(true);
    try {
      await api.answerQuestions(
        project.id,
        ready.map((q) => ({ id: q.id, answer: drafts[q.id].trim() })),
      );
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !ready.some((q) => q.id === id))));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function setAside(q: Question) {
    const note = prompt(`Set aside ${q.id}? It won't be asked again. A note for ${nameOf(q.askedBy)} (optional):`, "");
    if (note === null) return;
    await api.setAsideQuestion(project.id, q.id, note || undefined).catch((e) => alert(e.message));
  }

  if (open.length === 0 && closed.length === 0) return null;
  return (
    <div className="questions">
      {open.length > 0 && (
        <div className="questions-head">
          <MessageCircleQuestion size={14} />
          <span className="inbox-kind">Open questions</span>
          <span className="column-count">{open.length}</span>
          <span className="grow" />
          <button className="btn primary sm" onClick={send} disabled={sending || ready.length === 0}>
            <Send size={13} />
            {ready.length > 1 ? `Send ${ready.length} answers` : "Send answer"}
          </button>
        </div>
      )}
      {open.map((q) => (
        <div key={q.id} className={`question-card${drafts[q.id]?.trim() ? " answered" : ""}`}>
          <div className="question-meta">
            <span className="question-id">{q.id}</span>
            <Avatar name={nameOf(q.askedBy)} size="sm" />
            <span className="small">{nameOf(q.askedBy)}</span>
            {q.taskId && <span className="tag">{q.taskId}</span>}
            {q.blocking && (
              <span className="tag amber" title="Work waits on this answer">
                Blocking
              </span>
            )}
            <span className="when">{timeAgo(q.askedAt)}</span>
          </div>
          <div className="question-text">{q.question}</div>
          {q.context && (
            <div className="question-context md">
              <Md text={q.context} projectId={project.id} agentId={q.askedBy} className="" />
            </div>
          )}
          {q.options && (
            <div className="question-options">
              {q.options.map((o) => (
                <button key={o} className={`chip${drafts[q.id] === o ? " on" : ""}`} onClick={() => setDraft(q.id, drafts[q.id] === o ? "" : o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <textarea rows={2} placeholder={q.options ? "Pick an option, or write your answer" : "Your answer"} value={drafts[q.id] ?? ""} onChange={(e) => setDraft(q.id, e.target.value)} />
          <div className="question-actions">
            <button className="btn ghost sm" onClick={() => setAside(q)}>
              Set aside
            </button>
          </div>
        </div>
      ))}
      {closed.length > 0 && (
        <div className="questions-closed">
          <button className="btn ghost sm" onClick={() => setShowClosed((s) => !s)}>
            <History size={13} />
            {showClosed ? "Hide answered questions" : `Answered questions (${questions.filter((q) => q.state !== "open").length})`}
          </button>
          {showClosed &&
            closed.map((q) => (
              <div key={q.id} className="question-closed">
                <span className="question-id">{q.id}</span> {q.question}
                <div className="question-answer">
                  {q.state === "answered" ? `→ ${q.answer}${q.answeredIn === "chat" ? " (in the chat)" : ""}` : "Set aside"}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
