import { useCallback, useEffect, useState } from "react";
import { History, MessageCircleQuestion, Send } from "lucide-react";
import { api, subscribe, type Project, type Question } from "./api";
import { AttachButton, PendingFiles, usePendingFiles } from "./Attachments";
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

const answerFilesKey = (projectId: string, questionId: string) => `symbio:answer-files:${projectId}:${questionId}`;

/** The files going with one answer: the paperclip, the chips, and what's ready reported up. */
function AnswerFiles(props: {
  projectId: string;
  questionId: string;
  onChange: (id: string, ids: string[], uploading: boolean) => void;
  children: React.ReactNode;
}) {
  const { projectId, questionId, onChange, children } = props;
  const pending = usePendingFiles(projectId, answerFilesKey(projectId, questionId));
  const ids = pending.ready.join(",");
  useEffect(() => onChange(questionId, ids ? ids.split(",") : [], pending.uploading), [questionId, ids, pending.uploading, onChange]);
  return (
    <>
      <PendingFiles projectId={projectId} files={pending.files} onRemove={pending.remove} />
      <div className="question-actions">
        <AttachButton onFiles={pending.add} />
        <span className="grow" />
        {children}
      </div>
    </>
  );
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

  // Files attached to each answer (uploaded as they're added, like in the chat).
  const [files, setFiles] = useState<Record<string, { ids: string[]; uploading: boolean }>>({});
  const onFiles = useCallback((id: string, ids: string[], uploading: boolean) => setFiles((f) => ({ ...f, [id]: { ids, uploading } })), []);
  const ready = open.filter((q) => drafts[q.id]?.trim() || files[q.id]?.ids.length);
  const uploading = open.some((q) => files[q.id]?.uploading);
  const setDraft = (id: string, text: string) => setDrafts((d) => ({ ...d, [id]: text }));

  async function send() {
    setSending(true);
    try {
      await api.answerQuestions(
        project.id,
        ready.map((q) => ({ id: q.id, answer: (drafts[q.id] ?? "").trim(), attachments: files[q.id]?.ids ?? [] })),
      );
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !ready.some((q) => q.id === id))));
      for (const q of ready) localStorage.removeItem(answerFilesKey(project.id, q.id));
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
          <button className="btn primary sm" onClick={send} disabled={sending || uploading || ready.length === 0} title={uploading ? "Waiting for files to upload" : undefined}>
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
          <AnswerFiles projectId={project.id} questionId={q.id} onChange={onFiles}>
            <button className="btn ghost sm" onClick={() => setAside(q)}>
              Set aside
            </button>
          </AnswerFiles>
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
