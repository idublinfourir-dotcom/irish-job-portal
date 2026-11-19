// Performance (#275): (1) the daily alert run on a Thursday with 10,000 alerts over 2,000 candidates, half of the candidates weekly (each on their
// own weekday, last sent on that day the week before, so only those whose day is Monday to Thursday are due), half dormant; (2) the staff digest's
// EMAIL_LIMIT read over 100,000 audit rows of other actions. Pages and time from EXPLAIN (ANALYZE, BUFFERS), each alert run rolled back. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { queueAlerts, weeklyDay } from "../../src/alerts-run-cli.ts";
import { EMAIL_LIMIT, emailLimit } from "../../src/staff-digest-cli.ts";
import { assertPageBudget, costOf, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured 19 Nov 2026 (three runs, the same pages each time): the weekly mix 774 candidates due, median 188,798 pages (171,307 to about 205,000,
// growing with each rolled-back run's dead rows), median 1,207 to 1,307 ms; EMAIL_LIMIT 1,214 pages (4 of them audit_event, the rest one pass of
// alert after those runs' dead rows), 6 to 7 ms. Budgets: 1.5 times the pages, about 4 times the time. Raise only on purpose.
export const WEEKLY_RUN_PAGES = 285_000;
export const WEEKLY_RUN_MEDIAN_MS = 5_000;
export const EMAIL_LIMIT_PAGES = 1_800;
const THU = new Date("2026-11-19T06:00:00Z");
const id = (c: number) => "perf-" + c;
// candidates: c % 2 = 0 dormant; c % 4 in (0, 1) weekly (so half the weekly ones dormant), else daily
const weekly = (c: number) => c % 4 < 2;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('perf-org', 'Fake Org', 'employer', 'verified') returning id")).rows[0].id;
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  await su.query(`insert into candidate_user(id, name, email, email_verified, created_at, updated_at, last_active_at)
    select 'perf-' || i, 'Fake', 'perf-' || i || '@example.test', true, now(), now(), case when i % 2 = 0 then $1::timestamptz - interval '200 days' else $1 end
      from generate_series(1, 2000) i`, [THU]);
  // weekly alerts were last sent on the candidate's own day of the week before (9 to 15 November)
  await su.query(`insert into alert(candidate_user_id, sector, frequency, last_sent_at, unsubscribe_token, created_at)
    select 'perf-' || c, case when k % 2 = 1 then 'it' end, case when c % 4 < 2 then 'weekly' else 'daily' end,
           case when c % 4 < 2 then timestamptz '2026-11-09T06:00:00Z' + (private.alert_weekly_day('perf-' || c) - 1) * interval '1 day' end,
           'perf-token-' || c || '-' || k || repeat('x', 30), timestamptz '2026-11-01'
      from generate_series(1, 2000) c, generate_series(0, 4) k`);
  await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, own_page_url, search_vector)
    select $1, 'admin_manual', $2, 'Fake job', 'Fake Org', 'Dublin', case when i % 2 = 0 then 'it' else 'health' end, 'critical_skills', 30000, 'live',
           timestamptz '2026-12-20', 'https://example.test/a', to_tsvector('english', 'cook')
      from generate_series(1, 500) i`, [org, src]);
  await su.query("update job set posted_at = timestamptz '2026-11-18T12:00:00Z' + id * interval '1 second'");
  // the digest's audit rows: 100,000 of other actions over 30 days, and 5 send runs (the newest within 2 days, one older than 2 days)
  await su.query(`insert into audit_event(kind, actor_system, action, at, source)
    select 'admin_action', 'perf', 'other.' || (g % 20), now() - g * interval '25 seconds', 'scheduled_job' from generate_series(1, 100000) g`);
  await su.query(`insert into audit_event(kind, actor_system, action, at, after, source)
    select 'admin_action', 'perf', 'email_outbox.run', now() - g * interval '20 hours', jsonb_build_object('left', 10 * g, 'old', g), 'scheduled_job' from generate_series(1, 5) g`);
  await su.query("analyze job; analyze alert; analyze candidate_user; analyze notification_preference; analyze audit_event");
});
afterAll(() => db.drop());

it("Thursday, 10,000 alerts, half weekly over the 7 days, half dormant: one statement, the counts right, pages and median time inside budget", async () => {
  const live = Array.from({ length: 2000 }, (_, i) => i + 1).filter((c) => c % 2 === 1);
  const dueCandidates = live.filter((c) => !weekly(c) || weeklyDay(id(c)) <= 4).length;
  const weeklyLive = live.filter(weekly);
  expect(weeklyLive.filter((c) => weeklyDay(id(c)) <= 4).length).toBeGreaterThan(0); // some weekly due
  expect(weeklyLive.filter((c) => weeklyDay(id(c)) > 4).length).toBeGreaterThan(0); // and some not
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  try {
    await c.query("begin");
    const r = await queueAlerts(c, THU);
    await c.query("rollback");
    expect(r).toEqual({ alerts_due: 5 * dueCandidates, candidates_queued: dueCandidates, rows_written: dueCandidates, alerts_paused: 5000 });
    const runs: { pages: number; ms: number }[] = [];
    for (let i = 0; i < 6; i++) {
      await c.query("begin");
      const plan = (await c.query("explain (analyze, buffers, serialize, format json) select private.queue_job_alerts($1)", [THU])).rows[0]["QUERY PLAN"];
      await c.query("rollback");
      if (i) runs.push(costOf("queue_job_alerts", plan)); // the first is the warm-up
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const pages = median(runs.map((x) => x.pages)), ms = median(runs.map((x) => x.ms));
    console.log(`queue_job_alerts weekly mix: ${dueCandidates} candidates due, median ${ms} ms, ${pages} pages (runs ${JSON.stringify(runs)})`);
    expect(pages).toBeLessThanOrEqual(WEEKLY_RUN_PAGES);
    expect(ms).toBeLessThanOrEqual(WEEKLY_RUN_MEDIAN_MS);
  } finally { await c.end(); }
});

it("EMAIL_LIMIT over 100,000 other audit rows and 10,000 alerts: the newest run through audit_event_action_idx, within the page budget", async () => {
  const c = await db.pool("app_admin").connect();
  try {
    expect(emailLimit((await c.query(EMAIL_LIMIT)).rows[0])).toEqual({ emailsLeft: 10, alertsTooOld: 1, alertSubscribers: 2000 });
    const cost = await measurePages(c, [EMAIL_LIMIT]);
    console.log("email limit", cost[0]!.pages, cost[0]!.scans, cost[0]!.ms);
    expect(cost[0]!.scans).toContain("audit_event_action_idx");
    expect(cost[0]!.scans).not.toContain("alert_candidate_idx"); // count(distinct) walked it with a heap visit per alert: 59,594 pages here
    assertPageBudget("staff digest email limit", cost, EMAIL_LIMIT_PAGES);
  } finally { c.release(); }
});
