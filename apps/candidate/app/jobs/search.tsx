// The search results page body (N02 visitor, C04 signed in, C05 empty, NM2 and M03 on a phone), as a pure view of what the page read.
// page.tsx reads; this file only shows. Every state of the read has its words here: 400, 401 (a visitor asked for a later page), 429, empty, and the visitor limit.
import { A, Breadcrumb, Button, Icon, Notice, Pager } from "@portal/ui";
import { AlertBuilder } from "./client";
import { ResultCard, TileCard, type CardJob } from "./card";
import { FilterPanel, SearchBar, POSTED } from "./filters";
import { COUNTIES, SECTORS, SORTS, capFirst, headingParts, loginHref, searchHref, type FilterKey, type Filters, type SearchState } from "./format";
import { Join, wrap } from "./parts";

export type ListRead =
  | { ok: true; jobs: CardJob[]; next: string | null; previous: string | null; count: { n: number; more: boolean } | null; signInForMore: boolean }
  | { ok: false; status: number; code: string; retryAfter?: number };
export type SearchProps = {
  state: SearchState; now: Date; list: ListRead; signedIn: boolean; savedIds: string[];
  sectorCounts?: { sector: string; jobs: number }[]; occupationTitle?: string | null; newest?: CardJob[];
};

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

const SORT_CHIP = "inline-flex min-h-[34px] items-center rounded-pill px-3.5 text-small font-medium no-underline";

export function SearchView(p: SearchProps) {
  const { state, list } = p;
  const f = state.filters;
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
        <h1 className="mt-3 break-words">
          {none ? <>No jobs match <span className="text-deep-green">that search</span> yet</> : <>{what}{county && ` in ${county}`} where a <span className="text-deep-green">permit is realistic</span></>}
        </h1>
        {f.occupationCode && <p className="mt-2 text-muted">Occupation: {p.occupationTitle ?? f.occupationCode}</p>}
        <div className="mt-5"><SearchBar state={state} /></div>
        <div className="mt-6 grid gap-5 md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-6">
          <aside><FilterPanel state={state} sectorCounts={p.sectorCounts} /></aside>
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-bento bg-white px-5 py-4 shadow-pop">
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
              <div className="flex flex-wrap items-center gap-2" data-chips>
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
            {list.ok && list.jobs.map((j) => <ResultCard key={j.id} job={j} now={p.now} signedIn={p.signedIn} saved={saved.has(j.id)} path={path} />)}
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
                    <div className="grid gap-4 sm:grid-cols-2">{p.newest.map((j) => <TileCard key={j.id} job={j} now={p.now} signedIn={p.signedIn} saved={saved.has(j.id)} />)}</div>
                  </section>
                )}
              </>
            )}
            {list.ok && (
              <>
                <AlertBuilder filters={a.filters} summary={a.summary} signedIn={p.signedIn} path={path} canSave={a.summary.length > 0 || a.notKept.length === 0} />
                {p.signedIn && a.notKept.length > 0 && <p className="text-small text-muted">An alert keeps sector, county, occupation, salary from and badge. Your {a.notKept.join(", ")} filter is not saved in it.</p>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <A href="/permit-services" className="flex items-start justify-between gap-4 rounded-bento bg-ink p-5 text-white no-underline">
                    <span>
                      <span className="block font-heading text-[18px] font-semibold leading-snug">Got an offer? We can handle your permit</span>
                      <span className="mt-1 block text-small text-white/75">Our services team prepares the application. Usually paid by the employer.</span>
                    </span>
                    <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-pill bg-deep-green"><Icon name="up-right" size={18} /></span>
                  </A>
                  <p className="flex items-center gap-3 rounded-bento bg-peach p-5 text-small font-semibold">
                    <Icon name="warning" size={20} className="shrink-0" />
                    No genuine employer asks you to pay for a job offer. Open a job to report it.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {!p.signedIn && <Join />}
    </>
  );
}
