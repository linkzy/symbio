import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronRight, CornerUpLeft, FileDiff, ListChecks } from "lucide-react";
import { api, type Task, type TaskChange } from "./api";

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

/** What a task changed: its files (+/−), each diff on click. Loaded when opened. */
export function TaskChanges({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ files: TaskChange[]; note?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  async function toggle() {
    setOpen((o) => !o);
    if (data || open) return;
    try {
      setData(await api.taskChanges(projectId, taskId));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="task-changes">
      <button className="btn ghost sm" onClick={toggle}>
        <FileDiff size={13} />
        {open ? "Hide changes" : "Show changes"}
        {data && ` (${data.files.length})`}
      </button>
      {open && (
        <div className="changes-list">
          {error && <div className="small error">{error}</div>}
          {!data && !error && <div className="small subtle">Loading…</div>}
          {data?.note && <div className="small subtle">{data.note}</div>}
          {data && !data.note && data.files.length === 0 && <div className="small subtle">No file changes recorded for this task.</div>}
          {data?.files.map((f) => (
            <div key={f.file} className="change-file">
              <button className="change-file-head" onClick={() => setShown(shown === f.file ? null : f.file)}>
                {shown === f.file ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className={`change-status ${f.status}`}>{f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"}</span>
                <span className="ellipsis grow">{f.file}</span>
                <span className="change-count add">+{f.additions}</span>
                <span className="change-count del">−{f.deletions}</span>
              </button>
              {shown === f.file && <Patch text={f.patch} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A unified diff, its lines coloured by kind (hunk headers, additions, removals). */
function Patch({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l));
  return (
    <pre className="patch">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
