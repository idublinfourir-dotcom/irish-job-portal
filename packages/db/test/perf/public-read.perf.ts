// Performance (S3, S5, #46): what a visitor's public read adds on the full-size fake fill (fill.ts: 5,000 live jobs in 38,000 rows). The capped first
// page (6 jobs, src/public-read.ts) on every sort, plain and with a keyword, is one statement through the real listJobs; the read limit is the shared
// rate upsert (candidate-route.ts rateSql) on a rate table of 100,000 rows, two per visitor read. Pages are counted with EXPLAIN (ANALYZE, BUFFERS,
// SERIALIZE) as app_candidate (pages.ts); the median is wall time of 51 real calls, warm. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { rateSql } from "../../src/candidate-route";
import { VISITOR_JOBS, VISITOR_READ_RATES } from "../../src/public-read";
import { listJobs, listQuery, SORTS, type SearchFilters } from "../../src/search";
import { fill } from "./fill";
import { measurePages } from "./pages";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
// Measured 18 Nov 2026 (printed by the test): capped page 60 pages, median about 0.8 ms (1.2 on salary); with a common keyword 497 pages, about 3 ms
// (the keyword's matches and the 200 count are read whatever the page size); rate upsert 7 pages, both windows 0.4 ms. Budgets about 3 times the
// measure; the keyword page keeps the search page's 900 (search.perf.ts), as the cap cannot make it dearer.
const LIST_PAGES = { plain: 200, keyword: 900 };
const LIST_MEDIAN_MS = 15;
const RATE_PAGES = 20; // one upsert on the primary key's unique index
const RATE_MEDIAN_MS = 3;

let db: TestDb;
let word: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = new pg.Client({ connectionString: urlFor(db.name, "postgres") });
  await su.connect();
  try {
    console.log("fill seconds", await fill(su));
    await su.query(`insert into candidate_rate_limit(id, key, count, last_request) select 'perf-' || g, 'read:ip:198.18.' || (g / 256) || '.' || (g % 256) || ':60000', 1 + g % 60, ${Date.now() + 60_000} from generate_series(1, 100000) g`);
  } finally {
    await su.end();
  }
  await db.pool("portal_owner").query("vacuum (analyze)");
  word = (await db.pool("postgres").query(`select word from ts_stat($$select search_vector from job where status='live'$$) where word ~ '^[a-z]{4,}$' and ndoc between 1001 and 5000 order by md5(word) limit 1`)).rows[0].word;
});
afterAll(() => db.drop());

const median = async (fn: () => Promise<unknown>) => {
  const t: number[] = [];
  for (let i = 0; i < 51; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[25]!;
};

it("a visitor's capped first page is one statement inside its page and median time budget, on every sort", async () => {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_candidate") });
  await c.connect();
  const counted = { n: 0, query: (t: string, v?: unknown[]) => (counted.n++, c.query(t, v)) };
  try {
    const over: string[] = [];
    for (const f of [{}, { q: word }] as SearchFilters[])
      for (const sort of SORTS) {
        const name = `${sort} ${f.q ? `keyword ${word}` : "no filter"}`;
        counted.n = 0;
        const l = await listJobs(counted as never, { sort, filters: f, limit: VISITOR_JOBS });
        expect([counted.n, l.jobs.length], name).toEqual([1, VISITOR_JOBS]);
        const [cost] = await measurePages(c, [listQuery(sort, undefined, "after", f, VISITOR_JOBS)]);
        const ms = await median(() => listJobs(c, { sort, filters: f, limit: VISITOR_JOBS }));
        console.log(`visitor ${name}: 1 statement, ${cost!.pages} pages, median ${ms.toFixed(2)} ms, ${cost!.scans}`);
        if (cost!.pages > (f.q ? LIST_PAGES.keyword : LIST_PAGES.plain) || ms > LIST_MEDIAN_MS) over.push(`${name}: ${cost!.pages} pages, ${ms.toFixed(2)} ms`);
      }
    expect(over).toEqual([]);
  } finally { await c.end(); }
});

it("the read limit is one upsert per window, two per visitor read, inside its page and median time budget", async () => {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_candidate") });
  await c.connect();
  try {
    const sql = rateSql("candidate_rate_limit");
    const at = (key: string, w: number) => ({ text: sql, values: [`perf-x-${key}`, key, Date.now(), w] });
    await c.query("begin"); // EXPLAIN ANALYZE runs the upsert: rolled back after
    const costs = await measurePages(c, VISITOR_READ_RATES.flatMap((r) => [at(`read:ip:198.18.3.7:${r.windowMs}`, r.windowMs), at(`read:ip:203.0.113.250:${r.windowMs}`, r.windowMs)]));
    await c.query("rollback");
    let i = 0;
    const ms = await median(() => Promise.all(VISITOR_READ_RATES.map((r) => c.query(sql, [`perf-m-${++i}`, `read:ip:198.18.9.${i % 200}:${r.windowMs}`, Date.now(), r.windowMs]))));
    const worst = Math.max(...costs.map((x) => x.pages));
    console.log(`read limit: ${VISITOR_READ_RATES.length} statements a visitor read, worst ${worst} pages (existing key and new key), both windows median ${ms.toFixed(2)} ms, on the unique key`);
    expect(worst).toBeLessThanOrEqual(RATE_PAGES);
    expect(ms).toBeLessThan(RATE_MEDIAN_MS);
  } finally { await c.end(); }
});
