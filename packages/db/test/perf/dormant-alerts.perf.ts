// Performance (C2): the daily alert run with 10,000 alerts over 2,000 candidates, half of them dormant (last active 200 days ago), and 500 new jobs.
// One client statement; pages read and median time from EXPLAIN (ANALYZE, BUFFERS) of the call, each run rolled back so every run sees the same rows.
// Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { queueAlerts } from "../../src/alerts-run-cli.ts";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured 18 Nov 2026 (three runs, the same numbers each time): median 196,895 pages (179,458 to 224,255, growing with each rolled-back run's dead rows),
// median 1,185 to 1,231 ms. Of that, the dormant pause is 75,168 pages and 69 ms (5,000 alert rows and their four indexes); the rest is the run as it
// was before C2 (the 5,000 last_sent_at stamps alone are 86,057 pages). Budgets: 1.5 times the pages, about 4 times the time. Raise only on purpose.
export const RUN_PAGES = 300_000;
export const RUN_MEDIAN_MS = 5_000;
const MON = new Date("2026-11-16T06:00:00Z");
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('perf-org', 'Fake Org', 'employer', 'verified') returning id")).rows[0].id;
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  await su.query(`insert into candidate_user(id, name, email, email_verified, created_at, updated_at, last_active_at)
    select 'perf-' || i, 'Fake', 'perf-' || i || '@example.test', true, now(), now(), case when i % 2 = 0 then $1::timestamptz - interval '200 days' else $1 end
      from generate_series(1, 2000) i`, [MON]);
  await su.query(`insert into alert(candidate_user_id, sector, frequency, unsubscribe_token, created_at)
    select 'perf-' || c, case when k % 2 = 1 then 'it' end, 'daily', 'perf-token-' || c || '-' || k || repeat('x', 30), timestamptz '2026-11-15'
      from generate_series(1, 2000) c, generate_series(0, 4) k`);
  await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, own_page_url, search_vector)
    select $1, 'admin_manual', $2, 'Fake job', 'Fake Org', 'Dublin', case when i % 2 = 0 then 'it' else 'health' end, 'critical_skills', 30000, 'live',
           timestamptz '2026-12-20', 'https://example.test/a', to_tsvector('english', 'cook')
      from generate_series(1, 500) i`, [org, src]);
  // the job trigger stamps posted_at with now() on the move into live; put it just before the run
  await su.query("update job set posted_at = timestamptz '2026-11-15T12:00:00Z' + id * interval '1 second'");
  await su.query("analyze job; analyze alert; analyze candidate_user; analyze notification_preference");
});
afterAll(() => db.drop());

it("10,000 alerts, half dormant: one statement, pages and median time inside budget, and the counts right", async () => {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  try {
    let statements = 0;
    const counting = { query: (...a: Parameters<pg.Client["query"]>) => (statements++, (c.query as (...x: unknown[]) => unknown)(...a)) } as never;
    await c.query("begin");
    const r = await queueAlerts(counting, MON);
    await c.query("rollback");
    expect(statements).toBe(1);
    expect(r).toEqual({ alerts_due: 5000, candidates_queued: 1000, rows_written: 1000, alerts_paused: 5000 });
    const runs: { pages: number; ms: number }[] = [];
    for (let i = 0; i < 6; i++) {
      await c.query("begin");
      const plan = (await c.query("explain (analyze, buffers, serialize, format json) select private.queue_job_alerts($1)", [MON])).rows[0]["QUERY PLAN"];
      await c.query("rollback");
      if (i) runs.push(costOf("queue_job_alerts", plan)); // the first is the warm-up
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const pages = median(runs.map((x) => x.pages)), ms = median(runs.map((x) => x.ms));
    console.log(`queue_job_alerts, 10,000 alerts half dormant: 1 statement, median ${ms} ms, ${pages} pages (runs ${JSON.stringify(runs)})`);
    expect(pages).toBeLessThanOrEqual(RUN_PAGES);
    expect(ms).toBeLessThanOrEqual(RUN_MEDIAN_MS);
  } finally { await c.end(); }
});
