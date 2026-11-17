// Performance (step 15 Q1, #244): the held-job queue statements on 40,000 decided items and 2,000 open ones over 20,000 employer and agency jobs. Pages are
// counted with EXPLAIN (ANALYZE, BUFFERS) inside a rolled-back transaction, warm pass then measured pass, as app_admin. The route test
// (employer-jobs-route.test.ts) holds the statement counts and the median times through the real handler. Fake data only.
import type { ClientBase } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { JOBQ_APPROVE, JOBQ_CLOSE, JOBQ_FIRST, JOBQ_ITEM, JOBQ_LOCK, JOBQ_REJECT } from "../../src/job-queues.ts";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 17 Nov 2026, three runs, the same pages each time: list 136 (a page of 20 on review_item_queue_idx), item 39, lock 24, approve 107, reject 40,
// close 35; wall time 0.8 to 2.5 ms each. Page limits are 1.5 times that; the time limit is 10 ms for each statement, about 4 times the slowest.
const PAGES: Record<string, number> = { list: 204, item: 59, lock: 36, approve: 161, reject: 60, close: 53 };
const MS = 10;
let db: TestDb;
let item: string, job: string, staff: string;
beforeAll(async () => {
  db = await createTestDb();
  const c = await db.pool("postgres").connect();
  try {
    await c.query("set session_replication_role = replica"); // the set-up only: no triggers, so the items are exactly the ones written here
    const src = (await c.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
    await c.query("insert into organisation(slug,display_name,kind,status) select 'o'||g,'Fake Org '||g,'agency','verified' from generate_series(1,200) g");
    await c.query(
      `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector,permit_employer_kind,permit_employer_name,permit_employer_check)
       select (select min(id) from organisation) + (g % 200), 'agency', $1, 'Fake role '||g, 'Fake', 'IT', 'critical_skills', case when g <= 2000 then 'in_review' else 'live' end,
         now() + interval '20 days', 'https://example.test', 60000, 'x', 'client', 'Fake Client '||g, 'not_found' from generate_series(1,20000) g`, [src]);
    await c.query(
      `insert into review_item(queue, job_id, reason, status, outcome, decided_at, created_at)
       select q, j.id, 'fake', 'done', 'approved', now() - interval '10 days', now() - interval '11 days' from job j cross join (values ('agency_client_check'), ('scam_flag')) v(q) where j.status = 'live'`);
    await c.query("insert into review_item(queue, job_id, reason, created_at) select 'agency_client_check', id, 'client not found in DETE', now() - (id || ' seconds')::interval from job where status = 'in_review'");
    staff = "perf-staff";
    await c.query("insert into staff_user(id,name,email,email_verified,created_at,updated_at) values ($1,'Fake Staff','perf@example.test',true,now(),now())", [staff]);
    ({ id: item, job_id: job } = (await c.query("select id::text, job_id::text from review_item where status = 'open' order by created_at, id limit 1")).rows[0]);
    await c.query("update review_item set status = 'claimed', claimed_by_staff_user_id = $2, claimed_at = now() where id = $1", [item, staff]);
    await c.query("analyze job; analyze review_item; analyze organisation");
  } finally {
    c.release();
  }
});
afterAll(() => db.drop());

async function pagesOf(c: ClientBase, text: string, values: unknown[], pre: [string, unknown[]][] = []) {
  const plans: unknown[] = [];
  let ms = 0;
  for (let pass = 0; pass < 2; pass++) {
    await c.query("begin");
    for (const [t, v] of pre) await c.query(t, v);
    const t = performance.now();
    plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${text}`, values)).rows[0]["QUERY PLAN"]);
    ms = performance.now() - t;
    await c.query("rollback");
  }
  return { ...costOf(text, plans[1]), wall: ms };
}

it("the list, the item, the lock, approve and reject stay inside their page and time budgets", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    const acting: [string, unknown[]][] = [["select set_config('app.staff_user_id', $1, true)", [staff]]];
    const got = {
      list: await pagesOf(c, JOBQ_FIRST, ["agency_client_check"]),
      item: await pagesOf(c, JOBQ_ITEM, [item]),
      lock: await pagesOf(c, JOBQ_LOCK, [item]),
      approve: await pagesOf(c, JOBQ_APPROVE, [job, item, staff, "agency_client_check.approve"], acting),
      reject: await pagesOf(c, JOBQ_REJECT, [job, item, staff, "agency_client_check.reject", "fake_client"], acting),
      close: await pagesOf(c, JOBQ_CLOSE, [job]),
    };
    for (const [k, v] of Object.entries(got)) console.log(k, "pages", v.pages, "ms", Math.round(v.wall * 100) / 100, v.scans);
    expect(got.list.scans).toContain("review_item_queue_idx");
    for (const [k, v] of Object.entries(got)) {
      expect(v.pages, k).toBeLessThanOrEqual(PAGES[k]!);
      expect(v.wall, k).toBeLessThan(MS);
    }
  } finally {
    c.release();
  }
});
