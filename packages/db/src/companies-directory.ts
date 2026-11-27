// B25 (C13): the companies directory, run as app_candidate. Every company getCompanyPage shows (not rejected, closed or merged away), by display name,
// keyset paged; a search by any of its names (legal or alias) on organisation_name's trigram index. One statement a page: the page's live job count and
// its permits since 2019 are subqueries on the page's rows only (job_company_page_idx, dete_permit_count by name), never a query a company.
import type pg from "pg";
import { BadSearchInput, employerLabels, LIVE, type CompanyLabel } from "./search";
import { FIRST_PERMIT_YEAR } from "./dete";
import { normaliseCompanyName } from "./registers";

type Db = Pick<pg.Pool, "query">;
export const DIRECTORY_PAGE = 20;
export const DIRECTORY_SEARCH_MAX = 100;
export const CLAIMED_LABEL = "Claimed";

// A year with a yearly total uses it, else its months are added (summarisePermits). null: no DETE name linked, as on the company page.
const PERMITS_SINCE =
  "(select case when count(*) = 0 then null else coalesce(sum(y.permits) filter (where y.year >= " + FIRST_PERMIT_YEAR + "), 0) end::int from (" +
  "select d.year, case when bool_or(d.month is null) then sum(d.permits) filter (where d.month is null) else sum(d.permits) end as permits " +
  "from organisation_name n join dete_permit_count d on d.organisation_name_id = n.id where n.organisation_id = p.id group by d.year) y)";
export const DIRECTORY_QUERY =
  "with p as (select o.id, o.slug, o.display_name, o.county, o.status, o.permit_history, o.claimed_at, o.claims_removed_at from organisation o " +
  "where o.status not in ('rejected', 'closed') and o.merged_into_id is null " +
  "and ($1::text is null or o.id in (select n.organisation_id from organisation_name n where n.normalised_name like '%' || $1 || '%')) " +
  "and ($2::text is null or (o.display_name, o.id) > ($2::text, $3::bigint)) order by o.display_name, o.id limit $4) " +
  `select p.id::text, p.slug, p.display_name, p.county, p.status, p.permit_history, p.claimed_at, p.claims_removed_at, ` +
  `(select count(*) from job where ${LIVE} and job.organisation_id = p.id)::int as live_jobs, ${PERMITS_SINCE} as permits ` +
  "from p order by p.display_name, p.id";

type Row = {
  id: string; slug: string; display_name: string; county: string | null; status: string; permit_history: string; claimed_at: Date | null;
  claims_removed_at: Date | null; live_jobs: number; permits: number | null;
};
export type DirectoryCompany = {
  slug: string; name: string; initials: string; county: string | null; labels: (CompanyLabel | typeof CLAIMED_LABEL)[]; permitsSince2019: number | null; liveJobs: number;
};
export type Directory = { companies: DirectoryCompany[]; next: string | null };

/** The first letters of the first two words with a letter or digit ("Northquay Hospital Group" gives "NH"). */
export const initials = (name: string) =>
  (name.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join("") || "?";

const encode = (name: string, id: string) => Buffer.from(JSON.stringify([name, id])).toString("base64url");
export function decodeDirectoryCursor(after: string): [string, string] {
  if (after.length <= 1000) try {
    const v: unknown = JSON.parse(Buffer.from(after, "base64url").toString());
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && v[0].length <= 500 && typeof v[1] === "string" && /^[0-9]{1,18}$/.test(v[1])) return [v[0], v[1]];
  } catch { /* falls through */ }
  throw new BadSearchInput("bad cursor");
}

/** `q`: a company or legal name, compared as normaliseCompanyName keys, so `%`, `_` and quotes are never pattern characters. BadSearchInput on a long q or bad cursor. */
export async function listCompanies(db: Db, opts: { q?: string; after?: string; limit?: number } = {}): Promise<Directory> {
  const limit = opts.limit ?? DIRECTORY_PAGE;
  if ((opts.q?.length ?? 0) > DIRECTORY_SEARCH_MAX) throw new BadSearchInput("search too long");
  const key = opts.q?.trim() ? normaliseCompanyName(opts.q) : "";
  if (opts.q?.trim() && !key) return { companies: [], next: null }; // only signs or letters no name key has ("%", "日本")
  const [name, id] = opts.after ? decodeDirectoryCursor(opts.after) : [null, null];
  const rows = (await db.query<Row>(DIRECTORY_QUERY, [key || null, name, id, limit + 1])).rows;
  const shown = rows.slice(0, limit), last = shown.at(-1);
  return {
    companies: shown.map((r) => ({
      slug: r.slug, name: r.display_name, initials: initials(r.display_name), county: r.county,
      labels: [...(r.claimed_at !== null && (r.status === "verified" || r.status === "verified_restricted") ? [CLAIMED_LABEL as typeof CLAIMED_LABEL] : []), ...employerLabels(r.permit_history, r.claims_removed_at)],
      permitsSince2019: r.permits, liveJobs: r.live_jobs,
    })),
    next: rows.length > limit && last ? encode(last.display_name, last.id) : null,
  };
}
