// Step 16 round 1, agent p1 (B2, B47, B49, B50), end to end on the test database through the real route handlers of apps/portal, connected as app_portal, with
// real portal sessions, and through apps/portal/lib/data.ts (the page data layer) with only Next's own `server-only` and `next/headers` faked. No test reaches
// the network. Fake people and companies only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { savePostingTexts } from "../src/posting-texts-cli";

// The page's headers, as Next gives them to a Server Component (data.ts reads them through next/headers).
const page = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => page.headers }));

// Statements counted on every pg.Client.query call, measured on 23 Nov 2026: the verification read 4 (session 3, the function), one job 4 (session 3, the read),
// the page data layer the same as the route it runs (it adds no statement). Medians of 9 warm calls were 2 to 4 ms; budgets are about 8 times that, a floor for a busy laptop.
const BUDGET = { verification: 4, job: 4, jobMs: 30, verificationMs: 30 };

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request, ctx: never) => Promise<Response>;
let db: TestDb, su: pg.Pool, AUTH: (r: Request) => Promise<Response>;
const R = {} as Record<"verification" | "jobs" | "job" | "edit" | "check", Record<string, Handler>>;
let D: typeof import("../../../apps/portal/lib/data");
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  R.verification = await import("../../../apps/portal/app/api/portal/verification/route") as never;
  R.jobs = await import("../../../apps/portal/app/api/portal/jobs/route") as never;
  R.job = await import("../../../apps/portal/app/api/portal/jobs/[id]/route") as never;
  R.edit = await import("../../../apps/portal/app/api/portal/jobs/edit/route") as never;
  R.check = await import("../../../apps/portal/app/api/portal/jobs/check/route") as never;
  D = await import("../../../apps/portal/lib/data");
  const c = await db.pool("app_admin").connect();
  try { await savePostingTexts(c); } finally { c.release(); }
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit where key not like '%:sign-%'"); });

let n = 0;
async function login() {
  const email = `fake.p1.${++n}.${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from portal_user where email=$1", [email])).rows[0].id as string };
}
type Login = { cookie?: string; id?: string };
async function call(h: Handler, p: Login, o: { body?: unknown; params?: Record<string, string>; origin?: string | null } = {}) {
  const method = o.body === undefined ? "GET" : "POST";
  const headers: Record<string, string> = p.cookie ? { cookie: p.cookie } : {};
  if (method === "POST") { headers["content-type"] = "application/json"; if (o.origin !== null) headers.origin = o.origin ?? BASE; }
  const res = await h(new Request(`${BASE}/api/portal/x`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) } as never);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, code: json?.code as string | undefined };
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
async function company(o: { kind?: string; name?: string; status?: string } = {}) {
  const kind = o.kind ?? "employer";
  const org = String(await F.org({ kind, name: o.name ?? "Fake Payments Limited", status: o.status, wrc: kind === "agency" ? `EA9${++n}` : null }));
  const m = async (role: string) => { const l = await login(); return { ...l, mem: String(await F.member(org, l.id, { role, signer: role === "account_owner" || role === "recruiter" })) }; };
  return { org, owner: await m("account_owner"), poster: await m("poster"), viewer: await m("viewer") };
}
const spec = () => loadSpec("portal");
const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const good = { status: "live", title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractType: "permanent",
  salaryLow: 50000, salaryHigh: 60000, ownPageUrl: "https://careers.example.ie/jobs/1" };
const post = (p: Login, body: unknown) => call(R.jobs.POST!, p, { body });
const jobOf = (p: Login, id: string) => call(R.job.GET!, p, { params: { id } });
const check = (p: Login, body: unknown) => call(R.check.POST!, p, { body });

describe("B47: GET /api/portal/verification", () => {
  const verification = (p: Login) => call(R.verification.GET!, p);
  /** A company waiting for review, with the staff review item open, the way a claim leaves it. */
  async function waiting(status = "pending_review", cro: string | null | undefined = undefined) {
    const c = await company({ status });
    cro = cro === undefined ? String(910000 + ++n) : cro;
    if (cro) await su.query("update organisation set cro_number = $2 where id = $1", [c.org, cro]);
    await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'claim')", [c.org]);
    return c;
  }
  it("shows the email check, the CRO row, the DETE match and when the review opened; and matches the contract", async () => {
    const c = await waiting();
    const cro = (await one("select cro_number from organisation where id = $1", [c.org])).cro_number as string;
    await su.query("insert into cro_company(cro_number, name, normalised_name, status, county, last_seen_on) values ($1, 'FAKE VERIFY LIMITED', 'fake verify', 'Normal', 'Cork', current_date)", [cro]);
    const opened = (await one("select created_at from review_item where organisation_id = $1", [c.org])).created_at as Date;
    const r = await verification(c.owner);
    expect(r.status).toBe(200);
    expect(r.json.verification).toEqual({ organisationId: c.org, status: "pending_review", emailVerified: true, croNumber: cro, croFound: true, croName: "FAKE VERIFY LIMITED",
      croStatus: "Normal", deteMatch: false, reviewOpenedAt: opened.toISOString(), question: null });
    expect(replyProblems(spec(), "get", "/api/portal/verification", 200, r.json)).toEqual([]);
    await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1::bigint, 'fake verify', 'fake verify ' || $1::text, 'legal', 'dete')", [c.org]);
    expect((await verification(c.owner)).json.verification.deteMatch).toBe(true);
  });
  it("says so when the CRO number is not in the register or the company has none, and when the email is not verified", async () => {
    const lost = await waiting("pending_review", "919099");
    expect((await verification(lost.owner)).json.verification).toMatchObject({ croNumber: "919099", croFound: false, croName: null, croStatus: null });
    const none = await waiting("pending_review", null);
    expect((await verification(none.owner)).json.verification).toMatchObject({ croNumber: null, croFound: null });
    await su.query("update portal_user set email_verified = false where id = $1", [none.owner.id]);
    expect((await verification(none.owner)).json.verification.emailVerified).toBe(false);
  });
  it("gives the newest question of staff to the owner only, only while the company is waiting for an answer", async () => {
    const c = await waiting("needs_info");
    const note = (q: string | null, at: string) => su.query(`insert into notification(portal_user_id, category, template_key, params, created_at) values ($1, 'account', 'account_needs_info', $2, $3)`,
      [c.owner.id, JSON.stringify({ organisationId: c.org, reason: "needs_info", ...(q ? { question: q } : {}) }), at]);
    await note("An older question?", "2026-11-01T10:00:00Z");
    await note("Which director signed you up?", "2026-11-02T10:00:00Z");
    await su.query("insert into notification(portal_user_id, category, template_key, params) values ($1, 'account', 'account_approved', '{\"question\":\"not this\"}')", [c.owner.id]);
    expect((await verification(c.owner)).json.verification.question).toBe("Which director signed you up?");
    await su.query("update membership set role = 'recruiter' where id = $1", [c.poster.mem]); // another member is never given the owner's question
    expect((await verification(c.poster)).json.verification.question).toBeNull();
    expect((await verification(c.viewer)).json.verification).toMatchObject({ status: "needs_info", question: null });
    await note(null, "2026-11-03T10:00:00Z"); // a newer decision with no question: the newest has none
    expect((await verification(c.owner)).json.verification.question).toBeNull();
    await su.query("update organisation set status = 'pending_review' where id = $1", [c.org]); // answered: no question to show
    expect((await verification(c.owner)).json.verification.question).toBeNull();
  });
  it("shows no other company, no staff id and no field beyond the contract; an item that is done shows no opened time", async () => {
    const a = await waiting(), b = await waiting();
    await su.query("update review_item set status = 'done', outcome = 'approved', decided_at = now() where organisation_id = $1", [b.org]);
    const r = await verification(a.owner);
    expect(Object.keys(r.json.verification).sort()).toEqual(["croFound", "croName", "croNumber", "croStatus", "deteMatch", "emailVerified", "organisationId", "question", "reviewOpenedAt", "status"]);
    expect(r.json.verification.organisationId).toBe(a.org);
    expect((await verification(b.owner)).json.verification.reviewOpenedAt).toBeNull();
  });
  it("security: no session, a login with no company, a removed member and a blocked login are refused", async () => {
    const c = await waiting();
    expect((await verification({})).code).toBe("NO_SESSION");
    expect((await verification(await login())).code).toBe("NO_COMPANY");
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [c.poster.mem]);
    expect((await verification(c.poster)).code).toBe("NO_COMPANY");
    await su.query("update portal_user set status = 'blocked', blocked_at = now(), blocked_reason_code = 'x' where id = $1", [c.viewer.id]);
    expect((await verification(c.viewer)).code).toBe("REFUSED");
    expect((await call(R.verification.GET!, c.owner, { params: { id: "1" } })).status).toBe(200); // a stray parameter changes nothing
  });
  it("security: the function answers for the named login's own company only, and refuses an unknown login", async () => {
    const a = await waiting(), b = await waiting();
    const asB = (await db.pool("app_portal").query("select private.verification_status($1) r", [b.owner.id])).rows[0].r;
    expect(String(asB.organisationId)).toBe(b.org);
    expect(String(asB.organisationId)).not.toBe(a.org);
    await expect(db.pool("app_portal").query("select private.verification_status($1)", ["no-such-login"])).rejects.toThrow(/status refused/);
  });
  it("performance: statements and time", async () => {
    const c = await waiting();
    await verification(c.owner);
    expect((await counted(() => verification(c.owner)))[1]).toBeLessThanOrEqual(BUDGET.verification);
    expect(await median(() => verification(c.owner))).toBeLessThan(BUDGET.verificationMs);
  });
});

describe("B49: own job reads and the looser draft", () => {
  it("the list adds the permit type, the route and whether an own page address is stored", async () => {
    const c = await company();
    expect((await post(c.owner, good)).status).toBe(200);
    expect((await post(c.owner, { status: "draft", title: "Chef" })).status).toBe(200);
    const r = await call(R.jobs.GET!, c.viewer);
    const byTitle = Object.fromEntries(r.json.jobs.map((j: { title: string }) => [j.title, j]));
    expect(byTitle["Software Engineer"]).toMatchObject({ permitType: "critical_skills", applicationRoute: "own_page", hasOwnPage: true });
    expect(byTitle["Chef"]).toMatchObject({ status: "draft", permitType: "critical_skills", applicationRoute: "own_page", hasOwnPage: false });
    expect(JSON.stringify(r.json)).not.toContain("careers.example.ie"); // the address itself is only in the one-job read
    expect(replyProblems(spec(), "get", "/api/portal/jobs", 200, r.json)).toEqual([]);
  });
  it("reads one own job in full, in the shape of the post body, with the current statement", async () => {
    const c = await company();
    const made = await post(c.owner, { ...good, statement: { signerName: "Fake Signer", signerTitle: "HR Director" }, healthInsuranceEur: 500, weeklyHours: 40, exceptionConfirmed: false });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const r = await jobOf(c.viewer, made.json.jobId); // a viewer reads, as the list
    expect(r.status).toBe(200);
    expect(r.json.job).toEqual({ id: made.json.jobId, status: "live", badge: "sponsor_confirmed", passRoute: "stated_pay", title: "Software Engineer", description: desc, county: "Dublin",
      occupationCode: "2136", contractType: "permanent", contractMonths: null, salaryLow: 50000, salaryHigh: 60000, payGrade: null, healthInsuranceEur: 500, weeklyHours: 40,
      ownPageUrl: good.ownPageUrl, clientName: null, permitType: "critical_skills", exceptionConfirmed: false,
      statement: { signerName: "Fake Signer", signerTitle: "HR Director", writtenAuthority: false }, postedAt: expect.any(String), closesAt: expect.any(String) });
    expect(replyProblems(spec(), "get", "/api/portal/jobs/{id}", 200, r.json)).toEqual([]);
    // the read is the edit form's own body: sent back to the edit route, it passes unchanged
    const { id, postedAt, closesAt, badge, passRoute, ...body } = r.json.job; // eslint-disable-line @typescript-eslint/no-unused-vars
    const edit = await call(R.edit.POST!, c.owner, { body: { ...body, jobId: id, statement: body.statement } });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
  });
  it("an agency job shows its client; a re-signed statement shows the new signer only", async () => {
    const a = await company({ kind: "agency", name: "Fake Agency Limited" });
    const made = await post(a.owner, { ...good, clientName: "Fake Client Limited", statement: { signerName: "First Signer", signerTitle: "Director", writtenAuthority: true } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const j = (await jobOf(a.owner, made.json.jobId)).json.job;
    expect(j).toMatchObject({ clientName: "Fake Client Limited", status: "in_review", statement: { signerName: "First Signer", writtenAuthority: true } });
    const edit = await call(R.edit.POST!, a.owner, { body: { ...good, jobId: made.json.jobId, clientName: "Fake Client Limited", statement: { signerName: "Second Signer", signerTitle: "Director", writtenAuthority: true } } });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    expect((await jobOf(a.owner, made.json.jobId)).json.job.statement.signerName).toBe("Second Signer");
  });
  it("a draft saves with a title alone, reads back empty, saves again loosely, and goes live only with every field", async () => {
    const c = await company();
    const d = await post(c.poster, { status: "draft", title: "Head Chef" });
    expect([d.status, d.json.status, d.json.passRoute]).toEqual([200, "draft", null]);
    const row = await one("select county, occupation_code, contract_type, own_page_url, sector, status from job where id = $1", [d.json.jobId]);
    expect(row).toEqual({ county: null, occupation_code: null, contract_type: null, own_page_url: null, sector: "other", status: "draft" });
    expect((await one("select advert_text from job_text where job_id = $1", [d.json.jobId])).advert_text).toBe("");
    const read = (await jobOf(c.poster, d.json.jobId)).json.job;
    expect(read).toMatchObject({ status: "draft", title: "Head Chef", description: "", county: null, occupationCode: null, contractType: null, ownPageUrl: null, weeklyHours: 39, statement: null });
    const again = await call(R.edit.POST!, c.poster, { body: { status: "draft", jobId: d.json.jobId, title: "Head Chef 2", county: "Cork", salaryLow: 42000 } });
    expect([again.status, again.json.status]).toEqual([200, "draft"]);
    expect((await jobOf(c.poster, d.json.jobId)).json.job).toMatchObject({ title: "Head Chef 2", county: "Cork", salaryLow: 42000 });
    expect((await call(R.edit.POST!, c.poster, { body: { status: "live", jobId: d.json.jobId, title: "Head Chef 2" } })).code).toBe("BAD_REQUEST"); // live needs every field
    const live = await call(R.edit.POST!, c.owner, { body: { ...good, jobId: d.json.jobId } });
    expect([live.status, live.json.status]).toEqual([200, "live"]);
  });
  it("a job past draft cannot be edited with a loose body, and a live post still needs every field", async () => {
    const c = await company();
    const live = await post(c.owner, good);
    const loose = await call(R.edit.POST!, c.owner, { body: { status: "draft", jobId: live.json.jobId, title: "Software Engineer" } });
    expect([loose.status, loose.code]).toEqual([400, "BAD_REQUEST"]);
    expect((await jobOf(c.owner, live.json.jobId)).json.job).toMatchObject({ status: "live", county: "Dublin", ownPageUrl: good.ownPageUrl });
    for (const missing of ["description", "county", "occupationCode", "contractType", "ownPageUrl"])
      expect((await post(c.owner, { ...good, [missing]: undefined })).code, missing).toBe("BAD_REQUEST");
    const before = Number((await one("select count(*) n from job where organisation_id = $1", [c.org])).n);
    expect((await post(c.owner, { status: "live", title: "Only a title" })).code).toBe("BAD_REQUEST");
    expect(Number((await one("select count(*) n from job where organisation_id = $1", [c.org])).n)).toBe(before);
  });
  it("the database lets only a draft lack its own page address", async () => {
    const c = await company();
    const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
    const ins = (status: string) => db.pool("app_portal").query(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, search_vector, posted_by_membership_id, salary_low)
       values ($1, 'employer', $2, 'Fake', 'Fake', 'IT', 'critical_skills', $3, now() + interval '20 days', to_tsvector('fake'), $4, 50000)`, [c.org, src, status, c.owner.mem]);
    await expect(ins("draft")).resolves.toBeDefined();
    await expect(ins("live")).rejects.toThrow(/job_check1/);
    await expect(ins("in_review")).rejects.toThrow(/job_check1/);
  });
  it("hostile draft bodies are refused or stored as plain text", async () => {
    const c = await company();
    for (const body of [{ status: "draft" }, { status: "draft", title: "x" }, { status: "draft", title: "Chef", county: "Atlantis" }, { status: "draft", title: "Chef", badge: "sponsor_confirmed" },
      { status: "draft", title: "Chef", passRoute: "stated_pay" }, { status: "draft", title: "Chef", organisationId: "1" }, { status: "draft", title: "Chef", ownPageUrl: "javascript:alert(1)//a" },
      { status: "draft", title: "Chef", description: "a\u0000b" }, { status: "draft", title: "Chef", description: "x".repeat(10_001) }, { status: "draft", title: "Chef‮" }, { status: "draft", title: ["Chef"] }])
      expect((await post(c.poster, body)).code, JSON.stringify(body).slice(0, 80)).toBe("BAD_REQUEST");
    const evil = await post(c.poster, { status: "draft", title: "Robert'); drop table job;--", description: "<script>alert(1)</script>" });
    expect(evil.status).toBe(200);
    expect((await jobOf(c.poster, evil.json.jobId)).json.job).toMatchObject({ title: "Robert'); drop table job;--", description: "<script>alert(1)</script>" });
    expect((await post(c.viewer, { status: "draft", title: "Chef" })).code).toBe("NOT_A_POSTER");
    expect((await post({}, { status: "draft", title: "Chef" })).code).toBe("NO_SESSION");
  });
  it("security: another company's job, a missing job and a login with no company are all refused alike; bad ids are 400", async () => {
    const mine = await company(), theirs = await company();
    const j = await post(theirs.owner, good);
    const jobId = j.json.jobId as string;
    expect((await jobOf(theirs.viewer, jobId)).status).toBe(200);
    const other = await jobOf(mine.owner, jobId);
    expect([other.status, other.code]).toEqual([404, "JOB_NOT_FOUND"]);
    expect((await jobOf(mine.owner, "999999999")).json).toEqual(other.json);
    expect((await jobOf(await login(), jobId)).code).toBe("NO_COMPANY");
    expect((await jobOf({}, jobId)).code).toBe("NO_SESSION");
    for (const id of ["abc", "0", "-1", "1.5", "07", "9223372036854775808", "1 or 1=1", "1;drop table job", "%00", "x".repeat(10_000), ""])
      expect((await jobOf(mine.owner, id)).code, id.slice(0, 30)).toBe("BAD_REQUEST");
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [theirs.viewer.mem]);
    expect((await jobOf(theirs.viewer, jobId)).code).toBe("NO_COMPANY");
    // a fetched job of the same company is never shown here
    const src = (await su.query("select id from job_source where kind <> 'portal' limit 1")).rows[0].id;
    const f = await one(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, search_vector, badge)
      values ($1, 'fetched', $2, 'Fetched', 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test/x', to_tsvector('x'), 'critical_skills_eligible') returning id::text`, [mine.org, src]);
    expect((await jobOf(mine.owner, f.id)).code).toBe("JOB_NOT_FOUND");
  });
  it("performance: statements and time of the one-job read", async () => {
    const c = await company();
    const j = await post(c.owner, good);
    await jobOf(c.owner, j.json.jobId);
    expect((await counted(() => jobOf(c.owner, j.json.jobId)))[1]).toBeLessThanOrEqual(BUDGET.job);
    expect(await median(() => jobOf(c.owner, j.json.jobId))).toBeLessThan(BUDGET.jobMs);
  });
});

describe("B50: POST /api/portal/jobs/check as a list", () => {
  it("lists every check of a passing post, with the minimum applied and the counted pay, and keeps the single answer", async () => {
    const c = await company();
    const r = await check(c.poster, { ...good, salaryLow: 40000, salaryHigh: null, healthInsuranceEur: 904 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, status: "live", passRoute: "stated_pay", sector: "IT" });
    expect(r.json.checks.map((x: { id: string }) => x.id)).toEqual(["occupation", "contract", "wording", "money", "pay"]);
    expect(r.json.checks.find((x: { id: string }) => x.id === "pay")).toEqual({ id: "pay", state: "pass", detail: { minimumEur: 40904, countedEur: 40904, healthInsuranceEur: 904, weeklyHours: 39, route: "stated_pay" } });
    expect(replyProblems(spec(), "post", "/api/portal/jobs/check", 200, r.json)).toEqual([]);
  });
  it("lists every blocked check, the matched money phrase and the first refusal as the code", async () => {
    const c = await company();
    const r = await check(c.poster, { ...good, contractType: "fixed_term", contractMonths: 12, salaryLow: 20000, salaryHigh: null, description: desc + " Candidates must pay a registration fee." });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("CONTRACT_TOO_SHORT");
    const by = (id: string) => r.json.checks.find((x: { id: string }) => x.id === id);
    expect(by("contract")).toMatchObject({ state: "blocked", code: "CONTRACT_TOO_SHORT", detail: { months: 12, minimumMonths: 24 } });
    expect(by("money")).toEqual({ id: "money", state: "note", detail: { phrase: "pay a registration fee" } });
    expect(by("pay")).toMatchObject({ state: "blocked", code: "PAY_BELOW_MINIMUM", detail: { minimumEur: 40904, countedEur: 20000 } });
    expect(replyProblems(spec(), "post", "/api/portal/jobs/check", 422, r.json)).toEqual([]);
    const real = await post(c.poster, { ...good, contractType: "fixed_term", contractMonths: 12, salaryLow: 20000, salaryHigh: null });
    expect([real.status, real.json.code]).toEqual([422, "CONTRACT_TOO_SHORT"]); // a save stops at the same first refusal
  });
  it("the client of an agency post is matched to the DETE names: found passes, not found is a note and the answer says in_review", async () => {
    await su.query("insert into organisation_name(name, normalised_name, kind, source) values ('Fake Known Client Limited', 'fake known client limited', 'alias', 'dete') on conflict do nothing");
    const a = await company({ kind: "agency", name: "Fake Agency Limited" });
    const body = (clientName: string) => ({ ...good, clientName, statement: { signerName: "Fake Signer", signerTitle: "Director", writtenAuthority: true } });
    const found = await check(a.owner, body("Fake  Known CLIENT limited."));
    expect(found.json).toMatchObject({ ok: true, status: "live" });
    expect(found.json.checks.find((x: { id: string }) => x.id === "client")).toEqual({ id: "client", state: "pass", detail: { found: true } });
    const lost = await check(a.owner, body("Fake Unknown Client Limited"));
    expect(lost.json).toMatchObject({ ok: true, status: "in_review" });
    expect(lost.json.checks.find((x: { id: string }) => x.id === "client")).toEqual({ id: "client", state: "note", detail: { found: false } });
    expect((await check((await company()).poster, good)).json.checks.some((x: { id: string }) => x.id === "client")).toBe(false); // an employer's post has no client line
  });
  it("CF98: an agency posting for a public body gets no public pay route; the public body itself still does", async () => {
    const grade = { ...good, salaryLow: null, salaryHigh: null, payGrade: "Staff Nurse scale" };
    const hospital = await company({ name: "Beaumont Hospital" });
    expect((await check(hospital.poster, grade)).json).toMatchObject({ ok: true, passRoute: "public_pay" });
    expect((await post(hospital.owner, grade)).json).toMatchObject({ status: "live", passRoute: "public_pay" });
    const a = await company({ kind: "agency", name: "Fake Agency Limited" });
    const viaClient = { ...grade, clientName: "Beaumont Hospital", statement: { signerName: "Fake Signer", signerTitle: "Director", writtenAuthority: true } };
    const dry = await check(a.owner, viaClient);
    expect([dry.status, dry.json.code]).toEqual([422, "PAY_REQUIRED"]);
    expect(dry.json.checks.find((x: { id: string }) => x.id === "pay")).toMatchObject({ state: "blocked", code: "PAY_REQUIRED", detail: { route: null } });
    const real = await post(a.owner, viaClient);
    expect([real.status, real.json.code]).toEqual([422, "PAY_REQUIRED"]);
    expect((await check(a.owner, { ...viaClient, salaryLow: 50000 })).json).toMatchObject({ ok: true, passRoute: "stated_pay" }); // stated pay over the minimum still passes
  });
  it("security: the list is the poster's own, and the refusals are unchanged", async () => {
    const c = await company();
    expect((await check(c.viewer, good)).code).toBe("NOT_A_POSTER");
    expect((await check({}, good)).code).toBe("NO_SESSION");
    expect((await check(c.poster, { ...good, clientName: "Fake Client Limited" })).code).toBe("CLIENT_ONLY_FOR_AGENCIES");
    expect((await check(c.poster, { status: "draft", title: "Chef" })).code).toBe("BAD_REQUEST"); // the check needs a whole post, even from a draft form
    expect((await check(c.poster, { ...good, description: "x".repeat(30_000) })).code).toBe("BODY_TOO_LARGE");
    const r = await check(c.poster, { ...good, description: desc + " <script>alert(1)</script> pay a registration fee" });
    expect(JSON.stringify(r.json.checks)).not.toMatch(/organisation|membership|userId|email/i);
  });
});

describe("B2: the page data layer (apps/portal/lib/data.ts)", () => {
  const as = (p: Login) => { page.headers = new Headers(p.cookie ? { cookie: p.cookie } : {}); };
  it("answers each read as its route does, for the page's own session", async () => {
    const c = await company();
    const j = await post(c.owner, good);
    as(c.viewer);
    expect(await D.readJobs()).toEqual({ status: 200, body: (await call(R.jobs.GET!, c.viewer)).json });
    expect((await D.readJob(j.json.jobId)).body).toEqual((await jobOf(c.viewer, j.json.jobId)).json);
    for (const [read, route] of [[D.readCompany, "company"], [D.readTeam, "team"], [D.readStatus, "status"], [D.readCases, "cases"], [D.readNotices, "notices"]] as const) {
      const got = await read();
      expect(got.status, route).toBe(200);
    }
    expect((await D.readJobStats({ days: "7" })).body).toMatchObject({ days: 7, stats: expect.any(Array) });
    expect((await D.readJobStats({ days: "0" })).status).toBe(400); // the query passes through to the route's own checks
    const login = await D.readLogin();
    expect(login).toMatchObject({ userId: c.viewer.id, membership: { organisationId: Number(c.org) || c.org, role: "viewer" } });
  });
  it("is refused as the route is: no session, no company, another company's job, a blocked login", async () => {
    const mine = await company(), theirs = await company();
    const j = await post(theirs.owner, good);
    as({});
    expect([(await D.readJobs()).status, (await D.readJobs()).body]).toEqual([401, { code: "NO_SESSION" }]);
    expect(await D.readLogin()).toBeNull();
    as(await login());
    expect((await D.readJobs()).body).toEqual({ code: "NO_COMPANY" });
    expect((await D.readVerification()).body).toEqual({ code: "NO_COMPANY" });
    as(mine.owner);
    expect((await D.readJob(j.json.jobId)).body).toEqual({ code: "JOB_NOT_FOUND" });
    expect((await D.readJob("not an id")).status).toBe(400);
    await su.query("update portal_user set status = 'blocked', blocked_at = now(), blocked_reason_code = 'x' where id = $1", [mine.owner.id]);
    expect((await D.readJobs()).body).toEqual({ code: "REFUSED" });
    expect(await D.readLogin()).toBeNull();
  });
  it("performance: a page read costs the statements of its route", async () => {
    const c = await company();
    as(c.owner);
    await D.readJobs();
    expect((await counted(() => D.readJobs()))[1]).toBeLessThanOrEqual(4);
    expect((await counted(() => D.readVerification()))[1]).toBeLessThanOrEqual(BUDGET.verification);
  });
});
