// Performance: the next-minimums lookup of GET /api/minimums (src/page-reads.ts) as app_candidate, on a rules_version table with 200 minimums versions
// (a year of weekly changes, far more than will exist). It must stay on rules_version_in_force_idx: counted in 8 kB pages and in time, warm. The rules
// themselves are read by getRules (one statement kept 5 minutes), budgeted with the other rules reads. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { NEXT_MINIMUMS } from "../../src/page-reads";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
export const PAGES = 10; // measured 3 on 23 Nov 2026 (printed below); a full scan of the 200 versions would be far over
export const MS_LIMIT = 20;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const k = new pg.Client({ connectionString: urlFor(db.name) });
  await k.connect();
  try {
    await k.query("set session_replication_role = replica"); // the approval trigger off for the load; the checks still hold
    await k.query(`insert into rules_version(kind, data, effective_from, seeded_by_owner, approval_request_id)
      select 'minimums', (select data from rules_version where kind = 'minimums' limit 1), date '2030-01-01' + g, false, 900000 + g from generate_series(1, 200) g`);
    await k.query("vacuum (analyze) rules_version");
  } finally { await k.end(); }
});
afterAll(() => db.drop());

it("the next-minimums lookup stays on its index inside its page and time budget", async () => {
  const c = await db.pool("app_candidate").connect();
  try {
    expect((await c.query(NEXT_MINIMUMS, ["2026-11-23"])).rows[0].day).toBe("2030-01-02");
    const costs = await measurePages(c, [{ text: NEXT_MINIMUMS, values: ["2026-11-23"] }]);
    console.log(`next minimums: ${costs[0]!.pages} pages, ${costs[0]!.ms} ms (${costs[0]!.scans})`);
    assertPageBudget("next minimums", costs, PAGES);
    expect(costs[0]!.ms).toBeLessThan(MS_LIMIT);
  } finally { c.release(); }
});
