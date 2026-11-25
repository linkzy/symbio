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
  Paperclip,
  Pause,
  Play,
  Settings2,
  Users,
  Plus,
  Pin,
  FolderTree,
  FileText,
  X,
  Bot,
} from "lucide-react";
import { UsageLine } from "./Usage";
import { useCostsShown } from "./privacy";
import { api, formatTokens, RUNTIME_LABEL, subscribe, usageTokens, type Agent, type Asset, type Plan, type Project } from "./api";
import { Chat } from "./Chat";
import { Docs } from "./Docs";
import { Explorer, ExplorerPreview, ExplorerTree, type ExplorerPick } from "./Explorer";
import { useLayout, useWide } from "./theme";
import { FilesView } from "./Attachments";
import { InboxDrawer, useInbox } from "./Inbox";
import { Kanban } from "./Kanban";
import { NewHelperDialog } from "./NewHelper";
import { Messages, useProjectLog } from "./Messages";
import { ProjectMenu } from "./ProjectMenu";
import { ProjectSettings } from "./ProjectSettings";
import { Avatar, EmptyState, statusText, waitsForPinnedModel } from "./ui";
import { useI18n } from "./i18n";

type Tab = "chat" | "plan" | "explorer" | "messages" | "docs" | "files" | "settings";
// The Workbench layout keeps the chat on the right and the Explorer in its side bar; its middle has
// tabs, opened from the activity bar or the Explorer and closed like an editor's.
type CenterView = Exclude<Tab, "chat" | "explorer">;
type OpenTab = { view: CenterView } | { file: ExplorerPick };
const tabKey = (t: OpenTab) => ("view" in t ? t.view : `file:${t.file.agentId ?? ""}|${t.file.path}`);
const CENTER_VIEWS: CenterView[] = ["plan", "messages", "docs", "files", "settings"];

// Column widths the human dragged, kept in the browser.
function useWidth(key: string, initial: number): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || initial);
  return [width, (w) => (localStorage.setItem(key, String(Math.round(w))), setWidth(w))];
}

function useRemembered<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = sessionStorage.getItem(key);
    return saved === null ? initial : (JSON.parse(saved) as T);
  });
  const set = (v: T) => {
    sessionStorage.setItem(key, JSON.stringify(v));
    setValue(v);
  };
  return [value, set];
}

export function ProjectView({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Remembered for the browser session, so coming back (e.g. from Settings) opens the same place.
  const [selected, setSelected] = useRemembered<string | null>(`symbio:agent:${projectId}`, null);
  const [newHelper, setNewHelper] = useState(false);
  const [starting, setStarting] = useState(false);
  const [tab, setTab] = useRemembered<Tab>(`symbio:tab:${projectId}`, "chat");
  const [inboxOpen, setInboxOpen] = useState(false);
  // On phones the team sidebar is a drawer, opened from the button before the tabs.
  const [teamOpen, setTeamOpen] = useState(false);
  const [showStopped, setShowStopped] = useState(false);
  const log = useProjectLog(projectId);
  const inbox = useInbox(project, log, plan);
  const [layout] = useLayout();
  // Three columns need room: narrow windows and phones keep the classic layout.
  const wide = useWide(1100);
  const workbench = layout === "workbench" && wide;
  const [sideView, setSideView] = useRemembered<"team" | "explorer" | null>(`symbio:wb-side:${projectId}`, "team");
  const [openTabs, setOpenTabs] = useRemembered<OpenTab[]>(`symbio:wb-tabs:${projectId}`, [{ view: "plan" }]);
  const [activeKey, setActiveKey] = useRemembered<string | null>(`symbio:wb-active:${projectId}`, "plan");
  const [explorerAgent, setExplorerAgent] = useState<string | null>(null);
  const [sideWidth, setSideWidth] = useWidth("symbio:wb-side-width", 260);
  const [chatWidth, setChatWidth] = useWidth("symbio:wb-chat-width", 420);

  useEffect(() => {
    const load = () =>
      api
        .project(projectId)
        .then((p) => {
          setProject(p);
          setError(null);
        })
        .catch((e) => {
          // Removed (here, in another tab, or a remembered link): back to the list, not a dead page.
          if (/^project not found$/i.test(e.message)) location.replace("#/");
          else setError(e.message);
        });
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
      if (e.type === "agent.context" && e.projectId === projectId) {
        setProject((p) => p && { ...p, agents: p.agents.map((a) => (a.id === e.agentId ? { ...a, context: e.context } : a)) });
      }
    });
  }, [projectId]);

  if (error) return <div className="page-inner"><div className="error">{error}</div></div>;
  if (!project) return null;

  const agent = project.agents.find((a) => a.id === selected) ?? project.agents.find((a) => a.role === "coordinator");
  // Core first, then whoever is working, so a long team shows at a glance who's still busy: agents
  // that need attention, working, waiting, then idle (each group in its usual order).
  const rank = (a: Agent) => (a.role === "coordinator" ? 0 : a.problem ? 1 : a.status === "busy" ? 2 : a.status === "waiting" ? 3 : 4);
  const activeAgents = project.agents.filter((a) => a.status !== "stopped").sort((x, y) => rank(x) - rank(y));
  const stopped = project.agents.filter((a) => a.status === "stopped");
  // Pinned agents waiting for their model have their own notice (in their chat); the rest can't continue.
  const stuck = activeAgents.filter((a) => a.problem && !waitsForPinnedModel(a));
  const nameOf = (id: string | null) => (id === null ? "core" : (project.agents.find((a) => a.id === id)?.name ?? "?"));
  const done = plan?.tasks.filter((t) => t.status === "done").length ?? 0;

  const select = (a: Agent | string) => {
    setSelected(typeof a === "string" ? a : a.id);
    if (!workbench) setTab("chat");
    setTeamOpen(false);
  };
  // Opens a tab in whichever layout is showing.
  const openTab = (t: Tab) => {
    if (!workbench) return setTab(t);
    if (t === "explorer") setSideView("explorer");
    else if (t !== "chat") openInCenter({ view: t });
  };
  // Opens a tab in the Workbench's middle (or goes to it, if it's open).
  const openInCenter = (t: OpenTab) => {
    const key = tabKey(t);
    if (!openTabs.some((o) => tabKey(o) === key)) setOpenTabs([...openTabs, t]);
    setActiveKey(key);
  };
  const closeTab = (key: string) => {
    const i = openTabs.findIndex((o) => tabKey(o) === key);
    const rest = openTabs.filter((o) => tabKey(o) !== key);
    setOpenTabs(rest);
    if (activeKey === key) setActiveKey(rest.length ? tabKey(rest[Math.max(0, i - 1)]) : null);
  };
  const activeTab = openTabs.find((o) => tabKey(o) === activeKey) ?? null;
  const picked = activeTab && "file" in activeTab ? activeTab.file : null;

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
    {
      id: "chat",
      label: t("project.tab.chat"),
      icon: <MessageSquare size={14} />,
      // The helper's name; hidden on phones, where the chat header already shows it.
      extra: agent && agent.role !== "coordinator" ? <span className="tab-agent">· {agent.name}</span> : null,
    },
    {
      id: "plan",
      label: t("project.tab.plan"),
      icon: <KanbanSquare size={14} />,
      extra:
        plan?.status === "proposed" ? (
          <motion.span className="tab-alert" initial={{ scale: 0 }} animate={{ scale: 1 }} title={t("project.plan.reviewTitle")}>
            <span className="tab-alert-dot" />
            {t("project.tab.review")}
          </motion.span>
        ) : plan && plan.status !== "none" && plan.tasks.length > 0 ? (
          <span className="count">
            {done}/{plan.tasks.length}
          </span>
        ) : null,
    },
    { id: "explorer", label: t("project.tab.explorer"), icon: <FolderTree size={14} /> },
    { id: "messages", label: t("project.tab.messages"), icon: <MessagesSquare size={14} /> },
    { id: "docs", label: t("project.tab.docs"), icon: <BookOpen size={14} /> },
    { id: "files", label: t("project.tab.files"), icon: <Paperclip size={14} /> },
    { id: "settings", label: t("project.tab.settings"), icon: <Settings2 size={14} /> },
  ];

  const isActive = (a: Agent) => (workbench || tab === "chat") && agent?.id === a.id;
  const teamPanel = (
    <>
      <div className="side-scroll">
        <div>
          <div className="side-group-title">
            {t("project.team")}
            <span className="tnum">{activeAgents.length}</span>
            {project.agents.some((a) => a.role === "coordinator" && a.status !== "stopped") && (
              <button className="btn ghost icon xs side-add" title={t("project.newHelper")} aria-label={t("project.newHelper")} onClick={() => setNewHelper(true)}>
                <Plus size={13} />
              </button>
            )}
          </div>
          <AnimatePresence initial={false}>
            {activeAgents.map((a) => (
              <AgentRow key={a.id} agent={a} active={isActive(a)} onClick={() => select(a)} />
            ))}
          </AnimatePresence>
          {project.agents.length === 0 && (
            <div style={{ padding: "4px 8px" }}>
              <button className="btn primary block" onClick={start} disabled={starting}>
                {starting ? t("project.starting") : t("project.startCore")}
              </button>
            </div>
          )}
          {stopped.length > 0 && (
            <>
              <button className="stopped-toggle" onClick={() => setShowStopped((s) => !s)}>
                {showStopped ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {t("project.stoppedCount", { n: stopped.length })}
              </button>
              {showStopped && stopped.map((a) => <AgentRow key={a.id} agent={a} active={isActive(a)} onClick={() => select(a)} />)}
            </>
          )}
        </div>

        <div>
          <div className="side-group-title">{t("project.sharedAssets")}</div>
          {assets.length === 0 ? (
            <div className="subtle small" style={{ padding: "0 8px" }}>
              {t("project.noAssets")}
            </div>
          ) : (
            assets.map((a) => (
              <div key={a.name} className={`asset-row ${a.holder ? "held" : ""}`} title={a.description}>
                {a.holder ? <Lock size={13} /> : <LockOpen size={13} />}
                <div className="grow">
                  <div className="asset-name ellipsis">{a.name}</div>
                  <div className="asset-sub">
                    {a.holder ? t("project.heldBy", { name: nameOf(a.holder) }) : t("project.free")}
                    {a.queue.length > 0 && ` · ${t("project.waitingCount", { n: a.queue.length })}`}
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
            openTab("settings");
            setTimeout(() => document.getElementById("usage")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
          }}
        />
        {project.agents.length > 0 && (
          <button
            className="btn sm block"
            onClick={() => (project.paused ? api.resumeTeam(project.id) : api.pauseTeam(project.id)).then(setProject).catch((e) => alert(e.message))}
            title={project.paused ? t("project.resume.title") : t("project.pause.title")}
          >
            {project.paused ? <Play size={13} /> : <Pause size={13} />}
            {project.paused ? t("project.resume") : t("project.pause")}
          </button>
        )}
      </div>
    </>
  );

  const actions = (
    <div className="main-actions">
      {inbox.count > 0 && (
        <motion.button className="needs-you" onClick={() => setInboxOpen(true)} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          {t("project.needsYou")}
          <span className="count">{inbox.count}</span>
        </motion.button>
      )}
      <ProjectMenu project={project} onRemoved={() => (location.hash = "#/")} />
    </div>
  );

  const banners = (
    <>
      {project.paused && (
        <div className="banner blue">
          <Pause size={15} />
          <div className="grow">
            <strong>{project.budgetState?.pausedFor ? t(`project.paused.banner.budget.${project.budgetState.pausedFor}`) : t("project.paused.banner.title")}</strong>{" "}
            <span className="muted">
              {project.budgetState?.pausedFor
                ? t(`project.paused.banner.budget.${project.budgetState.pausedFor}.hint`)
                : project.heldMessages?.length
                ? t("project.paused.banner.held", { n: project.heldMessages.length })
                : t("project.paused.banner.idle")}
            </span>
          </div>
          <button className="btn sm" onClick={() => api.resumeTeam(project.id).then(setProject).catch((e) => alert(e.message))}>
            <Play size={13} />
            {t("project.resume.banner")}
          </button>
        </div>
      )}
      {stuck.length > 0 && (
        <div className="banner red">
          <CircleAlert size={15} />
          <div className="grow ellipsis" title={stuck[0].problem ?? ""}>
            <strong>{stuck.map((a) => a.name).join(", ")} {t("project.stuck.title")}</strong> <span className="muted">{t("project.stuck.subtitle")}</span>
          </div>
          <button className="btn sm" onClick={() => api.retryModels(project.id).catch((e) => alert(e.message))}>
            {t("common.retryNow")}
          </button>
          <button className="btn primary sm" onClick={() => openTab("settings")}>
            {t("project.addModel")}
          </button>
        </div>
      )}
    </>
  );

  const chat = agent ? (
    <Chat key={agent.id} project={project} agent={agent} />
  ) : (
    <EmptyState icon={<MessageSquare size={20} />} title={t("project.startConversation.title")}>
      {t("project.startConversation.body")}
    </EmptyState>
  );

  const view = (t: Tab | "file", file?: ExplorerPick | null) =>
    t === "docs" ? (
      <Docs project={project} />
    ) : t === "files" ? (
      <FilesView project={project} />
    ) : t === "explorer" ? (
      <Explorer key={project.id} project={project} />
    ) : t === "plan" ? (
      <Kanban project={project} plan={plan} />
    ) : t === "messages" ? (
      <Messages project={project} log={log} onOpenAgent={(id) => select(id)} />
    ) : t === "settings" ? (
      <ProjectSettings key={project.id} project={project} onChanged={setProject} />
    ) : t === "file" ? (
      <div className="docs-view explorer-view wb-file">
        <ExplorerPreview projectId={project.id} picked={file ?? null} />
      </div>
    ) : (
      chat
    );

  const overlays = (
    <>
      <AnimatePresence>
        {inboxOpen && (
          <InboxDrawer
            project={project}
            plan={plan}
            data={inbox}
            onClose={() => setInboxOpen(false)}
            onOpenAgent={(id) => {
              select(id);
              setInboxOpen(false);
            }}
            onOpenTab={(t) => {
              openTab(t);
              setInboxOpen(false);
            }}
          />
        )}
      </AnimatePresence>
      {newHelper && (
        <NewHelperDialog
          project={project}
          onClose={() => setNewHelper(false)}
          onCreated={(a) => {
            setNewHelper(false);
            select(a);
          }}
        />
      )}
    </>
  );

  if (workbench) {
    const working = activeAgents.filter((a) => a.status === "busy").length;
    const waiting = activeAgents.filter((a) => a.status === "waiting").length;
    const side = (v: "team" | "explorer") => setSideView(sideView === v ? null : v);
    const tabInfo = (v: CenterView) => tabs.find((t) => t.id === v)!;
    const viewIcon: Record<CenterView, React.ReactNode> = {
      plan: <KanbanSquare size={20} />,
      messages: <MessagesSquare size={20} />,
      docs: <BookOpen size={20} />,
      files: <Paperclip size={20} />,
      settings: <Settings2 size={20} />,
    };
    const viewButton = (v: CenterView) => (
      <button
        key={v}
        className={`wb-activity-item ${activeKey === v ? "active" : ""}`}
        onClick={() => openInCenter({ view: v })}
        title={v === "settings" ? t("project.wb.settings") : tabInfo(v).label}
        aria-label={v === "settings" ? t("project.wb.settings") : tabInfo(v).label}
      >
        {viewIcon[v]}
        {v === "plan" && plan?.status === "proposed" && <span className="wb-activity-badge amber" />}
      </button>
    );
    return (
      <div
        className={`workbench ${sideView ? "" : "no-side"}`}
        style={{ "--wb-side": `${sideWidth}px`, "--wb-chat": `${chatWidth}px` } as React.CSSProperties}
      >
        <nav className="wb-activity" aria-label={t("project.wb.views")}>
          <button className={`wb-activity-item ${sideView === "team" ? "active" : ""}`} onClick={() => side("team")} title={t("project.team")} aria-label={t("project.team")} aria-pressed={sideView === "team"}>
            <Users size={20} />
            {stuck.length > 0 && <span className="wb-activity-badge red" />}
          </button>
          <button className={`wb-activity-item ${sideView === "explorer" ? "active" : ""}`} onClick={() => side("explorer")} title={t("project.tab.explorer")} aria-label={t("project.tab.explorer")} aria-pressed={sideView === "explorer"}>
            <FolderTree size={20} />
          </button>
          <span className="wb-activity-sep" />
          {CENTER_VIEWS.filter((v) => v !== "settings").map(viewButton)}
          <span className="grow" />
          {viewButton("settings")}
        </nav>
        {sideView && (
          <aside className="wb-side" aria-label={sideView === "team" ? t("project.team") : t("project.tab.explorer")}>
            {sideView === "team" ? (
              teamPanel
            ) : (
              <div className="wb-side-scroll explorer-tree">
                <div className="wb-side-title">{t("project.tab.explorer")}</div>
                <ExplorerTree project={project} agentId={explorerAgent} onAgent={setExplorerAgent} picked={picked} onPick={(p) => openInCenter({ file: p })} />
              </div>
            )}
            <Resizer side="right" width={sideWidth} min={180} max={Math.min(600, innerWidth - 48 - chatWidth - 320)} initial={260} onResize={setSideWidth} label={t("project.wb.resizeSide")} />
          </aside>
        )}
        <section className="main wb-center">
          <div className="main-head">
            <div className="tabs">
              {openTabs.map((item) => {
                const key = tabKey(item);
                const active = key === activeKey;
                const info = "view" in item ? tabInfo(item.view) : null;
                const name = "view" in item ? info!.label : (item.file.path.split("/").pop() ?? item.file.path);
                return (
                  <div key={key} className={`tab wb-tab ${active ? "active" : ""}`} title={"file" in item ? item.file.path : undefined}>
                    <button className="wb-tab-open" onClick={() => setActiveKey(key)}>
                      {info ? info.icon : <FileText size={14} />}
                      <span className="ellipsis">{name}</span>
                      {info?.extra}
                    </button>
                    <button className="wb-tab-close" aria-label={t("project.wb.closeTab", { name })} title={t("common.close")} onClick={() => closeTab(key)}>
                      <X size={12} />
                    </button>
                    {active && <motion.span layoutId="tab-underline" className="tab-underline" transition={{ duration: 0.15 }} />}
                  </div>
                );
              })}
            </div>
            {actions}
          </div>
          {banners}
          <div className="main-body">
            {activeTab ? (
              view("view" in activeTab ? activeTab.view : "file", picked)
            ) : (
              <EmptyState icon={<FolderTree size={20} />} title={t("project.wb.nothingOpen.title")}>
                {t("project.wb.nothingOpen.body")}
              </EmptyState>
            )}
          </div>
        </section>
        <section className="wb-chat" aria-label={t("project.tab.chat")}>
          <Resizer side="left" width={chatWidth} min={300} max={Math.min(1000, innerWidth - 48 - (sideView ? sideWidth : 0) - 320)} initial={420} onResize={setChatWidth} label={t("project.wb.resizeChat")} />
          <div className="wb-chat-head">
            <span className="wb-side-title">{t("project.tab.chat")}</span>
            <select value={agent?.id ?? ""} onChange={(e) => select(e.target.value)} aria-label={t("project.wb.talkTo")} title={t("project.wb.talkToTitle")}>
              {[...activeAgents, ...stopped].map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role === "coordinator" ? t("project.wb.lead") : a.status === "stopped" ? t("project.wb.stopped") : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="wb-chat-body">{chat}</div>
        </section>
        <footer className="wb-status">
          <span className="wb-status-item" title={t("project.runtime.label")}>
            <Bot size={12} />
            {RUNTIME_LABEL[project.runtime ?? "opencode"]}
          </span>
          {project.paused ? (
            <span className="wb-status-item">
              <Pause size={12} />
              {t("project.status.paused")}
            </span>
          ) : (
            <span className="wb-status-item">
              {t("project.status.working", { n: working })}
              {waiting > 0 ? t("project.status.waiting", { n: waiting }) : ""}
            </span>
          )}
          {plan && plan.tasks.length > 0 && (
            <button className="wb-status-item" onClick={() => openInCenter({ view: "plan" })}>
              <KanbanSquare size={12} />
              {t("project.status.tasksDone", { done, total: plan.tasks.length })}
            </button>
          )}
          <span className="grow" />
          {inbox.count > 0 && (
            <button className="wb-status-item attention" onClick={() => setInboxOpen(true)}>
              {t("project.status.needsYou", { n: inbox.count })}
            </button>
          )}
          {agent && <span className="wb-status-item">{agent.name} · {agent.model.split("/").pop()}</span>}
        </footer>
        {overlays}
      </div>
    );
  }

  return (
    <div className="project-view">
      {teamOpen && <div className="side-backdrop" onClick={() => setTeamOpen(false)} />}
      <aside className={`side ${teamOpen ? "open" : ""}`}>{teamPanel}</aside>

      <section className="main">
        <div className="main-head">
          <button className="btn ghost sm team-toggle" onClick={() => setTeamOpen(true)} title={t("project.team")} aria-label={t("project.showTeam")}>
            <Users size={15} />
            <span className="tnum">{activeAgents.length}</span>
          </button>
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
          {actions}
        </div>
        {banners}
        <div className="main-body">{view(tab)}</div>
      </section>
      {overlays}
    </div>
  );
}

function AgentRow({ agent: a, active, onClick }: { agent: Agent; active: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const costs = useCostsShown();
  const sub = waitsForPinnedModel(a)
    ? t("project.agent.waitingForModel", { model: a.model.split("/").pop() ?? a.model })
    : a.problem
      ? t("project.agent.needsAttention")
      : a.status === "idle"
        ? (a.purpose ?? (a.role === "coordinator" ? t("project.agent.defaultPurpose") : t("project.agent.defaultIdle")))
        : statusText(a.status);
  const subClass = waitsForPinnedModel(a) ? "waiting" : a.problem ? "problem" : a.status === "busy" ? "working" : a.status === "waiting" ? "waiting" : "";
  return (
    <motion.button
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`agent-row ${active ? "active" : ""}`}
      onClick={onClick}
      title={[a.purpose, a.model, costs && a.usage && `${formatTokens(usageTokens(a.usage))} tokens`].filter(Boolean).join("\n")}
    >
      <Avatar name={a.name} status={waitsForPinnedModel(a) ? "waiting" : a.problem ? "error" : a.status} />
      <span className="grow">
        <span className="agent-name">
          {a.name}
          {a.role === "coordinator" && <span className="tag accent">{t("project.agent.lead")}</span>}
          {a.modelPinned && (
            <span className="agent-pin" title={t("project.agent.pinnedTo", { model: a.model })} aria-label={t("project.agent.pinnedTo", { model: a.model })}>
              <Pin size={11} />
            </span>
          )}
        </span>
        <span className={`agent-sub ellipsis ${subClass}`} style={{ display: "block" }}>
          {sub}
        </span>
      </span>
    </motion.button>
  );
}

/** A border to drag (or move with the arrow keys) to make a Workbench column wider; double-click resets it. */
function Resizer({ side, width, min, max, initial, onResize, label }: { side: "left" | "right"; width: number; min: number; max: number; initial: number; onResize: (w: number) => void; label: string }) {
  const clamp = (w: number) => Math.min(max, Math.max(min, w));
  return (
    <div
      className={`wb-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        document.body.classList.add("resizing");
        const move = (ev: PointerEvent) => onResize(clamp(startWidth + (side === "right" ? ev.clientX - startX : startX - ev.clientX)));
        const up = () => {
          el.classList.remove("dragging");
          document.body.classList.remove("resizing");
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => onResize(initial)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 50 : 10;
        const grow = side === "right" ? "ArrowRight" : "ArrowLeft";
        const shrink = side === "right" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow) onResize(clamp(width + step));
        else if (e.key === shrink) onResize(clamp(width - step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
