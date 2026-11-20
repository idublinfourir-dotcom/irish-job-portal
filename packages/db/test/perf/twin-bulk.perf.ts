// Performance: one statement that inserts 20,000 live fetched jobs of ONE company with ONE title (the seed of stale-close.perf.ts), with the twin
// trigger on. Without a JobsIreland board, and again with one holding 3 jobs of that company and title. The trigger's work per row must not grow
// with the company's earlier same-title jobs (0065 first did: each insert walked every earlier row, 602 s for the seed). Fake data; rolled back.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 20 Nov 2026 (see the D1-A report): about 2.3 s with 0057 alone, the same with 0065 fixed. Budget: 4 times that, for a loaded machine.
const BULK_MS = 10_000;
const ROWS = 20_000;
let db: TestDb, org: string, board: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  org = (await su.query("insert into organisation(slug, display_name, kind) values ('bulk-perf', 'Bulk Perf Ltd', 'employer') returning id::text")).rows[0].id;
  board = (await su.query("insert into job_source(kind, board) values ('board', 'bulk-perf') returning id::text")).rows[0].id;
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select $1, 'bp:' || g, 'passed' from generate_series(1, $2::int) g", [board, ROWS]);
});
afterAll(() => db.drop());

const INSERT =
  "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, badge, status, closes_at, search_vector, own_page_url) " +
  "select $1, 'fetched', f.job_source_id, f.id, 'Engineer', 'Bulk Perf Ltd', 'IT', 'critical_skills', 'critical_skills_eligible', 'live', 'infinity', to_tsvector('english', 'engineer'), " +
  "'https://jobs.example.test/' || f.id from fetched_advert f where f.job_source_id = $2";

async function bulk(withJi: boolean) {
  const c = await db.pool("postgres").connect();
  try {
    await c.query("begin");
    if (withJi) {
      const ji = (await c.query("insert into job_source(kind, board) values ('jobsireland', 'bulk-perf') returning id")).rows[0].id;
      await c.query("insert into fetched_advert(job_source_id, external_id, result) select $1, 'bj:' || g, 'passed' from generate_series(1, 3) g", [ji]);
      await c.query(INSERT, [org, ji]); // 3 JobsIreland "Engineer" jobs of the company, live before the bulk insert
    }
    const t = performance.now();
    const r = await c.query(INSERT, [org, board]);
    const ms = performance.now() - t;
    console.log(`bulk insert of ${r.rowCount} same-title jobs, JobsIreland board ${withJi ? "with 3 jobs" : "none"}: ${ms.toFixed(0)} ms`);
    expect(r.rowCount).toBe(ROWS);
    expect(Number((await c.query("select count(*) from job where hidden_reason = 'duplicate'")).rows[0].count)).toBe(0);
    return ms;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

it("no JobsIreland board: 20,000 same-title inserts in one statement stay within the budget", async () => expect(await bulk(false)).toBeLessThan(BULK_MS));
it("a JobsIreland board with 3 jobs of that title: the same, and none of the 3 is hidden (20,000 matches is not one)", async () => expect(await bulk(true)).toBeLessThan(BULK_MS));
