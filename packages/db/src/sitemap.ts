// S13 (#92): the sitemap read, run as app_candidate. Only what has a public page: live jobs (the LIVE rule of the job list, so never a draft,
// in-review, under-review, hidden, closed or expired job), the companies getCompanyPage shows (not rejected, closed or merged away) and the occupations
// on the rules' lists (getOccupationPage). sitemaps.org/protocol.html: at most 50,000 URLs and 50 MB a file, so each kind is cut into parts of
// SITEMAP_URLS, named `<kind>-<n>` for Next's generateSitemaps. A job's lastModified is posted_at: the table keeps no other change time.
// Step 16 (B21) adds the pages that are not jobs: `pages-0` (the static pages and the legal texts in force), `guides-0` and `help-0` (each content
// page by its change time; an update has no page of its own, the feed /updates is a static page), and a sitemap index (sitemaps.org: a file that lists the files), which Next's generateSitemaps does not make. A company's
// lastModified is its newest live job or its last claim or claim removal (the columns app_candidate may read); an occupation's is its text block's, when it has one.
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
  companies:
    `select o.slug as key, greatest(j.newest, o.claimed_at, o.claims_removed_at) as modified from organisation o ` +
    `left join (select organisation_id, max(posted_at) as newest from job where ${LIVE} group by organisation_id) j on j.organisation_id = o.id ` +
    `where ${COMPANY_PAGE} order by o.id limit ${SITEMAP_URLS} offset $1`,
  occupationTexts: "select slug as key, updated_at as modified from published_content_page where kind = 'occupation'",
  content: `select slug as key, updated_at as modified from published_content_page where kind = $1 order by id limit ${SITEMAP_URLS}`,
  legal: "select purpose as key, max(published_at) as modified from consent_text where purpose = any($1::text[]) group by purpose order by purpose",
};
/** The pages with no data behind them (`page` entries); paths.ts says where each lives. */
/** The legal texts that have a public page on the candidate site (privacy, terms, cookies, employer acceptable use, data retention; frame C22). */
export const LEGAL_PAGES = ["privacy_notice", "signup_terms", "cookie_policy", "employer_acceptable_use", "data_retention"];
// "companies" (the directory, C13) joins this list when its page is built (B25, B26); until then its address answers 404.
export const STATIC_PAGES = ["home", "jobs", "guides", "updates", "help", "eligibility-checker", "permit-services"] as const;
// The part ids of the content kinds. ponytail: one part each (a few hundred pages at most); cut like jobs when one kind nears SITEMAP_URLS.
const CONTENT_PARTS = { guides: "guide", help: "help" } as const;
/** `title` and `county` only on a job: its address is made from them and the id (#288). `legal` keys are consent purposes, `page` keys are in STATIC_PAGES. */
export type SitemapEntry = { kind: "job" | "company" | "occupation" | "page" | "legal" | "guide" | "help"; key: string; title?: string; county?: string | null; lastModified?: string };

export const partIds = (kind: string, n: number) => Array.from({ length: Math.max(1, Math.ceil(n / SITEMAP_URLS)) }, (_, i) => `${kind}-${i}`);
const occupationCodes = async (db: Db) => [...new Set((await getRules(db)).occupationLists.map((e) => e.code))].sort();

/** The ids of every sitemap file: jobs-0.., companies-0.., occupations-0.., pages-0, guides-0, help-0 (one part each at least, so the files never move). */
export async function sitemapIds(db: Db): Promise<string[]> {
  const [c, codes] = await Promise.all([db.query<{ jobs: number; companies: number }>(SITEMAP_QUERIES.counts), occupationCodes(db)]);
  return [...partIds("jobs", c.rows[0]!.jobs), ...partIds("companies", c.rows[0]!.companies), ...partIds("occupations", codes.length), "pages-0", "guides-0", "help-0"];
}

const modified = (d: Date | null) => (d ? { lastModified: d.toISOString() } : {});
type Timed = { key: string; modified: Date | null };

/** One sitemap file's entries, or null for an id that is not one (Next answers 404 for those before this runs; this is the second wall). */
export async function sitemapPart(db: Db, id: string): Promise<SitemapEntry[] | null> {
  const m = /^(jobs|companies|occupations|pages|guides|help)-([0-9]{1,4})$/.exec(id);
  if (!m) return null;
  const kind = m[1]!, n = Number(m[2]);
  const offset = n * SITEMAP_URLS;
  if (kind === "pages") {
    if (n !== 0) return [];
    const legal = (await db.query<Timed>(SITEMAP_QUERIES.legal, [LEGAL_PAGES])).rows;
    return [...STATIC_PAGES.map((key) => ({ kind: "page" as const, key })), ...legal.map((r) => ({ kind: "legal" as const, key: r.key, ...modified(r.modified) }))];
  }
  if (kind in CONTENT_PARTS) {
    if (n !== 0) return [];
    return (await db.query<Timed>(SITEMAP_QUERIES.content, [CONTENT_PARTS[kind as keyof typeof CONTENT_PARTS]])).rows.map((r) => ({ kind: CONTENT_PARTS[kind as keyof typeof CONTENT_PARTS], key: r.key, ...modified(r.modified) }));
  }
  if (kind === "occupations") {
    const texts = new Map((await db.query<Timed>(SITEMAP_QUERIES.occupationTexts)).rows.map((r) => [r.key, r.modified]));
    return (await occupationCodes(db)).slice(offset, offset + SITEMAP_URLS).map((key) => ({ kind: "occupation", key, ...modified(texts.get(key) ?? null) }));
  }
  if (kind === "companies") return (await db.query<Timed>(SITEMAP_QUERIES.companies, [offset])).rows.map((r) => ({ kind: "company", key: r.key, ...modified(r.modified) }));
  const rows = (await db.query<{ key: string; title: string; county: string | null; posted_at: Date }>(SITEMAP_QUERIES.jobs, [offset])).rows;
  return rows.map((r) => ({ kind: "job", key: r.key, title: r.title, county: r.county, lastModified: r.posted_at.toISOString() }));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The sitemap index (sitemaps.org/protocol.html#index): lists every file of sitemapIds at `<origin>/sitemap/<id>.xml`, where Next serves them. */
export const sitemapIndexXml = (origin: string, ids: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  ids.map((id) => `<sitemap><loc>${esc(`${origin}/sitemap/${id}.xml`)}</loc></sitemap>\n`).join("") + `</sitemapindex>\n`;
