// Integration: step 15 staff tools D through the admin app's real route handlers, the real daily command and the real outbox sender, on the real test
// database as app_admin with real staff sessions. Q8 the accuracy sample (/api/accuracy-sample), the fetched-queue decisions (/api/fetched-jobs/decisions)
// and the #74 counts (/api/targets); Q11 the member's counts (/api/staff/me/counts), the report alert (0053) and the daily digest (staff-digest-cli.ts);
// Q15 the invite (/api/staff, action invite) with its set-password email through the staff auth's Brevo sender, a fetch fake. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sendPending } from "../src/outbox-cli";
import { STAFF_COUNTS } from "../src/staff-counts";
import { DIGEST_STAFF, main as digestMain, writeDigest } from "../src/staff-digest-cli";
import { DECISIONS, SAMPLE_MAKE, SAMPLE_READ, TARGET_COUNTS } from "../src/staff-tools";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { assertPageBudget, measurePages } from "./perf/pages";
import { BASE, counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements per call through the route (requireStaff is 2, the role check 1): sample 5 (make, read), decisions 4, targets 4, counts 4; an invite is
// begin, role check, the login, the grant (2), audit, commit, then the reset (Better Auth: the user and its accounts 2, the token 1) = 12; a resend is
// 2 + begin, role check, the locked login with its count, audit, commit + the reset 3 = 10. The digest command is
// 1 + one per staff member + 1. Measured 19 Nov 2026 on the bulk rows below (about 2,200 live jobs, 500 decided fetched items with 1.8 kB adverts):
// medians sample 6.6 ms, decisions 5.2, targets 4.1, counts 4.3, invite 5.8, digest 12.8 (19 staff); pages sample make 102, sample read 116, decisions
// 734 (the 50 adverts' text), targets 193, counts 79. Page limits about 3 times them (decisions 2 times); time limits about 5 times, as the machine
// runs other test files at once (a load of 19 on 12 cores tripled the medians). Raise these only on purpose.
const BUDGET = {
  sample: 5, decisions: 4, targets: 4, counts: 4, invite: 12, resend: 10, ms: 35, inviteMs: 40, cliMs: 65,
  pages: { sampleMake: 300, sampleRead: 350, decisions: 1500, targets: 600, counts: 250 },
};

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
let F: { org(o?: object): Promise<string>; cand(o?: object): Promise<string> }, uid: (p: string) => string;
const routes: Record<string, Route> = {};
const spec = loadSpec("admin");
const call = (path: string, who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(routes[path]!, path, who, body, o);
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);
const mail: { url: string; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let brevoDown = false;
const PATHS = ["/api/accuracy-sample", "/api/fetched-jobs/decisions", "/api/targets", "/api/staff/me/counts"];

beforeAll(async () => {
  // Brevo on for the staff pool, with fetch as a fake: set before the staff auth is first built (it reads the settings once).
  Object.assign(process.env, { BREVO_API_KEY: "xkeysib-test-only", EMAIL_FROM: "no-reply@account.example.ie" });
  vi.stubGlobal("fetch", (async (url: string, init: RequestInit) => brevoDown ? new Response("{}", { status: 500 }) : (mail.push({ url, body: JSON.parse(init.body as string) }), new Response("{}", { status: 201 }))) as unknown as typeof fetch);
  db = await createTestDb();
  ({ F, id: uid } = fixtures(db) as unknown as { F: typeof F; id: typeof uid });
  h = await staffHarness(db);
  su = h.su;
  for (const p of [...PATHS, "/api/staff", "/api/fetched-jobs"]) routes[p] = await import(/* @vite-ignore */ `../../../apps/admin/app/api/${p.slice(5)}/route`);
  await oneOfEachRole(h);
  await h.makeStaff("ad2", ["administrator"]);
  await h.makeStaff("ts2", ["trust_and_safety"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await h.makeStaff("tsoff", ["trust_and_safety"]);
  await su.query("update staff_user set status = 'disabled' where id = any($1)", [[h.staff.disabled, h.staff.tsoff]]);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let org: string, src: string;
async function liveJobs(n: number, title = "Fake live job") {
  org ??= await F.org();
  src ??= (await su.query("insert into job_source(kind, board) values ('portal', 'fake-d') returning id")).rows[0].id;
  await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
    select $1, 'admin_manual', $2, $3 || ' ' || g, 'Fake Employer', 'IT', '2134', 'critical_skills', 'live', 'infinity', to_tsvector('english', 'fake'), 'https://jobs.example.test/' || g
    from generate_series(1, $4::int) g`, [org, src, title, n]);
}
/** A fetched job the fetcher queued (its trigger makes the fetched_job item), as in fetched-jobs-route.test.ts. */
async function queued(title: string) {
  const s = (await su.query("insert into job_source(kind, board) values ('greenhouse', $1) returning id", [uid("b")])).rows[0].id;
  const advert = (await su.query("insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason, quoted_evidence) " +
    "values ($1, $2, 'https://jobs.example.test/f', $3, 'Acme Widgets', 'queued', '7 contract unclear (admin queue)', 'title', 'a fixed-term role') returning id::text", [s, uid("x"), title])).rows[0].id;
  const job = (await su.query(`insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
    values ($1, 'fetched', $2, $3, $4, 'Acme Widgets', 'Dublin', 'IT', '2134', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', $4), 'https://jobs.example.test/f') returning id::text`,
    [await F.org(), s, advert, title])).rows[0].id as string;
  await su.query("insert into job_text(job_id, advert_text) values ($1, 'Fake advert text for the test set.')", [job]);
  return { job, item: (await su.query("select id::text from review_item where queue = 'fetched_job' and job_id = $1", [job])).rows[0].id as string };
}

describe("every new route: signed out, a forged session, a disabled login and an unknown query key are refused", () => {
  it("answers 401 and 400", async () => {
    for (const p of PATHS) {
      await no(call(p, null), 401, "no_session");
      await no(call(p, "disabled"), 401, "not_active");
      await no(call(p, null, undefined, { cookie: "staff.session_token=forged" }), 401, "no_session");
      await no(call(p, "only_administrator", undefined, { query: "?x=1" }), 400, "bad_query");
    }
    await no(call("/api/staff", null, { action: "invite", email: "a@example.test", name: "A", role: "content_editor" }), 401, "no_session");
  });
});

describe("Q8: the monthly accuracy sample", () => {
  it("with no live job nothing is made", async () => {
    const r = await call("/api/accuracy-sample", "only_fetched_job_reviewer");
    expect([r.status, r.json, replyProblems(spec, "GET", "/api/accuracy-sample", r.status, r.json)]).toEqual([200, { key: null, createdAt: null, jobs: [] }, []]);
    expect((await su.query("select count(*)::int n from review_item where queue = 'scheduled_check'")).rows[0].n).toBe(0);
  });
  it("makes 100 random live jobs once, the same on every reload and for every reader, kept on this month's hand_check_100 reminder", async () => {
    await liveJobs(150);
    const first = await ok(call("/api/accuracy-sample", "only_fetched_job_reviewer"));
    expect(replyProblems(spec, "GET", "/api/accuracy-sample", 200, first)).toEqual([]);
    expect(first.jobs).toHaveLength(100);
    expect(new Set(first.jobs.map((j: { id: string }) => j.id)).size).toBe(100);
    expect(first.key).toMatch(/^hand_check_100:\d{4}-\d\d$/);
    expect(first.jobs[0]).toMatchObject({ employerName: "Fake Employer", sourceUrl: expect.stringMatching(/^https:\/\/jobs\.example\.test\//), source: "admin_manual", status: "live", permitType: "critical_skills", approvedByYou: false });
    await liveJobs(50, "Later job"); // more live jobs later in the month change nothing
    for (const who of ["only_fetched_job_reviewer", "only_rules_data_editor", "only_trust_and_safety", "only_administrator"])
      expect((await ok(call("/api/accuracy-sample", who))).jobs.map((j: { id: string }) => j.id), who).toEqual(first.jobs.map((j: { id: string }) => j.id));
    // the daily reminders command keeps it: its insert skips the key
    const { main } = await import("../src/scheduled-checks-cli");
    expect(await main([], { SCHEDULED_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" }, () => {})).toBe(0);
    expect((await ok(call("/api/accuracy-sample", "only_administrator"))).jobs).toHaveLength(100);
    const rem = (await su.query("select detail, status from review_item where queue = 'scheduled_check' and reason = 'hand_check_100'")).rows;
    expect(rem).toHaveLength(1);
    expect(rem[0].detail).toMatchObject({ key: first.key, role: "fetched_job_reviewer" });
    expect(rem[0].detail.jobIds).toEqual(first.jobs.map((j: { id: string }) => j.id));
  });
  it("marks a job the reader approved in the queue", async () => {
    const sample = (await ok(call("/api/accuracy-sample", "only_fetched_job_reviewer"))).jobs;
    await su.query("insert into review_item(queue, job_id, status, outcome, decided_by_staff_user_id, decided_at) values ('fetched_job', $1, 'done', 'approved', $2, now())", [sample[3].id, h.staff.only_fetched_job_reviewer]);
    const again = (await ok(call("/api/accuracy-sample", "only_fetched_job_reviewer"))).jobs;
    expect(again.filter((j: { approvedByYou: boolean }) => j.approvedByYou).map((j: { id: string }) => j.id)).toEqual([sample[3].id]);
    expect((await ok(call("/api/accuracy-sample", "only_administrator"))).jobs.some((j: { approvedByYou: boolean }) => j.approvedByYou)).toBe(false);
  });
  it("refuses every other role", async () => {
    for (const who of ["only_account_reviewer", "only_services_case_handler", "only_content_editor", "norole"]) await no(call("/api/accuracy-sample", who), 403, "not_sample_staff");
  });
});

describe("Q8: the fetched-queue decisions as labelled rows", () => {
  let rejected: { job: string; item: string }, approved: { job: string; item: string };
  it("exports a rejection made through the queue route with its reason code, and an approval, oldest first; never an open item", async () => {
    rejected = await queued("Fixed-term Platform Engineer");
    approved = await queued("Senior Data Engineer");
    await queued("Still open Engineer");
    await h.makeStaff("jr2", ["fetched_job_reviewer"]);
    await ok(call("/api/fetched-jobs", "jr2", { action: "claim", itemId: rejected.item }));
    await ok(call("/api/fetched-jobs", "jr2", { action: "reject", itemId: rejected.item, reason: "not_permanent" }));
    await su.query("update review_item set status = 'done', outcome = 'approved', decided_by_staff_user_id = $2, decided_at = now() where id = $1", [approved.item, h.staff.jr2]);
    const r = await call("/api/fetched-jobs/decisions", "only_rules_data_editor");
    expect([r.status, replyProblems(spec, "GET", "/api/fetched-jobs/decisions", r.status, r.json)]).toEqual([200, []]);
    const mine = r.json.items.filter((i: { jobId: string }) => [rejected.job, approved.job].includes(i.jobId));
    expect(mine.map((i: { label: string; reasonCode: string | null }) => [i.label, i.reasonCode])).toEqual([["rejected", "not_permanent"], ["approved", null]]);
    expect(mine[0]).toMatchObject({ itemId: rejected.item, title: "Fixed-term Platform Engineer", sourceUrl: "https://jobs.example.test/f", stage: "7 contract unclear (admin queue)",
      reason: "title", quotedEvidence: "a fixed-term role", advertText: "Fake advert text for the test set.", occupationCode: "2134", county: "Dublin" });
    expect(r.json.items.every((i: { label: string }) => ["approved", "rejected"].includes(i.label))).toBe(true);
    expect(r.json.next).toBeNull();
  });
  it("pages by item id", async () => {
    const all = (await ok(call("/api/fetched-jobs/decisions", "only_administrator"))).items.map((i: { itemId: string }) => i.itemId);
    const after = await ok(call("/api/fetched-jobs/decisions", "only_fetched_job_reviewer", undefined, { query: `?after=${all[0]}` }));
    expect(after.items.map((i: { itemId: string }) => i.itemId)).toEqual(all.slice(1));
  });
  it("refuses other roles and hostile cursors", async () => {
    for (const who of ["only_account_reviewer", "only_trust_and_safety", "only_services_case_handler", "only_content_editor", "norole"]) await no(call("/api/fetched-jobs/decisions", who), 403, "not_decision_staff");
    for (const q of ["abc", "-1", "0x10", "1 or 1=1", "99999999999999999999", "", "1'%3B--"]) await no(call("/api/fetched-jobs/decisions", "only_administrator", undefined, { query: `?after=${q}` }), 400, "bad_cursor");
    await no(call("/api/fetched-jobs/decisions", "only_administrator", undefined, { query: "?after=1&after=2" }), 400, "bad_query");
  });
});

describe("Q8: the #74 target counts", () => {
  it("counts weekly active candidates, the taps, hires, live jobs and reports per 1,000 live jobs, for any role, aggregates only", async () => {
    const active = await F.cand(), old = await F.cand(), gone = await F.cand({ deleted: new Date() });
    await su.query("update candidate_user set last_active_at = case id when $1 then now() - interval '1 day' when $2 then now() - interval '20 days' else now() end where id = any($3)", [active, old, [active, old, gone]]);
    const job = (await su.query("select id from job where status = 'live' order by id limit 3")).rows.map((r) => r.id);
    await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1, $3, 'redirect', 'did_you_apply_yes', 'applied'), ($1, $4, 'redirect', 'did_you_apply_yes', 'applied'), ($2, $3, 'redirect', 'mark_applied', 'applied')", [active, old, job[0], job[1]]);
    await su.query("update job set hire_answer = 'yes', hire_answered_at = now() where id = $1", [job[2]]);
    await su.query("insert into report(target_kind, target_job_id, reason, created_at) values ('job', $1, 'other', now()), ('job', $1, 'other', now() - interval '40 days')", [job[0]]);
    const live = (await su.query("select count(*)::int n from job where status = 'live'")).rows[0].n;
    for (const who of ROLE_NAMES.map((r) => `only_${r}`)) {
      const r = await call("/api/targets", who);
      expect([r.status, replyProblems(spec, "GET", "/api/targets", r.status, r.json)], who).toEqual([200, []]);
      expect(r.json).toEqual({ weeklyActiveCandidates: 1, yesIApplied: 2, markApplied: 1, hires: 1, hiredOnSite: 0, liveJobs: live, reports30Days: 1, reportsPer1000LiveJobs: Math.round(10_000 / live) / 10 });
    }
    await no(call("/api/targets", "norole"), 403, "no_role");
  });
  it("the admin login reads only the counted columns of the candidate tables (0053)", async () => {
    const a = db.pool("app_admin");
    await expect(a.query("select candidate_user_id from tracker_entry limit 1")).rejects.toThrow(/permission denied/);
    await expect(a.query("select cover_note from application limit 1")).rejects.toThrow(/permission denied/);
    await expect(a.query("select * from tracker_entry limit 1")).rejects.toThrow(/permission denied/);
  });
});

describe("Q11: the report alert, the member's counts and the daily digest", () => {
  const staffRows = async (template: string) => (await su.query("select staff_user_id s, params, status from email_outbox where template = $1 order by staff_user_id", [template])).rows;
  it("a report from a candidate or an employer queues one email for each active trust_and_safety member, at most one an hour each", async () => {
    const [job] = (await su.query("select id from job where status = 'live' order by id desc limit 1")).rows.map((r) => r.id);
    const cand = await F.cand();
    await db.pool("app_candidate").query("insert into report(target_kind, target_job_id, reporter_candidate_user_id, reason) values ('job', $1, $2, 'asks_for_money')", [job, cand]);
    const ts = [h.staff.only_trust_and_safety, h.staff.ts2].sort();
    expect((await staffRows("staff_report_new")).map((r) => [r.s, r.params, r.status])).toEqual(ts.map((s) => [s, null, "pending"]));
    await db.pool("app_portal").query("insert into report(target_kind, target_job_id, reason) values ('job', $1, 'no_sponsorship')", [job]);
    expect((await staffRows("staff_report_new")).length).toBe(2); // the same hour: no second email
    // the reporter's login still cannot queue staff email itself, nor read the staff roles
    await expect(db.pool("app_candidate").query("insert into email_outbox(template, staff_user_id) values ('x', $1)", [ts[0]])).rejects.toThrow(/own side/);
    await expect(db.pool("app_candidate").query("select 1 from staff_role limit 1")).rejects.toThrow(/permission denied/);
  });
  it("each member sees the counts their roles cover; null for the rest", async () => {
    const counts = async (who: string) => { const r = await call("/api/staff/me/counts", who); expect([r.status, replyProblems(spec, "GET", "/api/staff/me/counts", r.status, r.json)], who).toEqual([200, []]); return r.json; };
    const ts = await counts("only_trust_and_safety");
    expect(ts).toEqual({ queues: {}, reportsOpen: 4, reportsNew: 3, appeals: 0, contact: null, approvals: null }); // the 40-day-old report is still open
    expect(await counts("only_fetched_job_reviewer")).toEqual({ queues: { fetched_job: 1, scheduled_check: 1 }, reportsOpen: null, reportsNew: null, appeals: null, contact: null, approvals: null });
    expect((await counts("only_rules_data_editor")).queues).toEqual({ scheduled_check: 2 }); // the DETE notice check and the 6-monthly review
    const pending = (await ok(call("/api/staff", "ad2", { action: "propose_role", staffId: h.staff.norole, role: "content_editor" }))).requestId;
    expect(await counts("only_administrator")).toMatchObject({ reportsOpen: null, appeals: 0, contact: 0, approvals: 1 });
    expect((await counts("ad2")).approvals).toBe(0); // their own proposal is not waiting for them
    expect(await counts("only_content_editor")).toEqual({ queues: {}, reportsOpen: null, reportsNew: null, appeals: null, contact: 0, approvals: null });
    expect(await counts("norole")).toEqual({ queues: {}, reportsOpen: null, reportsNew: null, appeals: null, contact: null, approvals: null });
    await ok(call("/api/staff", "ad2", { action: "refuse_role", requestId: pending }));
  });
  it("the daily digest writes one row per active member with work waiting, only numbers, once a day; the outbox sends it with the alert", async () => {
    const env = { DIGEST_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" };
    const out: string[] = [];
    expect(await digestMain([], env, (l) => out.push(l))).toBe(0);
    const rows = await staffRows("staff_digest");
    const by = Object.fromEntries(rows.map((r) => [r.s, r.params]));
    expect(by[h.staff.only_trust_and_safety!]).toEqual({ reportsOpen: 4, reportsNew: 3 });
    expect(by[h.staff.only_fetched_job_reviewer!]).toEqual({ fetched_job: 1, scheduled_check: 1 }); // the open queued job and this month's hand check
    for (const who of ["disabled", "tsoff", "norole", "only_content_editor", "only_account_reviewer"]) expect(by[h.staff[who]!], who).toBeUndefined();
    expect(out).toEqual([`staff digest: ${(await su.query(DIGEST_STAFF)).rowCount} staff, ${rows.length} new`]);
    expect(await digestMain([], env, (l) => out.push(l))).toBe(0);
    expect(out[1]).toMatch(/, 0 new$/);
    // the sender: a fake SendMail; the digest shows its numbers, the alert its sentence, neither a button or a staff member's name
    const sent: { to: string; subject: string; text: string; html: string }[] = [];
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
    await c.connect();
    try {
      await su.query("update email_outbox set status = 'dropped' where template not like 'staff_%'");
      expect(await sendPending(c, async (to, subject, text, html) => void sent.push({ to, subject, text, html }), 200)).toMatchObject({ sent: rows.length + 2, failed: 0 });
    } finally { await c.end(); }
    const ts = sent.filter((m) => m.to === "only_trust_and_safety@example.test");
    expect(ts.map((m) => m.subject).sort()).toEqual(["A new report has arrived", "Your work waiting today"]);
    expect(ts.find((m) => m.subject === "Your work waiting today")!.text).toMatch(/Open reports: 4[\s\S]*Reports in the last 24 hours: 3/);
    for (const m of sent) expect(m.html + m.text).not.toMatch(/href=|Fake only_/);
  });
  it("the digest command refuses with no login, an argument, or a login that may not read staff", async () => {
    expect(await digestMain([], {}, () => {})).toBe(2);
    expect(await digestMain(["x"], { DIGEST_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin") }, () => {})).toBe(2);
    const out: string[] = [];
    expect(await digestMain([], { DIGEST_ADMIN_DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable" }, (l) => out.push(l))).toBe(1);
    expect(out[0]).toMatch(/^refused: permission denied/);
  });
});

describe("Q15: invite a staff login", () => {
  it("one administrator invites: a login with no password or role, its first role proposed, the set-password email from security@; a second administrator confirms", async () => {
    mail.length = 0;
    const r = await call("/api/staff", "only_administrator", { action: "invite", email: "  New.Person@Example.TEST ", name: "Fake <b>New</b>", role: "content_editor" });
    expect([r.status, replyProblems(spec, "POST", "/api/staff", r.status, r.json)]).toEqual([200, []]);
    expect(r.json).toEqual({ ok: true, staffId: expect.any(String), requestId: expect.any(String) });
    const id = r.json.staffId;
    expect((await su.query("select email, name, status, email_verified from staff_user where id = $1", [id])).rows[0]).toEqual({ email: "new.person@example.test", name: "Fake <b>New</b>", status: "active", email_verified: false });
    expect((await su.query("select count(*)::int n from staff_account where user_id = $1", [id])).rows[0].n).toBe(0);
    expect((await su.query("select count(*)::int n from staff_role where staff_user_id = $1", [id])).rows[0].n).toBe(0);
    expect((await su.query("select actor_staff_user_id a, after from audit_event where action = 'staff.invite' and object_id = $1", [id])).rows)
      .toEqual([{ a: h.staff.only_administrator, after: { role: "content_editor", requestId: r.json.requestId } }]);
    // the email: Brevo (the fake), the reset sender, to the invitee, a link on the admin site, never the typed name
    expect(mail).toHaveLength(1);
    expect(mail[0]!.body.sender).toEqual({ name: "irishworkpermit.ie", email: "security@account.example.ie" });
    expect(mail[0]!.body.to).toEqual([{ email: "new.person@example.test" }]);
    const text = String(mail[0]!.body.textContent);
    expect(text + mail[0]!.body.htmlContent).not.toMatch(/<b>New|Fake/);
    const link = new URL(text.match(/https?:\/\/\S+/)![0]);
    expect(link.origin).toBe(BASE);
    // the invitee sets a password with the link's token and signs in; a role arrives only when a second administrator confirms
    const token = link.pathname.split("/").at(-1)!;
    const post = (path: string, body: unknown) => h.AUTH(new Request(`${BASE}/api/auth/staff/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "198.51.100.200" } }));
    expect((await post("reset-password", { token, newPassword: "Fake-new-staff-password-1" })).status).toBe(200);
    expect((await post("sign-in/email", { email: "new.person@example.test", password: "Fake-new-staff-password-1" })).status).toBe(200);
    await no(call("/api/staff", "only_administrator", { action: "confirm_role", requestId: r.json.requestId }), 409, "same_person");
    expect(await ok(call("/api/staff", "ad2", { action: "confirm_role", requestId: r.json.requestId }))).toEqual({ ok: true, staffId: id, role: "content_editor" });
    expect((await su.query("select role, granted_by_staff_user_id g from staff_role where staff_user_id = $1", [id])).rows).toEqual([{ role: "content_editor", g: h.staff.ad2 }]);
  });
  it("refuses the same email twice, in any case, and an email the owner's command already made", async () => {
    await no(call("/api/staff", "ad2", { action: "invite", email: "NEW.person@example.test", name: "Fake", role: "trust_and_safety" }), 409, "email_taken");
    await no(call("/api/staff", "ad2", { action: "invite", email: "only_content_editor@example.test", name: "Fake", role: "trust_and_safety" }), 409, "email_taken");
  });
  it("a send the sender refuses answers 502 email_not_sent, keeps the login and its pending role; resend_invite sends it again, 3 an hour", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    brevoDown = true;
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call("/api/staff", "only_administrator", { action: "invite", email: "unlucky@example.test", name: "Fake", role: "content_editor" });
      expect([r.status, r.json, replyProblems(spec, "POST", "/api/staff", r.status, r.json)]).toEqual([502, { error: "email_not_sent", staffId: expect.any(String), requestId: expect.any(String) }, []]);
      expect(err.mock.calls.flat().join(" ")).not.toContain("unlucky@"); // Better Auth's own log of the failure
      // a resend while the sender is still down: 502 again
      const again = await call("/api/staff", "only_administrator", { action: "resend_invite", staffId: r.json.staffId });
      expect([again.status, again.json, replyProblems(spec, "POST", "/api/staff", again.status, again.json)]).toEqual([502, { error: "email_not_sent", staffId: r.json.staffId }, []]);
    } finally { brevoDown = false; err.mockRestore(); }
    const id = r.json.staffId;
    expect((await su.query("select status from staff_user where id = $1", [id])).rows).toEqual([{ status: "active" }]);
    expect((await su.query("select status from approval_request where id = $1", [r.json.requestId])).rows).toEqual([{ status: "pending" }]);
    mail.length = 0;
    const ok1 = await call("/api/staff", "ad2", { action: "resend_invite", staffId: id });
    expect([ok1.status, ok1.json, replyProblems(spec, "POST", "/api/staff", ok1.status, ok1.json)]).toEqual([200, { ok: true }, []]);
    expect(mail.map((m) => [m.body.to, m.body.sender.email])).toEqual([[[{ email: "unlucky@example.test" }], "security@account.example.ie"]]);
    expect((await su.query("select count(*)::int n from staff_user where email = 'unlucky@example.test'")).rows[0].n).toBe(1); // no second login
    await ok(call("/api/staff", "only_administrator", { action: "resend_invite", staffId: id })); // the third this hour (the failed one counts)
    const over = await call("/api/staff", "only_administrator", { action: "resend_invite", staffId: id });
    expect([over.status, over.json, replyProblems(spec, "POST", "/api/staff", over.status, over.json)]).toEqual([429, { error: "too_many_resends" }, []]);
    expect(mail).toHaveLength(2);
    expect((await su.query("select actor_staff_user_id a from audit_event where action = 'staff.invite_resend' and object_id = $1 order by id", [id])).rows.map((x) => x.a))
      .toEqual([h.staff.only_administrator, h.staff.ad2, h.staff.only_administrator]);
  });
  it("resend_invite: only an administrator, only an active login with no password yet, and only a real login id", async () => {
    const newPerson = (await su.query("select id from staff_user where email = 'new.person@example.test'")).rows[0].id;
    for (const who of [...ROLE_NAMES.filter((r) => r !== "administrator").map((r) => `only_${r}`), "norole"]) await no(call("/api/staff", who, { action: "resend_invite", staffId: newPerson }), 403, "not_administrator");
    await no(call("/api/staff", "only_administrator", { action: "resend_invite", staffId: newPerson }), 409, "password_set"); // set in the first invite test
    await no(call("/api/staff", "only_administrator", { action: "resend_invite", staffId: h.staff.only_content_editor! }), 409, "password_set"); // made by the owner's command
    await no(call("/api/staff", "only_administrator", { action: "resend_invite", staffId: h.staff.tsoff! }), 409, "target_not_active");
    await no(call("/api/staff", "only_administrator", { action: "resend_invite", staffId: "no-such-login" }), 404, "not_found");
    for (const staffId of ["", "a b", "x".repeat(65), "1' or '1'='1", 5, null]) await no(call("/api/staff", "only_administrator", { action: "resend_invite", staffId }), 400, "bad_staff_id");
    await no(call("/api/staff", "only_administrator", { action: "resend_invite", staffId: newPerson, email: "x@example.test" }), 400, "bad_body");
    await no(call("/api/staff", "only_administrator", { action: "resend_invite", staffId: newPerson }, { origin: "https://evil.example" }), 403, "bad_origin");
  });
  it("refuses every role but administrator, hostile input and a bad origin, and writes nothing", async () => {
    const before = (await su.query("select count(*)::int n from staff_user")).rows[0].n;
    const body = { action: "invite", email: "someone@example.test", name: "Fake", role: "content_editor" };
    for (const who of [...ROLE_NAMES.filter((r) => r !== "administrator").map((r) => `only_${r}`), "norole"]) await no(call("/api/staff", who, body), 403, "not_administrator");
    const who = "only_administrator";
    for (const email of ["", "no-at", "a@b", "x@example.test'; drop table staff_user;--", "a\r\nbcc@example.test", 5, null, ["a@example.test"]]) await no(call("/api/staff", who, { ...body, email }), 400, "bad_email");
    await no(call("/api/staff", who, { ...body, email: `${"a".repeat(255)}@example.test` }), 400, "bad_email");
    await no(call("/api/staff", who, undefined, { raw: JSON.stringify({ ...body, name: "x".repeat(1000) }) }), 400, "bad_body"); // over the body cap
    for (const name of ["", "   ", "x".repeat(101), "a\nb", 5, null]) await no(call("/api/staff", who, { ...body, name }), 400, "bad_name");
    for (const role of ["owner", "Administrator", 5]) await no(call("/api/staff", who, { ...body, role }), 400, "bad_role");
    await no(call("/api/staff", who, { ...body, extra: 1 }), 400, "bad_body");
    await no(call("/api/staff", who, { action: "invite", email: "a@example.test", name: "Fake" }), 400, "bad_role");
    await no(call("/api/staff", who, body, { origin: "https://evil.example" }), 403, "bad_origin");
    await no(call("/api/staff", who, body, { origin: null }), 403, "bad_origin");
    expect((await su.query("select count(*)::int n from staff_user")).rows[0].n).toBe(before);
  });
});

describe("performance", () => {
  it("each route, the invite and the digest command stay inside their statement, time and page budgets", async () => {
    // bulk: 2,000 more live jobs, 500 decided fetched items with adverts and audit rows, 2,000 open review items over the queues, 300 reports
    await liveJobs(2000, "Bulk job");
    const s = (await su.query("insert into job_source(kind, board) values ('greenhouse', 'bulk') returning id")).rows[0].id;
    await su.query("insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason) select $1, 'bulk-' || g, 'https://jobs.example.test/b', 'Bulk', 'Bulk Co', 'queued', 's', 'r' from generate_series(1, 500) g", [s]);
    await su.query(`insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url)
      select $1, 'fetched', $2, f.id, 'Bulk fetched', 'Bulk Co', 'IT', 'critical_skills', 'in_review', 'infinity', 'https://jobs.example.test/b' from fetched_advert f where f.job_source_id = $2`, [org, s]);
    await su.query("insert into job_text(job_id, advert_text) select id, repeat('Bulk advert text. ', 100) from job where job_source_id = $1", [s]);
    await su.query("update review_item set status = 'done', outcome = 'rejected', decided_by_staff_user_id = $2, decided_at = now() where job_id in (select id from job where job_source_id = $1)", [s, h.staff.jr2]);
    await su.query("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, reason_code, source) select 'admin_action', $2, 'fetched_job.reject', 'job', id::text, 'bulk', 'panel' from job where job_source_id = $1", [s, h.staff.jr2]);
    await su.query("insert into review_item(queue, reason, detail) select 'scheduled_check', 'bulk', jsonb_build_object('key', 'bulk:' || g, 'role', (array['rules_data_editor','fetched_job_reviewer','administrator'])[1 + g % 3]) from generate_series(1, 2000) g");
    const job = (await su.query("select id from job where status = 'live' limit 1")).rows[0].id;
    await su.query("insert into report(target_kind, target_job_id, reason) select 'job', $1, 'other' from generate_series(1, 300)", [job]);
    await su.query("analyze job; analyze review_item; analyze report; analyze audit_event; analyze fetched_advert; analyze candidate_user");
    const counts = [
      (await counted(() => call("/api/accuracy-sample", "only_fetched_job_reviewer")))[1],
      (await counted(() => call("/api/fetched-jobs/decisions", "only_rules_data_editor")))[1],
      (await counted(() => call("/api/targets", "only_content_editor")))[1],
      (await counted(() => call("/api/staff/me/counts", "only_administrator")))[1],
    ];
    expect(counts).toEqual([BUDGET.sample, BUDGET.decisions, BUDGET.targets, BUDGET.counts]);
    const measured: Record<string, number> = {};
    for (const [path, who] of [["/api/accuracy-sample", "only_fetched_job_reviewer"], ["/api/fetched-jobs/decisions", "only_rules_data_editor"], ["/api/targets", "only_content_editor"], ["/api/staff/me/counts", "only_administrator"]] as const)
      expect(measured[path] = await median(() => ok(call(path, who))), path).toBeLessThan(BUDGET.ms);
    // the invite: statements and time (the reset email goes to the fetch fake)
    const [inv, inviteN] = await counted(() => call("/api/staff", "only_administrator", { action: "invite", email: "perf.0@example.test", name: "Fake", role: "content_editor" }));
    expect([inv.status, inviteN]).toEqual([200, BUDGET.invite]);
    expect(measured.invite = await median((i) => ok(call("/api/staff", "only_administrator", { action: "invite", email: `perf.${i + 1}@example.test`, name: "Fake", role: "content_editor" })))).toBeLessThan(BUDGET.inviteMs);
    const [res, resendN] = await counted(() => call("/api/staff", "only_administrator", { action: "resend_invite", staffId: inv.json.staffId }));
    expect([res.status, resendN]).toEqual([200, BUDGET.resend]);
    await su.query("analyze job; analyze review_item; analyze report; analyze audit_event; analyze approval_request; analyze contact_message; analyze strike"); // fresh statistics, so an autovacuum analyze does not re-plan mid-measure
    const client = await su.connect();
    try {
      const roles = ["fetched_job_reviewer", "rules_data_editor", "administrator"];
      const pages: [string, string, unknown[], number][] = [
        ["sample read", SAMPLE_READ, [h.staff.only_fetched_job_reviewer], BUDGET.pages.sampleRead],
        ["decisions", DECISIONS, ["0"], BUDGET.pages.decisions],
        ["targets", TARGET_COUNTS, [], BUDGET.pages.targets],
        ["counts", STAFF_COUNTS, [["scheduled_check", "scam_flag", "pay_floor_check"], roles, true, true, true, true, h.staff.only_administrator], BUDGET.pages.counts],
      ];
      for (const [name, text, values, budget] of pages) {
        const cost = await measurePages(client, [{ text, values }]);
        measured[`${name} pages`] = cost[0]!.pages;
        assertPageBudget(name, cost, budget);
      }
      // making the sample the first time: this month's reminder removed inside a transaction that is rolled back
      await client.query("begin");
      await client.query("delete from review_item where queue = 'scheduled_check' and reason = 'hand_check_100'");
      const cost = await measurePages(client, [SAMPLE_MAKE]);
      measured["sample make pages"] = cost[0]!.pages;
      assertPageBudget("sample make", cost, BUDGET.pages.sampleMake);
      await client.query("rollback");
    } finally { client.release(); }
    // the digest: 1 + one per active staff member with a role + 1
    const a = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
    await a.connect();
    try {
      const people = (await a.query(DIGEST_STAFF)).rowCount!;
      const [, cliN] = await counted(() => writeDigest(a));
      expect(cliN).toBeLessThanOrEqual(people + 2);
      expect(measured.digest = await median(() => writeDigest(a))).toBeLessThan(BUDGET.cliMs);
    } finally { await a.end(); }
    console.log("staff notices measured:", JSON.stringify(measured));
  });
});
