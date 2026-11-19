// Performance: the fetched twin trigger of migration 0057 (job_twin, one to one) on the fetcher's hot path, on 50,000 ANALYZEd jobs: 45,000 live fetched jobs of
// 500 companies and 5,000 live employer jobs. Measured: (a) 500 inserts by the fetcher's own INSERT_JOB as app_fetcher, (b) 500 status updates by
// its own CLOSE_RECHECK, each with the trigger on and with it disabled, so the budget is on what the trigger adds; (c) one employer job going live
// with 3 fetched twins (hides them and moves their saved rows); (d) the employer lookup and the same-title count use their partial indexes. Pages are counted by EXPLAIN
// (ANALYZE, BUFFERS) on the statement, and the trigger's own time and calls come from the plan's Triggers list. Fake data only; writes are rolled back.
import type pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { CLOSE_RECHECK, INSERT_JOB } from "../../../fetcher/src/store";
import { assertPageBudget, costOf, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 19 Nov 2026 (gap round): inserts 59.6 pages a row with the trigger and 62.6 without (no measurable extra), job_twin 0.086 ms a row;
// updates 33.2 pages a row either way, job_twin 0.004 ms; the employer going live 103 pages, 2.3 ms; the lookups 6 and 5 pages. Budgets fail on a regression.
export const TWIN_EXTRA_PAGES_PER_INSERT = 8;
export const TWIN_EXTRA_PAGES_PER_UPDATE = 4;
export const TWIN_EXTRA_MS_PER_ROW = 1;
export const TWIN_TRIGGER_MS_PER_ROW = 0.2;
export const TWIN_GO_LIVE_PAGES = 400;
export const TWIN_LOOKUP_PAGES = 50;
const ROWS = 500;
let db: TestDb;
let org: string, board: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into organisation(slug, display_name, kind, status) select 'twin-perf-' || g, 'Twin Perf ' || g, 'employer', 'verified' from generate_series(1, 500) g");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  await su.query("insert into job_source(kind, board) values ('board', 'twin-perf')");
  board = (await su.query("select id::text from job_source where board = 'twin-perf'")).rows[0].id;
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select $1, 'tp:' || g, 'passed' from generate_series(1, 45000 + 3 * $2::int) g", [board, ROWS]);
  // the fill skips the triggers (fake rows, not what is measured), then ANALYZE as autovacuum would
  await su.query(
    "set session_replication_role = replica; " +
      "insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url) " +
      `select o.id, 'employer', ${src}, 'Employer Role ' || g, o.display_name, 'Dublin', 'IT', 'critical_skills', 60000, 'live', now() + interval '29 days', to_tsvector('english', 'x'), 'https://example.test/a' ` +
      "from organisation o, generate_series(1, 10) g where o.slug like 'twin-perf-%'; " +
      "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, permit_type, badge, status, closes_at, search_vector, own_page_url) " +
      "select (select id from organisation where slug = 'twin-perf-' || (1 + f.id % 500)), 'fetched', f.job_source_id, f.id, 'Fetched Role ' || (f.id % 90), 'x', 'Dublin', 'IT', 'critical_skills', " +
      "'critical_skills_eligible', 'live', 'infinity', to_tsvector('english', 'x'), 'https://jobs.example.test/' || f.id from fetched_advert f where f.external_id like 'tp:%' and f.id <= (select min(id) + 44999 from fetched_advert where external_id like 'tp:%'); " +
      "set session_replication_role = default");
  await su.query("analyze organisation, job, fetched_advert, saved_job");
  org = (await su.query("select id::text from organisation where slug = 'twin-perf-7'")).rows[0].id;
});
afterAll(() => db.drop());

type Run = { pages: number; ms: number; triggerMs: number; triggerCalls: number };
/** Runs each statement through EXPLAIN (ANALYZE, BUFFERS) as app_fetcher in one transaction, rolled back; the trigger disabled meanwhile when `off`. */
async function measure(off: boolean, all: { text: string; values: unknown[] }[]): Promise<Run> {
  let statements = all;
  if (off) await db.query("postgres", "alter table job disable trigger job_twin"); // this test's own database; enabled again below
  const c: pg.PoolClient = await db.pool("app_fetcher").connect();
  try {
    await c.query("begin");
    for (const q of statements.slice(0, 20)) await c.query(`explain (analyze, buffers, format json) ${q.text}`, q.values); // this connection's caches, not counted
    statements = statements.slice(20);
    let pages = 0, triggerMs = 0, triggerCalls = 0;
    const t = performance.now();
    for (const q of statements) {
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
const spare = async (offset: number) =>
  (await db.query("postgres", "select id::text from fetched_advert where external_id like 'tp:%' and id not in (select fetched_advert_id from job where fetched_advert_id is not null) order by id offset $1 limit $2", [offset, ROWS])).rows.map((r) => r.id as string);

it("(a) 500 fetcher inserts: what the twin trigger adds stays within its budget", async () => {
  const [onAds, offAds] = [await spare(0), await spare(ROWS)]; // fresh rows for each run: a rolled-back run leaves dead index entries the next would pay for
  // one company in ten has an employer job with the same title words, the other nine do not (the common case: the lookup finds nothing)
  const orgs = (await db.query("postgres", "select id::text from organisation where slug like 'twin-perf-%' order by id")).rows.map((r) => r.id as string);
  const stmts = (ads: string[]) => ads.map((a, i) => ({ text: INSERT_JOB, values: [orgs[i % 500], board, a, i % 10 === 0 ? "Employer Role 3" : `New Role ${i}`, "x", "Dublin", "IT", "2134", "critical_skills_eligible", 50000, 60000, "stated_pay", "live", "text", `https://jobs.example.test/n${a}`] }));
  const on = await measure(false, stmts(onAds)), off = await measure(true, stmts(offAds));
  console.log("inserts on", on, "off", off, "per row", (on.pages - off.pages) / (ROWS - 20), (on.ms - off.ms) / (ROWS - 20));
  expect((on.pages - off.pages) / (ROWS - 20)).toBeLessThanOrEqual(TWIN_EXTRA_PAGES_PER_INSERT);
  expect(on.triggerCalls).toBe(ROWS - 20);
  expect(on.triggerMs / (ROWS - 20)).toBeLessThanOrEqual(TWIN_TRIGGER_MS_PER_ROW);
  expect((on.ms - off.ms) / (ROWS - 20)).toBeLessThanOrEqual(TWIN_EXTRA_MS_PER_ROW);
});

it("(b) 500 fetcher status updates: what the twin trigger adds stays within its budget", async () => {
  const ids = (await db.query("postgres", "select id::text from job where source = 'fetched' and status = 'live' order by id limit $1", [2 * ROWS])).rows.map((r) => r.id as string);
  const stmts = (xs: string[]) => xs.map((id) => ({ text: CLOSE_RECHECK, values: [id] }));
  const on = await measure(false, stmts(ids.slice(0, ROWS))), off = await measure(true, stmts(ids.slice(ROWS)));
  console.log("updates on", on, "off", off, "per row", (on.pages - off.pages) / (ROWS - 20), (on.ms - off.ms) / (ROWS - 20));
  expect((on.pages - off.pages) / (ROWS - 20)).toBeLessThanOrEqual(TWIN_EXTRA_PAGES_PER_UPDATE);
  expect(on.triggerCalls).toBe(ROWS - 20);
  expect(on.triggerMs / (ROWS - 20)).toBeLessThanOrEqual(TWIN_TRIGGER_MS_PER_ROW);
  expect((on.ms - off.ms) / (ROWS - 20)).toBeLessThanOrEqual(TWIN_EXTRA_MS_PER_ROW);
});

it("(c) an employer job going live among 3 same-title fetched jobs (one by its link) stays within its budget", async () => {
  const c = await db.pool("postgres").connect();
  try {
    await c.query("begin");
    const ads = await spare(2 * ROWS);
    const twins: string[] = [];
    for (const a of ads.slice(0, 3)) twins.push((await c.query(INSERT_JOB, [org, board, a, "Brand New Role", "x", "Dublin", "IT", "2134", "critical_skills_eligible", 50000, 60000, "stated_pay", "live", "t", "https://jobs.example.test/t" + a])).rows[0].id);
    await c.query("insert into candidate_user(id, name, email, email_verified, created_at, updated_at) select 'twp-' || g, 'Fake', 'twp-' || g || '@example.test', true, now(), now() from generate_series(1, 30) g");
    await c.query("insert into saved_job(candidate_user_id, job_id) select 'twp-' || g, ($1::bigint[])[1 + g % 3] from generate_series(1, 30) g", [twins]);
    const src = (await c.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
    const e = (await c.query("insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url) " +
      "values ($1, 'employer', $2, 'Brand new role', 'x', 'Dublin', 'IT', 'critical_skills', 60000, 'draft', now() + interval '29 days', to_tsvector('english', 'x'), $3) returning id", [org, src, "https://jobs.example.test/t" + ads[1] + "/"])).rows[0].id;
    const go = costOf("go live", (await c.query("explain (analyze, buffers, format json) update job set status = 'live' where id = $1", [e])).rows[0]["QUERY PLAN"]);
    console.log("go live with 3 same-title fetched jobs", go.pages, go.ms);
    // one to one: of the 3 same-title candidates only the one its link names is hidden, and only its 10 saved rows move
    expect((await c.query("select id::text from job where id = any($1::bigint[]) and hidden_reason = 'duplicate'", [twins])).rows.map((r) => r.id)).toEqual([twins[1]]);
    expect((await c.query("select count(*)::int as n from saved_job where job_id = $1", [e])).rows[0].n).toBe(10);
    assertPageBudget("employer job goes live among 3 candidates", [go], TWIN_GO_LIVE_PAGES);
  } finally {
    await c.query("rollback");
    c.release();
  }
});

it("(d) the employer lookup and the same-title count use their partial index and stay within their page budget", async () => {
  const c = await db.pool("postgres").connect();
  try {
    const key = "trim(regexp_replace(lower($2::text), '[^a-z0-9]+', ' ', 'g'))";
    const costs = await measurePages(c, [
      { text: `select e.id from job e where e.organisation_id = $1 and e.status = 'live' and e.source in ('employer','admin_manual') and e.title_key = ${key} and (e.county is null or $3::text is null or e.county = $3::text) limit 1`, values: [org, "Employer Role 3", "Dublin"] },
      { text: `select count(*) from job f where f.organisation_id = $1 and f.source = 'fetched' and f.status = 'live' and f.title_key = ${key} and (f.county is null or $3::text is null or f.county = $3::text)`, values: [org, "Fetched Role 3", "Dublin"] },
    ]);
    console.log("twin lookups", costs.map((x) => [x.pages, x.scans, x.ms]));
    expect(costs.map((x) => x.scans)).toEqual(["job_twin_owner_idx", "job_twin_fetched_idx"]);
    for (const x of costs) assertPageBudget("twin lookup", [x], TWIN_LOOKUP_PAGES);
  } finally {
    c.release();
  }
});
