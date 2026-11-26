// The public company page and occupation page reads (step 9, #223, feature plan 3.3 and 3.4), run as app_candidate. Both show a first page of live
// jobs in the job list's own columns and cards; a further page is the `next` cursor of the one before. The scope (the company, the code) is a
// parameter and the column it filters is fixed in code, never taken from input.
import type pg from "pg";
import { checkEligibility, publicPayCandidatesOf, publicPayTier, registrationFor, standingLine, type Registration, type RulesSnapshot } from "@portal/rules";
import { freshPayDeals, getRules } from "./rules-data";
import { getContent, validSlug, type ContentPage } from "./content";
import { FIRST_PERMIT_YEAR, PERMITS, summarisePermits, type Permits } from "./dete";
import { BadSearchInput, cursorOf, decodeCursor, employerLabels, KEYS, CAST, LIST, listCards, LIVE, PAGE_SIZE, pageSize, SOURCE, type ScopedRow, type CompanyLabel, type JobCard, type ListRow, type Sort } from "./search";

type Db = Pick<pg.Pool, "query">;

// ===== a page of the live jobs of one company or one occupation =====
const SCOPES = {
  company: { where: "job.organisation_id = $1::bigint", sort: "newest" as Sort }, // job_company_page_idx
  occupation: { where: "job.occupation_code = $1::text", sort: "sponsor" as Sort }, // job_live_occupation (0018)
} as const;
export type JobsScope = keyof typeof SCOPES;
export type ScopedJobs = { jobs: JobCard[]; next: string | null; count: { n: number; more: boolean } | null };

export function scopedQuery(scope: JobsScope, value: string, after?: string, size = PAGE_SIZE): { text: string; values: unknown[] } {
  if (!pageSize(size)) throw new BadSearchInput("bad page size");
  const { where, sort } = SCOPES[scope];
  const keys = KEYS[sort].map((k) => `job.${k.col}`);
  const order = ["(not job.quota_full)", ...keys, "job.id"].map((c) => `${c} desc`).join(", ");
  const page = (cond: string) => `select ${LIST} from job ${SOURCE} where ${LIVE} and ${where}${cond} order by ${order} limit ${size + 1}`;
  if (after === undefined) return { text: page(""), values: [value] };
  const c = decodeCursor(sort, after);
  const row = ["$2::boolean", ...KEYS[sort].map((k, i) => `$${i + 3}::${CAST[k.kind]}`), `$${keys.length + 3}::bigint`].join(", ");
  return {
    text: page(` and ((not job.quota_full), ${keys.join(", ")}, job.id) < (${row})`),
    values: [value, !c.quotaFull, ...c.keys, c.id],
  };
}
/** Counted to the end, not to COUNT_CAP: the page prints the ten below (#301), which the search it links to prints too. ponytail: one index range; a cap again when one code or company has tens of thousands. */
export const scopedCount = (scope: JobsScope) => `select count(*)::int as n from job where ${LIVE} and ${SCOPES[scope].where}`;

// The page's employers (slug and logo for the cards) in one statement on the primary key, only for the distinct ids of the page; a company page knows its own.
export const PAGE_EMPLOYERS = "select id::text, slug, logo_url from organisation where id = any($1::bigint[])";
/** `company`: the company this page is of (company scope), so its cards need no read. */
export async function scopedJobs(db: Db, scope: JobsScope, value: string, after?: string, size = PAGE_SIZE, company?: { slug: string; logoUrl: string | null }): Promise<ScopedJobs> {
  const q = scopedQuery(scope, value, after, size); // throws BadSearchInput on a bad cursor, before any statement runs
  const [list, count] = await Promise.all([db.query<ScopedRow>(q.text, q.values), after === undefined ? db.query<{ n: number }>(scopedCount(scope), [value]) : null]);
  const rows = list.rows;
  const shown = rows.slice(0, size);
  const last = shown.at(-1);
  const owners = new Map<string, { slug: string; logo_url: string | null }>();
  if (!company && shown.length) for (const o of (await db.query<{ id: string; slug: string; logo_url: string | null }>(PAGE_EMPLOYERS, [[...new Set(shown.map((r) => r.organisation_id))]])).rows) owners.set(o.id, o);
  const withEmployer = ({ organisation_id: orgId, ...r }: ScopedRow): ListRow => {
    const o = company ? { slug: company.slug, logo_url: company.logoUrl } : owners.get(orgId);
    return { ...r, employer_slug: o?.slug ?? "", employer_logo_url: o?.logo_url ?? null };
  };
  return {
    jobs: await listCards(db, shown.map(withEmployer)),
    next: rows.length > size && last ? cursorOf(SCOPES[scope].sort, last) : null,
    count: count ? { n: count.rows[0]!.n, more: false } : null,
  };
}

// ===== the company page =====
const ORG =
  "select o.id::text, o.slug, o.display_name, o.website, o.logo_url, o.short_description, o.county, o.kind, o.status, o.permit_history, o.claimed_at, " +
  "o.claims_removed_at, (select m.slug from organisation m where m.id = o.merged_into_id) as merged_slug, o.merged_into_id is not null as merged " +
  "from organisation o where o.slug = $1";
const NAMES = "select name, kind from organisation_name where organisation_id = $1::bigint order by (kind = 'legal') desc, name limit 200";
const CUT_OFF = "select d.year::int, d.month::int from dete_permit_count d where d.month is not null order by d.year desc, d.month desc limit 1"; // qualified: a bare name in order by is the output column (the cast), which the index cannot serve
export const COMPANY_QUERIES = { org: ORG, names: NAMES, permits: PERMITS, cutOff: CUT_OFF };
export const PUBLIC_PAY_LABEL = "Public sector pay scale employer";
const HIDDEN_STATUSES = new Set(["rejected", "closed"]);

type OrgRow = {
  id: string; slug: string; display_name: string; website: string | null; logo_url: string | null; short_description: string | null; county: string | null;
  kind: string; status: string; permit_history: string; claimed_at: Date | null; claims_removed_at: Date | null; merged_slug: string | null; merged: boolean;
};
export type CompanyPage = {
  id: string; slug: string; name: string; kind: string; website: string | null; logoUrl: string | null; shortDescription: string | null; county: string | null;
  /** A verified account (the employer has claimed the page). */
  claimed: boolean;
  /** The job page's labels, plus (B23, #67) "Public sector pay scale employer" when a name of the company is on the public pay-deal list. */
  labels: (CompanyLabel | typeof PUBLIC_PAY_LABEL)[];
  names: { name: string; kind: string }[];
  /** null: no DETE name is linked (not zero). byMonth (B23): every month with permits, oldest first; dataThrough: the newest month any DETE row covers (the cut-off). */
  permits: (Permits & { byMonth: { year: number; month: number; permits: number }[]; dataThrough: { year: number; month: number } | null }) | null;
  jobs: ScopedJobs;
};
export type CompanyResult = { merged: string } | CompanyPage;

/** The page of one company by slug. null: unknown, not a slug, or a company that was rejected or closed. `{ merged }` is the slug the page moved to. */
export async function getCompanyPage(db: Db, slug: string, opts: { after?: string; now?: Date; limit?: number } = {}): Promise<CompanyResult | null> {
  if (!validSlug(slug)) return null;
  const o = (await db.query<OrgRow>(ORG, [slug])).rows[0];
  if (!o || HIDDEN_STATUSES.has(o.status)) return null;
  if (o.merged) return o.merged_slug ? { merged: o.merged_slug } : null;
  const [names, permits, jobs, cut, payDeals] = await Promise.all([
    db.query<{ name: string; kind: string }>(NAMES, [o.id]),
    db.query<{ year: number; month: number | null; permits: number }>(PERMITS, [o.id]),
    scopedJobs(db, "company", o.id, opts.after, opts.limit, { slug: o.slug, logoUrl: o.logo_url }),
    db.query<{ year: number; month: number }>(CUT_OFF),
    freshPayDeals(db),
  ]);
  const summary = summarisePermits(permits.rows, opts.now);
  const byMonth = permits.rows.filter((r): r is { year: number; month: number; permits: number } => r.month !== null && r.year >= FIRST_PERMIT_YEAR && r.permits > 0).sort((a, b) => a.year - b.year || a.month - b.month);
  const pay = publicPayCandidatesOf({ publicPayEmployers: payDeals });
  const publicPay = [o.display_name, ...names.rows.map((n) => n.name)].some((n) => publicPayTier(n, pay) > 0);
  return {
    id: o.id, slug: o.slug, name: o.display_name, kind: o.kind, website: o.website, logoUrl: o.logo_url, shortDescription: o.short_description, county: o.county,
    claimed: o.claimed_at !== null && (o.status === "verified" || o.status === "verified_restricted"),
    labels: [...employerLabels(o.permit_history, o.claims_removed_at), ...(publicPay ? [PUBLIC_PAY_LABEL as typeof PUBLIC_PAY_LABEL] : [])],
    names: names.rows, permits: summary && { ...summary, byMonth, dataThrough: cut.rows[0] ?? null }, jobs,
  };
}

// ===== the occupation page =====
export type ListEntry = { code: string; title: string; list: string };

export type OccupationPage = {
  code: string;
  /** The title of each list entry for the code (a code on both lists has two). */
  entries: { list: string; title: string }[];
  /** 'critical-skills' when any entry is (like the checker), else 'ineligible'. */
  listStatus: "critical-skills" | "ineligible";
  /** What the checker applies to a listed role; null for an ineligible one. */
  minimums: { withDegree: number; recentGraduate: number; graduateMonths: number; withoutDegreeOrNotListed: number | null; minContractMonths: number; basedOnWeekHours: number } | null;
  jobs: ScopedJobs;
  /** The General permit quota of the code (#85, Q39): "full" when the code is in the minimums' generalQuotaFullCodes, else "none". No used count is kept. */
  quota: "none" | "full";
  /** The optional published text block of the content side (kind occupation, slug = the code). */
  text: ContentPage | null;
  standingLine: string;
  rulesCheckedOn: string;
  /** The health registration the code needs (S6), with no title: a mixed code gives the cautious line. */
  registration: Registration | null;
};

/** One occupation by code, or null when the code is not on either list (so there is no page for it). */
/** `rules`: the minimums and lists in force (#229, default `getRules(db)`, the database); `lists` replaces the snapshot's lists (tests). */
export async function getOccupationPage(db: Db, code: string, opts: { after?: string; lists?: readonly ListEntry[]; rules?: RulesSnapshot; limit?: number } = {}): Promise<OccupationPage | null> {
  if (typeof code !== "string" || !/^[0-9]{4}$/.test(code)) return null;
  const rules = opts.rules ?? (await getRules(db)), m = rules.minimums;
  const entries = (opts.lists ?? rules.occupationLists).filter((e) => e.code === code);
  if (entries.length === 0) return null;
  const listed = entries.some((e) => e.list === "critical-skills");
  const [jobs, text] = await Promise.all([scopedJobs(db, "occupation", code, opts.after, opts.limit), getContent(db, "occupation", code)]);
  return {
    code, entries: entries.map((e) => ({ list: e.list, title: e.title })), listStatus: listed ? "critical-skills" : "ineligible",
    minimums: listed
      ? { withDegree: m.criticalSkills, recentGraduate: m.graduate, graduateMonths: m.graduateMonths, withoutDegreeOrNotListed: m.nonListRoute ? m.nonList : null, minContractMonths: m.minContractMonths, basedOnWeekHours: m.standardWeekHours }
      : null,
    jobs, quota: m.generalQuotaFullCodes?.includes(code) ? "full" : "none", text, standingLine: standingLine(m.checkedOn), rulesCheckedOn: m.checkedOn, registration: registrationFor(code),
  };
}

/** The checker with the rules in force (#229): what the route calls. Input checks throw BadEligibilityInput. */
export const checkWithSiteLists = async (db: Db, input: Parameters<typeof checkEligibility>[0], opts?: Parameters<typeof checkEligibility>[2]) => checkEligibility(input, await getRules(db), opts);
