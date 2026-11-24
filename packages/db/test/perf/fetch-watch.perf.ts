// Performance: the fetch watch's two questions on a year of fetch_run rows (30 boards, 4 tries a day, 365 days: 43,800 rows) plus a bad
// day today (13 boards failed, as on 14 Nov 2026), plus 13 Workday boards that failed today on the laptop (W1b), which the skip leaves out. Both must read through the started_at index within a page budget. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { GOOD_RUN_TODAY, utcDayStart } from "../../src/fetch-guard-cli.ts";
import { FAILED_BOARDS_TODAY } from "../../src/fetch-watch-cli.ts";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
export const WATCH_PAGES = 40; // measured 18 on 16 Nov 2026 (6 for the guard's question, 12 for the failed boards); 22 on 18 Nov with the Workday skip and 13 more failed boards (8 and 14)
const NOW = new Date("2026-11-14T18:00:00Z");
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into job_source(kind, board) select 'board', 'b'||g from generate_series(1,30) g");
  await su.query("insert into job_source(kind, board) select 'workday', 'w'||g from generate_series(1,13) g");
  await su.query(
    "insert into fetch_run(job_source_id, started_at, finished_at, error) select s.id, t, t, case when random() < 0.05 then 'boom' end " +
      "from job_source s, generate_series($1::timestamptz - interval '365 days', $1::timestamptz - interval '1 hour', interval '6 hours') t",
    [utcDayStart(NOW)],
  );
  await su.query(
    "insert into fetch_run(job_source_id, started_at, finished_at, error) select id, $1, $1, case when board in ('b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12','b13') or kind = 'workday' then 'HTTP 303' end from job_source",
    [new Date("2026-11-14T12:09:00Z")],
  );
  await su.query("analyze fetch_run");
});
afterAll(() => db.drop());

it("the watch's two statements stay within the page budget on a year of runs", async () => {
  const c = await db.pool("app_fetcher").connect();
  try {
    const day = utcDayStart(NOW);
    const skip = ["workday"];
    const costs = await measurePages(c, [{ text: GOOD_RUN_TODAY, values: [day, skip] }, { text: FAILED_BOARDS_TODAY, values: [day, skip] }]);
    for (const k of costs) console.log("watch", k.pages, k.scans, k.ms);
    assertPageBudget("fetch watch", costs, WATCH_PAGES);
    for (const k of costs) expect(k.scans).toContain("fetch_run_started_idx");
    expect((await c.query(FAILED_BOARDS_TODAY, [day, skip])).rows[0].n).toBe(13);
    expect((await c.query(FAILED_BOARDS_TODAY, [day, []])).rows[0].n).toBe(26); // without the skip the Workday boards count too
  } finally {
    c.release();
  }
});

it("a slot started past midnight reads yesterday's rows too, within the same budget", async () => {
  const c = await db.pool("app_fetcher").connect();
  try {
    const day = utcDayStart(new Date(NOW.getTime() - 24 * 3_600_000));
    const costs = await measurePages(c, [{ text: GOOD_RUN_TODAY, values: [day, ["workday"]] }, { text: FAILED_BOARDS_TODAY, values: [day, ["workday"]] }]);
    for (const k of costs) console.log("watch, late slot", k.pages, k.scans, k.ms);
    assertPageBudget("fetch watch, late slot", costs, WATCH_PAGES);
    for (const k of costs) expect(k.scans).toContain("fetch_run_started_idx");
  } finally {
    c.release();
  }
});
