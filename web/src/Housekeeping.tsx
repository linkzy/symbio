import { useEffect, useState } from "react";
import { Eraser, RefreshCw } from "lucide-react";
import { api, type HousekeepingReport, type Project } from "./api";

const gb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** Project settings: backups, work that exists only on this machine, helpers' disk use. */
export function HousekeepingSection({ project }: { project: Project }) {
  const [report, setReport] = useState<HousekeepingReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .housekeeping(project.id)
      .then(setReport)
      .catch((e) => setError(e.message));
  }, [project.id]);

  async function check() {
    setChecking(true);
    try {
      setReport(await api.checkHousekeeping(project.id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function clean(agentId: string) {
    setCleaning(agentId);
    try {
      await api.cleanHelper(project.id, agentId);
      setReport(await api.housekeeping(project.id));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCleaning(null);
    }
  }

  const buildTotal = report?.folders.reduce((s, f) => s + f.buildBytes, 0) ?? 0;
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Storage &amp; backups</h2>
          <p>
            Symbio backs up its state every day (the last 7 days, in <code>~/.symbio/backups</code>) and checks once a day for work that
            exists only on this computer and for build outputs piling up in helpers' folders. When it finds either, you and core are told.
          </p>
        </div>
        <button className="btn sm" onClick={check} disabled={checking}>
          <RefreshCw size={13} className={checking ? "spin" : undefined} />
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      {error && (
        <div style={{ padding: 12 }}>
          <div className="error">{error}</div>
        </div>
      )}
      {!report ? (
        !error && <div className="section-empty">Checking… (measuring folders can take a moment)</div>
      ) : (
        <div className="stack" style={{ padding: 16, gap: 16 }}>
          <div className="field">
            <span>Last backup</span>
            <div className="small">{report.lastBackup ?? "Not yet: the first one runs a few minutes after Symbio starts."}</div>
          </div>

          <div className="field">
            <span>Work only on this computer</span>
            {!report.remote ? (
              <div className="small subtle">This project has no git remote, so there's nowhere to push to.</div>
            ) : report.unpushed.length === 0 ? (
              <div className="small">Everything is on the remote ({report.remote}).</div>
            ) : (
              <div className="list-compact">
                {report.unpushed.map((b) => (
                  <div key={b.branch} className="small">
                    <code>{b.branch}</code> — {b.commits} commit{b.commits === 1 ? "" : "s"} not on {report.remote}
                    <span className="subtle"> · latest: {b.latest}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <span>Helpers' folders{buildTotal > 0 ? ` · ${gb(buildTotal)} of build outputs` : ""}</span>
            {report.folders.length === 0 ? (
              <div className="small subtle">No helper folders.</div>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Helper</th>
                    <th className="num">Folder</th>
                    <th className="num">Build outputs</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {report.folders.map((f) => (
                    <tr key={f.agentId}>
                      <td>
                        {f.name} <span className="subtle">({f.status})</span>
                      </td>
                      <td className="num tnum">{gb(f.bytes)}</td>
                      <td className="num tnum">{f.buildBytes > 0 ? gb(f.buildBytes) : "—"}</td>
                      <td className="num">
                        {f.buildBytes > 0 && (
                          <button
                            className="btn ghost sm"
                            disabled={cleaning !== null || f.status === "busy" || f.status === "waiting"}
                            title={f.status === "busy" || f.status === "waiting" ? "Available when the helper is idle" : "Delete git-ignored build folders (bin, obj, node_modules…); work is never touched"}
                            onClick={() => clean(f.agentId)}
                          >
                            <Eraser size={13} />
                            {cleaning === f.agentId ? "Cleaning…" : "Clean"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="small subtle">Checked {new Date(report.checkedAt).toLocaleString()}.</div>
        </div>
      )}
    </section>
  );
}
