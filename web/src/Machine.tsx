import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { AlertTriangle, Bot, Gauge, Square } from "lucide-react";
import { api, subscribe, type AgentProgram, type MachineLoad } from "./api";
import { Drawer } from "./ui";
import { useI18n } from "./i18n";

type Translate = ReturnType<typeof useI18n>["t"];

// This computer, in the top bar: its load, the programs agents started (stoppable, also from a
// phone), and what happens when it's overloaded (server: machine.ts).

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes: number) => (bytes >= 1024 ** 3 ? gb(bytes) : `${Math.round(bytes / 1024 ** 2)} MB`);

/** "overdrive · core", or the agents that were working when it started when Symbio can't tell which one. */
function ownerText(p: AgentProgram, t: Translate): string {
  if (!p.owners.length) return t("usage.machine.unknownOwner");
  if (p.owners.length === 1) return `${p.owners[0].project} · ${p.owners[0].agent}`;
  const names = p.owners.map((o) => (new Set(p.owners.map((x) => x.projectId)).size > 1 ? `${o.project} · ${o.agent}` : o.agent));
  const one = t("usage.machine.ownersOr", { names: names.slice(0, -1).join(", "), last: names[names.length - 1] });
  return new Set(p.owners.map((x) => x.projectId)).size > 1 ? t("usage.machine.oneOf", { names: one }) : `${p.owners[0].project} · ${one}`;
}

export function MachineBadge() {
  const { t } = useI18n();
  const [load, setLoad] = useState<MachineLoad | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api.machine().then(setLoad, () => {});
    return subscribe((e) => {
      if (e.type === "machine.updated") setLoad(e.load);
    });
  }, []);
  if (!load) return null;
  const used = load.memory.total - load.memory.free;
  return (
    <>
      <button
        className={`btn ghost sm machine-badge ${load.overloaded ? "overloaded" : ""}`}
        onClick={() => setOpen(true)}
        title={t("usage.machine.badgeTitle", { cpu: load.cpu, used: gb(used), total: gb(load.memory.total) })}
      >
        {load.overloaded ? <AlertTriangle size={14} /> : <Gauge size={14} />}
        <span className="btn-label tnum">{load.overloaded ? t("usage.machine.overloaded") : `CPU ${load.cpu}%`}</span>
      </button>
      <AnimatePresence>{open && <MachineDrawer load={load} onLoad={setLoad} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function MachineDrawer({ load, onLoad, onClose }: { load: MachineLoad; onLoad: (l: MachineLoad) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [programs, setPrograms] = useState<AgentProgram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);
  const [project, setProject] = useState("");
  useEffect(() => {
    let live = true;
    // CPU per program is measured between two listings: the second one, a few seconds later, has it.
    const refresh = () =>
      api.machinePrograms().then(
        (p) => live && (setPrograms(p), setError(null)),
        (e) => live && setError((e as Error).message),
      );
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  async function stop(p: AgentProgram) {
    if (!confirm(t("usage.machine.stopConfirm", { name: p.name, pid: p.pid }))) return;
    setStopping(p.pid);
    try {
      await api.stopProgram(p.pid);
      setPrograms((list) => list?.filter((x) => x.pid !== p.pid) ?? null);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setStopping(null);
    }
  }

  const used = load.memory.total - load.memory.free;
  // Programs by the project whose agent started them ("?" for ones Symbio can't tell), for the filter.
  const projectOf = (p: AgentProgram) => {
    const ids = [...new Set(p.owners.map((o) => o.projectId))];
    return ids.length === 1 ? ids[0] : "?";
  };
  const projects = new Map<string, { name: string; count: number }>();
  for (const p of programs ?? []) {
    const id = projectOf(p);
    const entry = projects.get(id) ?? { name: id === "?" ? t("usage.machine.notKnown") : p.owners[0].project, count: 0 };
    entry.count++;
    projects.set(id, entry);
  }
  const shown = programs?.filter((p) => !project || projectOf(p) === project);
  return (
    <Drawer title={t("settings.group.computer")} onClose={onClose}>
      <div className="machine">
        <div className="machine-load">
          <div>
            <span className="subtle small">{t("usage.machine.cpuThreads", { n: load.cores })}</span>
            <strong className="tnum">{load.cpu}%</strong>
            <span className="machine-bar">
              <span style={{ width: `${Math.min(100, load.cpu)}%` }} className={load.cpu >= 90 ? "high" : ""} />
            </span>
          </div>
          <div>
            <span className="subtle small">{t("usage.machine.memory")}</span>
            <strong className="tnum">
              {gb(used)} <span className="subtle">{t("usage.machine.of", { total: gb(load.memory.total) })}</span>
            </strong>
            <span className="machine-bar">
              <span style={{ width: `${Math.min(100, (100 * used) / load.memory.total)}%` }} className={load.memory.free / load.memory.total < 0.12 ? "high" : ""} />
            </span>
          </div>
        </div>
        {load.overloaded && (
          <div className="banner red">
            <AlertTriangle size={15} />
            <div className="grow">
              <strong>{t("usage.machine.overloaded")}</strong>
              {load.since ? ` ${t("usage.machine.since", { time: new Date(load.since).toLocaleTimeString() })}` : ""}.{" "}
              <span className="muted">
                {t("usage.machine.told")}
                {load.holding ? t("usage.machine.holding") : ""}
                {t("usage.machine.stopBelow")}
              </span>
            </div>
          </div>
        )}

        <div className="machine-section-title">
          <span className="grow">{t("usage.machine.programs")}</span>
          {programs && projects.size > 1 && (
            <select className="machine-filter" value={project} onChange={(e) => setProject(e.target.value)} aria-label={t("usage.machine.project")}>
              <option value="">{t("usage.machine.allProjects", { n: programs.length })}</option>
              {[...projects]
                .sort((a, b) => (a[0] === "?" ? 1 : b[0] === "?" ? -1 : a[1].name.localeCompare(b[1].name)))
                .map(([id, e]) => (
                  <option key={id} value={id}>
                    {e.name} ({e.count})
                  </option>
                ))}
            </select>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {!programs && !error && <div className="subtle small">{t("usage.machine.looking")}</div>}
        {programs?.length === 0 && <div className="subtle small">{t("usage.machine.none")}</div>}
        <div className="machine-programs">
          {shown?.map((p) => (
            <div key={p.pid} className="machine-program" data-pid={p.pid}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="machine-program-head">
                  <strong>{p.name}</strong>
                  <span className="subtle small tnum">
                    pid {p.pid} · {p.cpu === null ? "CPU …" : `CPU ${p.cpu}%`} · {mb(p.memory)}
                    {p.runtime ? ` · ${p.runtime}` : ""}
                    {p.started ? ` · ${t("usage.machine.since", { time: new Date(p.started).toLocaleTimeString() })}` : ""}
                  </span>
                </div>
                <div className="machine-owner small">
                  <Bot size={12} />
                  {ownerText(p, t)}
                </div>
                <code className="machine-command" title={p.command}>
                  {p.command}
                </code>
              </div>
              <button className="btn sm" disabled={stopping === p.pid} onClick={() => stop(p)} aria-label={t("usage.machine.stopProgram", { name: p.name, pid: p.pid })}>
                <Square size={12} />
                {t("common.stop")}
              </button>
            </div>
          ))}
        </div>

        <label className="check machine-hold">
          <input
            type="checkbox"
            checked={load.settings.holdTurns}
            onChange={(e) => api.machineSettings({ holdTurns: e.target.checked }).then(onLoad, (err) => alert(err.message))}
          />
          <span>
            {t("usage.machine.hold")}
            <span className="hint">{t("usage.machine.holdHint")}</span>
          </span>
        </label>
        <p className="subtle small">{t("usage.machine.footer")}</p>
      </div>
    </Drawer>
  );
}
