import { MessageSquare } from "lucide-react";
import { useI18n } from "./i18n";

const DISCUSSIONS = "https://github.com/linkzy/symbio/discussions";

/** Settings → Feedback: opens the repository's Discussions, so people can share what they think without filing a bug. */
export function FeedbackSection() {
  const { t } = useI18n();
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{t("usage.feedback.title")}</h2>
          <p>{t("usage.feedback.intro")}</p>
        </div>
      </div>
      <div className="section-body" style={{ padding: "10px 16px 14px", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a className="btn sm" href={`${DISCUSSIONS}/new?category=ideas`} target="_blank" rel="noreferrer">
          <MessageSquare size={14} />
          {t("usage.feedback.give")}
        </a>
        <a className="btn ghost sm" href={`${DISCUSSIONS}/new?category=q-a`} target="_blank" rel="noreferrer">
          {t("usage.feedback.ask")}
        </a>
      </div>
    </section>
  );
}
