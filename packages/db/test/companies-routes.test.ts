// Integration: the company routes of the admin app (step 13 part 13c) on the real test database, through the real route handlers with real staff sessions
// (sign-in through the real auth route), connected as app_admin: /api/companies/merge, /api/companies/owner-reassign and /api/manual-jobs. Every staff role is
// tried on every route and verb, then hostile input. Companies and members are written as postgres. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedStaff } from "../src/staff-seed-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3002";
type Handler = { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
let db: TestDb, su: pg.Pool;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number>; staff(): Promise<string> };
let merge: Handler, owner: Handler, manual: Handler;
let AUTH: (r: Request) => Promise<Response>;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: BASE, STAFF_AUTH_SECRET: secret });
  merge = await import("../../../apps/admin/app/api/companies/merge/route");
  owner = await import("../../../apps/admin/app/api/companies/owner-reassign/route");
  manual = await import("../../../apps/admin/app/api/manual-jobs/route");
  ({ POST: AUTH } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

// ===== staff, with real sessions
const PW = "Fake-company-password-1";
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
const ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"] as const;
beforeAll(async () => {
  for (const r of ROLES) await makeStaff(r, [r]);
  await makeStaff("both", ["account_reviewer", "fetched_job_reviewer"]);
  await makeStaff("norole", []);
  await makeStaff("disabled", ["account_reviewer", "fetched_job_reviewer", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [staff.disabled]); // after sign-in: the open session is refused too
});

type Reply = { status: number; json: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(h: Handler, path: string, who: string | null, body?: unknown, o: { origin?: string | null; raw?: string; query?: string; cookie?: string; length?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = o.cookie ?? (who ? cookies[who] : undefined);
  if (cookie) headers.cookie = cookie;
  if (o.length) headers["content-length"] = o.length;
  const post = body !== undefined || o.raw !== undefined;
  if (post && o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await (post ? h.POST : h.GET)(new Request(`${BASE}${path}${o.query ?? ""}`, { method: post ? "POST" : "GET", body: post ? (o.raw ?? JSON.stringify(body)) : undefined, headers }));
  return { status: res.status, json: await res.json() };
}
const M = "/api/companies/merge", O = "/api/companies/owner-reassign", J = "/api/manual-jobs";
const doMerge = (who: string | null, a: unknown, s: unknown, o = {}) => call(merge, M, who, { absorbedId: String(a), survivorId: String(s) }, o);
const doOwner = (who: string | null, body: unknown, o = {}) => call(owner, O, who, body, o);
const doManual = (who: string | null, body: unknown, o = {}) => call(manual, J, who, body, o);
const is = (r: Reply, status: number, error?: string) => expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([status, error]);
const okay = (r: Reply) => { expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
const one = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows[0];

// ===== data
let n = 0;
const org = (o: { status?: string; kind?: string } = {}) => F.org({ status: o.status ?? "unclaimed", kind: o.kind, name: `Fake Route Co ${++n}`, wrc: o.kind === "agency" ? `EA${++n}${Date.now() % 1e6}` : null });
const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const post = (o: number, x: object = {}) => ({
  action: "create", organisationId: String(o), title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractMonths: null, salaryLow: 50000, salaryHigh: 60000,
  weeklyHours: 39, closesOn: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10), applyUrl: "https://careers.example.ie/jobs/1", ...x,
});
async function team() {
  const o = await org({ status: "verified" });
  const owner = Number(await F.member(o, await F.portal(), { role: "account_owner", signer: true }));
  const next = Number(await F.member(o, await F.portal(), { role: "recruiter" }));
  return { o, owner, next };
}
const WHO = [...ROLES, "both", "norole"] as const;
const AR = new Set<string>(["account_reviewer", "both"]); // "both" holds the account reviewer role too

describe("merge route", () => {
  const allowed = new Set(["account_reviewer", "fetched_job_reviewer", "both"]);
  it("POST: the account reviewer and the fetched-job reviewer merge; every other role is refused and nothing moves", async () => {
    for (const who of WHO) {
      const a = await org(), s = await org();
      const r = await doMerge(who, a, s);
      if (allowed.has(who)) {
        expect(okay(r)).toMatchObject({ ok: true, absorbed: String(a), survivor: String(s) });
        expect((await one("select merged_into_id from organisation where id = $1", [a])).merged_into_id).toBe(String(s));
      } else {
        is(r, 403, "not_company_staff");
        expect((await one("select merged_into_id from organisation where id = $1", [a])).merged_into_id).toBeNull();
      }
    }
  });
  it("GET: the five matrix roles see the two companies; the services case handler, the content editor and a role-less login do not", async () => {
    const [a, s] = [await org(), await org()];
    const q = `?id=${a}&id=${s}`;
    for (const who of ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "administrator", "both"]) {
      const r = await call(merge, M, who, undefined, { query: q });
      expect(r.status, who).toBe(200);
      expect(r.json.companies.map((c: { id: string }) => c.id)).toEqual([String(a), String(s)]);
    }
    for (const who of ["services_case_handler", "content_editor", "norole"]) is(await call(merge, M, who, undefined, { query: q }), 403, "not_company_viewer");
    is(await call(merge, M, "administrator", undefined, { query: "?id=1&id=2&id=3" }), 400, "bad_input");
    is(await call(merge, M, "administrator", undefined, { query: "?id=abc" }), 400, "bad_input");
    is(await call(merge, M, "administrator"), 400, "bad_input");
  });
  it("is refused for no session, a disabled login, a bad Origin, a big or unknown or odd body", async () => {
    const [a, s] = [await org(), await org()];
    is(await doMerge(null, a, s), 401, "no_session");
    is(await call(merge, M, null, undefined, { query: `?id=${a}` }), 401, "no_session");
    is(await doMerge("disabled", a, s), 401, "not_active");
    is(await call(merge, M, "disabled", undefined, { query: `?id=${a}` }), 401, "not_active");
    is(await doMerge("account_reviewer", a, s, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    is(await doMerge("account_reviewer", a, s, { origin: "https://evil.example" }), 403, "bad_origin");
    is(await doMerge("account_reviewer", a, s, { origin: null }), 403, "bad_origin");
    is(await doMerge("account_reviewer", a, s, { length: "999999" }), 400, "bad_body");
    is(await call(merge, M, "account_reviewer", { absorbedId: String(a), survivorId: String(s), extra: 1 }), 400, "bad_body");
    is(await call(merge, M, "account_reviewer", { absorbedId: String(a), survivorId: String(s), padding: "x".repeat(2000) }), 400, "bad_body");
    is(await call(merge, M, "account_reviewer", undefined, { raw: "[1,2]" }), 400, "bad_body");
    is(await call(merge, M, "account_reviewer", undefined, { raw: "{not json" }), 400, "bad_body");
    is(await call(merge, M, "account_reviewer", undefined, { raw: "null" }), 400, "bad_body");
    for (const bad of [1, "0", "-3", "1e3", "1 or 1=1", " 5", "5\n", "\u202E5", "9".repeat(25), null, true, {}, []]) is(await call(merge, M, "account_reviewer", { absorbedId: bad, survivorId: String(s) }), 400, "bad_input");
    expect((await one("select merged_into_id from organisation where id = $1", [a])).merged_into_id).toBeNull();
  });
  it("answers the database's refusals with their codes, and touches only the two companies named", async () => {
    const a = await org({ status: "verified" }), s = await org(), other = await org(), c = await org({ kind: "agency" });
    await F.member(a, await F.portal(), { role: "account_owner" });
    is(await doMerge("account_reviewer", a, s), 409, "active_members");
    is(await doMerge("account_reviewer", s, s), 400, "same_company");
    is(await doMerge("account_reviewer", s, "88888888"), 404, "not_found");
    is(await doMerge("account_reviewer", s, c), 409, "kind_mismatch");
    okay(await doMerge("account_reviewer", s, other));
    is(await doMerge("account_reviewer", s, other), 409, "already_merged");
    is(await doMerge("account_reviewer", other, s), 409, "target_merged");
    expect((await su.query("select id from organisation where id in ($1, $2, $3) and merged_into_id is not null", [a, c, other])).rows.map((x) => x.id)).toEqual([]);
    expect((await one("select merged_into_id from organisation where id = $1", [s])).merged_into_id).toBe(String(other));
  });
});

describe("owner-reassign route", () => {
  it("POST request: only the account reviewer; every other role is refused and nothing is written", async () => {
    for (const who of WHO) {
      const t = await team();
      const r = await doOwner(who, { action: "request", membershipId: String(t.next), domainChecked: true, croChecked: true });
      if (AR.has(who)) expect(okay(r)).toMatchObject({ ok: true, organisationId: String(t.o) });
      else {
        is(r, 403, "not_account_reviewer");
        expect((await one("select count(*)::int c from owner_reassign where organisation_id = $1", [t.o])).c).toBe(0);
      }
    }
  });
  it("POST complete and cancel: only the account reviewer", async () => {
    for (const action of ["complete", "cancel"]) {
      const t = await team();
      const r = okay(await doOwner("account_reviewer", { action: "request", membershipId: String(t.next), domainChecked: true, croChecked: true }));
      await su.query("update owner_reassign set requested_at = requested_at - interval '8 days', completes_after = completes_after - interval '8 days' where id = $1", [r.requestId]);
      for (const who of WHO.filter((x) => !AR.has(x))) is(await doOwner(who, { action, requestId: r.requestId }), 403, "not_account_reviewer");
      is(await doOwner("disabled", { action, requestId: r.requestId }), 401, "not_active");
      expect((await one("select status from owner_reassign where id = $1", [r.requestId])).status).toBe("open");
      okay(await doOwner("account_reviewer", { action, requestId: r.requestId }));
      expect((await one("select status from owner_reassign where id = $1", [r.requestId])).status).toBe(action === "complete" ? "done" : "cancelled");
    }
  });
  it("the 7 days are enforced through the route, with the code too_early", async () => {
    const t = await team();
    const r = okay(await doOwner("account_reviewer", { action: "request", membershipId: String(t.next), domainChecked: true, croChecked: true }));
    is(await doOwner("account_reviewer", { action: "complete", requestId: r.requestId }), 409, "too_early");
    is(await doOwner("account_reviewer", { action: "request", membershipId: String(t.next), domainChecked: true, croChecked: true }), 409, "request_open");
    expect((await one("select role from membership where id = $1", [t.owner])).role).toBe("account_owner");
  });
  it("GET: account reviewers only", async () => {
    const t = await team();
    okay(await doOwner("account_reviewer", { action: "request", membershipId: String(t.next), domainChecked: true, croChecked: true }));
    const r = await call(owner, O, "account_reviewer");
    expect(r.status).toBe(200);
    expect(r.json.items.some((x: { organisation_id: string }) => x.organisation_id === String(t.o))).toBe(true);
    for (const who of [...WHO.filter((x) => !AR.has(x)), "disabled"]) expect((await call(owner, O, who)).status, who).toBe(who === "disabled" ? 401 : 403);
    is(await call(owner, O, null), 401, "no_session");
    is(await call(owner, O, "account_reviewer", undefined, { query: "?after=abc" }), 400, "bad_cursor");
    is(await call(owner, O, "account_reviewer", undefined, { query: "?after=1;select" }), 400, "bad_cursor");
  });
  it("hostile input: the ticks must be real booleans, ids plain digits, no unknown fields, Origin and size checked", async () => {
    const t = await team();
    const req = { action: "request", membershipId: String(t.next), domainChecked: true, croChecked: true };
    is(await doOwner("account_reviewer", { ...req, domainChecked: false }), 400, "not_checked");
    is(await doOwner("account_reviewer", { ...req, croChecked: false }), 400, "not_checked");
    for (const bad of ["true", 1, null, "yes"]) is(await doOwner("account_reviewer", { ...req, domainChecked: bad }), 400, "bad_body");
    const { croChecked: _omit, ...missing } = req; void _omit;
    is(await doOwner("account_reviewer", missing), 400, "bad_body");
    is(await doOwner("account_reviewer", { ...req, role: "account_owner" }), 400, "bad_body");
    is(await doOwner("account_reviewer", { ...req, membershipId: "1 or 1=1" }), 400, "bad_input");
    is(await doOwner("account_reviewer", { ...req, membershipId: 5 }), 400, "bad_input");
    is(await doOwner("account_reviewer", { action: "complete", requestId: "1", extra: 1 }), 400, "bad_body");
    is(await doOwner("account_reviewer", { action: "complete" }), 400, "bad_input");
    is(await doOwner("account_reviewer", { action: "reassign" }), 400, "bad_action");
    is(await doOwner("account_reviewer", { membershipId: "1" }), 400, "bad_action");
    is(await doOwner("account_reviewer", req, { origin: "https://evil.example" }), 403, "bad_origin");
    is(await doOwner("account_reviewer", req, { origin: null }), 403, "bad_origin");
    is(await doOwner("account_reviewer", req, { length: "5000" }), 400, "bad_body");
    is(await doOwner("account_reviewer", { ...req, pad: "x".repeat(1500) }), 400, "bad_body");
    expect((await one("select count(*)::int c from owner_reassign where organisation_id = $1", [t.o])).c).toBe(0);
  });
  it("another company's members: a request names a member, and only that member's company changes", async () => {
    const a = await team(), b = await team();
    const r = okay(await doOwner("account_reviewer", { action: "request", membershipId: String(a.next), domainChecked: true, croChecked: true }));
    await su.query("update owner_reassign set requested_at = requested_at - interval '8 days', completes_after = completes_after - interval '8 days' where id = $1", [r.requestId]);
    okay(await doOwner("account_reviewer", { action: "complete", requestId: r.requestId }));
    expect((await su.query("select role from membership where organisation_id = $1 order by id", [b.o])).rows.map((x) => x.role)).toEqual(["account_owner", "recruiter"]);
    expect((await one("select count(*)::int c from owner_reassign where organisation_id = $1", [b.o])).c).toBe(0);
    expect((await one("select count(*)::int c from email_outbox where params->>'organisationId' = $1", [String(b.o)])).c).toBe(0);
  });
});

describe("manual-jobs route", () => {
  it("POST create: only the account reviewer; every other role is refused and nothing is written", async () => {
    const o = await org({ status: "verified" });
    for (const who of WHO) {
      const before = (await one("select count(*)::int c from job where organisation_id = $1", [o])).c;
      const r = await doManual(who, post(o));
      if (AR.has(who)) expect(okay(r)).toMatchObject({ ok: true, status: "live", passRoute: "stated_pay", reason: null });
      else {
        is(r, 403, "not_account_reviewer");
        expect((await one("select count(*)::int c from job where organisation_id = $1", [o])).c).toBe(before);
      }
    }
    is(await doManual("disabled", post(o)), 401, "not_active");
    is(await doManual(null, post(o)), 401, "no_session");
  });
  it("a post that fails the checks comes back as a draft with the reason", async () => {
    const o = await org({ status: "verified" });
    const r = okay(await doManual("account_reviewer", post(o, { salaryLow: 30000, salaryHigh: null })));
    expect(r).toMatchObject({ status: "draft", passRoute: null, reason: { code: "pay_below_minimum" } });
    const j = await one("select status, badge, source from job where id = $1", [r.jobId]);
    expect(j).toEqual({ status: "draft", badge: null, source: "admin_manual" });
  });
  it("POST close: only the account reviewer who posted it", async () => {
    const o = await org({ status: "verified" });
    const mine = okay(await doManual("account_reviewer", post(o))).jobId, theirs = okay(await doManual("both", post(o))).jobId;
    for (const who of WHO.filter((x) => !AR.has(x))) is(await doManual(who, { action: "close", jobId: mine }), 403, "not_account_reviewer");
    is(await doManual("both", { action: "close", jobId: mine }), 403, "not_poster");
    is(await doManual("account_reviewer", { action: "close", jobId: theirs }), 403, "not_poster");
    is(await doManual("disabled", { action: "close", jobId: mine }), 401, "not_active");
    okay(await doManual("account_reviewer", { action: "close", jobId: mine }));
    is(await doManual("account_reviewer", { action: "close", jobId: mine }), 409, "bad_state");
    is(await doManual("account_reviewer", { action: "close", jobId: "77777777" }), 404, "not_found");
    expect((await one("select status from job where id = $1", [theirs])).status).toBe("live");
    // an employer's own job (another side's row) is never reachable through this route
    const src = Number((await one("select id from job_source where kind = 'admin'")).id);
    const emp = (await one("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url) values ($1, 'employer', $2, 't', 'e', 'it', 'critical_skills', 'draft', now() + interval '5 days', 'https://x.example.ie/1') returning id", [o, src])).id;
    is(await doManual("account_reviewer", { action: "close", jobId: emp }), 404, "not_found");
    expect((await one("select status from job where id = $1", [emp])).status).toBe("draft");
  });
  it("GET: the account reviewer, the trust and safety officer and the administrator; every other role is refused", async () => {
    const o = await org({ status: "verified" });
    okay(await doManual("account_reviewer", post(o)));
    for (const who of ["account_reviewer", "trust_and_safety", "administrator", "both"]) {
      const r = await call(manual, J, who);
      expect(r.status, who).toBe(200);
      expect(r.json.items[0]).toMatchObject({ status: "live", organisation_id: String(o) });
    }
    for (const who of ["fetched_job_reviewer", "rules_data_editor", "services_case_handler", "content_editor", "norole"]) is(await call(manual, J, who), 403, "not_manual_viewer");
    is(await call(manual, J, "disabled"), 401, "not_active");
    is(await call(manual, J, null), 401, "no_session");
    is(await call(manual, J, "administrator", undefined, { query: "?before=x" }), 400, "bad_cursor");
  });
  it("hostile input: unknown fields, a badge, control and format characters, bad ids, Origin, size, odd JSON", async () => {
    const o = await org({ status: "verified" });
    const before = (await one("select count(*)::int c from job where source = 'admin_manual'")).c;
    is(await doManual("account_reviewer", { ...post(o), badge: "sponsor_confirmed" }), 400, "bad_body");
    is(await doManual("account_reviewer", { ...post(o), postedByStaffId: staff.administrator }), 400, "bad_body");
    is(await doManual("account_reviewer", { ...post(o), status: "live" }), 400, "bad_body");
    is(await doManual("account_reviewer", post(o, { title: "Eng‮ineer" })), 400, "bad_title");
    is(await doManual("account_reviewer", post(o, { description: desc + "\u0000" })), 400, "bad_description");
    is(await doManual("account_reviewer", post(o, { applyUrl: "javascript:alert(1)//x" })), 400, "bad_apply_url");
    is(await doManual("account_reviewer", post(o, { organisationId: "1;drop table job" })), 400, "bad_organisation_id");
    is(await doManual("account_reviewer", post(o, { closesOn: "2099-01-01" })), 400, "bad_closing_date");
    is(await doManual("account_reviewer", { action: "delete" }), 400, "bad_action");
    is(await doManual("account_reviewer", { title: "x" }), 400, "bad_action");
    is(await doManual("account_reviewer", { action: "close", jobId: "1", extra: 1 }), 400, "bad_body");
    is(await doManual("account_reviewer", { action: "close", jobId: "abc" }), 400, "bad_input");
    is(await doManual("account_reviewer", post(o), { origin: "https://evil.example" }), 403, "bad_origin");
    is(await doManual("account_reviewer", post(o), { origin: null }), 403, "bad_origin");
    is(await doManual("account_reviewer", post(o), { length: "100000" }), 400, "bad_body");
    is(await doManual("account_reviewer", post(o, { description: "x".repeat(31_000) })), 400, "bad_body");
    is(await doManual("account_reviewer", post(o, { description: "x".repeat(10_001) })), 400, "bad_description");
    is(await call(manual, J, "account_reviewer", undefined, { raw: "[]" }), 400, "bad_body");
    is(await call(manual, J, "account_reviewer", undefined, { raw: "{" }), 400, "bad_body");
    is(await doManual("account_reviewer", post(88888888)), 404, "company_not_found");
    expect((await one("select count(*)::int c from job where source = 'admin_manual'")).c).toBe(before);
  });
  it("another company's rows: a post lands on the named company only, and the audit row says which", async () => {
    const a = await org({ status: "verified" }), b = await org({ status: "verified" });
    const r = okay(await doManual("account_reviewer", post(a)));
    expect((await one("select organisation_id from job where id = $1", [r.jobId])).organisation_id).toBe(String(a));
    expect((await one("select count(*)::int c from job where organisation_id = $1", [b])).c).toBe(0);
    expect((await one("select after->>'organisation_id' o from audit_event where action = 'job.manual_post' and object_id = $1", [r.jobId])).o).toBe(String(a));
  });
});

// ===== performance: statements and time per request. requireStaff is 2 statements of each; measured on 13 November 2026: merge = begin-less single call (3), merge preview 4,
// request 3, owner list 4, manual create = begin, role check, company, closing date, job, advert text, audit, commit (10), manual list 4. Times are medians of 9 warm calls:
// merge 2.6 ms, owner list 2.5, manual create 3.5, manual list 1.7; the limits are about 4 times the slowest, with a floor for a busy laptop. Raise these only on purpose.
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: (i: number) => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(i); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
describe("performance", () => {
  it("each route stays inside its statement and time budget", async () => {
    const BUDGET = { merge: 3, mergeGet: 4, owner: 3, ownerList: 4, manual: 10, manualList: 4, mergeMs: 20, manualMs: 25, listMs: 15 };
    const pairs = Array.from({ length: 12 }, async () => [await org(), await org()] as const);
    const ps = await Promise.all(pairs);
    const [, c1] = await counted(async () => okay(await doMerge("account_reviewer", ps[0]![0], ps[0]![1])));
    const [, c2] = await counted(() => call(merge, M, "administrator", undefined, { query: `?id=${ps[1]![0]}&id=${ps[1]![1]}` }));
    const t = await team();
    const [, c3] = await counted(async () => okay(await doOwner("account_reviewer", { action: "request", membershipId: String(t.next), domainChecked: true, croChecked: true })));
    const [, c4] = await counted(() => call(owner, O, "account_reviewer"));
    const o = await org({ status: "verified" });
    const [, c5] = await counted(async () => okay(await doManual("account_reviewer", post(o))));
    const [, c6] = await counted(() => call(manual, J, "administrator"));
    for (const [k, v] of Object.entries({ merge: c1, mergeGet: c2, owner: c3, ownerList: c4, manual: c5, manualList: c6 })) expect(v, k).toBeLessThanOrEqual(BUDGET[k as keyof typeof BUDGET]);
    const med = [await median((i) => doMerge("account_reviewer", ps[2 + (i % 9)]![0], ps[2 + (i % 9)]![1])), await median(() => call(owner, O, "account_reviewer")),
      await median(() => doManual("account_reviewer", post(o))), await median(() => call(manual, J, "administrator"))];
    expect(med[0]).toBeLessThan(BUDGET.mergeMs);
    expect(med[1]).toBeLessThan(BUDGET.listMs);
    expect(med[2]).toBeLessThan(BUDGET.manualMs);
    expect(med[3]).toBeLessThan(BUDGET.listMs);
  });
});
