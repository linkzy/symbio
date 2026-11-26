import { useEffect, useState } from "react";
import { Bug } from "lucide-react";
import { api } from "./api";
import { useI18n } from "./i18n";

const NEW_BUG = "https://github.com/linkzy/symbio/issues/new";

/** The OS and browser as the browser reports them (the UI runs in the same browser the person uses). */
function osName(): string {
  const data = (navigator as any).userAgentData;
  return data?.platform || navigator.platform || "unknown";
}

/**
 * The link to a new bug report (the issue form, .github/ISSUE_TEMPLATE/bug_report.yml) with what helps to reproduce
 * filled in: Symbio's version, the agent runtimes installed (with their versions) and the OS. Nothing about the
 * person's projects (names, paths, logs, keys) is added; they write what they choose.
 */
export function reportProblemUrl(env: { symbio: string | null; runtimes: string | null; os: string }): string {
  // GitHub fills an issue form's fields from query parameters named after their ids.
  const params = new URLSearchParams({ template: "bug_report.yml", os: env.os });
  if (env.symbio) params.set("version", env.symbio);
  if (env.runtimes) params.set("runtime", env.runtimes);
  return `${NEW_BUG}?${params}`;
}

/** The "Report a problem" link, with the versions filled in once Symbio has told us (it works without them). */
export function useReportProblemUrl(): string {
  const [symbio, setSymbio] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<string | null>(null);
  useEffect(() => {
    api.update().then((u) => setSymbio(u.current)).catch(() => {});
    api
      .runtimes()
      .then((list) => {
        const installed = list.filter((r) => r.installed).map((r) => `${r.label} ${r.installedVersion ?? r.version ?? ""}`.trim());
        setRuntimes(installed.length ? installed.join(", ") : "none installed");
      })
      .catch(() => {});
  }, []);
  return reportProblemUrl({ symbio, runtimes, os: osName() });
}

/** Top bar: opens a new bug report in a new tab. */
export function ReportProblemLink() {
  const href = useReportProblemUrl();
  const { t } = useI18n();
  return (
    <a className="btn ghost sm" href={href} target="_blank" rel="noreferrer" title={t("usage.report.linkTitle")}>
      <Bug size={15} />
      <span className="btn-label">{t("usage.report.title")}</span>
    </a>
  );
}

/** Settings → Report a problem. */
export function ReportProblemSection() {
  const href = useReportProblemUrl();
  const { t } = useI18n();
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{t("usage.report.title")}</h2>
          <p>{t("usage.report.intro")}</p>
        </div>
      </div>
      <div className="section-body" style={{ padding: "10px 16px 14px" }}>
        <a className="btn sm" href={href} target="_blank" rel="noreferrer">
          <Bug size={14} />
          {t("usage.report.title")}
        </a>
      </div>
    </section>
  );
}
