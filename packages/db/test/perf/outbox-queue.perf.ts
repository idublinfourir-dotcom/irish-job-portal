// Performance (#275): the outbox claim with 10,000 pending rows, 9,000 job alerts queued before 1,000 notices, over 100,000 sent rows. The claim
// must take the 200 notices first straight from email_outbox_pending_idx (no sort of the whole queue), and the after-run count of rows left must
// stay inside its page and time budget. Pages and time from EXPLAIN (ANALYZE, BUFFERS), each claim rolled back. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { CLAIM, LEFT, sendPending } from "../../src/outbox-cli.ts";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured 19 Nov 2026, three runs: claim 3,825 pages (as the old 20,000-row claim: the cost is the 200 status changes, not the queue size),
// rows left 171 pages, batch 74 to 92 ms with an instant sender. Budgets: 1.5 times the pages, about 5 times the time. Raise only on purpose.
export const QUEUE_CLAIM_PAGES = 6000;
export const LEFT_PAGES = 260;
export const QUEUE_MS = 500;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into candidate_user(id,name,email,email_verified,updated_at) select 'c'||g,'Fake','c'||g||'@example.test',true,now() from generate_series(1,10000) g");
  await su.query("insert into email_outbox(template,candidate_user_id,status,attempts,sent_at,dedupe_key) select 't','old'||g,'sent',1,now(),'old'||g from generate_series(1,100000) g");
  await su.query("insert into email_outbox(template,candidate_user_id,dedupe_key,send_after,params) select 'job_alert','c'||g,'a'||g,now()-interval '2 days'+g*interval '1 second','{}' from generate_series(1,9000) g");
  await su.query("insert into email_outbox(template,candidate_user_id,dedupe_key,send_after) select 'account_merged','c'||g,'n'||g,now()-interval '1 hour'+(g-9000)*interval '1 second' from generate_series(9001,10000) g");
  await su.query("analyze email_outbox");
});
afterAll(() => db.drop());

it("10,000 pending: the claim takes 200 notices first through the index, and the rows-left count, within the page and time budgets", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    await c.query("begin");
    const claim = await measurePages(c, [{ text: CLAIM, values: [200] }]);
    const templates = (await c.query("select distinct template from email_outbox where status = 'sending'")).rows.map((r) => r.template);
    await c.query("rollback");
    const left = await measurePages(c, [{ text: LEFT, values: [] }]);
    console.log("queue claim", claim[0]!.pages, claim[0]!.scans, claim[0]!.ms, "left", left[0]!.pages, left[0]!.scans, left[0]!.ms);
    expect(templates).toEqual(["account_merged"]);
    expect(claim[0]!.scans).toContain("email_outbox_pending_idx");
    assertPageBudget("outbox claim, 10,000 pending", claim, QUEUE_CLAIM_PAGES);
    assertPageBudget("outbox rows left", left, LEFT_PAGES);
  } finally {
    c.release();
  }
  const seen: string[] = [];
  const a = db.pool("app_admin");
  const counted = { query: (q: unknown, ...rest: unknown[]) => (seen.push(String(q)), (a.query as (...x: unknown[]) => unknown)(q, ...rest)) } as never;
  const t = performance.now();
  const r = await sendPending(counted, async () => {}, 200);
  const ms = performance.now() - t;
  console.log("queue batch ms", Math.round(ms), "statements", seen.length);
  expect(r).toEqual({ sent: 200, retry: 0, failed: 0, dropped: 0, old: 0 });
  expect(seen.length).toBe(2 + 200); // claim, addresses, one mark per row (no alert in the batch, so no alert reads)
  expect(ms).toBeLessThan(QUEUE_MS);
});
