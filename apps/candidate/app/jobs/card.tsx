// One job in a list (frames C04 list card, C05 popular cards, N03 more jobs like this). Server rendered; only the save and report buttons are client islands.
// Every word and figure is read from the card. The logo is the employer's own file, or its initials.
import { A, CriticalSkillsBadge, Icon, Pill, SponsorBadge } from "@portal/ui";
import { companyPath, jobPath } from "../../lib/paths";
import { ReportJob, SaveButton } from "./client";
import { ago, contractText, euroText } from "./format";
import { Logo } from "./parts";

/** The fields of a card the list read gives (JobCard) and the small card of similar jobs shares (SmallJobCard's `jobId` is mapped to `id` by `fromSmall`). */
export type CardJob = {
  id: string; title: string; employerName: string; county: string | null; salaryLow: number | null; salaryHigh: number | null; salaryLine: string | null;
  payGrade: string | null; passRoute: string | null; badge: string | null; quotaFull: boolean; postedAt: Date | string | null; sponsorPermits: number | null;
  lastCheckedAt: Date | string | null; contractMonths: number | null; permitHistory: string | null; employerSlug: string | null; payScaleLine: string | null;
  employerLogoUrl?: string | null;
};
type Small = Partial<Omit<CardJob, "id">> & { jobId: string; title: string; employerName: string };
/** A small card (similar jobs) with the fields a list card has, absent ones null. */
export const fromSmall = (s: Small): CardJob => ({
  id: s.jobId, title: s.title, employerName: s.employerName, county: s.county ?? null, salaryLow: s.salaryLow ?? null, salaryHigh: s.salaryHigh ?? null, salaryLine: s.salaryLine ?? null,
  payGrade: s.payGrade ?? null, passRoute: s.passRoute ?? null, badge: s.badge ?? null, quotaFull: s.quotaFull ?? false, postedAt: s.postedAt ?? null, sponsorPermits: null,
  lastCheckedAt: s.lastCheckedAt ?? null, contractMonths: s.contractMonths ?? null, permitHistory: s.permitHistory ?? null, employerSlug: s.employerSlug ?? null, payScaleLine: s.payScaleLine ?? null,
  employerLogoUrl: s.employerLogoUrl ?? null,
});

/** The pay of a card in the states of frame C08: stated, public pay scale, big company, pay floor, not stated. `line` is the headline, `note` the line under it. */
export function salaryText(j: Pick<CardJob, "salaryLow" | "salaryHigh" | "salaryLine" | "payGrade" | "passRoute" | "payScaleLine">): { line: string; note: string | null } {
  if (j.passRoute === "public_pay") return { line: "Public sector pay scale applies", note: j.payScaleLine ? euroText(j.payScaleLine) : j.payGrade ? `Pay grade: ${j.payGrade}` : null };
  if (j.salaryLow !== null || j.salaryHigh !== null) return { line: `${j.salaryLine ?? ""} a year`.trim(), note: null };
  if (j.passRoute === "big_company") return { line: "Salary not stated", note: "A large employer on our list: its pay for this role clears the minimum." };
  if (j.passRoute === "pay_floor") return { line: "Salary not stated", note: "The employer has signed a pay floor for this role." };
  return { line: "Salary not stated", note: null };
}

/** "Checked today" for a fetched job (the source was read today), else when the job was posted. */
export const whenLine = (j: Pick<CardJob, "postedAt" | "lastCheckedAt">, now: Date) => {
  const checked = ago(j.lastCheckedAt, now);
  const posted = ago(j.postedAt, now);
  return checked ? `Checked ${checked}` : posted ? `Posted ${posted}` : null;
};

function Badges({ job }: { job: CardJob }) {
  const any = job.badge || job.permitHistory === "first_time" || job.quotaFull;
  if (!any) return null;
  return (
    <p className="flex flex-wrap items-center gap-2">
      {job.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}
      {job.badge === "sponsor_confirmed" && <SponsorBadge />}
      {job.permitHistory === "first_time" && <Pill tone="peach" className="min-h-0 px-3 py-[5px] text-[13px] font-semibold">First-time sponsor</Pill>}
      {job.quotaFull && <Pill tone="peach" className="min-h-0 px-3 py-[5px] text-[13px] font-semibold">Permit quota full</Pill>}
    </p>
  );
}

const VIEW = "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-pill bg-lilac-soft px-5 text-small font-semibold text-deep-green no-underline hover:bg-lilac";

/** The wide card of the search list (frame C04): logo, title and place, badges, pay and date, then save, report and View job. */
export function ResultCard({ job, now, signedIn, saved, path }: { job: CardJob; now: Date; signedIn: boolean; saved: boolean; path: string }) {
  const pay = salaryText(job);
  const contract = contractText(job.contractMonths);
  const where = [job.county, contract && `Fixed term, ${contract}`].filter(Boolean).join(" · ");
  const when = whenLine(job, now);
  return (
    <article data-job-card={job.id} className="flex flex-col gap-4 rounded-bento bg-sand p-4 sm:p-5 xl:flex-row xl:items-center xl:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <Logo name={job.employerName} url={job.employerLogoUrl} className="size-12 xl:size-14" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="break-words text-[18px] leading-snug">
            <A href={jobPath(job)} className="underline-offset-2 hover:underline">{job.title}</A>
          </h3>
          <p className="break-words text-small text-muted">
            {job.employerSlug ? <A href={companyPath(job.employerSlug)} className="underline-offset-2 hover:underline">{job.employerName}</A> : job.employerName}
            {where && ` · ${where}`}
          </p>
          <Badges job={job} />
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 xl:contents">
        <div className="min-w-0 xl:w-64 xl:shrink-0">
          <p className="break-words font-heading text-[17px] font-semibold leading-snug">{pay.line}</p>
          {pay.note && <p className="text-small text-muted">{pay.note}</p>}
          {when && (
            <p className="mt-1 flex items-center gap-1.5 text-small text-muted">
              <Icon name="clock" size={14} />
              {when}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 xl:shrink-0">
          {signedIn && <SaveButton jobId={job.id} title={job.title} saved={saved} />}
          {signedIn && <ReportJob jobId={job.id} title={job.title} signedIn path={path} compact />}
          <A href={jobPath(job)} className={VIEW}>View job</A>
        </div>
      </div>
    </article>
  );
}

/** The tall card of "More jobs like this" (frame N03) and "Popular right now" (frame C05). */
export function TileCard({ job, now, signedIn, saved }: { job: CardJob; now: Date; signedIn: boolean; saved: boolean }) {
  const pay = salaryText(job);
  const contract = contractText(job.contractMonths);
  const where = [job.county, contract && `Fixed term, ${contract}`].filter(Boolean).join(" · ");
  const when = whenLine(job, now);
  return (
    <article data-job-card={job.id} className="flex min-w-0 flex-col gap-3 rounded-bento bg-sand p-5">
      <div className="flex items-start gap-3">
        <Logo name={job.employerName} url={job.employerLogoUrl} className="size-12" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-[15px] font-medium leading-snug">{job.employerName}</p>
          {where && <p className="break-words text-small text-muted">{where}</p>}
        </div>
        {signedIn && <SaveButton jobId={job.id} title={job.title} saved={saved} />}
      </div>
      <Badges job={job} />
      <h3 className="break-words text-[18px] leading-snug">
        <A href={jobPath(job)} className="underline-offset-2 hover:underline">{job.title}</A>
      </h3>
      <div>
        <p className="break-words font-heading text-[17px] font-semibold leading-snug">{pay.line}</p>
        {pay.note && <p className="text-small text-muted">{pay.note}</p>}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-2 text-small text-muted">
        <p className="flex items-center gap-1.5">
          <Icon name="clock" size={14} />
          {when}
        </p>
        <A href={jobPath(job)} className={VIEW}>View job</A>
      </div>
    </article>
  );
}
