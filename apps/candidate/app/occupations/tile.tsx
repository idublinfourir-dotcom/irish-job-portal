// One live job on the occupation page (frame C14): the employer and place, a save button, the permit badge, the title, the pay and when it was posted or checked, and View job.
// The whole tile is not a link: the title and View job are, so a screen reader hears one job once.
import { A, CriticalSkillsBadge, Icon, Pill, SponsorBadge } from "@portal/ui";
import { companyPath, jobPath } from "../../lib/paths";
import { SaveButton } from "../jobs/client";
import { salaryText, whenLine, type CardJob } from "../jobs/card";
import { contractText, loginHref } from "../jobs/format";
import { BySignIn, Logo } from "../jobs/parts";

const VIEW = "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-pill bg-lilac-soft px-5 text-small font-semibold text-deep-green no-underline hover:bg-lilac";

export function OccupationTile({ job, now, signedIn, saved, path }: { job: CardJob; now: Date; signedIn: boolean | undefined; saved: boolean; path: string }) {
  const pay = salaryText(job);
  const contract = contractText(job.contractMonths);
  const place = [job.county, contract && `Fixed term, ${contract}`].filter(Boolean).join(" · ");
  const when = whenLine(job, now);
  return (
    <article data-lift data-job-card={job.id} className="flex min-w-0 flex-col gap-3 rounded-bento bg-sand p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Logo name={job.employerName} url={job.employerLogoUrl} className="size-12" />
          <div className="min-w-0">
            <p className="break-words font-heading text-[16px] font-semibold leading-snug">{job.employerSlug ? <A href={companyPath(job.employerSlug)} className="underline-offset-2 hover:underline">{job.employerName}</A> : job.employerName}</p>
            {place && <p className="text-small text-muted">{place}</p>}
          </div>
        </div>
        <BySignIn
          signedIn={signedIn}
          yes={<SaveButton jobId={job.id} title={job.title} saved={saved} />}
          no={<A href={loginHref(path)} aria-label={`Log in to save ${job.title}`} className="grid size-11 shrink-0 place-items-center rounded-pill bg-white text-ink hover:bg-hover-light"><Icon name="bookmark" size={18} /></A>}
        />
      </div>
      {(job.badge || job.permitHistory === "first_time" || job.quotaFull) && (
        <p className="flex flex-wrap items-center gap-2">
          {job.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}
          {job.badge === "sponsor_confirmed" && <SponsorBadge />}
          {job.permitHistory === "first_time" && <Pill tone="peach" className="min-h-0 px-3 py-[5px] text-[13px] font-semibold">First-time sponsor</Pill>}
          {job.quotaFull && <Pill tone="peach" className="min-h-0 px-3 py-[5px] text-[13px] font-semibold">Permit quota full</Pill>}
        </p>
      )}
      <h3 className="break-words text-[20px] leading-snug"><A href={jobPath(job)} className="underline-offset-2 hover:underline">{job.title}</A></h3>
      <div>
        <p className="break-words font-heading text-[17px] font-semibold leading-snug">{pay.line}</p>
        {pay.note && <p className="text-small">{pay.note}</p>}
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-2">
        {when ? <p className="flex items-center gap-1.5 text-small text-muted"><Icon name="clock" size={14} />{when}</p> : <span />}
        <A href={jobPath(job)} className={VIEW}>View job</A>
      </div>
    </article>
  );
}
