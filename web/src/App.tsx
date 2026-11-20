import { useEffect, useRef, useState } from "react";
import { MachineBadge } from "./Machine";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ChevronRight, KeyRound, LayoutList, PauseCircle, Plus, Settings as SettingsIcon } from "lucide-react";
import { api, LOCKED_EVENT, subscribe, type Project, type RuntimeInfo, type RuntimeKind, type RuntimeStatus } from "./api";
import { FileViewer } from "./files";
import { Home } from "./Home";
import { ProjectView } from "./ProjectView";
import { leaveSettings, Settings } from "./Settings";
import { EmptyState, Logo } from "./ui";
import { RemoteBanner } from "./Remote";
import { UpdateBadge, useUpdate } from "./Updates";
import { ReportProblemLink } from "./ReportProblem";
import { useI18n } from "./i18n";

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = (e: HashChangeEvent) => {
      // Remember where we came from, for "Back" buttons.
      const from = new URL(e.oldURL).hash || "#/";
      if (from !== location.hash) sessionStorage.setItem("symbio:previous-page", from);
      setHash(location.hash);
    };
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  // "#/view/<project>?path=…&agent=…&line=…": a file on its own page (links in the team's messages).
  const view = hash.match(/^#\/view\/([\w-]+)\?(.*)$/);
  if (view) {
    const q = new URLSearchParams(view[2]);
    return { page: "view" as const, id: view[1], path: q.get("path") ?? "", agent: q.get("agent"), line: Number(q.get("line")) || undefined };
  }
  const match = hash.match(/^#\/p\/([\w-]+)/);
  if (match) return { page: "project" as const, id: match[1] };
  if (hash.startsWith("#/settings")) return { page: "settings" as const };
  // "#/new": the project list with the New project dialog open (from the project switcher).
  return { page: "home" as const, create: hash === "#/new" };
}

export function App() {
  const { t } = useI18n();
  const route = useHashRoute();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  // The open project's runtime: the top bar shows that one there.
  const [projectRuntime, setProjectRuntime] = useState<RuntimeKind | null>(null);

  useEffect(() => {
    api.runtime().then(setRuntime).catch(() => {});
    // Memory is measured server-side every minute; refresh the indicator now and then.
    const timer = setInterval(() => api.runtime().then(setRuntime).catch(() => {}), 30_000);
    const unsubscribe = subscribe((e) => {
      if (e.type === "runtime") {
        // State changes don't carry memory (measured every minute): keep the last known figures.
        setRuntime((r) => ({
          ...e,
          memoryMB: e.memoryMB ?? r?.memoryMB ?? null,
          runtimes: e.runtimes?.map((x) => ({
            ...x,
            memoryMB: x.state === "running" ? (x.memoryMB ?? r?.runtimes?.find((y) => y.kind === x.kind)?.memoryMB ?? null) : null,
          })),
        }));
      }
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  // Breadcrumb name for the open project.
  useEffect(() => {
    if (route.page !== "project") {
      setProjectRuntime(null);
      return setProjectName(null);
    }
    const id = route.id;
    const load = () =>
      api
        .project(id)
        .then((p) => {
          setProjectName(p.name);
          setProjectRuntime(p.runtime ?? "opencode");
        })
        .catch(() => setProjectName(null));
    void load();
    return subscribe((e) => {
      if (e.type === "project.updated" && e.projectId === id) void load();
    });
  }, [route.page === "project" ? route.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const onLocked = () => setLocked(true);
    addEventListener(LOCKED_EVENT, onLocked);
    return () => removeEventListener(LOCKED_EVENT, onLocked);
  }, []);

  async function pauseAll() {
    if (!confirm(t("app.pauseAll.confirm"))) return;
    const { paused } = await api.pauseAll();
    alert(paused.length ? t("app.pauseAll.result", { names: paused.join(", ") }) : t("app.pauseAll.none"));
  }

  if (locked) {
    return (
      <div className="locked">
        <EmptyState icon={<KeyRound size={20} />} title={t("app.locked.title")}>
          {t("app.locked.body.before")}
          <code>sym</code>
          {t("app.locked.body.or")}
          <code>npm start</code>
          {t("app.locked.body.after")}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <Logo />
          <span className="brand-name">Symbio</span>
          <SymbioVersion />
        </a>
        <nav className="crumbs">
          <ChevronRight size={14} />
          {route.page === "settings" ? (
            <span className="current">{t("app.settings")}</span>
          ) : route.page === "project" ? (
            <>
              <a href="#/">{t("app.projects")}</a>
              <ChevronRight size={14} />
              <ProjectSwitcher currentId={route.id} name={projectName} />
            </>
          ) : (
            <span className="current">{t("app.projects")}</span>
          )}
        </nav>
        <div className="topbar-actions">
          <button className="btn ghost sm" onClick={pauseAll} title={t("app.pauseAll.title")}>
            <PauseCircle size={15} />
            <span className="btn-label">{t("app.pauseAll")}</span>
          </button>
          <a
            className={`btn ghost sm ${route.page === "settings" ? "active" : ""}`}
            href="#/settings"
            title={route.page === "settings" ? `${t("common.close")} ${t("app.settings")}` : t("app.settings")}
            // A second click closes Settings, back to where you were.
            onClick={(e) => {
              if (route.page !== "settings") return;
              e.preventDefault();
              leaveSettings();
            }}
          >
            <SettingsIcon size={15} />
            <span className="btn-label">{t("app.settings")}</span>
          </a>
          <ReportProblemLink />
          <UpdateBadge />
          <MachineBadge />
          <RuntimeBadges runtime={runtime} only={projectRuntime} />
        </div>
      </header>
      <RemoteBanner />
      <AnimatePresence mode="wait">
        <motion.main
          key={route.page === "project" ? route.id : route.page}
          className="page"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          {route.page === "project" ? (
            <ProjectView projectId={route.id} />
          ) : route.page === "view" ? (
            <FileViewer projectId={route.id} rel={route.path} agentId={route.agent} line={route.line} />
          ) : route.page === "settings" ? (
            <Settings />
          ) : (
            <Home runtime={runtime} create={route.page === "home" && route.create} />
          )}
        </motion.main>
      </AnimatePresence>
    </div>
  );
}

/** The project name in the breadcrumb: opens a list of the other projects to jump to. */
function ProjectSwitcher({ currentId, name }: { currentId: string; name: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    api.projects().then(setProjects).catch(() => setProjects([]));
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", close);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu switcher" ref={ref}>
      <button className="switcher-button current" onClick={() => setOpen((o) => !o)} title={t("app.switchProject")} aria-haspopup="menu" aria-expanded={open}>
        <span className="ellipsis">{name ?? "…"}</span>
        <ChevronDown size={13} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu-list left" role="menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.1 }}>
            {projects === null && <div className="menu-note">{t("common.loading")}</div>}
            {projects?.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                className={p.id === currentId ? "on" : ""}
                onClick={() => {
                  setOpen(false);
                  location.hash = `#/p/${p.id}`;
                }}
              >
                <span className="ellipsis grow">{p.name}</span>
                {p.id === currentId && <Check size={14} />}
              </button>
            ))}
            <div className="menu-sep" />
            <button
              onClick={() => {
                setOpen(false);
                location.hash = "#/";
              }}
            >
              <LayoutList size={14} />
              {t("app.allProjects")}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                location.hash = "#/new";
              }}
            >
              <Plus size={14} />
              {t("app.newProject.menu")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SymbioVersion() {
  const [state] = useUpdate();
  if (!state?.current) return null;
  return (
    <span className="brand-version" title={state.install === "dev" ? "Symbio version (development copy)" : "Symbio version"}>
      {state.current}
    </span>
  );
}

/**
 * The agent runtimes' status. On a project's page, the one its agents run on; elsewhere, the ones
 * running (each starts when something needs it).
 */
function RuntimeBadges({ runtime, only }: { runtime: RuntimeInfo | null; only: RuntimeKind | null }) {
  const { t } = useI18n();
  if (!runtime) return <span className="runtime">{t("app.connecting")}</span>;
  const all: RuntimeStatus[] = runtime.runtimes ?? [{ kind: "opencode", label: "OpenCode", ...runtime }];
  const shown = only ? all.filter((r) => r.kind === only) : all.filter((r) => r.state !== "stopped" || r.installing);
  if (!shown.length) {
    return (
      <span className="runtime" title={t("app.runtime.startHint")}>
        <span className="dot stopped" />
        <span className="runtime-label">{all.some((r) => r.installed !== false) ? t("app.noRuntimeRunning") : t("app.noRuntimeInstalled")}</span>
      </span>
    );
  }
  return (
    <>
      {shown.map((r) => (
        <RuntimeBadge key={r.kind} runtime={r} />
      ))}
    </>
  );
}

function RuntimeBadge({ runtime }: { runtime: RuntimeStatus }) {
  const { t } = useI18n();
  const name = runtime.label;
  const memory = runtime.memoryMB
    ? runtime.memoryMB >= 1024
      ? `${(runtime.memoryMB / 1024).toFixed(1)} GB`
      : `${runtime.memoryMB} MB`
    : null;
  const label =
    runtime.installed === false
      ? runtime.installing
        ? t("app.runtime.installing", { name })
        : t("app.runtime.notInstalled", { name })
      : runtime.state === "running"
      ? `${name} ${runtime.version ?? ""}`.trim()
      : runtime.state === "starting"
        ? t("app.runtime.starting", { name })
        : runtime.state === "crashed"
          ? t("app.runtime.restarting", { name })
          : t("app.runtime.notStarted", { name });
  return (
    <span className="runtime" data-runtime={runtime.kind} title={[runtime.error, memory && t("app.runtime.memory", { value: memory })].filter(Boolean).join("\n") || undefined}>
      <span className={`dot ${runtime.state}`} />
      <span className="runtime-label">{label}</span>
      {memory && runtime.state === "running" && <span className="subtle tnum">{memory}</span>}
    </span>
  );
}
