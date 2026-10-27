import { useEffect, useState } from "react";
import { GitBranch, Server } from "lucide-react";
import { api, type ConnectionView, type ProjectConnection } from "./api";

export function ConnIcon({ type, small }: { type: "github" | "server"; small?: boolean }) {
  return <span className={`conn-icon ${small ? "sm" : ""}`}>{type === "github" ? <GitBranch size={small ? 12 : 15} /> : <Server size={small ? 12 : 15} />}</span>;
}

/** Choose which global connections a project may use, and whether actions need approval. */
export function ConnectionsPicker({ value, onChange }: { value: ProjectConnection[]; onChange: (v: ProjectConnection[]) => void }) {
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
        No connections yet — add GitHub accounts or servers in <a className="link" href="#/settings">Settings</a>.
      </div>
    );
  }

  const link = (id: string) => value.find((l) => l.id === id);
  const toggle = (id: string) => onChange(link(id) ? value.filter((l) => l.id !== id) : [...value, { id, policy: "ask" }]);
  const setPolicy = (id: string, policy: "ask" | "allow") => onChange(value.map((l) => (l.id === id ? { ...l, policy } : l)));

  return (
    <div>
      {all.map((c) => {
        const l = link(c.id);
        return (
          <div key={c.id} className={`pick-row ${l ? "on" : ""}`}>
            <label className="pick-main">
              <input type="checkbox" checked={!!l} onChange={() => toggle(c.id)} />
              <ConnIcon type={c.type} small />
              <span className="grow ellipsis">
                <span style={{ fontWeight: 500 }}>{c.name}</span>{" "}
                <span className="subtle small">{c.type === "github" ? (c.account ?? "GitHub") : `${c.username}@${c.host}`}</span>
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
        );
      })}
    </div>
  );
}
