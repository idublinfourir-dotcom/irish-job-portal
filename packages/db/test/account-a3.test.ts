// Step 16 round 2, agent A3 (B31, B32, B38, B39, B40, B41 and the alert read by id): the candidate account reads and routes, end to end on the test
// database as app_candidate, through the real route handlers, the real Better Auth login and the data layer wrappers of apps/candidate/lib/data.ts.
// Only Next's request context is stood in (next/headers gives the headers a test sets; server-only is empty) and the confirmation email goes to the
// app's own fake sender (candidateMail). No network. Fake data only.
// Budgets (measured 23 November 2026, see the printed line): statements per signed-in read counted from the request, including the session read.
import { pressed } from "./confirm-link";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));

// session read (2) plus the route's own statements; 25 ms median; the tracker query reads about 2.5 pages a row (measured 50 for 20 rows).
// 27 Nov 2026, SEC-6: each read is one more, the read limit's count (markOne is a write and was already counted).
const BUDGET = { tracker: 4, notices: 4, security: 4, dataAccess: 4, alert: 4, markOne: 4, medianMs: 25, trackerPages: 70 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Data = typeof import("../../../apps/candidate/lib/data");
let db: TestDb, su: pg.Pool, D: Data, mail: () => { pool: string; kind: string; to: string; link: string }[];
let AUTH_GET: Handler, AUTH: Handler, TRACKER: Handler, TRACKER_PUT: Handler, NOTICES: Handler, NOTICES_POST: Handler, SECURITY: Handler, ACCESS: Handler, ALERTS: Handler, ALERTS_POST: Handler;
let CASES: Handler, CASE_ONE: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let org: string, src: string;
const spec = () => loadSpec("candidate");

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ GET: AUTH_GET, POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: TRACKER, PUT: TRACKER_PUT } = await import("../../../apps/candidate/app/api/candidate/tracker/route"));
  ({ GET: NOTICES, POST: NOTICES_POST } = await import("../../../apps/candidate/app/api/candidate/notices/route"));
  ({ GET: SECURITY } = await import("../../../apps/candidate/app/api/candidate/security/route"));
  ({ GET: ACCESS } = await import("../../../apps/candidate/app/api/candidate/data-access/route"));
  ({ GET: ALERTS, POST: ALERTS_POST } = await import("../../../apps/candidate/app/api/candidate/alerts/route"));
  ({ GET: CASES } = await import("../../../apps/candidate/app/api/candidate/cases/route"));
  ({ GET: CASE_ONE } = await import("../../../apps/candidate/app/api/candidate/cases/[id]/route"));
  ({ candidateMail: mail } = await import("../../../apps/candidate/lib/candidate"));
  mail = pressed(mail, "candidate");
  D = await import("../../../apps/candidate/lib/data");
  org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-a3-org', 'Fake A3 Org', 'employer', 'verified') returning id")).rows[0].id;
  src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-a3') returning id")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `10.${((++n) >> 8) & 255}.${n & 255}.7`; // a valid address: Better Auth's own limiter ignores one it cannot read
const json = { "content-type": "application/json", origin: BASE };
async function newJob(title: string, status = "live") {
  return (await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector)
     values ($1, 'admin_manual', $2, $3, 'Fake Employer', 'Cork', 'IT', '1122', 'critical_skills', 'critical_skills_eligible', false, $4, now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook'))
     returning id::text`, [org, src, title, status])).rows[0].id as string;
}
async function signUp(tag: string) {
  const email = `fake.a3.${tag}${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: { ...json, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` }, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }));
  expect(r.status).toBe(200);
  return { email, password };
}
async function signIn(email: string, password: string) {
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: { ...json, "x-vercel-forwarded-for": `198.51.100.${(++n % 200) + 10}` }, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function login(o: { suspended?: boolean } = {}) {
  const { email, password } = await signUp("u");
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const cookie = await signIn(email, password);
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  if (o.suspended) await su.query("update candidate_user set suspended_at=now() where id=$1", [id]);
  return { cookie, id, email, password };
}
const as = <T>(cookie: string | undefined, fn: () => Promise<T>, ip = freshIp()): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip });
  return fn();
};
type Got = { status: number; body: Record<string, unknown> };
async function call(route: Handler | typeof CASE_ONE, method: string, path: string, o: { cookie?: string; body?: unknown; raw?: string; origin?: string; params?: { id: string } } = {}): Promise<Got> {
  const res = await route(new Request(`${BASE}${path}`, {
    method, headers: { ...json, origin: o.origin ?? BASE, "x-vercel-forwarded-for": freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}) },
    ...(o.body !== undefined || o.raw !== undefined ? { body: o.raw ?? JSON.stringify(o.body) } : {}),
  }), { params: Promise.resolve(o.params ?? { id: "0" }) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const get = (route: Handler, path: string, cookie?: string) => call(route, "GET", path, { cookie });
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const t: number[] = [];
  for (let i = 0; i < 15; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[7]!;
};
const track = (userId: string, jobId: string, stage = "applied", route = "redirect") =>
  su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1, $2::bigint, $3, $4, $5)", [userId, jobId, route, route === "redirect" ? "mark_applied" : "on_site", stage]);

describe("every new signed-in read refuses a visitor, a forged cookie and a suspended candidate", () => {
  it("answers 401 NO_SESSION, 401 for a forged cookie, 403 REFUSED for a suspended candidate", async () => {
    const suspended = (await login({ suspended: true })).cookie;
    const table: [string, Handler, string][] = [["tracker", TRACKER, "/api/candidate/tracker"], ["notices", NOTICES, "/api/candidate/notices"], ["security", SECURITY, "/api/candidate/security"],
      ["data access", ACCESS, "/api/candidate/data-access"], ["alert by id", ALERTS, "/api/candidate/alerts?id=1"]];
    for (const [name, route, path] of table) {
      expect(await get(route, path), name).toMatchObject({ status: 401, body: { code: "NO_SESSION" } });
      expect((await get(route, path, "candidate.session_token=forged.value")).status, name).toBe(401);
      expect(await get(route, path, suspended), name).toMatchObject({ status: 403, body: { code: "REFUSED" } });
    }
    const wrappers: [string, () => Promise<{ ok: boolean; status?: number }>][] = [["tracker", () => D.readTracker()], ["notices", () => D.readNotices()], ["security", () => D.readSecurity()],
      ["data access", () => D.readDataAccess()], ["alert", () => D.readAlert("1")]];
    for (const [name, read] of wrappers) {
      expect(await as(undefined, read), name).toMatchObject({ ok: false, status: 401 });
      expect(await as(suspended, read), name).toMatchObject({ ok: false, status: 403 });
    }
  });
  it("the writes refuse a visitor, a wrong Origin and a suspended candidate too", async () => {
    const suspended = (await login({ suspended: true })).cookie, { cookie } = await login();
    expect((await call(NOTICES_POST, "POST", "/api/candidate/notices", { body: { action: "read_all" } })).status).toBe(401);
    expect(await call(NOTICES_POST, "POST", "/api/candidate/notices", { cookie, body: { action: "read_all" }, origin: "https://evil.example" })).toMatchObject({ status: 403, body: { code: "BAD_ORIGIN" } });
    expect(await call(NOTICES_POST, "POST", "/api/candidate/notices", { cookie: suspended, body: { action: "read_all" } })).toMatchObject({ status: 403, body: { code: "REFUSED" } });
  });
});

describe("B31: GET /api/candidate/tracker", () => {
  it("lists what the candidate tracks, newest change first, with route, stage and count; a closed job keeps only title, employer and reason", async () => {
    const { cookie, id } = await login();
    expect(await get(TRACKER, "/api/candidate/tracker", cookie)).toMatchObject({ status: 200, body: { tracker: [], count: 0 } });
    const [live, closing, onSite, hidden] = [await newJob("Fake Live Cook"), await newJob("Fake Closing Cook"), await newJob("Fake OnSite Cook"), await newJob("Fake Hidden Cook")];
    await track(id, closing);
    await track(id, live);
    await track(id, onSite, "shortlisted", "on_site");
    await track(id, hidden);
    await su.query("update job set status='closed', closed_at=now(), close_reason='closed' where id=$1", [closing]);
    await su.query("update job set status='hidden', hidden_reason='organisation_suspended', search_vector=null where id=$1", [hidden]);
    // the stage change goes through the real PUT, and moves the row to the top
    expect((await call(TRACKER_PUT, "PUT", "/api/candidate/tracker", { cookie, body: { jobId: live, stage: "interview" } })).status).toBe(200);
    const g = await get(TRACKER, "/api/candidate/tracker", cookie);
    expect(g.status).toBe(200);
    const rows = g.body.tracker as Record<string, unknown>[];
    expect(g.body.count).toBe(4);
    expect(rows.map((r) => r.jobId)).toEqual([live, hidden, onSite, closing]);
    expect(rows[0]).toMatchObject({ title: "Fake Live Cook", employerName: "Fake Employer", county: "Cork", live: true, reason: null, route: "redirect", stage: "interview", badge: "critical_skills_eligible" });
    expect(rows[2]).toMatchObject({ route: "on_site", stage: "shortlisted", live: true });
    // not live: only the stripped card plus route, stage and time
    for (const r of [rows[1]!, rows[3]!]) expect(Object.keys(r).sort(), String(r.title)).toEqual(["employerName", "jobId", "live", "reason", "route", "stage", "title", "updatedAt"]);
    expect(rows[3]).toMatchObject({ live: false, reason: "no_longer_available" });
    expect(rows[1]).toMatchObject({ live: false, reason: "no_longer_available" });
    expect(JSON.stringify(g.body)).not.toContain("ownPageUrl");
    expect(replyProblems(spec(), "GET", "/api/candidate/tracker", g.status, g.body)).toEqual([]);
    expect(await as(cookie, () => D.readTracker())).toMatchObject({ ok: true, data: g.body });
  });
  it("never shows another candidate's rows", async () => {
    const [a, b] = [await login(), await login()];
    const j = await newJob("Fake Private Cook");
    await track(a.id, j);
    expect(JSON.stringify((await get(TRACKER, "/api/candidate/tracker", b.cookie)).body)).not.toContain(j);
    expect((await get(TRACKER, "/api/candidate/tracker", b.cookie)).body).toMatchObject({ tracker: [], count: 0 });
  });
  it("caps the list at 200 and counts them all", async () => {
    const { cookie, id } = await login();
    await su.query(
      `with j as (insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, search_vector)
         select $1, 'admin_manual', $2, 'Fake Bulk ' || g, 'Fake Employer', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook')
         from generate_series(1, 205) g returning id)
       insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) select $3, id, 'redirect', 'mark_applied', 'applied' from j`, [org, src, id]);
    const g = await get(TRACKER, "/api/candidate/tracker", cookie);
    expect(g.body.count).toBe(205);
    expect(g.body.tracker).toHaveLength(200);
  });
});

describe("B32: the candidate's case read adds the employer, who pays and what we ask for now", () => {
  it("shows employerName, payer and documentsNeeded with labels, never a staff id or name, and never another candidate's case", async () => {
    const [a, b] = [await login(), await login()];
    const job = await newJob("Fake Case Job");
    const text = (await su.query("select id from consent_text where purpose='signup_terms' limit 1")).rows[0].id;
    const staff = "a3-staff";
    await su.query("insert into staff_user(id, name, email, email_verified) values ($1, 'Fake Staff Name A3', 'a3-staff@example.test', true)", [staff]);
    const k = async (u: string) => (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [u, text])).rows[0].id;
    const withJob = (await su.query(
      `insert into services_case(candidate_user_id, consent_record_id, job_id, organisation_id, payer, permit_type, assigned_staff_user_id, documents_needed)
       values ($1, $2, $3, $4, 'employer', 'critical_skills', $5, '{passport_copy,offer_letter,old_code}') returning id::text`, [a.id, await k(a.id), job, org, staff])).rows[0].id as string;
    const noJob = (await su.query("insert into services_case(candidate_user_id, consent_record_id, permit_type) values ($1, $2, 'general') returning id::text", [a.id, await k(a.id)])).rows[0].id as string;
    const viaOrg = (await su.query("insert into services_case(candidate_user_id, consent_record_id, permit_type, organisation_id, payer, status, closed_at, close_reason) values ($1, $2, 'general', $3, 'agency', 'closed', now(), 'withdrawn') returning id::text", [a.id, await k(a.id), org])).rows[0].id as string;
    const one = await call(CASE_ONE, "GET", `/api/candidate/cases/${withJob}`, { cookie: a.cookie, params: { id: withJob } });
    expect(one.status).toBe(200);
    expect(one.body.case).toMatchObject({
      id: withJob, jobTitle: "Fake Case Job", employerName: "Fake Employer", payer: "employer",
      documentsNeeded: [{ code: "passport_copy", label: "Passport copy" }, { code: "offer_letter", label: "Job offer letter" }, { code: "old_code", label: null }],
    });
    expect(JSON.stringify(one.body)).not.toMatch(/Fake Staff Name A3|a3-staff|assigned/);
    expect(replyProblems(spec(), "GET", "/api/candidate/cases/{id}", one.status, one.body)).toEqual([]);
    const list = await get(CASES, "/api/candidate/cases", a.cookie);
    const byId = new Map((list.body.cases as { id: string; employerName: string | null; payer: string | null; documentsNeeded: unknown[] }[]).map((c) => [c.id, c]));
    expect(byId.get(noJob)).toMatchObject({ employerName: null, payer: null, documentsNeeded: [] });
    expect(byId.get(viaOrg)).toMatchObject({ employerName: "Fake A3 Org", payer: "agency" }); // no job: the company's name
    expect(replyProblems(spec(), "GET", "/api/candidate/cases", list.status, list.body)).toEqual([]);
    expect(await call(CASE_ONE, "GET", `/api/candidate/cases/${withJob}`, { cookie: b.cookie, params: { id: withJob } })).toMatchObject({ status: 404, body: { code: "CASE_NOT_FOUND" } });
    expect(await as(a.cookie, () => D.readCase(withJob))).toMatchObject({ ok: true, data: { case: { employerName: "Fake Employer" } } });
  });
});

describe("B38: the update feed and the seen marker", () => {
  const seed = (id: string, count: number, tag: string) =>
    su.query(`insert into notification(candidate_user_id, category, template_key, params, dedupe_key, created_at)
      select $1, 'services_case', 'case_update', jsonb_build_object('caseId', g::text, 'kind', 'received'), $2 || g, now() - make_interval(secs => g) from generate_series(1, $3) g`, [id, tag, count]);
  it("pages 50 at a time, newest first, with a token; readAt starts null", async () => {
    const { cookie, id } = await login();
    await seed(id, 55, "feed-a:");
    const first = await get(NOTICES, "/api/candidate/notices", cookie);
    const items = first.body.items as { id: string; params: { caseId: string }; readAt: string | null; category: string; templateKey: string }[];
    expect(first.status).toBe(200);
    expect(items).toHaveLength(50);
    expect(items[0]).toMatchObject({ category: "services_case", templateKey: "case_update", params: { caseId: "1", kind: "received" }, readAt: null });
    expect(Object.keys(first.body).sort()).toEqual(["items", "next"]);
    expect(replyProblems(spec(), "GET", "/api/candidate/notices", first.status, first.body)).toEqual([]);
    const second = await get(NOTICES, `/api/candidate/notices?after=${first.body.next}`, cookie);
    expect(second.body.items).toHaveLength(5);
    expect(second.body.next).toBeNull();
    expect(new Set([...items, ...(second.body.items as typeof items)].map((i) => i.id)).size).toBe(55);
    expect(await as(cookie, () => D.readNotices({ after: String(first.body.next) }))).toMatchObject({ ok: true, data: { items: expect.any(Array) } });
  });
  it("refuses a bad token, another query key and a repeated token before reading", async () => {
    const { cookie } = await login();
    for (const q of ["after=x", "after=" + "a".repeat(5000), "after=%00", "after=eyJ0IjoiMSJ9", "after=a&after=b"]) expect((await get(NOTICES, `/api/candidate/notices?${q}`, cookie)).status, q).toBe(400);
    expect(await get(NOTICES, "/api/candidate/notices?after=x", cookie)).toMatchObject({ body: { code: "BAD_CURSOR" } });
    expect(await get(NOTICES, "/api/candidate/notices?limit=5", cookie)).toMatchObject({ status: 400, body: { code: "BAD_REQUEST" } });
  });
  it("marks one update or all of them seen, only the caller's own, and answers how many changed", async () => {
    const [a, b] = [await login(), await login()];
    await seed(a.id, 3, "mark-a:");
    await seed(b.id, 2, "mark-b:");
    const ids = ((await get(NOTICES, "/api/candidate/notices", a.cookie)).body.items as { id: string }[]).map((i) => i.id);
    const bIds = ((await get(NOTICES, "/api/candidate/notices", b.cookie)).body.items as { id: string }[]).map((i) => i.id);
    const post = (cookie: string, body: unknown) => call(NOTICES_POST, "POST", "/api/candidate/notices", { cookie, body });
    expect(await post(a.cookie, { action: "read", id: ids[0] })).toMatchObject({ status: 200, body: { marked: 1 } });
    expect((await post(a.cookie, { action: "read", id: ids[0] })).body).toEqual({ marked: 0 }); // already seen
    expect((await post(a.cookie, { action: "read", id: bIds[0] })).body).toEqual({ marked: 0 }); // another candidate's
    expect((await post(a.cookie, { action: "read", id: "999999999" })).body).toEqual({ marked: 0 });
    const readAt = async (c: string) => ((await get(NOTICES, "/api/candidate/notices", c)).body.items as { readAt: string | null }[]).map((i) => i.readAt !== null);
    expect(await readAt(a.cookie)).toEqual([true, false, false]);
    expect(await readAt(b.cookie)).toEqual([false, false]);
    expect((await post(a.cookie, { action: "read_all" })).body).toEqual({ marked: 2 });
    expect(await readAt(a.cookie)).toEqual([true, true, true]);
    expect(await readAt(b.cookie)).toEqual([false, false]);
    const ok = await post(a.cookie, { action: "read_all" });
    expect(replyProblems(spec(), "POST", "/api/candidate/notices", ok.status, ok.body)).toEqual([]);
  });
  it("refuses a hostile body", async () => {
    const { cookie } = await login();
    const bodies: unknown[] = [{}, { action: "delete" }, { action: "read" }, { action: "read", id: "abc" }, { action: "read", id: "1; drop table notification" }, { action: "read", id: 1 },
      { action: "read_all", id: "1" }, { action: "read", id: "1", extra: true }, [], "read_all", null, { action: "read", id: "9".repeat(40) }];
    for (const body of bodies) expect((await call(NOTICES_POST, "POST", "/api/candidate/notices", { cookie, body })).status, JSON.stringify(body)).toBe(400);
    expect((await call(NOTICES_POST, "POST", "/api/candidate/notices", { cookie, raw: "{not json" })).status).toBe(400);
    expect((await call(NOTICES_POST, "POST", "/api/candidate/notices", { cookie, raw: JSON.stringify({ action: "read_all", pad: "x".repeat(3000) }) })).status).toBe(413);
  });
  it("shows the case update notice the database writes for a case event", async () => {
    const { cookie, id } = await login();
    const text = (await su.query("select id from consent_text where purpose='signup_terms' limit 1")).rows[0].id;
    const k = (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [id, text])).rows[0].id;
    const c = (await su.query("insert into services_case(candidate_user_id, consent_record_id) values ($1, $2) returning id::text", [id, k])).rows[0].id;
    await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'received', 'received', $2)", [c, id]);
    expect((await get(NOTICES, "/api/candidate/notices", cookie)).body.items).toMatchObject([{ category: "services_case", templateKey: "case_update", params: { caseId: c, kind: "received" } }]);
  });
});

describe("B39: the registration body list", () => {
  it("gives a visitor and a candidate the five bodies as id, name and address, from the rules code file", async () => {
    const { cookie } = await login();
    for (const who of [undefined, cookie]) {
      const r = await as(who, () => D.readRegistrationBodies());
      expect(r).toMatchObject({ ok: true });
      const bodies = (r as { data: { bodies: { id: string; name: string; url: string }[] } }).data.bodies;
      expect(bodies.map((b) => b.id)).toEqual(["nmbi", "medical_council", "coru", "phecc", "psi"]);
      for (const b of bodies) { expect(Object.keys(b).sort()).toEqual(["id", "name", "url"]); expect(b.url).toMatch(/^https:\/\//); expect(b.name.length).toBeLessThanOrEqual(120); }
    }
  });
});

describe("B40: password date, sign-in methods, the Better Auth routes and the provider flag", () => {
  it("gives the password date and the methods, and the date moves on a password change", async () => {
    const { cookie, email, password } = await login();
    const first = await get(SECURITY, "/api/candidate/security", cookie);
    expect(first).toMatchObject({ status: 200, body: { signInMethods: ["credential"] } });
    expect(typeof first.body.passwordChangedAt).toBe("string");
    expect(replyProblems(spec(), "GET", "/api/candidate/security", first.status, first.body)).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    const bad = await call(AUTH, "POST", "/api/auth/candidate/change-password", { cookie, body: { currentPassword: "Wrong-password-1", newPassword: "New-password-12345" } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_PASSWORD");
    expect((await get(SECURITY, "/api/candidate/security", cookie)).body.passwordChangedAt).toBe(first.body.passwordChangedAt);
    const ok = await call(AUTH, "POST", "/api/auth/candidate/change-password", { cookie, body: { currentPassword: password, newPassword: "New-password-12345" } });
    expect(ok.status).toBe(200);
    const next = await get(SECURITY, "/api/candidate/security", cookie);
    expect(Date.parse(String(next.body.passwordChangedAt))).toBeGreaterThan(Date.parse(String(first.body.passwordChangedAt)));
    expect(await signIn(email, "New-password-12345")).toContain("session_token"); // the new password works
    // a password under 8 characters or over 128 is refused
    for (const newPassword of ["short", "x".repeat(129)]) expect((await call(AUTH, "POST", "/api/auth/candidate/change-password", { cookie, body: { currentPassword: "New-password-12345", newPassword } })).status).toBe(400);
    expect((await call(AUTH, "POST", "/api/auth/candidate/change-password", { body: { currentPassword: password, newPassword: "New-password-12345" } })).status).toBe(401);
  });
  it("list-accounts shows the methods without the hash, unlink-account removes Google and refuses the last method", async () => {
    const { cookie, id } = await login();
    const listed = await call(AUTH_GET, "GET", "/api/auth/candidate/list-accounts", { cookie });
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body) && listed.body.length).toBe(1);
    expect(JSON.stringify(listed.body)).toContain("credential");
    expect(JSON.stringify(listed.body)).not.toMatch(/scrypt|"password"|hash/i);
    expect((await call(AUTH_GET, "GET", "/api/auth/candidate/list-accounts")).status).toBe(401);
    await su.query("insert into candidate_account(id, account_id, provider_id, user_id, updated_at) values ($1, 'fake-google-sub', 'google', $2, now())", [`a3-google-${id}`, id]);
    expect((await get(SECURITY, "/api/candidate/security", cookie)).body.signInMethods).toEqual(["credential", "google"]);
    expect((await call(AUTH, "POST", "/api/auth/candidate/unlink-account", { body: { accountId: `a3-google-${id}` } })).status).toBeGreaterThanOrEqual(400); // no session: refused
    const unlinked = await call(AUTH, "POST", "/api/auth/candidate/unlink-account", { cookie, body: { accountId: `a3-google-${id}` } });
    expect(unlinked.status).toBe(200);
    expect((await get(SECURITY, "/api/candidate/security", cookie)).body.signInMethods).toEqual(["credential"]);
    const credential = ((await call(AUTH_GET, "GET", "/api/auth/candidate/list-accounts", { cookie })).body as unknown as { id: string }[])[0]!.id;
    const last = await call(AUTH, "POST", "/api/auth/candidate/unlink-account", { cookie, body: { accountId: credential } });
    expect(last.status).toBe(400);
    expect(last.body.code).toBe("FAILED_TO_UNLINK_LAST_ACCOUNT");
    expect((await get(SECURITY, "/api/candidate/security", cookie)).body.signInMethods).toEqual(["credential"]);
  });
  it("a Google-only login has no password date", async () => {
    const { cookie, id } = await login();
    await su.query("insert into candidate_account(id, account_id, provider_id, user_id, updated_at) values ($1, 'fake-google-sub-2', 'google', $2, now())", [`a3-google2-${id}`, id]);
    await su.query("delete from candidate_account where user_id = $1 and provider_id = 'credential'", [id]);
    expect((await get(SECURITY, "/api/candidate/security", cookie)).body).toEqual({ passwordChangedAt: null, signInMethods: ["google"] });
  });
  it("tells a page whether Google is on: only when both settings are set", async () => {
    const keep = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
    try {
      delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
      expect(D.readSignInProviders()).toEqual({ google: false });
      process.env.GOOGLE_CLIENT_ID = "fake-id";
      expect(D.readSignInProviders()).toEqual({ google: false });
      process.env.GOOGLE_CLIENT_SECRET = "fake-secret";
      expect(D.readSignInProviders()).toEqual({ google: true });
      process.env.GOOGLE_CLIENT_ID = "";
      expect(D.readSignInProviders()).toEqual({ google: false });
    } finally {
      for (const [k, v] of [["GOOGLE_CLIENT_ID", keep.id], ["GOOGLE_CLIENT_SECRET", keep.secret]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  describe("change-unverified-email (C27: Wrong address? Change it)", () => {
    const change = (body: unknown, ip = freshIp()) => AUTH(new Request(`${BASE}/api/auth/candidate/change-unverified-email`, { method: "POST", headers: { ...json, "x-vercel-forwarded-for": ip }, body: JSON.stringify(body) }))
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }));
    const emailOf = async (id: string) => (await su.query("select email, email_verified from candidate_user where id=$1", [id])).rows[0] as { email: string; email_verified: boolean };
    const idOf = async (email: string) => (await su.query("select id from candidate_user where email=$1", [email])).rows[0]?.id as string | undefined;

    it("moves an unconfirmed account to the new address and sends the link there; the old link stops working, and the new link confirms", async () => {
      const { email, password } = await signUp("wrong");
      const id = (await idOf(email))!;
      const oldLink = mail().filter((m) => m.to === email && m.kind === "verify").at(-1)!.link;
      const to = `fake.a3.right${n}@example.test`;
      const before = mail().length;
      expect(await change({ email, password, newEmail: to.toUpperCase() })).toMatchObject({ status: 200, body: { status: true } });
      expect(await emailOf(id)).toEqual({ email: to, email_verified: false });
      const sent = mail().slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to, kind: "verify" });
      const click = (link: string) => { const u = new URL(link); return AUTH_GET(new Request(`${BASE}${u.pathname}${u.search}`, { redirect: "manual", headers: { "x-vercel-forwarded-for": freshIp() } } as RequestInit)); };
      await click(oldLink);
      expect((await emailOf(id)).email_verified).toBe(false); // the old link names an address that no longer exists
      await click(sent[0]!.link);
      expect(await emailOf(id)).toEqual({ email: to, email_verified: true });
      expect(await signIn(to, password)).toContain("session_token");
    });
    it("the new link ends on the page the form names, and only on our own site", async () => {
      const landing = async (who: string, callbackURL: unknown) => {
        const { email, password } = await signUp(who);
        const before = mail().length;
        const { status } = await change({ email, password, newEmail: `fake.a3.cb.${who}.${n}@example.test`, callbackURL });
        const sent = mail().slice(before);
        if (status !== 200) return { status, sent: sent.length };
        const u = new URL(sent[0]!.link);
        const res = await AUTH_GET(new Request(`${BASE}${u.pathname}${u.search}`, { redirect: "manual", headers: { "x-vercel-forwarded-for": freshIp() } } as RequestInit));
        return new URL(res.headers.get("location") ?? "/", BASE).href;
      };
      expect(await landing("cbgood", "/verify?verified=1")).toBe(`${BASE}/verify?verified=1`);
      let i = 0;
      // Better Auth's origin check refuses an off-site address before the route runs; what it lets through and ownPath does not is dropped.
      for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/%2f%2fevil.example", "javascript:alert(1)"]) expect(await landing(`cbbad${i++}`, bad), bad).toEqual({ status: 403, sent: 0 });
      expect(await landing(`cbbad${i++}`, 7)).toEqual({ status: 400, sent: 0 });
      for (const none of ["/a b", null, undefined]) expect(await landing(`cbbad${i++}`, none), String(none)).toBe(`${BASE}/`);
    });
    it("a wrong password, an unknown address and an account with no password are the same 401, and nothing changes", async () => {
      const { email } = await signUp("wrongpw");
      const id = (await idOf(email))!;
      const before = mail().length;
      const a = await change({ email, password: "Wrong-password-1", newEmail: "fake.a3.nothing@example.test" });
      const b = await change({ email: "fake.a3.nobody@example.test", password: "Wrong-password-1", newEmail: "fake.a3.nothing@example.test" });
      await su.query("insert into candidate_account(id, account_id, provider_id, user_id, updated_at) values ($1, 'fake-g', 'google', $2, now())", [`a3-g3-${id}`, id]);
      await su.query("delete from candidate_account where user_id = $1 and provider_id = 'credential'", [id]);
      const c = await change({ email, password: "Wrong-password-1", newEmail: "fake.a3.nothing@example.test" });
      for (const r of [a, b, c]) expect(r).toEqual({ status: 401, body: expect.objectContaining({ code: "INVALID_EMAIL_OR_PASSWORD" }) });
      expect((await emailOf(id)).email).toBe(email);
      expect(mail()).toHaveLength(before);
    });
    it("a confirmed account is refused (the right password only), and a taken new address answers 200 and changes and sends nothing", async () => {
      const verified = await login();
      expect(await change({ email: verified.email, password: verified.password, newEmail: "fake.a3.any@example.test" })).toMatchObject({ status: 400, body: { code: "ALREADY_VERIFIED" } });
      expect((await emailOf(verified.id)).email).toBe(verified.email);
      const { email, password } = await signUp("taken");
      const id = (await idOf(email))!;
      const before = mail().length;
      expect(await change({ email, password, newEmail: verified.email })).toMatchObject({ status: 200, body: { status: true } });
      expect((await emailOf(id)).email).toBe(email);
      expect(mail()).toHaveLength(before);
    });
    it("refuses a bad body: wrong types, a long address or password, a malformed new address, extra keys do no harm", async () => {
      const { email, password } = await signUp("hostile");
      const id = (await idOf(email))!;
      const ok = "fake.a3.fine@example.test";
      const bad: unknown[] = [undefined, null, [], "x", {}, { email, password }, { email, newEmail: ok }, { password, newEmail: ok }, { email: 1, password, newEmail: ok },
        { email, password: ["a"], newEmail: ok }, { email, password, newEmail: { a: 1 } }, { email, password, newEmail: "not an address" }, { email, password, newEmail: "a@b" },
        { email, password, newEmail: `${"a".repeat(250)}@example.test` }, { email: `${"a".repeat(250)}@example.test`, password, newEmail: ok }, { email, password: "x".repeat(129), newEmail: ok },
        { email, password: "", newEmail: ok }, { email, password, newEmail: "a b@example.test" }, { email, password, newEmail: "a\u0000@example.test" }, { email, password, newEmail: "a@exa\nmple.test" },
        { email, password, newEmail: "x@example.test, y@example.test" }];
      for (const body of bad) { const r = await change(body); expect(r.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500); }
      expect((await emailOf(id)).email).toBe(email);
    });
    it("is limited per client address (5 in 5 minutes) and per old address (3 an hour)", async () => {
      const { email, password } = await signUp("limits");
      const ip = freshIp();
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await change({ email, password: "Wrong-password-1", newEmail: "fake.a3.nothing@example.test" }, ip)).status);
      expect(codes).toEqual([401, 401, 401, 429]); // the fourth try on one old address is over the 3 an hour
      const ipLimited = [];
      for (let i = 0; i < 7; i++) ipLimited.push((await change({ email: `fake.a3.lim${i}@example.test`, password, newEmail: "fake.a3.nothing@example.test" }, "198.51.100.250")).status);
      expect(ipLimited.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(ipLimited[5]).toBe(429);
    });
  });
});

describe("B41: who viewed my data", () => {
  it("lists the accesses by someone else, newest first, with a name only for an organisation, never an id; the candidate's own export is not in it", async () => {
    const [a, b] = [await login(), await login()];
    const staff = "a3-staff-2", portal = "a3-portal-2";
    await su.query("insert into staff_user(id, name, email, email_verified) values ($1, 'Fake Staff Name Two', 'a3-staff2@example.test', true) on conflict do nothing", [staff]);
    await su.query("insert into portal_user(id, name, email, email_verified) values ($1, 'Fake Portal Person', 'a3-portal2@example.test', true)", [portal]);
    await su.query("insert into membership(portal_user_id, organisation_id, role, status) values ($1, $2, 'recruiter', 'active')", [portal, org]);
    await su.query(`insert into audit_event(kind, actor_staff_user_id, action, subject_candidate_user_id, reason_text, source, at) values ('data_access', $1, 'staff.view', $2, 'STAFFREASON', 'panel', now() - interval '3 hours')`, [staff, a.id]);
    await su.query(`insert into audit_event(kind, actor_portal_user_id, action, subject_candidate_user_id, reason_text, source, at) values ('data_access', $1, 'contact_request.accept', $2, 'PORTALREASON', 'site', now() - interval '1 hour')`, [portal, a.id]);
    await su.query(`insert into audit_event(kind, actor_system, action, subject_candidate_user_id, reason_text, source, at) values ('data_access', 'x', 'system.read', $1, 'SYSREASON', 'scheduled_job', now() - interval '2 hours')`, [a.id]);
    await su.query(`insert into audit_event(kind, actor_staff_user_id, action, subject_candidate_user_id, reason_text, source) values ('data_access', $1, 'staff.view', $2, 'OTHERREASON', 'panel')`, [staff, b.id]);
    await su.query(`insert into audit_event(kind, actor_candidate_user_id, action, object_type, object_id, subject_candidate_user_id, source) values ('data_access', $1, 'candidate.export', 'candidate_user', $1, $1, 'site')`, [a.id]);
    const g = await get(ACCESS, "/api/candidate/data-access", a.cookie);
    expect(g.status).toBe(200);
    expect((g.body.log as { by: string; action: string }[]).map((x) => [x.by, x.action])).toEqual([["Fake A3 Org", "contact_request.accept"], ["Portal system", "system.read"], ["Portal staff", "staff.view"]]);
    expect(JSON.stringify(g.body)).not.toMatch(/Fake Staff Name Two|Fake Portal Person|a3-staff|a3-portal|REASON|candidate\.export/);
    expect(replyProblems(spec(), "GET", "/api/candidate/data-access", g.status, g.body)).toEqual([]);
    expect((await get(ACCESS, "/api/candidate/data-access", b.cookie)).body.log).toHaveLength(1);
    expect(await as(a.cookie, () => D.readDataAccess())).toMatchObject({ ok: true, data: g.body });
    expect((await get(ACCESS, "/api/candidate/data-access", (await login()).cookie)).body).toEqual({ log: [] });
  });
  it("keeps at most 200 rows", async () => {
    const { cookie, id } = await login();
    await su.query(`insert into audit_event(kind, actor_system, action, subject_candidate_user_id, source, at)
      select 'data_access', 'x', 'system.read', $1, 'scheduled_job', now() - make_interval(secs => g) from generate_series(1, 230) g`, [id]);
    expect(((await get(ACCESS, "/api/candidate/data-access", cookie)).body.log as unknown[])).toHaveLength(200);
  });
});

describe("the alert read by id (the edit form from the alert email)", () => {
  const mk = async (cookie: string, county: string) => {
    const r = await call(ALERTS_POST, "POST", "/api/candidate/alerts", { cookie, body: { county, frequency: "weekly" } });
    expect(r.status).toBe(200);
    return (r.body.alert as { id: string }).id;
  };
  it("reads one alert, only the caller's, and keeps the list as it was", async () => {
    const [a, b] = [await login(), await login()];
    const [one, two] = [await mk(a.cookie, "Dublin"), await mk(a.cookie, "Cork")];
    const g = await get(ALERTS, `/api/candidate/alerts?id=${one}`, a.cookie);
    expect(g).toMatchObject({ status: 200, body: { alert: { id: one, county: "Dublin", frequency: "weekly", status: "active" } } });
    expect(Object.keys(g.body)).toEqual(["alert"]);
    expect(JSON.stringify(g.body)).not.toMatch(/unsubscribe|token/i);
    expect(replyProblems(spec(), "GET", "/api/candidate/alerts", g.status, g.body)).toEqual([]);
    expect(await get(ALERTS, `/api/candidate/alerts?id=${one}`, b.cookie)).toMatchObject({ status: 404, body: { code: "ALERT_NOT_FOUND" } });
    expect(await get(ALERTS, "/api/candidate/alerts?id=999999999", a.cookie)).toMatchObject({ status: 404, body: { code: "ALERT_NOT_FOUND" } });
    const list = await get(ALERTS, "/api/candidate/alerts", a.cookie);
    expect((list.body.alerts as { id: string }[]).map((x) => x.id)).toEqual([two, one]);
    expect(await as(a.cookie, () => D.readAlert(one))).toMatchObject({ ok: true, data: { alert: { id: one } } });
    expect(await as(b.cookie, () => D.readAlert(one))).toMatchObject({ ok: false, status: 404 });
  });
  it("refuses a hostile id or another key with 400", async () => {
    const { cookie } = await login();
    for (const q of ["id=abc", "id=", "id=0", "id=-1", "id=1;drop table alert", "id=" + "9".repeat(40), "id=" + "a".repeat(5000), "id=1&id=2", "id=1&x=2", "id=%00", "id=1.5"])
      expect((await get(ALERTS, `/api/candidate/alerts?${q}`, cookie)).status, q).toBe(400);
  });
});

describe("performance: statements and time of the new reads", () => {
  it("stay inside their budgets (statements counted from the request, with the session read) and the tracker query inside its page budget", async () => {
    const { cookie, id } = await login();
    for (let i = 0; i < 20; i++) await track(id, await newJob(`Fake Perf Cook ${i}`));
    await su.query(`insert into notification(candidate_user_id, category, template_key, params, dedupe_key) select $1, 'services_case', 'case_update', '{}', 'perf:' || g from generate_series(1, 60) g`, [id]);
    const alertId = (await call(ALERTS_POST, "POST", "/api/candidate/alerts", { cookie, body: { county: "Cork", frequency: "daily" } })).body.alert as { id: string };
    const markId = ((await get(NOTICES, "/api/candidate/notices", cookie)).body.items as { id: string }[])[0]!.id;
    const run: Record<string, () => Promise<unknown>> = {
      tracker: () => get(TRACKER, "/api/candidate/tracker", cookie), notices: () => get(NOTICES, "/api/candidate/notices", cookie), security: () => get(SECURITY, "/api/candidate/security", cookie),
      dataAccess: () => get(ACCESS, "/api/candidate/data-access", cookie), alert: () => get(ALERTS, `/api/candidate/alerts?id=${alertId.id}`, cookie),
      markOne: () => call(NOTICES_POST, "POST", "/api/candidate/notices", { cookie, body: { action: "read", id: markId } }),
    };
    const seen: string[] = [];
    for (const [name, fn] of Object.entries(run)) {
      await fn();
      const [, statements] = await counted(fn);
      const ms = await median(fn);
      seen.push(`${name} ${statements} statements ${ms.toFixed(1)} ms`);
      expect(statements, name).toBeLessThanOrEqual(BUDGET[name as keyof typeof BUDGET] as number);
      expect(ms, name).toBeLessThan(BUDGET.medianMs);
    }
    console.log(`account reads: ${seen.join(", ")}`);
    const app = await db.pool("app_candidate").connect();
    try {
      const plan = (await app.query(
        `explain (analyze, buffers, format json) select j.id, j.title, (j.status = 'live' and j.closes_at > now()) as live, t.route, t.stage, t.updated_at, count(*) over ()::int
         from tracker_entry t join job j on j.id = t.job_id where t.candidate_user_id = $1 order by t.updated_at desc, t.id desc limit 200`, [id])).rows[0]["QUERY PLAN"][0].Plan;
      const pages = plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
      console.log(`tracker query pages ${pages} for 20 rows`);
      expect(pages).toBeLessThanOrEqual(BUDGET.trackerPages);
    } finally { app.release(); }
  });
});
