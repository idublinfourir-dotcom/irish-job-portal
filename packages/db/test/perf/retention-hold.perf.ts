// Performance (R3, R4, migration 0041): one run_retention call with 2,000 deleted candidates whose erasure an open case holds and 20,000 audit rows past
// the period. The first call writes the 2,000 deletion_on_hold notices and emails and deletes one batch of 1,000 audit rows; a later call finds every
// notice written and only deletes. Pages and median time from EXPLAIN (ANALYZE, BUFFERS) of the call, each run rolled back. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured 18 Nov 2026 (three runs, pages the same each time): first call 73,051 pages, median 102 to 115 ms; later call 4,115 pages, 28 to 35 ms.
// Budgets: 1.5 times the pages, about 4 times the time. Raise only on purpose.
export const FIRST = { pages: 110_000, ms: 500 };
export const LATER = { pages: 6_200, ms: 150 };
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query(`insert into candidate_user(id, name, email, email_verified, created_at, updated_at, deleted_at)
    select 'held-' || i, 'Fake', 'held-' || i || '@example.test', true, now(), now(), now() - interval '40 days' from generate_series(1, 2000) i`);
  const text = (await su.query("insert into consent_text(purpose, version, body) values ('application', 'perf-v1', 'Fake wording') returning id")).rows[0].id;
  await su.query("insert into consent_record(candidate_user_id, consent_text_id) select 'held-' || i, $1 from generate_series(1, 2000) i", [text]);
  await su.query("insert into services_case(candidate_user_id, permit_type, payer, consent_record_id) select candidate_user_id, 'critical_skills', 'employer', id from consent_record");
  await su.query(`insert into audit_event(kind, actor_system, action, at, source) select 'admin_action', 'fake', 'fake.old', now() - interval '25 months' - i * interval '1 second', 'scheduled_job'
    from generate_series(1, 20000) i`);
  await su.query("analyze candidate_user; analyze services_case; analyze audit_event; analyze notification; analyze email_outbox");
});
afterAll(() => db.drop());

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function measure(c: pg.Client, runs = 4) {
  const out: { pages: number; ms: number }[] = [];
  for (let i = 0; i < runs; i++) {
    await c.query("begin");
    const plan = (await c.query("explain (analyze, buffers, serialize, format json) select private.run_retention(1000)")).rows[0]["QUERY PLAN"];
    await c.query("rollback");
    if (i) out.push(costOf("run_retention", plan)); // the first is the warm-up
  }
  return { pages: median(out.map((x) => x.pages)), ms: median(out.map((x) => x.ms)), out };
}

it("2,000 held candidates and 20,000 old audit rows: the first call and a later one inside budget, with the right counts", async () => {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  try {
    const first = await measure(c);
    await c.query("begin");
    const r = (await c.query("select private.run_retention(1000) r")).rows[0].r;
    expect(r).toMatchObject({ rule: "audit_event", done: 1000, left: 19000 });
    expect((await c.query("select count(*)::int n from email_outbox where template = 'deletion_on_hold'")).rows[0].n).toBe(2000);
    await c.query("commit");
    const later = await measure(c);
    console.log(`run_retention: first call median ${first.ms} ms, ${first.pages} pages; later call median ${later.ms} ms, ${later.pages} pages`);
    expect(first.pages).toBeLessThanOrEqual(FIRST.pages);
    expect(first.ms).toBeLessThanOrEqual(FIRST.ms);
    expect(later.pages).toBeLessThanOrEqual(LATER.pages);
    expect(later.ms).toBeLessThanOrEqual(LATER.ms);
  } finally { await c.end(); }
});
