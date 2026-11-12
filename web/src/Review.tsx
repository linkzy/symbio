import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, CornerUpLeft, ListChecks } from "lucide-react";
import { api, type Task } from "./api";

// The human's review of a finished task (Settings → Team → Who reviews the work): the helper's
// guide for checking it, and approve / send back. Used in Needs you and in the Plan tab.

/** How to check the work, as its helper wrote it (links open in a new tab). */
export function ReviewGuide({ guide }: { guide?: string }) {
  if (!guide?.trim()) return <div className="small subtle">No guide was given for this task.</div>;
  return (
    <div className="review-guide md">
      <div className="review-guide-head">
        <ListChecks size={13} />
        How to check it
      </div>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {guide}
      </Markdown>
    </div>
  );
}

/** Approve, or send back with a note (it goes to the helper that did the work). */
export function ReviewActions({ projectId, task, onDone }: { projectId: string; task: Task; onDone?: () => void }) {
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(decision: "approve" | "send-back") {
    setBusy(true);
    try {
      await api.reviewTask(projectId, task.id, decision, decision === "send-back" ? note.trim() : undefined);
      onDone?.();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (sendingBack) {
    return (
      <div className="review-actions column">
        <textarea autoFocus rows={3} placeholder="What needs to change? It goes to the helper that did the work." value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row">
          <button className="btn primary sm" onClick={() => decide("send-back")} disabled={busy || !note.trim()}>
            <CornerUpLeft size={13} />
            Send back
          </button>
          <button className="btn ghost sm" onClick={() => setSendingBack(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="review-actions">
      <button className="btn primary sm" onClick={() => decide("approve")} disabled={busy}>
        <Check size={13} />
        Approve
      </button>
      <button className="btn sm" onClick={() => setSendingBack(true)} disabled={busy}>
        <CornerUpLeft size={13} />
        Send back…
      </button>
    </div>
  );
}

export const waitingForReview = (t: Task) => t.humanReview?.state === "waiting";
