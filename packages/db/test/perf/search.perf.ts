// Performance (S1, S2, #247): the filtered job list on the full-size fake fill (fill.ts: 5,000 live jobs in 38,000 rows, adverts of the measured
// size), every sort, first page and a later page (next and previous), with a keyword (a mid-band word and a common one), sector plus county,
// and all filters together, plus sectorCounts. Each list page is one statement through the real listJobs; pages are counted with
// EXPLAIN (ANALYZE, BUFFERS, SERIALIZE) as app_candidate, warm pass then measured pass (pages.ts). Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { decodeCursor, filterHash, listJobs, listQuery, sectorCounts, sectorCountsQuery, SORTS, type SearchFilters } from "../../src/search";
import { fill } from "./fill";
import { measurePages, type Statement } from "./pages";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
// Budgets for each list statement. Pages: the page gate's 1,000 for a whole page (page-gate.perf.ts, PAGE_LIMIT) less 100 for the signed-in
// shared statements it adds (about 60 measured warm). Before 0030 and the keyword CTE, plans read up to 5,200 pages (a rare sector on the
// sponsor sort), 3,387 (pay stated, sponsor sort) and 1,030 (a common keyword, row by row). Time: execution plus serialisation, warm; the
// measured worst is about 3 ms, so 25 ms leaves room for a loaded runner and still fails a plan that walks the table.
const PAGES = 900;
const MS = 25;

let db: TestDb;
let filters: Record<string, SearchFilters>;
beforeAll(async () => {
  db = await createTestDb();
  const su = new pg.Client({ connectionString: urlFor(db.name, "postgres") });
  await su.connect();
  try {
    console.log("fill seconds", await fill(su));
    await su.query("set session_replication_role = replica");
    // the fill has no occupation codes: give the live jobs ten real ones, then vacuum so the rows are as a settled table has them
    await su.query("update job set occupation_code = (array['2231','2136','2135','2139','2423','3111','2211','2129','1122','2424'])[1 + id % 10] where status = 'live'");
  } finally {
    await su.end();
  }
  await db.pool("portal_owner").query("vacuum (analyze)");
  const one = async (sql: string) => (await db.pool("postgres").query(sql)).rows[0];
  const word = async (lo: number, hi: number) =>
    (await one(`select word from ts_stat($$select search_vector from job where status='live'$$) where word ~ '^[a-z]{4,}$' and ndoc between ${lo} and ${hi} order by md5(word) limit 1`)).word as string;
  const mid = await word(101, 300), common = await word(1001, 5000);
  filters = {
    none: {},
    [`keyword ${mid}`]: { q: mid },
    [`keyword ${common}`]: { q: common },
    "sector IT": { sector: "IT" },
    "sector finance (rare)": { sector: "finance" },
    "sector IT + county Dublin": { sector: "IT", county: "Dublin" },
    "pay stated": { salaryStated: true },
    "pay from 60k": { salaryMin: 60000 },
    "posted within 7 days": { postedWithin: 7 },
    "stop words only": { q: "the" },
    "sector health + county Leitrim (rare)": { sector: "health", county: "Leitrim" },
    [`all filters, keyword ${common}`]: { q: common, occupationCode: "2136", sector: "IT", county: "Dublin", salaryMin: 30000, badge: "sponsor_confirmed", postedWithin: 30, salaryStated: true },
    "all filters but keyword": { occupationCode: "2136", sector: "IT", county: "Dublin", salaryMin: 30000, badge: "sponsor_confirmed", postedWithin: 30, salaryStated: true },
  };
});
afterAll(() => db.drop());

it("each list page is one statement inside its page and time budget, and sectorCounts too", async () => {
  const client = new pg.Client({ connectionString: urlFor(db.name, "app_candidate") });
  await client.connect();
  const counted = { n: 0, query: (t: string, v?: unknown[]) => (counted.n++, client.query(t, v)) };
  try {
    const rows: { name: string; q: Statement }[] = [];
    for (const [name, f] of Object.entries(filters))
      for (const sort of SORTS) {
        counted.n = 0;
        const first = await listJobs(counted as never, { sort, filters: f });
        expect(counted.n, `${sort} ${name}: statements`).toBe(1);
        rows.push({ name: `${sort} ${name}, first page (${first.count!.n}${first.count!.more ? "+" : ""} hits)`, q: listQuery(sort, undefined, "after", f) });
        if (!first.next) continue;
        counted.n = 0;
        const second = await listJobs(counted as never, { sort, filters: f, after: first.next });
        expect(counted.n).toBe(1);
        const at = decodeCursor(sort, first.next, filterHash(f));
        rows.push({ name: `${sort} ${name}, next page`, q: listQuery(sort, at, "after", f) });
        if (second.previous) rows.push({ name: `${sort} ${name}, previous page`, q: listQuery(sort, decodeCursor(sort, second.previous, filterHash(f)), "before", f) });
      }
    // B11: the sector counts of a search are one grouped statement under the same budget, whatever the filters (the sector filter itself is left out)
    for (const [name, f] of Object.entries(filters)) {
      counted.n = 0;
      await sectorCounts(counted as never, f);
      expect(counted.n, `sectorCounts ${name}: statements`).toBe(1);
      rows.push({ name: `sectorCounts ${name}`, q: sectorCountsQuery(f) });
    }

    const costs = await measurePages(client, rows.map((r) => r.q));
    const over: string[] = [];
    for (const [i, c] of costs.entries()) {
      console.log(`${rows[i]!.name}: ${c.pages} pages (planning ${c.planning}, execution ${c.execution}), ${c.ms} ms, ${c.scans}`);
      if (c.pages > PAGES || c.ms > MS) over.push(`${rows[i]!.name}: ${c.pages} pages, ${c.ms} ms, plan ${c.scans}`);
    }
    const worst = costs.reduce((a, b) => (b.pages > a.pages ? b : a));
    console.log(`worst ${worst.pages} pages, slowest ${Math.max(...costs.map((c) => c.ms))} ms, over ${rows.length} statements`);
    expect(over).toEqual([]);
  } finally {
    await client.end();
  }
});
