// Performance (OPS-5): the digest's stuck and failed counts over 100,000 outbox rows read two tiny partial indexes, never the table.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { OUTBOX_PROBLEMS } from "../../src/staff-digest-cli.ts";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
export const PROBLEMS_PAGES = 30; // measured 20 on 27 Nov 2026 over 100,000 rows (mostly planning); 1.5 times that
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into email_outbox(template,candidate_user_id,status,attempts,sent_at,dedupe_key,send_after) select 't','old'||g,case when g%1000=0 then 'failed' else 'sent' end,1,case when g%1000=0 then null else now() end,'old'||g,now()-g*interval '1 minute' from generate_series(1,100000) g");
  await su.query("analyze email_outbox");
});
afterAll(() => db.drop());

it("the stuck and failed counts stay within the page budget and use the two partial indexes", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    const r = await measurePages(c, [OUTBOX_PROBLEMS]);
    console.log("outbox problems", r[0]!.pages, r[0]!.scans, r[0]!.ms);
    assertPageBudget("outbox problems", r, PROBLEMS_PAGES);
    expect(r[0]!.scans).toContain("email_outbox_sending_idx");
    expect(r[0]!.scans).toContain("email_outbox_failed_idx");
  } finally { c.release(); }
});
