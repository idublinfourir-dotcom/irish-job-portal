// The government updates feed (frame C17), a pure view. Chips are the update categories (B17); Previous and Next only (#125). Not built (decision #287): "Email me updates" (Q46, L22).
// Dates are the Irish day of publication; "Effective from" is the update's own day when staff set one.
import type { ReactNode } from "react";
import { A, Breadcrumb, EmptyState, Icon, Pager, Pill } from "@portal/ui";
import { Body } from "../_content/body";
import { dayText, dublinDay } from "../_content/dates";
import { wrap } from "../_content/head";
import { sourceOf } from "../guides/guide-view";
import { Join } from "../jobs/parts";
import { staticPath } from "../../lib/paths";

export const CATEGORIES = [["salary_minimums", "Salary minimums"], ["quotas", "Quotas"], ["occupation_lists", "Occupation lists"], ["processing", "Processing"]] as const;
export const categoryLabel = (c: string | null) => CATEGORIES.find(([k]) => k === c)?.[1] ?? null;
/** The category in the address if it is one we know; anything else is ignored (the read would answer 400, and the page never echoes it). */
export const knownCategory = (raw: string | string[] | undefined): string | undefined => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return CATEGORIES.some(([k]) => k === v) ? v : undefined;
};

export type UpdateData = { id: string; slug: string; title: string; body: string; sourceUrl: string | null; publishedAt: Date | string; category: string | null; effectiveFrom: string | null };
export type UpdatesProps = { updates: UpdateData[]; category?: string; prevHref?: string; nextHref?: string; signedIn: boolean };

const base = () => staticPath("updates")!;
export const chipHref = (category?: string) => (category ? `${base()}?category=${category}` : base());
const CHIP = "inline-flex min-h-[38px] items-center rounded-pill px-4 text-small font-semibold no-underline";

function Item({ u }: { u: UpdateData }) {
  const cat = categoryLabel(u.category);
  const src = sourceOf(u.sourceUrl);
  const day = dublinDay(u.publishedAt);
  return (
    <article id={u.slug} data-update className="grid scroll-mt-6 gap-3 rounded-bento bg-sand p-6 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-6 sm:p-7">
      <div className="flex flex-col items-start gap-2">
        <p className="font-semibold">{day}</p>
        {cat && <Pill tone="green" className="min-h-0 px-3 py-[3px] text-[13px] text-pressed-dark">{cat}</Pill>}
      </div>
      <div className="min-w-0">
        <h2 className="break-words text-[1.35rem] leading-snug">{u.title}</h2>
        <Body text={u.body} className="mt-2 text-muted" />
        <p className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-small">
          <span className="inline-flex items-center gap-1.5"><Icon name="calendar" size={14} />{u.effectiveFrom ? `Effective from ${dayText(u.effectiveFrom)}` : `Published ${day}`}</span>
          {src && <A href={src.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-deep-green underline-offset-2 hover:underline"><Icon name="external" size={14} />DETE notice</A>}
        </p>
      </div>
    </article>
  );
}

export function UpdatesView({ updates, category, prevHref, nextHref, signedIn }: UpdatesProps): ReactNode {
  return (
    <>
      <div className={`${wrap} pb-10 pt-6 sm:pt-8`}>
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Guides", href: "/guides" }, { label: "Government updates" }]} />
        <h1 className="mt-4">Government <span className="text-deep-green">updates</span></h1>
        <p className="mt-3 max-w-[40rem] text-lead text-muted">Quota notices, threshold changes and list changes, entered by our team from the DETE latest notices page.</p>
        <nav aria-label="Update types" className="mt-6 flex flex-wrap gap-2.5">
          <A href={chipHref()} aria-current={category ? undefined : "true"} className={`${CHIP} ${category ? "bg-hover-light text-deep-green hover:bg-lilac-soft" : "bg-deep-green text-white"}`}>All</A>
          {CATEGORIES.map(([k, label]) => <A key={k} href={chipHref(k)} aria-current={category === k ? "true" : undefined} className={`${CHIP} ${category === k ? "bg-deep-green text-white" : "bg-hover-light text-deep-green hover:bg-lilac-soft"}`}>{label}</A>)}
        </nav>
        <div className="mt-8 flex max-w-[57.5rem] flex-col gap-4">
          {updates.length === 0 ? <EmptyState icon="file" title="No updates here yet">{category ? "There are no updates of this type yet." : "Updates will appear here when they are published."}</EmptyState> : updates.map((u) => <Item key={u.id} u={u} />)}
        </div>
        {(prevHref || nextHref) && <div className="mt-8 max-w-[57.5rem]"><Pager prevHref={prevHref} nextHref={nextHref} /></div>}
      </div>
      {!signedIn && <Join />}
    </>
  );
}
