// The home page (P6): frames N01 (node 472:2) and NM1 (308:5315), images in step16/design/images/. Server components only, no client script:
// every value comes from `data` (read in load.ts) or the dated DETE figures (dete.ts). Photos are the designer's Unsplash photos, self-hosted in
// ./photos (the engineer, 23 Nov 2026). Left out by decision: the Trusted Partner chip (L15), mock logos (L16), work-pattern tags (L45) and the
// Critical Skills fee sentence (Q130, CF1).
import type { ReactNode } from "react";
import type { JobCard } from "@portal/db";
import { A, Button, CriticalSkillsBadge, EmptyState, Icon, Notice, Pill, SITE_WORDMARK, SponsorBadge, type IconName } from "@portal/ui";
import { companyPath, guidePath, jobPath, occupationPath, staticPath, updatePath } from "../../lib/paths";
import { COUNTIES } from "./counties";
import { DETE_FIGURES as DETE, NUM, pct, topFiveShare } from "./dete";
import { eur, jobsIn, sectorLabel, shortDate } from "./format";
import { employersHref } from "./meta";
import { FEATURED, type Failed, type HomeData, type Jobs, type Minimums, type Occupation, type Sec, type SectorCount } from "./load";

const JOBS_LIMIT = 6; // #46: what a visitor sees of any list
const wrap = "mx-auto max-w-page px-5 sm:px-8";
const jobsPath = staticPath("jobs")!;
const checkerPath = staticPath("eligibility-checker")!;
const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;

// ---------- small parts the frame repeats ----------

// Imported, not in public/: the build puts a content hash in each file name and serves it cached for a year (public/ files are sent max-age=0).
// Next gives an image's { src }, Vitest its path.
const PHOTOS = import.meta.glob<string | { src: string }>("./photos/*.webp", { eager: true, import: "default" });
export function photoSrc(name: string) {
  const photo = PHOTOS[`./photos/${name}.webp`];
  if (!photo) throw new Error(`no photo ${name} in _home/photos`);
  return typeof photo === "string" ? photo : photo.src;
}

/** `true`: in view when the page opens, on every screen. "sm": only from 640 px (below that it is hidden, so a phone must not fetch it). */
type Eager = boolean | "sm";
/** A decorative photo from ./photos; the text beside it says what it shows, so alt is empty. */
function Photo({ name, className = "", eager }: { name: string; className?: string; eager?: Eager }) {
  const src = photoSrc(name);
  return (
    <>
      {eager === "sm" && <link rel="preload" as="image" href={src} media="(min-width: 40rem)" />}
      {/* eslint-disable-next-line @next/next/no-img-element -- the files are already sized webp; the image optimiser would add cost, not quality */}
      <img src={src} alt="" loading={eager === true ? "eager" : "lazy"} decoding="async" className={`object-cover ${className}`} />
    </>
  );
}
function Faces({ names, className = "size-12", eager }: { names: string[]; className?: string; eager?: Eager }) {
  return (
    <span aria-hidden="true" className="inline-flex -space-x-2 align-middle">
      {names.map((n) => <Photo key={n} name={n} eager={eager} className={`${className} rounded-pill border-2 border-white`} />)}
    </span>
  );
}

const HL = { peach: "bg-peach text-ink", green: "bg-deep-green text-white", lilac: "bg-lilac text-ink", white: "bg-white text-ink" } as const;
/** A heading's key word in a coloured pill (NS2: at most two pills and one media element a line). */
function Hl({ c, children }: { c: keyof typeof HL; children: ReactNode }) {
  return <span className={`inline-block rounded-[0.28em] px-[0.22em] pb-[0.08em] ${HL[c]}`}>{children}</span>;
}

const TONE = { ink: "bg-ink text-white", green: "bg-deep-green text-white", peach: "bg-peach text-ink", white: "bg-white text-ink" } as const;
type Tone = keyof typeof TONE;
/** A round icon in a heading line. */
function Dot({ icon = "up-right", tone = "green" }: { icon?: IconName; tone?: Tone }) {
  return (
    <span aria-hidden="true" className={`inline-grid size-[0.72em] place-items-center rounded-pill align-[0.05em] ${TONE[tone]}`}>
      <Icon name={icon} size={18} />
    </span>
  );
}
/** The round arrow a card carries. */
function Go({ tone = "ink", icon = "up-right", className = "" }: { tone?: Tone; icon?: IconName; className?: string }) {
  return (
    <span aria-hidden="true" className={`grid size-11 shrink-0 place-items-center rounded-pill ${TONE[tone]} ${className}`}>
      <Icon name={icon} size={18} />
    </span>
  );
}

const initials = (name: string) =>
  name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
/** The employer's logo, or its initials when it has none (frame N01's round logo chip). */
function Logo({ job, className = "size-11" }: { job: Pick<JobCard, "employerName" | "employerLogoUrl">; className?: string }) {
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center overflow-hidden rounded-pill bg-white font-heading text-small font-semibold text-ink ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a company logo from the portal's public store */}
      {job.employerLogoUrl ? <img src={job.employerLogoUrl} alt="" className="size-full object-contain p-1.5" /> : initials(job.employerName)}
    </span>
  );
}

function Head({ id, children, intro, action, center }: { id: string; children: ReactNode; intro?: ReactNode; action?: ReactNode; center?: boolean }) {
  return (
    <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
      <h2 id={`${id}-h`} className="text-[2.15rem] leading-[1.22] sm:text-[2.875rem]">{children}</h2>
      {(intro || action) && (
        <div className={`flex max-w-sm flex-col gap-4 ${center ? "mx-auto items-center text-center" : "items-start lg:items-end"}`}>
          {intro && <p className="text-muted">{intro}</p>}
          {action}
        </div>
      )}
    </div>
  );
}
function Section({ id, title, intro, action, children, center }: { id: string; title: ReactNode; intro?: ReactNode; action?: ReactNode; children: ReactNode; center?: boolean }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={`${wrap} py-12 lg:py-16`}>
      <Head id={id} intro={intro} action={action} center={center}>{title}</Head>
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

const firstJobs = (d: HomeData) => (d.jobs.ok ? d.jobs.data.jobs : []);
/** One card per employer, in list order. */
const byEmployer = (jobs: JobCard[]) => [...new Map(jobs.map((j) => [j.employerSlug, j])).values()];

// ---------- hero ----------

function Hero({ d }: { d: HomeData }) {
  const jobs = firstJobs(d);
  const first = jobs[0];
  return (
    <section aria-labelledby="hero-h" className={`${wrap} grid gap-8 pt-8 lg:grid-cols-[1fr_27.4rem] lg:gap-4 xl:grid-cols-[1fr_31.25rem] lg:pt-12`}>
      <div className="flex flex-col gap-7">
        <h1 id="hero-h" className="flex flex-col items-start gap-3 text-[2.5rem] leading-[1.1] sm:text-[4rem] lg:text-[3.5rem] xl:text-[4.875rem] xl:leading-[1.16]">
          <span className="flex flex-wrap items-center gap-3 sm:gap-5">
            <span className="rounded-2xl bg-peach px-4 pb-2 pt-1 sm:px-6">Find a job</span>
            <Go tone="green" className="size-9 sm:size-[3.8rem]" />
            <span className="hidden sm:inline-flex"><Faces eager="sm" names={["face-1", "face-2", "face-3"]} className="size-[3.8rem]" /></span>
          </span>
          <span className="flex flex-wrap items-center gap-4">
            <span className="rounded-2xl bg-deep-green px-4 pb-2 pt-1 text-white sm:px-6">a permit covers</span>
            <span aria-hidden="true" className="hidden gap-2 sm:flex lg:hidden xl:flex">
              {byEmployer(jobs).slice(0, 2).map((j) => <Logo key={j.employerSlug} job={j} className="size-[3.8rem] text-lg shadow-float" />)}
            </span>
          </span>
        </h1>
        <p className="max-w-[40rem] text-body text-muted lg:text-lead">
          Jobs in Ireland for people who need an employment permit. Every listing has passed Ireland&apos;s permit rules, or the employer has confirmed sponsorship.
        </p>
        <form action={jobsPath} method="get" role="search" className="flex max-w-[42.5rem] flex-col gap-2 rounded-bento bg-sand p-2 sm:flex-row sm:items-center sm:rounded-pill sm:bg-white sm:pl-6 sm:shadow-pop">
          <label className="flex flex-1 items-center gap-3 rounded-pill bg-white px-4 sm:px-0">
            <Icon name="search" className="shrink-0 text-muted" />
            <span className="sr-only">Job title</span>
            <input id="home-q" name="q" placeholder="Job title, e.g. Nurse" maxLength={200} autoComplete="off" className="min-h-12 w-full bg-transparent placeholder:text-muted" />
          </label>
          <label className="flex flex-1 items-center gap-3 rounded-pill bg-lilac px-4 sm:rounded-none sm:border-l sm:border-line sm:bg-transparent">
            <Icon name="pin" className="shrink-0 text-muted" />
            <span className="sr-only">County</span>
            <select id="home-county" name="county" defaultValue="" className="min-h-12 w-full bg-transparent">
              <option value="">County, e.g. Cork</option>
              {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <Button type="submit" size="lg">Find jobs <Icon name="arrow" size={16} /></Button>
        </form>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <div className="flex items-center gap-3">
            <Faces eager names={["face-4", "face-5", "face-6"]} className="size-12" />
            <p className="max-w-[9rem] text-small leading-snug text-muted"><strong className="block whitespace-nowrap text-[15px] text-ink">Free for candidates</strong>The job board is always free.</p>
          </div>
          <SponsorBadge />
          <CriticalSkillsBadge />
        </div>
      </div>
      <div className="relative self-start">
        <Photo name="hero" eager className="h-64 w-full rounded-bento sm:h-[29.25rem]" />
        <div className="absolute right-0 top-0 hidden rounded-bl-bento bg-white pb-3 pl-3 sm:block">
          <div className="rounded-3xl bg-white px-5 py-4 shadow-pop">
            <p className="text-small text-muted">Permits issued, {DETE.short}</p>
            <p className="font-heading text-2xl font-semibold">{NUM.format(DETE.total)}</p>
            <p className="text-small text-muted">Source: <A href={DETE.source} {...EXT} className="underline underline-offset-2">DETE</A></p>
          </div>
        </div>
        {first && (
          <div className="absolute bottom-0 left-0 rounded-tr-bento bg-white pr-3 pt-3">
            <A href={jobPath(first)} className="flex items-center gap-3 rounded-3xl bg-white p-4 no-underline shadow-pop">
              <Logo job={first} className="size-11 border border-line" />
              <span className="flex flex-col items-start gap-1">
                <span className="line-clamp-1 max-w-[14rem] font-semibold">{first.title}</span>
                {first.badge === "sponsor_confirmed" ? <SponsorBadge /> : first.badge === "critical_skills_eligible" ? <CriticalSkillsBadge /> : null}
              </span>
            </A>
          </div>
        )}
      </div>
    </section>
  );
}

function Bento({ m }: { m: Sec<Minimums> }) {
  const health = DETE.sectors[0];
  return (
    <div className={`${wrap} grid grid-cols-2 gap-3 py-4 sm:gap-4 lg:grid-cols-[1.31fr_1fr_1.05fr]`}>
      <div className="col-span-2 hidden gap-4 rounded-bento bg-deep-green p-6 text-white sm:flex lg:col-span-1">
        <Photo name="rules-card" eager="sm" className="hidden h-[14.4rem] w-[10.6rem] shrink-0 rounded-t-pill rounded-b-bento bg-white sm:block" />
        <div className="flex flex-col items-start gap-3 py-2">
          <h2 className="text-[1.25rem] leading-tight text-white xl:text-2xl">Every listing passes the permit rules first.</h2>
          <p className="text-white/85">Two badges say who makes each claim: the employer, or our rule check.</p>
          <A href="#badges" aria-label="How the two badges work" className="mt-auto"><Go tone="ink" icon="arrow" /></A>
        </div>
      </div>
      <div className="flex flex-col rounded-bento bg-peach p-4 sm:min-h-56 sm:p-7">
        <div className="hidden items-start justify-between gap-3 sm:flex">
          <Pill tone="white" className="font-medium">DETE, {DETE.short}</Pill>
          <A href="#permits" aria-label="Where permits go"><Go tone="ink" className="size-9" /></A>
        </div>
        <p className="mt-auto font-heading text-[2rem] font-semibold leading-none sm:text-[3.75rem]">{pct(health.share)}</p>
        <p className="mt-2 text-small sm:mt-3 sm:text-base">of permits go to health and social work, the first sector we cover.</p>
      </div>
      {m.ok && (
        <div className="flex flex-col rounded-bento bg-lilac p-4 sm:min-h-56 sm:p-7">
          <div className="hidden items-start justify-between gap-3 sm:flex">
            <p className="rounded-pill bg-white px-3 py-0.5 text-small font-medium">From the rules table</p>
            <A href={checkerPath} aria-label="Open the eligibility checker"><Go tone="green" className="size-9" /></A>
          </div>
          <p className="mt-auto font-heading text-[2rem] font-semibold leading-none sm:text-[3.75rem]">{eur(m.data.criticalSkills)}</p>
          <p className="mt-2 text-small text-muted sm:mt-3 sm:text-base">Critical Skills minimum with a relevant degree. We check every job against it.</p>
        </div>
      )}
    </div>
  );
}

/** "Employers with Irish permit history": the employers of the jobs shown that have DETE permits (real data, not a logo wall). */
function PermitHistory({ d }: { d: HomeData }) {
  const list = byEmployer(firstJobs(d).filter((j) => j.sponsorPermits)).slice(0, 4);
  if (!list.length) return null;
  return (
    <div className={`${wrap} hidden py-4 md:block`}>
      <div className="flex flex-wrap items-center justify-between gap-x-10 gap-y-4 rounded-[2.2rem] bg-sand px-9 py-5">
        <p className="max-w-[9.5rem] text-small font-semibold leading-snug">Employers with Irish permit history</p>
        {list.map((j) => (
          <A key={j.employerSlug} href={companyPath(j.employerSlug)} className="flex items-center gap-2 font-heading text-lg font-semibold no-underline hover:underline">
            <Logo job={j} className="size-8 border border-line text-[11px]" />
            {j.employerName}
          </A>
        ))}
      </div>
    </div>
  );
}

// ---------- sectors ----------

const TILE: Record<string, { fill: string; photo: string; shape: string }> = {
  health: { fill: "bg-green-tint", photo: "sector-health", shape: "lg:bottom-auto lg:h-[62%] lg:rounded-br-[5rem]" },
  hospitality: { fill: "bg-peach", photo: "sector-hospitality", shape: "lg:inset-auto lg:right-5 lg:top-5 lg:size-28 lg:rounded-pill" },
  IT: { fill: "bg-lilac", photo: "sector-it", shape: "lg:inset-auto lg:right-4 lg:top-4 lg:h-[7.5rem] lg:w-[9.5rem] lg:rounded-bento lg:rounded-bl-[4rem]" },
  "construction and engineering": { fill: "bg-ink lg:text-white", photo: "sector-construction", shape: "lg:opacity-55" },
  finance: { fill: "bg-sand", photo: "sector-finance", shape: "lg:inset-auto lg:right-4 lg:top-4 lg:h-[7.5rem] lg:w-[9.5rem] lg:rounded-bento lg:rounded-bl-[4rem]" },
  "pharma and science": { fill: "bg-pink", photo: "sector-pharma", shape: "lg:inset-auto lg:right-10 lg:top-4 lg:h-[7.5rem] lg:w-[6.3rem] lg:rounded-2xl" },
};

function Sectors({ s }: { s: Sec<SectorCount[]> }) {
  if (!s.ok) return <Unavailable r={s} />;
  const jobs = new Map(s.data.map((x) => [x.sector, x.jobs]));
  const tiled = new Set(DETE.sectors.map((x) => x.sector as string));
  const more = s.data.filter((x) => !tiled.has(x.sector) && x.jobs > 0);
  return (
    <ul className="grid grid-cols-2 gap-4 lg:grid-cols-[1.15fr_1fr_1fr_1fr] lg:grid-rows-[15.6rem_15.6rem]">
      {DETE.sectors.map((x, i) => {
        const t = TILE[x.sector]!;
        const n = jobs.get(x.sector) ?? 0;
        return (
          <li key={x.sector} className={i === 0 ? "min-h-[10.5rem] lg:row-span-2" : "min-h-[10.5rem] lg:min-h-[15.6rem]"}>
            <A href={`${jobsPath}?sector=${encodeURIComponent(x.sector)}`} className={`relative flex h-full flex-col justify-end overflow-hidden rounded-bento p-3 no-underline lg:p-6 ${t.fill}`}>
              <Photo name={t.photo} className={`absolute inset-0 size-full ${t.shape}`} />
              <span className="relative flex items-end justify-between gap-3">
                <span className="rounded-pill bg-white/90 px-3 py-1 text-ink lg:rounded-none lg:bg-transparent lg:p-0 lg:text-inherit">
                  <span className={`block text-small font-medium leading-tight lg:font-heading lg:font-semibold ${i === 0 ? "lg:text-[1.9rem]" : "lg:text-[1.4rem]"}`}>{x.short}<span className="lg:hidden"> · {pct(x.share)}</span></span>
                  <span className="hidden text-small opacity-85 lg:block">{pct(x.share)} of Irish permits{i === 0 ? " · nurses, doctors, care" : ""}</span>
                  <span className="hidden text-small font-semibold lg:block">{n > 0 ? jobsIn(n) : "No live jobs yet"}</span>
                </span>
                {i === 0 && <Go tone="green" className="hidden lg:grid" />}
              </span>
            </A>
          </li>
        );
      })}
      <li className="col-span-2 min-h-[8rem] lg:col-span-1 lg:min-h-[15.6rem]">
        <div className="flex h-full flex-col justify-between rounded-bento bg-deep-green p-6 text-white">
          <ul className="flex flex-wrap gap-2">
            {more.map((x) => (
              <li key={x.sector}>
                <A href={`${jobsPath}?sector=${encodeURIComponent(x.sector)}`} className="inline-flex min-h-9 items-center rounded-pill bg-white/90 px-3 text-small font-medium text-ink no-underline">
                  {sectorLabel(x.sector)} · {x.jobs}
                </A>
              </li>
            ))}
          </ul>
          <A href={jobsPath} className="flex items-end justify-between gap-3 text-white no-underline">
            <span className="font-heading text-[1.4rem] font-semibold">More sectors</span>
            <Go tone="ink" />
          </A>
        </div>
      </li>
    </ul>
  );
}

// ---------- latest jobs ----------

function Latest({ d }: { d: HomeData }) {
  const tabs = d.sectors.ok ? d.sectors.data.filter((x) => x.jobs > 0).sort((a, b) => b.jobs - a.jobs || a.sector.localeCompare(b.sector)) : [];
  const chip = (on: boolean) => `inline-flex min-h-9 shrink-0 items-center rounded-pill px-4 text-small font-semibold no-underline ${on ? "bg-ink text-white" : "border border-line bg-white text-ink hover:bg-hover-light"}`;
  const shown = d.jobs.ok ? d.jobs.data.jobs.length : 0;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-[2rem] bg-white px-6 py-3 shadow-pop sm:rounded-pill">
        <p className="leading-tight">
          <strong className="block">Showing {shown} {shown === 1 ? "job" : "jobs"}</strong>
          <span className="text-small text-muted">All passed the permit rules</span>
        </p>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          {tabs.length > 0 && (
            <div role="tablist" aria-label="Sector" className="flex min-w-0 max-w-full gap-2 overflow-x-auto [scrollbar-width:none]">
              <A role="tab" aria-selected={d.tab === null} href="/#latest-jobs" className={chip(d.tab === null)}>All</A>
              {tabs.map((x) => (
                <A key={x.sector} role="tab" aria-selected={d.tab === x.sector} href={`/?sector=${encodeURIComponent(x.sector)}#latest-jobs`} className={chip(d.tab === x.sector)}>
                  {sectorLabel(x.sector)}
                </A>
              ))}
            </div>
          )}
          <p className="text-small text-muted">Sort by <strong className="text-ink">Newest</strong></p>
        </div>
      </div>
      {!d.jobs.ok ? <Unavailable r={d.jobs} /> : <JobsGrid j={d.jobs.data} />}
    </>
  );
}

const JOB_FILL = ["bg-deep-green text-white", "bg-peach text-ink", "bg-lilac text-ink", "bg-sand text-ink"];
const JOB_ORDER = [0, 1, 2, 3, 0, 1]; // the frame's order: green, sun, lavender, then surface, green, sun

function JobTile({ c, i }: { c: JobCard; i: number }) {
  const dark = JOB_ORDER[i % JOB_ORDER.length] === 0;
  return (
    <article data-job-card className={`relative flex h-full min-h-[19.2rem] flex-col gap-3 rounded-bento p-6 ${JOB_FILL[JOB_ORDER[i % JOB_ORDER.length]!]}`}>
      <div className="flex items-start justify-between gap-3">
        <Pill tone="white" className="font-medium">{c.county ?? "Ireland"}</Pill>
        <Logo job={c} />
      </div>
      <div className="flex flex-wrap gap-2">
        {c.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}
        {c.badge === "sponsor_confirmed" && <SponsorBadge />}
        {c.quotaFull && <Pill tone="peach">Quota full</Pill>}
      </div>
      <h3 className="text-[1.35rem] leading-tight">
        <A href={jobPath(c)} className="no-underline after:absolute after:inset-0 after:rounded-bento hover:underline">{c.title}</A>
      </h3>
      <p className="-mt-1 opacity-80">{c.employerName}</p>
      {c.sponsorPermits ? (
        <p className="flex items-center gap-2 text-small font-semibold">
          <span className={`grid size-5 place-items-center rounded-pill ${dark ? "bg-white text-ink" : "bg-ink text-white"}`}><Icon name="check" size={12} /></span>
          Sponsored {NUM.format(c.sponsorPermits)} permits in 5 years
        </p>
      ) : null}
      <p className="mt-auto flex items-end justify-between gap-3 pt-1">
        <span className="font-heading text-xl font-semibold">{c.salaryLine ?? "Salary not stated"}</span>
        <Go tone={dark ? "peach" : "green"} />
      </p>
    </article>
  );
}

function JobsGrid({ j }: { j: Jobs }) {
  if (!j.jobs.length) return <EmptyState title="No jobs here yet">Try another sector, or look at every job.</EmptyState>;
  const hidden = j.signInForMore ? Math.min(3, Math.max(0, (j.count?.n ?? JOBS_LIMIT + 3) - j.jobs.length)) : 0;
  const box = j.signInForMore && (
    <div data-sign-in-for-more className={`flex flex-col gap-4 rounded-[2rem] bg-ink p-5 text-white sm:flex-row sm:items-center sm:justify-between ${hidden ? "absolute inset-x-0 top-6 z-[1] mx-auto max-w-[56rem]" : "mx-auto mt-6 max-w-[56rem]"}`}>
      <div className="flex items-center gap-4">
        <Go tone="peach" icon="lock" className="hidden sm:grid" />
        <div>
          <p className="font-heading text-lg font-semibold leading-snug">Want to see more jobs? Sign in or create a free account.</p>
          <p className="text-small text-white/75">
            {j.count ? `There ${j.count.n === 1 ? "is" : "are"} ${j.count.n}${j.count.more ? " or more" : ""} live ${j.count.n === 1 ? "job" : "jobs"}. ` : ""}Free for candidates. One question about your permit.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button href="/login" variant="outline" className="border-white text-white hover:bg-white/10">Sign in</Button>
        <Button href="/signup">Create free account</Button>
      </div>
    </div>
  );
  return (
    <>
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {j.jobs.map((c, i) => <li key={c.id}><JobTile c={c} i={i} /></li>)}
      </ul>
      {hidden > 0 ? (
        <div className="relative mt-4">
          <ul aria-hidden="true" className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: hidden }, (_, i) => (
              <li key={i} data-placeholder className={i > 0 ? "hidden md:block" : undefined}>
                <div className={`flex h-56 flex-col gap-3 rounded-bento p-6 opacity-60 blur-[5px] ${JOB_FILL[[2, 3, 0][i]!]}`}>
                  <div className="h-7 w-1/3 rounded-pill bg-white/70" />
                  <div className="h-6 w-3/4 rounded-pill bg-ink/15" />
                  <div className="h-4 w-1/2 rounded-pill bg-ink/15" />
                  <div className="mt-auto h-6 w-1/3 rounded-pill bg-ink/15" />
                </div>
              </li>
            ))}
          </ul>
          {box}
        </div>
      ) : (
        box
      )}
    </>
  );
}

// ---------- the rest ----------

function Badges() {
  return (
    <section id="badges" aria-labelledby="badges-h" className={`${wrap} py-12 lg:py-16`}>
      <h2 id="badges-h" className="text-[2.15rem] leading-[1.22] sm:text-[2.875rem]">
        Two badges <Dot icon="pen" tone="peach" /> <Dot icon="shield" tone="green" /> <Hl c="lilac">two sources</Hl>
      </h2>
      <p className="mb-10 mt-3 text-center text-muted">We say who makes each claim, so you can judge it.</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col items-start gap-4 rounded-bento bg-sand p-8 lg:p-9">
          <div className="flex w-full items-start justify-between"><SponsorBadge /><Go tone="white" icon="pen" className="text-sponsor-ink shadow-card" /></div>
          <h3 className="text-[1.85rem]">The employer&apos;s claim</h3>
          <p className="text-muted">The employer or agency signed a sponsorship statement for this job, with a named person. Look for the pen icon.</p>
          <p className="rounded-pill border border-ink px-3 py-1 text-small font-semibold">Source: the employer</p>
        </div>
        <div className="flex flex-col items-start gap-4 rounded-bento bg-sand p-8 lg:p-9">
          <div className="flex w-full items-start justify-between"><CriticalSkillsBadge /><Go tone="green" icon="shield" /></div>
          <h3 className="text-[1.85rem]">Our rule check</h3>
          <p className="text-muted">A job we fetched that passed every Critical Skills permit rule. It is not a promise from the employer. Look for the shield icon.</p>
          <p className="rounded-pill border border-ink px-3 py-1 text-small font-semibold">Source: {SITE_WORDMARK}, from the DETE rules</p>
        </div>
      </div>
    </section>
  );
}

const STEPS: [string, string, string][] = [
  ["Create a free account", "Sign up with your email, plus one question about your permit.", "bg-deep-green text-white"],
  ["Find jobs by sector", "Health, hospitality and IT first. Filter by county.", "bg-peach text-ink"],
  ["Apply", "Use the link on the job, then track it in your account.", "bg-lilac text-ink"],
  ["Got an offer? We can handle your permit", "Our services team supports the application.", "bg-ink text-white"],
];
function Steps() {
  return (
    <Section id="steps" title={<>From <Hl c="peach">search</Hl> <Dot /> to <Hl c="green">permit</Hl><br />in four steps</>} intro="Our permit services are paid by the employer or agency, never by you.">
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(([t, text, fill], i) => (
          <li key={t} className={`flex min-h-[18.7rem] flex-col justify-between gap-8 rounded-bento p-7 ${fill}`}>
            <p className={`font-heading text-[3.4rem] font-semibold leading-none ${i === 3 ? "text-peach" : ""}`}>{String(i + 1).padStart(2, "0")}</p>
            <div>
              <h3 className="text-[1.2rem] leading-tight">{t}</h3>
              <p className="mt-2 text-small opacity-85">{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Minimums({ m }: { m: Sec<Minimums> }) {
  const title = <>Check a <Hl c="peach">salary</Hl> <Dot icon="euro" /><br />against <Hl c="green">the rules</Hl></>;
  if (!m.ok) return <Section id="minimums" title={title}><Unavailable r={m} /></Section>;
  const d = m.data;
  const options: [string, string, number][] = [
    ["I have a relevant degree", "Critical Skills permit", d.criticalSkills],
    [`I got my degree in the last ${d.graduateMonths} months`, "Critical Skills permit, recent graduate", d.graduate],
    ...(d.general === null ? [] : [["I don't have a relevant degree", "General Employment permit", d.general] as [string, string, number]]),
  ];
  const show = ["group-has-[#deg-0:checked]:block", "group-has-[#deg-1:checked]:block", "group-has-[#deg-2:checked]:block"];
  return (
    <section id="minimums" aria-labelledby="minimums-h" className={`${wrap} grid items-center gap-10 py-12 lg:grid-cols-2 lg:py-16`}>
      <div className="flex flex-col items-start gap-5">
        <h2 id="minimums-h" className="text-[2.15rem] leading-[1.22] sm:text-[2.875rem]">{title}</h2>
        <p className="max-w-md text-muted">Tell us about your degree. We show which salary minimum applies. The eligibility checker shows whether a job clears it.</p>
        <p className="font-semibold">A Critical Skills permit needs a job offer of at least {d.minContractMonths} months.</p>
        {d.nextVersionOn && <p className="text-small text-muted">New minimums start on {shortDate(d.nextVersionOn)}.</p>}
        <Button href={checkerPath} variant="dark" size="lg">Open the eligibility checker <Icon name="arrow" size={16} /></Button>
      </div>
      <fieldset className="group flex flex-col gap-3 rounded-bento bg-sand p-7">
        <legend className="float-left mb-1 font-heading text-xl font-semibold">Your degree</legend>
        {options.map(([label], i) => (
          <label key={label} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-pill bg-lilac/70 px-5 has-[:checked]:bg-deep-green has-[:checked]:text-white">
            <input type="radio" name="home-degree" id={`deg-${i}`} defaultChecked={i === 0} className="size-4 accent-ink" />
            {label}
          </label>
        ))}
        {options.map(([label, permit, n], i) => (
          <div key={label} className={`mt-1 hidden rounded-3xl bg-peach p-5 ${show[i]}`}>
            <p className="text-small">Minimum that applies to you: {permit}</p>
            <p className="font-heading text-[1.9rem] font-semibold">{eur(n)} a year</p>
            <p className="flex items-center gap-2 text-small font-medium"><Icon name="check" size={16} />From the rules table, checked on {shortDate(d.rulesCheckedOn)}</p>
          </div>
        ))}
      </fieldset>
    </section>
  );
}

const BAR = ["bg-deep-green", "bg-peach", "bg-lilac", "bg-ink", "bg-ink"];
function Permits() {
  const top = DETE.sectors.slice(0, 5);
  const rest = 100 - topFiveShare;
  const max = Math.max(rest, ...top.map((x) => x.share));
  const rows: [string, number, string][] = [...top.map((x, i) => [x.short, x.share, BAR[i]!] as [string, number, string]), ["All other sectors", rest, "bg-line"]];
  return (
    <Section id="permits" title={<>Where <Hl c="lilac">{NUM.format(DETE.total)}</Hl> permits <Dot icon="trend" tone="peach" /> <Hl c="peach">actually go</Hl></>}>
      <div className="grid gap-4 lg:grid-cols-[19.7rem_1fr] xl:grid-cols-[22.5rem_1fr]">
        <div className="flex flex-col rounded-bento bg-ink p-7 text-white">
          <div className="flex items-start justify-between gap-3">
            <p className="rounded-pill bg-white/10 px-3 py-1 text-small">DETE, {DETE.short}</p>
            <A href={DETE.source} {...EXT} aria-label="DETE employment permit statistics (opens in a new tab)"><Go tone="peach" /></A>
          </div>
          <p className="mt-16 font-heading text-[4rem] font-semibold leading-none text-peach">{NUM.format(DETE.total)}</p>
          <p className="mt-2 text-white/75">employment permits issued</p>
          <div aria-hidden="true" className="mt-5 flex h-2.5 gap-1">
            {top.map((x, i) => <span key={x.short} style={{ width: `${x.share}%` }} className={`rounded-pill ${["bg-deep-green", "bg-peach", "bg-lilac", "bg-white", "bg-white/50"][i]}`} />)}
            <span style={{ width: `${rest}%` }} className="rounded-pill bg-white/15" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 border-t border-white/15 pt-5">
            <p><strong className="block font-heading text-2xl">{pct(top[0]!.share)}</strong><span className="text-small text-white/75">go to Health, the top sector</span></p>
            <p><strong className="block font-heading text-2xl">{pct(topFiveShare)}</strong><span className="text-small text-white/75">land in just five sectors</span></p>
          </div>
        </div>
        <div className="rounded-bento bg-sand p-8">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-[1.35rem]">Permits by sector</h3>
              <p className="text-small text-muted">Share of all employment permits issued, {DETE.short}</p>
            </div>
            <p className="rounded-pill bg-ink px-4 py-1.5 text-small font-semibold text-white">Share</p>
          </div>
          <ul className="flex flex-col gap-3">
            {rows.map(([label, share, fill]) => (
              <li key={label} className="grid grid-cols-[1fr_3rem] items-center gap-x-3 gap-y-1 sm:grid-cols-[14.25rem_1fr_3rem]">
                <span>{label}</span>
                <span className="col-span-2 row-start-2 h-5 sm:col-span-1 sm:row-start-auto sm:h-7"><span style={{ width: `${(share / max) * 100}%` }} className={`block h-full rounded-pill ${fill}`} /></span>
                <span className="text-right font-semibold">{pct(share)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-small text-muted">
            Source: <A href={DETE.source} {...EXT} className="underline underline-offset-2">DETE employment permits by sector</A>, {DETE.period}. Other sectors shown as the remainder.
          </p>
        </div>
      </div>
    </Section>
  );
}

const LIST_LINE: Record<string, string> = { "critical-skills": "On the Critical Skills list", other: "General Employment permit route", ineligible: "Only some roles qualify" };
const OCC_FILL = ["bg-teal", "bg-ink", "bg-deep-green"];
function Occupations({ o }: { o: Sec<Occupation[]> }) {
  if (o.ok && !o.data.length) return null;
  return (
    <Section
      id="occupations"
      title={<>Built for <Faces names={["face-7", "face-8", "face-1"]} className="size-[0.72em]" /> <Hl c="green">people</Hl><br />moving to <Hl c="peach">Ireland</Hl> <Photo name="guide-2" className="inline-block h-[0.7em] w-[1.35em] rounded-pill align-middle" /></>}
      intro="Browse by occupation. Each page shows the permit rules and the live jobs."
    >
      {!o.ok ? <Unavailable r={o} /> : (
        <ul className="-mx-5 flex snap-x gap-4 overflow-x-auto px-5 pb-4 sm:-mx-8 sm:px-8 [scrollbar-width:thin]">
          {o.data.map((x, i) => {
            const f = FEATURED.find((y) => y.code === x.code)!;
            return (
              <li key={x.code} className="w-64 shrink-0 snap-start">
                <A href={occupationPath(x.slug)} className={`relative flex h-full flex-col items-center rounded-bento p-3 pt-6 text-center text-white no-underline ${OCC_FILL[i % OCC_FILL.length]}`}>
                  <span className="rounded-pill bg-white/15 px-3 py-0.5 text-small">{f.sector}</span>
                  <span className="mt-3 line-clamp-2 min-h-[2.6em] px-2 font-heading text-lg font-semibold leading-tight">{x.title}</span>
                  <span className="mt-1 text-small text-white/80">{LIST_LINE[x.listStatus] ?? "See the permit rules"}</span>
                  <Photo name={f.photo} className="mt-5 h-80 w-full rounded-t-[8rem] rounded-b-card" />
                  <Go tone="white" icon="arrow" className="absolute bottom-6 right-6" />
                </A>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

const SERVICES: [IconName, string, string, string][] = [
  ["shield", "Free eligibility check", "Know where you stand first", "bg-peach"],
  ["clipboard", "Document checklist", "Exactly what to prepare", "bg-sand"],
  ["chat", "First consultation, free", "With a named case handler", "bg-sand"],
  ["receipt", "Who pays", "The employer or agency, never you", "bg-deep-green text-white"],
  ["copy", "Copies, never originals", "You upload copies; your passport stays with you", "bg-sand"],
  ["pulse", "Case tracker", "Every step, live", "bg-lilac"],
];
function PermitServices() {
  return (
    <section id="permit-services" aria-labelledby="permit-services-h" className={`${wrap} grid gap-4 py-12 lg:grid-cols-[32.4rem_1fr] xl:grid-cols-[37rem_1fr] lg:py-16 [&>*]:min-w-0`}>
      <div className="flex flex-col gap-6 rounded-bento bg-deep-green p-8 text-white lg:p-10">
        <h2 id="permit-services-h" className="text-[1.85rem] leading-[1.3] text-white sm:text-[2.6rem]">
          Got an offer?<br /><Hl c="white">We can handle</Hl><br />your permit <Dot tone="ink" />
        </h2>
        <p className="max-w-md text-white/85">Our own permit team handles the application with your employer and tracks the case with you. The employer or agency pays for it.</p>
        <div className="mt-auto flex flex-wrap items-center gap-4 pt-6">
          <Button href={staticPath("permit-services")!} variant="dark" size="lg">Open permit services <Icon name="arrow" size={16} /></Button>
          <span className="flex items-center gap-3 text-small text-white/85"><Faces names={["face-9", "face-10"]} className="size-10" />A named case handler</span>
        </div>
      </div>
      <div className="grid gap-4">
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {SERVICES.map(([icon, t, text, fill]) => (
            <li key={t} className={`flex min-h-40 min-w-0 flex-col gap-2 rounded-3xl p-4 [overflow-wrap:anywhere] ${fill}`}>
              <span aria-hidden="true" className={`mb-2 grid size-10 place-items-center rounded-xl ${fill.includes("deep-green") || fill.includes("peach") || fill.includes("lilac") ? "bg-ink" : "bg-deep-green"} text-white`}><Icon name={icon} size={18} /></span>
              <h3 className="font-sans text-[15px] font-semibold leading-snug">{t}</h3>
              <p className="text-small opacity-80">{text}</p>
            </li>
          ))}
        </ul>
        <div className="flex overflow-hidden rounded-bento bg-ink text-white">
          <div className="flex-1 p-7">
            <h3 className="text-[1.35rem] text-white">Who pays for our services?</h3>
            <p className="mt-2 text-small text-white/80">The employer or agency pays for our permit services. The job board is free for candidates.</p>
          </div>
          <Photo name="family" className="hidden w-52 rounded-l-[4rem] sm:block" />
        </div>
      </div>
    </section>
  );
}

function Employers() {
  const href = employersHref();
  return (
    <section id="employers" aria-labelledby="employers-h" className={`${wrap} py-12 lg:py-16`}>
      <div className="grid items-center gap-8 rounded-bento bg-ink p-8 text-white lg:grid-cols-[1fr_28rem] xl:grid-cols-[1fr_32rem] lg:p-5 lg:pl-12">
        <div className="flex flex-col items-start gap-5">
          <h2 id="employers-h" className="text-[2.15rem] leading-[1.3] text-white sm:text-[2.6rem]">
            Employers: <Hl c="green">post a job</Hl> <Dot icon="plus" tone="peach" /><br />and confirm <Hl c="peach">sponsorship</Hl>
          </h2>
          <p className="max-w-md text-white/75">A separate portal. Free to post. Live rule checks warn you while you type.</p>
          {href && (
            <div className="flex flex-wrap gap-2">
              <Button href={href}>Post a job</Button>
              <Button href={href} variant="outline" className="border-white text-white hover:bg-white/10">I&apos;m a recruitment agency</Button>
            </div>
          )}
        </div>
        <Photo name="employer" className="hidden h-[23.5rem] w-full rounded-bento rounded-tl-[6rem] rounded-bl-[5rem] lg:block" />
      </div>
    </section>
  );
}

function Guides({ d }: { d: HomeData }) {
  const items = [
    ...(d.guides.ok ? d.guides.data.map((g) => ({ key: `g-${g.slug}`, kind: "Guide", title: g.title, href: guidePath(g.slug), on: g.checkedOn })) : []),
    ...(d.updates.ok ? d.updates.data.map((u) => ({ key: `u-${u.slug}`, kind: "Government update", title: u.title, href: updatePath(u.slug), on: u.checkedOn })) : []),
  ].slice(0, 3);
  let body: ReactNode;
  if (!d.guides.ok && !d.updates.ok) body = <Unavailable r={d.guides} />;
  else if (!items.length) body = <p className="text-muted">Guides and government updates will appear here when they are published.</p>;
  else
    body = (
      <ul className="grid gap-4 md:grid-cols-3">
        {items.map((it, i) => (
          <li key={it.key}>
            <article className="relative flex h-full flex-col rounded-bento bg-sand p-3 pb-6">
              <div className="relative">
                <Photo name={`guide-${(i % 3) + 1}`} className="h-[13rem] w-full rounded-card" />
                <Pill tone="white" className="absolute left-3 top-3 font-medium">{it.kind}</Pill>
              </div>
              <h3 className="mt-4 px-3 text-lg leading-snug">
                <A href={it.href} className="no-underline after:absolute after:inset-0 after:rounded-bento hover:underline">{it.title}</A>
              </h3>
              <p className="mt-auto flex items-center justify-between gap-3 px-3 pt-4 text-small text-muted">
                {it.on ? `Checked on ${shortDate(it.on)}` : ""}
                <Go tone="green" className="size-9" />
              </p>
            </article>
          </li>
        ))}
      </ul>
    );
  return (
    <Section
      id="guides"
      title={<><Hl c="lilac">Guides</Hl> and government<br /><Hl c="green">updates</Hl> <Photo name="employer" className="inline-block h-[0.7em] w-[1.35em] rounded-pill align-middle" /></>}
      action={<Button href={staticPath("guides")!} variant="outline">All guides <Icon name="arrow" size={16} /></Button>}
    >
      {body}
    </Section>
  );
}

function Scam() {
  return (
    <div className={`${wrap} py-4`}>
      <div className="flex flex-col items-start gap-4 rounded-[2rem] bg-peach p-6 sm:flex-row sm:items-center sm:rounded-pill sm:px-7 sm:py-5">
        <Go tone="ink" icon="warning" />
        <p className="flex-1 font-semibold sm:text-lg">No genuine employer asks you to pay for a job offer. Report it.</p>
        <Button href="/report" variant="dark"><Icon name="flag" size={16} />Report a listing</Button>
      </div>
    </div>
  );
}

function Faq({ d }: { d: HomeData }) {
  const checked = d.minimums.ok ? ` The rules were last checked on ${shortDate(d.minimums.data.rulesCheckedOn)}.` : "";
  const qa: [string, string][] = [
    ["Do I pay to use the site or for its permit services?", "No. The job board is free for candidates. Our permit services are paid by the employer or agency."],
    ["What does \"Sponsor confirmed\" mean?", "The employer or agency signed a sponsorship statement for this job, with a named person. It is the employer's claim."],
    ["What does \"Critical Skills eligible\" mean?", "A job we fetched passed every Critical Skills permit rule in our check. It is not a promise from the employer."],
    ["Why are some jobs blurred?", `Visitors see the latest ${JOBS_LIMIT} jobs of any list. Create a free account to see every job.`],
    ["Where do the salary minimums come from?", `From the DETE rules table.${checked}`],
  ];
  return (
    <Section id="faq" title={<>Questions <Hl c="green">answered</Hl> <Dot icon="help" tone="peach" /></>}>
      <div className="mx-auto flex max-w-[57.5rem] flex-col gap-3">
        {qa.map(([q, a], i) => (
          <details key={q} open={i === 0} className="group rounded-[1.9rem] bg-sand px-7 py-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
              {q}
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-pill bg-white group-open:bg-deep-green group-open:text-white">
                <Icon name="plus" size={16} className="group-open:hidden" />
                <Icon name="minus" size={16} className="hidden group-open:block" />
              </span>
            </summary>
            <p className="mt-2 max-w-[42rem] text-muted">{a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/** The dark join band the footer runs on from (frame N01): only for a visitor. data-join tells the footer to drop its gap and corners. */
function Join() {
  return (
    <section data-join aria-labelledby="join-h" className="mt-12 rounded-t-[2.5rem] bg-ink text-white">
      <div className={`${wrap} flex flex-col items-start justify-between gap-8 border-b border-white/15 py-14 lg:flex-row lg:items-center`}>
        <h2 id="join-h" className="text-[2.4rem] leading-[1.3] text-white sm:text-[3.75rem]">
          Create a <Hl c="green">free</Hl> account <Dot tone="peach" /><br />and see <Hl c="peach">every job</Hl>
        </h2>
        <Button href="/signup" size="lg">Create free account <Icon name="arrow" size={16} /></Button>
      </div>
    </section>
  );
}

export function HomeView({ data: d }: { data: HomeData }) {
  return (
    <>
      <Hero d={d} />
      <Bento m={d.minimums} />
      <PermitHistory d={d} />
      <Section
        id="sectors"
        title={<>Pick a <Dot icon="plus" tone="peach" /> <Hl c="green">sector</Hl><br />that sponsors <Photo name="sector-construction" className="inline-block h-[0.7em] w-[1.35em] rounded-pill align-middle" /> <Hl c="lilac">you</Hl></>}
        intro={`In the order permits are issued. Shares are DETE figures, ${DETE.period}; job counts are ours, live today.`}
      >
        <Sectors s={d.sectors} />
      </Section>
      <Section
        id="latest-jobs"
        title={<><Hl c="peach">Latest jobs</Hl> at <span className="hidden gap-1 align-middle sm:inline-flex">{byEmployer(firstJobs(d)).slice(0, 4).map((j) => <Logo key={j.employerSlug} job={j} className="size-10 border border-line text-[13px]" />)}</span><br /><Hl c="green">checked</Hl> today <Dot icon="check" tone="ink" /></>}
        action={<Button href={jobsPath} variant="outline">View all jobs <Icon name="arrow" size={16} /></Button>}
      >
        <Latest d={d} />
      </Section>
      <Badges />
      <Steps />
      <Minimums m={d.minimums} />
      <Permits />
      <Occupations o={d.occupations} />
      <PermitServices />
      <Employers />
      <Guides d={d} />
      <Scam />
      <Faq d={d} />
      {!d.signedIn && <Join />}
    </>
  );
}
