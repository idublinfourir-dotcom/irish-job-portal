// Performance (N3): the portal notice reader's statements on 1,000 notices for one user (half unread) and 10,000 for 100 other users. Pages are counted with
// EXPLAIN (ANALYZE, BUFFERS) as app_portal, warm pass then measured pass; mark all read runs in a transaction that is rolled back. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { encodeNoticeCursor, MARK_ALL, NOTICES_AFTER, NOTICES_FIRST, UNREAD } from "../../src/notices";
import { decodeReviewCursor } from "../../src/account-review";
import { assertPageBudget, costOf, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 18 Nov 2026 (two runs, the same pages): first page 143 pages 0.8 ms, later page 74 pages 0.5 ms, unread count 63 pages 0.15 ms, mark all read
// (500 rows) 7,174 pages 5.4 ms. The planner reads the user's 1,000 rows by a bitmap on notification_portal_idx and sorts them (the user is 9% of this small
// table); no new index needed. Page limits are about 1.5 times the measure, time limits about 10 times or more.
export const PAGE_PAGES = 220; // the first page: the user's rows found by the index, then sorted
export const LATER_PAGES = 120; // a page from the middle: only the rows older than the token
export const UNREAD_PAGES = 100; // up to 200 unread rows, each checked on the heap
export const MARK_ALL_PAGES = 11000; // 500 rows updated, about 14 pages each: the heap and the index entries the new row versions add
export const READ_MS = 20;
export const MARK_ALL_MS = 60;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) select 'u'||g,'Fake','u'||g||'@example.test',true,now() from generate_series(0,100) g");
  // the others' notices first and the user's spread through them, as real notices arrive over time
  await su.query(`insert into notification(portal_user_id, category, template_key, params, created_at, read_at)
    select case when g % 11 = 0 then 'u0' else 'u' || (1 + g % 100) end, 'rules', 'fake', jsonb_build_object('n', g), now() - g * interval '1 minute',
           case when g % 2 = 0 then now() end
      from generate_series(1, 11000) g`);
  await su.query("analyze notification");
});
afterAll(() => db.drop());

it("list, later page, unread count and mark all read stay inside their page and time budgets on the portal index", async () => {
  const c = await db.pool("app_portal").connect();
  try {
    expect((await c.query("select count(*)::int n from portal_notification where portal_user_id = 'u0'")).rows[0].n).toBe(1000);
    const mid = (await c.query("select id, created_at::text as created_text from portal_notification where portal_user_id = 'u0' order by created_at desc, id desc offset 500 limit 1")).rows[0];
    const [t, i] = decodeReviewCursor(encodeNoticeCursor(mid));
    const read = await measurePages(c, [{ text: NOTICES_FIRST, values: ["u0"] }, { text: NOTICES_AFTER, values: ["u0", t, i] }, { text: UNREAD, values: ["u0"] }]);
    for (const r of read) console.log("notices", r.pages, r.scans, r.ms, r.sql.slice(0, 60));
    assertPageBudget("notices first page", [read[0]!], PAGE_PAGES);
    assertPageBudget("notices later page", [read[1]!], LATER_PAGES);
    assertPageBudget("notices unread count", [read[2]!], UNREAD_PAGES);
    for (const r of read) { expect(r.scans).toContain("notification_portal_idx"); expect(r.ms).toBeLessThan(READ_MS); }
    // an update runs twice (warm, measured), each time in a transaction that is rolled back, so both passes mark the same 500 rows
    const plans: unknown[] = [];
    for (let pass = 0; pass < 2; pass++) {
      await c.query("begin");
      plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${MARK_ALL}`, ["u0"])).rows[0]["QUERY PLAN"]);
      await c.query("rollback");
    }
    const fresh = costOf(MARK_ALL, plans[1]);
    console.log("mark all", fresh.pages, fresh.scans, fresh.ms);
    assertPageBudget("notices mark all read", [fresh], MARK_ALL_PAGES);
    expect(fresh.scans).toContain("notification_portal_idx");
    expect(fresh.ms).toBeLessThan(MARK_ALL_MS);
  } finally {
    c.release();
  }
});
