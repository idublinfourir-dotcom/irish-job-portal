// The company page body (frame C12): a pure view of what the page read. [slug]/page.tsx reads; this file only shows.
// Not built, by decision #287: the CRO number and status (Q44), the company alert (Q43), the sector chip (Q112), per-legal-name permit counts, the designer's demo of the labels
// on other companies. A frame photo is a neutral block (NS6). Every figure is the read's: nothing typed.
import type { ReactNode } from "react";
import { Breadcrumb, Icon, Pager, Pill } from "@portal/ui";
import { SignInMore } from "../_content/limit";
import { Mark, SectionTitle, wrap } from "../_content/head";
import { ResultCard, type CardJob } from "../jobs/card";
import { initials } from "../jobs/format";
import { Join, PhotoBlock } from "../jobs/parts";
import { MONTH_NAMES, PermitChart, monthSeries, plural, shortMonth, yearBars } from "./chart";
import { ReportCompany } from "./report-company";

export type CompanyData = {
  id: string; slug: string; name: string; website: string | null; logoUrl: string | null; shortDescription: string | null; county: string | null; claimed: boolean; labels: string[];
  names: { name: string; kind: string }[];
  permits: {
    byYear: { year: number; permits: number }[]; peakYear: number | null; trend: "up" | "down" | "flat" | null;
    latestMonth: { year: number; month: number; permits: number } | null; byMonth: { year: number; month: number; permits: number }[]; dataThrough: { year: number; month: number } | null;
  } | null;
  jobs: { jobs: CardJob[]; count: { n: number; more: boolean } | null; signInForMore: boolean };
};
export type CompanyProps = { company: CompanyData; now: Date; signedIn: boolean; savedIds: string[]; path: string; prevHref?: string; nextHref?: string };

const TREND = { up: "Rising", down: "Falling", flat: "Steady" } as const;
export const NOT_LINKED = "We could not match this employer to DETE records, so we claim nothing either way.";
export const FIRST_TIME = "We found no DETE permit history for this employer since 2019.";
export const CLAIMS_REMOVED = "This company made sponsorship claims that were confirmed false three times. Its jobs are no longer listed.";

/** The company's name with its last words on a band (two for a name of three words or more, one for two words, none for one). */
export function NameTitle({ name }: { name: string }) {
  const w = name.split(/\s+/).filter(Boolean);
  const k = w.length >= 3 ? 2 : w.length === 2 ? 1 : 0;
  return k === 0 ? <>{name}</> : <>{w.slice(0, -k).join(" ")} <Mark tone="tint">{w.slice(-k).join(" ")}</Mark></>;
}
/** The website as the host to show and the address to open, only for an http or https address; anything else is not shown. */
export function siteOf(website: string | null): { host: string; href: string } | null {
  if (!website) return null;
  try {
    const u = new URL(website);
    return u.protocol === "https:" || u.protocol === "http:" ? { host: u.host.replace(/^www\./, ""), href: u.href } : null;
  } catch { return null; }
}
const sum = (p: { permits: number }[]) => p.reduce((a, b) => a + b.permits, 0);

function Identity({ c, path, signedIn }: { c: CompanyData; path: string; signedIn: boolean }) {
  const site = siteOf(c.website);
  const labels = c.labels;
  return (
    <section aria-labelledby="company-h" className="flex flex-col gap-5 rounded-bento border border-line bg-sand p-6 shadow-card sm:p-8">
      <div className="flex items-start gap-4 sm:gap-6">
        <span aria-hidden="true" data-company-logo className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-card bg-green-tint font-heading text-[1.5rem] font-semibold sm:size-[84px] sm:text-[2rem]">
          {/* eslint-disable-next-line @next/next/no-img-element -- the company's own logo from the portal's public store */}
          {c.logoUrl ? <img src={c.logoUrl} alt="" className="size-full object-contain p-2" /> : initials(c.name)}
        </span>
        <div className="min-w-0">
          <h1 id="company-h" className="break-words text-[2rem] leading-[1.4] sm:text-[2.75rem]"><NameTitle name={c.name} /></h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-ui text-muted">
            {c.county && <span className="inline-flex items-center gap-1.5"><Icon name="pin" size={16} />{c.county}</span>}
            {site && <a href={site.href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1.5 underline-offset-2 hover:underline"><Icon name="globe" size={16} /><span className="break-all">{site.host}</span></a>}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
          {c.claimed && <Pill tone="green" className="min-h-0 gap-1.5 px-3 py-[5px] text-[13px]"><Icon name="check" size={14} />Claimed</Pill>}
          {labels.map((l) => <Pill key={l} tone={l === "Public sector pay scale employer" ? "lilac" : l === "First-time sponsor" ? "peach" : l === "Sponsorship claims removed" ? "peach" : "outline"} className="min-h-0 px-3 py-[5px] text-[13px]">{l}</Pill>)}
        <ReportCompany companyId={c.id} name={c.name} signedIn={signedIn} path={path} />
      </div>
      {labels.includes("Sponsorship claims removed") && <p className="text-ui">{CLAIMS_REMOVED}</p>}
      {c.shortDescription && <p className="max-w-[44rem] break-words text-body text-muted">{c.shortDescription}</p>}
    </section>
  );
}

function Stat({ tone, label, value, note }: { tone: "peach" | "sand" | "ink"; label: string; value: string; note: string }) {
  const box = { peach: "bg-peach", sand: "border border-line bg-sand", ink: "bg-ink text-white" }[tone];
  return (
    <div data-stat={label} className={`flex flex-col gap-1 rounded-bento p-5 shadow-card ${box}`}>
      <p className={`text-small ${tone === "ink" ? "text-white/85" : "text-muted"}`}>{label}</p>
      <p className={`font-heading text-[1.75rem] font-semibold leading-tight ${tone === "peach" ? "text-[#8a4b0f]" : ""}`}>{value}</p>
      <p className={`text-ui ${tone === "ink" ? "text-white/85" : "text-muted"}`}>{note}</p>
    </div>
  );
}

function History({ c, now }: { c: CompanyData; now: Date }) {
  const p = c.permits;
  if (!p || p.byYear.length === 0) {
    const why = c.labels.includes("Permit history not linked yet") ? NOT_LINKED : c.labels.includes("First-time sponsor") ? FIRST_TIME : "There are no DETE permit figures for this company.";
    return <p data-history-empty className="rounded-bento border border-dashed border-line bg-sand p-6 text-muted">{why}</p>;
  }
  const year = now.getUTCFullYear();
  const end = p.dataThrough ?? (p.latestMonth ? { year: p.latestMonth.year, month: p.latestMonth.month } : null);
  const permitsIn = (y: number) => p.byYear.find((b) => b.year === y)?.permits ?? 0;
  const cutOff = p.dataThrough ? `${p.dataThrough.year} covers January to ${MONTH_NAMES[p.dataThrough.month - 1]}.` : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="rounded-bento border border-line bg-sand p-6 shadow-card sm:p-8">
        <PermitChart years={yearBars(p.byYear, p.peakYear, year)} months={end ? monthSeries(p.byMonth, end) : null} endLabel={cutOff} />
      </div>
      <div className="grid gap-4">
        {p.peakYear !== null && <Stat tone="peach" label="Peak year" value={String(p.peakYear)} note={plural(permitsIn(p.peakYear))} />}
        {p.trend && <Stat tone="sand" label="Trend" value={TREND[p.trend]} note={`${year - 1} had ${plural(permitsIn(year - 1))}, ${year - 2} had ${plural(permitsIn(year - 2))}.`} />}
        {p.latestMonth && <Stat tone="ink" label="Latest month with permits" value={shortMonth(p.latestMonth.year, p.latestMonth.month)} note={plural(p.latestMonth.permits)} />}
      </div>
    </div>
  );
}

const KIND = (k: string) => (k === "legal" ? "Legal name" : "Also known as");
function Names({ names }: { names: { name: string; kind: string }[] }) {
  if (names.length === 0) return null;
  return (
    <section aria-labelledby="names-h" className="mt-14 sm:mt-16">
      <SectionTitle id="names-h">Legal names <Mark tone="tint">on this page</Mark></SectionTitle>
      <div className="mt-6 rounded-bento border border-line bg-sand p-4 shadow-card sm:p-6">
        <p className="px-2 pb-3 text-small text-muted">All names of one brand are linked here.</p>
        <table className="w-full text-left text-ui">
          <thead><tr className="bg-lilac text-small text-muted"><th scope="col" className="rounded-l-pill px-4 py-2.5 font-medium">Name</th><th scope="col" className="rounded-r-pill px-4 py-2.5 font-medium">Kind</th></tr></thead>
          <tbody>
            {names.map((n) => <tr key={`${n.kind}:${n.name}`} className="border-b border-line last:border-0"><td className="break-words px-4 py-4">{n.name}</td><td className="px-4 py-4 text-muted">{KIND(n.kind)}</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The breadcrumb of the page, also its markup. */
export const companyCrumbs = (c: { name: string }) => [{ label: "Home", href: "/" }, { label: c.name }];

export function CompanyView({ company: c, now, signedIn, savedIds, path, prevHref, nextHref }: CompanyProps): ReactNode {
  const n = c.jobs.count;
  const total = n ? (n.more ? `${n.n}+` : String(n.n)) : String(c.jobs.jobs.length);
  const permits = c.permits;
  return (
    <>
      <div className={`${wrap} pb-4 pt-5`}>
        <Breadcrumb items={companyCrumbs(c)} />
        <div className="mt-6"><PhotoBlock className="h-[140px] sm:h-[240px]" /></div>
        <div className={`mt-5 grid grid-cols-[minmax(0,1fr)] items-start gap-5 ${permits && permits.byYear.length ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : ""}`}>
          <Identity c={c} path={path} signedIn={signedIn} />
          {permits && permits.byYear.length > 0 && (
            <section aria-label="Permits since 2019" className="flex min-h-[300px] flex-col justify-between rounded-bento bg-ink p-6 text-white shadow-card sm:p-8">
              <div className="flex items-start justify-between gap-3">
                <span className="inline-flex min-h-[30px] items-center rounded-pill bg-[#1d6b4b] px-3 text-[13px] text-white">DETE, since 2019</span>
                <span aria-hidden="true" className="grid size-10 place-items-center rounded-pill bg-deep-green"><Icon name="up-right" size={18} /></span>
              </div>
              <div>
                <p data-permit-total className="font-heading text-[4.5rem] font-semibold leading-none text-lilac">{sum(permits.byYear)}</p>
                <p className="mt-3 text-lead">employment permits since 2019</p>
                <p className="mt-1 text-[13px] text-white/85">DETE data, all legal entities.</p>
              </div>
            </section>
          )}
        </div>

        <section aria-labelledby="history-h" className="mt-14 sm:mt-16">
          <SectionTitle id="history-h" className="mb-6">Permit <Mark tone="peach">history</Mark></SectionTitle>
          <History c={c} now={now} />
        </section>

        <Names names={c.names} />

        <section aria-labelledby="jobs-h" className="mt-14 sm:mt-16">
          <SectionTitle id="jobs-h">{total} live {total === "1" ? "job" : "jobs"} <Mark tone="peach">at this company</Mark></SectionTitle>
          <div className="mt-6 flex flex-col gap-3.5">
            {c.jobs.jobs.length === 0 && <p className="rounded-bento border border-dashed border-line bg-sand p-6 text-muted">This company has no live jobs right now. A job appears here when it passes our checks.</p>}
            {c.jobs.jobs.map((j) => <ResultCard key={j.id} job={j} now={now} signedIn={signedIn} saved={savedIds.includes(j.id)} path={path} />)}
            {c.jobs.signInForMore && <SignInMore shown={c.jobs.jobs.length} count={c.jobs.count} path={path} />}
          </div>
          {(prevHref || nextHref) && <div className="mt-6"><Pager prevHref={prevHref} nextHref={nextHref} /></div>}
        </section>
      </div>
      {!signedIn && <Join />}
    </>
  );
}
