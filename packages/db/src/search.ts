// The Search module (design 23, section 3): the two reads the candidate pages call, run as app_candidate. The job list and one job.
// Every statement is a constant with parameters, every column is named (never `select job.*`: it would fetch search_vector and columns the
// candidate role cannot read), and the list pages on the sort key plus id, never OFFSET. No advert text is read for a list.
import { createHash } from "node:crypto";
import type pg from "pg";
import { RULES_CHECKED_ON as RULES_DATE, SOC2010_CODES, type Sector } from "@portal/rules";
import { getRules } from "./rules-data";
import { permitsLast5Years } from "./dete";

type Db = Pick<pg.Pool, "query">;

export const SORTS = ["sponsor", "newest", "salary"] as const;
export type Sort = (typeof SORTS)[number];
export const PAGE_SIZE = 20;
export const COUNT_CAP = 200; // #125: the count stops here ("200+")
// The date on the standing line "Rules last checked on [date]" (#94), version 1. A job page reads the date in force from getRules(db) (#229).
export const RULES_CHECKED_ON = RULES_DATE;

/** A bad cursor, sort, filter or id from a URL. A page answers 400 or shows the first page. */
export class BadSearchInput extends Error {}

// ===== filters (S1, S2, #247): the alert filters with the alert run's meaning (0024), plus keyword, posted within and pay stated =====
// The six sectors the rules give a job (types.ts, Sector); a job is stored with one of them.
export const ALERT_SECTORS: readonly Sector[] = ["health", "IT", "construction and engineering", "finance", "pharma and science", "other"];
// The 26 counties of the Republic (the same list as apps/portal/lib/jobs.ts and packages/fetcher/src/county.ts).
export const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick",
  "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
] as const;
export const MAX_SALARY = 1_000_000; // whole euros a year, the posting check's ceiling
export const MAX_Q = 200; // characters of keyword text
export const POSTED_WITHIN = [1, 3, 7, 30] as const;

export type JobFilters = { occupationCode: string | null; sector: string | null; county: string | null; salaryMin: number | null; badge: string | null };
/** The filters an alert and a search share, one check for both. Absent or null means "any"; null back means refuse. */
export function checkJobFilters(b: Record<string, unknown>, occupations: ReadonlySet<string>): JobFilters | null {
  const { occupationCode: occ, sector, county, salaryMin, badge } = b;
  const any = (v: unknown) => v === undefined || v === null;
  if (!any(occ) && !(typeof occ === "string" && occupations.has(occ))) return null;
  if (!any(sector) && !(typeof sector === "string" && (ALERT_SECTORS as readonly string[]).includes(sector))) return null;
  if (!any(county) && !(typeof county === "string" && (COUNTIES as readonly string[]).includes(county))) return null;
  if (!any(salaryMin) && !(Number.isInteger(salaryMin) && (salaryMin as number) >= 0 && (salaryMin as number) <= MAX_SALARY)) return null;
  if (!any(badge) && badge !== "sponsor_confirmed") return null;
  return { occupationCode: (occ as string) ?? null, sector: (sector as string) ?? null, county: (county as string) ?? null, salaryMin: (salaryMin as number) ?? null, badge: (badge as string) ?? null };
}

/** A search: the alert filters plus three of its own. Absent means "any". */
export type SearchFilters = Partial<{ [K in keyof JobFilters]: NonNullable<JobFilters[K]> }> & { q?: string; postedWithin?: (typeof POSTED_WITHIN)[number]; salaryStated?: true };
const FILTER_KEYS = ["q", "occupationCode", "sector", "county", "salaryMin", "badge", "postedWithin", "salaryStated"] as const;

/** Checks a filter object (from parseSearch or a page) and returns it with only the filters set. Throws BadSearchInput. */
export function checkSearch(f: unknown): SearchFilters {
  const bad = (why: string) => new BadSearchInput(`bad filter: ${why}`);
  if (f === undefined) return {};
  if (typeof f !== "object" || f === null || Array.isArray(f)) throw bad("not an object");
  const o = f as Record<string, unknown>;
  if (!Object.keys(o).every((k) => (FILTER_KEYS as readonly string[]).includes(k))) throw bad("unknown key");
  const shared = checkJobFilters(o, SOC2010_CODES);
  if (!shared) throw bad("alert filter");
  const out: SearchFilters = {};
  for (const [k, v] of Object.entries(shared)) if (v !== null) Object.assign(out, { [k]: v });
  if (o.q !== undefined) {
    if (typeof o.q !== "string") throw bad("q");
    const q = o.q.trim();
    if (q.length > MAX_Q) throw bad("q too long");
    if (/\p{Cc}/u.test(q)) throw bad("q control character"); // null bytes, newlines, escapes: Postgres text refuses a null byte
    if (q) out.q = q; // empty means no keyword
  }
  if (o.postedWithin !== undefined) {
    if (!(POSTED_WITHIN as readonly unknown[]).includes(o.postedWithin)) throw bad("postedWithin");
    out.postedWithin = o.postedWithin as SearchFilters["postedWithin"];
  }
  if (o.salaryStated !== undefined && o.salaryStated !== false) {
    if (o.salaryStated !== true) throw bad("salaryStated");
    out.salaryStated = true;
  }
  return out;
}

/**
 * The filters from a page's URL. Keys are the filter names (q, occupationCode, sector, county, salaryMin, badge, postedWithin, salaryStated=true);
 * an empty value means "any" (a form's blank select), a key given twice is refused, and other keys (sort, after, before, tracking tags) are ignored.
 */
export function parseSearch(params: URLSearchParams): SearchFilters {
  const o: Record<string, unknown> = {};
  for (const k of FILTER_KEYS) {
    const all = params.getAll(k);
    if (all.length > 1) throw new BadSearchInput(`bad filter: ${k} twice`);
    const v = all[0];
    if (v === undefined || v === "") continue;
    if (k === "salaryMin" || k === "postedWithin") {
      if (!/^\d{1,7}$/.test(v)) throw new BadSearchInput(`bad filter: ${k}`);
      o[k] = Number(v);
    } else if (k === "salaryStated") {
      if (v !== "true") throw new BadSearchInput("bad filter: salaryStated");
      o[k] = true;
    } else o[k] = v;
  }
  return checkSearch(o);
}

/** The URL form of the filters, the inverse of parseSearch. */
export const searchParams = (f: SearchFilters) => new URLSearchParams(FILTER_KEYS.filter((k) => f[k] !== undefined).map((k) => [k, String(f[k])]));

/**
 * The body checkAlert takes for the same search, without the frequency the candidate picks. q, postedWithin and salaryStated have no alert
 * column the alert route accepts (it refuses free text, Q2), so they are left out: the alert then matches more than the search showed.
 */
export const toAlertBody = (f: SearchFilters) => ({
  occupationCode: f.occupationCode ?? null, sector: f.sector ?? null, county: f.county ?? null, salaryMin: f.salaryMin ?? null, badge: f.badge ?? null,
});

/** A short hash of the checked filters, carried in the cursor so a cursor works only with the filters it was made for. */
export const filterHash = (f: SearchFilters) =>
  createHash("sha256").update(JSON.stringify(FILTER_KEYS.map((k) => f[k] ?? null))).digest("base64url").slice(0, 16);
const NO_FILTERS = filterHash({});

/**
 * The filters as SQL, every value a parameter numbered after `values`: `with` is a CTE (the keyword's matches) or empty, `where`
 * the terms to AND on. The keyword is matched once on the GIN index (job_live_search) in its own materialized CTE: checked row by row it reads
 * each row's search_vector out of TOAST, which cost over 1,000 pages for a common word on the full-size fill (test/perf/search.perf.ts).
 */
export function filterSql(f: SearchFilters, values: unknown[]): { with: string; where: string } {
  const p = (v: unknown) => (values.push(v), `$${values.length}`);
  const pay = "num_nonnulls(job.salary_low, job.salary_high) > 0";
  const t: string[] = [];
  let cte = "";
  if (f.q !== undefined) {
    // A query of stop words or punctuation only parses to nothing: then there is no keyword filter (the list is not emptied).
    const tq = `websearch_to_tsquery('english', ${p(f.q)}::text)`;
    cte = `kw as materialized (select id from job where status = 'live' and search_vector @@ ${tq})`;
    t.push(`(numnode(${tq}) = 0 or job.id in (select id from kw))`);
  }
  if (f.occupationCode !== undefined) t.push(`job.occupation_code = ${p(f.occupationCode)}::text`);
  if (f.sector !== undefined) t.push(`job.sector = ${p(f.sector)}::text`);
  if (f.county !== undefined) t.push(`job.county = ${p(f.county)}::text`);
  if (f.salaryMin !== undefined) t.push(`${pay} and job.salary_sort >= ${p(f.salaryMin)}::int`);
  if (f.badge !== undefined) t.push(`job.badge = ${p(f.badge)}::text`);
  if (f.postedWithin !== undefined) t.push(`job.posted_at > now() - ${p(f.postedWithin)}::int * interval '1 day'`);
  if (f.salaryStated) t.push(pay);
  return { with: cte, where: t.map((x) => ` and ${x}`).join("") };
}

// The sort keys that follow (not quota_full) and come before id. Full-quota jobs sort last on every sort (#85).
// sponsor (#154, #157): permits in the last 5 years, then newest. -1 means no confirmed DETE link, so those come after the rest.
export const KEYS: Record<Sort, { col: string; kind: "int" | "time" }[]> = {
  sponsor: [{ col: "sponsor_sort", kind: "int" }, { col: "posted_at", kind: "time" }],
  newest: [{ col: "posted_at", kind: "time" }],
  salary: [{ col: "salary_sort", kind: "int" }],
};
export const CAST = { int: "int", time: "timestamptz" } as const;

// ===== cursors: an opaque token for the row a page starts or ends at =====
export type Cursor = { sort: Sort; quotaFull: boolean; keys: string[]; id: string };

const INT = /^-?\d{1,10}$/;
// Text from Postgres keeps the microseconds a JavaScript Date would lose. A 4-digit year from 1970 on, and Date.parse rejects a month 13.
const TIME = /^(19[7-9]\d|2\d{3})-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d(:?\d\d)?)$/;
const ID = /^[1-9]\d{0,18}$/;
const MAX_BIGINT = 2n ** 63n - 1n;
export const validId = (s: unknown): s is string => typeof s === "string" && ID.test(s) && BigInt(s) <= MAX_BIGINT;
// Postgres writes the zone as +00, which Date.parse refuses, so it gets :00 first.
export const isTime = (s: string) => TIME.test(s) && !Number.isNaN(Date.parse(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")));
const validKey = (kind: "int" | "time", s: unknown): s is string =>
  typeof s === "string" && (kind === "int" ? INT.test(s) && Number(s) >= -1 && Number(s) <= 2147483647 : isTime(s));

/** `f` is the filterHash of the filters the cursor's list ran with. */
export function encodeCursor(c: Cursor, f = NO_FILTERS): string {
  return Buffer.from(JSON.stringify({ s: c.sort, q: c.quotaFull, k: c.keys, i: c.id, f })).toString("base64url");
}

/** Throws BadSearchInput for anything that is not exactly a token this module made for this sort and these filters. */
export function decodeCursor(sort: Sort, token: unknown, f = NO_FILTERS): Cursor {
  const bad = () => new BadSearchInput("bad cursor");
  if (typeof token !== "string" || token.length > 300 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad();
  let o: { s?: unknown; q?: unknown; k?: unknown; i?: unknown; f?: unknown };
  try {
    o = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const kinds = KEYS[sort];
  if (o === null || typeof o !== "object" || o.s !== sort || o.f !== f || typeof o.q !== "boolean" || !Array.isArray(o.k) || o.k.length !== kinds.length) throw bad();
  if (!kinds.every((k, i) => validKey(k.kind, (o.k as unknown[])[i])) || !validId(o.i)) throw bad();
  return { sort, quotaFull: o.q, keys: o.k as string[], id: o.i };
}

// ===== the list =====
// What a card shows, plus the key texts the cursor needs. posted_text is the time with its microseconds.
export const LIST =
  "job.id, job.title, job.employer_name, job.county, job.salary_low, job.salary_high, job.pay_grade, job.pass_route, job.badge, job.quota_full, " +
  "job.posted_at, job.posted_at::text as posted_text, job.sponsor_sort, job.salary_sort, s.last_ok_at";
export const SOURCE = "left join job_source s on s.id = job.job_source_id"; // "last checked" is the source's last good fetch
export const LIVE = "job.status = 'live' and job.closes_at > now()"; // the one visibility rule; 'infinity' passes

type Query = { text: string; values: unknown[] };
/** A page size a caller may ask for: 1 to PAGE_SIZE. A visitor gets fewer (public-read.ts, #46). */
export const pageSize = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= PAGE_SIZE;

/**
 * One page: the first page (with the capped count from the same index walk), or the page after or before a cursor.
 * Fetches one row more than a page, to know whether there is a further page.
 */
export function listQuery(sort: Sort, cursor?: Cursor, dir: "after" | "before" = "after", filters: SearchFilters = {}, size = PAGE_SIZE): Query {
  if (!pageSize(size)) throw new BadSearchInput("bad page size"); // written into the text, so only a whole number from 1 to PAGE_SIZE
  const keys = KEYS[sort].map((k) => k.col);
  const desc = (d: string) => ["(not job.quota_full)", ...keys.map((k) => `job.${k}`), "job.id"].map((c) => `${c} ${d}`).join(", ");
  if (!cursor) {
    const ks = keys.map((k, i) => `${k} as k${i}`).join(", ");
    const page = keys.map((_, i) => `k${i}`);
    const values: unknown[] = [];
    const { with: kw, where } = filterSql(filters, values);
    return {
      text:
        `with ${kw && `${kw}, `}hits as materialized (select id, (not quota_full) as r, ${ks} from job where ${LIVE}${where} ` +
        `order by (not quota_full) desc, ${keys.map((k) => `${k} desc`).join(", ")}, id desc limit ${COUNT_CAP + 1}) ` +
        `select ${LIST}, (select count(*) from hits)::int as capped ` +
        `from (select id, r, ${page.join(", ")} from hits order by r desc, ${page.map((k) => `${k} desc`).join(", ")}, id desc limit ${size + 1}) page ` +
        `join job on job.id = page.id ${SOURCE} order by page.r desc, ${page.map((k) => `page.${k} desc`).join(", ")}, page.id desc`,
      values,
    };
  }
  const row = ["$1::boolean", ...KEYS[sort].map((k, i) => `$${i + 2}::${CAST[k.kind]}`), `$${keys.length + 2}::bigint`].join(", ");
  const op = dir === "after" ? "<" : ">";
  const values: unknown[] = [!cursor.quotaFull, ...cursor.keys, cursor.id];
  const { with: kw, where } = filterSql(filters, values);
  const order = `order by ${desc(dir === "after" ? "desc" : "asc")}`;
  const walk = `where ${LIVE}${where} and ((not job.quota_full), ${keys.map((k) => `job.${k}`).join(", ")}, job.id) ${op} (${row}) ${order} limit ${size + 1}`;
  // With a keyword the walk takes only ids, so it stays in the index and does not read every row it skips (a rare word skips most rows).
  const text = kw
    ? `with ${kw}, page as materialized (select job.id from job ${walk}) select ${LIST} from page join job on job.id = page.id ${SOURCE} ${order}`
    : `select ${LIST} from job ${SOURCE} ${walk}`;
  return { text, values };
}

export type ListRow = {
  id: string; title: string; employer_name: string; county: string | null; salary_low: number | null; salary_high: number | null;
  pay_grade: string | null; pass_route: string; badge: string | null; quota_full: boolean; posted_at: Date; posted_text: string;
  sponsor_sort: number; salary_sort: number; last_ok_at: Date | null; capped?: number;
};

export type JobCard = {
  id: string; title: string; employerName: string; county: string | null; salaryLow: number | null; salaryHigh: number | null;
  salaryLine: string | null; payGrade: string | null; passRoute: string; badge: string | null; quotaFull: boolean; postedAt: Date;
  /** Permits in the last 5 years when the employer has any, for "Sponsored N permits". null when none or not linked. */
  sponsorPermits: number | null;
  /** The "last checked" date: when the job's source last fetched without error. */
  lastCheckedAt: Date | null;
};
export type JobList = {
  jobs: JobCard[];
  /** A cursor for the next page, or null at the end. */
  next: string | null;
  /** A cursor for the previous page. null on the first page, and on a page reached backwards when there is no earlier one. */
  previous: string | null;
  /** First page only (carry it in the link, later pages do not count): n stops at 200, more means over 200. */
  count: { n: number; more: boolean } | null;
};

/** The salary text of a card, without "a year": the page adds the unit. A pay grade stands in when no salary is stated (#67). */
export function salaryLine(low: number | null, high: number | null, payGrade: string | null): string | null {
  const eur = (n: number) => `€${new Intl.NumberFormat("en-IE").format(n)}`;
  if (low !== null && high !== null) return low === high ? eur(low) : `${eur(low)} to ${eur(high)}`;
  if (low !== null) return `From ${eur(low)}`;
  if (high !== null) return `Up to ${eur(high)}`;
  return payGrade || null;
}

export const card = (r: ListRow): JobCard => ({
  id: r.id, title: r.title, employerName: r.employer_name, county: r.county, salaryLow: r.salary_low, salaryHigh: r.salary_high,
  salaryLine: salaryLine(r.salary_low, r.salary_high, r.pay_grade), payGrade: r.pay_grade, passRoute: r.pass_route, badge: r.badge,
  quotaFull: r.quota_full, postedAt: r.posted_at, sponsorPermits: r.sponsor_sort > 0 ? r.sponsor_sort : null, lastCheckedAt: r.last_ok_at,
});

export function cursorOf(sort: Sort, r: ListRow, f = NO_FILTERS): string {
  const value = { sponsor_sort: String(r.sponsor_sort), salary_sort: String(r.salary_sort), posted_at: r.posted_text } as Record<string, string>;
  return encodeCursor({ sort, quotaFull: r.quota_full, keys: KEYS[sort].map((k) => value[k.col]!), id: r.id }, f);
}

/**
 * Live jobs a candidate may see, sponsor history first by default (#157), narrowed by `filters` (parseSearch). At most one of `after` and
 * `before`; a cursor works only with the sort and filters it was made with. `limit` (1 to PAGE_SIZE, default PAGE_SIZE) is the page size.
 */
export async function listJobs(db: Db, opts: { sort?: Sort; after?: string; before?: string; filters?: SearchFilters; limit?: number } = {}): Promise<JobList> {
  const size = opts.limit ?? PAGE_SIZE;
  const sort = opts.sort ?? "sponsor";
  if (!SORTS.includes(sort)) throw new BadSearchInput("unknown sort");
  if (opts.after !== undefined && opts.before !== undefined) throw new BadSearchInput("after and before together");
  const filters = checkSearch(opts.filters);
  const f = filterHash(filters);
  const dir = opts.before !== undefined ? "before" : "after";
  const token = opts.after ?? opts.before;
  const { text, values } = listQuery(sort, token === undefined ? undefined : decodeCursor(sort, token, f), dir, filters, size);
  const all = (await db.query<ListRow>(text, values)).rows;
  const more = all.length > size;
  const rows = all.slice(0, size);
  if (dir === "before") rows.reverse(); // read backwards, shown forwards
  const first = rows[0];
  const last = rows.at(-1);
  const beyond = more && first && last ? cursorOf(sort, dir === "before" ? first : last, f) : null;
  return {
    jobs: rows.map(card),
    next: dir === "before" ? (last ? cursorOf(sort, last, f) : null) : beyond,
    previous: dir === "before" ? beyond : token !== undefined && first ? cursorOf(sort, first, f) : null,
    count: token === undefined ? { n: Math.min(all[0]?.capped ?? 0, COUNT_CAP), more: (all[0]?.capped ?? 0) > COUNT_CAP } : null,
  };
}

/** Each sector of ALERT_SECTORS with its live jobs (the LIVE rule), zero included, for a sector-first front page. */
export async function sectorCounts(db: Db): Promise<{ sector: Sector; jobs: number }[]> {
  const r = await db.query<{ sector: string; n: number }>(SECTOR_COUNTS);
  const n = new Map(r.rows.map((x) => [x.sector, x.n]));
  return ALERT_SECTORS.map((sector) => ({ sector, jobs: n.get(sector) ?? 0 }));
}
export const SECTOR_COUNTS = `select job.sector, count(*)::int as n from job where ${LIVE} group by job.sector`;

// ===== one job =====
const JOB =
  "select job.id, job.organisation_id, job.source, job.title, job.employer_name, job.county, job.sector, job.occupation_code, job.contract_type, " +
  "job.contract_months, job.permit_type, job.badge, job.salary_low, job.salary_high, job.health_insurance_eur, job.pay_grade, job.pass_route, " +
  "job.posted_at, job.closes_at, job.permit_history, job.application_route, job.own_page_url, job.permit_employer_kind, job.permit_employer_name, " +
  "t.advert_text, s.last_ok_at, o.slug, o.display_name, o.website, o.logo_url, o.short_description, o.kind " +
  `from job join organisation o on o.id = job.organisation_id left join job_text t on t.job_id = job.id ${SOURCE} ` +
  `where job.id = $1::bigint and ${LIVE}`;

type JobRow = {
  id: string; organisation_id: string; source: string; title: string; employer_name: string; county: string | null; sector: string | null;
  occupation_code: string | null; contract_type: string | null; contract_months: number | null; permit_type: string; badge: string | null;
  salary_low: number | null; salary_high: number | null; health_insurance_eur: number | null; pay_grade: string | null; pass_route: string;
  posted_at: Date; closes_at: Date | number; permit_history: string; application_route: string; own_page_url: string | null;
  permit_employer_kind: string | null; permit_employer_name: string | null; advert_text: string | null; last_ok_at: Date | null;
  slug: string; display_name: string; website: string | null; logo_url: string | null; short_description: string | null; kind: string;
};

export type JobPage = {
  id: string; source: string; title: string; employerName: string; county: string | null; sector: string | null; occupationCode: string | null;
  contractType: string | null; contractMonths: number | null; permitType: string; applicationRoute: string; ownPageUrl: string | null;
  permitEmployerKind: string | null; permitEmployerName: string | null;
  salaryLow: number | null; salaryHigh: number | null; salaryLine: string | null; healthInsuranceEur: number | null; payGrade: string | null; passRoute: string;
  postedAt: Date; closesAt: Date | null; // null: a fetched job has no life limit
  advertText: string | null;
  employer: { id: string; slug: string; name: string; website: string | null; logoUrl: string | null; shortDescription: string | null; kind: string };
  /** The Critical Skills badge: 'critical_skills_eligible', or 'sponsor_confirmed' on an employer's signed job, or null. */
  badge: string | null;
  /** "Sponsored {permits} permits since {since}" (#152): DETE permits of the last 5 years from a confirmed link. null when not linked or none. */
  sponsored: { permits: number; since: number } | null;
  permitHistory: string;
  lastCheckedAt: Date | null;
  /** For the standing line "Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on [date]." (#94) */
  rulesCheckedOn: string;
};

/** One live job with what its page shows, or null when the id is not a live job (queued, closed, expired, hidden, under review, unknown or not an id). */
export async function getJob(db: Db, id: string | number, now = new Date()): Promise<JobPage | null> {
  const key = String(id);
  if (!validId(key)) return null;
  const r = (await db.query<JobRow>(JOB, [key])).rows[0];
  if (!r) return null;
  const permits = await permitsLast5Years(db, r.organisation_id, now);
  // The count is the last 5 calendar years, so "since" is no earlier than the start of that window.
  const sponsored = permits && permits.permits > 0 && permits.firstYear !== null ? { permits: permits.permits, since: Math.max(permits.firstYear, now.getUTCFullYear() - 4) } : null;
  return {
    id: r.id, source: r.source, title: r.title, employerName: r.employer_name, county: r.county, sector: r.sector, occupationCode: r.occupation_code,
    contractType: r.contract_type, contractMonths: r.contract_months, permitType: r.permit_type, applicationRoute: r.application_route, ownPageUrl: r.own_page_url,
    permitEmployerKind: r.permit_employer_kind, permitEmployerName: r.permit_employer_name,
    salaryLow: r.salary_low, salaryHigh: r.salary_high, salaryLine: salaryLine(r.salary_low, r.salary_high, r.pay_grade),
    healthInsuranceEur: r.health_insurance_eur, payGrade: r.pay_grade, passRoute: r.pass_route,
    postedAt: r.posted_at, closesAt: r.closes_at instanceof Date ? r.closes_at : null,
    advertText: r.advert_text,
    employer: { id: r.organisation_id, slug: r.slug, name: r.display_name, website: r.website, logoUrl: r.logo_url, shortDescription: r.short_description, kind: r.kind },
    badge: r.badge, sponsored, permitHistory: r.permit_history, lastCheckedAt: r.last_ok_at, rulesCheckedOn: (await getRules(db)).minimums.checkedOn,
  };
}

/** The statements one job page runs, for the page budget: the job, then the DETE count. */
export const JOB_QUERY = JOB;
