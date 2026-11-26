import { motion } from "motion/react";
import { FileText, FolderOpen, FolderPlus, GitBranch } from "lucide-react";
import type { Inspection } from "./api";
import { useI18n, type MessageKey } from "./i18n";

const KIND_LABEL: Record<string, MessageKey> = {
  documents: "folderSummary.kind.documents",
  spreadsheets: "folderSummary.kind.spreadsheets",
  presentations: "folderSummary.kind.presentations",
  images: "folderSummary.kind.images",
  "audio-video": "folderSummary.kind.audioVideo",
  code: "folderSummary.kind.code",
  data: "folderSummary.kind.data",
  archives: "folderSummary.kind.archives",
  other: "folderSummary.kind.other",
};

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function FolderSummary({ inspection: i }: { inspection: Inspection }) {
  const { t } = useI18n();
  const kindLabel = (kind: string) => (KIND_LABEL[kind] ? t(KIND_LABEL[kind]) : kind);
  const kinds = Object.entries(i.kinds).sort((a, b) => b[1] - a[1]);
  const total = kinds.reduce((s, [, n]) => s + n, 0) || 1;

  let headline: string;
  if (!i.exists) headline = t("folderSummary.new");
  else if (i.empty) headline = t("folderSummary.empty");
  else headline = t("folderSummary.existing", { count: `${i.fileCount}${i.truncated ? "+" : ""}`, size: formatBytes(i.totalBytes) });

  return (
    <motion.div className="folder-summary" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
      <div className="folder-headline">
        {i.empty || !i.exists ? <FolderPlus size={15} /> : <FolderOpen size={15} />}
        <strong>{headline}</strong>
        {i.isGit && (
          <span className="tag">
            <GitBranch />
            git
          </span>
        )}
        {i.repos.length > 0 && (
          <span className="tag" title={i.repos.join("\n")}>
            <GitBranch />
            {i.repos.length === 1 ? t("folderSummary.oneRepo") : t("folderSummary.repos", { n: i.repos.length })}
          </span>
        )}
        {i.guidance.map((g) => (
          <span key={g} className="tag">
            <FileText />
            {g}
          </span>
        ))}
      </div>

      {kinds.length > 0 && (
        <>
          <div className="kind-bar">
            {kinds.map(([kind, n], idx) => (
              <motion.span
                key={kind}
                className={`kind-seg k${idx % 6}`}
                initial={{ width: 0 }}
                animate={{ width: `${(n / total) * 100}%` }}
                transition={{ duration: 0.5, delay: idx * 0.05 }}
                title={`${kindLabel(kind)}: ${n}`}
              />
            ))}
          </div>
          <div className="kind-legend">
            {kinds.map(([kind, n], idx) => (
              <span key={kind}>
                <i className={`k${idx % 6}`} />
                {kindLabel(kind)} {n}
              </span>
            ))}
          </div>
        </>
      )}

      {i.topLevel.length > 0 && (
        <div className="top-level" title={t("folderSummary.topLevel")}>
          {i.topLevel.slice(0, 14).join("  ·  ")}
          {i.topLevel.length > 14 && "  ·  …"}
        </div>
      )}
    </motion.div>
  );
}
