// The companies directory (frame C13), a pure view. Without the sector column and chips (decision #287); keyset paging by "More companies".
import type { ReactNode } from "react";
import { A, EmptyState, Icon, Input, Pill } from "@portal/ui";
import { PageHead, wrap } from "../_content/head";
import { companyPath } from "../../lib/paths";

export type CompanyRow = { slug: string; name: string; initials: string; county: string | null; labels: string[]; permitsSince2019: number | null; liveJobs: number };
export type DirectoryProps = { companies: CompanyRow[]; next: string | null; q: string };

const tone = (l: string) => (l === "Public sector pay scale employer" ? "lilac" : l === "First-time sponsor" || l === "Sponsorship claims removed" ? "peach" : l === "Claimed" ? "green" : "outline");
/** The address of the next page; the search words and the cursor are encoded. */
export const moreHref = (q: string, next: string) => `/companies?${q ? `q=${encodeURIComponent(q)}&` : ""}after=${encodeURIComponent(next)}`;

const ROW = "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-4 py-4 lg:grid-cols-[minmax(0,2.4fr)_1fr_minmax(0,2fr)_8rem_5rem_5rem] lg:px-5";

function Row({ c }: { c: CompanyRow }) {
  const notLinked = c.permitsSince2019 === null;
  return (
    <li data-company className={`${ROW} border-t border-line`}>
      <div className="col-span-2 flex min-w-0 items-center gap-3 lg:col-span-1">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-card bg-green-tint font-heading text-small font-semibold">{c.initials}</span>
        <A href={companyPath(c.slug)} className="break-words font-semibold no-underline hover:underline">{c.name}</A>
      </div>
      <span className="text-small text-muted lg:hidden">County</span>
      <span>{c.county ?? ""}</span>
      <div className="col-span-2 flex flex-wrap gap-2 lg:col-span-1">
        {notLinked && <Pill tone="outline" className="min-h-0 px-3 py-[5px] text-[13px]">Permit history not linked yet</Pill>}
        {c.labels.map((l) => <Pill key={l} tone={tone(l)} className="min-h-0 px-3 py-[5px] text-[13px]">{l}</Pill>)}
      </div>
      <span className="text-small text-muted lg:hidden">Permits since 2019</span>
      <span className="lg:text-right">{notLinked ? "-" : c.permitsSince2019}</span>
      <span className="text-small text-muted lg:hidden">Live jobs</span>
      <span className="lg:text-right">{c.liveJobs}</span>
      <A href={companyPath(c.slug)} className="col-span-2 inline-flex items-center gap-1 font-semibold text-deep-green no-underline hover:underline lg:col-span-1 lg:justify-end" aria-label={`View ${c.name}`}>View<Icon name="arrow" size={14} /></A>
    </li>
  );
}

export function DirectoryView({ companies, next, q }: DirectoryProps): ReactNode {
  return (
    <div className={`${wrap} pb-12`}>
      <PageHead crumbs={[{ label: "Home", href: "/" }, { label: "Companies" }]} title="Companies that sponsor permits" lead="Permit history from DETE records since 2019." />
      <form method="get" action="/companies" role="search" aria-label="Search companies" className="mt-6 flex max-w-xl items-end gap-3">
        <div className="min-w-0 flex-1"><Input name="q" type="search" label="Search a company or legal name" defaultValue={q} maxLength={100} icon="search" /></div>
        <button type="submit" className="min-h-[48px] rounded-pill bg-ink px-6 font-semibold text-white">Search</button>
      </form>
      <div className="mt-8">
        {companies.length === 0 ? (
          q ? (
            <EmptyState title="No companies found" action={<A href="/companies" className="font-semibold underline underline-offset-2">Clear the search</A>}>No company or legal name matches that search.</EmptyState>
          ) : (
            <EmptyState icon="file" title="No companies yet">Companies appear here once they have jobs or permit history.</EmptyState>
          )
        ) : (
          <div className="overflow-hidden rounded-bento border border-line bg-sand shadow-card">
            <div aria-hidden="true" className={`${ROW} hidden bg-lilac text-small font-semibold lg:grid`}>
              <span>Company</span><span>County</span><span>Label</span><span className="text-right">Permits since 2019</span><span className="text-right">Live jobs</span><span />
            </div>
            <ul>{companies.map((c) => <Row key={c.slug} c={c} />)}</ul>
          </div>
        )}
        {next !== null && <p className="mt-6"><A href={moreHref(q, next)} className="inline-flex min-h-[48px] items-center rounded-pill border border-line bg-white px-6 font-semibold no-underline hover:bg-hover-light">More companies</A></p>}
      </div>
    </div>
  );
}
