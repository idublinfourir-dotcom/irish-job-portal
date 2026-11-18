// The daily job alert run (0024, private.queue_job_alerts) on the real test database: which alerts are due, which jobs are new for them, the
// outbox row's shape (step11/wave-brief.md, "The shared shape"), and who may run it. Fake data only. Fixed run times: 16 November 2026 is a
// Monday, the 17th a Tuesday. Every test starts with no alerts, no outbox rows and no live jobs.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main, queueAlerts } from "../src/alerts-run-cli.ts";
import { createTestDb, urlFor } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
let db: Awaited<ReturnType<typeof createTestDb>>;
type Fx = { id(p: string): string; F: { cand(o?: object): Promise<string>; org(): Promise<number>; portal(): Promise<string>;
  member(org: string, user: string, o?: object): Promise<number>; text(purpose: string): Promise<number> } };
let f: Fx;
let org: string, src: string, member: string, text: string;
const MON = new Date("2026-11-16T06:00:00Z"), TUE = new Date("2026-11-17T06:00:00Z"), WED = new Date("2026-11-18T06:00:00Z");
const BEFORE = "2026-11-15T00:00:00Z"; // alerts are made here; jobs go live after it
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p);
const run = (now: Date) => queueAlerts(db.pool("app_admin"), now);

type JobOpts = { occ?: string | null; sector?: string; county?: string | null; low?: number | null; high?: number | null; sponsor?: boolean; quota?: boolean; closes?: string; at?: string };
async function job(o: JobOpts = {}): Promise<number> {
  const id = (await su(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, salary_low, salary_high, pay_grade,
       quota_full, status, closes_at, own_page_url, search_vector)
     values ($1, $12, $2, 'Fake job', 'Fake Org', $3, $4, $5, 'critical_skills', $6, $7, $8, null, $9, $10, $11::timestamptz, 'https://example.test/a', to_tsvector('english', 'cook'))
     returning id::int`,
    [org, src, o.county ?? null, o.sector ?? "it", o.occ ?? null, o.sponsor ? "sponsor_confirmed" : null, o.low ?? null, o.high ?? null, o.quota ?? false,
      o.sponsor ? "draft" : "live", o.closes ?? "2026-12-20T00:00:00Z", o.sponsor ? "employer" : "admin_manual"])).rows[0].id as number;
  if (o.sponsor) {
    await db.query("app_portal", "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, signer_membership_id, signer_name) values ($1, $2, 'own_company', $3, $4, 'Fake Signer')", [id, org, text, member]);
    await su("update job set status = 'live' where id = $1", [id]);
  }
  await su("update job set posted_at = $2::timestamptz where id = $1", [id, o.at ?? "2026-11-15T12:00:00Z"]);
  return id;
}
type AlertOpts = { occ?: string; sector?: string; county?: string; salary?: number; badge?: string; frequency?: string; status?: string; reason?: string; created?: string };
async function alert(cand: string, o: AlertOpts = {}): Promise<number> {
  return (await su(
    `insert into alert(candidate_user_id, occupation_code, sector, county, salary_min, badge, frequency, status, pause_reason, unsubscribe_token, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::int`,
    [cand, o.occ ?? null, o.sector ?? null, o.county ?? null, o.salary ?? null, o.badge ?? null, o.frequency ?? "daily", o.status ?? "active", o.reason ?? null,
      f.id("tok").padEnd(40, "x"), o.created ?? BEFORE])).rows[0].id as number;
}
const cand = (o: object = {}) => f.F.cand(o);
const outbox = async (c: string) => (await su("select template, status, send_after, dedupe_key, params from email_outbox where candidate_user_id = $1", [c])).rows;
const jobsFor = async (c: string) => ((await outbox(c))[0]?.params.alerts ?? []).map((a: { job_ids: number[] }) => a.job_ids);
const lastSent = async (id: number) => (await su("select last_sent_at from alert where id = $1", [id])).rows[0].last_sent_at as Date | null;

beforeAll(async () => {
  db = await createTestDb();
  f = fixtures(db) as unknown as Fx;
  org = String(await f.F.org());
  src = (await su("insert into job_source(kind, board) values ('portal', 'fake-board') returning id::text")).rows[0].id;
  member = String(await f.F.member(org, await f.F.portal(), { role: "account_owner" }));
  text = String(await f.F.text("sponsorship_statement"));
});
afterAll(() => db.drop());
beforeEach(async () => {
  await su("delete from alert");
  await su("delete from email_outbox");
  await su("update job set status = 'closed', close_reason = 'closed' where status = 'live'");
});

describe("the outbox row", () => {
  it("one row per candidate in the shared shape, only alerts with new jobs, and one audit row with the counts", async () => {
    const c = await cand();
    const j1 = await job({ sector: "health", at: "2026-11-15T10:00:00Z" }), j2 = await job({ sector: "health", at: "2026-11-15T11:00:00Z" });
    const a1 = await alert(c, { sector: "health" }), a2 = await alert(c), a3 = await alert(c, { sector: "nothing-matches" });
    const r = await run(MON);
    expect(r).toEqual({ alerts_due: 3, candidates_queued: 1, rows_written: 1, alerts_paused: 0 });
    const rows = await outbox(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: "job_alert", status: "pending", dedupe_key: `job_alert:${c}:2026-11-16` });
    expect(rows[0].send_after).toEqual(MON);
    expect(rows[0].params).toEqual({ run_on: "2026-11-16", alerts: [{ alert_id: a1, job_ids: [j2, j1] }, { alert_id: a2, job_ids: [j2, j1] }] });
    for (const a of [a1, a2, a3]) expect(await lastSent(a)).toEqual(MON); // every due alert, with or without new jobs
    const audit = (await su("select actor_system, after, source from audit_event where action = 'job_alerts.run' order by id desc limit 1")).rows[0];
    expect(audit).toEqual({ actor_system: "queue_job_alerts by app_admin", after: { ...r, run_on: "2026-11-16" }, source: "scheduled_job" });
  });
  it("a second run the same day writes nothing and stamps nothing, even with a new job; the next day sends only the new job", async () => {
    const c = await cand();
    const j1 = await job();
    await alert(c);
    expect(await run(MON)).toEqual({ alerts_due: 1, candidates_queued: 1, rows_written: 1, alerts_paused: 0 });
    const j2 = await job({ at: "2026-11-16T07:00:00Z" });
    expect(await run(new Date("2026-11-16T20:00:00Z"))).toEqual({ alerts_due: 0, candidates_queued: 0, rows_written: 0, alerts_paused: 0 });
    expect(await outbox(c)).toHaveLength(1);
    await run(TUE);
    const rows = (await outbox(c)).map((x) => x.params.alerts[0].job_ids);
    expect(rows).toEqual([[j1], [j2]]);
  });
  it("the dedupe key stops a second row for the same UTC day even when the alerts are due again", async () => {
    const c = await cand();
    await job();
    const a = await alert(c);
    await run(MON);
    await su("update alert set last_sent_at = null where id = $1", [a]);
    expect(await run(new Date("2026-11-16T23:59:00Z"))).toEqual({ alerts_due: 1, candidates_queued: 1, rows_written: 0, alerts_paused: 0 });
    expect(await outbox(c)).toHaveLength(1);
  });
  it("at most 20 jobs per alert, the newest first; at most 10 alerts per candidate, the oldest alerts", async () => {
    const c = await cand(), many = await cand();
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push(await job({ at: `2026-11-15T12:00:${String(i).padStart(2, "0")}Z` }));
    await alert(c);
    const alerts: number[] = [];
    for (let i = 0; i < 11; i++) alerts.push(await alert(many)); // more than the routes allow, written straight in
    await run(MON);
    expect(await jobsFor(c)).toEqual([ids.slice(5).reverse()]);
    const p = (await outbox(many))[0].params;
    expect(p.alerts.map((a: { alert_id: number }) => a.alert_id)).toEqual(alerts.slice(0, 10));
  });
});

describe("which jobs are new for an alert", () => {
  it("each filter alone and all together; quota-full, closing, later-posted and before-the-alert jobs never match; hostile text matches nothing", async () => {
    const a = await job({ occ: "2136", sector: "it", county: "Dublin", low: 45000, high: 50000, sponsor: true, at: "2026-11-15T10:00:00Z" });
    const b = await job({ occ: "2136", sector: "health", county: "Cork", low: 30000, at: "2026-11-15T11:00:00Z" });
    const n = await job({ occ: "3421", sector: "it", county: "Cork", at: "2026-11-15T12:00:00Z" }); // no stated pay
    const d = await job({ occ: "2136", sector: "it", county: "Dublin", low: 40000, high: 40000, at: "2026-11-15T13:00:00Z" });
    await job({ occ: "2136", quota: true });
    await job({ occ: "2136", closes: "2026-11-16T05:00:00Z" }); // closes before the run
    await job({ occ: "2136", at: "2026-11-16T07:00:00Z" }); // after the run time
    await job({ occ: "2136", at: "2026-11-14T12:00:00Z" }); // before the alert was made
    const cases: [AlertOpts, number[]][] = [
      [{}, [d, n, b, a]],
      [{ occ: "2136" }, [d, b, a]],
      [{ sector: "it" }, [d, n, a]],
      [{ county: "Cork" }, [n, b]],
      [{ salary: 40000 }, [d, a]],
      [{ salary: 0 }, [d, b, a]], // a minimum of 0 still needs a stated pay
      [{ badge: "sponsor_confirmed" }, [a]],
      [{ occ: "2136", sector: "it", county: "Dublin", salary: 41000, badge: "sponsor_confirmed" }, [a]],
      [{ occ: "2136", sector: "it", county: "Dublin", salary: 41000 }, [a]],
      [{ sector: "it' or '1'='1" }, []],
      [{ county: "Dublin\u202e" }, []], // a format character
    ];
    const cands: string[] = [];
    for (const [o] of cases) { const c = await cand(); cands.push(c); await alert(c, o); }
    await run(MON);
    for (const [i, [o, want]] of cases.entries()) expect(await jobsFor(cands[i]!), JSON.stringify(o)).toEqual(want.length ? [want] : []);
  });
  it("a job that closes and reopens is not sent again (its posted_at does not move)", async () => {
    const c = await cand();
    const j = await job();
    await alert(c);
    await run(MON);
    const before = (await su("select posted_at from job where id = $1", [j])).rows[0].posted_at;
    await su("update job set status = 'closed', close_reason = 'expired' where id = $1", [j]);
    await su("update job set status = 'live', close_reason = null, closed_at = null where id = $1", [j]);
    expect((await su("select status, posted_at from job where id = $1", [j])).rows[0]).toEqual({ status: "live", posted_at: before });
    expect(await run(TUE)).toMatchObject({ alerts_due: 1, candidates_queued: 0, rows_written: 0 });
    expect(await outbox(c)).toHaveLength(1);
  });
});

describe("which alerts are due", () => {
  it("daily every day; weekly only on a Monday; the same last_sent_at rule for both", async () => {
    const c1 = await cand(), c2 = await cand();
    await job();
    const daily = await alert(c1), weekly = await alert(c2, { frequency: "weekly" });
    expect(await run(TUE)).toMatchObject({ alerts_due: 1 });
    expect([await lastSent(daily), await lastSent(weekly)]).toEqual([TUE, null]);
    expect(await outbox(c2)).toHaveLength(0);
    expect(await run(WED)).toMatchObject({ alerts_due: 1 }); // daily again, weekly still waits
    expect(await lastSent(weekly)).toBeNull();
    const nextMon = new Date("2026-11-23T06:00:00Z");
    expect(await run(nextMon)).toMatchObject({ alerts_due: 2 });
    expect(await jobsFor(c2)).toHaveLength(1);
    expect(await run(new Date("2026-11-23T18:00:00Z"))).toMatchObject({ alerts_due: 0 }); // already sent this Monday
  });
  it("paused, unsubscribed, Stamp 4 paused, unverified, deleted, suspended and setting-off candidates get nothing; setting-on does", async () => {
    await job();
    const nothing = [
      [await cand(), { status: "paused", reason: "candidate" }], [await cand(), { status: "unsubscribed" }], [await cand(), { status: "paused", reason: "stamp_4" }],
      [await cand({ verified: false }), {}], [await cand({ deleted: new Date() }), {}], [await cand({ suspended: new Date() }), {}], [await cand(), {}],
    ] as const;
    const off = nothing[6][0], on = await cand();
    await su("insert into notification_preference(candidate_user_id, category, channel, enabled) values ($1, 'job_alerts', 'email', false), ($2, 'job_alerts', 'email', true), ($2, 'apply_reminders', 'email', false)", [off, on]);
    const ids: number[] = [];
    for (const [c, o] of nothing) ids.push(await alert(c, o));
    await alert(on);
    expect(await run(MON)).toEqual({ alerts_due: 1, candidates_queued: 1, rows_written: 1, alerts_paused: 0 });
    for (const [c] of nothing) expect(await outbox(c)).toHaveLength(0);
    for (const a of ids) expect(await lastSent(a)).toBeNull();
    expect(await outbox(on)).toHaveLength(1);
  });
});

describe("dormant candidates (C2)", () => {
  // MON is the run time; the setting alert_dormant is 90 days
  const ago = (d: number) => new Date(MON.getTime() - d * 864e5);
  const idle = async (d: number) => { const c = await cand(); await su("update candidate_user set last_active_at = $2 where id = $1", [c, ago(d)]); return c; };
  const state = async (id: number) => (await su("select status, pause_reason, last_sent_at from alert where id = $1", [id])).rows[0];

  it("an active candidate's alert is queued; a 91-day idle one is paused dormant with nothing queued; other pauses are left alone", async () => {
    await job();
    const active = await idle(10), edge = await idle(89), gone = await idle(91);
    const a1 = await alert(active), a2 = await alert(edge), a3 = await alert(gone), a4 = await alert(gone, { status: "paused", reason: "candidate" }),
      a5 = await alert(gone, { frequency: "weekly" }), a6 = await alert(gone, { status: "unsubscribed" });
    expect(await run(MON)).toEqual({ alerts_due: 2, candidates_queued: 2, rows_written: 2, alerts_paused: 2 });
    expect(await outbox(active)).toHaveLength(1);
    expect(await outbox(edge)).toHaveLength(1);
    expect(await outbox(gone)).toHaveLength(0);
    for (const a of [a3, a5]) expect(await state(a)).toEqual({ status: "paused", pause_reason: "dormant", last_sent_at: null });
    expect(await state(a4)).toMatchObject({ status: "paused", pause_reason: "candidate" });
    expect(await state(a6)).toMatchObject({ status: "unsubscribed", pause_reason: null });
    for (const a of [a1, a2]) expect(await lastSent(a)).toEqual(MON);
    const audit = (await su("select after from audit_event where action = 'job_alerts.run' order by id desc limit 1")).rows[0].after;
    expect(audit).toMatchObject({ alerts_paused: 2 });
    expect(await run(TUE)).toMatchObject({ alerts_paused: 0 }); // already paused: counted once
  });

  it("a null last_active_at is never dormant (as in retention); an empty setting pauses nobody", async () => {
    await job();
    const none = await cand(), old = await idle(100);
    await su("update candidate_user set last_active_at = null where id = $1", [none]);
    const a1 = await alert(old), a2 = await alert(none);
    await su("update setting set value = null where key = 'alert_dormant'");
    try {
      expect(await run(MON)).toMatchObject({ alerts_due: 2, alerts_paused: 0 });
    } finally { await su("update setting set value = 90 where key = 'alert_dormant'"); }
    expect(await run(TUE)).toMatchObject({ alerts_due: 1, alerts_paused: 1 });
    expect(await state(a1)).toMatchObject({ status: "paused", pause_reason: "dormant" });
    expect(await state(a2)).toMatchObject({ status: "active" });
  });

  it("a new last_active_at resumes only dormant pauses, of that candidate only, with new jobs counted from then", async () => {
    const me = await idle(200), other = await idle(200);
    const d1 = await alert(me), mine = await alert(me, { status: "paused", reason: "candidate" }), stamp = await alert(me, { status: "paused", reason: "stamp_4" });
    const unsub = await alert(me, { status: "unsubscribed" }), theirs = await alert(other);
    await run(MON);
    expect(await state(theirs)).toMatchObject({ pause_reason: "dormant" });
    // the C1 sign-in statement (packages/auth/src/index.ts), run as app_candidate
    await db.query("app_candidate", "update candidate_user set last_active_at = now() where id = $1", [me]);
    const back = await state(d1);
    expect(back).toMatchObject({ status: "active", pause_reason: null });
    expect(Math.abs(back.last_sent_at.getTime() - Date.now())).toBeLessThan(60_000);
    expect(await state(mine)).toMatchObject({ status: "paused", pause_reason: "candidate" });
    expect(await state(stamp)).toMatchObject({ status: "paused", pause_reason: "stamp_4" });
    expect(await state(unsub)).toMatchObject({ status: "unsubscribed" });
    expect(await state(theirs)).toMatchObject({ status: "paused", pause_reason: "dormant" });
    // an update that leaves last_active_at as it is, and a deleted candidate, resume nothing
    await su("update candidate_user set name = 'Fake' where id = $1", [other]);
    await su("update candidate_user set deleted_at = now(), last_active_at = now() where id = $1", [other]);
    expect(await state(theirs)).toMatchObject({ status: "paused", pause_reason: "dormant" });
  });

  it("no app role writes pause_reason dormant; keeping a reason already dormant is allowed", async () => {
    const c = await idle(200), a = await alert(c);
    await run(MON);
    for (const role of ["app_candidate", "app_portal", "app_admin", "app_fetcher"] as const) {
      const fresh = await alert(c);
      await expect(db.query(role, "update alert set status = 'paused', pause_reason = 'dormant' where id = $1", [fresh]), role).rejects.toThrow(/permission denied|alert guard/);
    }
    await expect(db.query("app_candidate", `insert into alert(candidate_user_id, frequency, status, pause_reason, unsubscribe_token) values ($1, 'daily', 'paused', 'dormant', $2)`,
      [c, f.id("tok").padEnd(40, "x")])).rejects.toThrow(/alert guard/);
    // the pause route's statement on an alert already paused dormant keeps the reason
    await db.query("app_candidate", "update alert set pause_reason = case when status = 'active' then 'candidate' else pause_reason end, status = case when status = 'active' then 'paused' else status end where id = $1", [a]);
    expect(await state(a)).toMatchObject({ status: "paused", pause_reason: "dormant" });
    await expect(db.query("app_candidate", "select private.alert_resume_dormant()")).rejects.toThrow(/permission denied/);
  });

  it("the 12-month retention warning still works for a candidate whose alerts are paused dormant", async () => {
    const c = await cand();
    await su("update candidate_user set last_active_at = now() - interval '13 months' where id = $1", [c]);
    const a = await alert(c);
    await queueAlerts(db.pool("app_admin")); // now(): dormant
    expect(await state(a)).toMatchObject({ pause_reason: "dormant" });
    for (let i = 0; i < 5; i++) {
      await db.query("app_admin", "select private.run_retention(1000)");
      if ((await su("select inactive_warned_at from candidate_user where id = $1", [c])).rows[0].inactive_warned_at) break;
    }
    expect((await su("select inactive_warned_at from candidate_user where id = $1", [c])).rows[0].inactive_warned_at).not.toBeNull();
    expect((await su("select template from email_outbox where candidate_user_id = $1", [c])).rows).toEqual([{ template: "inactive-warning" }]);
    expect(await state(a)).toMatchObject({ pause_reason: "dormant" }); // the warning is not activity
  });
});

describe("who may run it", () => {
  it("app_admin only: app_candidate, app_portal and app_fetcher are refused", async () => {
    for (const role of ["app_candidate", "app_portal", "app_fetcher"] as const)
      await expect(db.query(role, "select private.queue_job_alerts(now())"), role).rejects.toThrow(/permission denied/);
    await expect(db.query("app_admin", "select private.queue_job_alerts(now())")).resolves.toBeTruthy();
  });
  it("the command: one line of counts as app_admin, exit 1 for another login, exit 2 without the setting or with arguments", async () => {
    const lines: string[] = [];
    const env = (role: string) => ({ ALERTS_ADMIN_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
    expect(await main([], env("app_admin"), (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([expect.stringMatching(/^job alerts: \d+ alerts due, \d+ candidates queued, \d+ emails written, \d+ paused for dormancy$/)]);
    expect(await main([], env("app_portal"), (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toMatch(/^refused: permission denied/);
    expect(await main([], {}, (l) => lines.push(l))).toBe(2);
    expect(await main(["--now"], env("app_admin"), (l) => lines.push(l))).toBe(2);
  });
});

describe("performance", () => {
  it("5,000 alerts over 1,000 candidates and 500 new jobs: one statement, a loose time budget, and the jobs read through an index", async () => {
    await su(`insert into candidate_user(id, name, email, email_verified, created_at, updated_at)
      select 'perf-' || i, 'Fake', 'perf-' || i || '@example.test', true, now(), now() from generate_series(1, 1000) i`);
    const sectors = ["it", "health", "construction", "hospitality", "finance"], counties = ["Dublin", "Cork", "Galway", "Limerick"];
    // 5 alerts each: all jobs, a sector, a county, a minimum, a sector and county
    await su(`insert into alert(candidate_user_id, sector, county, salary_min, frequency, unsubscribe_token, created_at)
      select 'perf-' || c, case when k in (1, 4) then ($1::text[])[1 + c % 5] end, case when k in (2, 4) then ($2::text[])[1 + c % 4] end,
             case when k = 3 then 30000 + (c % 5) * 5000 end, 'daily', 'perf-token-' || c || '-' || k || repeat('x', 30), $3::timestamptz
        from generate_series(1, 1000) c, generate_series(0, 4) k`, [sectors, counties, BEFORE]);
    // 500 new jobs, and 4,500 older live jobs the run must not read
    await su(`insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, own_page_url, search_vector)
      select $1, 'admin_manual', $2, 'Fake job', 'Fake Org', ($4::text[])[1 + i % 4], ($3::text[])[1 + i % 5], 'critical_skills', 25000 + (i % 9) * 5000, 'live',
             timestamptz '2026-12-20', 'https://example.test/a', to_tsvector('english', 'cook') from generate_series(1, 5000) i`, [org, src, sectors, counties]);
    await su(`with j as (select id, row_number() over (order by id) n from job where status = 'live')
      update job set posted_at = case when j.n <= 500 then timestamptz '2026-11-15T12:00:00Z' + j.n * interval '1 second' else timestamptz '2026-10-01' end from j where job.id = j.id`);
    await su("analyze job; analyze alert; analyze candidate_user; analyze notification_preference");

    // The real plan of the function's statements, through auto_explain sent to this client as notices.
    const c = new pg.Client({ connectionString: urlFor(db.name, "postgres") });
    await c.connect();
    const plans: string[] = [];
    c.on("notice", (m) => plans.push(m.message ?? ""));
    let statements = 0;
    const counting = { query: (...a: Parameters<pg.Client["query"]>) => (statements++, (c.query as (...x: unknown[]) => unknown)(...a)) } as never;
    try {
      // auto_explain is preloaded in the test image (and on Supabase)
      await c.query("set auto_explain.log_min_duration = 0; set auto_explain.log_nested_statements = on; set auto_explain.log_level = notice");
      statements = 0;
      const t0 = Date.now();
      const r = await queueAlerts(counting, MON);
      const ms = Date.now() - t0;
      expect(statements).toBe(1);
      expect(r).toEqual({ alerts_due: 5000, candidates_queued: 1000, rows_written: 1000, alerts_paused: 0 });
      expect(ms).toBeLessThan(15_000);
    } finally { await c.end(); }
    const plan = plans.find((p) => p.includes("new_job")) ?? plans.join("\n");
    // the live jobs are read once through the index and kept (Materialize), not scanned again per alert
    expect(plan).toMatch(/Materialize .*\n\s*->  Index (Only )?Scan using job_live_newest on job j/);
    expect(plan).not.toMatch(/Seq Scan on job/);
    const max = (await su("select max(jsonb_array_length(a->'job_ids'))::int m from email_outbox, jsonb_array_elements(params->'alerts') a where template = 'job_alert'")).rows[0].m;
    expect(max).toBe(20);
  });
});
