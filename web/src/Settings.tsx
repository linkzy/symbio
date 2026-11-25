import { SkillsSection } from "./Skills";
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowLeft, Bell, Bot, Check, Coins, LifeBuoy, Monitor, Pencil, Plug, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { SettingsTabs, settingsHref, useSettingsGroup, type SettingsGroupId } from "./SettingsTabs";
import { api, type ConnectionView, type FtpSecurity } from "./api";
import { ConnIcon } from "./ConnectionsPicker";
import { ProvidersSection } from "./Providers";
import { AppearanceSection } from "./Appearance";
import { RuntimesSection, useRuntimes } from "./Runtimes";
import { CostsSection, PricesSection } from "./Usage";
import { RemoteSection } from "./Remote";
import { UpdatesSection } from "./Updates";
import { NotificationsSection } from "./Notifications";
import { FeedbackSection } from "./Feedback";
import { ReportProblemSection } from "./ReportProblem";
import { Dialog, EmptyState } from "./ui";
import { useI18n } from "./i18n";

/** Where the user was before Settings (a project, the project list…). */
export function previousPage(): string {
  const previous = sessionStorage.getItem("symbio:previous-page");
  return previous && !previous.startsWith("#/settings") ? previous : "#/";
}

export function leaveSettings() {
  location.hash = previousPage();
}

/** "Back to <project>" / "Back to projects": where Back (and Escape) take you. */
function useBackLabel(): string {
  const { t } = useI18n();
  const target = previousPage();
  const id = target.match(/^#\/p\/([\w-]+)/)?.[1];
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (id) api.project(id).then((p) => setName(p.name)).catch(() => {});
  }, [id]);
  if (!id) return t("app.backToProjects");
  return name ? t("app.backTo", { name }) : t("app.backToProject");
}

export function Settings() {
  const { t } = useI18n();
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [editing, setEditing] = useState<ConnectionView | `new-${ConnectionView["type"]}` | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backLabel = useBackLabel();
  const openCodeInstalled = !!useRuntimes().runtimes?.find((r) => r.kind === "opencode")?.installed;
  const group = useSettingsGroup();
  const groups: { id: SettingsGroupId; label: string; icon: ReactNode }[] = [
    { id: "agents", label: t("settings.group.agents"), icon: <Bot size={14} /> },
    { id: "notifications", label: t("settings.group.notifications"), icon: <Bell size={14} /> },
    { id: "connections", label: t("settings.group.connections"), icon: <Plug size={14} /> },
    { id: "usage", label: t("settings.group.usage"), icon: <Coins size={14} /> },
    { id: "computer", label: t("settings.group.computer"), icon: <Monitor size={14} /> },
    { id: "help", label: t("settings.group.help"), icon: <LifeBuoy size={14} /> },
  ];

  // Escape leaves Settings, unless it's closing a dialog or the cursor is in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".backdrop")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      leaveSettings();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const load = () =>
    api
      .connections()
      .then(setConnections)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function test(id: string) {
    setTesting(id);
    try {
      await api.testConnection(id);
      await load();
    } finally {
      setTesting(null);
    }
  }

  async function remove(c: ConnectionView) {
    if (!confirm(t("settings.connections.deleteConfirm", { name: c.name }))) return;
    await api.deleteConnection(c.id).catch((e) => alert(e.message));
    await load();
  }

  return (
    <div className="page-inner">
      <div>
        <button className="btn sm settings-back" onClick={leaveSettings} title={t("common.esc")}>
          <ArrowLeft size={14} />
          {backLabel}
        </button>
        <div className="page-head">
          <div>
            <h1>{t("settings.title")}</h1>
            <p>{t("settings.subtitle")}</p>
          </div>
        </div>
        <SettingsTabs groups={groups} current={group} href={settingsHref} />
      </div>

      {group === "agents" && (
        <>
          <RuntimesSection />
          {/* Model providers are OpenCode's: shown once it's installed. */}
          {openCodeInstalled && <ProvidersSection />}
          <SkillsSection />
        </>
      )}

      {group === "notifications" && <NotificationsSection />}

      {group === "connections" && (
        <section className="section">
          <div className="section-head">
            <div>
              <h2>{t("settings.connections.title")}</h2>
              <p>{t("settings.connections.desc")}</p>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => setEditing("new-github")}>
                <Plus size={13} />
                GitHub
              </button>
              <button className="btn sm" onClick={() => setEditing("new-azure")}>
                <Plus size={13} />
                Azure DevOps
              </button>
              <button className="btn sm" onClick={() => setEditing("new-server")}>
                <Plus size={13} />
                Server
              </button>
              <button className="btn sm" onClick={() => setEditing("new-ftp")}>
                <Plus size={13} />
                FTP
              </button>
            </div>
          </div>

          {error && (
            <div style={{ padding: 12 }}>
              <div className="error">{error}</div>
            </div>
          )}
          {connections?.length === 0 && (
            <EmptyState icon={<Plug size={20} />} title={t("settings.connections.none.title")}>
              {t("settings.connections.none.body")}
            </EmptyState>
          )}

          {connections && connections.length > 0 && (
            <div className="section-body">
              {connections.map((c) => (
                <div key={c.id} className="list-row">
                  <ConnIcon type={c.type} />
                  <div className="grow">
                    <div className="list-title">{c.name}</div>
                    <div className="list-sub ellipsis">
                      {c.type === "github"
                        ? c.account
                          ? `${t("settings.connections.github.label")} · ${c.account}`
                          : `${t("settings.connections.github.label")} · ${t("settings.connections.notTested")}`
                        : c.type === "azure"
                          ? `${t("settings.connections.azure.label")} · ${c.organization}${c.account ? ` · ${c.account}` : ` · ${t("settings.connections.notTested")}`}`
                          : c.type === "ftp"
                            ? `${t("settings.connections.ftp.label")} · ${c.username}@${c.host}${c.port !== 21 ? `:${c.port}` : ""} · ${c.security === "none" ? t("settings.connections.ftp.unencrypted") : c.security === "implicit" ? t("settings.connections.ftp.implicit") : t("settings.connections.ftp.ftps")}`
                            : `${c.username}@${c.host}${c.port !== 22 ? `:${c.port}` : ""} · ${c.auth === "password" ? t("settings.connections.auth.password") : c.keyPath ? t("settings.connections.auth.keyFile", { path: c.keyPath }) : t("settings.connections.auth.storedKey")}`}
                    </div>
                    {c.lastTest && (
                      <div className={`conn-test ${c.lastTest.ok ? "ok" : "bad"}`}>
                        {c.lastTest.ok ? <Check size={12} /> : <X size={12} />}
                        {c.lastTest.message}
                      </div>
                    )}
                  </div>
                  <button className="btn sm" onClick={() => test(c.id)} disabled={testing === c.id}>
                    <ShieldCheck size={13} />
                    {testing === c.id ? t("common.testing") : t("common.test")}
                  </button>
                  <button className="btn ghost icon sm" onClick={() => setEditing(c)} title={t("settings.connections.edit")}>
                    <Pencil size={13} />
                  </button>
                  <button className="btn ghost icon sm" onClick={() => remove(c)} title={t("settings.connections.delete")}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {group === "usage" && (
        <>
          <CostsSection />
          <PricesSection />
        </>
      )}

      {group === "computer" && (
        <>
          <RemoteSection />
          <UpdatesSection />
          <AppearanceSection />
        </>
      )}

      {group === "help" && (
        <>
          <FeedbackSection />
          <ReportProblemSection />
        </>
      )}

      <AnimatePresence>
        {editing && (
          <ConnectionForm
            existing={typeof editing === "string" ? null : editing}
            type={typeof editing === "string" ? (editing.slice(4) as ConnectionView["type"]) : editing.type}
            onClose={() => setEditing(null)}
            onSaved={async (id) => {
              setEditing(null);
              await load();
              void test(id);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ConnectionForm({
  existing,
  type,
  onClose,
  onSaved,
}: {
  existing: ConnectionView | null;
  type: ConnectionView["type"];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const server = existing?.type === "server" ? existing : null;
  const ftp = existing?.type === "ftp" ? existing : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [token, setToken] = useState("");
  const [organization, setOrganization] = useState(existing?.type === "azure" ? existing.organization : "");
  const [host, setHost] = useState(server?.host ?? ftp?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? ftp?.port ?? (type === "ftp" ? 21 : 22)));
  const [username, setUsername] = useState(server?.username ?? ftp?.username ?? "");
  const [security, setSecurity] = useState<FtpSecurity>(ftp?.security ?? "explicit");
  const [acceptAnyCertificate, setAcceptAnyCertificate] = useState(ftp?.acceptAnyCertificate ?? false);
  const [auth, setAuth] = useState<"key" | "password">(server?.auth ?? "key");
  const [keySource, setKeySource] = useState<"file" | "paste">(server?.keyPath ? "file" : server ? "paste" : "file");
  const [keyPath, setKeyPath] = useState(server?.keyPath ?? "~/.ssh/id_ed25519");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = (field: string) => !!existing?.secrets?.[field];
  const keep = (field: string) => (stored(field) ? t("settings.connections.keepSaved") : "");

  async function save() {
    setSaving(true);
    setError(null);
    const body =
      type === "github"
        ? { type, name, token }
        : type === "azure"
          ? { type, name, organization, token }
          : type === "ftp"
            ? { type, name, host, port: Number(port) || 21, username, security, acceptAnyCertificate, password: password || undefined }
            : {
            type,
            name,
            host,
            port: Number(port) || 22,
            username,
            auth,
            keyPath: auth === "key" && keySource === "file" ? keyPath : null,
            privateKey: auth === "key" && keySource === "paste" ? privateKey : undefined,
            passphrase: auth === "key" ? passphrase : undefined,
            password: auth === "password" ? password : undefined,
          };
    try {
      const saved = existing ? await api.updateConnection(existing.id, body) : await api.createConnection(body);
      onSaved(saved.id);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={t(`settings.connections.title.${existing ? "edit" : "new"}.${type}`)}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? t("common.saving") : t("settings.connections.saveAndTest")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("settings.connections.name")}</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t(`settings.connections.name.${type}`)} />
      </label>

      {type === "github" ? (
        <label className="field">
          <span>{t("settings.connections.token")}</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={keep("token") || "github_pat_… or ghp_…"} />
          <span className="hint">{t("settings.connections.token.hint.github")}</span>
        </label>
      ) : type === "azure" ? (
        <>
          <label className="field">
            <span>{t("settings.connections.azure.org")}</span>
            <input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder={t("settings.connections.azure.orgPlaceholder")} />
            <span className="hint">{t("settings.connections.azure.orgHint")}</span>
          </label>
          <label className="field">
            <span>{t("settings.connections.token")}</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={keep("token") || "Paste the token"} />
            <span className="hint">{t("settings.connections.token.hint.azure")}</span>
          </label>
        </>
      ) : type === "ftp" ? (
        <>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>{t("settings.connections.host")}</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ftp.example.com" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>{t("settings.connections.port")}</span>
              <input value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
          </div>
          <div className="field">
            <span>{t("settings.connections.security")}</span>
            <div className="seg">
              {(
                [
                  ["explicit", t("settings.connections.security.explicit"), "21"],
                  ["implicit", t("settings.connections.security.implicit"), "990"],
                  ["none", t("settings.connections.security.none"), "21"],
                ] as const
              ).map(([value, label, defaultPort]) => (
                <button
                  key={value}
                  className={security === value ? "on" : ""}
                  onClick={() => {
                    setSecurity(value);
                    if (port === "21" || port === "990") setPort(defaultPort);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="hint">
              {security === "none"
                ? t("settings.connections.security.hint.none")
                : security === "implicit"
                  ? t("settings.connections.security.hint.implicit")
                  : t("settings.connections.security.hint.explicit")}
            </span>
          </div>
          {security !== "none" && (
            <label className="check">
              <input type="checkbox" checked={acceptAnyCertificate} onChange={(e) => setAcceptAnyCertificate(e.target.checked)} />
              {t("settings.connections.acceptAnyCert")}
            </label>
          )}
          <label className="field">
            <span>{t("settings.connections.user")}</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="user@example.com" />
          </label>
          <label className="field">
            <span>{t("settings.connections.password")}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={keep("password")} />
            <span className="hint">{t("settings.connections.ftp.passwordHint")}</span>
          </label>
        </>
      ) : (
        <>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>{t("settings.connections.host")}</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.10 or vps.example.com" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>{t("settings.connections.port")}</span>
              <input value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>{t("settings.connections.user")}</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" />
          </label>
          <div className="field">
            <span>{t("settings.connections.auth")}</span>
            <div className="seg">
              <button className={auth === "key" ? "on" : ""} onClick={() => setAuth("key")}>
                {t("settings.connections.auth.sshKey")}
              </button>
              <button className={auth === "password" ? "on" : ""} onClick={() => setAuth("password")}>
                {t("settings.connections.auth.passwordLabel")}
              </button>
            </div>
          </div>
          {auth === "key" ? (
            <>
              <div className="seg">
                <button className={keySource === "file" ? "on" : ""} onClick={() => setKeySource("file")}>
                  {t("settings.connections.keySource.file")}
                </button>
                <button className={keySource === "paste" ? "on" : ""} onClick={() => setKeySource("paste")}>
                  {t("settings.connections.keySource.paste")}
                </button>
              </div>
              {keySource === "file" ? (
                <label className="field">
                  <span>{t("settings.connections.keyFile")}</span>
                  <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
                </label>
              ) : (
                <label className="field">
                  <span>{t("settings.connections.privateKey")}</span>
                  <textarea
                    rows={5}
                    className="mono"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder={keep("privateKey") || "-----BEGIN OPENSSH PRIVATE KEY-----"}
                  />
                  <span className="hint">{t("settings.connections.privateKey.stored")}</span>
                </label>
              )}
              <label className="field">
                <span>{t("settings.connections.passphrase")}</span>
                <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={keep("passphrase")} />
              </label>
            </>
          ) : (
            <label className="field">
              <span>{t("settings.connections.password")}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={keep("password")} />
            </label>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
