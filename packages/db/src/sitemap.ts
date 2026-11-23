// S13 (#92): the sitemap read, run as app_candidate. Only what has a public page: live jobs (the LIVE rule of the job list, so never a draft,
// in-review, under-review, hidden, closed or expired job), the companies getCompanyPage shows (not rejected, closed or merged away) and the occupations
// on the rules' lists (getOccupationPage). sitemaps.org/protocol.html: at most 50,000 URLs and 50 MB a file, so each kind is cut into parts of
// SITEMAP_URLS, named `<kind>-<n>` for Next's generateSitemaps. A job's lastModified is posted_at: the table keeps no other change time.
import type pg from "pg";
import { getRules } from "./rules-data";
import { LIVE } from "./search";

type Db = Pick<pg.Pool, "query">;
export const SITEMAP_URLS = 50_000;
const COMPANY_PAGE = "o.status not in ('rejected', 'closed') and o.merged_into_id is null"; // public-pages.ts HIDDEN_STATUSES and the merged redirect
// ponytail: offset over the live rows, which is the whole live set at most; a keyset on id when one part's offset gets slow
export const SITEMAP_QUERIES = {
  counts: `select (select count(*) from job where ${LIVE})::int as jobs, (select count(*) from organisation o where ${COMPANY_PAGE})::int as companies`,
  jobs: `select job.id::text as key, job.title, job.county, job.posted_at from job where ${LIVE} order by job.id limit ${SITEMAP_URLS} offset $1`,
  companies: `select o.slug as key from organisation o where ${COMPANY_PAGE} order by o.id limit ${SITEMAP_URLS} offset $1`,
};
/** `title` and `county` only on a job: its address is made from them and the id (#288). */
export type SitemapEntry = { kind: "job" | "company" | "occupation"; key: string; title?: string; county?: string | null; lastModified?: string };

export const partIds = (kind: string, n: number) => Array.from({ length: Math.max(1, Math.ceil(n / SITEMAP_URLS)) }, (_, i) => `${kind}-${i}`);
const occupationCodes = async (db: Db) => [...new Set((await getRules(db)).occupationLists.map((e) => e.code))].sort();

/** The ids of every sitemap file: jobs-0.., companies-0.., occupations-0.. (one part each at least, so the files never move). */
export async function sitemapIds(db: Db): Promise<string[]> {
  const [c, codes] = await Promise.all([db.query<{ jobs: number; companies: number }>(SITEMAP_QUERIES.counts), occupationCodes(db)]);
  return [...partIds("jobs", c.rows[0]!.jobs), ...partIds("companies", c.rows[0]!.companies), ...partIds("occupations", codes.length)];
}

/** One sitemap file's entries, or null for an id that is not one (Next answers 404 for those before this runs; this is the second wall). */
export async function sitemapPart(db: Db, id: string): Promise<SitemapEntry[] | null> {
  const m = /^(jobs|companies|occupations)-([0-9]{1,4})$/.exec(id);
  if (!m) return null;
  const offset = Number(m[2]) * SITEMAP_URLS;
  if (m[1] === "occupations") return (await occupationCodes(db)).slice(offset, offset + SITEMAP_URLS).map((key) => ({ kind: "occupation", key }));
  if (m[1] === "companies") return (await db.query<{ key: string }>(SITEMAP_QUERIES.companies, [offset])).rows.map((r) => ({ kind: "company", key: r.key }));
  const rows = (await db.query<{ key: string; title: string; county: string | null; posted_at: Date }>(SITEMAP_QUERIES.jobs, [offset])).rows;
  return rows.map((r) => ({ kind: "job", key: r.key, title: r.title, county: r.county, lastModified: r.posted_at.toISOString() }));
}
