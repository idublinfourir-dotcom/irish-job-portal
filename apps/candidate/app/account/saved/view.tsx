// The saved jobs page (frame A04): the saved jobs, newest first, with the closed ones kept so the candidate knows what happened (#287: a closed card shows title, employer and
// the reason). Filter All, Open or Closed by the address (?show=). Each card's bookmark removes the job (the same button as on the job lists).
import { A, Button, CriticalSkillsBadge, EmptyState, Icon, Notice, Pill, SponsorBadge, cx } from "@portal/ui";
import { jobPath, savedPath } from "../../../lib/paths";
import { fromSmall, salaryText, whenLine, type CardJob } from "../../jobs/card";
import { SaveButton } from "../../jobs/client";
import { Logo } from "../../jobs/parts";
import { reasonText } from "../messages";
import { Head } from "../parts";

const LIMIT = 200; // SAVED_LIMIT in the yaml
const SHOW = [["", "All"], ["open", "Open"], ["closed", "Closed"]] as const;

export type SavedRow = Parameters<typeof fromSmall>[0] & { live: boolean; reason: string | null; savedAt: string };

export function SavedView({ saved, show, now }: { saved: SavedRow[]; show: string; now: Date }) {
  const shown = saved.filter((s) => (show === "open" ? s.live : show === "closed" ? !s.live : true));
  return (
    <>
      <Head
        title="Saved jobs"
        line={saved.length ? `${saved.length} saved. Closed jobs stay here so you know what happened.` : "Jobs you save are kept here."}
        action={saved.length > 0 && (
          <nav aria-label="Show" className="flex gap-1 rounded-pill bg-lilac p-1">
            {SHOW.map(([v, l]) => <A key={v} href={v ? `${savedPath()}?show=${v}` : savedPath()} aria-current={show === v ? "page" : undefined} className={cx("inline-flex min-h-10 items-center rounded-pill px-4 text-small font-semibold no-underline", show === v ? "bg-white text-ink" : "text-ink/75")}>{l}</A>)}
          </nav>
        )}
      />
      {saved.length >= LIMIT && <div className="mb-4"><Notice kind="warning" title={`You have saved ${LIMIT} jobs, the most we keep`}>Remove one to save another.</Notice></div>}
      {saved.length === 0 ? (
        <EmptyState icon="bookmark" title="No saved jobs yet" action={<Button href="/jobs">Find jobs</Button>}>Tap the bookmark on any job to keep it here.</EmptyState>
      ) : shown.length === 0 ? (
        <p className="rounded-bento bg-sand p-6 text-muted">No {show} jobs among your saved ones.</p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {shown.map((s) => <li key={s.jobId}><SavedCard s={s} now={now} /></li>)}
        </ul>
      )}
    </>
  );
}

function SavedCard({ s, now }: { s: SavedRow; now: Date }) {
  const job: CardJob = fromSmall(s);
  const pay = salaryText(job);
  const when = whenLine(job, now);
  return (
    <article data-saved={s.jobId} data-live={s.live} className="flex h-full flex-col gap-3 rounded-bento bg-sand p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Logo name={s.employerName} url={s.employerLogoUrl} />
          <p className="min-w-0 text-small"><span className="block break-words font-semibold">{s.employerName}</span><span className="text-muted">{s.live ? s.county : ""}</span></p>
        </div>
        <SaveButton jobId={s.jobId} title={s.title} saved />
      </div>
      {s.live && (job.badge || job.quotaFull) && (
        <p className="flex flex-wrap gap-2">
          {job.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}
          {job.badge === "sponsor_confirmed" && <SponsorBadge />}
          {job.quotaFull && <Pill tone="peach" className="min-h-0 px-3 py-[5px] text-[13px] font-semibold">Permit quota full</Pill>}
        </p>
      )}
      <h2 className={cx("break-words text-[20px] leading-snug", !s.live && "text-muted")}>{s.title}</h2>
      {s.live ? <p className="font-semibold">{pay.line}</p> : <p className="font-semibold text-error">{reasonText(s.reason)}</p>}
      <div className="mt-auto flex items-center justify-between gap-3 pt-2">
        <p className="flex items-center gap-1.5 text-small text-muted">{s.live && when && <><Icon name="clock" size={14} />{when}</>}</p>
        <Button href={jobPath({ id: s.jobId, title: s.title, county: s.live ? (s.county ?? null) : null })} variant="chip" size="sm" className="font-semibold text-deep-green">{s.live ? "View job" : "See similar jobs"}</Button>
      </div>
    </article>
  );
}

