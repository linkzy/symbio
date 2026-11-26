import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, ExternalLink, File as FileIcon, FileSpreadsheet, FileText, Paperclip, Send, Trash2, Upload, X } from "lucide-react";
import { api, attachmentBlob, openAttachment, subscribe, uploadAttachments, type Attachment, type Project, type SharedFile } from "./api";
import { FileCard } from "./files";
import { EmptyState, timeAgo } from "./ui";
import { useI18n } from "./i18n";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const isImage = (name: string) => IMAGE.test(name);
export const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The project's gallery, kept current. */
export function useAttachments(projectId: string): [Attachment[] | null, () => void] {
  const [list, setList] = useState<Attachment[] | null>(null);
  const load = () => api.attachments(projectId).then(setList).catch(() => {});
  useEffect(() => {
    void load();
    return subscribe((e) => {
      if (e.type === "attachments.updated" && e.projectId === projectId) void load();
    });
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  return [list, load];
}

function KindIcon({ name, size = 18 }: { name: string; size?: number }) {
  if (/\.(xlsx?|csv|tsv|ods)$/i.test(name)) return <FileSpreadsheet size={size} />;
  if (/\.(pdf|docx?|odt|txt|md|pptx?)$/i.test(name)) return <FileText size={size} />;
  return <FileIcon size={size} />;
}

/** An image from the gallery (fetched with the key), or an icon for other files. */
export function AttachmentThumb({ projectId, a, size = 40, local }: { projectId: string; a: { id?: string; name: string }; size?: number; local?: string }) {
  const [src, setSrc] = useState<string | null>(local ?? null);
  useEffect(() => {
    if (local || !a.id || !isImage(a.name)) return;
    let alive = true;
    attachmentBlob(projectId, a.id)
      .then((u) => alive && setSrc(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, a.id, a.name, local]);
  return (
    <span className="att-thumb" style={{ width: size, height: size }}>
      {src && isImage(a.name) ? <img src={src} alt="" /> : <KindIcon name={a.name} size={Math.round(size * 0.45)} />}
    </span>
  );
}

// ---------------------------------------------------------------- composer

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  preview?: string;
  status: "uploading" | "ready" | "error";
  progress: number;
  id?: string;
  error?: string;
}

/** Files waiting to be sent with the next message, uploaded as soon as they're added. */
/**
 * Files waiting to go with the next message. With a storageKey, the uploaded ones are kept in the
 * browser, so they're still there after leaving the chat (they're already stored in the project).
 */
export function usePendingFiles(projectId: string, storageKey?: string) {
  const [files, setFiles] = useState<PendingFile[]>(() => {
    if (!storageKey) return [];
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Pick<PendingFile, "id" | "name" | "size">[];
      return saved.map((f) => ({ ...f, key: f.id!, status: "ready" as const, progress: 1 }));
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (!storageKey) return;
    const ready = files.filter((f) => f.status === "ready").map(({ id, name, size }) => ({ id, name, size }));
    if (ready.length) localStorage.setItem(storageKey, JSON.stringify(ready));
    else localStorage.removeItem(storageKey);
  }, [files, storageKey]);
  const update = (key: string, patch: Partial<PendingFile>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const add = (list: File[]) => {
    for (const file of list) {
      const key = `${Date.now()}-${Math.random()}`;
      const name = file.name || `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
      const named = file.name ? file : new File([file], name, { type: file.type });
      setFiles((fs) => [...fs, { key, name, size: file.size, preview: isImage(name) ? URL.createObjectURL(file) : undefined, status: "uploading", progress: 0 }]);
      uploadAttachments(projectId, [named], (p) => update(key, { progress: p }))
        .then(([a]) => update(key, { status: "ready", id: a.id, progress: 1 }))
        .catch((e) => update(key, { status: "error", error: (e as Error).message }));
    }
  };
  const remove = (key: string) => setFiles((fs) => fs.filter((f) => f.key !== key));
  const clear = () => setFiles([]);
  return { files, add, remove, clear, ready: files.filter((f) => f.status === "ready").map((f) => f.id!), uploading: files.some((f) => f.status === "uploading") };
}

export function PendingFiles({ projectId, files, onRemove }: { projectId: string; files: PendingFile[]; onRemove: (key: string) => void }) {
  const { t } = useI18n();
  if (!files.length) return null;
  return (
    <div className="att-pending">
      {files.map((f) => (
        <div key={f.key} className={`att-chip ${f.status}`} title={f.error ?? f.name}>
          <AttachmentThumb projectId={projectId} a={f} size={34} local={f.preview} />
          <span className="att-chip-text">
            <span className="ellipsis">{f.name}</span>
            <span className="att-chip-sub">
              {f.status === "uploading" ? t("usage.files.uploading", { n: Math.round(f.progress * 100) }) : f.status === "error" ? f.error : formatSize(f.size)}
            </span>
          </span>
          <button className="btn ghost icon xs" onClick={() => onRemove(f.key)} title={t("common.remove")} aria-label={t("usage.files.removeName", { name: f.name })}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The paperclip button and its hidden file input. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <button className="btn ghost icon sm" onClick={() => input.current?.click()} disabled={disabled} title={t("usage.files.attachTitle")} aria-label={t("usage.files.attach")}>
        <Paperclip size={15} />
      </button>
    </>
  );
}

// ---------------------------------------------------------------- past messages

const NOTE = /\n\n\[Attached by the human[^\]]*\]\n([\s\S]*)$/;

/** A sent message's text without the note Symbio added for the agent, and the stored files it lists. */
export function splitAttachmentNote(text: string): { body: string; files: string[] } {
  const m = NOTE.exec(text);
  if (!m) return { body: text, files: [] };
  const files = m[1]
    .split("\n")
    .map((l) => /^- (.+?) \(/.exec(l)?.[1])
    .filter((p): p is string => !!p)
    .map((p) => p.split(/[\\/]/).pop()!);
  return { body: text.slice(0, m.index), files };
}

/** Chips for the files a past message carried (matched to the gallery by stored file name). */
export function MessageAttachments({ projectId, files }: { projectId: string; files: string[] }) {
  const { t } = useI18n();
  const [list] = useAttachments(projectId);
  if (!files.length) return null;
  const byFile = new Map((list ?? []).map((a) => [`${a.id.slice(4, 12)}-${a.name}`, a]));
  return (
    <div className="att-sent">
      {files.map((f) => {
        const a = byFile.get(f);
        const name = a?.name ?? f.replace(/^[a-z0-9]{8}-/, "");
        return (
          <button key={f} className="att-chip sent" disabled={!a} onClick={() => a && openAttachment(projectId, a)} title={a ? t("usage.files.openName", { name }) : t("usage.files.gone", { name })}>
            <AttachmentThumb projectId={projectId} a={{ id: a?.id, name }} size={a && isImage(name) ? 64 : 30} />
            {!(a && isImage(name)) && <span className="ellipsis">{name}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- the Files tab

/** Everything sent in this project's chats, to find, open, resend or delete. */
export function FilesView({ project }: { project: Project }) {
  const { t } = useI18n();
  const [all] = useAttachments(project.id);
  const sharedAll = useSharedFiles(project.id);
  // Filters: what it is (evidence, reports, the human's own) and which task.
  const [show, setShow] = useState<"all" | "evidence" | "report" | "mine">("all");
  const [task, setTask] = useState("");
  const tasks = [...new Set(sharedAll.map((s) => s.taskId).filter((id): id is string => !!id))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const shared = sharedAll.filter((s) => show !== "mine" && (show === "all" || s.tag === show) && (!task || s.taskId === task));
  const list = (show === "all" && !task) || show === "mine" ? (all ?? []) : [];
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [sendTo, setSendTo] = useState<string | null>(null);
  const agents = project.agents.filter((a) => a.status !== "stopped");
  const nameOf = (id: string) => project.agents.find((a) => a.id === id)?.name ?? t("usage.files.anAgent");

  async function upload(files: File[]) {
    if (!files.length) return;
    setError(null);
    setUploading(0);
    try {
      await uploadAttachments(project.id, files, setUploading);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  }

  async function send(a: Attachment, agentId: string) {
    setSendTo(null);
    try {
      await api.send(project.id, agentId, "", false, [a.id]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const drop = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void upload([...e.dataTransfer.files]);
    },
  };

  return (
    <div className={`files ${dragging ? "dragging" : ""}`} {...drop}>
      <div className="files-head">
        <div>
          <h2>{t("project.tab.files")}</h2>
          <p className="muted small">
            {t("usage.files.intro.before")} <code>.symbio/attachments</code>
            {t("usage.files.intro.after")}
          </p>
        </div>
        <span className="spacer" />
        <AttachButtonLabeled onFiles={upload} busy={uploading !== null} progress={uploading} />
      </div>
      {error && <div className="error">{error}</div>}
      {(sharedAll.length > 0 || (all?.length ?? 0) > 0) && (
        <div className="files-filters row">
          <div className="seg">
            {(
              [
                ["all", "usage.files.all"],
                ["evidence", "usage.files.evidence"],
                ["report", "usage.files.reports"],
                ["mine", "usage.files.mine"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={show === id ? "on" : ""} onClick={() => setShow(id)}>
                {t(label)}
              </button>
            ))}
          </div>
          {tasks.length > 0 && show !== "mine" && (
            <select value={task} onChange={(e) => setTask(e.target.value)} aria-label={t("usage.files.task")}>
              <option value="">{t("usage.files.anyTask")}</option>
              {tasks.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {shared.length > 0 && (
        <>
          <h3 className="files-section">{t("usage.files.fromTeam")}</h3>
          <div className="shared-files">
            {shared.map((s) => (
              <FileCard
                key={s.id}
                projectId={project.id}
                agentId={s.agentId}
                path={s.rel}
                caption={[nameOf(s.agentId), timeAgo(s.at), s.tag, s.taskId, s.caption].filter(Boolean).join(" · ")}
              />
            ))}
          </div>
          {list && list.length > 0 && <h3 className="files-section">{t("usage.files.mine")}</h3>}
        </>
      )}
      {all && all.length === 0 && sharedAll.length === 0 ? (
        <EmptyState icon={<Paperclip size={20} />} title={t("usage.files.empty")}>
          {t("usage.files.emptyBody")}
        </EmptyState>
      ) : list.length === 0 && shared.length === 0 ? (
        <div className="subtle small">{t("usage.files.noMatch")}</div>
      ) : (
        <div className="files-grid">
          {list.map((a) => (
            <div key={a.id} className="file-card">
              <button className="file-card-preview" onClick={() => openAttachment(project.id, a)} title={t("usage.files.openName", { name: a.name })}>
                <AttachmentThumb projectId={project.id} a={a} size={isImage(a.name) ? 132 : 56} />
              </button>
              <div className="file-card-body">
                <div className="ellipsis file-card-name" title={a.name}>
                  {a.name}
                </div>
                <div className="file-card-sub">
                  {formatSize(a.size)} · {timeAgo(a.addedAt)}
                </div>
                <div className="file-card-sub ellipsis">
                  {a.sentTo.length
                    ? t("usage.files.sentTo", { names: [...new Set(a.sentTo.map((s) => nameOf(s.agentId)))].join(", ") })
                    : t("usage.files.notSent")}
                </div>
              </div>
              <div className="file-card-actions">
                <div className="file-send">
                  <button className="btn ghost icon xs" title={t("usage.files.sendTo")} onClick={() => setSendTo(sendTo === a.id ? null : a.id)} disabled={!agents.length}>
                    <Send size={13} />
                  </button>
                  {sendTo === a.id && (
                    <div className="file-send-menu">
                      {agents.map((ag) => (
                        <button key={ag.id} onClick={() => send(a, ag.id)}>
                          {ag.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button className="btn ghost icon xs" title={t("common.open")} onClick={() => openAttachment(project.id, a)}>
                  <ExternalLink size={13} />
                </button>
                <button className="btn ghost icon xs" title={t("common.download")} onClick={() => openAttachment(project.id, a, true)}>
                  <Download size={13} />
                </button>
                <button
                  className="btn ghost icon xs"
                  title={t("common.delete")}
                  onClick={() => {
                    if (confirm(t("usage.files.deleteConfirm", { name: a.name }))) api.deleteAttachment(project.id, a.id).catch((e) => setError(e.message));
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {dragging && <DropOverlay label={t("usage.files.drop")} />}
    </div>
  );
}

function AttachButtonLabeled({ onFiles, busy, progress }: { onFiles: (files: File[]) => void; busy: boolean; progress: number | null }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <button className="btn sm" onClick={() => input.current?.click()} disabled={busy}>
        <Upload size={13} />
        {busy ? t("usage.files.uploading", { n: Math.round((progress ?? 0) * 100) }) : t("usage.files.add")}
      </button>
    </>
  );
}

/** Files agents shared with the human (share_file), newest first, kept current. */
export function useSharedFiles(projectId: string): SharedFile[] {
  const [list, setList] = useState<SharedFile[]>([]);
  useEffect(() => {
    const load = () => api.sharedFiles(projectId).then(setList).catch(() => {});
    load();
    return subscribe((e) => {
      if (e.type === "attachments.updated" && e.projectId === projectId) load();
    });
  }, [projectId]);
  return list;
}

export function DropOverlay({ label }: { label: ReactNode }) {
  return (
    <div className="drop-overlay">
      <Upload size={22} />
      <span>{label}</span>
    </div>
  );
}
