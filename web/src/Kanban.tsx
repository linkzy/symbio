import { useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { CheckCircle2, Circle, CircleDashed, ClipboardList, Eye, Link2, Lock, MessageSquare, OctagonAlert } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Agent, type Plan, type Project, type Task, type TaskStatus } from "./api";
import { Avatar, Drawer, EmptyState, clock } from "./ui";

const COLUMNS: { status: TaskStatus; title: string; icon: React.ReactNode }[] = [
  { status: "todo", title: "To do", icon: <Circle size={14} /> },
  { status: "in-progress", title: "In progress", icon: <CircleDashed size={14} /> },
  { status: "blocked", title: "Blocked", icon: <OctagonAlert size={14} /> },
  { status: "review", title: "Review", icon: <Eye size={14} /> },
  { status: "done", title: "Done", icon: <CheckCircle2 size={14} /> },
];

export function Kanban({ project, plan }: { project: Project; plan: Plan | null }) {
  const [openTask, setOpenTask] = useState<string | null>(null);

  if (!plan) return null;
  if (plan.status === "none") {
    return (
      <EmptyState icon={<ClipboardList size={20} />} title="No plan yet">
        core proposes a plan once you've agreed on the scope. It shows up here for your approval, then turns into a live board.
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
            <span>Revision {plan.revision}</span>
          </div>
        </div>
        <div className="progress" title={`${done} of ${plan.tasks.length} tasks done`}>
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
            You asked for changes{plan.feedback ? `: “${plan.feedback}”` : ""}. Waiting for core's revised plan…
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
                  {col.title}
                  <span className="column-count">{tasks.length}</span>
                </div>
                <div className="column-body">
                  <AnimatePresence>
                    {tasks.map((t) => (
                      <TaskCard
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

      <AnimatePresence>{task && <TaskDetail task={task} agent={task.assignee ? agentById.get(task.assignee) : undefined} onClose={() => setOpenTask(null)} />}</AnimatePresence>
    </div>
  );
}

function PlanStatus({ status }: { status: Plan["status"] }) {
  if (status === "proposed") return <span className="tag amber">Awaiting your approval</span>;
  if (status === "changes-requested") return <span className="tag blue">Changes requested</span>;
  if (status === "approved") return <span className="tag green">Approved</span>;
  return null;
}

function TaskCard({ task: t, agent, waitingOn, onOpen }: { task: Task; agent?: Agent; waitingOn: string[]; onOpen: () => void }) {
  return (
    <motion.button
      layout
      layoutId={t.id}
      className={`task-card ts-${t.status}`}
      onClick={onOpen}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      <div className="task-top">
        <span className="task-id">{t.id}</span>
        {waitingOn.length > 0 && t.status === "todo" && (
          <span className="row" style={{ gap: 3 }} title="Waiting on these tasks">
            <Link2 size={11} />
            after {waitingOn.join(", ")}
          </span>
        )}
      </div>
      <div className="task-title">{t.title}</div>
      {t.assets.length > 0 && (
        <div className="task-meta">
          {t.assets.map((a) => (
            <span key={a} className="tag" title="Shared asset">
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
          <span className="subtle">Unassigned</span>
        )}
        {t.notes.length > 0 && (
          <span className="subtle" title={t.notes[t.notes.length - 1].text}>
            <MessageSquare size={11} />
            {t.notes.length}
          </span>
        )}
      </div>
    </motion.button>
  );
}

function TaskDetail({ task: t, agent, onClose }: { task: Task; agent?: Agent; onClose: () => void }) {
  const column = COLUMNS.find((c) => c.status === t.status);
  return (
    <Drawer title={`${t.id} · ${t.title}`} onClose={onClose}>
      <dl className="task-detail-meta">
        <dt>Status</dt>
        <dd>
          {column?.icon}
          {column?.title}
        </dd>
        <dt>Assignee</dt>
        <dd>
          {agent ? (
            <>
              <Avatar name={agent.name} size="sm" />
              {agent.name}
            </>
          ) : (
            <span className="subtle">Unassigned</span>
          )}
        </dd>
        {t.dependsOn.length > 0 && (
          <>
            <dt>Depends on</dt>
            <dd>{t.dependsOn.join(", ")}</dd>
          </>
        )}
        {t.assets.length > 0 && (
          <>
            <dt>Shared assets</dt>
            <dd>
              {t.assets.map((a) => (
                <span key={a} className="tag">
                  <Lock />
                  {a}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
      <div className="md">
        <Markdown remarkPlugins={[remarkGfm]}>{t.description || "_No description._"}</Markdown>
      </div>
      {t.notes.length > 0 && (
        <>
          <h3>History</h3>
          <div className="history">
            {t.notes.map((n, i) => (
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

function ApprovalBar({ project, plan }: { project: Project; plan: Plan }) {
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
          <strong>core proposed this plan ({plan.tasks.length} tasks).</strong> <span className="muted">Nothing starts until you approve it.</span>
        </div>
        {!changing && (
          <>
            <button className="btn sm" onClick={() => setChanging(true)} disabled={busy}>
              Request changes
            </button>
            <button className="btn primary sm" onClick={() => decide(true)} disabled={busy}>
              Approve plan
            </button>
          </>
        )}
      </div>
      {changing && (
        <div className="plan-banner-row">
          <textarea autoFocus rows={2} placeholder="What should change? e.g. “split T2 in two”, “use one helper only”…" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <button className="btn ghost sm" onClick={() => setChanging(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary sm" onClick={() => decide(false)} disabled={busy || !feedback.trim()}>
            Send
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </motion.div>
  );
}
