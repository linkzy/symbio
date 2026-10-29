import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  KanbanSquare,
  Lock,
  LockOpen,
  MessageSquare,
  MessagesSquare,
  Pause,
  Play,
  Settings2,
} from "lucide-react";
import { UsageLine } from "./Usage";
import { api, formatTokens, subscribe, usageTokens, type Agent, type Asset, type Plan, type Project } from "./api";
import { Chat } from "./Chat";
import { Docs } from "./Docs";
import { InboxDrawer, useInbox } from "./Inbox";
import { Kanban } from "./Kanban";
import { Messages, useProjectLog } from "./Messages";
import { ProjectMenu } from "./ProjectMenu";
import { ProjectSettings } from "./ProjectSettings";
import { Avatar, EmptyState, statusText } from "./ui";

type Tab = "chat" | "plan" | "messages" | "docs" | "settings";

export function ProjectView({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [showStopped, setShowStopped] = useState(false);
  const log = useProjectLog(projectId);
  const inbox = useInbox(project, log, plan);

  useEffect(() => {
    const load = () =>
      api
        .project(projectId)
        .then((p) => {
          setProject(p);
          setError(null);
        })
        .catch((e) => setError(e.message));
    const loadAssets = () =>
      api
        .assets(projectId)
        .then(setAssets)
        .catch(() => {});
    const loadPlan = () =>
      api
        .plan(projectId)
        .then(setPlan)
        .catch(() => {});
    load();
    loadAssets();
    loadPlan();
    return subscribe((e) => {
      if (e.type === "project.updated" && e.projectId === projectId) load();
      if (e.type === "assets.updated" && e.projectId === projectId) loadAssets();
      if (e.type === "plan.updated" && e.projectId === projectId) loadPlan();
      if (e.type === "agent.status" && e.projectId === projectId) {
        setProject((p) => p && { ...p, agents: p.agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status } : a)) });
      }
    });
  }, [projectId]);

  if (error) return <div className="page-inner"><div className="error">{error}</div></div>;
  if (!project) return null;

  const agent = project.agents.find((a) => a.id === selected) ?? project.agents.find((a) => a.role === "coordinator");
  const activeAgents = project.agents.filter((a) => a.status !== "stopped");
  const stopped = project.agents.filter((a) => a.status === "stopped");
  const stuck = activeAgents.filter((a) => a.problem);
  const nameOf = (id: string | null) => (id === null ? "core" : (project.agents.find((a) => a.id === id)?.name ?? "?"));
  const done = plan?.tasks.filter((t) => t.status === "done").length ?? 0;

  const select = (a: Agent) => {
    setSelected(a.id);
    setTab("chat");
  };

  async function start() {
    setStarting(true);
    try {
      setProject((await api.start(project!.id)).project);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode; extra?: React.ReactNode }[] = [
    { id: "chat", label: agent && agent.role !== "coordinator" ? `Chat · ${agent.name}` : "Chat", icon: <MessageSquare size={14} /> },
    {
      id: "plan",
      label: "Plan",
      icon: <KanbanSquare size={14} />,
      extra:
        plan?.status === "proposed" ? (
          <motion.span className="tab-alert" initial={{ scale: 0 }} animate={{ scale: 1 }} title="A plan is waiting for your approval">
            <span className="tab-alert-dot" />
            Review
          </motion.span>
        ) : plan && plan.status !== "none" && plan.tasks.length > 0 ? (
          <span className="count">
            {done}/{plan.tasks.length}
          </span>
        ) : null,
    },
    { id: "messages", label: "Messages", icon: <MessagesSquare size={14} /> },
    { id: "docs", label: "Docs", icon: <BookOpen size={14} /> },
    { id: "settings", label: "Settings", icon: <Settings2 size={14} /> },
  ];

  return (
    <div className="project-view">
      <aside className="side">
        <div className="side-scroll">
          <div>
            <div className="side-group-title">
              Team
              <span className="tnum">{activeAgents.length}</span>
            </div>
            <AnimatePresence initial={false}>
              {activeAgents.map((a) => (
                <AgentRow key={a.id} agent={a} active={tab === "chat" && agent?.id === a.id} onClick={() => select(a)} />
              ))}
            </AnimatePresence>
            {project.agents.length === 0 && (
              <div style={{ padding: "4px 8px" }}>
                <button className="btn primary block" onClick={start} disabled={starting}>
                  {starting ? "Starting…" : "Start core"}
                </button>
              </div>
            )}
            {stopped.length > 0 && (
              <>
                <button className="stopped-toggle" onClick={() => setShowStopped((s) => !s)}>
                  {showStopped ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {stopped.length} stopped
                </button>
                {showStopped && stopped.map((a) => <AgentRow key={a.id} agent={a} active={tab === "chat" && agent?.id === a.id} onClick={() => select(a)} />)}
              </>
            )}
          </div>

          <div>
            <div className="side-group-title">Shared assets</div>
            {assets.length === 0 ? (
              <div className="subtle small" style={{ padding: "0 8px" }}>
                None declared yet.
              </div>
            ) : (
              assets.map((a) => (
                <div key={a.name} className={`asset-row ${a.holder ? "held" : ""}`} title={a.description}>
                  {a.holder ? <Lock size={13} /> : <LockOpen size={13} />}
                  <div className="grow">
                    <div className="asset-name ellipsis">{a.name}</div>
                    <div className="asset-sub">
                      {a.holder ? `Held by ${nameOf(a.holder)}` : "Free"}
                      {a.queue.length > 0 && ` · ${a.queue.length} waiting`}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="side-foot">
          <UsageLine
            project={project}
            onOpen={() => {
              setTab("settings");
              setTimeout(() => document.getElementById("usage")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
            }}
          />
          {project.agents.length > 0 && (
            <button
              className="btn sm block"
              onClick={() => (project.paused ? api.resumeTeam(project.id) : api.pauseTeam(project.id)).then(setProject).catch((e) => alert(e.message))}
              title={project.paused ? "Deliver held messages and let agents continue" : "Interrupt working agents and hold their messages"}
            >
              {project.paused ? <Play size={13} /> : <Pause size={13} />}
              {project.paused ? "Resume team" : "Pause team"}
            </button>
          )}
        </div>
      </aside>

      <section className="main">
        <div className="main-head">
          <div className="tabs">
            {tabs.map((t) => (
              <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                {t.icon}
                {t.label}
                {t.extra}
                {tab === t.id && <motion.span layoutId="tab-underline" className="tab-underline" transition={{ duration: 0.15 }} />}
              </button>
            ))}
          </div>
          <div className="main-actions">
            {inbox.count > 0 && (
              <motion.button className="needs-you" onClick={() => setInboxOpen(true)} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                Needs you
                <span className="count">{inbox.count}</span>
              </motion.button>
            )}
            <ProjectMenu project={project} onRemoved={() => (location.hash = "#/")} />
          </div>
        </div>

        {project.paused && (
          <div className="banner blue">
            <Pause size={15} />
            <div className="grow">
              <strong>The team is paused.</strong>{" "}
              <span className="muted">
                {project.heldMessages?.length
                  ? `${project.heldMessages.length} message(s) between agents will be delivered when you resume.`
                  : "Agents won't start anything on their own; you can still talk to them."}
              </span>
            </div>
            <button className="btn sm" onClick={() => api.resumeTeam(project.id).then(setProject).catch((e) => alert(e.message))}>
              <Play size={13} />
              Resume
            </button>
          </div>
        )}
        {stuck.length > 0 && (
          <div className="banner red">
            <CircleAlert size={15} />
            <div className="grow ellipsis" title={stuck[0].problem ?? ""}>
              <strong>{stuck.map((a) => a.name).join(", ")} can't continue</strong> <span className="muted">— every allowed model failed.</span>
            </div>
            <button className="btn sm" onClick={() => api.retryModels(project.id).catch((e) => alert(e.message))}>
              Retry now
            </button>
            <button className="btn primary sm" onClick={() => setTab("settings")}>
              Add a model
            </button>
          </div>
        )}

        <div className="main-body">
          {tab === "docs" ? (
            <Docs project={project} />
          ) : tab === "plan" ? (
            <Kanban project={project} plan={plan} />
          ) : tab === "messages" ? (
            <Messages project={project} log={log} onOpenAgent={(id) => { setSelected(id); setTab("chat"); }} />
          ) : tab === "settings" ? (
            <ProjectSettings key={project.id} project={project} onChanged={setProject} />
          ) : agent ? (
            <Chat key={agent.id} project={project} agent={agent} />
          ) : (
            <EmptyState icon={<MessageSquare size={20} />} title="Start the conversation">
              Start core to begin discussing the project.
            </EmptyState>
          )}
        </div>
      </section>

      <AnimatePresence>
        {inboxOpen && (
          <InboxDrawer
            project={project}
            plan={plan}
            data={inbox}
            onClose={() => setInboxOpen(false)}
            onOpenAgent={(id) => {
              setSelected(id);
              setTab("chat");
              setInboxOpen(false);
            }}
            onOpenTab={(t) => {
              setTab(t);
              setInboxOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentRow({ agent: a, active, onClick }: { agent: Agent; active: boolean; onClick: () => void }) {
  const sub = a.problem ? "Needs attention" : a.status === "idle" ? (a.purpose ?? (a.role === "coordinator" ? "Coordinates the team" : "Idle")) : statusText(a.status);
  const subClass = a.problem ? "problem" : a.status === "busy" ? "working" : a.status === "waiting" ? "waiting" : "";
  return (
    <motion.button
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`agent-row ${active ? "active" : ""}`}
      onClick={onClick}
      title={[a.purpose, a.model, a.usage && `${formatTokens(usageTokens(a.usage))} tokens`].filter(Boolean).join("\n")}
    >
      <Avatar name={a.name} status={a.problem ? "error" : a.status} />
      <span className="grow">
        <span className="agent-name">
          {a.name}
          {a.role === "coordinator" && <span className="tag accent">lead</span>}
        </span>
        <span className={`agent-sub ellipsis ${subClass}`} style={{ display: "block" }}>
          {sub}
        </span>
      </span>
    </motion.button>
  );
}
