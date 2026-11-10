import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ChevronRight, KeyRound, LayoutList, PauseCircle, Settings as SettingsIcon } from "lucide-react";
import { api, LOCKED_EVENT, subscribe, type Project, type RuntimeInfo } from "./api";
import { Home } from "./Home";
import { ProjectView } from "./ProjectView";
import { leaveSettings, Settings } from "./Settings";
import { EmptyState, Logo } from "./ui";
import { RemoteBanner } from "./Remote";
import { UpdateBadge, useUpdate } from "./Updates";

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
  const match = hash.match(/^#\/p\/([\w-]+)/);
  if (match) return { page: "project" as const, id: match[1] };
  if (hash.startsWith("#/settings")) return { page: "settings" as const };
  return { page: "home" as const };
}

export function App() {
  const route = useHashRoute();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    api.runtime().then(setRuntime).catch(() => {});
    // Memory is measured server-side every minute; refresh the indicator now and then.
    const timer = setInterval(() => api.runtime().then(setRuntime).catch(() => {}), 30_000);
    const unsubscribe = subscribe((e) => {
      if (e.type === "runtime") setRuntime((r) => ({ ...e, memoryMB: e.memoryMB ?? r?.memoryMB ?? null }));
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  // Breadcrumb name for the open project.
  useEffect(() => {
    if (route.page !== "project") return setProjectName(null);
    const id = route.id;
    const load = () =>
      api
        .project(id)
        .then((p) => setProjectName(p.name))
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
    if (!confirm("Pause every project that has agents working? You can resume each project from its page.")) return;
    const { paused } = await api.pauseAll();
    alert(paused.length ? `Paused: ${paused.join(", ")}` : "No agents were working.");
  }

  if (locked) {
    return (
      <div className="locked">
        <EmptyState icon={<KeyRound size={20} />} title="Open Symbio from its link">
          This page doesn't have Symbio's key, so it can't show your projects. Use the link Symbio printed when it started, or start
          it again (<code>sym</code> or <code>npm start</code>): it opens the right link for you.
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
            <span className="current">Settings</span>
          ) : route.page === "project" ? (
            <>
              <a href="#/">Projects</a>
              <ChevronRight size={14} />
              <ProjectSwitcher currentId={route.id} name={projectName} />
            </>
          ) : (
            <span className="current">Projects</span>
          )}
        </nav>
        <div className="topbar-actions">
          <button className="btn ghost sm" onClick={pauseAll} title="Pause every project that has agents working">
            <PauseCircle size={15} />
            <span className="btn-label">Pause all</span>
          </button>
          <a
            className={`btn ghost sm ${route.page === "settings" ? "active" : ""}`}
            href="#/settings"
            title={route.page === "settings" ? "Close Settings" : "Settings"}
            // A second click closes Settings, back to where you were.
            onClick={(e) => {
              if (route.page !== "settings") return;
              e.preventDefault();
              leaveSettings();
            }}
          >
            <SettingsIcon size={15} />
            <span className="btn-label">Settings</span>
          </a>
          <UpdateBadge />
          <RuntimeBadge runtime={runtime} />
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
          {route.page === "project" ? <ProjectView projectId={route.id} /> : route.page === "settings" ? <Settings /> : <Home runtime={runtime} />}
        </motion.main>
      </AnimatePresence>
    </div>
  );
}

/** The project name in the breadcrumb: opens a list of the other projects to jump to. */
function ProjectSwitcher({ currentId, name }: { currentId: string; name: string | null }) {
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
      <button className="switcher-button current" onClick={() => setOpen((o) => !o)} title="Switch project" aria-haspopup="menu" aria-expanded={open}>
        <span className="ellipsis">{name ?? "…"}</span>
        <ChevronDown size={13} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu-list left" role="menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.1 }}>
            {projects === null && <div className="menu-note">Loading…</div>}
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
              All projects
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

function RuntimeBadge({ runtime }: { runtime: RuntimeInfo | null }) {
  if (!runtime) return <span className="runtime">Connecting…</span>;
  const memory = runtime.memoryMB
    ? runtime.memoryMB >= 1024
      ? `${(runtime.memoryMB / 1024).toFixed(1)} GB`
      : `${runtime.memoryMB} MB`
    : null;
  const label =
    runtime.state === "running"
      ? `OpenCode ${runtime.version ?? ""}`
      : runtime.state === "starting"
        ? "Starting OpenCode…"
        : runtime.state === "crashed"
          ? "OpenCode restarting"
          : "OpenCode stopped";
  return (
    <span className="runtime" title={[runtime.error, memory && `Memory: ${memory}`].filter(Boolean).join("\n") || undefined}>
      <span className={`dot ${runtime.state}`} />
      <span className="runtime-label">{label}</span>
      {memory && runtime.state === "running" && <span className="subtle tnum">{memory}</span>}
    </span>
  );
}
