// Performance: the JobsIreland part of the twin trigger (migration 0065) on the fetcher's hot path, on ANALYZEd fake data: 500 companies, 45,000 live
// fetched jobs of an employer's board and 4,500 live JobsIreland jobs. Measured with the trigger on and disabled, so the budget is on what it adds:
// (a) 500 JobsIreland inserts by the fetcher's own INSERT_JOB as app_fetcher (the one-match lookup), (b) 500 inserts on the other board (every fetched
// insert of any kind now also looks for a JobsIreland twin). One company in ten has a same-title match. Pages are counted by EXPLAIN (ANALYZE, BUFFERS)
// on the statement; the trigger's own time and calls come from the plan's Triggers list. Writes are rolled back.
import type pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { INSERT_JOB } from "../../../fetcher/src/store";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Budgets (a regression fails): extra pages and ms a row over the trigger disabled, and the trigger's own time a row. Measured numbers are in the D1-A report.
const EXTRA_PAGES_PER_INSERT = 12;
const EXTRA_MS_PER_ROW = 1;
const TRIGGER_MS_PER_ROW = 0.3;
const ROWS = 500;
let db: TestDb;
let board: string, ji: string, orgs: string[];
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into organisation(slug, display_name, kind, status) select 'jit-perf-' || g, 'Jit Perf ' || g, 'employer', 'verified' from generate_series(1, 500) g");
  board = (await su.query("insert into job_source(kind, board) values ('sitemap', 'jit-perf') returning id::text")).rows[0].id;
  ji = (await su.query("insert into job_source(kind, board) values ('jobsireland', 'jit-perf') returning id::text")).rows[0].id;
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select $1, 'jp:' || g, 'passed' from generate_series(1, 45000 + 2 * $2::int) g", [board, ROWS]);
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select $1, 'jj:' || g, 'passed' from generate_series(1, 4500 + 2 * $2::int) g", [ji, ROWS]);
  const fill = (src: string, prefix: string, n: number) =>
    "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, permit_type, badge, status, closes_at, search_vector, own_page_url) " +
    `select (select id from organisation where slug = 'jit-perf-' || (1 + f.id % 500)), 'fetched', f.job_source_id, f.id, '${prefix} Role ' || (f.id % 90), 'x', 'Dublin', 'IT', 'critical_skills', ` +
    `'critical_skills_eligible', 'live', 'infinity', to_tsvector('english', 'x'), 'https://jobs.example.test/' || f.id from fetched_advert f where f.job_source_id = ${src} ` +
    `and f.id < (select min(id) + ${n} from fetched_advert where job_source_id = ${src}); `;
  // the fill skips the triggers (fake rows, not what is measured), then ANALYZE as autovacuum would
  await su.query(`set session_replication_role = replica; ${fill(board, "Board", 45000)}${fill(ji, "Ji", 4500)} set session_replication_role = default`);
  await su.query("analyze organisation, job, fetched_advert, job_source");
  orgs = (await su.query("select id::text from organisation where slug like 'jit-perf-%' order by id")).rows.map((r) => r.id as string);
});
afterAll(() => db.drop());

type Run = { pages: number; ms: number; triggerMs: number; triggerCalls: number };
/** Each statement through EXPLAIN (ANALYZE, BUFFERS) as app_fetcher in one transaction, rolled back; the trigger disabled meanwhile when `off`. The first 20 warm the caches. */
async function measure(off: boolean, all: { text: string; values: unknown[] }[]): Promise<Run> {
  if (off) await db.query("postgres", "alter table job disable trigger job_twin"); // this test's own database; enabled again below
  const c: pg.PoolClient = await db.pool("app_fetcher").connect();
  try {
    await c.query("begin");
    for (const q of all.slice(0, 20)) await c.query(`explain (analyze, buffers, format json) ${q.text}`, q.values);
    let pages = 0, triggerMs = 0, triggerCalls = 0;
    const t = performance.now();
    for (const q of all.slice(20)) {
      const plan = (await c.query(`explain (analyze, buffers, format json) ${q.text}`, q.values)).rows[0]["QUERY PLAN"];
      pages += costOf(q.text, plan).pages;
      const tr = ((plan[0].Triggers ?? []) as { "Trigger Name": string; Time: number; Calls: number }[]).find((x) => x["Trigger Name"] === "job_twin");
      triggerMs += tr?.Time ?? 0;
      triggerCalls += tr?.Calls ?? 0;
    }
    return { pages, ms: performance.now() - t, triggerMs, triggerCalls };
  } finally {
    await c.query("rollback");
    c.release();
    if (off) await db.query("postgres", "alter table job enable trigger job_twin");
  }
}
const spare = async (src: string, offset: number) =>
  (await db.query("postgres", "select id::text from fetched_advert where job_source_id = $1 and id not in (select fetched_advert_id from job where fetched_advert_id is not null) order by id offset $2 limit $3", [src, offset, ROWS])).rows.map((r) => r.id as string);
const inserts = (src: string, prefix: string, other: string, ads: string[]) =>
  ads.map((a, i) => ({ text: INSERT_JOB, values: [orgs[i % 500], src, a, i % 10 === 0 ? `${other} Role 3` : `${prefix} New ${i}`, "x", "Dublin", "IT", "2134", "critical_skills_eligible", 50000, 60000, "stated_pay", "live", "text", `https://jobs.example.test/n${a}`] }));

async function check(name: string, src: string, prefix: string, other: string) {
  const on = await measure(false, inserts(src, prefix, other, await spare(src, 0)));
  const off = await measure(true, inserts(src, prefix, other, await spare(src, ROWS)));
  const n = ROWS - 20;
  console.log(name, "on", on, "off", off, "per row: pages", ((on.pages - off.pages) / n).toFixed(2), "ms", ((on.ms - off.ms) / n).toFixed(3), "trigger ms", (on.triggerMs / n).toFixed(3));
  expect(on.triggerCalls).toBe(n);
  expect((on.pages - off.pages) / n).toBeLessThanOrEqual(EXTRA_PAGES_PER_INSERT);
  expect(on.triggerMs / n).toBeLessThanOrEqual(TRIGGER_MS_PER_ROW);
  expect((on.ms - off.ms) / n).toBeLessThanOrEqual(EXTRA_MS_PER_ROW);
}

it("(a) 500 JobsIreland inserts: the one-match lookup stays within its budget", () => check("jobsireland inserts", ji, "Ji", "Board"));
it("(b) 500 inserts on another board: the JobsIreland twin lookup stays within its budget", () => check("board inserts", board, "Board", "Ji"));
