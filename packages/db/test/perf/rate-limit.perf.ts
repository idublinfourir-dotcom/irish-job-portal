// Performance: the two rate-limit checks added by the API follow-ups (step 15 apifix): the alert unsubscribe limit per client address
// (candidate_rate_limit, as app_candidate) and the portal notices mark limit per login (portal_rate_limit, as app_portal). Each is one upsert
// (rateSql); both its paths are measured on a table of 100,000 other keys: a first call (insert) and a call inside the window (update).
// Counted in 8 kB pages with EXPLAIN (ANALYZE, BUFFERS), warm pass then measured pass, each in a transaction that is rolled back. Fake data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { rateSql } from "../../src/candidate-route";
import { UNSUBSCRIBE_RATE } from "../../src/alerts";
import { NOTICE_RATE } from "../../../../apps/portal/lib/notices";
import { assertPageBudget, costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 18 Nov 2026: a first call 12 pages (unsubscribe) and 14 pages (notices), a repeat 6 pages, each under 0.1 ms; the upsert finds the
// key through its unique index (no scan node in the plan). The page budget is about 2.5 times the measure, the time budget far above it.
export const RATE_PAGES = 35;
export const RATE_MS = 5;
const OTHERS = 100_000;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  for (const t of ["candidate_rate_limit", "portal_rate_limit"])
    await su.query(`insert into ${t}(id, key, count, last_request) select gen_random_uuid()::text, 'perf:' || g, 1, 0 from generate_series(1, ${OTHERS}) g`);
  await su.query("analyze candidate_rate_limit; analyze portal_rate_limit");
});
afterAll(() => db.drop());

it.each([
  ["unsubscribe, per client address", "app_candidate", "candidate_rate_limit", "unsubscribe:198.51.100.7", UNSUBSCRIBE_RATE.windowMs],
  ["portal notices marks, per login", "app_portal", "portal_rate_limit", "notices:perf-user", NOTICE_RATE.windowMs],
] as const)("the %s check stays inside its page and time budget, first call and repeat", async (name, role, table, key, windowMs) => {
  const c = await db.pool(role).connect();
  try {
    const sql = rateSql(table);
    const explain = async (seed: boolean) => {
      const plans: unknown[] = [];
      for (let pass = 0; pass < 2; pass++) {
        await c.query("begin");
        if (seed) await c.query(sql, [randomUUID(), key, Date.now(), windowMs]); // the key already holds a window: the update path
        plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${sql}`, [randomUUID(), key, Date.now(), windowMs])).rows[0]["QUERY PLAN"]);
        await c.query("rollback");
      }
      return costOf(sql, plans[1]);
    };
    for (const [path, cost] of [["first call", await explain(false)], ["repeat", await explain(true)]] as const) {
      console.log(`rate limit ${name} (${path}): ${cost.pages} pages, ${cost.ms} ms, ${cost.scans || "no scan"}`);
      assertPageBudget(`rate limit ${name} (${path})`, [cost], RATE_PAGES);
      expect(cost.ms).toBeLessThan(RATE_MS);
      expect(cost.scans).not.toContain("Seq Scan");
    }
  } finally {
    c.release();
  }
});
