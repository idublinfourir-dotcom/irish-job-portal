// The public company page and occupation page reads (step 9, #223, feature plan 3.3 and 3.4), run as app_candidate. Both show a first page of live
// jobs in the job list's own columns and cards; a further page is the `next` cursor of the one before. The scope (the company, the code) is a
// parameter and the column it filters is fixed in code, never taken from input.
import type pg from "pg";
import { checkEligibility, CRITICAL_SKILLS_MINIMUM, GRADUATE_MINIMUM, GRADUATE_MONTHS, MIN_CONTRACT_MONTHS, NON_LIST_MINIMUM, NON_LIST_ROUTE, RULES_CHECKED_ON, standingLine } from "@portal/rules";
import occupationLists from "../../fetcher/data/occupation-lists.json";
import { getContent, validSlug, type ContentPage } from "./content";
import { card, COUNT_CAP, cursorOf, decodeCursor, KEYS, CAST, LIST, LIVE, PAGE_SIZE, SOURCE, type JobCard, type ListRow, type Sort } from "./search";

type Db = Pick<pg.Pool, "query">;

// ===== a page of the live jobs of one company or one occupation =====
const SCOPES = {
  company: { where: "job.organisation_id = $1::bigint", sort: "newest" as Sort }, // job_company_page_idx
  occupation: { where: "job.occupation_code = $1::text", sort: "sponsor" as Sort }, // job_live_occupation (0018)
} as const;
export type JobsScope = keyof typeof SCOPES;
export type ScopedJobs = { jobs: JobCard[]; next: string | null; count: { n: number; more: boolean } | null };

export function scopedQuery(scope: JobsScope, value: string, after?: string): { text: string; values: unknown[] } {
  const { where, sort } = SCOPES[scope];
  const keys = KEYS[sort].map((k) => `job.${k.col}`);
  const order = ["(not job.quota_full)", ...keys, "job.id"].map((c) => `${c} desc`).join(", ");
  const tail = `order by ${order} limit ${PAGE_SIZE + 1}`;
  if (after === undefined) return { text: `select ${LIST} from job ${SOURCE} where ${LIVE} and ${where} ${tail}`, values: [value] };
  const c = decodeCursor(sort, after);
  const row = ["$2::boolean", ...KEYS[sort].map((k, i) => `$${i + 3}::${CAST[k.kind]}`), `$${keys.length + 3}::bigint`].join(", ");
  return {
    text: `select ${LIST} from job ${SOURCE} where ${LIVE} and ${where} and ((not job.quota_full), ${keys.join(", ")}, job.id) < (${row}) ${tail}`,
    values: [value, !c.quotaFull, ...c.keys, c.id],
  };
}
export const scopedCount = (scope: JobsScope) =>
  `select count(*)::int as n from (select 1 from job where job.status = 'live' and job.closes_at > now() and ${SCOPES[scope].where} limit ${COUNT_CAP + 1}) c`;

export async function scopedJobs(db: Db, scope: JobsScope, value: string, after?: string): Promise<ScopedJobs> {
  const q = scopedQuery(scope, value, after); // throws BadSearchInput on a bad cursor, before any statement runs
  const [list, count] = await Promise.all([db.query<ListRow>(q.text, q.values), after === undefined ? db.query<{ n: number }>(scopedCount(scope), [value]) : null]);
  const rows = list.rows;
  const shown = rows.slice(0, PAGE_SIZE);
  const last = shown.at(-1);
  const n = count?.rows[0]!.n ?? 0;
  return {
    jobs: shown.map(card),
    next: rows.length > PAGE_SIZE && last ? cursorOf(SCOPES[scope].sort, last) : null,
    count: count ? { n: Math.min(n, COUNT_CAP), more: n > COUNT_CAP } : null,
  };
}

// ===== the company page =====
const ORG =
  "select o.id::text, o.slug, o.display_name, o.website, o.logo_url, o.short_description, o.county, o.kind, o.status, o.permit_history, o.claimed_at, " +
  "o.claims_removed_at, (select m.slug from organisation m where m.id = o.merged_into_id) as merged_slug, o.merged_into_id is not null as merged " +
  "from organisation o where o.slug = $1";
const NAMES = "select name, kind from organisation_name where organisation_id = $1::bigint order by (kind = 'legal') desc, name limit 200";
// Linked DETE rows per year and month, every year. A yearly total has no month. No rows at all means "not linked".
const PERMITS =
  "select d.year::int as year, d.month::int as month, sum(d.permits)::int as permits from organisation_name n join dete_permit_count d on d.organisation_name_id = n.id " +
  "where n.organisation_id = $1::bigint group by d.year, d.month";
export const COMPANY_QUERIES = { org: ORG, names: NAMES, permits: PERMITS };
export const FIRST_PERMIT_YEAR = 2019; // the DETE files the site shows start here (feature plan 3.3)
const HIDDEN_STATUSES = new Set(["rejected", "closed"]);

type OrgRow = {
  id: string; slug: string; display_name: string; website: string | null; logo_url: string | null; short_description: string | null; county: string | null;
  kind: string; status: string; permit_history: string; claimed_at: Date | null; claims_removed_at: Date | null; merged_slug: string | null; merged: boolean;
};
export type Permits = {
  byYear: { year: number; permits: number }[];
  peakYear: number | null;
  /** The last full year against the year before it. null when neither had permits. */
  trend: "up" | "down" | "flat" | null;
  latestMonth: { year: number; month: number; permits: number } | null;
};
export type CompanyLabel = "First-time sponsor" | "Permit history not linked yet" | "Sponsorship claims removed";
export type CompanyPage = {
  id: string; slug: string; name: string; kind: string; website: string | null; logoUrl: string | null; shortDescription: string | null; county: string | null;
  /** A verified account (the employer has claimed the page). */
  claimed: boolean;
  labels: CompanyLabel[];
  names: { name: string; kind: string }[];
  /** null: no DETE name is linked (not zero). */
  permits: Permits | null;
  jobs: ScopedJobs;
};
export type CompanyResult = { merged: string } | CompanyPage;

/** Pure: the permit rows into the figures a page shows. A year with a yearly total uses it; otherwise its months are added. */
export function summarisePermits(rows: { year: number; month: number | null; permits: number }[], now = new Date()): Permits | null {
  if (rows.length === 0) return null;
  const yearly = new Map<number, number>();
  const monthly = new Map<number, number>();
  for (const r of rows) if (r.year >= FIRST_PERMIT_YEAR) (r.month === null ? yearly : monthly).set(r.year, ((r.month === null ? yearly : monthly).get(r.year) ?? 0) + r.permits);
  const total = (y: number) => yearly.get(y) ?? monthly.get(y) ?? 0;
  const byYear = [...new Set([...yearly.keys(), ...monthly.keys()])].sort((a, b) => a - b).map((year) => ({ year, permits: total(year) })).filter((y) => y.permits > 0);
  const peak = byYear.reduce<{ year: number; permits: number } | null>((best, y) => (best === null || y.permits >= best.permits ? y : best), null);
  const last = now.getUTCFullYear() - 1;
  const [a, b] = [total(last), total(last - 1)];
  const months = rows.filter((r) => r.month !== null && r.year >= FIRST_PERMIT_YEAR && r.permits > 0).sort((x, y) => y.year - x.year || y.month! - x.month!);
  const m = months[0];
  return {
    byYear, peakYear: peak?.year ?? null,
    trend: a === 0 && b === 0 ? null : a > b ? "up" : a < b ? "down" : "flat",
    latestMonth: m ? { year: m.year, month: m.month!, permits: m.permits } : null,
  };
}

/** The page of one company by slug. null: unknown, not a slug, or a company that was rejected or closed. `{ merged }` is the slug the page moved to. */
export async function getCompanyPage(db: Db, slug: string, opts: { after?: string; now?: Date } = {}): Promise<CompanyResult | null> {
  if (!validSlug(slug)) return null;
  const o = (await db.query<OrgRow>(ORG, [slug])).rows[0];
  if (!o || HIDDEN_STATUSES.has(o.status)) return null;
  if (o.merged) return o.merged_slug ? { merged: o.merged_slug } : null;
  const [names, permits, jobs] = await Promise.all([
    db.query<{ name: string; kind: string }>(NAMES, [o.id]),
    db.query<{ year: number; month: number | null; permits: number }>(PERMITS, [o.id]),
    scopedJobs(db, "company", o.id, opts.after),
  ]);
  const labels: CompanyLabel[] = [];
  if (o.permit_history === "first_time") labels.push("First-time sponsor");
  if (o.permit_history === "not_linked") labels.push("Permit history not linked yet");
  if (o.claims_removed_at) labels.push("Sponsorship claims removed");
  return {
    id: o.id, slug: o.slug, name: o.display_name, kind: o.kind, website: o.website, logoUrl: o.logo_url, shortDescription: o.short_description, county: o.county,
    claimed: o.claimed_at !== null && (o.status === "verified" || o.status === "verified_restricted"),
    labels, names: names.rows, permits: summarisePermits(permits.rows, opts.now), jobs,
  };
}

// ===== the occupation page =====
export type ListEntry = { code: string; title: string; list: string };
export const OCCUPATION_LISTS = occupationLists as readonly ListEntry[];

export type OccupationPage = {
  code: string;
  /** The title of each list entry for the code (a code on both lists has two). */
  entries: { list: string; title: string }[];
  /** 'critical-skills' when any entry is (like the checker), else 'ineligible'. */
  listStatus: "critical-skills" | "ineligible";
  /** What the checker applies to a listed role; null for an ineligible one. */
  minimums: { withDegree: number; recentGraduate: number; graduateMonths: number; withoutDegreeOrNotListed: number | null; minContractMonths: number; basedOnWeekHours: number } | null;
  jobs: ScopedJobs;
  /** The optional published text block of the content side (kind occupation, slug = the code). */
  text: ContentPage | null;
  standingLine: string;
  rulesCheckedOn: string;
};

/** One occupation by code, or null when the code is not on either list (so there is no page for it). */
export async function getOccupationPage(db: Db, code: string, opts: { after?: string; lists?: readonly ListEntry[] } = {}): Promise<OccupationPage | null> {
  if (typeof code !== "string" || !/^[0-9]{4}$/.test(code)) return null;
  const entries = (opts.lists ?? OCCUPATION_LISTS).filter((e) => e.code === code);
  if (entries.length === 0) return null;
  const listed = entries.some((e) => e.list === "critical-skills");
  const [jobs, text] = await Promise.all([scopedJobs(db, "occupation", code, opts.after), getContent(db, "occupation", code)]);
  return {
    code, entries: entries.map((e) => ({ list: e.list, title: e.title })), listStatus: listed ? "critical-skills" : "ineligible",
    minimums: listed
      ? { withDegree: CRITICAL_SKILLS_MINIMUM, recentGraduate: GRADUATE_MINIMUM, graduateMonths: GRADUATE_MONTHS, withoutDegreeOrNotListed: NON_LIST_ROUTE ? NON_LIST_MINIMUM : null, minContractMonths: MIN_CONTRACT_MONTHS, basedOnWeekHours: 39 }
      : null,
    jobs, text, standingLine: standingLine(), rulesCheckedOn: RULES_CHECKED_ON,
  };
}

/** The checker with the site's own lists: what the route calls. Input checks throw BadEligibilityInput. */
export const checkWithSiteLists = (input: Parameters<typeof checkEligibility>[0], opts?: Parameters<typeof checkEligibility>[2]) => checkEligibility(input, OCCUPATION_LISTS, opts);
