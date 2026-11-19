// Performance: the S13 sitemap read (src/sitemap.ts) on a realistic table, as app_candidate: 10,000 jobs, most of them closed (8,500 closed, 500 of the
// other hidden statuses, 100 live but expired, 900 live) and 3,000 companies (a tenth rejected, closed or merged). The ids (one count statement)
// and the first part of jobs and of companies are each counted in 8 kB pages (planning, execution and serialisation) and in time, warm.
// A change that pushes a read over its budget is fixed in the query, not in the budget. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import { createTestDb, urlFor, type TestDb } from "../db";
import { SITEMAP_QUERIES } from "../../src/sitemap";
import { assertPageBudget, measurePages, type PageCost, type Statement } from "./pages";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
// Measured on 19 Nov 2026 (printed by the test): counts 83, jobs-0 39, companies-0 250 pages. Each budget is about 3 times the measure.
// A part lists every row it names, so its cost grows with the rows (about 0.04 pages a live job, 0.09 a company); the budget catches a plan that
// reads the closed jobs or the whole table more than once, not the growth itself.
export const COUNTS_PAGES = 250;
export const JOBS_PAGES = 120;
export const COMPANIES_PAGES = 750;
export const MS_LIMIT = 150;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const k = new pg.Client({ connectionString: urlFor(db.name) });
  await k.connect();
  try {
    await db.pool("portal_owner").query("alter table job set (autovacuum_enabled = false)");
    await k.query("set session_replication_role = replica"); // as fill.ts: triggers off for the load; the CHECKs still hold
    await k.query("insert into job_source(kind, board) values ('portal', 'perf-sitemap')");
    await k.query(`insert into organisation(slug, display_name, kind, status) select 'perf-co-' || g, 'Perf Co ' || g, 'employer',
      case when g % 30 = 0 then 'rejected' when g % 30 = 1 then 'closed' else 'verified' end from generate_series(1, 3000) g`);
    await k.query("update organisation set merged_into_id = 2 where id % 30 = 2 and id > 2");
    await k.query(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, status, close_reason, closed_at, hidden_reason, under_review_reason, closes_at, own_page_url, search_vector, posted_at)
       select 1 + (g % 3000), 'admin_manual', (select id from job_source limit 1), 'Perf job ' || g, 'Perf Co', 'it', '2136', 'critical_skills', 'critical_skills_eligible', s,
              case when s = 'closed' then 'closed' end, case when s = 'closed' then now() - interval '30 days' end, case when s = 'hidden' then 'admin' end, case when s = 'under_review' then 'NEEDS_REVIEW' end,
              case when g % 10 = 9 and s = 'live' then now() - interval '1 day' else now() + interval '20 days' end, 'https://example.test/a', to_tsvector('english', 'perf'), now() - (g || ' minutes')::interval
       from generate_series(1, 10000) g,
            lateral (select case when g <= 1000 then 'live' when g <= 1100 then 'draft' when g <= 1200 then 'in_review' when g <= 1350 then 'under_review' when g <= 1500 then 'hidden' else 'closed' end as s) x`);
  } finally {
    await k.end();
  }
  await db.pool("portal_owner").query("vacuum (analyze)");
});
afterAll(() => db.drop());

const show = (name: string, costs: PageCost[]) =>
  console.log(`${name}: ${costs.reduce((n, c) => n + c.pages, 0)} pages, ${costs.reduce((n, c) => n + c.ms, 0).toFixed(2)} ms (${costs.map((c) => c.scans).join(" | ")})`);

it("the sitemap ids and each first part stay under their page and time budgets", async () => {
  const c = await db.pool("app_candidate").connect();
  try {
    const live = (await c.query(SITEMAP_QUERIES.jobs, [0])).rows.length;
    expect(live).toBe(900); // 1,000 live, 100 of them expired; nothing else
    const page = async (name: string, statements: Statement[], budget: number) => {
      const costs = await measurePages(c, statements);
      show(name, costs);
      assertPageBudget(name, costs, budget);
      expect(costs.reduce((n, x) => n + x.ms, 0), `${name} time`).toBeLessThan(MS_LIMIT);
    };
    await page("sitemap ids (counts)", [SITEMAP_QUERIES.counts], COUNTS_PAGES);
    await page("sitemap jobs-0", [{ text: SITEMAP_QUERIES.jobs, values: [0] }], JOBS_PAGES);
    await page("sitemap companies-0", [{ text: SITEMAP_QUERIES.companies, values: [0] }], COMPANIES_PAGES);
  } finally {
    c.release();
  }
});
