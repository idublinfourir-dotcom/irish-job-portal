// Integration: trust and safety (step 8 slice 8.5) on the real test database. The reports queue and the strike and ban cases go through the real
// admin route handlers with real staff sessions (sign-in through the real auth route), some steps also through src/trust-safety.ts directly as app_admin.
// Test data (companies, owners, jobs) is written as postgres; reports are filed as app_candidate. Notices are only email_outbox rows, nothing is sent.
// Fake people only; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueueRefused } from "../src/admin-queue";
import { seedStaff } from "../src/staff-seed-cli";
import { decideCase, listReports, openCase } from "../src/trust-safety";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements and times measured on 12 November 2026 (median of 9 calls each, as account-review.test.ts does). Statement counts, counting every
// pg.Client.query call: report list = role check + page (2); open case by hand = begin, role check, organisation lock, insert, audit, commit (6);
// decide a strike 1 = begin, role check, case lock, pending check, company pending check, prior strikes, apply, notice, audit, commit (10).
// Medians over three runs of this file alone on 12 November 2026: list 0.6 to 0.8 ms, open 5.7 to 6.5 ms, decide 6.8 to 7.8 ms; the limits are about
// 4 times the slowest. Inside a full parallel `npm run check` on the busy laptop the medians were list 1.4, open 10.5 and decide 55.4 ms (as account-review.test.ts there).
const BUDGET = { list: 2, open: 6, decide: 10, listMs: 4, openMs: 26, decideMs: 32 };

const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3002";
let db: TestDb;
let su: pg.Pool;
let id: (p: string) => string;
let F: { org: (o?: { status?: string; name?: string; cro?: string; kind?: string }) => Promise<string>; portal: (o?: { email?: string }) => Promise<string>; cand: () => Promise<string> };
type Handler = (r: Request) => Promise<Response>;
let routes: Record<"reports" | "cases", { GET: Handler; POST: Handler }>;
let AUTH: Handler;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ id, F } = fixtures(db) as unknown as { id: typeof id; F: typeof F });
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: BASE, STAFF_AUTH_SECRET: secret });
  routes = {
    reports: await import("../../../apps/admin/app/api/trust-safety/reports/route"),
    cases: await import("../../../apps/admin/app/api/trust-safety/cases/route"),
  };
  ({ POST: AUTH } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const admin = () => db.pool("app_admin");
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof QueueRefused ? e.why : `error: ${(e as Error).message}`;
  }
  return "accepted";
};

// ===== staff, with real sessions =====
const PW = "Fake-safety-password-1";
const staff: Record<string, string> = {};
const cookies: Record<string, string> = {};
let ipn = 10;
async function makeStaff(name: string, roles: string[]) {
  const c = await su.connect();
  try {
    staff[name] = await seedStaff(c, { email: `${name}@example.test`, name: `Fake ${name}`, roles: roles.length ? roles : ["content_editor"] }, PW);
  } finally {
    c.release();
  }
  if (roles.length === 0) await su.query("delete from staff_role where staff_user_id = $1", [staff[name]]);
  const res = await AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
    method: "POST", body: JSON.stringify({ email: `${name}@example.test`, password: PW }),
    headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${ipn++}` },
  }));
  expect(res.status, name).toBe(200);
  cookies[name] = res.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
}
beforeAll(async () => {
  for (const n of ["ts1", "ts2", "ts3", "ts4"]) await makeStaff(n, ["trust_and_safety"]);
  await makeStaff("reviewer", ["account_reviewer"]);
  await makeStaff("fetched", ["fetched_job_reviewer"]);
  await makeStaff("adminonly", ["administrator"]);
  await makeStaff("norole", []);
  await makeStaff("disabled", ["trust_and_safety"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [staff.disabled]); // after sign-in: the open session is refused too
});

type Reply = { status: number; json: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, path: "reports" | "cases", body?: unknown, o: { origin?: string | null; raw?: string; query?: string; cookie?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = o.cookie ?? (who ? cookies[who] : undefined);
  if (cookie) headers.cookie = cookie;
  const post = body !== undefined || o.raw !== undefined;
  if (post && o.origin !== null) headers.origin = o.origin ?? BASE;
  const req = new Request(`${BASE}/api/trust-safety/${path}${o.query ?? ""}`, { method: post ? "POST" : "GET", body: post ? (o.raw ?? JSON.stringify(body)) : undefined, headers });
  const res = await (post ? routes[path].POST : routes[path].GET)(req);
  return { status: res.status, json: await res.json() };
}
const ok = async (who: string, path: "reports" | "cases", body: unknown) => {
  const r = await call(who, path, body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const no = async (who: string | null, path: "reports" | "cases", body: unknown, status: number, error: string) => {
  const r = await call(who, path, body);
  expect([r.status, r.json.error], JSON.stringify(body)).toEqual([status, error]);
};

// ===== test data =====
let source: string;
beforeAll(async () => { source = (await one("insert into job_source(kind, board) values ('portal', 'portal') returning id::text")).id; });
/** A verified company with an owner (on its own domain, or a free provider address) who joined yesterday, the domain saved last week, and live jobs posted by the owner. */
async function company(o: { kind?: string; free?: boolean; jobs?: number; noCro?: boolean } = {}) {
  const domain = o.free ? "gmail.com" : `${id("co")}.example.test`;
  const cro = o.noCro ? undefined : String(Math.floor(Math.random() * 9e7) + 1e7);
  const org = await F.org({ kind: o.kind ?? "employer", cro, status: "verified" });
  const email = `${id("owner")}@${domain}`;
  const owner = await F.portal({ email });
  const member = (await one("insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values ($1, $2, 'account_owner', 'active', true, now() - interval '1 day') returning id::text", [org, owner])).id;
  if (!o.free) await su.query("insert into organisation_domain(organisation_id, domain, source, created_at) values ($1, $2, 'seed', now() - interval '7 days')", [org, domain]);
  const jobs: string[] = [];
  for (let i = 0; i < (o.jobs ?? 1); i++)
    jobs.push((await one(
      "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, own_page_url, search_vector, posted_by_membership_id) " +
      "values ($1, 'employer', $2, 'Fake Cook', 'Fake Org', 'it', 'critical_skills', 40000, 'live', now() + interval '20 days', 'https://example.test/a', 'fake', $3) returning id::text", [org, source, member])).id);
  return { org: String(org), owner, email, domain, cro, member, jobs };
}
async function report(job: string) {
  const who = await F.cand();
  return (await db.query("app_candidate", "insert into report(target_kind, target_job_id, reporter_candidate_user_id, reason, evidence_text) values ('job', $1, $2, 'no_sponsorship', 'Fake proof') returning id::text", [job, who])).rows[0].id as string;
}
const jobRow = async (j: string) => one("select status, hidden_reason, hidden_report_id::text, close_reason from job where id = $1", [j]);
const caseRow = async (c: string) => one("select * from strike where id = $1", [c]);
const orgRow = async (o: string) => one("select status, restricted_until, claims_removed_at from organisation where id = $1", [o]);
const audits = async (type: string, oid: string) => (await su.query("select actor_staff_user_id, action, reason_code, second_staff_user_id, after, reason_text from audit_event where object_type = $1 and object_id = $2 order by id", [type, oid])).rows;
const pastWindow = (c: string) => su.query("update strike set reply_due_at = now() - interval '1 minute' where id = $1", [c]); // the 7 days pass (as the owner, which the guard lets move it)
const bans = async (c: string) => (await su.query("select cro_number, email_domain, email_address, reason_code from ban where strike_id = $1 order by id", [c])).rows;
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

/** A false-claim case notified, with its 7 days passed: ready for a strike decision. */
async function readyCase(co: { org: string; jobs: string[] }, by = "ts1") {
  const { caseId } = await ok(by, "cases", { action: "open", organisationId: co.org, jobId: co.jobs[0], caseKind: "false_claim", reasonCode: "false_sponsorship" });
  await ok(by, "cases", { action: "notify", caseId });
  await pastWindow(caseId);
  return caseId as string;
}

// ===== reports =====
describe("reports", () => {
  it("lists open reports oldest first; hide makes the job hidden at once; clear brings it back and drops the reporter; audit rows hold codes only", async () => {
    const co = await company();
    const r = await report(co.jobs[0]!);
    const list = await call("ts1", "reports");
    expect(list.status).toBe(200);
    const mine = list.json.items.find((x: { id: string }) => x.id === r);
    expect(mine).toMatchObject({ status: "open", reason: "no_sponsorship", targetJobId: co.jobs[0] });
    expect(JSON.stringify(mine)).not.toMatch(/Fake proof|reporter/); // the list shows no evidence and no reporter
    expect((await call("ts1", "reports", undefined, { query: `?id=${r}` })).json.item).toMatchObject({ evidenceText: "Fake proof", reporterCandidateUserId: expect.any(String) });

    await ok("ts1", "reports", { action: "hide", reportId: r });
    expect(await jobRow(co.jobs[0]!)).toMatchObject({ status: "hidden", hidden_reason: "report", hidden_report_id: r });
    await no("ts1", "reports", { action: "hide", reportId: r }, 409, "already_hidden");
    await ok("ts2", "reports", { action: "clear", reportId: r });
    expect(await jobRow(co.jobs[0]!)).toMatchObject({ status: "live", hidden_reason: null, hidden_report_id: null });
    expect(await one("select status, reporter_candidate_user_id, decided_by_staff_user_id from report where id = $1", [r])).toEqual({ status: "cleared", reporter_candidate_user_id: null, decided_by_staff_user_id: staff.ts2 });
    await no("ts1", "reports", { action: "clear", reportId: r }, 409, "already_decided");
    expect((await audits("report", r)).map((a) => [a.actor_staff_user_id, a.action, a.reason_text])).toEqual([[staff.ts1, "trust_safety.report_hide", null], [staff.ts2, "trust_safety.report_clear", null]]);
    await no("ts1", "reports", { action: "hide", reportId: "999999999" }, 404, "not_found");
  });

  it("uphold closes the hidden job and opens a case on the job's company; the case does not carry the reporter", async () => {
    const co = await company();
    const r = await report(co.jobs[0]!);
    await ok("ts1", "reports", { action: "hide", reportId: r });
    const { caseId } = await ok("ts1", "reports", { action: "uphold", reportId: r, caseKind: "false_claim", reasonCode: "false_sponsorship", noticeSummary: "The advert claimed sponsorship." });
    expect(await jobRow(co.jobs[0]!)).toMatchObject({ status: "closed", close_reason: "removed" });
    expect(await caseRow(caseId)).toMatchObject({ organisation_id: co.org, job_id: co.jobs[0], report_id: r, case_kind: "false_claim", stage: "case_open", outcome: null });
    expect((await one("select reporter_candidate_user_id from report where id = $1", [r])).reporter_candidate_user_id).toBeNull();
    await no("ts1", "reports", { action: "uphold", reportId: r, caseKind: "false_claim", reasonCode: "false_sponsorship" }, 409, "already_decided");
    // a reason code that does not fit the case kind
    const r2 = await report((await company()).jobs[0]!);
    await no("ts1", "reports", { action: "uphold", reportId: r2, caseKind: "instant_ban", reasonCode: "false_sponsorship" }, 400, "bad_reason");
  });
});

// ===== strikes =====
describe("strikes", () => {
  it("strike 1: the notice goes to the owner and the poster, the decision waits for the reply window, the person who entered the reply cannot decide", async () => {
    const co = await company();
    const poster = await F.portal();
    const pm = (await one("insert into membership(organisation_id, portal_user_id, role, status, joined_at) values ($1, $2, 'poster', 'active', now()) returning id::text", [co.org, poster])).id;
    await su.query("update job set posted_by_membership_id = $2 where id = $1", [co.jobs[0], pm]);
    const { caseId } = await ok("ts1", "cases", { action: "open", organisationId: co.org, jobId: co.jobs[0], caseKind: "false_claim", reasonCode: "false_sponsorship" });
    await no("ts1", "cases", { action: "decide", caseId, outcome: "strike" }, 409, "not_notified");
    expect(await ok("ts1", "cases", { action: "notify", caseId })).toEqual({ ok: true, notices: 2 });
    await no("ts1", "cases", { action: "notify", caseId }, 409, "already_notified");
    const out = (await su.query("select template, portal_user_id, params, dedupe_key from email_outbox where params->>'strike_id' = $1 order by portal_user_id", [caseId])).rows;
    expect(out.map((x) => x.portal_user_id).sort()).toEqual([co.owner, poster].sort());
    expect(out[0]).toMatchObject({ template: "strike_case_opened", params: { strike_id: Number(caseId), case_kind: "false_claim", stage: "employer_notified" } });
    expect(JSON.stringify(out)).not.toMatch(/proof|report/i);
    const k = await caseRow(caseId);
    expect(k.reply_due_at.getTime() - Date.now()).toBeGreaterThan(6.9 * 864e5);
    await no("ts1", "cases", { action: "decide", caseId, outcome: "strike" }, 409, "reply_window_open");
    // a reply by post, entered by ts2 with its received date: ts2 may not decide, ts1 may (a reply is in, so the case need not wait)
    await ok("ts2", "cases", { action: "record_reply", caseId, text: "We do sponsor; letter attached.", receivedAt: ago(60) });
    expect(await caseRow(caseId)).toMatchObject({ employer_reply: "We do sponsor; letter attached.", reply_entered_by_staff_user_id: staff.ts2 });
    await no("ts2", "cases", { action: "decide", caseId, outcome: "strike" }, 409, "entered_reply");
    await no("ts1", "cases", { action: "decide", caseId, outcome: "ban" }, 400, "bad_outcome"); // a ban is only for instant-ban cases
    expect(await ok("ts1", "cases", { action: "decide", caseId, outcome: "strike" })).toEqual({ ok: true, outcome: "strike", level: 1, applied: true });
    expect(await caseRow(caseId)).toMatchObject({ outcome: "strike", level: 1, stage: "applied", decided_by_staff_user_id: staff.ts1 });
    expect((await caseRow(caseId)).appeal_due_at).not.toBeNull();
    expect(await jobRow(co.jobs[0]!)).toMatchObject({ status: "closed", close_reason: "removed" });
    await no("ts1", "cases", { action: "decide", caseId, outcome: "cleared" }, 409, "already_decided");
    // a reply received after its deadline is refused by the database
    const late = await readyCase(await company());
    await no("ts2", "cases", { action: "record_reply", caseId: late, text: "Late", receivedAt: ago(0.5) }, 409, "window_closed");
  });

  it("strike 2 within 12 months: proposed by one, refused for the proposer and other roles, confirmed by a second; the 90-day restriction and the badge lock follow", async () => {
    const co = await company({ jobs: 3 });
    const first = await readyCase({ org: co.org, jobs: [co.jobs[0]!] });
    await ok("ts1", "cases", { action: "decide", caseId: first, outcome: "strike" });
    const second = await readyCase({ org: co.org, jobs: [co.jobs[1]!] });
    const d = await ok("ts1", "cases", { action: "decide", caseId: second, outcome: "strike" });
    expect(d).toMatchObject({ outcome: "strike", level: 2, applied: false, requestId: expect.any(String) });
    expect(await caseRow(second)).toMatchObject({ outcome: null, level: null });
    await no("ts1", "cases", { action: "decide", caseId: second, outcome: "strike" }, 409, "decision_pending");
    await no("ts1", "cases", { action: "confirm", caseId: second }, 409, "same_person");
    await no("reviewer", "cases", { action: "confirm", caseId: second }, 403, "not_trust_and_safety");
    await no("adminonly", "cases", { action: "confirm", caseId: second }, 403, "not_trust_and_safety");
    // another case of the same company cannot be decided while this one waits (the level would be counted twice)
    const third = await readyCase({ org: co.org, jobs: [co.jobs[2]!] });
    await no("ts1", "cases", { action: "decide", caseId: third, outcome: "strike" }, 409, "other_case_pending");
    expect(await ok("ts2", "cases", { action: "confirm", caseId: second })).toEqual({ ok: true, applied: "strike_2" });
    const k = await caseRow(second);
    expect(k).toMatchObject({ outcome: "strike", level: 2, stage: "applied", decided_by_staff_user_id: staff.ts2 });
    const req = await one("select proposed_by_staff_user_id, confirmed_by_staff_user_id, applied_at from approval_request where id = $1", [k.approval_request_id]);
    expect(req).toMatchObject({ proposed_by_staff_user_id: staff.ts1, confirmed_by_staff_user_id: staff.ts2 });
    expect((await orgRow(co.org)).restricted_until.getTime()).toBe(req.applied_at.getTime() + 90 * 864e5);
    await expect(su.query("update job set badge = 'sponsor_confirmed' where id = $1", [co.jobs[2]])).rejects.toThrow(/restricted/);
    const a = (await audits("strike", second)).map((x) => [x.action, x.actor_staff_user_id, x.second_staff_user_id]);
    expect(a).toContainEqual(["trust_safety.case_propose", staff.ts1, null]);
    expect(a).toContainEqual(["trust_safety.case_confirm", staff.ts2, staff.ts1]);

    // strike 3: claims removed, the company banned by its CRO number and domain, every job closed
    const d3 = await ok("ts1", "cases", { action: "decide", caseId: third, outcome: "strike" });
    expect(d3).toMatchObject({ level: 3, applied: false });
    await ok("ts3", "cases", { action: "confirm", caseId: third });
    const k3 = await caseRow(third);
    const at3 = (await one("select applied_at from approval_request where id = $1", [k3.approval_request_id])).applied_at;
    expect(await orgRow(co.org)).toMatchObject({ status: "banned", claims_removed_at: at3 });
    expect(await bans(third)).toEqual([
      { cro_number: co.cro, email_domain: null, email_address: null, reason_code: "strike_3" },
      { cro_number: null, email_domain: co.domain, email_address: null, reason_code: "strike_3" },
    ]);
    for (const j of co.jobs) expect((await jobRow(j)).status).toBe("closed");
  });

  it("a strike older than 12 months stops counting (#214 a); an overturned one does not count", async () => {
    const co = await company({ jobs: 3 });
    const old = await readyCase({ org: co.org, jobs: [co.jobs[0]!] });
    await ok("ts1", "cases", { action: "decide", caseId: old, outcome: "strike" });
    await su.query("update strike set decided_at = now() - interval '13 months' where id = $1", [old]);
    const next = await readyCase({ org: co.org, jobs: [co.jobs[1]!] });
    expect(await ok("ts1", "cases", { action: "decide", caseId: next, outcome: "strike" })).toMatchObject({ level: 1 });
    await ok("ts3", "cases", { action: "record_appeal", caseId: next, text: "Appeal", receivedAt: ago(1) });
    await ok("ts4", "cases", { action: "decide_appeal", caseId: next, result: "overturned" });
    const again = await readyCase({ org: co.org, jobs: [co.jobs[2]!] });
    expect(await ok("ts1", "cases", { action: "decide", caseId: again, outcome: "strike" })).toMatchObject({ level: 1 });
  });
});

// ===== instant bans =====
describe("instant ban cases (#213)", () => {
  it("hide and suspend at once; the ban waits for the 7 days; once confirmed the company is banned and its jobs closed", async () => {
    const co = await company({ jobs: 2 });
    const { caseId } = await ok("ts1", "cases", { action: "open", organisationId: co.org, caseKind: "instant_ban", reasonCode: "asks_for_money" });
    expect((await orgRow(co.org)).status).toBe("suspended");
    for (const j of co.jobs) expect(await jobRow(j)).toMatchObject({ status: "hidden", hidden_reason: "organisation_suspended" });
    await no("ts1", "cases", { action: "decide", caseId, outcome: "strike" }, 400, "bad_outcome");
    await ok("ts1", "cases", { action: "notify", caseId });
    await ok("ts2", "cases", { action: "record_reply", caseId, text: "This was not us.", receivedAt: ago(1) });
    await no("ts1", "cases", { action: "decide", caseId, outcome: "ban" }, 409, "reply_window_open"); // a reply does not end the 7 days for a ban
    await pastWindow(caseId);
    expect(await ok("ts1", "cases", { action: "decide", caseId, outcome: "ban" })).toMatchObject({ outcome: "ban", applied: false });
    await no("ts2", "cases", { action: "confirm", caseId }, 409, "entered_reply"); // the one who entered the reply does not decide
    await ok("ts3", "cases", { action: "confirm", caseId });
    expect((await orgRow(co.org)).status).toBe("banned");
    for (const j of co.jobs) expect((await jobRow(j)).status).toBe("closed");
    expect((await bans(caseId)).map((b) => b.reason_code)).toEqual(["asks_for_money", "asks_for_money"]);
  });

  it("conclusive evidence bans at once and the 7 days become the appeal window", async () => {
    const co = await company();
    const { caseId } = await ok("ts1", "cases", { action: "open", organisationId: co.org, caseKind: "instant_ban", reasonCode: "fake_job" });
    await ok("ts1", "cases", { action: "decide", caseId, outcome: "ban", conclusive: true });
    await ok("ts2", "cases", { action: "confirm", caseId });
    const k = await caseRow(caseId);
    expect(k).toMatchObject({ outcome: "ban", stage: "applied" });
    expect(k.appeal_due_at.getTime() - Date.now()).toBeGreaterThan(6.9 * 864e5);
    expect((await orgRow(co.org)).status).toBe("banned");
  });

  it("cleared: the company comes back from suspended and its hidden jobs go live again", async () => {
    const co = await company();
    const { caseId } = await ok("ts1", "cases", { action: "open", organisationId: co.org, caseKind: "instant_ban", reasonCode: "fake_company" });
    await ok("ts1", "cases", { action: "decide", caseId, outcome: "cleared" });
    expect((await orgRow(co.org)).status).toBe("verified");
    expect(await jobRow(co.jobs[0]!)).toMatchObject({ status: "live", hidden_reason: null });
  });

  it("a company on a free provider is banned by its CRO number and its people's exact addresses, never the whole provider; the address cannot claim or register again", async () => {
    const co = await company({ free: true });
    const { caseId } = await ok("ts1", "cases", { action: "open", organisationId: co.org, caseKind: "instant_ban", reasonCode: "asks_for_money" });
    await ok("ts1", "cases", { action: "decide", caseId, outcome: "ban", conclusive: true });
    await ok("ts2", "cases", { action: "confirm", caseId });
    expect(await bans(caseId)).toEqual([
      { cro_number: co.cro, email_domain: null, email_address: null, reason_code: "asks_for_money" },
      { cro_number: null, email_domain: null, email_address: co.email.toLowerCase(), reason_code: "asks_for_money" },
    ]);
    // the same person, now in no company (the ban removed nothing, so drop the old membership first), tries again
    await su.query("update membership set status = 'removed', removed_at = now() where organisation_id = $1", [co.org]);
    const other = await F.org({ status: "unclaimed" });
    await expect(db.query("app_portal", "select private.claim_organisation($1, $2)", [co.owner, other])).rejects.toThrow(/email address is banned/);
    await expect(db.query("app_portal", "select private.register_organisation($1, 'employer', 'Fresh Fake Ltd', '12345', null)", [co.owner])).rejects.toThrow(/email address is banned/);
    // someone else on the same free provider is not banned
    const stranger = await F.portal({ email: `${id("someone")}@gmail.com` });
    expect((await db.query("app_portal", "select private.claim_organisation($1, $2) r", [stranger, other])).rows[0].r.status).toBe("pending_review");
  });

  it("the WRC report is a step ticked off on an agency's instant-ban case, once", async () => {
    const ag = await company({ kind: "agency", noCro: true });
    const { caseId } = await ok("ts1", "cases", { action: "open", organisationId: ag.org, caseKind: "instant_ban", reasonCode: "asks_for_money" });
    await ok("ts1", "cases", { action: "mark_wrc", caseId });
    await no("ts1", "cases", { action: "mark_wrc", caseId }, 409, "already_marked");
    expect((await call("ts2", "cases", undefined, { query: `?id=${caseId}` })).json.item).toMatchObject({ wrcReported: true, organisationKind: "agency" });
    const emp = await company();
    const e = await ok("ts1", "cases", { action: "open", organisationId: emp.org, caseKind: "instant_ban", reasonCode: "asks_for_money" });
    await no("ts1", "cases", { action: "mark_wrc", caseId: e.caseId }, 409, "not_agency_ban");
  });
});

// ===== appeals =====
describe("appeals (#134 to #136)", () => {
  async function strike2() {
    const co = await company({ jobs: 2 });
    const a = await readyCase({ org: co.org, jobs: [co.jobs[0]!] });
    await ok("ts1", "cases", { action: "decide", caseId: a, outcome: "strike" });
    const b = await readyCase({ org: co.org, jobs: [co.jobs[1]!] });
    await ok("ts1", "cases", { action: "decide", caseId: b, outcome: "strike" });
    await ok("ts2", "cases", { action: "confirm", caseId: b });
    return { co, caseId: b };
  }
  it("an appeal by post is entered with its date; neither the one who entered it nor the deciders decide it; overturned clears the restriction", async () => {
    const { co, caseId } = await strike2();
    await no("ts3", "cases", { action: "decide_appeal", caseId, result: "overturned" }, 409, "no_appeal");
    await ok("ts3", "cases", { action: "record_appeal", caseId, text: "We have the permit letters.", receivedAt: ago(5) });
    await no("ts3", "cases", { action: "record_appeal", caseId, text: "Again", receivedAt: ago(1) }, 409, "already_appealed");
    expect(await caseRow(caseId)).toMatchObject({ stage: "appealed", appeal_entered_by_staff_user_id: staff.ts3 });
    await no("ts3", "cases", { action: "decide_appeal", caseId, result: "overturned" }, 409, "entered_appeal");
    await no("ts2", "cases", { action: "decide_appeal", caseId, result: "overturned" }, 409, "decided_case"); // the confirmer decided the case
    await no("ts1", "cases", { action: "decide_appeal", caseId, result: "overturned" }, 409, "decided_case"); // the proposer
    expect(await ok("ts4", "cases", { action: "decide_appeal", caseId, result: "overturned" })).toEqual({ ok: true, result: "overturned", liftsProposed: 0 });
    expect(await caseRow(caseId)).toMatchObject({ stage: "overturned", appeal_decided_by_staff_user_id: staff.ts4 });
    expect((await orgRow(co.org)).restricted_until).toBeNull();
    await no("ts4", "cases", { action: "decide_appeal", caseId, result: "upheld" }, 409, "appeal_decided");
    expect((await su.query("select count(*)::int n from email_outbox where params->>'strike_id' = $1 and template = 'appeal_decided'", [caseId])).rows[0].n).toBe(1);
  });

  it("a ban overturned on appeal: the lift is proposed by the appeal's decider and confirmed by a second officer; the company comes back", async () => {
    const co = await company();
    const { caseId } = await ok("ts1", "cases", { action: "open", organisationId: co.org, caseKind: "instant_ban", reasonCode: "fake_job" });
    await ok("ts1", "cases", { action: "decide", caseId, outcome: "ban", conclusive: true });
    await ok("ts2", "cases", { action: "confirm", caseId });
    await ok("ts3", "cases", { action: "record_appeal", caseId, text: "Wrong company.", receivedAt: ago(1) });
    expect(await ok("ts4", "cases", { action: "decide_appeal", caseId, result: "overturned" })).toMatchObject({ liftsProposed: 2 });
    expect((await orgRow(co.org)).status).toBe("banned"); // the ban stands until the second person confirms the lift
    await no("ts4", "cases", { action: "confirm", caseId }, 409, "same_person");
    await no("fetched", "cases", { action: "confirm", caseId }, 403, "not_trust_and_safety");
    expect(await ok("ts1", "cases", { action: "confirm", caseId })).toEqual({ ok: true, applied: "ban_lift" });
    expect(await bans(caseId)).toEqual([]);
    expect((await orgRow(co.org)).status).toBe("verified");
    expect((await caseRow(caseId)).ban_lifted_at).not.toBeNull();
  });

  it("a strike 3 ban lifted without an appeal also ends 'Sponsorship claims removed' (#214 b); a lift can be refused", async () => {
    const co = await company({ jobs: 3 });
    for (const [i, by] of [[0, "ts2"], [1, "ts3"], [2, "ts4"]] as const) {
      const c = await readyCase({ org: co.org, jobs: [co.jobs[i]!] });
      const d = await ok("ts1", "cases", { action: "decide", caseId: c, outcome: "strike" });
      if (!d.applied) await ok(by, "cases", { action: "confirm", caseId: c });
      if (i === 2) {
        expect((await orgRow(co.org)).claims_removed_at).not.toBeNull();
        expect(await ok("ts1", "cases", { action: "propose_ban_lift", caseId: c })).toEqual({ ok: true, requests: 2 });
        await no("ts1", "cases", { action: "propose_ban_lift", caseId: c }, 409, "decision_pending");
        await ok("ts2", "cases", { action: "refuse", caseId: c });
        expect((await su.query("select status from approval_request where kind = 'ban_lift' and reason = $1", [`case ${c}`])).rows.map((r) => r.status)).toEqual(["refused", "refused"]);
        await ok("ts1", "cases", { action: "propose_ban_lift", caseId: c });
        await ok("ts2", "cases", { action: "confirm", caseId: c });
        expect(await orgRow(co.org)).toMatchObject({ status: "verified", claims_removed_at: null });
      }
    }
  });
});

// ===== security =====
describe("security", () => {
  it("only an active trust and safety officer gets in: no role, account reviewer, fetched-job reviewer, administrator, disabled, no session, a foreign cookie", async () => {
    const co = await company();
    const r = await report(co.jobs[0]!);
    for (const who of ["norole", "reviewer", "fetched", "adminonly"]) {
      for (const path of ["reports", "cases"] as const) expect((await call(who, path)).json.error, who).toBe("not_trust_and_safety");
      await no(who, "reports", { action: "hide", reportId: r }, 403, "not_trust_and_safety");
      await no(who, "cases", { action: "open", organisationId: co.org, caseKind: "instant_ban", reasonCode: "fake_job" }, 403, "not_trust_and_safety");
    }
    await no("disabled", "reports", { action: "hide", reportId: r }, 401, "not_active");
    expect((await call(null, "reports")).status).toBe(401);
    // a candidate or portal session cookie means nothing to the staff login
    expect((await call(null, "cases", undefined, { cookie: "candidate.session_token=fake.value; portal.session_token=fake.value" })).json.error).toBe("no_session");
    expect((await jobRow(co.jobs[0]!)).status).toBe("live");
    expect((await orgRow(co.org)).status).toBe("verified");
    // the functions refuse the same way when called directly
    expect(await refusal(listReports(admin(), staff.adminonly!))).toBe("not_trust_and_safety");
    expect(await refusal(listReports(admin(), staff.disabled!))).toBe("not_active_staff");
    expect(await refusal(listReports(admin(), "nobody"))).toBe("not_active_staff");
  });

  it("refuses a foreign or missing Origin and hostile bodies before anything changes", async () => {
    const r = await report((await company()).jobs[0]!);
    expect((await call("ts1", "reports", { action: "hide", reportId: r }, { origin: "https://evil.example" })).json.error).toBe("bad_origin");
    expect((await call("ts1", "reports", { action: "hide", reportId: r }, { origin: null })).json.error).toBe("bad_origin");
    for (const raw of ["", "{", "[]", "null", JSON.stringify({ action: "hide", reportId: r, extra: 1 }), JSON.stringify({ action: "hide", reportId: `${r} or 1=1` }), "x".repeat(13000)])
      expect((await call("ts1", "reports", undefined, { raw })).status, raw.slice(0, 30)).toBe(400);
    expect((await call("ts1", "reports", undefined, { query: "?after=not-a-token" })).json.error).toBe("bad_cursor");
    expect((await call("ts1", "cases", undefined, { query: "?id=1;drop" })).status).toBe(404);
    expect((await one("select status from report where id = $1", [r])).status).toBe("open");
  });

  it("the employer can change only its own reply and appeal text; a reporter sees nothing of a report or a case", async () => {
    const co = await company();
    const r = await report(co.jobs[0]!);
    const { caseId } = await ok("ts1", "reports", { action: "uphold", reportId: r, caseKind: "false_claim", reasonCode: "false_sponsorship" });
    for (const set of ["stage = 'overturned'", "outcome = 'cleared'", "level = 1", "reply_due_at = now()", "report_id = null", "appeal_due_at = now()", "reply_received_at = now()"])
      await expect(db.query("app_portal", `update strike set ${set} where id = $1`, [caseId]), set).rejects.toThrow(/permission denied/);
    await expect(db.query("app_portal", "select report_id from strike where id = $1", [caseId])).rejects.toThrow(/permission denied/);
    await expect(db.query("app_portal", "insert into ban(cro_number, reason_code, strike_id, approval_request_id) values ('1', 'fake_job', $1, 1)", [caseId])).rejects.toThrow(/permission denied/);
    await expect(db.query("app_portal", "insert into approval_request(kind, target_table, target_id) values ('ban', 'strike', $1)", [caseId])).rejects.toThrow(/permission denied/);
    for (const q of ["select reporter_candidate_user_id from report", "select evidence_text from report", "select * from strike", "select * from ban"])
      await expect(db.query("app_candidate", q), q).rejects.toThrow(/permission denied/);
    await expect(db.query("app_candidate", "update report set status = 'cleared' where id = $1", [r])).rejects.toThrow(/permission denied/);
  });

  it("app_admin without the functions cannot skip the two-person rule: a strike 2 or ban with no confirmed request is refused by the database", async () => {
    const co = await company();
    const c = await readyCase({ org: co.org, jobs: [co.jobs[0]!] });
    const p = await admin().connect();
    try {
      await p.query("begin");
      await p.query("select set_config('app.staff_user_id', $1, true)", [staff.ts1]);
      await expect(p.query("update strike set outcome = 'strike', level = 2, approval_request_id = (select min(id) from approval_request) where id = $1", [c])).rejects.toThrow(/two-person rule/);
    } finally {
      await p.query("rollback");
      p.release();
    }
  });
});

// ===== budgets =====
async function counted<T>(fn: () => Promise<T>): Promise<[T, number, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  const t = performance.now();
  try { const out = await fn(); return [out, n, performance.now() - t]; } finally { pg.Client.prototype.query = q; }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe("budgets", () => {
  it("the report list, opening a case and deciding a strike 1 stay within their statement counts and times (median of 9)", async () => {
    const companies = await Promise.all(Array.from({ length: 9 }, () => company()));
    await listReports(admin(), staff.ts1!); // warm
    const list: number[] = [], open: number[] = [], decide: number[] = [];
    for (let i = 0; i < 9; i++) {
      const [, n, ms] = await counted(() => listReports(admin(), staff.ts1!));
      expect(n).toBe(BUDGET.list);
      list.push(ms);
    }
    const cases: string[] = [];
    for (const co of companies) {
      const [o, n, ms] = await counted(() => openCase(admin(), staff.ts1!, { organisationId: co.org, caseKind: "false_claim", reasonCode: "false_sponsorship" }));
      expect(n).toBe(BUDGET.open);
      open.push(ms);
      cases.push(o.caseId);
      await ok("ts1", "cases", { action: "notify", caseId: o.caseId });
      await pastWindow(o.caseId);
    }
    for (const c of cases) {
      const [, n, ms] = await counted(() => decideCase(admin(), staff.ts1!, c, { outcome: "strike" }));
      expect(n).toBe(BUDGET.decide);
      decide.push(ms);
    }
    process.stderr.write(`trust-safety medians: list ${median(list).toFixed(1)} ms, open ${median(open).toFixed(1)} ms, decide ${median(decide).toFixed(1)} ms\n`);
    expect(median(list)).toBeLessThan(BUDGET.listMs);
    expect(median(open)).toBeLessThan(BUDGET.openMs);
    expect(median(decide)).toBeLessThan(BUDGET.decideMs);
  });
});
