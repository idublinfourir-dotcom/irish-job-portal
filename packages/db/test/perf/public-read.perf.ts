// Performance (S3, S5, #46): what a visitor's public read adds on the full-size fake fill (fill.ts: 5,000 live jobs in 38,000 rows). The capped first
// page (6 jobs, src/public-read.ts) on every sort, plain and with a keyword, is one statement through the real listJobs; the read limit is the shared
// rate upsert (candidate-route.ts rateSql) on a rate table of 100,000 rows, two per visitor read. Pages are counted with EXPLAIN (ANALYZE, BUFFERS,
// SERIALIZE) as app_candidate (pages.ts); the median is wall time of 51 real calls, warm. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { rateSql } from "../../src/candidate-route";
import { CLOSED_JOB_SQL, closedJob, LIVE_SIMILAR, similarLiveJobs, similarSql } from "../../src/candidate";
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
// S9 "more jobs like this": the job lookup and both the occupation and the sector query (the sector one runs when the occupation has no other live job), pages
// summed. Measured 18 Nov 2026: 22 pages (7 + 3 + 12), median 0.65 ms; budget about 4 times.
const SIMILAR_PAGES = 100;
const SIMILAR_MEDIAN_MS = 15;

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

it("more jobs like this (S9): at most 3 statements, inside its page and median time budget, both queries counted (the sector fallback included)", async () => {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_candidate") });
  await c.connect();
  const counted = { n: 0, query: (t: string, v?: unknown[]) => (counted.n++, c.query(t, v)) };
  try {
    // the live job in the biggest sector whose occupation has the fewest other live jobs in that sector
    const j = (await c.query(
      `with s as (select sector from job where status = 'live' and sector is not null group by sector order by count(*) desc limit 1)
       select j.id::text as id, j.sector, j.occupation_code as occ from job j join s using (sector) where j.status = 'live' and j.closes_at > now()
       order by (select count(*) from job k where k.status = 'live' and k.sector = j.sector and k.occupation_code is not distinct from j.occupation_code), j.id limit 1`)).rows[0];
    const r = await similarLiveJobs(counted as never, j.id);
    expect(r!.jobs.length).toBe(LIVE_SIMILAR);
    expect(counted.n).toBeLessThanOrEqual(3);
    const costs = await measurePages(c, [
      { text: `select j.sector, j.occupation_code from job j where j.id = $1::bigint and (j.status = 'live' and j.closes_at > now())`, values: [j.id] },
      { text: similarSql(true, LIVE_SIMILAR), values: [j.sector, j.id, j.occ] }, { text: similarSql(false, LIVE_SIMILAR), values: [j.sector, j.id] },
    ]);
    const pages = costs.reduce((a, x) => a + x.pages, 0);
    const ms = await median(() => similarLiveJobs(c as never, j.id));
    console.log(`similar: ${counted.n} statements, ${pages} pages (${costs.map((x) => `${x.pages} ${x.scans}`).join(" | ")}), median ${ms.toFixed(2)} ms`);
    expect(pages).toBeLessThanOrEqual(SIMILAR_PAGES);
    expect(ms).toBeLessThan(SIMILAR_MEDIAN_MS);
  } finally { await c.end(); }
});

// B27 the closed-job read: the lookup by primary key and the same similar queries (up to 5 live jobs), at most 3 statements, pages summed and median time budgeted.
const CLOSED_PAGES = 100;
const CLOSED_MEDIAN_MS = 15;
it("closed job (B27): at most 3 statements, inside its page and median time budget; a job that is not closed costs one lookup", async () => {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_candidate") });
  await c.connect();
  const counted = { n: 0, query: (t: string, v?: unknown[]) => (counted.n++, c.query(t, v)) };
  try {
    // the fill has no closed job: the owner closes one live job of the biggest sector (the last test, so no other read sees it closed)
    const su = db.pool("postgres");
    const id = (await su.query(
      `update job set status = 'closed', closed_at = now(), close_reason = 'expired' where id = (select id from job where status = 'live' and sector = (select sector from job where status = 'live' group by sector order by count(*) desc limit 1) order by id limit 1) returning id::text`)).rows[0].id;
    const j = (await c.query("select j.id::text as id, j.sector, j.occupation_code as occ from job j where j.id = $1::bigint", [id])).rows[0];
    const r = await closedJob(counted as never, j.id);
    expect(r!.similar.length).toBeGreaterThan(0);
    expect(counted.n).toBeLessThanOrEqual(3);
    const costs = await measurePages(c, [
      { text: CLOSED_JOB_SQL, values: [j.id] },
      { text: similarSql(true, 5), values: [j.sector, j.id, j.occ ?? "0000"] }, { text: similarSql(false, 5), values: [j.sector, j.id] },
    ]);
    const pages = costs.reduce((a, x) => a + x.pages, 0);
    const ms = await median(() => closedJob(c as never, j.id));
    console.log(`closed job: ${counted.n} statements, ${pages} pages (${costs.map((x) => `${x.pages} ${x.scans}`).join(" | ")}), median ${ms.toFixed(2)} ms`);
    expect(pages).toBeLessThanOrEqual(CLOSED_PAGES);
    expect(ms).toBeLessThan(CLOSED_MEDIAN_MS);
    const live = (await c.query("select j.id::text as id from job j where j.status = 'live' limit 1")).rows[0].id;
    const miss = { n: 0, query: (t: string, v?: unknown[]) => (miss.n++, c.query(t, v)) };
    expect(await closedJob(miss as never, live)).toBeNull();
    expect(miss.n).toBe(1);
  } finally { await c.end(); }
});
