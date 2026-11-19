// Migration 0019 on the test database: the poster check in job_guard (D8), private.portal_jobs, private.expire_employer_jobs (D7) with its
// command, and the placeholder statement texts command. Fake data only; no test calls the real network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { savePostingTexts, POSTING_TEXT_VERSION } from "../src/posting-texts-cli";
import { main as expiryMain } from "../src/job-expiry-cli";
import { createTestDb, rule, urlFor, type TestDb } from "./db";
import { fixtures, in30 } from "./fixtures";

let db: TestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any, ins: any;
let src: number;
beforeAll(async () => {
  db = await createTestDb();
  ({ F, ins } = fixtures(db) as never);
  src = Number((await db.query("postgres", "select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id);
});
afterAll(() => db.drop());

const one = async (sql: string, args: unknown[] = []) => (await db.query("postgres", sql, args)).rows[0];
const row = (org: number, o: Record<string, unknown> = {}) => ({ organisation_id: org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org",
  sector: "IT", permit_type: "critical_skills", status: "draft", closes_at: in30(), own_page_url: "https://example.test/apply", salary_low: 50000, ...o });
async function company() {
  const org = Number(await F.org());
  const m = async (role: string, status = "active") => Number(await F.member(org, await F.portal(), { role, status }));
  return { org, owner: await m("account_owner"), recruiter: await m("recruiter"), poster: await m("poster"), viewer: await m("viewer") };
}

describe("job_guard: the poster check (D8)", () => {
  it("a portal write needs an active poster, recruiter or owner of the job's own company", async () => {
    const c = await company(), other = await company();
    for (const m of [c.owner, c.recruiter, c.poster]) expect(Number(await ins("app_portal", "job", row(c.org, { posted_by_membership_id: m })))).toBeGreaterThan(0);
    const removed = Number(await F.member(c.org, await F.portal(), { role: "poster" }));
    await db.query("postgres", "update membership set status = 'removed', removed_at = now() where id = $1", [removed]);
    for (const m of [c.viewer, removed, null]) await rule({ refuse: () => ins("app_portal", "job", row(c.org, { posted_by_membership_id: m })), expect: "active poster, recruiter or account owner" });
    // another company's member: refused (the foreign key would refuse too, the guard first)
    await rule({ refuse: () => ins("app_portal", "job", row(c.org, { posted_by_membership_id: other.owner })) });
  });
  it("an update is checked too: a job whose poster left must name a member who is still active", async () => {
    const c = await company();
    const j = await ins("app_portal", "job", row(c.org, { posted_by_membership_id: c.poster }));
    await db.query("postgres", "update membership set status = 'removed', removed_at = now() where id = $1", [c.poster]);
    await rule({ refuse: () => db.query("app_portal", "update job set title = 'x' where id = $1", [j]), expect: "active poster" });
    await rule({ ok: () => db.query("app_portal", "update job set title = 'x', posted_by_membership_id = $2 where id = $1", [j, c.recruiter]) });
    await rule({ refuse: () => db.query("app_portal", "update job set title = 'y', posted_by_membership_id = $2 where id = $1", [j, c.viewer]), expect: "active poster" });
  });
  it("other roles are not affected: staff and the owner role write without a member", async () => {
    const c = await company();
    await rule({ ok: () => ins("app_admin", "job", row(c.org, { source: "admin_manual" })) });
    await rule({ ok: () => ins("postgres", "job", row(c.org)) });
  });
  it("the portal can read and write weekly_hours, 1 to 60", async () => {
    const c = await company();
    await rule({ ok: () => ins("app_portal", "job", row(c.org, { posted_by_membership_id: c.owner, weekly_hours: 40 })) });
    for (const h of [0, 61]) await rule({ refuse: () => ins("app_portal", "job", row(c.org, { posted_by_membership_id: c.owner, weekly_hours: h })), expect: "job_weekly_hours_check" });
  });
});

describe("portal_jobs", () => {
  it("lists only the login's own company's employer jobs, with the reason a job is held", async () => {
    const c = await company(), other = await company();
    const live = await ins("postgres", "job", row(c.org, { status: "live", search_vector: "'x':1" }));
    const review = await ins("postgres", "job", row(c.org, { status: "in_review", search_vector: "'x':1" }));
    const hidden = await ins("postgres", "job", row(c.org, { status: "hidden", hidden_reason: "admin", search_vector: "'x':1" }));
    const under = await ins("postgres", "job", row(c.org, { status: "under_review", search_vector: "'x':1" }));
    const theirs = await ins("postgres", "job", row(other.org, { status: "live", search_vector: "'x':1" }));
    const viewerUser = (await one("select portal_user_id from membership where id = $1", [c.viewer])).portal_user_id;
    const jobs = (await db.query("app_portal", "select private.portal_jobs($1) r", [viewerUser])).rows[0].r as { id: number; reason: string | null }[];
    const by = new Map(jobs.map((j) => [Number(j.id), j]));
    expect(by.has(Number(theirs))).toBe(false);
    expect(by.get(Number(live))!.reason).toBeNull();
    expect(by.get(Number(review))!.reason).toBe("staff_check"); // the insert queued a scam_flag item
    expect(by.get(Number(hidden))!.reason).toBe("admin");
    expect(by.get(Number(under))!.reason).toBe("pay_check");
    expect(JSON.stringify(jobs)).not.toMatch(/staff_user|report_id|hidden_report/);
  });
  it("refuses a login with no active membership", async () => {
    const lone = await F.portal();
    await rule({ refuse: () => db.query("app_portal", "select private.portal_jobs($1)", [lone]), expect: "NOT_A_MEMBER" });
    await rule({ refuse: () => db.query("app_portal", "select private.portal_jobs($1)", ["nobody"]), expect: "REFUSED" });
  });
  it("only app_portal may run it, only app_admin the expiry", async () => {
    for (const r of ["app_candidate", "app_fetcher", "app_admin"] as const) await rule({ refuse: () => db.query(r, "select private.portal_jobs('x')"), expect: "permission denied" });
    for (const r of ["app_candidate", "app_fetcher", "app_portal"] as const) await rule({ refuse: () => db.query(r, "select private.expire_employer_jobs()"), expect: "permission denied" });
  });
});

describe("expire_employer_jobs (D7)", () => {
  it("closes employer jobs past day 30 with the right reason, and leaves the rest", async () => {
    const c = await company();
    const past = "now() - interval '1 minute'";
    const mk = async (o: Record<string, unknown>) => {
      const id = await ins("postgres", "job", row(c.org, { search_vector: "'x':1", ...o }));
      await db.query("postgres", `update job set closes_at = ${past} where id = $1`, [id]);
      return Number(id);
    };
    const live = await mk({ status: "live" }), rev = await mk({ status: "in_review" }), under = await mk({ status: "under_review" });
    const hidden = await mk({ status: "hidden", hidden_reason: "admin" }), draft = await mk({ status: "draft" });
    const fetched = Number(await ins("postgres", "job", row(c.org, { source: "fetched", status: "live", badge: "critical_skills_eligible", search_vector: "'x':1", closes_at: "infinity" })));
    const fresh = Number(await ins("postgres", "job", row(c.org, { status: "live", search_vector: "'x':1" })));
    const r = (await db.query("app_admin", "select private.expire_employer_jobs() r")).rows[0].r;
    expect(r.closed).toBeGreaterThanOrEqual(3);
    const state = async (id: number) => one("select status, close_reason, closed_at is not null as at from job where id = $1", [id]);
    expect(await state(live)).toEqual({ status: "closed", close_reason: "expired", at: true });
    expect(await state(rev)).toEqual({ status: "closed", close_reason: "expired", at: true });
    expect(await state(under)).toEqual({ status: "closed", close_reason: "under_review_expired", at: true });
    for (const id of [hidden, draft, fetched, fresh]) expect((await state(id)).status).not.toBe("closed");
  });
  it("queues one reminder 3 days before the end, to the poster or else the owner, and again after a renewal", async () => {
    const c = await company();
    const soon = async (by: number | null) => {
      const id = Number(await ins("postgres", "job", row(c.org, { status: "live", search_vector: "'x':1", posted_by_membership_id: by })));
      await db.query("postgres", "update job set closes_at = now() + interval '2 days' where id = $1", [id]);
      return id;
    };
    const byPoster = await soon(c.poster), byNobody = await soon(null);
    const later = Number(await ins("postgres", "job", row(c.org, { status: "live", search_vector: "'x':1", posted_by_membership_id: c.poster })));
    const sent = (job: number) => db.query("postgres", "select portal_user_id, template, params from email_outbox where params->>'jobId' = $1", [String(job)]).then((x) => x.rows);
    await db.query("app_admin", "select private.expire_employer_jobs()");
    await db.query("app_admin", "select private.expire_employer_jobs()"); // a second run the same day adds nothing
    const user = async (m: number) => (await one("select portal_user_id from membership where id = $1", [m])).portal_user_id;
    expect((await sent(byPoster)).map((x) => x.portal_user_id)).toEqual([await user(c.poster)]);
    expect((await sent(byNobody)).map((x) => x.portal_user_id)).toEqual([await user(c.owner)]);
    expect((await sent(byPoster))[0].template).toBe("job_expiry_reminder");
    expect(await sent(later)).toEqual([]);
    // renewed: a new end, so a new reminder before it
    await db.query("postgres", "update job set closes_at = now() + interval '1 day' where id = $1", [byPoster]);
    await db.query("app_admin", "select private.expire_employer_jobs()");
    expect(await sent(byPoster)).toHaveLength(2);
    // the poster left and no owner is active: nobody to tell, nothing queued
    await db.query("postgres", "update membership set status = 'removed', removed_at = now() where organisation_id = $1", [c.org]);
    const orphan = await soon(null);
    await db.query("app_admin", "select private.expire_employer_jobs()");
    expect(await sent(orphan)).toEqual([]);
  });
  it("the command runs it as app_admin and refuses without its setting", async () => {
    const lines: string[] = [];
    expect(await expiryMain([], { EXPIRY_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" }, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toMatch(/^\d+ employer jobs closed as expired, \d+ expiry reminders queued, \d+ jobs closed after 30 days under review, \d+ pay floors ended, \d+ pay floor reminders queued$/);
    expect(await expiryMain([], {}, (l) => lines.push(l))).toBe(2);
    expect(await expiryMain(["x"], {}, (l) => lines.push(l))).toBe(2);
    expect(await expiryMain([], { EXPIRY_ADMIN_DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable" }, (l) => lines.push(l))).toBe(1); // the portal login is refused
  });
  it("budget: 2,000 open employer jobs, 200 due, one run under 500 ms", async () => {
    const c = await company();
    await db.query("postgres", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector)
      select $1, 'employer', $2, 'Fake', 'Fake', 'IT', 'critical_skills', 'live', now() + (g % 30) * interval '1 day' + interval '1 hour', 'https://example.test', 50000, 'x'
        from generate_series(1, 2000) g`, [c.org, src]);
    await db.query("postgres", "update job set closes_at = now() - interval '1 minute' where id in (select id from job where organisation_id = $1 order by id limit 200)", [c.org]);
    await db.query("postgres", "analyze job");
    const t = performance.now();
    const r = (await db.query("app_admin", "select private.expire_employer_jobs() r")).rows[0].r;
    const ms = performance.now() - t;
    expect(r.closed).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(500);
    console.log(`expiry budget: closed ${r.closed}, reminded ${r.reminded}, ${ms.toFixed(1)} ms`);
  });
});

describe("the placeholder statement texts", () => {
  it("app_admin saves both texts with no approval, once; a second run writes nothing", async () => {
    const c = await db.pool("app_admin").connect();
    try {
      expect(await savePostingTexts(c)).toEqual(["sponsorship_statement", "pay_floor"]);
      expect(await savePostingTexts(c)).toEqual([]);
    } finally { c.release(); }
    const rows = (await db.query("postgres", "select purpose, version, approval_request_id from consent_text where purpose in ('sponsorship_statement','pay_floor') order by purpose")).rows;
    expect(rows).toEqual([{ purpose: "pay_floor", version: POSTING_TEXT_VERSION, approval_request_id: null }, { purpose: "sponsorship_statement", version: POSTING_TEXT_VERSION, approval_request_id: null }]);
  });
});
