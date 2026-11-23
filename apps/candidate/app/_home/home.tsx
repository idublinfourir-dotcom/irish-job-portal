// The home page (P6, frames 3 and 76): server components only, every value from `data` (read in load.ts), no client script.
// Cut by #287: occupation carousel, national DETE figures, logo strip, Trusted Partner chip, work-pattern tags, Medical devices and Retail tiles.
import type { ReactNode } from "react";
import { A, Button, CriticalSkillsBadge, EmptyState, Icon, Input, Notice, Pill, Select, SponsorBadge, Tabs } from "@portal/ui";
import { guidePath, jobPath, staticPath, updatePath } from "../../lib/paths";
import { COUNTIES } from "./counties";
import { eur, jobsIn, sectorLabel, shortDate } from "./format";
import { employersHref } from "./meta";
import type { Failed, HomeData, Jobs, Minimums, SectorCount, Sec } from "./load";

const JOBS_LIMIT = 6; // #46: what a visitor sees of any list
const wrap = "mx-auto max-w-page px-4";
const jobsPath = staticPath("jobs")!;

type Fill = "forest" | "orange" | "lilac" | "pink" | "mist" | "mint" | "ink";
const FILL: Record<Fill, string> = {
  forest: "bg-deep-green text-white",
  orange: "bg-orange text-ink",
  lilac: "bg-lilac text-ink",
  pink: "bg-pink text-ink",
  mist: "bg-mist text-ink",
  mint: "bg-green-tint text-ink",
  ink: "bg-ink text-white",
};
const bento = "rounded-bento";
/** A highlighted word in a heading, as on the designer's page. */
const HL: Record<string, string> = { orange: "bg-orange", forest: "bg-deep-green text-white", lilac: "bg-lilac" };
function Hl({ c, children }: { c: keyof typeof HL; children: ReactNode }) {
  return <mark className={`rounded-2xl px-3 text-inherit ${HL[c]}`}>{children}</mark>;
}
/** The round arrow chip the cards carry. */
function Go({ tone = "ink" }: { tone?: "ink" | "orange" | "forest" }) {
  const t = { ink: "bg-ink text-white", orange: "bg-orange text-ink", forest: "bg-deep-green text-white" }[tone];
  return <span aria-hidden="true" className={`grid size-10 shrink-0 place-items-center rounded-pill ${t}`}><Icon name="arrow" size={18} /></span>;
}

function Section({ id, title, intro, children, action, center }: { id: string; title: ReactNode; intro?: ReactNode; children: ReactNode; action?: ReactNode; center?: boolean }) {
  return (
    <section aria-labelledby={`${id}-h`} id={id} className={`${wrap} py-10 lg:py-16`}>
      <div className={`mb-8 flex flex-wrap justify-between gap-4 ${center ? "flex-col items-center text-center" : "items-end"}`}>
        <h2 id={`${id}-h`} className="max-w-[18ch] text-4xl leading-[1.25] tracking-tight lg:text-5xl lg:leading-[1.25]">{title}</h2>
        {intro && <p className="max-w-sm text-muted">{intro}</p>}
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
    <>
      <div className={`${wrap} grid gap-8 pt-8 lg:grid-cols-[1.05fr_1fr] lg:pt-12`}>
        <div className="flex flex-col gap-6 self-center">
          <h1 className="text-5xl leading-[1.3] tracking-tight lg:text-7xl lg:leading-[1.3]">
            <span className="rounded-3xl bg-orange px-4">Find a job</span><br />
            <span className="rounded-3xl bg-deep-green px-4 text-white">a permit covers</span>
          </h1>
          <p className="max-w-prose text-lg text-muted">
            Jobs in Ireland for people who need an employment permit. Each job carries one of two badges: our rule check passed, or the employer confirmed sponsorship.
          </p>
          <form action={jobsPath} method="get" className="grid gap-3 rounded-bento bg-white p-4 shadow-pop sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <Input id="home-q" name="q" label="Job title" placeholder="Job title, e.g. Nurse" maxLength={200} autoComplete="off" />
            <Select id="home-county" name="county" label="County" defaultValue="">
              <option value="">Any county</option>
              {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
            <Button type="submit" size="lg" className="rounded-pill">Find jobs</Button>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-small text-muted"><strong className="text-ink">Free for candidates.</strong> The job board is always free.</p>
            <SponsorBadge />
            <CriticalSkillsBadge />
          </div>
        </div>
        <div aria-hidden="true" className={`relative hidden min-h-[26rem] overflow-hidden ${bento} bg-sand lg:block`}>
          <div className="absolute right-6 top-6 h-2/3 w-3/4 rounded-[2.5rem] bg-green-tint" />
          <div className="absolute bottom-16 left-6 h-1/3 w-1/2 rounded-[2.5rem] bg-peach" />
        </div>
      </div>
      <div className={`${wrap} grid gap-4 py-6 md:grid-cols-3`}>
        <Link3 />
        <div className={`${bento} flex flex-col justify-end gap-2 bg-orange p-6`}>
          <p className="font-heading text-5xl font-semibold">Free</p>
          <p>The job board is free for candidates. Permit services are paid by the employer or agency.</p>
        </div>
        {m.ok && (
          <div className={`${bento} flex flex-col justify-end gap-2 bg-lilac p-6`}>
            <p className="text-small font-semibold">From the rules table</p>
            <p className="font-heading text-5xl font-semibold">{eur(m.data.criticalSkills)}</p>
            <p>Critical Skills minimum with a relevant degree. We check every job against it.</p>
            <p className="text-small text-muted">Checked on {shortDate(m.data.rulesCheckedOn)}</p>
          </div>
        )}
      </div>
    </>
  );
}

function Link3() {
  return (
    <div className={`${bento} flex flex-col justify-between gap-6 bg-deep-green p-6 text-white`}>
      <div>
        <h3 className="text-2xl">Every listing passes the permit rules first.</h3>
        <p className="mt-2 text-white/85">Two badges say who makes each claim: the employer, or our rule check.</p>
      </div>
      <A href={jobsPath} aria-label="See the jobs"><Go /></A>
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
      <div className="flex flex-col items-start gap-4">
        <p className="font-semibold">A Critical Skills job offer must run at least {d.minContractMonths} months.</p>
        <p className="text-small text-muted">
          From the rules table, checked on {shortDate(d.rulesCheckedOn)}.{d.nextVersionOn && ` New minimums start on ${shortDate(d.nextVersionOn)}.`}
        </p>
        <Button href={staticPath("eligibility-checker")!} variant="primary" className="rounded-pill bg-ink hover:bg-ink">Open the eligibility checker</Button>
      </div>
      <dl className={`${bento} flex flex-col gap-3 bg-mist p-5`}>
        {rows.map(([label, n], i) => (
          <div key={label} className={`flex items-baseline justify-between gap-4 rounded-3xl p-4 ${i === 0 ? "bg-deep-green text-white" : "bg-lilac"}`}>
            <dt>{label}</dt>
            <dd className="font-heading text-xl font-semibold">{eur(n)} a year</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const SECTOR_FILLS: Fill[] = ["mint", "orange", "lilac", "forest", "mist", "pink"];
function Sectors({ s }: { s: Sec<SectorCount[]> }) {
  if (!s.ok) return <Unavailable r={s} />;
  const live = s.data.filter((x) => x.jobs > 0).sort((a, b) => b.jobs - a.jobs || a.sector.localeCompare(b.sector));
  if (!live.length) return <EmptyState title="No live jobs yet">New jobs appear here as soon as they pass our checks.</EmptyState>;
  return (
    <ul className="grid grid-cols-2 gap-4 lg:auto-rows-[13.5rem] lg:grid-cols-4">
      {live.map((x, i) => (
        <li key={x.sector} className={i === 0 ? "col-span-2 lg:col-span-1 lg:row-span-2" : undefined}>
          <A href={`${jobsPath}?sector=${encodeURIComponent(x.sector)}`} className={`flex h-full min-h-40 flex-col justify-end gap-1 p-6 no-underline ${bento} ${FILL[SECTOR_FILLS[i % SECTOR_FILLS.length]!]}`}>
            <h3 className="text-2xl">{sectorLabel(x.sector)}</h3>
            <p className="flex items-center justify-between gap-2 text-small opacity-80">{jobsIn(x.jobs)}<Go tone={i === 0 ? "forest" : "ink"} /></p>
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

const JOB_FILLS: Fill[] = ["forest", "orange", "lilac", "mist"];
function JobsGrid({ j }: { j: Jobs }) {
  if (!j.jobs.length) return <EmptyState title="No jobs here yet">Try another sector, or look at every job.</EmptyState>;
  const hidden = j.signInForMore ? Math.min(3, Math.max(0, (j.count?.n ?? JOBS_LIMIT + 3) - j.jobs.length)) : 0;
  return (
    <>
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {j.jobs.map((c, i) => {
          const f = JOB_FILLS[i % JOB_FILLS.length]!;
          return (
            <li key={c.id}>
              <article className={`flex h-full min-h-60 flex-col gap-2 p-6 ${bento} ${FILL[f]}`}>
                <div className="flex flex-wrap gap-2">
                  {c.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}
                  {c.badge === "sponsor_confirmed" && <SponsorBadge />}
                  {c.quotaFull && <Pill tone="peach">Quota full</Pill>}
                </div>
                <h3 className="mt-2 text-2xl"><A href={jobPath(c)} className="no-underline hover:underline">{c.title}</A></h3>
                <p className="opacity-85">{c.employerName}</p>
                <p className="flex items-center gap-1.5 text-small opacity-85"><Icon name="pin" size={16} />{c.county ?? "Ireland"}</p>
                <p className="mt-auto flex items-center justify-between gap-3 pt-3 text-xl font-semibold">{c.salaryLine ?? "Salary not stated"}<Go tone={f === "forest" ? "orange" : "forest"} /></p>
              </article>
            </li>
          );
        })}
        {Array.from({ length: hidden }, (_, i) => (
          <li key={`hidden-${i}`} aria-hidden="true" data-placeholder>
            <div className={`flex min-h-60 flex-col gap-3 p-6 blur-[2px] ${bento} ${FILL[JOB_FILLS[(j.jobs.length + i) % JOB_FILLS.length]!]}`}>
              <div className="h-6 w-3/4 rounded-control bg-ink/10" />
              <div className="h-4 w-1/2 rounded-control bg-ink/10" />
              <div className="h-4 w-1/3 rounded-control bg-ink/10" />
            </div>
          </li>
        ))}
      </ul>
      {j.signInForMore && (
        <div data-sign-in-for-more className={`mx-auto mt-6 flex max-w-3xl flex-col items-start gap-4 bg-ink p-5 text-white sm:flex-row sm:items-center sm:justify-between ${bento}`}>
          <div>
            <p className="font-heading text-xl font-semibold">Want to see more jobs? Log in or create a free account.</p>
            <p className="text-small text-white/80">{j.count ? `There ${j.count.n === 1 ? "is" : "are"} ${j.count.n}${j.count.more ? " or more" : ""} live ${j.count.n === 1 ? "job" : "jobs"}. ` : ""}Free for candidates. One question about your permit.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button href="/login" variant="outline" className="rounded-pill border-white bg-transparent text-white hover:bg-white/10">Log in</Button>
            <Button href="/signup" className="rounded-pill bg-deep-green text-white">Create free account</Button>
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
          <article className={`flex h-full min-h-44 flex-col gap-2 p-6 ${bento} bg-mist`}>
            <Pill tone={i.kind === "Guide" ? "green" : "peach"} className="self-start">{i.kind}</Pill>
            <h3 className="text-lg"><A href={i.href} className="underline-offset-2 hover:underline">{i.title}</A></h3>
            {i.on && <p className="mt-auto text-small text-muted">Checked on {shortDate(i.on)}</p>}
          </article>
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
        <div key={q} className={`${bento} bg-mist p-6`}>
          <dt className="font-heading text-lg font-semibold">{q}</dt>
          <dd className="mt-1">{a}</dd>
        </div>
      ))}
    </dl>
  );
}

const STEP_FILLS: Fill[] = ["forest", "orange", "lilac", "ink"];

export function HomeView({ data: d }: { data: HomeData }) {
  return (
    <>
      <Hero m={d.minimums} />
      <Section id="sectors" title={<>Pick a <Hl c="forest">sector</Hl><br />that sponsors <Hl c="lilac">you</Hl></>} intro="Live jobs in each sector today.">
        <Sectors s={d.sectors} />
      </Section>
      <Section id="latest-jobs" title={<><Hl c="orange">Latest jobs</Hl> at<br /><Hl c="forest">checked</Hl> today</>} action={<Button href={jobsPath} variant="outline" size="sm" className="rounded-pill">View all jobs</Button>}>
        <Latest d={d} />
      </Section>
      <Section id="badges" center title={<>Two badges <Hl c="lilac">two sources</Hl></>} intro="We say who makes each claim, so you can judge it.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className={`${bento} flex flex-col items-start gap-3 bg-mist p-8`}>
            <SponsorBadge />
            <h3 className="text-2xl">The employer&apos;s claim</h3>
            <p>The employer or agency signed a sponsorship statement for this job, with a named person. Look for the pen icon.</p>
            <p className="rounded-pill border border-ink px-3 text-small">Source: the employer</p>
          </div>
          <div className={`${bento} flex flex-col items-start gap-3 bg-mist p-8`}>
            <CriticalSkillsBadge />
            <h3 className="text-2xl">Our rule check</h3>
            <p>A job we fetched that passed every Critical Skills permit rule. It is not a promise from the employer. Look for the shield icon.</p>
            <p className="rounded-pill border border-ink px-3 text-small">Source: our rule check, from the DETE rules</p>
          </div>
        </div>
      </Section>
      <Section id="steps" title={<>From <Hl c="orange">search</Hl> to <Hl c="forest">permit</Hl><br />in four steps</>} intro="Our paid permit services are paid by the employer or agency, never by you.">
        <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([t, text], i) => (
            <li key={t}>
              <div className={`${bento} flex h-full min-h-72 flex-col justify-between gap-8 p-6 ${FILL[STEP_FILLS[i]!]}`}>
                <p className={`font-heading text-5xl font-semibold ${i === 3 ? "text-orange" : ""}`}>{String(i + 1).padStart(2, "0")}</p>
                <div>
                  <h3 className="text-xl">{t}</h3>
                  <p className="mt-1 opacity-85">{text}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Section>
      <Section id="minimums" title={<>Check a <Hl c="orange">salary</Hl><br />against <Hl c="forest">the rules</Hl></>} intro="Which salary minimum applies depends on your degree. The eligibility checker shows whether a job clears it.">
        <Minimums m={d.minimums} />
      </Section>
      <Section id="permit-services" title={<>Got an offer? We can <Hl c="forest">handle</Hl> your permit</>} intro="Our own permit team handles the application with your employer and tracks the case with you. The employer or agency pays for it.">
        <ul className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICES.map(([t, text], i) => (
            <li key={t} className={`flex gap-3 p-5 ${bento} ${FILL[(["mint", "orange", "lilac", "pink"] as Fill[])[i]!]}`}>
              <Icon name="check" className="mt-1 shrink-0" />
              <div><h3 className="text-lg">{t}</h3><p className="text-small opacity-80">{text}</p></div>
            </li>
          ))}
        </ul>
        <Button href={staticPath("permit-services")!} className="rounded-pill">Open permit services</Button>
      </Section>
      <Section id="employers" title={<>Employers: post a job and <Hl c="orange">confirm</Hl> sponsorship</>} intro="A separate portal. Free to post. Live rule checks warn you while you type.">
        {employersHref() && <Button href={employersHref()!} className="rounded-pill">Post a job</Button>}
      </Section>
      <Section id="guides" title={<>Guides and <Hl c="lilac">government updates</Hl></>} action={<Button href={staticPath("guides")!} variant="outline" size="sm" className="rounded-pill">All guides</Button>}>
        <Cards d={d} />
      </Section>
      <Section id="faq" title={<>Questions <Hl c="orange">answered</Hl></>}>
        <Faq d={d} />
      </Section>
      {!d.signedIn && (
        <section aria-labelledby="join-h" className={`${wrap} py-10 lg:py-16`}>
          <div className={`${bento} flex flex-col items-center gap-5 bg-deep-green p-10 text-center text-white lg:p-16`}>
            <h2 id="join-h" className="max-w-[22ch] text-4xl text-white lg:text-5xl">Create a free account and see every job</h2>
            <Button href="/signup" size="lg" className="rounded-pill bg-orange text-ink hover:bg-orange">Create free account</Button>
          </div>
        </section>
      )}
    </>
  );
}
