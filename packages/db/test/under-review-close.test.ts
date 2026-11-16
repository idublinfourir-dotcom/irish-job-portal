// Integration (#93, migration 0027): the 30-day close of a job under review, the under_review_since column and its trigger, who may write the column,
// and that retention still treats the closed job as closed. Real test database; no network, no mail (email stays in the outbox). Fake data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOSE_UNDER_REVIEW, expireJobs, expiryLine, main as expiryMain } from "../src/job-expiry-cli";
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
async function company() {
  const org = Number(await F.org());
  const owner = Number(await F.member(org, await F.portal(), { role: "account_owner" }));
  return { org, owner };
}
const job = async (c: { org: number; owner: number }, o: Record<string, unknown> = {}) => String(await ins("postgres", "job", {
  organisation_id: c.org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org", sector: "IT", permit_type: "critical_skills",
  status: "live", closes_at: in30(), own_page_url: "https://example.test/apply", salary_low: 50000, search_vector: "x", posted_by_membership_id: c.owner, ...o }));
// The job went under review `days` days ago (the trigger stamped now(); the test sets the stamp back, which an update of that column alone does not re-stamp).
const underReview = async (c: { org: number; owner: number }, days: number, o: Record<string, unknown> = {}) => {
  const id = await job(c, o);
  await db.query("postgres", "update job set status = 'under_review' where id = $1", [id]);
  await db.query("postgres", "update job set under_review_since = now() - make_interval(days => $2, mins => 1) where id = $1", [id, days]);
  return id;
};
const state = async (id: string) => one("select status, close_reason, closed_at is not null as closed, under_review_since is not null as since from job where id = $1", [id]);
const close = async () => (await expireJobs(db.pool("app_admin"))).underReviewClosed;

describe("the under_review_since column", () => {
  it("is set when a job goes under review, kept while it stays, cleared when it leaves", async () => {
    const c = await company(), id = await job(c);
    expect((await state(id)).since).toBe(false);
    await db.query("postgres", "update job set status = 'under_review' where id = $1", [id]);
    const first = (await one("select under_review_since s from job where id = $1", [id])).s;
    expect(first).not.toBeNull();
    await db.query("postgres", "update job set title = 'Other title' where id = $1", [id]);
    await db.query("postgres", "update job set status = 'under_review' where id = $1", [id]); // a second write of the same status keeps the first stamp
    expect((await one("select under_review_since s from job where id = $1", [id])).s).toEqual(first);
    await db.query("postgres", "update job set status = 'live' where id = $1", [id]);
    expect((await state(id)).since).toBe(false);
  });
  it("is set on an insert straight to under_review too, and never on any other status", async () => {
    const c = await company();
    expect((await state(await job(c, { status: "under_review" }))).since).toBe(true);
    for (const status of ["live", "draft", "in_review"]) expect((await state(await job(c, { status }))).since).toBe(false);
  });
});

describe("the daily 30-day close", () => {
  it("closes a job under review for 30 days as under_review_expired; 29 days, a restored job and other statuses are left alone", async () => {
    const c = await company(), d = await company();
    const old = await underReview(c, 30), older = await underReview(d, 90), young = await underReview(c, 29);
    const restored = await underReview(c, 40);
    await db.query("postgres", "update job set status = 'live' where id = $1", [restored]); // the employer edited the salary: live, stamp cleared
    const live = await job(c), draft = await job(c, { status: "draft" }), hidden = await job(c, { status: "hidden", hidden_reason: "admin" }), inReview = await job(c, { status: "in_review" });
    expect(await close()).toBe(2);
    for (const id of [old, older]) expect(await state(id)).toEqual({ status: "closed", close_reason: "under_review_expired", closed: true, since: false });
    expect((await state(young)).status).toBe("under_review");
    expect((await state(restored)).status).toBe("live");
    expect(await Promise.all([live, draft, hidden, inReview].map(async (id) => (await state(id)).status))).toEqual(["live", "draft", "hidden", "in_review"]);
    expect(await close()).toBe(0); // a second run finds nothing
  });
  it("never touches a fetched job, even one stamped long ago", async () => {
    const c = await company();
    const fetchedSrc = Number((await one("insert into job_source(kind, board) values ('board', 'fake-board-ur') returning id")).id);
    const f = String(await ins("postgres", "job", { organisation_id: c.org, source: "fetched", job_source_id: fetchedSrc, title: "Fake", employer_name: "Fake", sector: "IT", permit_type: "critical_skills",
      status: "under_review", closes_at: in30(), own_page_url: "https://example.test/f", salary_low: 1000, search_vector: "x" }));
    await db.query("postgres", "update job set under_review_since = now() - interval '90 days' where id = $1", [f]);
    expect(await close()).toBe(0);
    expect((await state(f)).status).toBe("under_review");
  });
  it("is one statement that app_admin runs, and the command prints its count", async () => {
    const c = await company();
    await underReview(c, 31);
    const lines: string[] = [];
    expect(await expiryMain([], { EXPIRY_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" }, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toMatch(/, 1 jobs closed after 30 days under review$/);
    const due = await underReview(c, 31); // the other roles' tries all fail: the portal and candidate sites cannot read the column, the fetcher's write is refused by job_guard
    for (const role of ["app_portal", "app_candidate", "app_fetcher"] as const) await rule({ refuse: () => db.query(role, CLOSE_UNDER_REVIEW) });
    expect((await state(due)).status).toBe("under_review");
  });
  it("closed after 30 days under review is a closed job for retention (#99): closed_at is set and rule closed_job_unreferenced picks it up", async () => {
    const c = await company();
    const id = await underReview(c, 31), still = await underReview(c, 5);
    await close();
    expect((await state(id)).closed).toBe(true);
    await db.query("postgres", "update job set closed_at = now() - interval '2 years' where id = $1", [id]);
    const due = (await one("select due from private.retention_rules() where key = 'closed_job_unreferenced'")).due as string;
    const ids = (await db.query("postgres", due, [1])).rows.map((r) => r.id);
    expect(ids).toContain(id);
    expect(ids).not.toContain(still);
  });
  it("the log line", () => {
    expect(expiryLine({ closed: 2, reminded: 3, underReviewClosed: 4 })).toBe("2 employer jobs closed as expired, 3 expiry reminders queued, 4 jobs closed after 30 days under review");
  });
});

describe("who may write the column (security)", () => {
  it("the portal, the candidate site and the fetcher cannot write it, and the portal and candidate sites cannot read it", async () => {
    const c = await company(), id = await underReview(c, 3);
    for (const role of ["app_portal", "app_candidate", "app_fetcher"] as const) {
      await rule({ refuse: () => db.query(role, "update job set under_review_since = now() - interval '60 days' where id = $1", [id]), expect: "permission denied" });
      await rule({ refuse: () => db.query(role, "insert into job(under_review_since) values (now())"), expect: "permission denied" });
    }
    for (const role of ["app_portal", "app_candidate"] as const) await rule({ refuse: () => db.query(role, "select under_review_since from job limit 1"), expect: "permission denied" });
    const s = await one("select under_review_since is not null as since from job where id = $1", [id]);
    expect(s.since).toBe(true);
  });
  it("the portal cannot move a job out of under review without a pay change; with one the job is live and the stamp is cleared", async () => {
    const c = await company(), id = await underReview(c, 3);
    await rule({ refuse: () => db.query("app_portal", "update job set status = 'live' where id = $1", [id]), expect: "may not move a job" });
    await rule({ ok: () => db.query("app_portal", "update job set salary_low = 70000, status = 'live', posted_by_membership_id = $2 where id = $1", [id, c.owner]) });
    expect((await state(id)).since).toBe(false);
  });
});
