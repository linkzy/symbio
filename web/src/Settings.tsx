import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowLeft, Check, Pencil, Plug, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { api, type ConnectionView } from "./api";
import { ConnIcon } from "./ConnectionsPicker";
import { ProvidersSection } from "./Providers";
import { Dialog, EmptyState } from "./ui";

/** Back to the page the user came from (a project, the project list…), or the project list. */
function goBack() {
  const previous = sessionStorage.getItem("symbio:previous-page");
  location.hash = previous && !previous.startsWith("#/settings") ? previous : "#/";
}

export function Settings() {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [editing, setEditing] = useState<ConnectionView | "new-github" | "new-server" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (!confirm(`Delete the connection “${c.name}”? Its stored credentials are deleted too. Projects using it lose access.`)) return;
    await api.deleteConnection(c.id).catch((e) => alert(e.message));
    await load();
  }

  return (
    <div className="page-inner">
      <div>
        <button className="back" onClick={goBack}>
          <ArrowLeft size={14} />
          Back
        </button>
        <div className="page-head">
          <div>
            <h1>Settings</h1>
            <p>Set these once — every project can use them.</p>
          </div>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Connections</h2>
            <p>
              GitHub accounts and servers agents can use to push and deploy. Credentials are encrypted on this computer, tied to your Windows
              login, and never shown to agents — they ask Symbio to act, and Symbio uses the credentials itself.
            </p>
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => setEditing("new-github")}>
              <Plus size={13} />
              GitHub
            </button>
            <button className="btn sm" onClick={() => setEditing("new-server")}>
              <Plus size={13} />
              Server
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: 12 }}>
            <div className="error">{error}</div>
          </div>
        )}
        {connections?.length === 0 && (
          <EmptyState icon={<Plug size={20} />} title="No connections yet">
            Add a GitHub account or a server (SSH) so agents can push code or deploy for you.
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
                        ? `GitHub · ${c.account}`
                        : "GitHub · not tested yet"
                      : `${c.username}@${c.host}${c.port !== 22 ? `:${c.port}` : ""} · ${c.auth === "password" ? "password" : c.keyPath ? `key file ${c.keyPath}` : "stored key"}`}
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
                  {testing === c.id ? "Testing…" : "Test"}
                </button>
                <button className="btn ghost icon sm" onClick={() => setEditing(c)} title="Edit">
                  <Pencil size={13} />
                </button>
                <button className="btn ghost icon sm" onClick={() => remove(c)} title="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ProvidersSection />

      <AnimatePresence>
        {editing && (
          <ConnectionForm
            existing={typeof editing === "string" ? null : editing}
            type={typeof editing === "string" ? (editing === "new-github" ? "github" : "server") : editing.type}
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
  type: "github" | "server";
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const server = existing?.type === "server" ? existing : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [token, setToken] = useState("");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "");
  const [auth, setAuth] = useState<"key" | "password">(server?.auth ?? "key");
  const [keySource, setKeySource] = useState<"file" | "paste">(server?.keyPath ? "file" : server ? "paste" : "file");
  const [keyPath, setKeyPath] = useState(server?.keyPath ?? "~/.ssh/id_ed25519");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = (field: string) => !!existing?.secrets?.[field];
  const keep = (field: string) => (stored(field) ? "Saved — leave empty to keep" : "");

  async function save() {
    setSaving(true);
    setError(null);
    const body =
      type === "github"
        ? { type, name, token }
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
      title={`${existing ? "Edit" : "New"} ${type === "github" ? "GitHub connection" : "server connection"}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save and test"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "github" ? "My GitHub" : "My VPS"} />
      </label>

      {type === "github" ? (
        <label className="field">
          <span>Personal access token</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={keep("token") || "github_pat_… or ghp_…"} />
          <span className="hint">
            GitHub → Settings → Developer settings → Personal access tokens. A fine-grained token limited to the repositories agents should
            work on is safest; give it Contents (read &amp; write), Pull requests and Issues as needed.
          </span>
        </label>
      ) : (
        <>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>Host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.10 or vps.example.com" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Port</span>
              <input value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>User</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" />
          </label>
          <div className="field">
            <span>Authentication</span>
            <div className="seg">
              <button className={auth === "key" ? "on" : ""} onClick={() => setAuth("key")}>
                SSH key
              </button>
              <button className={auth === "password" ? "on" : ""} onClick={() => setAuth("password")}>
                Password
              </button>
            </div>
          </div>
          {auth === "key" ? (
            <>
              <div className="seg">
                <button className={keySource === "file" ? "on" : ""} onClick={() => setKeySource("file")}>
                  Key file on this computer
                </button>
                <button className={keySource === "paste" ? "on" : ""} onClick={() => setKeySource("paste")}>
                  Paste the key
                </button>
              </div>
              {keySource === "file" ? (
                <label className="field">
                  <span>Key file</span>
                  <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
                </label>
              ) : (
                <label className="field">
                  <span>Private key</span>
                  <textarea
                    rows={5}
                    className="mono"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder={keep("privateKey") || "-----BEGIN OPENSSH PRIVATE KEY-----"}
                  />
                  <span className="hint">Stored encrypted.</span>
                </label>
              )}
              <label className="field">
                <span>Passphrase (if the key has one)</span>
                <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={keep("passphrase")} />
              </label>
            </>
          ) : (
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={keep("password")} />
            </label>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
