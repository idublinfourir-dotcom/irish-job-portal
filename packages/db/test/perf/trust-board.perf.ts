// Performance: the trust and safety reads of B69 and B70 (src/trust-board.ts) at about 10 times the launch size: 43,000 reports (3,000 open, 40,000 decided), 11,000 jobs
// (one company with 5,000 of them and 500 open reports on them), 4,000 cases, 3,000 bans, 2,000 WRC ticks among 100,000 other audit rows. Each statement is counted in 8 kB
// pages (planning, execution and serialisation, warm) and in time. A change that pushes a read over its budget is fixed in the query, not in the budget. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { BANS, TRUST_COUNTS, TRUST_LIST, wrcSql } from "../../src/trust-board";
import { assertPageBudget, measurePages, type Statement } from "./pages";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
// Measured 25 Nov 2026 (printed by the test): list 1,700 to 3,800 pages and 2 to 7 ms (the closed tab reads the report table in order: 4,400 pages, 64 ms at 43,000 reports; an index
// on decided reports by time fixes it when that matters), counts 113 pages, bans 190, WRC 200. Budgets are about 2 times the worst measure, the time limit has a floor for a busy laptop.
export const LIST_PAGES = 8000; // one page of the list, worst case: a page full of reports on one company with 5,000 jobs, each row with its two counts (200 at most)
export const COUNT_PAGES = 400; // the four tab counts, each stopping at 200
export const BAN_PAGES = 400;
export const WRC_PAGES = 400;
export const MS_LIMIT = 150;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const k = new pg.Client({ connectionString: urlFor(db.name) });
  await k.connect();
  try {
    await k.query("set session_replication_role = replica"); // as fill.ts: triggers off, CHECKs and keys still apply
    await k.query(`insert into staff_user(id, name, email, email_verified) values ('perf-ts', 'Fake TS', 'perf-ts@example.test', true), ('perf-ts2', 'Fake TS 2', 'perf-ts2@example.test', true)`);
    await k.query(`insert into organisation(slug, display_name, kind, status) select 'perf-o' || g, 'Fake Perf Org ' || g, case when g % 10 = 0 then 'agency' else 'employer' end, 'verified' from generate_series(1, 300) g`);
    const src = (await k.query("insert into job_source(kind, board) values ('portal', 'perf') returning id")).rows[0].id;
    await k.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, search_vector, salary_low)
      select o.id, 'employer', $1, 'Fake Job ' || g, 'Fake', 'IT', 'critical_skills', 'live', 'infinity', 'https://jobs.example.test/a', to_tsvector('x'), 40000
      from generate_series(1, 11000) g join (select id, row_number() over (order by id) n from organisation) o on o.n = case when g <= 5000 then 1 else 2 + g % 299 end`, [src]);
    // 500 open reports on the big company's jobs (below); 2,500 more open ones across the others; 40,000 decided
    // the worst case for the company count: the big company's 500 open reports are on its LAST jobs and are the oldest, so the first page is full of that company
    await k.query(`insert into report(target_kind, target_job_id, reason, status, created_at)
      select 'job', j.id, 'no_sponsorship', 'open', now() - interval '10 days' - j.id * interval '1 second' from (select id from job where organisation_id = (select min(organisation_id) from job) order by id desc limit 500) j`);
    await k.query(`insert into report(target_kind, target_job_id, reason, status, created_at)
      select 'job', j.id, 'asks_for_money', 'open', now() - (j.id % 5000) * interval '1 minute' from (select id from job where id > (select min(id) + 5000 from job) order by id limit 2500) j`);
    await k.query(`insert into report(target_kind, target_job_id, reason, status, decided_at, decided_by_staff_user_id, created_at)
      select 'job', j.id, 'job_closed', case when g % 3 = 0 then 'upheld' else 'cleared' end, now(), 'perf-ts', now() - (g || ' minutes')::interval
      from generate_series(1, 40000) g join (select id, row_number() over (order by id) n from job) j on j.n = 1 + g % 11000`);
    // 4,000 cases: 1,500 open, 500 waiting, 300 appealed, 1,700 closed
    await k.query(`insert into strike(organisation_id, case_kind, reason_code, stage, outcome, level, reply_due_at, appealed_at, created_at)
      select o.id, 'false_claim', 'false_sponsorship', c.stage, c.outcome, c.level, case when c.stage <> 'case_open' then now() end, case when c.stage = 'appealed' then now() end, now() - (g || ' minutes')::interval
      from generate_series(1, 4000) g
      join (select id, row_number() over (order by id) n from organisation) o on o.n = 1 + g % 300
      join lateral (select case when g <= 1500 then 'case_open' when g <= 2000 then 'reply_window' when g <= 2300 then 'appealed' else 'applied' end stage,
        case when g <= 2000 then null when g <= 2300 then 'strike' else 'cleared' end outcome, case when g > 2000 and g <= 2300 then 1 end level) c on true`);
    await k.query(`insert into approval_request(kind, target_table, target_id, proposed_by_staff_user_id, confirmed_by_staff_user_id, status, decided_at, applied_at)
      select 'ban', 'strike', s.id::text, 'perf-ts', 'perf-ts2', 'confirmed', now(), now() - (g || ' minutes')::interval from generate_series(1, 3000) g join (select id, row_number() over (order by id) n from strike where stage = 'applied') s on s.n = g`);
    await k.query(`insert into ban(cro_number, email_domain, reason_code, strike_id, approval_request_id)
      select 'perf' || a.id, 'perf' || a.id || '.example.test', 'asks_for_money', a.target_id::bigint, a.id from approval_request a where a.kind = 'ban'`);
    await k.query(`insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, at, source)
      select 'admin_action', 'perf-ts', 'trust_safety.wrc_reported', 'strike', s.id::text, now() - (g || ' minutes')::interval, 'panel' from generate_series(1, 2000) g join (select id, row_number() over (order by id) n from strike) s on s.n = g`);
    await k.query(`insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, at, source)
      select 'admin_action', 'perf-ts', 'other.action' || g % 20, 'job', g::text, now() - (g || ' seconds')::interval, 'panel' from generate_series(1, 100000) g`);
  } finally {
    await k.end();
  }
  await db.pool("portal_owner").query("vacuum (analyze)");
});
afterAll(() => db.drop());

async function measure(statements: Statement[]) {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  try {
    return { costs: await measurePages(c, statements), c };
  } finally {
    await c.end();
  }
}
async function budget(name: string, statements: Statement[], pages: number) {
  const { costs } = await measure(statements);
  const ms = costs.reduce((n, x) => n + x.ms, 0);
  console.log(`${name}: ${costs.reduce((n, x) => n + x.pages, 0)} pages, ${ms.toFixed(2)} ms (${costs.map((x) => x.scans).join(" | ")})`);
  assertPageBudget(name, costs, pages);
  expect(ms, `${name} time`).toBeLessThan(MS_LIMIT);
}
const at = async (sql: string) => { // the (created_at text, kind, id) of one row far into a list, as a cursor would carry it
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  try { return (await c.query(sql)).rows[0] as { t: string; k: string; i: string }; } finally { await c.end(); }
};

it("the list stays inside its page and time budget on every tab, first page and deep page, and reads a page not the table", async () => {
  const deepOpen = await at("select created_at::text t, 'report' k, id::text i from report where status in ('open','job_hidden') order by created_at, id offset 2000 limit 1");
  const deepClosed = await at("select created_at::text t, 'report' k, id::text i from report where status not in ('open','job_hidden') order by created_at desc, id desc offset 20000 limit 1");
  const deepCase = await at("select created_at::text t, 'case' k, id::text i from strike where outcome is null order by created_at, id offset 800 limit 1");
  await budget("open, first page", [TRUST_LIST.open!], LIST_PAGES);
  await budget("open, 2,000 in", [{ text: TRUST_LIST["open:after"]!, values: [deepOpen.t, deepOpen.k, deepOpen.i] }], LIST_PAGES);
  await budget("open, cases 800 in", [{ text: TRUST_LIST["open:after"]!, values: [deepCase.t, deepCase.k, deepCase.i] }], LIST_PAGES);
  await budget("waiting, first page", [TRUST_LIST.waiting!], LIST_PAGES);
  await budget("appeals, first page", [TRUST_LIST.appeals!], LIST_PAGES);
  await budget("closed, first page", [TRUST_LIST.closed!], LIST_PAGES);
  await budget("closed, 20,000 in", [{ text: TRUST_LIST["closed:after"]!, values: [deepClosed.t, deepClosed.k, deepClosed.i] }], LIST_PAGES);
});

it("the tab counts stop at 200 and stay inside their budget", async () => {
  await budget("tab counts", [TRUST_COUNTS], COUNT_PAGES);
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  const r = (await c.query(TRUST_COUNTS)).rows[0];
  await c.end();
  expect(r).toEqual({ open: 200, waiting: 200, appeals: 200, closed: 200 });
});

it("the ban list and the WRC list read a page of their own index, never the whole ban or audit table", async () => {
  await budget("bans, first page", [{ text: BANS, values: ["9223372036854775807"] }], BAN_PAGES);
  const deep = (await at("select id::text i from ban order by id desc offset 1500 limit 1")).i;
  await budget("bans, 1,500 in", [{ text: BANS, values: [deep] }], BAN_PAGES);
  await budget("wrc, first page", [wrcSql(false)], WRC_PAGES);
  const w = await at("select at::text t, 'case' k, id::text i from audit_event where action = 'trust_safety.wrc_reported' order by at desc, id desc offset 1000 limit 1");
  await budget("wrc, 1,000 in", [{ text: wrcSql(true), values: [w.t, w.i] }], WRC_PAGES);
});
