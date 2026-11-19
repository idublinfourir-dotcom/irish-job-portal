// Performance (P7): the daily pay floor sweep and re-sign reminder (job-expiry-cli.ts FLOORS_END, FLOORS_REMIND) on 5,000 floors across 100 companies:
// 1,000 active past valid_until, 500 active in their last 30 days, 2,500 active later, 1,000 replaced. Pages are counted with EXPLAIN (ANALYZE, BUFFERS)
// inside a rolled-back transaction, warm pass then measured pass; then the real run, then the second run of the same day (nothing to write). Fake data only.
import { SOC2010_CODES } from "@portal/rules";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { FLOORS_END, FLOORS_REMIND, REMIND_DAYS } from "../../src/job-expiry-cli.ts";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 19 Nov 2026 over three runs: the sweep 21,228 pages and 102 to 175 ms (1,000 floor updates, 1,000 notices, 1,000 emails and their indexes), the
// reminder 7,247 pages and 34 to 59 ms (500 of each), the second run 126 and 237 pages, 2 to 9 ms (seq scans of pay_floor, nothing written; ponytail: an index
// on active floors by valid_until if the table grows past tens of thousands). Limits are about 1.5 times the pages and 3 to 5 times the time. Raise these only on purpose.
export const BUDGET = { endPages: 32000, endMs: 600, remindPages: 11000, remindMs: 300, againPages: 400, againMs: 40 };
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const c = await db.pool("postgres").connect();
  try {
    await c.query("set session_replication_role = replica"); // fake rows straight in: the floor triggers (big company, signer, approval) are tested elsewhere
    await c.query("insert into portal_user(id,name,email,email_verified,updated_at) select 'u'||g,'Fake','u'||g||'@example.test',true,now() from generate_series(1,100) g");
    await c.query("insert into organisation(slug,display_name,kind,status,is_big_company) select 'o'||g,'Fake Org '||g,'employer','verified',true from generate_series(1,100) g");
    await c.query("insert into membership(organisation_id,portal_user_id,role,status,is_signer) select o.id, 'u'||row_number() over (order by o.id), 'account_owner','active',true from organisation o where o.slug like 'o%'");
    const text = (await c.query("insert into consent_text(purpose,version,body) values ('pay_floor','perf','Fake wording') returning id")).rows[0].id;
    await c.query("insert into staff_user(id,name,email,email_verified,created_at,updated_at) select 's'||g,'Fake Staff','s'||g||'@example.test',true,now(),now() from generate_series(1,2) g");
    const req = (await c.query("insert into approval_request(kind,target_table,target_id,status,proposed_by_staff_user_id,confirmed_by_staff_user_id,decided_at,applied_at) values ('pay_floor','pay_floor','0','confirmed','s1','s2',now(),now()) returning id")).rows[0].id;
    // 50 floors per company, each its own role family: g 1-10 passed, 11-15 in the last 30 days, 16-40 later, 41-50 replaced
    await c.query(
      `insert into pay_floor(organisation_id,role_family,floor_eur,consent_text_id,signer_membership_id,signed_at,valid_until,status,approval_request_id)
       select m.organisation_id, ($3::text[])[g], 50000, $1, m.id, now() - interval '13 months',
              now() + case when g <= 10 then interval '-1 day' when g <= 15 then interval '10 days' else interval '200 days' end,
              case when g <= 40 then 'active' else 'replaced' end, $2
         from membership m cross join generate_series(1,50) g where m.role = 'account_owner'`, [text, req, [...SOC2010_CODES].slice(0, 50)]);
    await c.query("analyze pay_floor; analyze membership; analyze notification; analyze email_outbox");
  } finally {
    await c.query("reset session_replication_role");
    c.release();
  }
});
afterAll(() => db.drop());

it("the sweep and the reminder on 5,000 floors stay inside their page and time budgets, and a second run writes nothing", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    expect((await c.query("select count(*)::int n from pay_floor")).rows[0].n).toBe(5000);
    const measure = async (sql: string, args: unknown[]) => {
      const plans: unknown[] = [];
      for (let pass = 0; pass < 2; pass++) {
        await c.query("begin");
        plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${sql}`, args)).rows[0]["QUERY PLAN"]);
        await c.query("rollback");
      }
      const t = performance.now();
      const n = (await c.query(sql, args)).rows[0].n; // the measured run is kept
      return { pages: costOf(sql, plans[1]).pages, ms: performance.now() - t, n };
    };
    const end = await measure(FLOORS_END, []);
    const remind = await measure(FLOORS_REMIND, [REMIND_DAYS]);
    const endAgain = await measure(FLOORS_END, []);
    const remindAgain = await measure(FLOORS_REMIND, [REMIND_DAYS]);
    console.log("floor sweep pages/ms", end.pages, Math.round(end.ms), "reminder", remind.pages, Math.round(remind.ms), "again", endAgain.pages, Math.round(endAgain.ms), remindAgain.pages, Math.round(remindAgain.ms));
    expect([end.n, remind.n, endAgain.n, remindAgain.n]).toEqual([1000, 500, 0, 0]);
    const written = (await db.pool("postgres").query("select (select count(*) from notification)::int + (select count(*) from email_outbox)::int as n")).rows[0].n;
    expect(written).toBe(3000); // 1,000 ended and 500 reminded, a notice and an email each
    expect(end.pages).toBeLessThanOrEqual(BUDGET.endPages);
    expect(end.ms).toBeLessThan(BUDGET.endMs);
    expect(remind.pages).toBeLessThanOrEqual(BUDGET.remindPages);
    expect(remind.ms).toBeLessThan(BUDGET.remindMs);
    for (const r of [endAgain, remindAgain]) {
      expect(r.pages).toBeLessThanOrEqual(BUDGET.againPages);
      expect(r.ms).toBeLessThan(BUDGET.againMs);
    }
  } finally {
    c.release();
  }
});
