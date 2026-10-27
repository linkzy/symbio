import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, ClipboardList, KeyRound, MessageCircleQuestion, Plug, ShieldQuestion } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, subscribe, type Approval, type LoggedMessage, type PermissionRequest, type Plan, type Project } from "./api";
import { openQuestions } from "./Messages";
import { Avatar, Drawer, timeAgo } from "./ui";

export interface InboxData {
  approvals: Approval[];
  permissions: PermissionRequest[];
  questions: LoggedMessage[];
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
  const stuck = project?.agents.filter((a) => a.problem && a.status !== "stopped").length ?? 0;
  const planWaiting = plan?.status === "proposed" ? 1 : 0;
  return { approvals, permissions, questions, count: approvals.length + permissions.length + questions.length + stuck + planWaiting };
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
  const stuck = project.agents.filter((a) => a.problem && a.status !== "stopped");
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
              <button className="btn primary sm" onClick={() => onOpenTab("settings")}>
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

        {data.approvals.map((a) => (
          <ApprovalItem key={a.id} project={project} approval={a} />
        ))}

        {data.permissions.map((p) => (
          <PermissionItem key={p.id} project={project} request={p} />
        ))}

        {data.questions.map((q) =>
          q.kind === "form" ? (
            <Item key={q.id} icon={<MessageCircleQuestion size={14} />} kind="Question" agent={nameOf(q.from)} time={q.time}>
              <div className="small">{nameOf(q.from)} is asking you a multiple-choice question.</div>
              <div className="inbox-actions">
                <button className="btn primary sm" onClick={() => onOpenAgent(q.from)}>
                  Answer in chat
                </button>
              </div>
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

function ApprovalItem({ project, approval: a }: { project: Project; approval: Approval }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(approved: boolean) {
    setBusy(true);
    await api.decideApproval(project.id, a.id, approved, note.trim() || undefined).catch((e) => alert(e.message));
  }
  const body = a.action.kind === "github_api" && a.action.body !== undefined ? JSON.stringify(a.action.body, null, 2) : null;
  return (
    <Item icon={<Plug size={14} />} kind={`Use ${a.connectionName}`} agent={a.agentName} time={a.createdAt}>
      <div className="small">Wants to {a.summary}</div>
      {typeof a.action.command === "string" && <pre className="command">{a.action.command}</pre>}
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
        <Markdown remarkPlugins={[remarkGfm]}>{q.text}</Markdown>
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
