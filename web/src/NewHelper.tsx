import { useState } from "react";
import { api, type Agent, type Project } from "./api";
import { modelsForRole } from "./ModelPicker";
import { Dialog } from "./ui";
import { useI18n } from "./i18n";

/**
 * A helper the human creates from the team list, to talk to directly (like opening a new chat).
 * It's a full team member: the same as one core creates with spawn_agent, without a first task.
 */
export function NewHelperDialog({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: (agent: Agent) => void }) {
  const { t } = useI18n();
  const models = modelsForRole(project, "worker");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [model, setModel] = useState(models.includes(project.coordinatorModel) ? project.coordinatorModel : models[0]);
  const [workspace, setWorkspace] = useState<"shared" | "own">("shared");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(slug);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createHelper(project.id, { name: slug, purpose: purpose.trim() || undefined, model, workspace });
      onCreated(agent);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t("newHelper.title")}
      subtitle={t("newHelper.subtitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={create} disabled={busy || !valid}>
            {busy ? t("newHelper.creating") : t("newHelper.create")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("newHelper.name")}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && !busy && void create()}
          placeholder={t("newHelper.namePlaceholder")}
        />
        {name && !valid && <span className="hint warn">{t("newHelper.nameInvalid")}</span>}
      </label>
      <label className="field">
        <span>{t("newHelper.purpose")}</span>
        <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={t("newHelper.purposePlaceholder")} />
      </label>
      <label className="field">
        <span>{t("newHelper.model")}</span>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>{t("newHelper.where")}</span>
        <div className="seg">
          <button className={workspace === "shared" ? "on" : ""} onClick={() => setWorkspace("shared")}>
            {t("newHelper.shared")}
          </button>
          <button className={workspace === "own" ? "on" : ""} onClick={() => setWorkspace("own")}>
            {t("newHelper.own")}
          </button>
        </div>
        <span className="hint">
          {workspace === "shared"
            ? t("newHelper.sharedHint")
            : t("newHelper.ownHint")}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
