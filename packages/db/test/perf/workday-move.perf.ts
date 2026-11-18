// Performance: the Workday move's statements (W1c) on 100,000 fetched adverts of 40 other boards (20,000 with a job) plus the eight
// employers' 320 Workday adverts with their jobs, within a page budget. Fake data only.
// MOVE writes, so the measured pass runs in a transaction that is rolled back.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { ADD_TARGETS, MOVE, MOVES, ROWS, TAKEN } from "../../src/workday-move.ts";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 18 Nov 2026: 12,389 pages for 280 moved rows (the reads 144, the move 12,245: about 44 pages a row, almost all of it writing the
// advert and the job with their indexes, foreign-key checks and job_guard). The budget is 60 pages a moved row.
// W1e (Applied Materials added): 14,018 pages for 320 rows (the reads 185), about 44 a row.
export const MOVE_PAGES = 320 * 60; // W1e: eight employers, 320 rows; the same 60 a row
let db: TestDb;
const TENANTS = Object.keys(MOVES);
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into organisation(slug, display_name, kind) values ('move-perf', 'Move Perf Ltd', 'employer')");
  await su.query("insert into job_source(kind, board) select 'board', 'b'||g from generate_series(1,40) g");
  await su.query("insert into job_source(kind, board) select 'workday', t from unnest($1::text[]) t", [TENANTS]);
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select s.id, s.kind || ':' || s.board || ':' || g, 'rejected' from job_source s, generate_series(1, 2500) g where s.kind = 'board'");
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select s.id, 'workday:' || s.board || ':/job/Dublin/Job-' || g || '_R-' || (100000 + g), 'passed' from job_source s, generate_series(1, 40) g where s.kind = 'workday'");
  await su.query(
    "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, status, closes_at, search_vector, own_page_url) " +
      "select (select id from organisation where slug = 'move-perf'), 'fetched', f.job_source_id, f.id, 'Engineer', 'Move Perf Ltd', 'IT', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', 'engineer'), 'https://jobs.example.test/' || f.id " +
      "from fetched_advert f where f.external_id like 'workday:%' or f.id % 5 = 0",
  );
  await su.query("analyze job_source, fetched_advert, job");
});
afterAll(() => db.drop());

it("the move's statements stay within the page budget and use the indexes", async () => {
  const c = await db.pool("app_fetcher").connect();
  try {
    await c.query("begin");
    const targets = (await c.query<{ id: string; board: string }>(ADD_TARGETS, [TENANTS.map((t) => MOVES[t]), TENANTS])).rows;
    const rows = (await c.query<{ id: string; board: string; external_id: string }>(ROWS, [TENANTS])).rows;
    expect(rows).toHaveLength(320);
    const src = new Map(targets.map((t) => [t.board, t.id]));
    const move = [rows.map((r) => r.id), rows.map((r) => src.get(r.board)), rows.map((r) => `${MOVES[r.board]}:${r.board}:x${r.id}`)];
    const costs = await measurePages(c, [
      { text: ADD_TARGETS, values: [TENANTS.map((t) => MOVES[t]), TENANTS] },
      { text: TAKEN, values: [targets.map((t) => t.id)] },
      { text: ROWS, values: [TENANTS] },
      { text: MOVE, values: move },
    ]);
    for (const k of costs) console.log("workday move", k.pages, k.scans, k.ms);
    assertPageBudget("workday move", costs, MOVE_PAGES);
    expect(costs[1]!.scans).toContain("fetched_advert_job_source_id_external_id_key");
    expect(costs[2]!.scans).toContain("fetched_advert_job_source_id_external_id_key");
    expect(costs[3]!.scans).toContain("fetched_advert_pkey");
    expect(costs.slice(0, 3).reduce((n, k) => n + k.pages, 0)).toBeLessThan(300); // the reads: measured 144
  } finally {
    await c.query("rollback");
    c.release();
  }
});
