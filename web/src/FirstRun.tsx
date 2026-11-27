import { useEffect, useState } from "react";
import { Check, Download, ExternalLink, Loader2, Plus } from "lucide-react";
import { api, type RuntimeView } from "./api";
import { useI18n } from "./i18n";
import { CopilotSignIn, size } from "./Runtimes";

/**
 * Whether the runtimes installed can run agents yet: OpenCode needs a model provider connected,
 * GitHub Copilot a signed-in account. null while it isn't known.
 */
export function useReadiness(runtimes: RuntimeView[] | null): { ready: boolean | null; models: Record<string, number | null> } {
  const installed = runtimes?.filter((r) => r.installed) ?? [];
  const opencode = installed.some((r) => r.kind === "opencode");
  const [openCodeModels, setOpenCodeModels] = useState<number | null>(null);
  useEffect(() => {
    if (!opencode) return;
    let stop = false;
    const load = () =>
      api
        .providers()
        .then((p) => !stop && setOpenCodeModels(p.connected.reduce((n, c) => n + c.models, 0)))
        .catch(() => {});
    void load();
    // A provider connected in Settings (another page, or another tab) shows here when it's back.
    window.addEventListener("focus", load);
    return () => {
      stop = true;
      window.removeEventListener("focus", load);
    };
  }, [opencode]);
  const models: Record<string, number | null> = {};
  for (const r of installed) models[r.kind] = r.kind === "opencode" ? openCodeModels : r.login ? 1 : r.state === "running" ? 0 : null;
  if (!runtimes) return { ready: null, models };
  const ready = installed.some((r) => (models[r.kind] ?? 0) > 0);
  const unknown = installed.some((r) => models[r.kind] === null);
  return { ready: ready ? true : unknown ? null : false, models };
}

/**
 * The first run, before any project: what Symbio needs, in the order it's done. 1. what agents
 * run on (an agent runtime: installed for Symbio, or the one already on the computer), 2. the
 * models they use (a provider, or a Copilot sign-in), 3. git (optional), then a project.
 */
export function FirstRun({ runtimes, reload, onNewProject }: { runtimes: RuntimeView[]; reload: () => void; onNewProject: () => void }) {
  const { t } = useI18n();
  const installed = runtimes.filter((r) => r.installed);
  const { ready, models } = useReadiness(runtimes);
  const [setup, setSetup] = useState<{ git: boolean; gitInstaller: "winget" | null } | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  useEffect(() => {
    void api.setup().then(setSetup).catch(() => {});
  }, []);

  // Copilot, once installed, says whether it's signed in only while running: check it right away.
  const copilot = installed.find((r) => r.kind === "copilot");
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!copilot || checked || copilot.state === "running") return;
    setChecked(true);
    void api.checkCopilot().catch(() => {}).finally(reload);
  }, [copilot, checked]); // eslint-disable-line react-hooks/exhaustive-deps

  async function installGit() {
    setGitBusy(true);
    setGitError(null);
    try {
      await api.installGit();
      setSetup(await api.setup());
    } catch (e) {
      setGitError((e as Error).message);
    } finally {
      setGitBusy(false);
    }
  }

  const step1 = installed.length > 0;
  return (
    <div className="first-run section" style={{ padding: 16 }} data-testid="first-run">
      <div>
        <h2>{t("firstRun.title")}</h2>
        <p>{t("firstRun.intro")}</p>
      </div>
      <ol className="setup-steps">
        <li className={step1 ? "done" : "current"} data-step="runtime">
          <div className="setup-step-title">{step1 ? <Check size={14} /> : <span className="setup-step-n">1</span>}{t("firstRun.runtime.title")}</div>
          {step1 ? (
            <div className="small">
              {installed.map((r) => (
                <div key={r.kind}>
                  {r.label} · {r.source === "path" ? t("firstRun.runtime.fromComputer") : t("firstRun.runtime.forSymbio")}
                  {(r.installedVersion ?? r.version) ? ` · ${r.installedVersion ?? r.version}` : ""}
                </div>
              ))}
              <div className="subtle">{t("firstRun.runtime.more")}</div>
            </div>
          ) : (
            <>
              <p>{t("firstRun.runtime.what")}</p>
              <div className="runtime-cards">
                {runtimes.map((r) => (
                  <RuntimeChoice key={r.kind} view={r} onChange={reload} />
                ))}
              </div>
            </>
          )}
        </li>

        <li className={!step1 ? "pending" : ready ? "done" : "current"} data-step="models">
          <div className="setup-step-title">{step1 && ready ? <Check size={14} /> : <span className="setup-step-n">2</span>}{t("firstRun.models.title")}</div>
          {step1 &&
            installed.map((r) =>
              r.kind === "opencode" ? (
                <div key={r.kind} className="small">
                  {(models.opencode ?? 0) > 0 ? (
                    t("firstRun.models.opencodeReady", { n: models.opencode ?? 0 })
                  ) : (
                    <div className="stack" style={{ gap: 8 }}>
                      <span>{t("firstRun.models.opencode")}</span>
                      <a className="btn sm primary" href="#/settings/agents" style={{ alignSelf: "flex-start" }}>
                        {t("home.connectProvider")}
                      </a>
                    </div>
                  )}
                </div>
              ) : r.kind === "copilot" ? (
                <div key={r.kind} className="small stack" style={{ gap: 6 }}>
                  {!r.login && <span>{t("firstRun.models.copilot")}</span>}
                  <CopilotSignIn view={r} onChange={reload} />
                </div>
              ) : null,
            )}
          {!step1 && <p className="subtle">{t("firstRun.models.later")}</p>}
        </li>

        <li className={setup?.git ? "done" : "optional"} data-step="git">
          <div className="setup-step-title">
            {setup?.git ? <Check size={14} /> : <span className="setup-step-n">3</span>}
            {t("firstRun.git.title")}
          </div>
          {setup && setup.git ? (
            <div className="small">{t("firstRun.git.ready")}</div>
          ) : setup ? (
            <div className="stack small" style={{ gap: 8 }}>
              <span>{t("firstRun.git.missing")}</span>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {setup.gitInstaller && (
                  <button className="btn sm" disabled={gitBusy} onClick={installGit}>
                    {gitBusy ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                    {gitBusy ? t("newProject.noGit.installing") : t("newProject.noGit.install")}
                  </button>
                )}
                <a className="btn sm" href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">
                  <ExternalLink size={13} />
                  {t("newProject.noGit.download")}
                </a>
              </div>
              {gitBusy && <span className="subtle">{t("newProject.noGit.installingHint")}</span>}
              {gitError && <div className="error">{t("newProject.noGit.installFailed", { error: gitError })}</div>}
            </div>
          ) : null}
        </li>

        <li className={step1 && ready ? "current" : "pending"} data-step="project">
          <div className="setup-step-title">
            <span className="setup-step-n">4</span>
            {t("firstRun.project.title")}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn primary sm" disabled={!step1 || !ready} onClick={onNewProject}>
              <Plus size={14} />
              {t("home.newProject")}
            </button>
            <span className="subtle small">{step1 && ready ? t("firstRun.project.ready") : t("firstRun.project.waiting")}</span>
          </div>
        </li>
      </ol>
    </div>
  );
}

/** One runtime on the first run: install it for Symbio, or use the copy already on the computer. */
function RuntimeChoice({ view, onChange }: { view: RuntimeView; onChange: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  }
  const copy = view.computer;
  const version = copy?.version ? ` ${copy.version}` : "";
  const known = view.kind === "opencode" || view.kind === "copilot";
  return (
    <div className="runtime-card" data-runtime={view.kind}>
      <div className="list-title">{view.label}</div>
      <p className="runtime-card-desc">{known ? t(`agents.runtimes.desc.${view.kind}`) : view.description}</p>
      <p className="runtime-card-desc subtle">{t("agents.runtimes.needs", { needs: known ? t(`agents.runtimes.needs.${view.kind}`) : view.needs })}</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn sm primary" disabled={busy || view.installing} onClick={() => act(() => api.installRuntime(view.kind))}>
          <Download size={13} />
          {t("firstRun.runtime.install", { size: size(view.sizeMB) })}
        </button>
        {copy?.usable && (
          <button className="btn sm" disabled={busy || view.installing} onClick={() => act(() => api.setFromComputer(view.kind, true))}>
            {t("firstRun.runtime.useComputer", { version })}
          </button>
        )}
      </div>
      <p className="runtime-card-desc subtle">{t("firstRun.runtime.separate")}</p>
      {copy?.usable && (
        <p className="runtime-card-desc subtle">
          {t("firstRun.runtime.computerNote", { version, tested: view.testedVersion ?? "?" })}
        </p>
      )}
      {copy && !copy.usable && (
        <p className="runtime-card-desc subtle" data-testid="computer-copy">
          {t("agents.runtimes.computer.unusable", { name: view.label, version })}
        </p>
      )}
      {view.installing && (
        <div className="runtime-install-log">
          <Loader2 size={13} className="spin" />
          <span className="ellipsis">{view.installLog.at(-1) ?? t("agents.runtimes.downloading")}</span>
        </div>
      )}
      {(error || view.installError) && <div className="error">{error ?? t("agents.runtimes.installError", { error: view.installError ?? "" })}</div>}
    </div>
  );
}
