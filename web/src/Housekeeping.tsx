import { useEffect, useState } from "react";
import { Eraser, RefreshCw } from "lucide-react";
import { api, type HousekeepingReport, type Project } from "./api";
import { useI18n } from "./i18n";

const gb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** Project settings: backups, work that exists only on this machine, helpers' disk use. */
export function HousekeepingSection({ project }: { project: Project }) {
  const { t } = useI18n();
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
          <h2>{t("usage.housekeeping.title")}</h2>
          <p>
            {t("usage.housekeeping.intro.before")} <code>~/.symbio/backups</code>
            {t("usage.housekeeping.intro.after")}
          </p>
        </div>
        <button className="btn sm" onClick={check} disabled={checking}>
          <RefreshCw size={13} className={checking ? "spin" : undefined} />
          {checking ? t("usage.checking") : t("usage.checkNow")}
        </button>
      </div>
      {error && (
        <div style={{ padding: 12 }}>
          <div className="error">{error}</div>
        </div>
      )}
      {!report ? (
        !error && <div className="section-empty">{t("usage.housekeeping.measuring")}</div>
      ) : (
        <div className="stack" style={{ padding: 16, gap: 16 }}>
          <div className="field">
            <span>{t("usage.housekeeping.lastBackup")}</span>
            <div className="small">{report.lastBackup ?? t("usage.housekeeping.noBackup")}</div>
          </div>

          <div className="field">
            <span>{t("usage.housekeeping.unpushed")}</span>
            {!report.remote ? (
              <div className="small subtle">{t("usage.housekeeping.noRemote")}</div>
            ) : report.unpushed.length === 0 ? (
              <div className="small">{t("usage.housekeeping.allPushed", { remote: report.remote })}</div>
            ) : (
              <div className="list-compact">
                {report.unpushed.map((b) => (
                  <div key={b.branch} className="small">
                    <code>{b.branch}</code> — {t(b.commits === 1 ? "usage.housekeeping.commit" : "usage.housekeeping.commits", { n: b.commits, remote: report.remote! })}
                    <span className="subtle"> · {t("usage.housekeeping.latest", { latest: b.latest })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <span>
              {t("usage.housekeeping.folders")}
              {buildTotal > 0 ? ` · ${t("usage.housekeeping.buildTotal", { size: gb(buildTotal) })}` : ""}
            </span>
            {report.folders.length === 0 ? (
              <div className="small subtle">{t("usage.housekeeping.noFolders")}</div>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t("usage.housekeeping.helper")}</th>
                    <th className="num">{t("usage.housekeeping.folder")}</th>
                    <th className="num">{t("usage.housekeeping.buildOutputs")}</th>
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
                            title={f.status === "busy" || f.status === "waiting" ? t("usage.housekeeping.idleOnly") : t("usage.housekeeping.cleanTitle")}
                            onClick={() => clean(f.agentId)}
                          >
                            <Eraser size={13} />
                            {cleaning === f.agentId ? t("usage.housekeeping.cleaning") : t("usage.housekeeping.clean")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="small subtle">{t("usage.housekeeping.checked", { date: new Date(report.checkedAt).toLocaleString() })}</div>
        </div>
      )}
    </section>
  );
}
