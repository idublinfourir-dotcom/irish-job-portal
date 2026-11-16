// Performance (#93): the effective-date run's one added statement (the jobs go under review and each company is told) and the daily 30-day close,
// on a table of 100,000 jobs with 2,000 under review. Pages are counted with EXPLAIN (ANALYZE, BUFFERS) inside a rolled-back transaction, warm pass then measured pass.
// Fake data only; the email stays in the outbox.
import type { ClientBase } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { CLOSE_UNDER_REVIEW } from "../../src/job-expiry-cli.ts";
import { UNDER_REVIEW } from "../../src/rules-run-cli.ts";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 16 Nov 2026: 30,007 pages and 77 ms for the run (1,000 jobs, 200 companies), 5,111 pages and 11 ms for the close (200 jobs). Page limits are 1.5 times that, time limits about 7 times.
export const RUN_PAGES = 45000; // 1,000 jobs across 200 companies: the job update, the owners read and two inserts per company
export const ADDED_PAGES = 3000; // the notices' own cost over the plain status update of the same jobs: measured none (30,007 against 31,169), so this is room for 400 inserted rows
export const CLOSE_PAGES = 7600; // 200 due jobs found through job_under_review_idx, 1,800 others under review left alone
export const RUN_MS = 500; // measured 77 ms
export const CLOSE_MS = 150; // measured 11 ms
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) select 'u'||g,'Fake','u'||g||'@example.test',true,now() from generate_series(1,200) g");
  await su.query("insert into organisation(slug,display_name,kind,status) select 'o'||g,'Fake Org '||g,'employer','verified' from generate_series(1,200) g");
  await su.query("insert into membership(organisation_id,portal_user_id,role,status) select o.id, 'u'||row_number() over (order by o.id), 'account_owner','active' from organisation o where o.slug like 'o%'");
  await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector)
     select (select min(id) from organisation) + (g % 200), 'employer', $1, 'Fake role '||g, 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 30000 + g, 'x'
       from generate_series(1,100000) g`, [src]);
  await su.query("update job set status = 'under_review' where id in (select id from job order by id limit 2000)"); // the trigger stamps them
  await su.query("update job set under_review_since = now() - interval '31 days' where id in (select id from job where status = 'under_review' order by id limit 200)");
  await su.query("analyze job");
});
afterAll(() => db.drop());

// An update runs twice (warm, measured), each time in a transaction that is rolled back.
async function pagesOf(c: ClientBase, text: string, values: unknown[]) {
  const plans: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    await c.query("begin");
    plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${text}`, values)).rows[0]["QUERY PLAN"]);
    await c.query("rollback");
  }
  return costOf(text, plans[1]);
}

it("the effective-date run's added statement and the daily close stay inside their page and time budgets", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    const ids = (await c.query("select id from job where status = 'live' order by id limit 1000")).rows.map((r) => r.id);
    const versionId = 1; // any version id: the dedupe key holds it
    const run = await pagesOf(c, UNDER_REVIEW, [ids, versionId]);
    const plain = await pagesOf(c, "update job set status = 'under_review' where id = any($1::bigint[]) and status = 'live'", [ids]);
    expect(run.pages - plain.pages).toBeLessThanOrEqual(ADDED_PAGES);
    console.log("plain update pages", plain.pages, plain.ms, "added by the notices", run.pages - plain.pages);
    const close = await pagesOf(c, CLOSE_UNDER_REVIEW, []);
    console.log("run pages", run.pages, run.scans, run.ms, "close pages", close.pages, close.scans, close.ms);
    expect(run.pages).toBeLessThanOrEqual(RUN_PAGES);
    expect(close.pages).toBeLessThanOrEqual(CLOSE_PAGES);
    expect(close.scans).toContain("job_under_review_idx");
    for (const [text, values, limit, name] of ([[UNDER_REVIEW, [ids, versionId], RUN_MS, "run"], [CLOSE_UNDER_REVIEW, [], CLOSE_MS, "close"]] as [string, unknown[], number, string][])) {
      await c.query("begin");
      const t = performance.now();
      await c.query(text, values);
      const ms = performance.now() - t;
      await c.query("rollback");
      console.log(name, "ms", Math.round(ms));
      expect(ms).toBeLessThan(limit);
    }
  } finally {
    c.release();
  }
});
