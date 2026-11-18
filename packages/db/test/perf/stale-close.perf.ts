// Performance: the daily stale-board close (packages/fetcher/src/store.ts CLOSE_STALE) on 100,000 fetched adverts of 40 good boards (20,000
// live jobs) plus 7 boards with no good fetch for 10 days (280 live jobs). Two numbers: the day it closes the 280, and every later day (nothing
// to close), which is the daily cost. Fake data only. The writes are rolled back.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { CLOSE_STALE } from "../../../fetcher/src/store";
import { assertPageBudget, costOf, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 18 Nov 2026: the closing day 8,005 pages for 280 jobs (about 29 a job: writing the job, its text, its advert and their
// indexes); later days 760 (the adverts of the stale boards by index, and one pass over job, 710 pages for 20,280 jobs, which the planner
// picks for so few rows; ponytail: it grows with the job table, about 3.5 pages per 100 jobs; add an index on live fetched jobs by advert if it hurts).
export const STALE_CLOSE_PAGES_PER_JOB = 60;
export const STALE_DAILY_PAGES = 1_500;
const NOW = new Date("2026-11-25T05:17:00Z");
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into organisation(slug, display_name, kind) values ('stale-perf', 'Stale Perf Ltd', 'employer')");
  await su.query("insert into job_source(kind, board, last_ok_at) select 'board', 'b'||g, $1 from generate_series(1,40) g", [NOW]);
  await su.query("insert into job_source(kind, board, last_ok_at) select 'workday', 'w'||g, $1::timestamptz - interval '10 days' from generate_series(1,7) g", [NOW]);
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select s.id, s.board || ':' || g, 'passed' from job_source s, generate_series(1, 2500) g where s.kind = 'board'");
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select s.id, s.board || ':' || g, 'passed' from job_source s, generate_series(1, 40) g where s.kind = 'workday'");
  await su.query(
    "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, badge, status, closes_at, search_vector, own_page_url) " +
      "select (select id from organisation where slug = 'stale-perf'), 'fetched', f.job_source_id, f.id, 'Engineer', 'Stale Perf Ltd', 'IT', 'critical_skills', 'critical_skills_eligible', 'live', 'infinity', to_tsvector('english', 'engineer'), 'https://jobs.example.test/' || f.id " +
      "from fetched_advert f join job_source s on s.id = f.job_source_id where s.kind = 'workday' or f.id % 5 = 0",
  );
  await su.query("insert into job_text(job_id, advert_text) select id, 'We build fake things.' from job");
  await su.query("analyze job_source, fetched_advert, job, job_text");
});
afterAll(() => db.drop());

it("the stale close stays within its page budgets: the closing day and every later day", async () => {
  const c = await db.pool("app_fetcher").connect();
  try {
    await c.query("select count(*) from job where status = 'live'"); // warm the connection's catalog caches
    await c.query("begin");
    const first = costOf(CLOSE_STALE, (await c.query(`explain (analyze, buffers, serialize, format json) ${CLOSE_STALE}`, [NOW, 7])).rows[0]["QUERY PLAN"]);
    const [later] = await measurePages(c, [{ text: CLOSE_STALE, values: [NOW, 7] }]);
    console.log("stale close: closing day", first.pages, first.scans, first.ms, "| later days", later!.pages, later!.scans, later!.ms);
    expect(Number((await c.query("select count(*) from job where close_reason = 'source_stale'")).rows[0].count)).toBe(280);
    assertPageBudget("stale close, closing day", [first], 280 * STALE_CLOSE_PAGES_PER_JOB);
    assertPageBudget("stale close, later days", [later!], STALE_DAILY_PAGES);
  } finally {
    await c.query("rollback");
    c.release();
  }
});
