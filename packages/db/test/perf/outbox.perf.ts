// Performance: the outbox sender on a big table (100,000 sent and failed rows, 20,000 pending). One batch of 200 must claim through the
// pending index (pages budget), find the addresses by key, and finish in a time budget with an instant fake sender. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { ADDRESSES, CLAIM, SENT_TODAY, sendPending } from "../../src/outbox-cli.ts";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
export const SENT_TODAY_PAGES = 20; // measured 8 on 27 Nov 2026 with 90,000 rows sent today: the count stops at DAILY_CAP, so the day never costs more
export const CLAIM_PAGES = 6000; // measured 3,836 on 12 Nov 2026 (about 19 pages a row: heap and the index entries the status change rewrites); 6,000 is 1.5 times that
export const ADDRESS_PAGES = 1000; // measured 626 on 12 Nov 2026 (200 rows through 6 left joins by key)
export const BATCH_MS = 3000; // measured 455 ms for a batch of 200 with an instant sender, about 6 times that
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into candidate_user(id,name,email,email_verified,updated_at) select 'c'||g,'Fake','c'||g||'@example.test',true,now() from generate_series(1,20000) g");
  await su.query("insert into email_outbox(template,candidate_user_id,status,attempts,sent_at,dedupe_key) select 't','old'||g,case when g%10=0 then 'failed' else 'sent' end,1,now(),'old'||g from generate_series(1,100000) g");
  await su.query("insert into email_outbox(template,candidate_user_id,dedupe_key,send_after) select 't','c'||g,'new'||g,now()-interval '1 day'+g*interval '1 second' from generate_series(1,20000) g");
  await su.query("analyze email_outbox");
});
afterAll(() => db.drop());

it("claims and addresses a batch of 200 within the page budget, and sends it within the time budget", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    await c.query("begin");
    const claim = await measurePages(c, [{ text: CLAIM, values: [200] }]);
    console.log("claim", claim[0]!.pages, claim[0]!.scans, claim[0]!.ms);
    assertPageBudget("outbox claim", claim, CLAIM_PAGES);
    expect(claim[0]!.scans).toContain("email_outbox_pending_idx");
    await c.query("rollback");
    // The day's count (DAILY_CAP), asked once a run: on email_outbox_record_idx, never a pass over the table.
    const today = await measurePages(c, [SENT_TODAY]);
    console.log("sent today", today[0]!.pages, today[0]!.scans, today[0]!.ms);
    assertPageBudget("outbox sent today", today, SENT_TODAY_PAGES);
    expect(today[0]!.scans).toContain("email_outbox_record_idx");
    const ids = (await c.query("select id from email_outbox where status='pending' order by send_after, id limit 200")).rows.map((r) => r.id);
    const addr = await measurePages(c, [{ text: ADDRESSES, values: [ids] }]);
    console.log("addresses", addr[0]!.pages, addr[0]!.scans, addr[0]!.ms);
    assertPageBudget("outbox addresses", addr, ADDRESS_PAGES);
  } finally {
    c.release();
  }
  const sent: string[] = [];
  const t = performance.now();
  const r = await sendPending(db.pool("app_admin"), async (to) => void sent.push(to), 200);
  const ms = performance.now() - t;
  console.log("batch ms", Math.round(ms));
  expect(r.sent).toBe(200);
  expect(ms).toBeLessThan(BATCH_MS);
});
