// The home page (P6, frames 3 and 76): server components only, every value from `data` (read in load.ts), no client script.
// Cut by #287: occupation carousel, national DETE figures, logo strip, Trusted Partner chip, work-pattern tags, Medical devices and Retail tiles.
import type { ReactNode } from "react";
import { A, Button, Card, CriticalSkillsBadge, EmptyState, Icon, Input, JobCard, Notice, Pill, Select, Skeleton, SponsorBadge, Tabs } from "@portal/ui";
import { guidePath, jobPath, staticPath, updatePath } from "../../lib/paths";
import { COUNTIES } from "./counties";
import { eur, jobsIn, sectorLabel, shortDate } from "./format";
import { EMPLOYERS_HREF } from "./meta";
import type { Failed, HomeData, Jobs, Minimums, SectorCount, Sec } from "./load";

const JOBS_LIMIT = 6; // #46: what a visitor sees of any list
const wrap = "mx-auto max-w-page px-4";
const jobsPath = staticPath("jobs")!;

function Section({ id, title, intro, children, action }: { id: string; title: string; intro?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} id={id} className={`${wrap} py-8 lg:py-12`}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={`${id}-h`} className="text-2xl lg:text-3xl">{title}</h2>
          {intro && <p className="mt-1 max-w-prose text-muted">{intro}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** What a section shows when its read was refused or failed: the 429 says how long to wait. */
function Unavailable({ r }: { r: Failed }) {
  return r.status === 429 ? (
    <Notice kind="warning" title="Too many requests">Please try again in {r.retryAfter ?? 60} seconds.</Notice>
  ) : (
    <Notice kind="error" title="This part could not be loaded">Reload the page to try again.</Notice>
  );
}

function Hero({ m }: { m: Sec<Minimums> }) {
  return (
    <div className={`${wrap} grid gap-8 py-10 lg:grid-cols-2 lg:py-16`}>
      <div className="flex flex-col gap-5">
        <h1 className="text-4xl lg:text-5xl">Find a job a permit covers</h1>
        <p className="max-w-prose text-lg">
          Jobs in Ireland for people who need an employment permit. Each job carries one of two badges: our rule check passed, or the employer confirmed sponsorship.
        </p>
        <form action={jobsPath} method="get" className="grid gap-3 rounded-card border border-line bg-white p-4 shadow-card sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <Input id="home-q" name="q" label="Job title" placeholder="Job title, e.g. Nurse" maxLength={200} autoComplete="off" />
          <Select id="home-county" name="county" label="County" defaultValue="">
            <option value="">Any county</option>
            {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Button type="submit" size="lg">Find jobs</Button>
        </form>
        <p className="text-small text-muted">Free for candidates. The job board is always free.</p>
      </div>
      {m.ok && (
        <Card className="flex flex-col justify-center gap-2 self-center">
          <p className="text-small font-semibold text-muted">From the rules table</p>
          <p className="font-heading text-5xl font-semibold text-deep-green">{eur(m.data.criticalSkills)}</p>
          <p>Critical Skills minimum with a relevant degree. We check every job against it.</p>
          <p className="text-small text-muted">Checked on {shortDate(m.data.rulesCheckedOn)}</p>
        </Card>
      )}
    </div>
  );
}

function Minimums({ m }: { m: Sec<Minimums> }) {
  if (!m.ok) return <Unavailable r={m} />;
  const d = m.data;
  const rows: [string, number][] = [
    ["Critical Skills, relevant degree", d.criticalSkills],
    [`Critical Skills, degree awarded in the last ${d.graduateMonths} months`, d.graduate],
    ...(d.general === null ? [] : [["General Employment permit", d.general] as [string, number]]),
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <dl className="divide-y divide-line rounded-card border border-line bg-white">
        {rows.map(([label, n]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 p-4">
            <dt>{label}</dt>
            <dd className="font-heading text-xl font-semibold">{eur(n)} a year</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col items-start gap-3">
        <p>A Critical Skills job offer must run at least {d.minContractMonths} months.</p>
        <p className="text-small text-muted">
          From the rules table, checked on {shortDate(d.rulesCheckedOn)}.{d.nextVersionOn && ` New minimums start on ${shortDate(d.nextVersionOn)}.`}
        </p>
        <Button href={staticPath("eligibility-checker")!} variant="outline">Open the eligibility checker</Button>
      </div>
    </div>
  );
}

function Sectors({ s }: { s: Sec<SectorCount[]> }) {
  if (!s.ok) return <Unavailable r={s} />;
  const live = s.data.filter((x) => x.jobs > 0).sort((a, b) => b.jobs - a.jobs || a.sector.localeCompare(b.sector));
  if (!live.length) return <EmptyState title="No live jobs yet">New jobs appear here as soon as they pass our checks.</EmptyState>;
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {live.map((x) => (
        <li key={x.sector}>
          <A href={`${jobsPath}?sector=${encodeURIComponent(x.sector)}`} className="block h-full rounded-card border border-line bg-white p-4 shadow-card hover:bg-hover-light">
            <h3 className="text-lg">{sectorLabel(x.sector)}</h3>
            <p className="text-small text-muted">{jobsIn(x.jobs)}</p>
          </A>
        </li>
      ))}
    </ul>
  );
}

function Latest({ d }: { d: HomeData }) {
  const tabs = d.sectors.ok ? d.sectors.data.filter((x) => x.jobs > 0).sort((a, b) => b.jobs - a.jobs || a.sector.localeCompare(b.sector)) : [];
  return (
    <>
      {tabs.length > 0 && (
        <div className="mb-5">
          <Tabs
            label="Sector"
            items={[
              { label: "All", href: "/#latest-jobs", active: d.tab === null },
              ...tabs.map((x) => ({ label: sectorLabel(x.sector), href: `/?sector=${encodeURIComponent(x.sector)}#latest-jobs`, active: d.tab === x.sector })),
            ]}
          />
        </div>
      )}
      {!d.jobs.ok ? <Unavailable r={d.jobs} /> : <JobsGrid j={d.jobs.data} />}
    </>
  );
}

function JobsGrid({ j }: { j: Jobs }) {
  if (!j.jobs.length) return <EmptyState title="No jobs here yet">Try another sector, or look at every job.</EmptyState>;
  const hidden = j.signInForMore ? Math.min(3, Math.max(0, (j.count?.n ?? JOBS_LIMIT + 3) - j.jobs.length)) : 0;
  return (
    <>
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {j.jobs.map((c) => (
          <li key={c.id}>
            <JobCard
              title={c.title}
              href={jobPath(c)}
              employer={c.employerName}
              place={c.county ?? "Ireland"}
              salary={c.salaryLine ?? "Salary not stated"}
              badges={
                <>
                  {c.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}
                  {c.badge === "sponsor_confirmed" && <SponsorBadge />}
                  {c.quotaFull && <Pill tone="peach">Quota full</Pill>}
                </>
              }
            />
          </li>
        ))}
        {Array.from({ length: hidden }, (_, i) => (
          <li key={`hidden-${i}`} aria-hidden="true" data-placeholder>
            <Card className="flex flex-col gap-3 blur-[2px]">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </Card>
          </li>
        ))}
      </ul>
      {j.signInForMore && (
        <div data-sign-in-for-more className="mt-6 flex flex-col items-start gap-3 rounded-card border-2 border-ink bg-peach p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-heading text-xl font-semibold">Want to see more jobs? Log in or create a free account.</p>
            <p>{j.count ? `There ${j.count.n === 1 ? "is" : "are"} ${j.count.n}${j.count.more ? " or more" : ""} live ${j.count.n === 1 ? "job" : "jobs"}. ` : ""}Free for candidates. One question about your permit.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button href="/login" variant="outline">Log in</Button>
            <Button href="/signup">Create free account</Button>
          </div>
        </div>
      )}
    </>
  );
}

const STEPS: [string, string][] = [
  ["Create a free account", "Sign up with your email, plus one question about your permit."],
  ["Find jobs by sector", "Filter by sector and county, and look for the two badges."],
  ["Apply", "Use the link on the job, then track it in your account."],
  ["Got an offer? We can handle your permit", "Our services team supports the application."],
];
const SERVICES: [string, string][] = [
  ["Free eligibility check", "Know where you stand first"],
  ["Document checklist", "Exactly what to prepare"],
  ["First consultation, free", "With a named case handler"],
  ["Case tracker", "Every step, live"],
];

function Cards({ d }: { d: HomeData }) {
  const items = [
    ...(d.guides.ok ? d.guides.data.map((g) => ({ key: `g-${g.slug}`, kind: "Guide", title: g.title, href: guidePath(g.slug), on: g.checkedOn })) : []),
    ...(d.updates.ok ? d.updates.data.map((u) => ({ key: `u-${u.slug}`, kind: "Government update", title: u.title, href: updatePath(u.slug), on: u.checkedOn })) : []),
  ];
  if (!d.guides.ok && !d.updates.ok) return <Unavailable r={d.guides} />;
  if (!items.length) return <p className="text-muted">Guides and government updates will appear here when they are published.</p>;
  return (
    <ul className="grid gap-4 md:grid-cols-3">
      {items.map((i) => (
        <li key={i.key}>
          <Card as="article" className="flex h-full flex-col gap-2">
            <Pill tone={i.kind === "Guide" ? "green" : "peach"} className="self-start">{i.kind}</Pill>
            <h3 className="text-lg"><A href={i.href} className="underline-offset-2 hover:underline">{i.title}</A></h3>
            {i.on && <p className="mt-auto text-small text-muted">Checked on {shortDate(i.on)}</p>}
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Faq({ d }: { d: HomeData }) {
  const checked = d.minimums.ok ? ` The rules were last checked on ${shortDate(d.minimums.data.rulesCheckedOn)}.` : "";
  const qa: [string, string][] = [
    ["Do I pay to use the site or for its permit services?", "No. The job board is free for candidates. Our permit services are paid by the employer or agency."],
    ["What does \"Sponsor confirmed\" mean?", "The employer or agency signed a sponsorship statement for this job, with a named person. It is the employer's claim."],
    ["What does \"Critical Skills eligible\" mean?", "A job we fetched passed every Critical Skills permit rule in our check. It is not a promise from the employer."],
    ["Why can I see only some jobs?", `Visitors see the latest ${JOBS_LIMIT} jobs of any list. Create a free account to see every job.`],
    ["Where do the salary minimums come from?", `From the DETE rules table.${checked}`],
  ];
  return (
    <dl className="grid gap-4 lg:grid-cols-2">
      {qa.map(([q, a]) => (
        <div key={q} className="rounded-card border border-line bg-white p-5">
          <dt className="font-heading text-lg font-semibold">{q}</dt>
          <dd className="mt-1">{a}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HomeView({ data: d }: { data: HomeData }) {
  return (
    <>
      <Hero m={d.minimums} />
      <Section id="sectors" title="Pick a sector that sponsors you" intro="Live jobs in each sector today.">
        <Sectors s={d.sectors} />
      </Section>
      <Section id="latest-jobs" title="Latest jobs" action={<Button href={jobsPath} variant="outline" size="sm">View all jobs</Button>}>
        <Latest d={d} />
      </Section>
      <Section id="badges" title="Two badges, two sources" intro="We say who makes each claim, so you can judge it.">
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="flex flex-col items-start gap-2">
            <SponsorBadge />
            <h3 className="text-xl">The employer&apos;s claim</h3>
            <p>The employer or agency signed a sponsorship statement for this job, with a named person. Look for the pen icon.</p>
            <p className="text-small text-muted">Source: the employer</p>
          </Card>
          <Card className="flex flex-col items-start gap-2">
            <CriticalSkillsBadge />
            <h3 className="text-xl">Our rule check</h3>
            <p>A job we fetched that passed every Critical Skills permit rule. It is not a promise from the employer. Look for the shield icon.</p>
            <p className="text-small text-muted">Source: our rule check, from the DETE rules</p>
          </Card>
        </div>
      </Section>
      <Section id="steps" title="From search to permit in four steps" intro="Our paid permit services are paid by the employer or agency, never by you.">
        <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([t, text], i) => (
            <li key={t}>
              <Card className="h-full">
                <p className="font-heading text-3xl font-semibold text-deep-green">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="mt-1 text-lg">{t}</h3>
                <p className="mt-1 text-muted">{text}</p>
              </Card>
            </li>
          ))}
        </ol>
      </Section>
      <Section id="minimums" title="Check a salary against the rules" intro="Which salary minimum applies depends on your degree. The eligibility checker shows whether a job clears it.">
        <Minimums m={d.minimums} />
      </Section>
      <Section id="permit-services" title="Got an offer? We can handle your permit" intro="Our own permit team handles the application with your employer and tracks the case with you. The employer or agency pays for it.">
        <ul className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICES.map(([t, text]) => (
            <li key={t} className="flex gap-2 rounded-card border border-line bg-white p-4">
              <Icon name="check" className="mt-1 shrink-0 text-deep-green" />
              <div><h3 className="text-base">{t}</h3><p className="text-small text-muted">{text}</p></div>
            </li>
          ))}
        </ul>
        <Button href={staticPath("permit-services")!}>Open permit services</Button>
      </Section>
      <Section id="employers" title="Employers: post a job and confirm sponsorship" intro="A separate portal. Free to post. Live rule checks warn you while you type.">
        <Button href={EMPLOYERS_HREF}>Post a job</Button>
      </Section>
      <Section id="guides" title="Guides and government updates" action={<Button href={staticPath("guides")!} variant="outline" size="sm">All guides</Button>}>
        <Cards d={d} />
      </Section>
      <Section id="faq" title="Questions answered">
        <Faq d={d} />
      </Section>
      <section aria-labelledby="join-h" className={`${wrap} py-8 lg:py-12`}>
        <Card className="flex flex-col items-start gap-3 bg-green-tint">
          <h2 id="join-h" className="text-2xl lg:text-3xl">Create a free account and see every job</h2>
          <Button href="/signup" size="lg">Create free account</Button>
        </Card>
      </section>
    </>
  );
}
