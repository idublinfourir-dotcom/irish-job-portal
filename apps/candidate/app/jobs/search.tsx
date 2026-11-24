// The search results page body (N02 visitor, C04 signed in, C05 empty, NM2 and M03 on a phone), as a pure view of what the page read.
// page.tsx reads; this file only shows. Every state of the read has its words here: 400, 401 (a visitor asked for a later page), 429, empty, and the visitor limit.
import { A, Breadcrumb, Button, Icon, Notice, Pager, Pill } from "@portal/ui";
import { staticPath } from "../../lib/paths";
import { shortDate } from "../_home/format";
import { AlertBuilder } from "./client";
import { ResultCard, TileCard, VisitorCard, type CardJob } from "./card";
import { FilterPanel, FilterPills, SearchBar, POSTED } from "./filters";
import { COUNTIES, SECTORS, SORTS, capFirst, contractText, euro, headingParts, loginHref, searchHref, type FilterKey, type Filters, type SearchState } from "./format";
import { Dot, Hl, Join, wrap } from "./parts";

export type ListRead =
  | { ok: true; jobs: CardJob[]; next: string | null; previous: string | null; count: { n: number; more: boolean } | null; signInForMore: boolean }
  | { ok: false; status: number; code: string; retryAfter?: number };
export type SearchProps = {
  state: SearchState; now: Date; list: ListRead; signedIn: boolean; savedIds: string[];
  sectorCounts?: { sector: string; jobs: number }[]; occupationTitle?: string | null; newest?: CardJob[];
  /** The permit minimums in force (B5), for the visitor's "Permit rules" card; null when the read failed. */
  minimums?: RuleMinimums | null;
};
export type RuleMinimums = { criticalSkills: number; minContractMonths: number; rulesCheckedOn: string };

const BADGE_WORDS: Record<string, string> = { sponsor_confirmed: "Sponsor confirmed", critical_skills_eligible: "Critical Skills eligible" };
const inList = (list: readonly string[], v: string | undefined) => (v !== undefined && list.includes(v) ? v : undefined);
const eur = (n: number) => `€${new Intl.NumberFormat("en-IE").format(n)}`;

/** What an alert can hold of this search (the route's own filters, validated the way the route does), the words for them, and what it cannot keep. */
export function alertFrom(f: Filters, occupationTitle?: string | null) {
  const filters: Record<string, string | number> = {};
  const summary: string[] = [];
  if (f.occupationCode && /^[0-9]{4}$/.test(f.occupationCode)) { filters.occupationCode = f.occupationCode; summary.push(occupationTitle || `Occupation ${f.occupationCode}`); }
  const sector = inList(SECTORS, f.sector);
  if (sector) { filters.sector = sector; summary.push(capFirst(sector)); }
  const county = inList(COUNTIES, f.county);
  if (county) { filters.county = county; summary.push(county); }
  if (f.salaryMin && /^[0-9]{1,7}$/.test(f.salaryMin) && Number(f.salaryMin) <= 1_000_000) { filters.salaryMin = Number(f.salaryMin); summary.push(`From ${eur(Number(f.salaryMin))} a year`); }
  const badge = inList(Object.keys(BADGE_WORDS), f.badge);
  if (badge) { filters.badge = badge; summary.push(BADGE_WORDS[badge]!); }
  const notKept = [f.q && "keyword", f.postedWithin && "date posted", f.salaryStated && "salary stated"].filter(Boolean) as string[];
  return { filters, summary, notKept };
}

/** The chips of the filters in use, each with the address that drops it. The words are ours for a known value and a clipped copy of the text for the keyword. */
export function chipsOf(state: SearchState, occupationTitle?: string | null): { key: FilterKey; label: string; href: string }[] {
  const f = state.filters;
  const without = (k: FilterKey) => searchHref({ ...state, filters: { ...f, [k]: undefined } });
  const words: Partial<Record<FilterKey, string>> = {};
  if (f.q) words.q = f.q.length > 30 ? `${f.q.slice(0, 29)}…` : f.q;
  if (f.occupationCode) words.occupationCode = occupationTitle || `Occupation ${f.occupationCode}`;
  const sector = inList(SECTORS, f.sector); if (sector) words.sector = capFirst(sector);
  const county = inList(COUNTIES, f.county); if (county) words.county = county;
  if (f.badge && BADGE_WORDS[f.badge]) words.badge = BADGE_WORDS[f.badge];
  if (f.salaryMin && /^[0-9]{1,7}$/.test(f.salaryMin)) words.salaryMin = `From ${eur(Number(f.salaryMin))}`;
  const posted = POSTED.find(([v]) => v && v === f.postedWithin); if (posted) words.postedWithin = posted[1];
  if (f.salaryStated === "true") words.salaryStated = "Salary stated";
  return (Object.keys(words) as FilterKey[]).map((key) => ({ key, label: words[key]!, href: without(key) }));
}

function Problem({ list, state }: { list: Extract<ListRead, { ok: false }>; state: SearchState }) {
  if (list.status === 401)
    return (
      <Notice kind="info" title="Log in to see more jobs">
        <p className="mb-3">Visitors see the first jobs of a search only. It is free for candidates.</p>
        <span className="flex flex-wrap gap-3"><Button href={loginHref(searchHref(state))}>Log in</Button><Button href="/signup" variant="outline">Create free account</Button></span>
      </Notice>
    );
  if (list.status === 429)
    return <Notice kind="warning" title="Too many searches">Please wait{list.retryAfter ? ` about ${list.retryAfter} seconds` : " a little"} and try again.</Notice>;
  if (list.status === 400)
    return <Notice kind="error" title="We could not use that search">One of the filters in the address is not valid. <A href="/jobs" className="underline underline-offset-2">Clear the filters</A> and start again.</Notice>;
  return <Notice kind="error" title="Jobs could not be loaded">Please try again in a moment.</Notice>;
}

const PLACEHOLDER = "flex h-28 items-center gap-4 rounded-bento bg-sand p-5";
/** The visitor limit (N02): blurred empty rows, then the dark box. The rows hold no real job, only shapes. */
function SignInBox({ shown, count, path }: { shown: number; count: { n: number; more: boolean } | null; path: string }) {
  const hidden = Math.min(2, Math.max(0, (count?.n ?? shown + 2) - shown)) || 2;
  return (
    <div data-sign-in-for-more className="flex flex-col">
      <ul aria-hidden="true" className="flex flex-col gap-3 opacity-60 blur-[5px]">
        {Array.from({ length: hidden }, (_, i) => (
          <li key={i} data-placeholder className={PLACEHOLDER}>
            <span className="size-12 shrink-0 rounded-pill bg-white" />
            <span className="flex flex-1 flex-col gap-2"><span className="h-5 w-1/2 rounded-pill bg-ink/15" /><span className="h-4 w-1/3 rounded-pill bg-ink/10" /></span>
            <span className="hidden h-6 w-24 rounded-pill bg-ink/15 sm:block" />
          </li>
        ))}
      </ul>
      <section aria-labelledby="more" className="relative z-[1] -mt-16 flex flex-col gap-4 rounded-bento bg-ink p-5 text-white shadow-pop sm:mx-5 sm:p-6 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="hidden size-12 shrink-0 place-items-center rounded-pill bg-deep-green sm:grid"><Icon name="lock" size={20} /></span>
          <div>
            <h2 id="more" className="text-[18px] leading-snug text-white">Want to see more jobs? Sign in or create a free account.</h2>
            <p className="text-small text-white/75">You can see {shown}{count ? ` of ${count.more ? `${count.n}+` : count.n}` : ""}. Free for candidates.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button href={loginHref(path)} variant="outline" size="lg" className="border-white text-white hover:bg-white/10 active:bg-white/20">Sign in</Button>
          <Button href="/signup" size="lg">Create free account</Button>
        </div>
      </section>
    </div>
  );
}


const ON_DARK = "border-white text-white hover:bg-white/10 active:bg-white/20";
const RAIL_NOTE = "flex items-start gap-3 rounded-card bg-lilac px-4 py-3.5 text-[15px]";

/** The visitor's alert card (frame N02): the filters an alert can hold, and a sign in. No script: a visitor creates nothing. */
function AlertRail({ summary, notKept, href }: { summary: string[]; notKept: string[]; href: string }) {
  return (
    <section data-alert-rail aria-labelledby="alert-h" className="flex flex-col gap-4 rounded-bento bg-ink p-6 text-white">
      <div className="flex items-center justify-between">
        <span aria-hidden="true" className="grid size-10 place-items-center rounded-pill bg-ink-hover"><Icon name="bell" size={18} /></span>
        <Pill tone="lilac">Daily</Pill>
      </div>
      <h2 id="alert-h" className="text-[24px] leading-snug text-white">Get new jobs like these by email</h2>
      <p className="flex flex-wrap items-center gap-2">
        {summary.length ? summary.map((x) => <span key={x} className="inline-flex items-center rounded-pill bg-lilac px-3 py-1 text-small font-medium text-ink">{x}</span>) : <span className="text-small text-white/75">Every job (no filters chosen)</span>}
      </p>
      {notKept.length > 0 && <p className="text-small text-white/75">An alert keeps sector, county, occupation, salary from and badge. Your {notKept.join(", ")} filter is not saved in it.</p>}
      <Button href={href} variant="outline" size="lg" className={ON_DARK}>Sign in to create an alert</Button>
    </section>
  );
}

/** The permit rules card (frame N02): the Critical Skills minimum and the offer length, both from the minimums read, and the way to the checker. */
function RulesRail({ m }: { m: RuleMinimums }) {
  return (
    <section data-rules-rail aria-labelledby="rules-h" className="flex flex-col gap-3 rounded-bento bg-sand p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="rules-h" className="text-[20px]">Permit rules</h2>
        <Pill tone="lilac">Checked {shortDate(m.rulesCheckedOn)}</Pill>
      </div>
      <p className={RAIL_NOTE}><Icon name="euro" size={18} className="mt-0.5 shrink-0" />{euro(m.criticalSkills)} is the minimum salary for a Critical Skills permit with a relevant degree.</p>
      <p className={RAIL_NOTE}><Icon name="calendar" size={18} className="mt-0.5 shrink-0" />A Critical Skills permit needs a job offer of at least {contractText(m.minContractMonths)}.</p>
      <Button href={staticPath("eligibility-checker")!} variant="outline" size="lg">Open the eligibility checker <Icon name="arrow" size={16} /></Button>
    </section>
  );
}

function OfferCard({ big }: { big?: boolean }) {
  return (
    <A href="/permit-services" className="flex items-start justify-between gap-4 rounded-bento bg-ink p-5 text-white no-underline">
      <span>
        <span className={`block font-heading font-semibold leading-snug ${big ? "text-[22px]" : "text-[18px]"}`}>Got an offer? We can handle your permit</span>
        <span className="mt-1 block text-small text-white/75">Our services team prepares the application. Usually paid by the employer.</span>
      </span>
      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-pill bg-deep-green"><Icon name="up-right" size={18} /></span>
    </A>
  );
}
const ScamBar = () => (
  <p className="flex items-center gap-3 rounded-bento bg-peach p-5 text-small font-semibold">
    <Icon name="warning" size={20} className="shrink-0" />
    No genuine employer asks you to pay for a job offer. Open a job to report it.
  </p>
);

const SORT_CHIP = "inline-flex min-h-[34px] items-center rounded-pill px-3.5 text-small font-medium no-underline";

export function SearchView(p: SearchProps) {
  const { state, list } = p;
  const f = state.filters;
  const visitor = !p.signedIn; // a visitor gets frame N02 from 1024 px and the phone layout below; a signed-in candidate frame C04
  const count = list.ok && list.count ? (list.count.more ? `${list.count.n}+` : String(list.count.n)) : null;
  const saved = new Set(p.savedIds);
  const path = searchHref(state);
  const none = list.ok && list.jobs.length === 0;
  const { what, county } = headingParts(f);
  const sector = inList(SECTORS, f.sector);
  const chips = chipsOf(state, p.occupationTitle);
  const a = alertFrom(f, p.occupationTitle);
  const sort = state.sort ?? "sponsor";
  const alertLink = p.signedIn ? "#alert" : loginHref(path);
  return (
    <>
      <div className={`${wrap} pb-8 pt-6 sm:pt-8`}>
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Find jobs", href: sector ? "/jobs" : undefined }, ...(sector ? [{ label: capFirst(sector) }] : [])]} />
        {visitor ? (
          <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
            <h1 className="min-w-0 break-words text-[2.1rem] leading-[1.5] sm:text-[3rem] lg:text-[4rem]">
              {none ? (
                <>No jobs match <Hl c="peach" tight>that search</Hl> yet</>
              ) : (
                <>
                  <Hl c="peach" tight>{what}</Hl>{county && <> in <Hl c="green" tight>{county}</Hl></>}
                  <br />where a <Hl c="lilac" tight>permit is realistic</Hl> <Dot icon="shield" tone="ink" />
                </>
              )}
            </h1>
            {count !== null && (
              <p data-count-big className="hidden shrink-0 pb-3 lg:block lg:text-right">
                <span className="block font-heading text-[2.9rem] font-semibold leading-none">{count}</span>
                <span className="mt-1 block text-small text-muted">{count === "1" ? "job" : "jobs"}, rechecked daily</span>
              </p>
            )}
          </div>
        ) : (
          <h1 className="mt-3 break-words">
            {none ? <>No jobs match <span className="text-deep-green">that search</span> yet</> : <>{what}{county && ` in ${county}`} where a <span className="text-deep-green">permit is realistic</span></>}
          </h1>
        )}
        {f.occupationCode && <p className="mt-2 text-muted">Occupation: {p.occupationTitle ?? f.occupationCode}</p>}
        <div className="mt-5"><SearchBar state={state} visitor={visitor} sectorCounts={p.sectorCounts} /></div>
        {visitor && (
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <FilterPanel state={state} sectorCounts={p.sectorCounts} sheet />
            <div className="contents max-lg:hidden"><FilterPills state={state} sectorCounts={p.sectorCounts} /></div>
          </div>
        )}
        <div className={visitor ? "mt-6 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_23.25rem] lg:gap-6" : "mt-6 grid gap-5 md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-6"}>
          {!visitor && <aside><FilterPanel state={state} sectorCounts={p.sectorCounts} /></aside>}
          <div className={`flex min-w-0 flex-col ${visitor ? "gap-3.5" : "gap-4"}`}>
            <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-bento bg-white px-5 py-4 shadow-pop ${visitor ? "lg:hidden" : ""}`}>
              <div>
                <p className="font-semibold" data-count>
                  {none ? "0 jobs" : count !== null ? `${count} ${count === "1" ? "job" : "jobs"}` : "Jobs"}
                </p>
                <p className="text-small text-muted">{none ? "We only list jobs where a permit is realistic, so some searches are empty." : "Rechecked daily. Closed jobs are removed."}</p>
              </div>
              {!none && <nav aria-label="Sort" className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-small text-muted">Sort by</span>
                {SORTS.map(([v, l]) => (
                  <A key={v} href={searchHref({ ...state, sort: v === "sponsor" ? undefined : v })} aria-current={sort === v ? "true" : undefined} className={`${SORT_CHIP} ${sort === v ? "bg-ink text-white" : "bg-hover-light text-ink hover:bg-lilac-soft"}`}>{l}</A>
                ))}
              </nav>}
            </div>
            {(chips.length > 0 || (list.ok && !none)) && (
              <div className={`flex flex-wrap items-center gap-2 ${visitor ? "lg:hidden" : ""}`} data-chips>
                {chips.map((c) => (
                  <A key={c.key} href={c.href} className="inline-flex min-h-[34px] items-center gap-2 rounded-pill bg-deep-green px-3.5 text-small font-medium text-white no-underline hover:bg-hover-dark">
                    {c.label}
                    <Icon name="close" size={14} />
                    <span className="sr-only">Remove this filter</span>
                  </A>
                ))}
                {list.ok && !none && (
                  <A href={alertLink} className="inline-flex min-h-[34px] items-center gap-1.5 rounded-pill bg-hover-light px-3.5 text-small font-medium text-deep-green no-underline hover:bg-lilac-soft">
                    <Icon name="bell" size={14} />
                    {p.signedIn ? "Save this search as an alert" : "Sign in to create an alert"}
                  </A>
                )}
              </div>
            )}
            {!list.ok && <Problem list={list} state={state} />}
            {list.ok && list.jobs.map((j) => (visitor ? <VisitorCard key={j.id} job={j} now={p.now} path={path} /> : <ResultCard key={j.id} job={j} now={p.now} signedIn={p.signedIn} saved={saved.has(j.id)} path={path} />))}
            {list.ok && list.signInForMore && !none && <SignInBox shown={list.jobs.length} count={list.count} path={path} />}
            {list.ok && p.signedIn && (list.next || list.previous) && (
              <Pager prevHref={list.previous ? searchHref(state, { before: list.previous }) : undefined} nextHref={list.next ? searchHref(state, { after: list.next }) : undefined} />
            )}
            {none && (
              <>
                <div data-empty className="flex flex-col items-center gap-3 rounded-bento bg-sand px-6 py-14 text-center">
                  <span className="grid size-14 place-items-center rounded-pill bg-deep-green text-white"><Icon name="search" size={26} /></span>
                  <h2 className="text-[22px]">Nothing to show for this search</h2>
                  <p className="max-w-md text-muted">Try a wider county, remove a filter, or set an alert. We check for new jobs every day and will email you when one appears.</p>
                  <span className="mt-2 flex flex-wrap justify-center gap-3">
                    <Button href="/jobs" className="bg-white text-deep-green hover:bg-hover-light" variant="chip" size="md">Clear filters</Button>
                    <Button href={alertLink} variant="dark" size="md"><Icon name="bell" size={16} />{p.signedIn ? "Create an alert for this search" : "Sign in to create an alert"}</Button>
                  </span>
                </div>
                {p.newest && p.newest.length > 0 && (
                  <section aria-labelledby="newest" className="flex flex-col gap-3">
                    <h2 id="newest" className="text-[20px]">Newest jobs with a confirmed sponsor</h2>
                    <div className="grid gap-4 sm:grid-cols-2">{p.newest.map((j, i) => <TileCard key={j.id} job={j} dark={i > 0} />)}</div>
                  </section>
                )}
              </>
            )}
            {list.ok && !visitor && (
              <>
                <AlertBuilder filters={a.filters} summary={a.summary} signedIn={p.signedIn} path={path} canSave={a.summary.length > 0 || a.notKept.length === 0} />
                {a.notKept.length > 0 && <p className="text-small text-muted">An alert keeps sector, county, occupation, salary from and badge. Your {a.notKept.join(", ")} filter is not saved in it.</p>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <OfferCard />
                  <ScamBar />
                </div>
              </>
            )}
          </div>
          {visitor && list.ok && (
            <aside aria-label="Alerts and permit rules" className="flex flex-col gap-5">
              <AlertRail summary={a.summary} notKept={a.notKept} href={alertLink} />
              {p.minimums && <RulesRail m={p.minimums} />}
              <OfferCard big />
              <ScamBar />
            </aside>
          )}
        </div>
      </div>
      {!p.signedIn && <Join />}
    </>
  );
}
