// The search bar and the filter panel (frames C04, C05, NM2, M03). One plain GET form (id jobs-search) holds every control through the `form` attribute, so it works
// without script and the address holds the search. On a phone the panel is the bottom sheet of frame M03, opened by a checkbox and a label (CSS only); from 768 px it is the side panel.
import type { ReactNode } from "react";
import { A, Button, CriticalSkillsBadge, Icon, SponsorBadge, cx } from "@portal/ui";
import { COUNTIES, SECTORS, SORTS, activeFilters, capFirst, euro, queryOf, searchHref, type FilterKey, type SearchState } from "./format";

export const FORM_ID = "jobs-search";
export const POSTED = [["", "Any time"], ["1", "Last 24 hours"], ["3", "Last 3 days"], ["7", "Last 7 days"], ["30", "Last 30 days"]] as const;

const INPUT = "h-[54px] w-full rounded-pill pl-12 text-body bg-ink-hover text-white placeholder:text-white/60 max-md:border max-md:border-line max-md:bg-white max-md:text-ink max-md:placeholder:text-faint";

type Counts = { sector: string; jobs: number }[] | undefined;
// The visitor's bar (frame N02): a white bar with a shadow from 1024 px, fields apart by a thin line; below that the phone rows.
const INPUT_V = "h-[54px] lg:h-[52px] w-full rounded-pill border border-line bg-white pl-12 text-body text-ink placeholder:text-faint lg:rounded-none lg:border-0 lg:bg-transparent lg:pl-11";
const ICON_V = "pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-muted lg:left-4";

/** The search bar. Signed in (frame C04): dark, keyword and county. Visitor (frame N02, NM2): white, keyword, county and sector, and a green Find jobs. The other filters are sent by the same form. */
export function SearchBar({ state, visitor, sectorCounts }: { state: SearchState; visitor?: boolean; sectorCounts?: Counts }) {
  const f = state.filters;
  const hidden = (
    <>
      {f.occupationCode && <input type="hidden" name="occupationCode" value={f.occupationCode} />}
      {state.sort && <input type="hidden" name="sort" value={state.sort} />}
    </>
  );
  if (visitor) {
    const n = (s: string) => (sectorCounts ? ` (${sectorCounts.find((c) => c.sector === s)?.jobs ?? 0})` : "");
    return (
      <form id={FORM_ID} method="get" action="/jobs" role="search" aria-label="Search jobs" className="grid grid-cols-2 gap-2 lg:flex lg:items-center lg:gap-0 lg:rounded-pill lg:bg-white lg:p-2.5 lg:shadow-pop">
        {hidden}
        <div className="relative col-span-2 lg:flex-[1.1]">
          <label htmlFor="q" className="sr-only">Job title or keyword</label>
          <Icon name="search" size={20} className={ICON_V} />
          <input id="q" name="q" type="search" defaultValue={f.q ?? ""} maxLength={200} placeholder="Job title or keyword" className={`${INPUT_V} pr-5`} />
        </div>
        <div className="relative lg:flex-1 lg:border-l lg:border-line">
          <label htmlFor="county" className="sr-only">County</label>
          <Icon name="pin" size={20} className={ICON_V} />
          <select id="county" name="county" defaultValue={f.county ?? ""} className={`${INPUT_V} appearance-none pr-10`}>
            <option value="">Any county</option>
            {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Icon name="down" size={18} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
        </div>
        <div className="relative lg:flex-1 lg:border-l lg:border-line">
          <label htmlFor="sector" className="sr-only">Sector</label>
          <Icon name="layers" size={20} className={ICON_V} />
          <select id="sector" name="sector" defaultValue={f.sector ?? ""} className={`${INPUT_V} appearance-none pr-10`}>
            <option value="">Any sector</option>
            {SECTORS.map((s) => <option key={s} value={s}>{capFirst(s)}{n(s)}</option>)}
          </select>
          <Icon name="down" size={18} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
        </div>
        <Button type="submit" size="lg" className="col-span-2 lg:col-auto lg:px-8">Find jobs <Icon name="arrow" size={16} /></Button>
      </form>
    );
  }
  return (
    <form id={FORM_ID} method="get" action="/jobs" role="search" aria-label="Search jobs" className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-bento p-0 md:flex md:items-center md:rounded-pill md:bg-ink md:p-3.5">
      {hidden}
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

// ===== the visitor's filter pills (frame N02) =====
const PILL = "inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-pill px-5 text-small font-medium [&::-webkit-details-marker]:hidden";
const MENU = "absolute left-0 top-full z-20 mt-2 flex max-h-80 min-w-56 flex-col overflow-y-auto rounded-card bg-white p-2 shadow-pop";
const CHOICE = "flex min-h-10 items-center justify-between gap-4 rounded-control px-3 text-[15px] text-ink no-underline hover:bg-hover-light aria-[current]:font-semibold";

/** One pill that opens a list of links (a native details, no script): lilac when its filter is set, outlined when not. */
function PillMenu({ label, set, children, right }: { label: ReactNode; set: boolean; children: ReactNode; right?: boolean }) {
  return (
    <details className="relative">
      <summary className={cx(PILL, set ? "bg-lilac" : "border border-line bg-white hover:bg-hover-light")}>{label}<Icon name="down" size={16} /></summary>
      <div className={cx(MENU, right && "left-auto right-0")}>{children}</div>
    </details>
  );
}
const Choice = ({ href, on, children }: { href: string; on: boolean; children: ReactNode }) => (
  <A href={href} aria-current={on ? "true" : undefined} className={CHOICE}>{children}{on && <Icon name="check" size={16} />}</A>
);

/** The pills after "All filters": badge, sector, county and salary, then Sort by on the right. Every choice is a link to the same search with that one filter changed. */
export function FilterPills({ state, sectorCounts }: { state: SearchState; sectorCounts?: Counts }) {
  const f = state.filters;
  const to = (k: FilterKey, v?: string) => searchHref({ ...state, filters: { ...f, [k]: v } });
  const badge = { sponsor_confirmed: "Sponsor confirmed", critical_skills_eligible: "Critical Skills eligible" }[f.badge ?? ""];
  const sector = SECTORS.find((s) => s === f.sector);
  const county = COUNTIES.find((c) => c === f.county);
  const from = f.salaryMin && /^[0-9]{1,7}$/.test(f.salaryMin) ? Number(f.salaryMin) : null;
  const sort = SORTS.find(([v]) => v === (state.sort ?? "sponsor")) ?? SORTS[0];
  // The salary form sends the rest of the search along: only values the read accepts (a bad one is never echoed into the page).
  const fine = (k: string, v: string) => k === "q" || (k === "occupationCode" && /^[0-9]{4}$/.test(v)) || (k === "sector" && SECTORS.some((x) => x === v)) || (k === "county" && COUNTIES.some((x) => x === v))
    || (k === "badge" && ["sponsor_confirmed", "critical_skills_eligible"].includes(v)) || (k === "postedWithin" && POSTED.some(([x]) => x === v)) || (k === "salaryStated" && v === "true") || (k === "sort" && SORTS.some(([x]) => x === v));
  const keep = [...queryOf({ ...state, filters: { ...f, salaryMin: undefined } }).entries()].filter(([k, v]) => fine(k, v));
  return (
    <>
      <PillMenu set={!!badge} label={`Badge: ${badge ?? "any"}`}>
        <Choice href={to("badge")} on={!badge}>Any</Choice>
        <Choice href={to("badge", "sponsor_confirmed")} on={f.badge === "sponsor_confirmed"}>Sponsor confirmed</Choice>
        <Choice href={to("badge", "critical_skills_eligible")} on={f.badge === "critical_skills_eligible"}>Critical Skills eligible</Choice>
      </PillMenu>
      <PillMenu set={!!sector} label={`Sector: ${sector ? capFirst(sector) : "any"}`}>
        <Choice href={to("sector")} on={!sector}>Any sector</Choice>
        {SECTORS.map((s) => <Choice key={s} href={to("sector", s)} on={sector === s}>{capFirst(s)}{sectorCounts && <span className="text-muted">{sectorCounts.find((c) => c.sector === s)?.jobs ?? 0}</span>}</Choice>)}
      </PillMenu>
      <PillMenu set={!!county} label={`County: ${county ?? "any"}`}>
        <Choice href={to("county")} on={!county}>Any county</Choice>
        {COUNTIES.map((c) => <Choice key={c} href={to("county", c)} on={county === c}>{c}</Choice>)}
      </PillMenu>
      <PillMenu set={from !== null} label={`Salary: ${from !== null ? `from ${euro(from)}` : "any"}`}>
        <form method="get" action="/jobs" className="flex flex-col gap-2 p-1">
          {keep.map(([k, v], i) => <input key={i} type="hidden" name={k} value={v} />)}
          <label htmlFor="pill-salary" className="text-small font-semibold">From (euro a year)</label>
          <input id="pill-salary" name="salaryMin" type="number" inputMode="numeric" min={0} max={1_000_000} step={1000} defaultValue={f.salaryMin ?? ""} className="min-h-11 w-full rounded-pill border-[1.5px] border-line bg-white px-4 focus:border-ink" />
          <Button type="submit" variant="dark" size="md">Show jobs</Button>
          {from !== null && <A href={to("salaryMin")} className="text-center text-small font-semibold text-deep-green">Any salary</A>}
        </form>
      </PillMenu>
      <div className="ml-auto flex items-center gap-2 text-small">
        <span className="text-muted">Sort by</span>
        <details className="relative">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden">{sort[1]}<Icon name="down" size={16} /></summary>
          <div className={cx(MENU, "left-auto right-0")}>
            {SORTS.map(([v, l]) => <Choice key={v} href={searchHref({ ...state, sort: v === "sponsor" ? undefined : v })} on={sort[0] === v}>{l}</Choice>)}
          </div>
        </details>
      </div>
    </>
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

/** `sheet` (the visitor): the panel is a sheet on every width, a centred card from 1024 px, and the sector is in the bar. Otherwise a side panel from 768 px. */
export function FilterPanel({ state, sectorCounts, sheet }: { state: SearchState; sectorCounts?: Counts; sheet?: boolean }) {
  const f = state.filters;
  const n = activeFilters(f);
  const count = (s: string) => (sectorCounts ? (sectorCounts.find((c) => c.sector === s)?.jobs ?? 0) : undefined);
  return (
    <div>
      <input type="checkbox" id="filters-open" aria-label="Show the filters" className="peer sr-only" />
      <label htmlFor="filters-open" className={cx("inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill bg-ink px-5 text-small font-semibold text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink", !sheet && "md:hidden")}>
        <Icon name="filter" size={16} />
        All filters{n > 0 && ` (${n})`}
      </label>
      <div className={cx("hidden peer-checked:block", !sheet && "md:block")}>
        <label htmlFor="filters-open" aria-hidden="true" className={cx("fixed inset-0 z-30 bg-ink/50", !sheet && "md:hidden")} />
        <div role="group" aria-label="Filters" className={cx("fixed inset-x-0 bottom-0 z-40 flex max-h-[88dvh] flex-col gap-5 overflow-y-auto rounded-t-bento bg-sand p-5 shadow-modal", sheet ? "lg:inset-x-auto lg:bottom-auto lg:left-1/2 lg:top-1/2 lg:w-[34rem] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-bento lg:p-6" : "md:static md:z-auto md:max-h-none md:rounded-bento md:p-6 md:shadow-none")}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[20px]">Filters</h2>
            <span className="flex items-center gap-1">
              <A href="/jobs" className="inline-flex min-h-11 items-center px-2 text-small font-semibold text-deep-green">Clear all</A>
              <label htmlFor="filters-open" className={cx("grid size-11 cursor-pointer place-items-center rounded-pill bg-white", !sheet && "md:hidden")}><Icon name="close" size={18} /><span className="sr-only">Close the filters</span></label>
            </span>
          </div>
          <Group title="Badge">
            <Opt type="radio" name="badge" value="" checked={!f.badge}>Any</Opt>
            <Opt type="radio" name="badge" value="sponsor_confirmed" checked={f.badge === "sponsor_confirmed"}><SponsorBadge /></Opt>
            <Opt type="radio" name="badge" value="critical_skills_eligible" checked={f.badge === "critical_skills_eligible"}><CriticalSkillsBadge /></Opt>
          </Group>
          {!sheet && (
            <Group title="Sector">
              <Opt type="radio" name="sector" value="" checked={!f.sector}>Any sector</Opt>
              {SECTORS.map((s) => <Opt key={s} type="radio" name="sector" value={s} checked={f.sector === s} count={count(s)}>{capFirst(s)}</Opt>)}
            </Group>
          )}
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
