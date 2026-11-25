// Pure helpers of the job pages (no data reads, no React): money, dates, the search query and its links.

export const euro = (n: number) => `€${new Intl.NumberFormat("en-IE").format(n)}`;
/** The pay scale line comes from the read as "EUR 38,166 to 56,592" (placeholder wording, CF54): print the euro sign. */
export const euroText = (s: string) => s.replace(/\bEUR\s?(?=\d)/g, "€").replace(/ to (?=\d)/g, " to €");
export const toDate = (d: Date | string | null | undefined): Date | null => {
  if (d == null) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
};
/** "today", "yesterday", "3 days ago", "2 weeks ago" or "5 months ago" for a time before `now`. */
export function ago(d: Date | string | null | undefined, now: Date): string | null {
  const t = toDate(d);
  if (!t) return null;
  const days = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}
export const initials = (name: string) => name.split(/\s+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
/** A fixed-term contract's length, or null when the job does not state one (we never say "permanent" on a guess). */
export const contractText = (months: number | null) => (months === null ? null : months % 12 === 0 ? `${months / 12} ${months === 12 ? "year" : "years"}` : `${months} months`);
export const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ===== the search query =====
export const SECTORS = ["health", "IT", "construction and engineering", "finance", "care", "hospitality", "pharma and science", "other"] as const;
export const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick", "Longford", "Louth", "Mayo", "Meath",
  "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
] as const;
export const SORTS = [["sponsor", "Sponsors first"], ["newest", "Newest"], ["salary", "Highest salary"]] as const;
export const FILTER_KEYS = ["q", "occupationCode", "sector", "county", "salaryMin", "badge", "postedWithin", "salaryStated"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Partial<Record<FilterKey, string>>;
export type SearchState = { filters: Filters; sort?: string; after?: string; before?: string };
type Raw = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => {
  const s = (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 400);
  return s ? s : undefined;
};
/** The page's own view of the address query: the first value of each known key, nothing else. The read validates every value (a bad one is a 400 the page words). */
export function parseSearch(raw: Raw): SearchState {
  const filters: Filters = {};
  for (const k of FILTER_KEYS) {
    const v = first(raw[k]);
    if (v !== undefined) filters[k] = v;
  }
  return { filters, sort: first(raw.sort), after: first(raw.after), before: first(raw.before) };
}
/** The query string of the page's own links: the filters and the sort, and a paging token only when `extra` gives one (a token works for the filters it was made with). */
export function queryOf(s: SearchState, extra: { after?: string; before?: string } = {}): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (s.filters[k] !== undefined) p.set(k, s.filters[k]!);
  if (s.sort) p.set("sort", s.sort);
  if (extra.after) p.set("after", extra.after);
  if (extra.before) p.set("before", extra.before);
  return p;
}
/** The query the list read takes: the page's own query plus the paging token it was opened on. */
export const readQuery = (s: SearchState) => queryOf(s, { after: s.after, before: s.before });
export const searchHref = (s: SearchState, extra?: { after?: string; before?: string }) => {
  const q = queryOf(s, extra).toString();
  return q ? `/jobs?${q}` : "/jobs";
};
export const activeFilters = (f: Filters) => FILTER_KEYS.filter((k) => f[k] !== undefined).length;

// ===== titles and descriptions (frame 01 SEO spec: title 60 or fewer plus the site name, which _content/meta.ts cuts and adds; description 120 to 160) =====
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
// Only values the read accepts reach a heading, a title or a description: a bad filter is worded as an error on the page, never echoed as a title.
const known = <T extends string>(list: readonly T[], v: string | undefined) => list.find((x) => x === v);
/** The two parts of the heading: what is searched ("Nurse jobs") and the county, when the read would accept it. */
export function headingParts(f: Filters): { what: string; county: string | null } {
  const sector = known(SECTORS, f.sector);
  return { what: f.q ? `${capFirst(clip(f.q, 30))} jobs` : sector ? `${capFirst(sector)} jobs` : "Jobs", county: known(COUNTIES, f.county) ?? null };
}
export function searchHeading(f: Filters): string {
  const { what, county } = headingParts(f);
  return county ? `${what} in ${county}` : what;
}
export const searchTitle = (f: Filters) => (searchHeading(f) === "Jobs" ? "Find a job" : searchHeading(f));
const DESCRIPTION = "Live jobs in Ireland where an employment permit is realistic. Filter by county, sector, salary and permit badge. Rules are checked against DETE guidance.";
export const searchDescription = (f: Filters) => {
  const d = searchHeading(f) !== "Jobs" ? `${searchHeading(f)}: live jobs where an employment permit is realistic. Filter by sector, salary and permit badge. Checked against DETE guidance.` : DESCRIPTION;
  return d.length >= 120 && d.length <= 160 ? d : DESCRIPTION;
};

/** The log in link that comes back to `path` (an own path only; anything else goes to plain /login). Whether the login page honours `next` is the sign-in slice's call. */
export const loginHref = (path: string) => (/^\/(?!\/)[\w\-./?=&%~]*$/.test(path) ? `/login?next=${encodeURIComponent(path)}` : "/login");

export const jobTitleText = (j: { title: string; employerName: string }) => `${j.title} at ${j.employerName}`;
/** 120 to 160 characters: what the job is, then fixed lines until it is long enough, then cut. */
export function jobDescription(j: { title: string; employerName: string; county: string | null; badge: string | null }): string {
  const lead = `${j.title} at ${j.employerName}${j.county ? ` in ${j.county}` : ""}.`;
  const badge = j.badge === "critical_skills_eligible" ? " Meets the Critical Skills pay rule." : j.badge === "sponsor_confirmed" ? " The employer says it will sponsor a permit." : "";
  let d = `${lead}${badge} See the pay, our permit check and how to apply.`;
  for (const extra of [" Rules are checked against DETE guidance.", " Free for candidates.", " Jobs are rechecked daily."]) if (d.length < 120) d += extra;
  return d.length > 160 ? `${d.slice(0, 159).trimEnd()}…` : d;
}

/** Who pays DETE's permit fee, by permit type (#297). Not our service fee: the employer or agency pays that, never the candidate (#3, #84). */
export const permitFeeLabel = (permitType: string) => (permitType === "critical_skills" ? "Paid by the employee or employer" : "Usually paid by the employer");
