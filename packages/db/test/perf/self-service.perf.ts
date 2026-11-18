// Performance (R1): the portal login's export and delete (migration 0034) and the staff export, on a member with 500 notices and 200 audit rows (and a staff
// member with 200 audit rows and 50 review items) among 100 other people with 50 notices and 20 audit rows each. Pages counted with EXPLAIN (ANALYZE, BUFFERS)
// as the app's own role; the nested statements of a function count in its call. Each run is in a transaction that is rolled back, warm pass then measured
// pass, so both passes see the same rows. Fake data only.
import type pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { STAFF_EXPORT_SQL } from "../../src/self-service";
import { assertPageBudget, costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 18 Nov 2026: portal export 110 pages 5.9 ms, portal delete 3,766 pages 4.7 ms (the erase touches every table that names the person, and
// pseudonymises the 200 audit rows), staff export 90 pages 2.8 ms (by the actor and claim indexes). Limits are about 1.5 times the pages and 10 times the time.
export const EXPORT_PAGES = 170;
export const DELETE_PAGES = 5700;
export const STAFF_EXPORT_PAGES = 140;
export const EXPORT_MS = 60;
export const DELETE_MS = 50;
export const STAFF_EXPORT_MS = 30;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) select 'u'||g,'Fake','u'||g||'@example.test',true,now() from generate_series(0,100) g");
  await su.query("insert into portal_session(id, token, user_id, expires_at, updated_at) values ('s0', 'tok-u0', 'u0', now() + interval '1 day', now())");
  await su.query(`insert into notification(portal_user_id, category, template_key, params, created_at)
    select case when g <= 500 then 'u0' else 'u' || (1 + g % 100) end, 'account', 'fake', jsonb_build_object('n', g), now() - g * interval '1 minute' from generate_series(1, 5500) g`);
  await su.query(`insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, source)
    select 'security', case when g <= 200 then 'u0' else 'u' || (1 + g % 100) end, 'fake.action', 'job', g::text, 'site' from generate_series(1, 2200) g`);
  await su.query("insert into staff_user(id,name,email,email_verified,updated_at) select 'st'||g,'Fake','st'||g||'@example.test',true,now() from generate_series(0,100) g");
  await su.query(`insert into audit_event(kind, actor_staff_user_id, action, source)
    select 'admin_action', case when g <= 200 then 'st0' else 'st' || (1 + g % 100) end, 'fake.action', 'panel' from generate_series(1, 2200) g`);
  await su.query(`insert into review_item(queue, status, claimed_by_staff_user_id, claimed_at)
    select 'scheduled_check', 'dropped', case when g <= 50 then 'st0' else 'st' || (1 + g % 100) end, now() from generate_series(1, 2050) g`);
  await su.query("analyze");
});
afterAll(() => db.drop());

async function twice(c: pg.PoolClient, sql: string, args: unknown[], before?: string) {
  const plans: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    await c.query("begin");
    if (before) await c.query(before);
    plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${sql}`, args)).rows[0]["QUERY PLAN"]);
    await c.query("rollback");
  }
  return costOf(sql, plans[1]);
}

it("the portal export and delete stay inside their page and time budgets", async () => {
  const c = await db.pool("app_portal").connect();
  try {
    const ex = await twice(c, "select private.portal_account_export($1) r", ["tok-u0"]);
    const del = await twice(c, "select private.portal_account_delete($1) r", ["tok-u0"]);
    console.log("portal export", ex.pages, ex.ms, "| portal delete", del.pages, del.ms);
    assertPageBudget("portal account export", [ex], EXPORT_PAGES);
    assertPageBudget("portal account delete", [del], DELETE_PAGES);
    expect(ex.ms).toBeLessThan(EXPORT_MS);
    expect(del.ms).toBeLessThan(DELETE_MS);
  } finally {
    c.release();
  }
});

it("the staff export stays inside its page and time budget", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    const ex = await twice(c, STAFF_EXPORT_SQL, ["st0"], "select set_config('app.staff_user_id', 'st0', true)");
    console.log("staff export", ex.pages, ex.ms, ex.scans);
    assertPageBudget("staff export", [ex], STAFF_EXPORT_PAGES);
    expect(ex.ms).toBeLessThan(STAFF_EXPORT_MS);
  } finally {
    c.release();
  }
});
