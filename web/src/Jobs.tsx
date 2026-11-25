import { useEffect, useState } from "react";
import { CalendarClock, Check, ChevronDown, ChevronRight, Pause, Play, Trash2, X } from "lucide-react";
import { api, subscribe, type Job, type JobRun, type Project } from "./api";
import { Md } from "./files";
import { useI18n } from "./i18n";
import { timeAgo } from "./ui";

/** The project's scheduled jobs, kept current. */
export function useJobs(projectId: string | undefined): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    if (!projectId) return;
    const load = () => api.jobs(projectId).then(setJobs).catch(() => {});
    void load();
    return subscribe((e) => {
      if (e.type === "schedules.updated" && e.projectId === projectId) void load();
    });
  }, [projectId]);
  return jobs;
}

const at = (t: number, locale: string) => new Date(t).toLocaleString(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const act = (p: Promise<unknown>) => p.catch((e) => alert((e as Error).message));

function RunLine({ run, projectId }: { run: JobRun; projectId: string }) {
  const { t } = useI18n();
  return (
    <div className={`job-run run-${run.status}`}>
      <div className="row" style={{ gap: 8 }}>
        <span className={`tag ${run.status === "done" ? "green" : run.status === "failed" ? "red" : run.status === "running" ? "blue" : ""}`}>{t(`jobs.run.${run.status}`)}</span>
        <span className="small subtle">
          {t("jobs.run.n", { n: run.n })} · {timeAgo(run.at)}
          {run.by === "manual" ? ` · ${t("jobs.run.manual")}` : ""}
        </span>
      </div>
      {run.note && (
        <div className="small job-run-note">
          <Md text={run.note} projectId={projectId} />
        </div>
      )}
    </div>
  );
}

/** Approve or decline a job core proposed (also in Needs you). */
export function JobApproval({ project, job }: { project: Project; job: Job }) {
  const { t } = useI18n();
  return (
    <div className="row" style={{ gap: 8 }}>
      <button className="btn primary sm" onClick={() => act(api.jobAction(project.id, job.id, "approve"))}>
        <Check size={13} />
        {t("jobs.approve")}
      </button>
      <button className="btn sm" onClick={() => confirm(t("jobs.declineConfirm", { title: job.title })) && act(api.removeJob(project.id, job.id))}>
        <X size={13} />
        {t("jobs.decline")}
      </button>
    </div>
  );
}

function JobCard({ project, job }: { project: Project; job: Job }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const last = job.runs.at(-1);
  return (
    <div className={`job-card job-${job.state}`} data-job={job.id}>
      <div className="row job-card-head" style={{ gap: 10 }}>
        <span className="task-id">{job.id}</span>
        <strong className="grow">{job.title}</strong>
        <span className={`tag ${job.state === "proposed" ? "amber" : job.state === "active" ? "green" : ""}`}>{t(`jobs.state.${job.state}`)}</span>
      </div>
      <div className="small muted">
        {job.when}
        {job.state === "active" && job.nextRun !== null && ` · ${t("jobs.next", { when: at(job.nextRun, locale) })}`}
      </div>
      <div className="small job-instructions">{job.instructions}</div>
      {last && <RunLine run={last} projectId={project.id} />}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {job.state === "proposed" ? (
          <JobApproval project={project} job={job} />
        ) : (
          <>
            <button className="btn sm" onClick={() => act(api.jobAction(project.id, job.id, "run"))}>
              <Play size={13} />
              {t("jobs.runNow")}
            </button>
            <button className="btn sm" onClick={() => act(api.jobAction(project.id, job.id, job.state === "paused" ? "resume" : "pause"))}>
              {job.state === "paused" ? <Play size={13} /> : <Pause size={13} />}
              {job.state === "paused" ? t("jobs.resume") : t("jobs.pause")}
            </button>
            <button className="btn ghost sm" onClick={() => confirm(t("jobs.removeConfirm", { title: job.title })) && act(api.removeJob(project.id, job.id))}>
              <Trash2 size={13} />
              {t("common.remove")}
            </button>
          </>
        )}
        {job.runs.length > 1 && (
          <button className="btn ghost sm" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {t("jobs.history", { n: job.runs.length })}
          </button>
        )}
      </div>
      {open && (
        <div className="stack" style={{ gap: 8 }}>
          {[...job.runs].reverse().slice(1).map((r) => (
            <RunLine key={r.n} run={r} projectId={project.id} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Plan tab: the scheduled jobs, folded into one line until opened (open when one waits for approval). */
export function ScheduledJobs({ project }: { project: Project }) {
  const { t, locale } = useI18n();
  const jobs = useJobs(project.id);
  const waiting = jobs.some((j) => j.state === "proposed");
  const [open, setOpen] = useState<boolean | null>(null);
  if (!jobs.length) return null;
  const shown = open ?? waiting;
  const next = jobs.filter((j) => j.state === "active" && j.nextRun !== null).sort((a, b) => a.nextRun! - b.nextRun!)[0];
  return (
    <div className="jobs" id="scheduled-jobs">
      <button className="jobs-head" onClick={() => setOpen(!shown)}>
        {shown ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <CalendarClock size={14} />
        <strong>{t("jobs.title", { n: jobs.length })}</strong>
        {waiting && <span className="tag amber">{t("jobs.waiting")}</span>}
        <span className="small subtle grow">{next ? t("jobs.nextOne", { title: next.title, when: at(next.nextRun!, locale) }) : ""}</span>
      </button>
      {shown && (
        <div className="jobs-list">
          {jobs.map((j) => (
            <JobCard key={j.id} project={project} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}
