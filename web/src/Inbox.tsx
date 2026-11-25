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
  const stuck = project.agents.filter((a) => a.problem && a.status !== "stopped" && !waitsForPinnedModel(a));
  const nameOf = (id: string) => project.agents.find((a) => a.id === id)?.name ?? id;

  return (
    <Drawer title="Needs you" onClose={onClose}>
      {data.count === 0 && <div className="inbox-empty">Nothing is waiting for you.</div>}
      <AnimatePresence initial={false}>
        {stuck.length > 0 && (
          <Item key="stuck" icon={<CircleAlert size={14} style={{ color: "var(--red)" }} />} kind="Agents stuck">
            <div className="small">
              <strong>{stuck.map((a) => a.name).join(", ")}</strong> can't continue — every allowed model failed.
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
                Add a model
              </button>
              <button className="btn sm" onClick={() => api.retryModels(project.id).catch((e) => alert(e.message))}>
                Retry now
              </button>
            </div>
          </Item>
        )}

        {plan?.status === "proposed" && (
          <Item key="plan" icon={<ClipboardList size={14} />} kind="Plan to review">
            <div className="small">
              core proposed a plan with <strong>{plan.tasks.length} tasks</strong>. Nothing starts until you approve it.
            </div>
            <div className="inbox-actions">
              <button className="btn primary sm" onClick={() => onOpenTab("plan")}>
                Review plan
              </button>
            </div>
          </Item>
        )}

        <OpenQuestions key="team-questions" project={project} questions={data.teamQuestions} />

        {data.jobs.map((j) => (
          <Item key={`job-${j.id}`} icon={<CalendarClock size={14} />} kind="Scheduled job to approve" time={j.createdAt}>
            <div className="small">
              <strong>{j.id}</strong> {j.title} · {j.when}
            </div>
            <div className="inbox-reason">{j.instructions}</div>
            <div className="inbox-actions">
              <JobApproval project={project} job={j} />
            </div>
          </Item>
        ))}

        {data.toReview.map((t) => (
          <Item key={`review-${t.id}`} icon={<ListChecks size={14} />} kind="To review" agent={t.assignee ? nameOf(t.assignee) : undefined} time={t.humanReview?.at}>
            <div className="small">
              <strong>{t.id}</strong> {t.title}
            </div>
            <ReviewGuide guide={t.guide} projectId={project.id} agentId={t.assignee} />
            <TaskChanges projectId={project.id} taskId={t.id} />
            <ReviewActions projectId={project.id} task={t} />
          </Item>
        ))}

        {data.approvals.length > 1 && (
          <div key="approve-all" className="inbox-approve-all">
            <span className="small subtle">{data.approvals.length} requests to use connections are waiting.</span>
            <button
              className="btn sm"
              onClick={() => {
                if (confirm(`Approve all ${data.approvals.length} requests? Each runs, and its result goes to the agent that asked.`)) {
                  api.approveAll(project.id).catch((e) => alert(e.message));
                }
              }}
            >
              <CheckCheck size={13} />
              Approve all
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
            <Item key={q.id} icon={<MessageCircleQuestion size={14} />} kind="Question" agent={nameOf(q.from)} time={q.time}>
              {/* The question itself, to answer right here. */}
              {project.agents.some((a) => a.id === q.from) ? (
                <AgentForms
                  project={project}
                  agent={project.agents.find((a) => a.id === q.from)!}
                  fallback={
                    <>
                      <div className="small">{nameOf(q.from)} is asking you a question.</div>
                      <div className="inbox-actions">
                        <button className="btn primary sm" onClick={() => onOpenAgent(q.from)}>
                          Answer in chat
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

const ALLOW_FOR = [
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "stop", label: "until I stop it" },
];

function ApprovalItem({ project, approval: a }: { project: Project; approval: Approval }) {
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
    <Item icon={<Plug size={14} />} kind={`Use ${a.connectionName}`} agent={a.agentName} time={a.createdAt}>
      <div className="small">Wants to {a.summary}</div>
      {command && <pre className="command">{command}</pre>}
      {body && <pre className="command">{body}</pre>}
      <div className="inbox-reason">Why: {a.reason}</div>
      <input placeholder="Note for the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="inbox-actions">
        <button className="btn primary sm" onClick={() => decide(true)} disabled={busy}>
          Approve
        </button>
        <button className="btn danger sm" onClick={() => decide(false)} disabled={busy}>
          Deny
        </button>
      </div>
      <div className="inbox-widen">
        <button
          className="btn sm"
          disabled={busy}
          onClick={() => decide(true, { allowFor: allowFor === "stop" ? null : Number(allowFor) })}
          title={`Approve this, and let ${a.agentName} use ${a.connectionName} without asking for a while (pausing the team ends it)`}
        >
          <Timer size={13} />
          Approve, and allow {a.agentName} on {a.connectionName} for
        </button>
        <select value={allowFor} onChange={(e) => setAllowFor(e.target.value)} disabled={busy} aria-label="For how long">
          {ALLOW_FOR.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
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
            title={`Approve this, and run commands like it on ${a.connectionName} without asking, from now on (* stands for anything; chained commands still ask)`}
          >
            <KeyRound size={13} />
            Approve, and always allow
          </button>
          <input className="inbox-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Commands to always allow" disabled={busy} />
        </div>
      )}
    </Item>
  );
}

function PermissionItem({ project, request: r }: { project: Project; request: PermissionRequest }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function answer(decision: "once" | "always" | "reject") {
    setBusy(true);
    await api.answerPermission(project.id, r.id, decision, note.trim() || undefined).catch((e) => alert(e.message));
  }
  const verb = r.action === "shell" ? "run a command" : r.action === "read" ? "read a file" : r.action === "edit" ? "change a file" : r.action;
  return (
    <Item icon={<ShieldQuestion size={14} />} kind="Permission" agent={r.agentName} time={r.time}>
      <div className="small">Wants to {verb}:</div>
      <pre className="command">{r.resources.join("\n")}</pre>
      <input placeholder="Note for the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="inbox-actions">
        <button className="btn primary sm" onClick={() => answer("once")} disabled={busy}>
          Allow once
        </button>
        {r.save.length > 0 && (
          <button className="btn sm" onClick={() => answer("always")} disabled={busy} title="Remembered for this project">
            <KeyRound size={13} />
            Always allow <code>{r.save.join(", ")}</code>
          </button>
        )}
        <button className="btn danger sm" onClick={() => answer("reject")} disabled={busy}>
          Deny
        </button>
      </div>
    </Item>
  );
}

function QuestionItem({ project, question: q, agentName }: { project: Project; question: LoggedMessage; agentName: string }) {
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
    <Item icon={<MessageCircleQuestion size={14} />} kind="Question" agent={agentName} time={q.time}>
      <div className="md small">
        <Md text={q.text} projectId={project.id} agentId={q.from} className="" />
      </div>
      <textarea
        rows={2}
        placeholder={`Answer ${agentName}…`}
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
          Send answer
        </button>
      </div>
    </Item>
  );
}
