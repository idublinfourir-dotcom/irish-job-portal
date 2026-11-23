// Performance: the content, company and occupation reads (src/content.ts, src/public-pages.ts) on a table of 40,000 live jobs, 400 companies with
// DETE rows and about 1,000 content pages (600 updates, 150 guides, 100 help pages, 120 occupation blocks), as app_candidate. Each page of the site is its statements together, counted in 8 kB pages (planning, execution and
// serialisation) and in time, warm. A change that pushes a page over its budget is fixed in the query, not in the budget. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import { createTestDb, urlFor, type TestDb } from "../db";
import { CONTENT_QUERIES } from "../../src/content";
import { COMPANY_QUERIES, PAGE_EMPLOYERS, scopedCount, scopedQuery } from "../../src/public-pages";
import { encodeCursor } from "../../src/search";
import { assertPageBudget, measurePages, type PageCost, type Statement } from "./pages";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
// Measured on 12 Nov 2026 (printed by the test); each budget is about 3 times the measure, far under the 1,000-page limit of the page gate.
export const FEED_PAGES = 250;
export const ONE_PAGES = 15;
export const COMPANY_PAGES = 500;
export const OCCUPATION_PAGES = 250;
export const MS_LIMIT = 150;
// B15, B19: the list of 150 guides or 100 help pages through the security-barrier view. Measured 23 Nov 2026: guides 40 pages, help 19; the feed with a category 86 as without.
export const LIST_PAGES = 150;
// The feed reads the view published_content_page, which is a security barrier: Postgres cannot take index order through it, so the feed reads every
// published update and keeps the newest 21 (a seq scan: about 0.08 pages a row). Fine at this size, which is far more than Launch A will publish;
// over about 3,000 pages the budget fails. The fix then is a view without security_barrier (it holds only public rows) or a function.

const JOBS = 40_000;
const ORGS = 400;
const CODES = 120; // a quarter of all jobs have the one big code 2136, the rest one of CODES codes; codes and sponsor keys are hashed so they do not line up

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const k = new pg.Client({ connectionString: urlFor(db.name) });
  await k.connect();
  try {
    await db.pool("portal_owner").query("alter table job set (autovacuum_enabled = false)"); // as the page gate: no background vacuum changes the plans mid-run
    await k.query("set session_replication_role = replica"); // as fill.ts: the load switches triggers off; the rows are still checked by their CHECKs
    await k.query("insert into job_source(kind, board) values ('portal', 'perf-content')");
    await k.query(
      `insert into organisation(slug, display_name, kind, status, permit_history, sponsor_sort) select 'perf-co-' || g, 'Perf Co ' || g, 'employer', 'verified', 'has_history', g % 50 from generate_series(1, ${ORGS}) g`);
    await k.query(
      `insert into organisation_name(organisation_id, name, normalised_name, kind, source) select g, 'Perf Co ' || g || ' Limited', 'perf co ' || g || ' limited', 'legal', 'admin' from generate_series(1, ${ORGS}) g;
       insert into organisation_name(organisation_id, name, normalised_name, kind, source) select 1 + (g % ${ORGS}), 'Perf Co ' || g || ' Branch ' || n, 'perf co ' || g || ' branch ' || n, 'alias', 'admin' from generate_series(1, ${ORGS}) g, generate_series(1, 4) n;
       insert into dete_permit_count(dete_name, organisation_name_id, year, permits) select n.name, n.id, y, 1 + (n.id % 90)::int from organisation_name n cross join generate_series(2019, 2026) y where n.kind = 'legal';`);
    await k.query(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, status, closes_at, own_page_url, search_vector, quota_full, posted_at, sponsor_sort)
       select 1 + (g % ${ORGS}), 'admin_manual', (select id from job_source limit 1), 'Perf job ' || g, 'Perf Co', 'it',
              case when abs(hashtext('a' || g)) % 4 = 0 then '2136' else (1000 + abs(hashtext('b' || g)) % ${CODES})::text end, 'critical_skills', 'critical_skills_eligible', 'live', now() + interval '20 days', 'https://example.test/a',
              to_tsvector('english', 'cook'), g % 97 = 0, now() - (g || ' minutes')::interval, abs(hashtext('c' || g)) % 50 from generate_series(1, ${JOBS}) g`);
    await k.query("update job set organisation_id = 7 where organisation_id in (8, 9)"); // company 7 is a big one: 300 live jobs, so the count runs to its cap of 200
    await k.query(
      `insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at, category, effective_from)
       select 'update', 'upd-' || g, 'Update ' || g, repeat('Fake update text. ', 20), 'https://enterprise.gov.ie/', '2026-11-01', case when g % 10 = 0 then 'withdrawn' else 'published' end, now() - (g || ' hours')::interval,
              (array['salary_minimums', 'quotas', 'occupation_lists', 'processing', null])[1 + g % 5], case when g % 3 = 0 then date '2027-01-01' end from generate_series(1, 600) g;
       insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at)
       select 'guide', 'guide-' || g, 'Guide ' || g, repeat('Fake guide text. ', 100), 'https://enterprise.gov.ie/', '2026-11-01', 'published', now() from generate_series(1, 150) g;
       insert into content_page(kind, slug, title, body, status, published_at, category) select 'help', 'help-' || g, 'Help ' || g, 'Fake help', 'published', now(),
              (array['report_problem', 'permit_services', 'jobs_badges', 'account', null])[1 + g % 5] from generate_series(1, 100) g;
       insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at) select 'occupation', (1000 + g)::text, 'Occupation ' || g, repeat('Fake text. ', 50), 'https://enterprise.gov.ie/', '2026-11-01', 'published', now() from generate_series(0, ${CODES - 1}) g;`);
  } finally {
    await k.end();
  }
  await db.pool("portal_owner").query("vacuum (analyze)"); // as the page gate: the visibility map is set, so the count reads the index alone
});
afterAll(() => db.drop());

const show = (name: string, costs: PageCost[]) =>
  console.log(`${name}: ${costs.reduce((n, c) => n + c.pages, 0)} pages, ${costs.reduce((n, c) => n + c.ms, 0).toFixed(2)} ms (${costs.map((c) => c.scans).join(" | ")})`);

it("every page of the content, company and occupation reads stays under its page budget and time budget, and uses its index", async () => {
  const c = await db.pool("app_candidate").connect();
  try {
    const page = async (name: string, statements: Statement[], budget: number, scans?: RegExp) => {
      const costs = await measurePages(c, statements);
      show(name, costs);
      assertPageBudget(name, costs, budget);
      expect(costs.reduce((n, x) => n + x.ms, 0), `${name} time`).toBeLessThan(MS_LIMIT);
      if (scans) expect(costs.map((x) => x.scans).join("|"), `${name} plan`).toMatch(scans);
    };
    const mid = (await c.query("select published_at::text t, id::text i from published_content_page where kind = 'update' order by published_at desc, published_content_page.id desc offset 300 limit 1")).rows[0];
    await page("updates feed, first page", [{ text: CONTENT_QUERIES.feedFirst, values: [null] }], FEED_PAGES);
    await page("updates feed, 300 in", [{ text: CONTENT_QUERIES.feedAfter, values: [mid.t, mid.i, null] }], FEED_PAGES);
    // B17: one category (a fifth of the updates); the same view scan, so the same budget
    await page("updates feed, one category", [{ text: CONTENT_QUERIES.feedFirst, values: ["quotas"] }], FEED_PAGES);
    await page("updates feed, one category, 300 in", [{ text: CONTENT_QUERIES.feedAfter, values: [mid.t, mid.i, "quotas"] }], FEED_PAGES);
    // B15 and B19: every guide (150) and every help page (100) in one statement each
    await page("guides list", [CONTENT_QUERIES.guides], LIST_PAGES);
    await page("help list", [CONTENT_QUERIES.helpPages], LIST_PAGES);
    await page("guide by slug", [{ text: CONTENT_QUERIES.one, values: ["guide", "guide-250"] }], ONE_PAGES);
    await page("help by slug", [{ text: CONTENT_QUERIES.one, values: ["help", "help-150"] }], ONE_PAGES);

    // the occupation page: a rare code, the big code (a quarter of the jobs), first page and a page deep in
    const deep = (await c.query("select quota_full q, sponsor_sort::text s, posted_at::text p, id::text i from job where status = 'live' and occupation_code = '2136' order by (not quota_full) desc, sponsor_sort desc, posted_at desc, id desc offset 5000 limit 1")).rows[0];
    const deepCursor = encodeCursor({ sort: "sponsor", quotaFull: deep.q, keys: [deep.s, deep.p], id: deep.i });
    // a code with a quarter of all jobs may be read through the global sponsor index instead (it finds 21 matches soon); only the rare code must use job_live_occupation
    for (const [name, code, after, scans] of [["rare code", "1050", undefined, /job_live_occupation/], ["big code (10,000 jobs)", "2136", undefined, undefined], ["big code, 5,000 in", "2136", deepCursor, undefined]] as const) {
      const q = scopedQuery("occupation", code, after);
      // B7: the page's employers (slug and logo of each card) are read in one statement for the distinct organisations of the page
      const owners = [...new Set((await c.query(q.text, q.values)).rows.slice(0, 20).map((r) => r.organisation_id as string))];
      await page(`occupation page, ${name}`, [q, { text: scopedCount("occupation"), values: [code] }, { text: PAGE_EMPLOYERS, values: [owners] }, { text: CONTENT_QUERIES.one, values: ["occupation", code] }], OCCUPATION_PAGES, scans);
    }

    // the company page: its row, names, DETE rows and one page of its jobs
    const org = (await c.query("select id::text i, slug from organisation where slug = 'perf-co-7'")).rows[0];
    await page("company page", [
      { text: COMPANY_QUERIES.org, values: [org.slug] }, { text: COMPANY_QUERIES.names, values: [org.i] }, { text: COMPANY_QUERIES.permits, values: [org.i] },
      scopedQuery("company", org.i), { text: scopedCount("company"), values: [org.i] },
    ], COMPANY_PAGES, /job_company_page_idx/);
  } finally {
    c.release();
  }
});
