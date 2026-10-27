// Shared UI building blocks: avatars, status, dialogs, drawers, empty states, logo.

import { useEffect, type ReactNode } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";

// Muted, distinguishable hues for agent avatars (stable per name).
const AVATAR_COLORS = ["#5b5fc7", "#2f8f6f", "#a87326", "#a2508f", "#3b78cc", "#3c8c9b", "#8a5bb5", "#7c7448"];

export function agentColor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Letter avatar for an agent (or "you"/Symbio), with an optional status dot. */
export function Avatar({
  name,
  status,
  size,
  kind = "agent",
}: {
  name: string;
  status?: string;
  size?: "sm" | "lg";
  kind?: "agent" | "human" | "system";
}) {
  const letter = kind === "human" ? "You".slice(0, 1) : kind === "system" ? "S" : name.slice(0, 1);
  return (
    <span
      className={`avatar ${size ?? ""} ${kind !== "agent" ? kind : ""}`}
      style={kind === "agent" ? { background: agentColor(name) } : undefined}
      title={name}
    >
      {letter}
      {status && <span className={`dot ${status}`} />}
    </span>
  );
}

export function statusText(status: string): string {
  switch (status) {
    case "busy":
      return "Working";
    case "waiting":
      return "Waiting for you";
    case "stuck":
      return "Recovering";
    case "error":
      return "Needs attention";
    case "stopped":
      return "Stopped";
    default:
      return "Idle";
  }
}

export function Logo({ size = 22 }: { size?: number }) {
  // Two overlapping circles: two organisms living together.
  return (
    <svg className="brand-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="12" r="6.5" fill="none" stroke="#6d6af5" strokeWidth="2.2" />
      <circle cx="15" cy="12" r="6.5" fill="none" stroke="#3fb27f" strokeWidth="2.2" />
    </svg>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** Centered dialog. Render inside <AnimatePresence>. */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
  header,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  header?: ReactNode;
}) {
  useEscape(onClose);
  return (
    <motion.div
      className="backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className={`dialog ${wide ? "wide" : ""}`}
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        {subtitle && <div className="dialog-sub">{subtitle}</div>}
        {header}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </motion.div>
    </motion.div>
  );
}

/** Right-side drawer. Render inside <AnimatePresence>. */
export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEscape(onClose);
  return (
    <motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.aside
        className="drawer"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
      >
        <div className="drawer-head">
          <h2>{title}</h2>
          {actions}
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </motion.aside>
    </motion.div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function timeAgo(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
