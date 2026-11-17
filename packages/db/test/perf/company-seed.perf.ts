// Performance (D2, #246): the company seed loads the real 94-row file into a database the size the live one will grow to (24,326 DETE names over
// five years, about 122,000 DETE rows, and 20,000 fake companies with a name each), as app_admin. Budgets: the statement count (bounded, whatever the
// file size: one statement per step, names batched with unnest) and the wall time of the whole load, then of the second run, which writes nothing.
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { parseSeed, seedCompanies } from "../../src/company-seed.ts";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 17 Nov 2026, three runs: 10 statements on the first run (begin, 3 reads, slugs, companies, names, links, refresh, commit), 7 on the
// second (no slugs, companies or names); first run 120 to 137 ms (94 companies, 272 names, 388 DETE rows linked), second 49 to 54 ms. The statement
// counts are exact; the time limits are about 7 and 9 times the slowest, for a busy laptop.
const STATEMENTS = { first: 10, second: 7 };
const MS = { first: 1_000, second: 500 };

let db: TestDb;
const rows = parseSeed(readFileSync(new URL("../../seed/companies-2026-11.tsv", import.meta.url), "utf8")).rows;
beforeAll(async () => {
  db = await createTestDb();
  const c = db.pool("postgres");
  // The file's own DETE names, two years each, then fake names up to 24,326, five years each.
  const real = rows.flatMap((r) => r.deteNames);
  await c.query("insert into dete_permit_count(dete_name, year, permits) select n, y, 3 from unnest($1::text[]) n cross join (values (2025), (2026)) v(y)", [real]);
  await c.query("insert into dete_permit_count(dete_name, year, permits) select 'Fake Dete Name ' || g, y, 1 from generate_series(1, 24326 - $1::int) g cross join generate_series(2022, 2026) y", [real.length]);
  await c.query("insert into organisation(slug, display_name, kind) select 'fake-org-' || g, 'Fake Org ' || g, 'employer' from generate_series(1, 20000) g");
  await c.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) select id, display_name, lower(display_name), 'alias', 'job_site' from organisation");
  await c.query("analyze dete_permit_count; analyze organisation; analyze organisation_name");
});
afterAll(() => db.drop());

/** The admin pool with every statement counted, on the pool and on the checked-out client. */
function counting(pool: pg.Pool) {
  const sql: string[] = [];
  return {
    sql,
    db: {
      query: ((text: string, v?: unknown[]) => (sql.push(text), pool.query(text, v))) as pg.Pool["query"],
      connect: (async () => {
        const c = await pool.connect();
        return { query: (text: string, v?: unknown[]) => (sql.push(text), c.query(text, v)), release: () => c.release() };
      }) as unknown as pg.Pool["connect"],
    },
  };
}

it("loads the 94-row file inside the statement and time budgets, and a second run writes nothing", async () => {
  expect(rows).toHaveLength(94);
  const timed = async () => {
    const k = counting(db.pool("app_admin"));
    const t = performance.now();
    const r = await seedCompanies(k.db, rows);
    return { r, ms: performance.now() - t, statements: k.sql.length };
  };
  const first = await timed();
  const second = await timed();
  console.log("first", first.statements, "statements", Math.round(first.ms), "ms", JSON.stringify({ ...first.r, deteNotFound: first.r.deteNotFound.length }));
  console.log("second", second.statements, "statements", Math.round(second.ms), "ms");
  expect(first.r).toMatchObject({ created: 94, found: 0, refused: [], deteNotFound: [] });
  expect(first.r.deteRowsLinked).toBe(194 * 2);
  expect(second.r).toMatchObject({ created: 0, found: 94, namesAdded: 0, deteRowsLinked: 0, labelsChanged: 0, refused: [] });
  expect(first.statements).toBeLessThanOrEqual(STATEMENTS.first);
  expect(second.statements).toBeLessThanOrEqual(STATEMENTS.second);
  expect(first.ms).toBeLessThan(MS.first);
  expect(second.ms).toBeLessThan(MS.second);
});
