// The occupation page body (frame C14): a pure view of what the page read. [slug]/page.tsx reads; this file only shows.
// Not built, by decision #287: related occupations and the sector in the breadcrumb (Q53, B13 dropped); the "Occupations" index has no page. Every figure is the read's: the minimums, the
// checked date, the quota, the registration steps. No typed number.
import type { ReactNode } from "react";
import { A, Breadcrumb, Button, Icon, Pill } from "@portal/ui";
import { Body } from "../_content/body";
import { SectionTitle, wrap } from "../_content/head";
import { SignInMore } from "../_content/limit";
import { occupationJobsPath } from "../../lib/paths";
import { shortDate } from "../_home/format";
import type { CardJob } from "../jobs/card";
import { contractText, euro, jobCount, type Count } from "../jobs/format";
import { Join } from "../jobs/parts";
import { OccupationTile } from "./tile";

export type OccupationData = {
  code: string;
  entries: { list: string; title: string }[];
  listStatus: "critical-skills" | "ineligible";
  minimums: { withDegree: number; recentGraduate: number; graduateMonths: number; withoutDegreeOrNotListed: number | null; minContractMonths: number; basedOnWeekHours: number } | null;
  jobs: { jobs: CardJob[]; count: Count | null; signInForMore: boolean };
  quota: "none" | "full";
  text: { title: string; body: string; sourceUrl: string | null; checkedOn: string | null } | null;
  rulesCheckedOn: string;
  registration: { status: "required" | "may_need" | "not_open"; body: { id: string; name: string; url: string; readOn: string }; line: string; steps: readonly string[]; degreeNote?: string } | null;
};
/** `name`: the SOC unit group title of the code (the occupation page is named after it); the list entry title stands in when the code has none. */
export type OccupationProps = { occupation: OccupationData; name?: string | null; now: Date; path: string; signedIn: boolean; savedIds?: string[] };

/** The occupation's name: its SOC unit group title, else the title of its Critical Skills list entry, else its first entry. */
export const titleOf = (o: Pick<OccupationData, "entries">, name?: string | null) => name || (o.entries.find((e) => e.list === "critical-skills") ?? o.entries[0])?.title || "";
/** The breadcrumb of the page, also its markup. */
export const occupationCrumbs = (title: string) => [{ label: "Home", href: "/" }, { label: title }];
/** The title of the page: "<name> visa sponsorship jobs in Ireland" (frame C14). */
export const headingOf = (title: string) => `${title} visa sponsorship jobs in Ireland`;

function Hero({ o, title, signedIn }: { o: OccupationData; title: string; signedIn: boolean }) {
  const listed = o.listStatus === "critical-skills";
  const n = jobCount(o.jobs.count ?? { n: o.jobs.jobs.length, more: false });
  const [a, b] = [`${title} `, " jobs in Ireland"];
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section aria-labelledby="occ-h" className="flex min-h-[300px] flex-col justify-between gap-10 rounded-bento bg-ink p-6 text-white sm:p-10 lg:min-h-[416px]">
        <div className="flex flex-col gap-6">
          <div className="text-white/85 [&_a]:text-white/85 [&_li]:text-white/85 [&_span]:text-white"><Breadcrumb items={occupationCrumbs(title)} /></div>
          <h1 id="occ-h" className="break-words text-[2rem] leading-[1.25] text-white sm:text-[2.9rem]">{a}<span className="text-deep-green">visa sponsorship</span>{b}</h1>
        </div>
        <div className="flex flex-col gap-6">
          <p className="max-w-[34rem] text-body text-white/85">
            {listed ? `This occupation is on the Critical Skills Occupations List. These are the rules, and the jobs that pass them today.` : "This occupation is on the Ineligible Occupations List, so we show no salary minimum for it. Below are the live jobs we list for it."}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button href={occupationJobsPath(o.code)} variant="sun" size="lg">See {n} {n === "1" ? "job" : "jobs"} <Icon name="arrow" size={16} /></Button>
            <Button href={`${occupationJobsPath(o.code)}#alert`} size="lg" className="bg-transparent text-white hover:bg-ink-hover"><Icon name="bell" size={18} />{signedIn ? "Set a job alert" : "Sign in to set a job alert"}</Button>
          </div>
        </div>
      </section>
      <div className="grid gap-4 lg:grid-rows-2 lg:gap-5">
        <section aria-label="List status" className="flex flex-col gap-3 rounded-bento bg-peach p-6 sm:p-7">
          <p className="text-small">List status</p>
          <p className="font-heading text-[1.5rem] font-semibold leading-tight">{listed ? "On the Critical Skills list" : "On the Ineligible list"}</p>
          <p className="text-small">SOC {o.code} · checked {shortDate(o.rulesCheckedOn)}</p>
        </section>
        <section aria-label="Quota" className="flex flex-col gap-3 rounded-bento border border-line bg-sand p-6 sm:p-7">
          <p className="text-small text-muted">Quota</p>
          <p className="font-heading text-[1.5rem] font-semibold leading-tight">{o.quota === "full" ? "The quota is full" : "No quota applies"}</p>
          <p className="text-small text-muted">{o.quota === "full" ? "The General permit quota for this occupation is full for now. Its jobs are marked." : "Jobs are marked when a quota is full."}</p>
        </section>
      </div>
    </div>
  );
}

function Minimum({ label, note, value, sub, tone = "sand" }: { label: string; note?: string; value: ReactNode; sub: string; tone?: "sand" | "tint" }) {
  return (
    <div data-minimum className={`flex min-h-[213px] flex-col justify-between gap-4 rounded-bento p-6 ${tone === "tint" ? "bg-green-tint" : "bg-sand"}`}>
      <p className="text-ui">{label}{note && <span className="block text-small text-muted">{note}</span>}</p>
      <div>
        <p className="break-words font-heading text-[2.25rem] font-semibold leading-[1.05] sm:text-[2.6rem]">{value}</p>
        <p className="mt-1 text-small">{sub}</p>
      </div>
    </div>
  );
}

function Minimums({ o }: { o: OccupationData }) {
  const m = o.minimums;
  if (!m) return null;
  const note = o.registration?.degreeNote;
  return (
    <section aria-labelledby="min-h" className="mt-12 sm:mt-14">
      <h2 id="min-h" className="text-[1.75rem] sm:text-[2rem]">Salary minimums for this occupation</h2>
      <p className="mt-2 text-muted">From the rules table, checked {shortDate(o.rulesCheckedOn)}.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Minimum label="Relevant degree" note={note} value={euro(m.withDegree)} sub="a year, Critical Skills permit" />
        <Minimum label={`Degree in the last ${m.graduateMonths} months`} value={euro(m.recentGraduate)} sub="a year, Critical Skills permit" />
        {m.withoutDegreeOrNotListed !== null
          ? <Minimum label="No relevant degree" value={euro(m.withoutDegreeOrNotListed)} sub="a year, Critical Skills permit" />
          : <Minimum label="No relevant degree" value="Not open" sub="This permit route is not open without a relevant degree." />}
        <Minimum tone="tint" label="Public sector pay scale employer" value="No minimum" sub="The pay scale applies instead" />
      </div>
    </section>
  );
}

function Notes({ o }: { o: OccupationData }) {
  const m = o.minimums;
  if (!m) return null;
  const note = o.registration?.degreeNote;
  const rows: [ReactNode, string][] = [
    [<Icon key="c" name="calendar" size={18} />, `Critical Skills permit needs a job offer of at least ${contractText(m.minContractMonths)}.`],
    [<Icon key="d" name="degree" size={18} />, `Needs a relevant degree${m.withoutDegreeOrNotListed !== null ? `, or a salary of ${euro(m.withoutDegreeOrNotListed)} or more` : ""}.${note ? ` ${note}` : ""}`],
    [<Icon key="e" name="euro" size={18} />, `At an employer on the public sector pay scale list, the pay scale applies instead of the ${euro(m.withDegree)} minimum.`],
  ];
  return (
    <section aria-labelledby="notes-h" className="flex flex-col gap-4 rounded-bento bg-sand p-6 sm:p-7">
      <h2 id="notes-h" className="text-[1.5rem]">Permit notes</h2>
      <ul className="flex flex-col gap-3">
        {rows.map(([icon, text], i) => (
          <li key={i} className={`flex items-start gap-3 text-ui ${i === 0 ? "rounded-pill bg-white px-4 py-3" : "px-4 py-1"}`}><span className="mt-0.5 shrink-0 text-deep-green">{icon}</span>{text}</li>
        ))}
      </ul>
    </section>
  );
}

function Registration({ o }: { o: OccupationData }) {
  const r = o.registration;
  if (!r) return null;
  return (
    <section aria-labelledby="reg-h" className="flex flex-col gap-4 rounded-bento bg-sand p-6 sm:p-7">
      <div className="flex items-center justify-between gap-3"><h2 id="reg-h" className="text-[1.5rem]">Registration body</h2><Pill tone="green" className="min-h-0 px-3 py-1 text-[13px] text-pressed-dark">{r.body.id.toUpperCase()}</Pill></div>
      <p className="text-muted">{r.line}</p>
      {r.steps.length > 0 && (
        <ol aria-label={`How to register with ${r.body.name}`} className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {r.steps.map((s, i) => (
            <li key={s} className="flex flex-col items-start gap-3 font-semibold"><span aria-hidden="true" className="grid size-8 place-items-center rounded-pill bg-deep-green text-small text-white">{i + 1}</span>{s}</li>
          ))}
        </ol>
      )}
      <p><A href={r.body.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-semibold text-deep-green underline-offset-2 hover:underline">Read the {r.body.name} guide <Icon name="arrow" size={16} /></A></p>
    </section>
  );
}

function Team({ o }: { o: OccupationData }) {
  const t = o.text;
  if (!t) return null;
  return (
    <section aria-labelledby="team-h" className="mt-5 rounded-bento bg-sand p-6 sm:p-7">
      <h2 id="team-h" className="text-[1.5rem]">{t.title}</h2>
      <Body text={t.body} className="mt-3 text-muted" />
      {(t.checkedOn || t.sourceUrl) && (
        <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-muted">
          {t.checkedOn && <span>Checked on {shortDate(t.checkedOn)}</span>}
          {t.sourceUrl && <A href={t.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-deep-green underline-offset-2 hover:underline">DETE source</A>}
        </p>
      )}
    </section>
  );
}

export function OccupationView({ occupation: o, name, now, path, signedIn, savedIds = [] }: OccupationProps): ReactNode {
  const title = titleOf(o, name);
  const shown = o.jobs.jobs.slice(0, 6);
  return (
    <>
      <div className={`${wrap} pb-4 pt-6 sm:pt-8`}>
        <Hero o={o} title={title} signedIn={signedIn} />
        <Minimums o={o} />
        {(o.registration || o.minimums) && (
          <div className={`mt-5 grid items-start gap-5 ${o.registration && o.minimums ? "lg:grid-cols-2" : ""}`}>
            <Registration o={o} />
            <Notes o={o} />
          </div>
        )}
        <Team o={o} />
        <section aria-labelledby="jobs-h" className="mt-14 sm:mt-16">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SectionTitle id="jobs-h" className="text-[1.75rem]! sm:text-[2rem]!">Live jobs in this occupation</SectionTitle>
            <A href={occupationJobsPath(o.code)} className="inline-flex min-h-11 items-center gap-2 font-semibold text-deep-green underline-offset-2 hover:underline">All jobs in this occupation <Icon name="arrow" size={16} /></A>
          </div>
          {shown.length === 0 && <p className="mt-6 rounded-bento border border-dashed border-line bg-sand p-6 text-muted">There are no live jobs for this occupation right now. A job appears here when it passes our checks.</p>}
          {shown.length > 0 && <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{shown.map((j) => <OccupationTile key={j.id} job={j} now={now} signedIn={signedIn} saved={savedIds.includes(j.id)} path={path} />)}</div>}
          {o.jobs.signInForMore && <div className="mt-6"><SignInMore shown={shown.length} count={o.jobs.count} path={path} /></div>}
        </section>
      </div>
      {!signedIn && <Join />}
    </>
  );
}
