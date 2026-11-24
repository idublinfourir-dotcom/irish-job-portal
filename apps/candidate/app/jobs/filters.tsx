// The search bar and the filter panel (frames C04, C05, NM2, M03). One plain GET form (id jobs-search) holds every control through the `form` attribute, so it works
// without script and the address holds the search. On a phone the panel is the bottom sheet of frame M03, opened by a checkbox and a label (CSS only); from 768 px it is the side panel.
import type { ReactNode } from "react";
import { A, Button, CriticalSkillsBadge, Icon, SponsorBadge } from "@portal/ui";
import { COUNTIES, SECTORS, activeFilters, capFirst, type SearchState } from "./format";

export const FORM_ID = "jobs-search";
export const POSTED = [["", "Any time"], ["1", "Last 24 hours"], ["3", "Last 3 days"], ["7", "Last 7 days"], ["30", "Last 30 days"]] as const;

const INPUT = "h-[54px] w-full rounded-pill pl-12 text-body bg-ink-hover text-white placeholder:text-white/60 max-md:border max-md:border-line max-md:bg-white max-md:text-ink max-md:placeholder:text-faint";

/** The dark search bar (frame C04): keyword, county and Find jobs. The sector and the other filters are in the panel; they are sent by the same form. */
export function SearchBar({ state }: { state: SearchState }) {
  const f = state.filters;
  return (
    <form id={FORM_ID} method="get" action="/jobs" role="search" aria-label="Search jobs" className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-bento p-0 md:flex md:items-center md:rounded-pill md:bg-ink md:p-3.5">
      {f.occupationCode && <input type="hidden" name="occupationCode" value={f.occupationCode} />}
      {state.sort && <input type="hidden" name="sort" value={state.sort} />}
      <div className="relative col-span-2 md:flex-[1.2]">
        <label htmlFor="q" className="sr-only">Keyword</label>
        <Icon name="search" size={20} className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-white/75 max-md:text-muted" />
        <input id="q" name="q" type="search" defaultValue={f.q ?? ""} maxLength={200} placeholder="Job title or keyword" className={`${INPUT} pr-5`} />
      </div>
      <div className="relative md:flex-1">
        <label htmlFor="county" className="sr-only">County</label>
        <Icon name="pin" size={20} className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-white/75 max-md:text-muted" />
        <select id="county" name="county" defaultValue={f.county ?? ""} className={`${INPUT} appearance-none pr-12`}>
          <option value="">Any county</option>
          {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Icon name="down" size={18} className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-white/75 max-md:text-muted" />
      </div>
      <Button type="submit" variant="sun" size="lg" className="md:px-8">Find jobs</Button>
    </form>
  );
}

/** A radio or checkbox row with the kit's green tick; `count` is printed at the end (the sector counts). */
function Opt({ type, name, value, checked, children, count }: { type: "radio" | "checkbox"; name: string; value: string; checked: boolean; children: ReactNode; count?: number }) {
  return (
    <label className="group flex min-h-10 cursor-pointer items-center gap-3 text-[15px]">
      <input form={FORM_ID} type={type} name={name} value={value} defaultChecked={checked} className="peer sr-only" />
      <span className="grid size-6 shrink-0 place-items-center rounded-pill border-[1.5px] border-line-strong bg-white text-white peer-checked:border-deep-green peer-checked:bg-deep-green peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink">
        <Icon name="check" size={14} className="hidden group-has-[:checked]:block" />
      </span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {count !== undefined && <span className="text-small text-muted">{count}</span>}
    </label>
  );
}
const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <fieldset className="flex flex-col gap-0.5">
    <legend className="mb-1 text-small font-semibold">{title}</legend>
    {children}
  </fieldset>
);

export function FilterPanel({ state, sectorCounts }: { state: SearchState; sectorCounts?: { sector: string; jobs: number }[] }) {
  const f = state.filters;
  const n = activeFilters(f);
  const count = (s: string) => (sectorCounts ? (sectorCounts.find((c) => c.sector === s)?.jobs ?? 0) : undefined);
  return (
    <div>
      <input type="checkbox" id="filters-open" aria-label="Show the filters" className="peer sr-only" />
      <label htmlFor="filters-open" className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill bg-ink px-5 text-small font-semibold text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink md:hidden">
        <Icon name="filter" size={16} />
        All filters{n > 0 && ` (${n})`}
      </label>
      <div className="hidden peer-checked:block md:block">
        <label htmlFor="filters-open" aria-hidden="true" className="fixed inset-0 z-30 bg-ink/50 md:hidden" />
        <div role="group" aria-label="Filters" className="fixed inset-x-0 bottom-0 z-40 flex max-h-[88dvh] flex-col gap-5 overflow-y-auto rounded-t-bento bg-sand p-5 shadow-modal md:static md:z-auto md:max-h-none md:rounded-bento md:p-6 md:shadow-none">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[20px]">Filters</h2>
            <span className="flex items-center gap-1">
              <A href="/jobs" className="inline-flex min-h-11 items-center px-2 text-small font-semibold text-deep-green">Clear all</A>
              <label htmlFor="filters-open" className="grid size-11 cursor-pointer place-items-center rounded-pill bg-white md:hidden"><Icon name="close" size={18} /><span className="sr-only">Close the filters</span></label>
            </span>
          </div>
          <Group title="Badge">
            <Opt type="radio" name="badge" value="" checked={!f.badge}>Any</Opt>
            <Opt type="radio" name="badge" value="sponsor_confirmed" checked={f.badge === "sponsor_confirmed"}><SponsorBadge /></Opt>
            <Opt type="radio" name="badge" value="critical_skills_eligible" checked={f.badge === "critical_skills_eligible"}><CriticalSkillsBadge /></Opt>
          </Group>
          <Group title="Sector">
            <Opt type="radio" name="sector" value="" checked={!f.sector}>Any sector</Opt>
            {SECTORS.map((s) => <Opt key={s} type="radio" name="sector" value={s} checked={f.sector === s} count={count(s)}>{capFirst(s)}</Opt>)}
          </Group>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="salaryMin" className="text-small font-semibold">Salary from (euro a year)</label>
            <input form={FORM_ID} id="salaryMin" name="salaryMin" type="number" inputMode="numeric" min={0} max={1_000_000} step={1000} defaultValue={f.salaryMin ?? ""} placeholder="For example 30000" className="min-h-12 w-full rounded-pill border-[1.5px] border-line bg-white px-5 placeholder:text-faint focus:border-ink" />
            <Opt type="checkbox" name="salaryStated" value="true" checked={f.salaryStated === "true"}>Salary stated only</Opt>
          </div>
          <Group title="Date posted">
            {POSTED.map(([v, l]) => <Opt key={v} type="radio" name="postedWithin" value={v} checked={(f.postedWithin ?? "") === v}>{l}</Opt>)}
          </Group>
          <Button form={FORM_ID} type="submit" variant="dark" size="lg" className="w-full">Show jobs</Button>
        </div>
      </div>
    </div>
  );
}
