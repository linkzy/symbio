import { useEffect, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { CheckCircle2, Circle, CircleDashed, ClipboardList, Eye, FileText, Link2, Paperclip, ListChecks, Lock, MessageSquare, OctagonAlert, Pencil } from "lucide-react";
import { api, type Agent, type Plan, type Project, type Task, type TaskStatus } from "./api";
import { useI18n, type MessageKey } from "./i18n";
import { Md } from "./files";
import { Avatar, Drawer, EmptyState, clock, timeAgo } from "./ui";
import { ReviewActions, ReviewGuide, TaskChanges, waitingForReview } from "./Review";
import { TaskChecks, TaskReviews } from "./Checks";
import { useSharedFiles } from "./Attachments";
import { FileCard } from "./files";

const COLUMNS: { status: TaskStatus; title: MessageKey; icon: React.ReactNode }[] = [
  { status: "todo", title: "work.kanban.col.todo", icon: <Circle size={14} /> },
  { status: "in-progress", title: "work.kanban.col.inProgress", icon: <CircleDashed size={14} /> },
  { status: "blocked", title: "work.kanban.col.blocked", icon: <OctagonAlert size={14} /> },
  { status: "review", title: "work.kanban.col.review", icon: <Eye size={14} /> },
  { status: "done", title: "work.kanban.col.done", icon: <CheckCircle2 size={14} /> },
];

export function Kanban({ project, plan }: { project: Project; plan: Plan | null }) {
  const { t } = useI18n();
  const [openTask, setOpenTask] = useState<string | null>(null);

  if (!plan) return null;
  if (plan.status === "none") {
    return (
      <EmptyState icon={<ClipboardList size={20} />} title={t("work.kanban.noPlan.title")}>
        {t("work.kanban.noPlan.body")}
      </EmptyState>
    );
  }

  const agentById = new Map(project.agents.map((a) => [a.id, a]));
  const done = plan.tasks.filter((t) => t.status === "done").length;
  const progress = plan.tasks.length ? done / plan.tasks.length : 0;
  const isDone = (id: string) => plan.tasks.find((t) => t.id === id)?.status === "done";
  const task = plan.tasks.find((t) => t.id === openTask);

  return (
    <div className="kanban">
      <div className="kanban-head">
        <div className="kanban-goal">
          <div className="kanban-goal-text">{plan.goal}</div>
          <div className="kanban-goal-meta">
            <PlanStatus status={plan.status} />
            <span>{t("work.kanban.revision", { n: plan.revision })}</span>
          </div>
        </div>
        <div className="progress" title={t("work.kanban.progress", { done, total: plan.tasks.length })}>
          <span className="tnum">
            {done}/{plan.tasks.length}
          </span>
          <div className="progress-track">
            <motion.div className="progress-fill" animate={{ width: `${progress * 100}%` }} transition={{ type: "spring", stiffness: 80, damping: 18 }} />
          </div>
        </div>
      </div>

      <AnimatePresence>{plan.status === "proposed" && <ApprovalBar project={project} plan={plan} />}</AnimatePresence>
      {plan.status === "changes-requested" && (
        <div className="plan-banner">
          <span className="small muted">
            {plan.feedback ? t("work.kanban.changesAskedWith", { feedback: plan.feedback }) : t("work.kanban.changesAsked")}
          </span>
        </div>
      )}

      <LayoutGroup>
        <div className="columns">
          {COLUMNS.map((col) => {
            const tasks = plan.tasks.filter((t) => t.status === col.status);
            return (
              <div key={col.status} className={`column col-${col.status}`}>
                <div className="column-head">
                  {col.icon}
                  {t(col.title)}
                  <span className="column-count">{tasks.length}</span>
                </div>
                <div className="column-body">
                  <AnimatePresence>
                    {tasks.map((t) => (
                      <TaskCard
                        reviewMarked={project.reviewBy === "marked"}
                        key={t.id}
                        task={t}
                        agent={t.assignee ? agentById.get(t.assignee) : undefined}
                        waitingOn={t.dependsOn.filter((d) => !isDone(d))}
                        onOpen={() => setOpenTask(t.id)}
                      />
                    ))}
                  </AnimatePresence>
                  {tasks.length === 0 && <div className="column-empty">—</div>}
                </div>
              </div>
            );
          })}
        </div>
      </LayoutGroup>

      <AnimatePresence>
        {task && <TaskDetail project={project} task={task} agent={task.assignee ? agentById.get(task.assignee) : undefined} onClose={() => setOpenTask(null)} />}
      </AnimatePresence>
    </div>
  );
}

function PlanStatus({ status }: { status: Plan["status"] }) {
  const { t } = useI18n();
  if (status === "proposed") return <span className="tag amber">{t("work.plan.status.proposed")}</span>;
  if (status === "changes-requested") return <span className="tag blue">{t("work.plan.status.changesRequested")}</span>;
  if (status === "approved") return <span className="tag green">{t("work.plan.status.approved")}</span>;
  return null;
}

function TaskCard({ task, agent, waitingOn, onOpen, reviewMarked }: { task: Task; agent?: Agent; waitingOn: string[]; onOpen: () => void; reviewMarked?: boolean }) {
  const { t } = useI18n();
  return (
    <motion.button
      layout
      layoutId={task.id}
      className={`task-card ts-${task.status}`}
      onClick={onOpen}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      <div className="task-top">
        <span className="task-id">{task.id}</span>
        {waitingForReview(task) && <span className="tag amber">{t("work.task.waitingForYou")}</span>}
        {reviewMarked && task.review && !waitingForReview(task) && task.status !== "done" && <span className="tag blue">{t("work.task.youReview")}</span>}
        {waitingOn.length > 0 && task.status === "todo" && (
          <span className="row" style={{ gap: 3 }} title={t("work.task.waitingOn")}>
            <Link2 size={11} />
            {t("work.task.after", { ids: waitingOn.join(", ") })}
          </span>
        )}
      </div>
      <div className="task-title">{task.title}</div>
      {task.assets.length > 0 && (
        <div className="task-meta">
          {task.assets.map((a) => (
            <span key={a} className="tag" title={t("work.task.sharedAsset")}>
              <Lock />
              {a}
            </span>
          ))}
        </div>
      )}
      <div className="task-bottom">
        {agent ? (
          <>
            <Avatar name={agent.name} size="sm" status={agent.status === "busy" ? "busy" : undefined} />
            <span className="ellipsis">{agent.name}</span>
          </>
        ) : (
          <span className="subtle">{t("work.task.unassigned")}</span>
        )}
        {task.doneWhen && (
          <span className="subtle task-done-when" title={t("work.task.doneWhenTitle", { text: task.doneWhen })}>
            <ListChecks size={11} />
          </span>
        )}
        {task.notes.length > 0 && (
          <span className="subtle" title={task.notes[task.notes.length - 1].text}>
            <MessageSquare size={11} />
            {task.notes.length}
          </span>
        )}
      </div>
    </motion.button>
  );
}

function TaskDetail({ project, task, agent, onClose }: { project: Project; task: Task; agent?: Agent; onClose: () => void }) {
  const projectId = project.id;
  const marking = project.reviewBy === "marked" && task.status !== "done" && !waitingForReview(task);
  const column = COLUMNS.find((c) => c.status === task.status);
  const { t } = useI18n();
  return (
    <Drawer title={`${task.id} · ${task.title}`} onClose={onClose}>
      <dl className="task-detail-meta">
        <dt>{t("work.task.status")}</dt>
        <dd>
          {column?.icon}
          {column && t(column.title)}
        </dd>
        <dt>{t("work.task.assignee")}</dt>
        <dd>
          {agent ? (
            <>
              <Avatar name={agent.name} size="sm" />
              {agent.name}
            </>
          ) : (
            <span className="subtle">{t("work.task.unassigned")}</span>
          )}
        </dd>
        {task.dependsOn.length > 0 && (
          <>
            <dt>{t("work.task.dependsOn")}</dt>
            <dd>{task.dependsOn.join(", ")}</dd>
          </>
        )}
        {task.assets.length > 0 && (
          <>
            <dt>{t("work.task.sharedAssets")}</dt>
            <dd>
              {task.assets.map((a) => (
                <span key={a} className="tag">
                  <Lock />
                  {a}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
      {waitingForReview(task) && (
        <div className="review-box">
          <div className="review-box-head">{t("work.task.waitingForReview")}</div>
          <ReviewGuide guide={task.guide} projectId={projectId} agentId={task.assignee} />
          <ReviewActions projectId={projectId} task={task} onDone={onClose} />
        </div>
      )}
      {marking && <ReviewMark projectId={projectId} task={task} />}
      <div className="md">
        <Md text={task.description || t("work.task.noDescription")} projectId={projectId} agentId={task.assignee} className="" />
      </div>
      {task.spec && (
        <div className="task-spec">
          <FileText size={14} />
          <Md text={t("work.task.spec", { spec: task.spec })} projectId={projectId} agentId={task.assignee} className="" />
        </div>
      )}
      <DoneWhen projectId={projectId} task={task} />
      <TaskEvidence project={project} taskId={task.id} />
      {task.checks && <TaskChecks run={task.checks} />}
      <TaskReviews task={task} reviewerName={task.reviewer ? project.agents.find((a) => a.id === task.reviewer)?.name : undefined} />
      {(task.status === "review" || task.status === "done" || task.guide) && <TaskChanges projectId={projectId} taskId={task.id} />}
      {!waitingForReview(task) && task.guide && (
        <>
          <h3>{t("work.review.howToCheck")}</h3>
          <ReviewGuide guide={task.guide} projectId={projectId} agentId={task.assignee} />
        </>
      )}
      {task.notes.length > 0 && (
        <>
          <h3>{t("work.task.history")}</h3>
          <div className="history">
            {task.notes.map((n, i) => (
              <div key={i} className="history-item">
                <span className="when">{clock(n.time)}</span>
                <span className="what">
                  <strong>{n.by}</strong> {n.text}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Drawer>
  );
}

/** A task's evidence: the files its helper shared as showing the work was done. */
function TaskEvidence({ project, taskId }: { project: Project; taskId: string }) {
  const { t } = useI18n();
  const files = useSharedFiles(project.id).filter((f) => f.taskId === taskId && f.tag === "evidence");
  if (!files.length) return null;
  return (
    <div className="task-evidence">
      <h3>
        <Paperclip size={14} /> {t("work.task.evidence")}
      </h3>
      <div className="shared-files">
        {files.map((f) => (
          <FileCard key={f.id} projectId={project.id} agentId={f.agentId} path={f.rel} caption={[timeAgo(f.at), f.caption].filter(Boolean).join(" · ")} />
        ))}
      </div>
    </div>
  );
}

function ApprovalBar({ project, plan }: { project: Project; plan: Plan }) {
  const { t } = useI18n();
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approved: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.decidePlan(project.id, approved, feedback.trim() || undefined);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <motion.div className="plan-banner" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="plan-banner-row">
        <ClipboardList size={16} style={{ color: "var(--amber)" }} />
        <div className="grow">
          <strong>{t("work.plan.proposed", { n: plan.tasks.length })}</strong> <span className="muted">{t("work.plan.nothingStarts")}</span>
        </div>
        {!changing && (
          <>
            <button className="btn sm" onClick={() => setChanging(true)} disabled={busy}>
              {t("work.plan.requestChanges")}
            </button>
            <button className="btn primary sm" onClick={() => decide(true)} disabled={busy}>
              {t("work.plan.approve")}
            </button>
          </>
        )}
      </div>
      {changing && (
        <div className="plan-banner-row">
          <textarea autoFocus rows={2} placeholder={t("work.plan.feedback.placeholder")} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <button className="btn ghost sm" onClick={() => setChanging(false)} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn primary sm" onClick={() => decide(false)} disabled={busy || !feedback.trim()}>
            {t("common.send")}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </motion.div>
  );
}

/** Done when as written, one check per line: shown as a list unless it's already Markdown. */
const checklist = (text: string) =>
  /^\s*([-*+]|\d+[.)])\s/m.test(text)
    ? text
    : text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `- ${l.trim()}`)
        .join("\n");

/** A task's Done when: how its work will be judged finished. The human can change it while the task isn't done. */
function DoneWhen({ projectId, task }: { projectId: string; task: Task }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.doneWhen ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) setText(task.doneWhen ?? "");
  }, [task.doneWhen, editing]);
  const editable = task.status !== "done";
  async function save() {
    setBusy(true);
    try {
      await api.setDoneWhen(projectId, task.id, text);
      setEditing(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="done-when">
      <div className="done-when-head">
        <h3>
          <ListChecks size={14} /> {t("work.task.doneWhen")}
        </h3>
        {editable && !editing && (
          <button className="btn ghost sm" onClick={() => setEditing(true)}>
            <Pencil size={12} /> {task.doneWhen ? t("common.edit") : t("common.add")}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            autoFocus
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("work.task.doneWhen.placeholder")}
          />
          <div className="row" style={{ justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
            <button className="btn ghost sm" onClick={() => setEditing(false)} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button className="btn primary sm" onClick={save} disabled={busy}>
              {t("common.save")}
            </button>
          </div>
        </>
      ) : task.doneWhen ? (
        <Md text={checklist(task.doneWhen)} projectId={projectId} agentId={task.assignee} />
      ) : (
        <p className="subtle small">{t("work.task.doneWhen.notSet")}</p>
      )}
    </div>
  );
}

/** "I review this task" (Project.reviewBy "marked"): shows the new state at once, then the plan confirms it. */
function ReviewMark({ projectId, task }: { projectId: string; task: Task }) {
  const { t } = useI18n();
  const [checked, setChecked] = useState(!!task.review);
  useEffect(() => setChecked(!!task.review), [task.review]);
  return (
    <label className="check review-mark">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          const next = e.target.checked;
          setChecked(next);
          api.markTask(projectId, task.id, next).catch((err) => {
            setChecked(!next);
            alert(err.message);
          });
        }}
      />
      {t("work.task.reviewMark")}
    </label>
  );
}
