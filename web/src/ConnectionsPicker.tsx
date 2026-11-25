import { useEffect, useState } from "react";
import { Cloud, FolderUp, GitBranch, Server, Timer, X } from "lucide-react";
import { api, type ConnectionGrant, type ConnectionView, type ProjectConnection } from "./api";

export function ConnIcon({ type, small }: { type: ConnectionView["type"]; small?: boolean }) {
  const size = small ? 12 : 15;
  return (
    <span className={`conn-icon ${small ? "sm" : ""}`}>
      {type === "github" ? <GitBranch size={size} /> : type === "azure" ? <Cloud size={size} /> : type === "ftp" ? <FolderUp size={size} /> : <Server size={size} />}
    </span>
  );
}

/** One line describing a connection: account, organization or user@host. */
export function connectionLabel(c: ConnectionView): string {
  if (c.type === "github") return c.account ? `GitHub · ${c.account}` : "GitHub";
  if (c.type === "azure") return `Azure DevOps · ${c.organization}${c.account ? ` · ${c.account}` : ""}`;
  if (c.type === "ftp") return `FTP · ${c.username}@${c.host}`;
  return `${c.username}@${c.host}`;
}

/**
 * Choose which global connections a project may use, and whether actions need approval. In a
 * project's settings it also shows the server commands that run without asking (removable) and the
 * agents allowed to use a connection without asking for now (with Stop).
 */
export function ConnectionsPicker({
  value,
  onChange,
  grants,
  agentName,
  onStopGrant,
}: {
  value: ProjectConnection[];
  onChange: (v: ProjectConnection[]) => void;
  grants?: ConnectionGrant[];
  agentName?: (id: string) => string;
  onStopGrant?: (g: ConnectionGrant) => void;
}) {
  const [all, setAll] = useState<ConnectionView[] | null>(null);
  useEffect(() => {
    api
      .connections()
      .then(setAll)
      .catch(() => setAll([]));
  }, []);

  if (!all) return <div className="subtle small">Loading connections…</div>;
  if (all.length === 0) {
    return (
      <div className="subtle small">
        No connections yet — add GitHub, Azure DevOps or servers in <a className="link" href="#/settings/connections">Settings</a>.
      </div>
    );
  }

  const link = (id: string) => value.find((l) => l.id === id);
  const toggle = (id: string) => onChange(link(id) ? value.filter((l) => l.id !== id) : [...value, { id, policy: "ask" }]);
  const setPolicy = (id: string, policy: "ask" | "allow") => onChange(value.map((l) => (l.id === id ? { ...l, policy } : l)));
  const removeCommand = (id: string, pattern: string) =>
    onChange(value.map((l) => (l.id === id ? { ...l, allowedCommands: (l.allowedCommands ?? []).filter((p) => p !== pattern) } : l)));
  const now = Date.now();

  return (
    <div>
      {all.map((c) => {
        const l = link(c.id);
        const live = (grants ?? []).filter((g) => g.connectionId === c.id && (g.until === null || g.until > now));
        const commands = l?.policy === "ask" ? (l.allowedCommands ?? []) : [];
        return (
          <div key={c.id}>
          <div className={`pick-row ${l ? "on" : ""}`}>
            <label className="pick-main">
              <input type="checkbox" checked={!!l} onChange={() => toggle(c.id)} />
              <ConnIcon type={c.type} small />
              <span className="grow ellipsis">
                <span style={{ fontWeight: 500 }}>{c.name}</span>{" "}
                <span className="subtle small">{connectionLabel(c)}</span>
              </span>
            </label>
            {l && (
              <div className="seg">
                <button className={l.policy === "ask" ? "on" : ""} onClick={() => setPolicy(c.id, "ask")} title="Every action waits for your approval">
                  Ask me
                </button>
                <button className={l.policy === "allow" ? "on" : ""} onClick={() => setPolicy(c.id, "allow")} title="Agents act without asking">
                  Allowed
                </button>
              </div>
            )}
          </div>
          {l && (commands.length > 0 || live.length > 0) && (
            <div className="pick-extra">
              {live.map((g) => (
                <div key={g.agentId} className="pick-grant">
                  <Timer size={12} />
                  <span className="grow">
                    {agentName?.(g.agentId) ?? "An agent"} acts without asking{" "}
                    {g.until ? `until ${new Date(g.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "until you stop it"}
                  </span>
                  {onStopGrant && (
                    <button className="btn ghost xs" onClick={() => onStopGrant(g)}>
                      Stop
                    </button>
                  )}
                </div>
              ))}
              {commands.length > 0 && (
                <div className="pick-commands">
                  <span className="subtle small">Run without asking:</span>
                  {commands.map((p) => (
                    <span key={p} className="pick-command">
                      <code>{p}</code>
                      <button className="btn ghost icon xs" aria-label={`Ask again for ${p}`} title="Ask again for these" onClick={() => removeCommand(c.id, p)}>
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          </div>
        );
      })}
    </div>
  );
}
