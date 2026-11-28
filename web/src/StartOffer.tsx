import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { MessageCircleQuestion, Play } from "lucide-react";
import { api, type Project, type StartChoice } from "./api";
import { Md } from "./files";
import { useI18n, type MessageKey } from "./i18n";

// How a piece of work starts in a light project (team/start-offer.ts): core's few lines, then the
// human's pick. Go ahead is the default; in a project that lets core decide, Symbio picks it on its
// own after a few minutes, and the card says when.

const WAIT_MS = 5 * 60_000;
const CHOICES: { id: StartChoice; label: MessageKey; desc: MessageKey }[] = [
  { id: "go", label: "start.go", desc: "start.go.desc" },
  { id: "brainstorm", label: "start.brainstorm", desc: "start.brainstorm.desc" },
  { id: "briefing", label: "start.briefing", desc: "start.briefing.desc" },
  { id: "grill", label: "start.grill", desc: "start.grill.desc" },
];

export function StartOfferCard({ project, agentId }: { project: Project; agentId: string }) {
  const { t } = useI18n();
  const offer = project.startOffer;
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<StartChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!offer) return null;

  const left = Math.max(0, offer.at + WAIT_MS - now);
  const clock = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;

  async function pick(choice: StartChoice) {
    setBusy(choice);
    setError(null);
    try {
      await api.chooseStart(project.id, choice);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <motion.div className="form-card start-offer" data-testid="start-offer" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <div className="form-card-head">
        <MessageCircleQuestion size={15} />
        <strong>{t("start.title")}</strong>
      </div>
      <div className="form-card-body">
        <Md text={offer.summary} projectId={project.id} agentId={agentId} />
        <div className="start-choices">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              className={`start-choice ${c.id === "go" ? "primary" : ""}`}
              disabled={busy !== null}
              onClick={() => void pick(c.id)}
              data-choice={c.id}
            >
              <span className="start-choice-title">
                {c.id === "go" && <Play size={12} />}
                {t(c.label)}
              </span>
              <span className="start-choice-desc">{t(c.desc)}</span>
            </button>
          ))}
        </div>
        <div className="small subtle">
          {project.autonomy === "decide" ? (left > 0 ? t("start.auto", { time: clock }) : t("start.autoNow")) : t("start.waits")}
          {" "}
          {t("start.orWrite")}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </motion.div>
  );
}
