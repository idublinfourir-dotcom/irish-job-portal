// Performance (N5): the daily rules run's floor step (every active pay floor ends and each company's owner is told, one notice and one email per floor) on
// 500 active floors across 100 companies, among 1,000 floors in all. Pages are counted with EXPLAIN (ANALYZE, BUFFERS) inside a rolled-back transaction,
// warm pass then measured pass. Fake data only; the email stays in the outbox.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { END_FLOORS } from "../../src/rules-run-cli.ts";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 18 Nov 2026 over three runs: 10,507 pages and 32 to 34 ms (500 floor updates, 500 notices, 500 emails and their indexes). Limits are about 1.5 times
// the pages and 7 times the time. Raise these only on purpose.
export const FLOOR_PAGES = 16000;
export const FLOOR_MS = 250;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const c = await db.pool("postgres").connect();
  try {
    await c.query("set session_replication_role = replica"); // fake rows straight in: the floor triggers (big company, signer, approval) are tested elsewhere
    await c.query("insert into portal_user(id,name,email,email_verified,updated_at) select 'u'||g,'Fake','u'||g||'@example.test',true,now() from generate_series(1,200) g");
    await c.query("insert into organisation(slug,display_name,kind,status,is_big_company) select 'o'||g,'Fake Org '||g,'employer','verified',true from generate_series(1,100) g");
    await c.query("insert into membership(organisation_id,portal_user_id,role,status,is_signer) select o.id, 'u'||row_number() over (order by o.id), 'account_owner','active',true from organisation o where o.slug like 'o%'");
    await c.query("insert into membership(organisation_id,portal_user_id,role,status,is_signer) select o.id, 'u'||(100 + row_number() over (order by o.id)), 'recruiter','active',true from organisation o where o.slug like 'o%'");
    const text = (await c.query("insert into consent_text(purpose,version,body) values ('pay_floor','perf','Fake wording') returning id")).rows[0].id;
    await c.query("insert into staff_user(id,name,email,email_verified,created_at,updated_at) select 's'||g,'Fake Staff','s'||g||'@example.test',true,now(),now() from generate_series(1,2) g");
    const req = (await c.query("insert into approval_request(kind,target_table,target_id,status,proposed_by_staff_user_id,confirmed_by_staff_user_id,decided_at,applied_at) values ('pay_floor','pay_floor','0','confirmed','s1','s2',now(),now()) returning id")).rows[0].id;
    await c.query(
      `insert into pay_floor(organisation_id,role_family,floor_eur,consent_text_id,signer_membership_id,valid_until,status,approval_request_id)
       select m.organisation_id, (2100 + g)::text, 50000, $1, m.id, now() + interval '200 days', case when g <= 5 then 'active' else 'replaced' end, $2
         from membership m cross join generate_series(1,10) g where m.role = 'account_owner'`, [text, req]);
    await c.query("analyze pay_floor; analyze membership");
  } finally {
    await c.query("reset session_replication_role");
    c.release();
  }
});
afterAll(() => db.drop());

it("the floor step on 500 active floors stays inside its page and time budgets", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    expect((await c.query("select count(*)::int n from pay_floor where status = 'active'")).rows[0].n).toBe(500);
    const plans: unknown[] = [];
    for (let pass = 0; pass < 2; pass++) {
      await c.query("begin");
      plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${END_FLOORS}`, [1])).rows[0]["QUERY PLAN"]);
      await c.query("rollback");
    }
    const cost = costOf(END_FLOORS, plans[1]);
    const t = performance.now();
    const n = (await c.query(END_FLOORS, [1])).rows[0].n; // the measured run is kept, so the rows it wrote can be counted
    const ms = performance.now() - t;
    const written = (await db.pool("postgres").query("select (select count(*) from notification where template_key = 'pay_floor_expired')::int + (select count(*) from email_outbox where template = 'pay_floor_expired')::int as n")).rows[0].n;
    console.log("floor step pages", cost.pages, cost.scans, "ms", Math.round(ms));
    expect([n, written]).toEqual([500, 1000]);
    expect(cost.pages).toBeLessThanOrEqual(FLOOR_PAGES);
    expect(ms).toBeLessThan(FLOOR_MS);
  } finally {
    c.release();
  }
});
