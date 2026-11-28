import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api, type UpdateState } from "./api";
import { CopyButton } from "./ui";
import { useI18n } from "./i18n";

const LINKS = {
  site: "https://symbio.linkzy.dev",
  privacy: "https://symbio.linkzy.dev/privacy",
  repo: "https://github.com/linkzy/symbio",
  changelog: "https://github.com/linkzy/symbio/blob/main/CHANGELOG.md",
  details: "https://github.com/linkzy/symbio/blob/main/docs/security.md#update-checks",
  usage: "https://github.com/linkzy/symbio/blob/main/docs/usage.md",
};

/**
 * Settings → About: what Symbio is, what leaves this computer, and the usage statistics the update
 * checks carry (the install id), with the switch to turn them off. It says exactly what's sent;
 * when that changes, so do this page and docs/security.md.
 */
export function AboutSection({ help }: { help?: ReactNode } = {}) {
  const { t } = useI18n();
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<Awaited<ReturnType<typeof api.vault>> | null>(null);
  useEffect(() => {
    api.update().then(setState).catch((e) => setError(e.message));
    api.vault().then(setVault).catch(() => {});
  }, []);

  async function setStatistics(on: boolean) {
    setError(null);
    try {
      setState(await api.setInstallId(on));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noreferrer" className="row" style={{ gap: 4, display: "inline-flex" }}>
      {label}
      <ExternalLink size={12} />
    </a>
  );

  return (
    <>
      <section className="section" id="about">
        <div className="section-head">
          <div>
            <h2>{t("about.title")}</h2>
            <p>{t("about.desc")}</p>
          </div>
        </div>
        <div className="stack about-body">
          <div className="small">
            {t("about.version", { version: state?.current ?? "…" })} · {t("about.license")}
          </div>
          <div className="row small" style={{ gap: 16, flexWrap: "wrap" }}>
            {link(LINKS.site, t("about.links.site"))}
            {link(LINKS.repo, t("about.links.repo"))}
            {link(LINKS.changelog, t("about.links.changelog"))}
          </div>
        </div>
      </section>

      {help}

      <section className="section" id="privacy">
        <div className="section-head">
          <div>
            <h2>{t("about.privacy.title")}</h2>
            <p>{t("about.privacy.desc")}</p>
          </div>
        </div>
        <div className="stack about-body">
          <ul className="about-list small">
            <li>{t("about.privacy.models")}</li>
            <li>{t("about.privacy.updates")}</li>
            <li>{t("about.privacy.notifications")}</li>
            <li>{t("about.privacy.remote")}</li>
            {vault && (
              <li data-testid="vault-store">
                {t(`about.privacy.vault.${vault.store}`)}
                {vault.error && <span className="subtle"> {vault.error}</span>}
              </li>
            )}
            <li>{t("about.privacy.nothingElse")}</li>
          </ul>
          <div className="small">{link(LINKS.privacy, t("about.privacy.policy"))}</div>
        </div>
      </section>

      <section className="section" id="telemetry" data-testid="telemetry">
        <div className="section-head">
          <div>
            <h2>{t("about.telemetry.title")}</h2>
            <p>{t("about.telemetry.desc")}</p>
          </div>
        </div>
        <div className="stack about-body">
          <ul className="about-list small">
            <li>{t("about.telemetry.what")}</li>
            <li>{t("about.telemetry.server")}</li>
            <li>{t("about.telemetry.never")}</li>
          </ul>
          <p className="small">{t("about.telemetry.why")}</p>
          {state?.install === "npm" ? (
            <>
              {state.installId && (
                <div className="small row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {t("about.telemetry.yours")} <code>{state.installId}</code>
                  <CopyButton text={state.installId} />
                </div>
              )}
              <label className="choice">
                <input type="checkbox" checked={!!state.installId} onChange={(e) => void setStatistics(e.target.checked)} />
                <span className="choice-body">
                  <span className="choice-title">{t("about.telemetry.switch")}</span>
                  <span className="choice-desc">{state.installId ? t("about.telemetry.on") : t("about.telemetry.off")}</span>
                </span>
              </label>
            </>
          ) : (
            state && <p className="small subtle">{t("about.telemetry.dev")}</p>
          )}
          <div className="small">{link(LINKS.details, t("about.telemetry.details"))}</div>
          {error && <div className="error">{error}</div>}
        </div>
      </section>
    </>
  );
}

/** Settings → About: starting and stopping Symbio (there's no icon on macOS and Linux), and the usage guide. */
export function UsingSection() {
  const { t } = useI18n();
  return (
    <section className="section" id="using">
      <div className="section-head">
        <div>
          <h2>{t("about.using.title")}</h2>
          <p>{t("about.using.desc")}</p>
        </div>
      </div>
      <div className="stack about-body">
        <ul className="about-list small">
          <li>{t("about.using.start")}</li>
          <li>{t("about.using.stop")}</li>
        </ul>
        <div className="small">
          <a href={LINKS.usage} target="_blank" rel="noreferrer" className="row" style={{ gap: 4, display: "inline-flex" }}>
            {t("about.using.guide")}
            <ExternalLink size={12} />
          </a>
        </div>
      </div>
    </section>
  );
}
