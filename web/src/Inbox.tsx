import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCheck, CircleAlert, ClipboardList, KeyRound, MessageCircleQuestion, Plug, ShieldQuestion, ListChecks, Timer } from "lucide-react";
import { api, subscribe, type Approval, type LoggedMessage, type PermissionRequest, type Plan, type Project, type Question, type Task } from "./api";
import { Md } from "./files";
import { OpenQuestions, useQuestions } from "./Questions";
import { openQuestions } from "./Messages";
import { AgentForms } from "./FormCard";
import { ReviewActions, ReviewGuide, TaskChanges, waitingForReview } from "./Review";
import { Avatar, Drawer, timeAgo, waitsForPinnedModel } from "./ui";
import { JobApproval, useJobs } from "./Jobs";
import { showProjectSettings } from "./SettingsTabs";
import type { Job } from "./api";
import { CalendarClock } from "lucide-react";
import { useI18n, type MessageKey } from "./i18n";

export interface InboxData {
  approvals: Approval[];
  permissions: PermissionRequest[];
  questions: LoggedMessage[];
  /** Finished tasks waiting for the human's review. */
  toReview: Task[];
  /** The team's questions (open ones wait for an answer; the rest are the record). */
  teamQuestions: Question[];
  /** Scheduled jobs core proposed, waiting for the human's approval. */
  jobs: Job[];
  count: number;
}

/** Everything in a project that waits on the human. */
export function useInbox(project: Project | null, log: LoggedMessage[] | null, plan: Plan | null): InboxData {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const id = project?.id;

  useEffect(() => {
    if (!id) return;
    const load = () => {
      api
        .approvals(id)
        .then((a) => setApprovals(a.filter((x) => x.status === "pending")))
        .catch(() => {});
      api
        .permissions(id)
        .then(setPermissions)
        .catch(() => {});
    };
    load();
    return subscribe((e) => {
      if (e.type === "approvals.updated" && e.projectId === id) load();
    });
  }, [id]);

  const questions = openQuestions(log ?? []);
  const teamQuestions = useQuestions(id);
  const openCount = teamQuestions.filter((q) => q.state === "open").length;
  const stuck = project?.agents.filter((a) => a.problem && a.status !== "stopped" && !waitsForPinnedModel(a)).length ?? 0;
  const planWaiting = plan?.status === "proposed" ? 1 : 0;
  const toReview = plan?.tasks.filter(waitingForReview) ?? [];
  const jobs = useJobs(id).filter((j) => j.state === "proposed");
  return {
    jobs,
    approvals,
    permissions,
    questions,
    toReview,
    teamQuestions,
    count: approvals.length + permissions.length + questions.length + stuck + planWaiting + toReview.length + openCount + jobs.length,
  };
}

export function InboxDrawer({
  project,
  plan,
  data,
  onClose,
  onOpenAgent,
  onOpenTab,
}: {
  project: Project;
  plan: Plan | null;
  data: InboxData;
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
  onOpenTab: (tab: "plan" | "settings") => void;
}) {
  const { t } = useI18n();
  const stuck = project.agents.filter((a) => a.problem && a.status !== "stopped" && !waitsForPinnedModel(a));
  const nameOf = (id: string) => project.agents.find((a) => a.id === id)?.name ?? id;

  return (
    <Drawer title={t("project.needsYou")} onClose={onClose}>
      {data.count === 0 && <div className="inbox-empty">{t("work.inbox.empty")}</div>}
      <AnimatePresence initial={false}>
        {stuck.length > 0 && (
          <Item key="stuck" icon={<CircleAlert size={14} style={{ color: "var(--red)" }} />} kind={t("work.inbox.stuck")}>
            <div className="small">
              <strong>{stuck.map((a) => a.name).join(", ")}</strong>{t("work.inbox.stuck.after")}
            </div>
            <div className="inbox-reason">{stuck[0].problem}</div>
            <div className="inbox-actions">
              <button
                className="btn primary sm"
                onClick={() => {
                  showProjectSettings(project.id, "team");
                  onOpenTab("settings");
                }}
              >
                {t("work.inbox.addModel")}
              </button>
              <button className="btn sm" onClick={() => api.retryModels(project.id).catch((e) => alert(e.message))}>
                {t("common.retryNow")}
              </button>
            </div>
          </Item>
        )}

        {plan?.status === "proposed" && (
          <Item key="plan" icon={<ClipboardList size={14} />} kind={t("work.inbox.plan")}>
            <div className="small">
              {t("work.inbox.plan.before")}<strong>{t("work.inbox.plan.tasks", { n: plan.tasks.length })}</strong>{t("work.inbox.plan.after")}
            </div>
            <div className="inbox-actions">
              <button className="btn primary sm" onClick={() => onOpenTab("plan")}>
                {t("work.inbox.reviewPlan")}
              </button>
            </div>
          </Item>
        )}

        <OpenQuestions key="team-questions" project={project} questions={data.teamQuestions} />

        {data.jobs.map((j) => (
          <Item key={`job-${j.id}`} icon={<CalendarClock size={14} />} kind={t("work.inbox.job")} time={j.createdAt}>
            <div className="small">
              <strong>{j.id}</strong> {j.title} · {j.when}
            </div>
            <div className="inbox-reason">{j.instructions}</div>
            <div className="inbox-actions">
              <JobApproval project={project} job={j} />
            </div>
          </Item>
        ))}

        {data.toReview.map((task) => (
          <Item key={`review-${task.id}`} icon={<ListChecks size={14} />} kind={t("work.inbox.toReview")} agent={task.assignee ? nameOf(task.assignee) : undefined} time={task.humanReview?.at}>
            <div className="small">
              <strong>{task.id}</strong> {task.title}
            </div>
            <ReviewGuide guide={task.guide} projectId={project.id} agentId={task.assignee} />
            <TaskChanges projectId={project.id} taskId={task.id} />
            <ReviewActions projectId={project.id} task={task} />
          </Item>
        ))}

        {data.approvals.length > 1 && (
          <div key="approve-all" className="inbox-approve-all">
            <span className="small subtle">{t("work.inbox.approvalsWaiting", { n: data.approvals.length })}</span>
            <button
              className="btn sm"
              onClick={() => {
                if (confirm(t("work.inbox.approveAll.confirm", { n: data.approvals.length }))) {
                  api.approveAll(project.id).catch((e) => alert(e.message));
                }
              }}
            >
              <CheckCheck size={13} />
              {t("work.inbox.approveAll")}
            </button>
          </div>
        )}
        {data.approvals.map((a) => (
          <ApprovalItem key={a.id} project={project} approval={a} />
        ))}

        {data.permissions.map((p) => (
          <PermissionItem key={p.id} project={project} request={p} />
        ))}

        {data.questions.map((q) =>
          q.kind === "form" ? (
            <Item key={q.id} icon={<MessageCircleQuestion size={14} />} kind={t("work.inbox.question")} agent={nameOf(q.from)} time={q.time}>
              {/* The question itself, to answer right here. */}
              {project.agents.some((a) => a.id === q.from) ? (
                <AgentForms
                  project={project}
                  agent={project.agents.find((a) => a.id === q.from)!}
                  fallback={
                    <>
                      <div className="small">{t("work.inbox.isAsking", { name: nameOf(q.from) })}</div>
                      <div className="inbox-actions">
                        <button className="btn primary sm" onClick={() => onOpenAgent(q.from)}>
                          {t("work.inbox.answerInChat")}
                        </button>
                      </div>
                    </>
                  }
                />
              ) : null}
            </Item>
          ) : (
            <QuestionItem key={q.id} project={project} question={q} agentName={nameOf(q.from)} />
          ),
        )}
      </AnimatePresence>
    </Drawer>
  );
}

function Item({
  icon,
  kind,
  agent,
  time,
  children,
}: {
  icon: React.ReactNode;
  kind: string;
  agent?: string;
  time?: number;
  children: React.ReactNode;
}) {
  return (
    <motion.div className="inbox-item" layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, padding: 0, margin: 0 }}>
      <div className="inbox-item-head">
        {agent ? <Avatar name={agent} size="sm" /> : icon}
        <span className="inbox-kind">{kind}</span>
        {agent && <span className="small">· {agent}</span>}
        {time && <span className="when">{timeAgo(time)}</span>}
      </div>
      {children}
    </motion.div>
  );
}

// The same checks as the server's (remote.ts): a plain command, and the pattern offered for it.
const SHELL_SPECIAL = /[;&|`$<>\r\n(){}\\]/;
function suggestPattern(command: string): string | null {
  const c = command.trim();
  if (!c || SHELL_SPECIAL.test(c)) return null;
  const words = c.split(/\s+/);
  if (words.length === 1) return words[0];
  return /^[a-z][\w.-]*$/i.test(words[1]) ? `${words[0]} ${words[1]} *` : `${words[0]} *`;
}

const ALLOW_FOR: { value: string; label: MessageKey }[] = [
  { value: "30", label: "work.inbox.allowFor.30" },
  { value: "60", label: "work.inbox.allowFor.60" },
  { value: "240", label: "work.inbox.allowFor.240" },
  { value: "stop", label: "work.inbox.allowFor.stop" },
];

function ApprovalItem({ project, approval: a }: { project: Project; approval: Approval }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [allowFor, setAllowFor] = useState("60");
  const command = typeof a.action.command === "string" ? a.action.command : null;
  const suggestion = a.action.kind === "remote_exec" && a.connectionType === "server" && command ? suggestPattern(command) : null;
  const [pattern, setPattern] = useState(suggestion ?? "");
  async function decide(approved: boolean, widen?: { allowFor?: number | null; always?: string }) {
    setBusy(true);
    try {
      await api.decideApproval(project.id, a.id, approved, note.trim() || undefined, widen);
    } catch (e) {
      alert((e as Error).message);
      setBusy(false);
    }
  }
  const body = a.action.kind === "github_api" && a.action.body !== undefined ? JSON.stringify(a.action.body, null, 2) : null;
  return (
    <Item icon={<Plug size={14} />} kind={t("work.inbox.use", { name: a.connectionName })} agent={a.agentName} time={a.createdAt}>
      <div className="small">{t("work.inbox.wantsTo", { what: a.summary })}</div>
      {command && <pre className="command">{command}</pre>}
      {body && <pre className="command">{body}</pre>}
      <div className="inbox-reason">{t("work.inbox.why", { reason: a.reason })}</div>
      <input placeholder={t("work.inbox.note.placeholder")} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="inbox-actions">
        <button className="btn primary sm" onClick={() => decide(true)} disabled={busy}>
          {t("common.approve")}
        </button>
        <button className="btn danger sm" onClick={() => decide(false)} disabled={busy}>
          {t("common.deny")}
        </button>
      </div>
      <div className="inbox-widen">
        <button
          className="btn sm"
          disabled={busy}
          onClick={() => decide(true, { allowFor: allowFor === "stop" ? null : Number(allowFor) })}
          title={t("work.inbox.allowFor.title", { agent: a.agentName, connection: a.connectionName })}
        >
          <Timer size={13} />
          {t("work.inbox.allowFor", { agent: a.agentName, connection: a.connectionName })}
        </button>
        <select value={allowFor} onChange={(e) => setAllowFor(e.target.value)} disabled={busy} aria-label={t("work.inbox.allowFor.label")}>
          {ALLOW_FOR.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.label)}
            </option>
          ))}
        </select>
      </div>
      {suggestion && (
        <div className="inbox-widen">
          <button
            className="btn sm"
            disabled={busy || !pattern.trim()}
            onClick={() => decide(true, { always: pattern })}
            title={t("work.inbox.always.title", { connection: a.connectionName })}
          >
            <KeyRound size={13} />
            {t("work.inbox.always")}
          </button>
          <input className="inbox-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label={t("work.inbox.always.label")} disabled={busy} />
        </div>
      )}
    </Item>
  );
}

function PermissionItem({ project, request: r }: { project: Project; request: PermissionRequest }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function answer(decision: "once" | "always" | "reject") {
    setBusy(true);
    await api.answerPermission(project.id, r.id, decision, note.trim() || undefined).catch((e) => alert(e.message));
  }
  const verb = r.action === "shell" ? t("work.inbox.perm.shell") : r.action === "read" ? t("work.inbox.perm.read") : r.action === "edit" ? t("work.inbox.perm.edit") : r.action;
  return (
    <Item icon={<ShieldQuestion size={14} />} kind={t("work.inbox.permission")} agent={r.agentName} time={r.time}>
      <div className="small">{t("work.inbox.wantsToColon", { what: verb })}</div>
      <pre className="command">{r.resources.join("\n")}</pre>
      <input placeholder={t("work.inbox.note.placeholder")} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="inbox-actions">
        <button className="btn primary sm" onClick={() => answer("once")} disabled={busy}>
          {t("work.inbox.allowOnce")}
        </button>
        {r.save.length > 0 && (
          <button className="btn sm" onClick={() => answer("always")} disabled={busy} title={t("work.inbox.remembered")}>
            <KeyRound size={13} />
            {t("work.inbox.alwaysAllow")} <code>{r.save.join(", ")}</code>
          </button>
        )}
        <button className="btn danger sm" onClick={() => answer("reject")} disabled={busy}>
          {t("common.deny")}
        </button>
      </div>
    </Item>
  );
}

function QuestionItem({ project, question: q, agentName }: { project: Project; question: LoggedMessage; agentName: string }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  async function send() {
    if (!text.trim()) return;
    setSending(true);
    await api.send(project.id, q.from, text.trim()).catch((e) => alert(e.message));
    setSending(false);
    setText("");
  }
  return (
    <Item icon={<MessageCircleQuestion size={14} />} kind={t("work.inbox.question")} agent={agentName} time={q.time}>
      <div className="md small">
        <Md text={q.text} projectId={project.id} agentId={q.from} className="" />
      </div>
      <textarea
        rows={2}
        placeholder={t("work.inbox.answerName", { name: agentName })}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="inbox-actions">
        <button className="btn primary sm" onClick={send} disabled={!text.trim() || sending}>
          {t("work.answer.send")}
        </button>
      </div>
    </Item>
  );
}
