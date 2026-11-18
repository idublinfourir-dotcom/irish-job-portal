// Performance: the #257 sector backfill (src/sector-backfill-cli.ts) on 20,000 jobs, 2,000 of them "other" with a care or hospitality code,
// within a page and time budget. Fake data only. The apply writes, so it runs once (a second run would move nothing) in a transaction that is
// rolled back, after a warm dry run on the same connection.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { APPLY, COUNT, PARAMS } from "../../src/sector-backfill-cli.ts";
import { assertPageBudget, costOf, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const JOBS = 20_000, MOVED = 2_000;
// Measured on 18 Nov 2026: the dry run 692 pages (one sequential read of job), 7 ms; the apply 83,262 pages (about 42 a moved row: writing each
// row with its indexes and the per-row triggers, job_guard and the deferred sponsor check, as the Workday move's 44), 141 ms.
// Budgets: 1,500 pages for the dry run; 60 pages a moved row (the Workday move's budget) and 2 s for the apply.
export const COUNT_PAGES = 1_500, APPLY_PAGES = MOVED * 60, APPLY_MS = 2_000;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into organisation(slug, display_name, kind) values ('sector-perf', 'Sector Perf Ltd', 'employer')");
  await su.query("insert into job_source(kind, board) values ('portal', 'sector-perf')");
  await su.query(
    "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, status, closes_at, close_reason, own_page_url, search_vector) " +
      "select (select id from organisation where slug = 'sector-perf'), 'admin_manual', (select id from job_source where board = 'sector-perf'), 'Fake job ' || g, 'Sector Perf Ltd', " +
      "case when g % 10 = 0 then 'other' else (array['IT','health','finance','other'])[1 + g % 4] end, " +
      "case when g % 10 = 0 then (array['6145','6146','5434','9273','1221'])[1 + (g / 10) % 5] else (array['2136','2231','2421','3542'])[1 + g % 4] end, " +
      "'critical_skills', case when g % 3 = 0 then 'closed' else 'live' end, now() + interval '20 days', case when g % 3 = 0 then 'closed' end, 'https://example.test/' || g, to_tsvector('english', 'fake job') " +
      `from generate_series(1, ${JOBS}) g`,
  );
  await su.query("analyze job");
});
afterAll(() => db.drop());

it("the dry run and the apply stay within the page and time budget on 20,000 jobs", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    const [count] = await measurePages(c, [{ text: COUNT, values: PARAMS }]);
    console.log("sector backfill dry run", count!.pages, count!.scans, count!.ms);
    assertPageBudget("sector backfill dry run", [count!], COUNT_PAGES);
    expect((await c.query(COUNT, PARAMS)).rows.reduce((n, r) => n + r.n, 0)).toBe(MOVED);
    await c.query("begin");
    const apply = costOf(APPLY, (await c.query(`explain (analyze, buffers, serialize, format json) ${APPLY}`, PARAMS)).rows[0]["QUERY PLAN"]);
    console.log("sector backfill apply", apply.pages, apply.scans, apply.ms);
    assertPageBudget("sector backfill apply", [apply], APPLY_PAGES);
    expect(apply.ms).toBeLessThan(APPLY_MS);
    expect((await c.query(COUNT, PARAMS)).rows).toEqual([]); // the apply did move them all
  } finally {
    await c.query("rollback");
    c.release();
  }
});
