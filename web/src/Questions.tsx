import { useCallback, useEffect, useState } from "react";
import { History, ListChecks, MessageCircleQuestion, Send } from "lucide-react";
import { api, subscribe, type Briefing, type Project, type Question } from "./api";
import { AttachButton, PendingFiles, usePendingFiles } from "./Attachments";
import { Md } from "./files";
import { Avatar, timeAgo } from "./ui";
import { useI18n } from "./i18n";

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

/** A project's briefings, kept current (they change with its questions). */
export function useBriefings(projectId: string | undefined): Briefing[] {
  const [briefings, setBriefings] = useState<Briefing[]>([]);
  useEffect(() => {
    if (!projectId) return;
    const load = () => api.briefings(projectId).then(setBriefings).catch(() => {});
    load();
    return subscribe((e) => {
      if (e.type === "questions.updated" && e.projectId === projectId) load();
    });
  }, [projectId]);
  return briefings;
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
  const { t } = useI18n();
  const briefings = useBriefings(project.id);
  const open = questions.filter((q) => q.state === "open");
  // A briefing's questions together under its feature; the others after them.
  const groups = briefings
    .filter((b) => b.state === "open")
    .map((b) => ({ briefing: b, questions: open.filter((q) => q.briefing === b.id) }))
    .filter((g) => g.questions.length);
  const loose = open.filter((q) => !groups.some((g) => g.questions.includes(q)));
  const closed = questions.filter((q) => q.state !== "open").slice(-15).reverse();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => loadDrafts(project.id));
  const [sending, setSending] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const nameOf = (id: string) => project.agents.find((a) => a.id === id)?.name ?? t("work.questions.aHelper");

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
    const note = prompt(t("work.questions.setAside.prompt", { id: q.id, name: nameOf(q.askedBy) }), "");
    if (note === null) return;
    await api.setAsideQuestion(project.id, q.id, note || undefined).catch((e) => alert(e.message));
  }

  /** A decision the team made meanwhile, kept as it is. */
  async function keep(q: Question) {
    try {
      await api.answerQuestions(project.id, [{ id: q.id, answer: q.decided! }]);
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => id !== q.id)));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const card = (q: Question) => (
    <div key={q.id} className={`question-card${q.decided ? " decided" : ""}${drafts[q.id]?.trim() ? " answered" : ""}`}>
      <div className="question-meta">
        <span className="question-id">{q.id}</span>
        <Avatar name={nameOf(q.askedBy)} size="sm" />
        <span className="small">{nameOf(q.askedBy)}</span>
        {q.taskId && <span className="tag">{q.taskId}</span>}
        {q.blocking && (
          <span className="tag amber" title={t("work.questions.blocking.title")}>
            {t("work.questions.blocking")}
          </span>
        )}
        {q.decided && (
          <span className="tag green" title={t("work.questions.decided.title")}>
            {t("work.questions.decided")}
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
      {q.decided && (
        <div className="question-decided">
          <div className="grow">
            <span className="subtle small">{t("work.questions.decidedBy", { name: nameOf(q.askedBy) })}</span>
            <div>{q.decided}</div>
          </div>
          <button className="btn sm" onClick={() => keep(q)}>
            {t("work.questions.keep")}
          </button>
        </div>
      )}
      <textarea rows={2} placeholder={q.decided ? t("work.questions.placeholder.instead") : q.options ? t("work.questions.placeholder.options") : t("work.questions.placeholder.answer")} value={drafts[q.id] ?? ""} onChange={(e) => setDraft(q.id, e.target.value)} />
      <AnswerFiles projectId={project.id} questionId={q.id} onChange={onFiles}>
        <button className="btn ghost sm" onClick={() => setAside(q)}>
          {t("work.questions.setAside")}
        </button>
      </AnswerFiles>
    </div>
  );

  if (open.length === 0 && closed.length === 0) return null;
  return (
    <div className="questions">
      {open.length > 0 && (
        <div className="questions-head">
          <MessageCircleQuestion size={14} />
          <span className="inbox-kind">{t("work.questions.open")}</span>
          <span className="column-count">{open.length}</span>
          <span className="grow" />
          <button className="btn primary sm" onClick={send} disabled={sending || uploading || ready.length === 0} title={uploading ? t("work.questions.uploading") : undefined}>
            <Send size={13} />
            {ready.length > 1 ? t("work.questions.sendN", { n: ready.length }) : t("work.answer.send")}
          </button>
        </div>
      )}
      {groups.map(({ briefing: b, questions: qs }) => (
        <div key={b.id} className="briefing" data-briefing={b.id}>
          <div className="briefing-head">
            <div className="row">
              <ListChecks size={14} />
              <strong className="grow">
                {b.id} · {b.feature}
              </strong>
              <span className="subtle small">
                {t("work.questions.answeredOf", { answered: b.questions.length - qs.length + qs.filter((q) => drafts[q.id]?.trim()).length, total: b.questions.length })}
              </span>
            </div>
            {b.why && <div className="small">{b.why}</div>}
            <div className="hint">{t("work.questions.briefing.hint", { name: nameOf(b.askedBy) })}</div>
          </div>
          {qs.map(card)}
        </div>
      ))}
      {loose.map(card)}
      {closed.length > 0 && (
        <div className="questions-closed">
          <button className="btn ghost sm" onClick={() => setShowClosed((s) => !s)}>
            <History size={13} />
            {showClosed ? t("work.questions.hideAnswered") : t("work.questions.answered", { n: questions.filter((q) => q.state !== "open").length })}
          </button>
          {showClosed &&
            closed.map((q) => (
              <div key={q.id} className="question-closed">
                <span className="question-id">{q.id}</span> {q.question}
                <div className="question-answer">
                  {q.state === "answered" ? `→ ${q.answer}${q.answeredIn === "chat" ? t("work.questions.inChat") : ""}` : t("work.questions.setAside")}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
