// The job page body (N03 dark head for a Critical Skills job, C07 light head otherwise, C08 pay and degree states, NM3 on a phone), as a pure view of the job read.
// [job]/page.tsx reads; this file only shows. Left column: head, pay, permit notes, registration, the advert, similar jobs. Right column: apply, degree box, the
// employer's permit snapshot, permit services, the report line. Below 1024 px the two columns become one stack in the order of frame NM3 (the apply card is the sticky bar).
import type { ReactNode } from "react";
import type { JobPage } from "@portal/db";
import { A, Breadcrumb, CriticalSkillsBadge, Icon, Pill, SponsorBadge, type IconName } from "@portal/ui";
import { companyPath, staticPath } from "../../lib/paths";
import { TileCard, type CardJob } from "./card";
import { DegreeBox } from "./degree-box";
import { criticalSkillsResult, generalResult, type DegreeChoice, type DegreeResult } from "./degree";
import { JobActions, ReportJob, SaveButton } from "./client";
import { ago, capFirst, contractText, euro } from "./format";
import { Hl, Join, Logo, PhotoBlock, wrap } from "./parts";

/** Launch B: applying on the site is behind the flag (D72, D78). Off: a job whose route is `on_site` shows no apply button. */
export const LAUNCH_B_APPLY = false;

export type JobViewProps = {
  job: JobPage; now: Date; path: string; signedIn: boolean; saved: boolean; stage: string | null; degree: DegreeChoice;
  prompt: { clickId: string; title: string; employerName: string; county: string | null } | null; similar: CardJob[];
};

export const safeApplyUrl = (j: Pick<JobPage, "applicationRoute" | "ownPageUrl">) =>
  j.applicationRoute === "own_page" && j.ownPageUrl && /^https?:\/\/[^\s]+$/i.test(j.ownPageUrl) ? j.ownPageUrl : null;

const TREND = { up: "rising", down: "falling", flat: "steady" } as const;
const PERMIT = { critical_skills: "Critical Skills Employment Permit", general: "General Employment Permit" } as const;
const SOURCE: Record<string, (j: JobPage) => string> = {
  fetched: () => "Collected from the employer's own site",
  employer: () => "Posted by the employer",
  agency: (j) => (j.permitEmployerName ? `Posted by a recruitment agency. Permit employer: ${j.permitEmployerName}` : "Posted by a recruitment agency"),
  admin_manual: () => "Added by our team",
};

const Card = ({ children, className = "", ...rest }: { children: ReactNode; className?: string } & Record<string, unknown>) => (
  <section {...rest} className={`flex flex-col gap-4 rounded-bento bg-sand p-6 sm:p-8 xl:p-10 ${className}`}>{children}</section>
);
const Note = ({ icon, children }: { icon: IconName; children: ReactNode }) => (
  <p className="flex items-start gap-3 rounded-card bg-lilac px-5 py-3.5 text-[15px]"><Icon name={icon} size={18} className="mt-0.5 shrink-0" />{children}</p>
);

/** How the stated pay stands against the minimum of this job: for a Critical Skills job the one of the chosen degree, else the General one. */
export function resultOf(job: JobPage, degree: DegreeChoice): DegreeResult | null {
  const pay = { passRoute: job.passRoute, salaryLow: job.salaryLow, salaryHigh: job.salaryHigh };
  return job.permitType === "critical_skills" ? criticalSkillsResult(degree, job.minimums, pay) : generalResult(job.minimums, job.occupationCode, pay);
}

/** The pay in the states of frame C08: stated, big company (not stated), public pay scale, a range that crosses the minimum. */
export function PayCard({ job, result }: { job: JobPage; result: DegreeResult | null }) {
  const stated = job.salaryLow !== null || job.salaryHigh !== null;
  const m = result?.kind === "minimum" ? result.minimum : null;
  const general = job.permitType === "general";
  let head: ReactNode, sub: ReactNode = null, chip: ReactNode = null, state: string;
  if (job.passRoute === "public_pay") {
    state = "public_pay";
    head = "Public sector pay scale applies";
    sub = job.payScale ? `Pay scale for this grade: ${euro(job.payScale.firstEur)} to ${euro(job.payScale.lastEur)}` : job.payGrade ? `Pay grade: ${job.payGrade}` : null;
    chip = <Pill tone="lilac">Salary minimum does not apply</Pill>;
  } else if (stated) {
    state = job.salaryRangeCrosses ? "range_crosses" : "stated";
    head = <>{job.salaryLine} a year</>;
    sub = job.salaryRangeCrosses ? "The top of the range clears the minimum" : "Stated in the advert";
    chip = job.salaryRangeCrosses ? <Pill tone="peach">Depends on starting point</Pill>
      : result?.kind === "minimum" && result.standing === "clears" ? <Pill tone="lilac"><Icon name="check" size={14} className="mr-1" />{general && m ? `Clears the General permit minimum of ${euro(m)}` : "Clears the minimum"}</Pill>
      : result?.kind === "minimum" && result.standing === "below" ? <Pill tone="lilac">Below the minimum</Pill> : null;
  } else {
    state = job.passRoute ?? "not_stated";
    head = m !== null && job.passRoute === "big_company" ? `Salary not stated, expected above ${euro(m)}` : "Salary not stated";
    sub = job.passRoute === "big_company" ? "This employer is on our list of large companies whose pay for this role clears the minimum."
      : job.passRoute === "pay_floor" ? "The employer has signed a pay floor for this role (declared by the employer)." : null;
    chip = <Pill tone="lilac">Not stated</Pill>;
  }
  return (
    <div data-pay={state} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 rounded-bento bg-white p-4 sm:p-5">
        <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-pill bg-green-tint text-deep-green"><Icon name="euro" size={22} /></span>
        <div className="min-w-0 flex-1 basis-56">
          <p className="break-words font-heading text-[20px] font-semibold leading-snug">{head}</p>
          {sub && <p className="text-small text-muted">{sub}</p>}
        </div>
        {chip}
      </div>
      {job.salaryRangeCrosses && (
        <p className="flex items-start gap-3 rounded-card bg-white px-5 py-3.5 text-[15px]">
          <Icon name="info" size={18} className="mt-0.5 shrink-0 text-deep-green" />
          <span>
            Pay depends on where you start in this range. The top of the range clears the minimum, the bottom does not.
            {job.permitType === "critical_skills" && ` Recent graduates have a lower minimum of ${euro(job.minimums.graduate)}.`}
            {job.healthInsuranceEur !== null && ` Employer-paid health insurance of ${euro(job.healthInsuranceEur)} a year also counts.`}
          </span>
        </p>
      )}
      {!job.salaryRangeCrosses && stated && job.healthInsuranceEur !== null && (
        <p className="text-small text-muted">Employer-paid health insurance of {euro(job.healthInsuranceEur)} a year also counts.</p>
      )}
    </div>
  );
}

function Snapshot({ job }: { job: JobPage }) {
  const p = job.permits;
  const max = Math.max(1, ...(p?.byYear.map((y) => y.permits) ?? []));
  return (
    <Card aria-labelledby="snapshot">
      <h2 id="snapshot" className="text-[22px] sm:text-[24px]">Employer permit snapshot</h2>
      {job.employerLabels.length > 0 && <div className="flex flex-wrap gap-2">{job.employerLabels.map((l) => <Pill key={l} tone={l === "Sponsorship claims removed" ? "peach" : "lilac"}>{l}</Pill>)}</div>}
      {job.sponsored && <p>Sponsored {job.sponsored.permits} {job.sponsored.permits === 1 ? "permit" : "permits"} since {job.sponsored.since}.</p>}
      {p && p.byYear.length > 0 && (
        <>
          <ol aria-label="DETE permits by year" className="flex h-36 items-end gap-1.5">
            {p.byYear.map((y) => (
              <li key={y.year} className="flex flex-1 flex-col items-center justify-end gap-1.5">
                <span className="sr-only">{y.year}: {y.permits} permits</span>
                <span aria-hidden="true" className={`w-full max-w-9 rounded-pill ${y.year === p.peakYear ? "bg-deep-green" : "bg-ink"}`} style={{ height: `${Math.max(14, Math.round((y.permits / max) * 104))}px` }} />
                <span aria-hidden="true" className="text-[11px] text-muted">{String(y.year).slice(-2)}</span>
              </li>
            ))}
          </ol>
          <p className="flex flex-wrap gap-2">
            {p.peakYear !== null && <Pill tone="lilac">Peak {p.peakYear}</Pill>}
            {p.trend && <Pill tone="outline">Trend: {TREND[p.trend]}</Pill>}
          </p>
          {p.latestMonth && <p className="text-small text-muted">Latest month: {p.latestMonth.permits} {p.latestMonth.permits === 1 ? "permit" : "permits"} in {new Date(Date.UTC(p.latestMonth.year, p.latestMonth.month - 1)).toLocaleString("en-IE", { month: "long", year: "numeric", timeZone: "UTC" })}</p>}
        </>
      )}
      <A href={companyPath(job.employer.slug)} className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-pill border-[1.5px] border-ink px-5 font-semibold no-underline hover:bg-hover-light">
        See {job.employer.name} company page <Icon name="arrow" size={16} />
      </A>
    </Card>
  );
}

/** Frame N03's dark head (a Critical Skills job) or C07's light head (a sponsor-confirmed or General job). */
function Head({ job, now, result, signedIn, saved }: { job: JobPage; now: Date; result: DegreeResult | null; signedIn: boolean; saved: boolean }) {
  const dark = job.permitType === "critical_skills";
  const posted = ago(job.postedAt, now);
  const checked = ago(job.lastCheckedAt, now);
  const contract = contractText(job.contractMonths);
  const stated = job.salaryLow !== null || job.salaryHigh !== null;
  const note = job.badge === "sponsor_confirmed" ? "The employer's claim, not our check" : job.badge ? "Our rule check, not an employer promise" : null;
  const meta: [IconName, string][] = [
    ...(job.county ? ([["pin", job.county]] as [IconName, string][]) : []),
    ...(contract ? ([["briefcase", `Fixed term, ${contract}`]] as [IconName, string][]) : []),
    ["file", (PERMIT as Record<string, string>)[job.permitType] ?? capFirst(job.permitType)],
    ...(posted ? ([["clock", `Posted ${posted}`]] as [IconName, string][]) : []),
    ...(checked ? ([["clock", `Last checked ${checked}`]] as [IconName, string][]) : []),
  ];
  const badges = (
    <>
      {job.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}
      {job.badge === "sponsor_confirmed" && <SponsorBadge />}
      {job.quotaFull && <Pill tone="peach" className="min-h-0 px-3 py-[5px] text-[13px] font-semibold">Permit quota full</Pill>}
    </>
  );
  const employer = (
    <div className="flex items-center gap-4">
      <Logo name={job.employer.name} url={job.employer.logoUrl} className="size-14 sm:size-16" />
      <div className="min-w-0">
        <p className="break-words font-heading text-[18px] font-semibold leading-snug"><A href={companyPath(job.employer.slug)} className={`no-underline hover:underline ${dark ? "text-white" : "text-deep-green"}`}>{job.employerName}</A></p>
        <p className={`break-words text-small ${dark ? "text-white/75" : "text-muted"}`}>
          {[job.county, job.sponsored && `${job.sponsored.permits} ${job.sponsored.permits === 1 ? "permit" : "permits"} since ${job.sponsored.since}`].filter(Boolean).join(" · ")}
        </p>
      </div>
    </div>
  );
  const metaRow = (
    <ul className="flex flex-wrap gap-2">
      {meta.map(([icon, text], i) => (
        <li key={i} className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-pill px-3.5 text-small font-medium ${dark ? "bg-lilac text-ink" : "bg-white text-ink"}`}>
          <Icon name={icon} size={14} />{text}
        </li>
      ))}
    </ul>
  );
  const save = signedIn && <span className="lg:hidden"><SaveButton jobId={job.id} title={job.title} saved={saved} /></span>;
  if (dark)
    return (
      <section data-head="dark" className="flex flex-col gap-6 rounded-bento bg-ink p-6 text-white sm:gap-7 sm:p-9">
        <div className="flex items-start justify-between gap-3">{employer}{save}</div>
        <h1 className="break-words text-[2.1rem] leading-[1.6] text-ink sm:text-[4rem] sm:leading-[1.4]">
          <span className="rounded-2xl bg-white px-3 box-decoration-clone sm:px-4">{job.title}</span>
        </h1>
        {metaRow}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 sm:mt-6">
          <div className="flex flex-col items-start gap-2">
            <span className="flex flex-wrap gap-2">{badges}</span>
            {note && <span className="text-small text-white/80">{note}</span>}
          </div>
          {stated && (
            <div className="text-right">
              <p className="font-heading text-[2.6rem] font-semibold leading-none text-white sm:text-[3.4rem]">{job.salaryLine}</p>
              <p className="mt-1 text-small text-white/80">a year{result?.kind === "minimum" && result.standing === "clears" ? ` · clears the ${euro(result.minimum)} minimum` : ""}</p>
            </div>
          )}
        </div>
      </section>
    );
  return (
    <section data-head="light" className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-9">
      <div className="flex items-start justify-between gap-3">{employer}{save}</div>
      <h1 className="break-words text-[2.1rem] sm:text-[3.4rem]">{job.title}</h1>
      {metaRow}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex flex-wrap gap-2">{badges}</span>
        {note && <span className="text-small text-muted">{note}</span>}
        {job.employerLabels.includes("First-time sponsor") && <Pill tone="peach" className="min-h-0 px-3 py-[5px] text-[13px] font-semibold">First-time sponsor</Pill>}
      </div>
      <PayCard job={job} result={result} />
    </section>
  );
}

export function JobView({ job, now, path, signedIn, saved, stage, degree, prompt, similar }: JobViewProps) {
  const m = job.minimums;
  const cs = job.permitType === "critical_skills";
  const result = resultOf(job, degree);
  const years = contractText(m.minContractMonths);
  const stated = job.salaryLow !== null || job.salaryHigh !== null;
  const applyUrl = safeApplyUrl(job);
  const onSiteOff = job.applicationRoute === "on_site" && !LAUNCH_B_APPLY;
  const notes: [IconName, string][] = [
    ...(cs ? ([["calendar", `Critical Skills permit needs a job offer of at least ${years}.`]] as [IconName, string][]) : []),
    ...(cs ? ([["degree", `Needs a relevant degree${job.registration?.degreeNote ? ` (${job.registration.degreeNote})` : ""}${m.nonList !== null ? `, or a salary of ${euro(m.nonList)} or more` : ""}.`]] as [IconName, string][]) : []),
    ...(job.condition ? ([["briefcase", job.condition]] as [IconName, string][]) : []),
  ];
  const dark = cs;
  return (
    <>
      <div className={`${wrap} pb-28 pt-6 lg:pb-10`}>
        <Breadcrumb items={[{ label: "Find a job", href: "/jobs" }, ...(job.sector ? [{ label: capFirst(job.sector), href: `/jobs?sector=${encodeURIComponent(job.sector)}` }] : []), { label: job.title }]} />
        <div className="mt-4 flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-start lg:gap-5">
          <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-5">
            <div className="order-1 flex flex-col gap-4 lg:order-none lg:gap-5">
              <Head job={job} now={now} result={result} signedIn={signedIn} saved={saved} />
              {dark && (!stated || job.salaryRangeCrosses || job.healthInsuranceEur !== null) && <Card><PayCard job={job} result={result} /></Card>}
              {job.quotaFull && (
                <section data-quota-notice aria-labelledby="quota" className="flex items-start gap-3 rounded-bento bg-peach p-5 sm:px-7">
                  <Icon name="warning" size={20} className="mt-0.5 shrink-0" />
                  <div>
                    <h2 id="quota" className="font-heading text-[16px] font-semibold leading-snug">Quota notice: places for this occupation are full</h2>
                    <p className="text-small">Permits for this occupation are limited by a quota, and its places are full for now.</p>
                  </div>
                </section>
              )}
            </div>
            {dark && <PhotoBlock className="order-2 h-44 lg:hidden" />}
            {notes.length > 0 && (
              <Card aria-labelledby="notes" className="order-3 lg:order-none">
                <h2 id="notes" className="text-[22px] sm:text-[24px]">{cs ? <>Permit <Hl c="peach">notes</Hl> for this job</> : "Permit conditions"}</h2>
                <div className="flex flex-col gap-3">{notes.map(([icon, text]) => <Note key={text} icon={icon}>{text}</Note>)}</div>
              </Card>
            )}
            {job.registration && (
              <Card aria-labelledby="registration" className="order-6 lg:order-none">
                <h2 id="registration" className="text-[22px] sm:text-[24px]">Registration</h2>
                <p>{job.registration.line}</p>
                {job.registration.steps.length > 0 && <ol className="list-decimal pl-6">{job.registration.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
                <p><A href={job.registration.body.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-deep-green underline underline-offset-2">{job.registration.body.name}</A></p>
              </Card>
            )}
            {job.advertText && (
              <Card aria-labelledby="about" className="order-5 lg:order-none">
                <h2 id="about" className="text-[22px] sm:text-[24px]">About <Hl c="lilac">the job</Hl></h2>
                <p className="whitespace-pre-line break-words text-muted">{job.advertText}</p>
              </Card>
            )}
            <p className="order-10 text-small text-muted lg:order-none">{job.standingLine} {(SOURCE[job.source] ?? SOURCE.fetched!)(job)}.</p>
            {similar.length > 0 && (
              <section aria-labelledby="similar" className="order-11 flex flex-col gap-4 lg:order-none lg:mt-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="similar" className="text-[26px] sm:text-[32px]">More jobs <Hl c="green">like this</Hl></h2>
                  <A href="/jobs" className="inline-flex min-h-[34px] items-center gap-1.5 rounded-pill bg-lilac-soft px-3.5 text-small font-semibold text-deep-green no-underline hover:bg-lilac">See all <Icon name="arrow" size={14} /></A>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{similar.slice(0, 3).map((j) => <TileCard key={j.id} job={j} now={now} signedIn={signedIn} saved={false} />)}</div>
              </section>
            )}
          </div>

          <div className="contents lg:flex lg:flex-col lg:gap-5">
            {dark && <PhotoBlock className="hidden h-56 lg:block" />}
            <JobActions
              jobId={job.id} title={job.title} applyUrl={applyUrl} signedIn={signedIn} saved={saved} stage={stage} prompt={prompt} path={path}
              unavailable={onSiteOff ? "Applying for this job is not open yet." : "The employer has not given a page to apply on."}
            />
            {cs && <div className="order-4 lg:order-none"><DegreeBox minimums={m} pay={{ passRoute: job.passRoute, salaryLow: job.salaryLow, salaryHigh: job.salaryHigh }} initial={degree} /></div>}
            <div className="order-6 lg:order-none"><Snapshot job={job} /></div>
            <A href={staticPath("permit-services")!} className="order-7 flex items-start justify-between gap-4 rounded-bento bg-ink p-6 text-white no-underline lg:order-none">
              <span>
                <span className="block font-heading text-[22px] font-semibold leading-snug">Got an offer? We can handle your permit</span>
                <span className="mt-2 block text-small text-white/75">Our services team prepares the application. Usually paid by the employer.</span>
              </span>
              <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-pill bg-deep-green"><Icon name="up-right" size={18} /></span>
            </A>
            <p className="order-8 flex items-center gap-3 rounded-bento bg-peach p-5 text-[15px] font-semibold lg:order-none"><Icon name="warning" size={20} className="shrink-0" />No genuine employer asks you to pay for a job offer. Report it.</p>
            <div className="order-9 lg:order-none"><ReportJob jobId={job.id} title={job.title} signedIn={signedIn} path={path} /></div>
          </div>
        </div>
      </div>
      {!signedIn && <Join />}
    </>
  );
}
