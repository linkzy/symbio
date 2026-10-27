import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, KeyRound, PauseCircle, Settings as SettingsIcon } from "lucide-react";
import { api, LOCKED_EVENT, subscribe, type RuntimeInfo } from "./api";
import { Home } from "./Home";
import { ProjectView } from "./ProjectView";
import { Settings } from "./Settings";
import { EmptyState, Logo } from "./ui";

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
          Symbio
        </a>
        <nav className="crumbs">
          <ChevronRight size={14} />
          {route.page === "settings" ? (
            <span className="current">Settings</span>
          ) : route.page === "project" ? (
            <>
              <a href="#/">Projects</a>
              <ChevronRight size={14} />
              <span className="current ellipsis">{projectName ?? "…"}</span>
            </>
          ) : (
            <span className="current">Projects</span>
          )}
        </nav>
        <div className="topbar-actions">
          <button className="btn ghost sm" onClick={pauseAll} title="Pause every project that has agents working">
            <PauseCircle size={15} />
            Pause all
          </button>
          <a className={`btn ghost sm ${route.page === "settings" ? "active" : ""}`} href="#/settings" title="Settings">
            <SettingsIcon size={15} />
            Settings
          </a>
          <RuntimeBadge runtime={runtime} />
        </div>
      </header>
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
      {label}
      {memory && runtime.state === "running" && <span className="subtle tnum">{memory}</span>}
    </span>
  );
}
