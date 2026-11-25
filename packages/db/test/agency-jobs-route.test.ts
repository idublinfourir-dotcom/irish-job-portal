// P11, end to end on the test database: "Jobs posted for you by agencies" and "I don't recognise this" through the real portal handlers,
// connected as app_portal, with real portal sessions (sign-up and sign-in through the real auth route). Fake people and companies only; the
// email stays in the outbox (no test reaches the network).
// Statements counted on every pg.Client.query call, measured on 19 November 2026: the list 4 (requirePortal 3, the query), a press 5
// (requirePortal 3, rate count 1, the function). Times, median of 9 calls, warm: list 2 to 4 ms, press 3 to 5 ms. Budgets about 5 times that.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listReports } from "../src/trust-safety";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

const BUDGET = { list: 4, press: 5, listMs: 25, pressMs: 25 };
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, LIST: Handler, PRESS: Handler;
let F: { org(o?: object): Promise<string>; member(org: string, user: string | null, o?: object): Promise<string>; staff(): Promise<string> };
// the client C, the agency A (posts for C and for another client D), a bystander company X
let C: string, D: string, A: string, X: string, aOwner: string, src: string;
let owner: Login, viewer: Login, recruiter: Login, agencyOwner: Login, other: Login, loner: Login;

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
type Login = { cookie: string; id: string };
async function login(): Promise<Login> {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from portal_user where email=$1", [email])).rows[0].id };
}
async function member(org: string, role: string) { const l = await login(); await F.member(org, l.id, { role }); return l; }
const named = (org: string, name: string) =>
  su.query("insert into organisation_name(organisation_id,name,normalised_name,kind,source) values ($1,$2,btrim(regexp_replace(lower($2),'[^a-z0-9]+',' ','g')),'legal','admin')", [org, name]);
/** An agency job (as postgres, so job_defaults links the client name). */
async function job(o: { org?: string; client?: string; status?: string; source?: string; posted?: string } = {}): Promise<string> {
  const status = o.status ?? "live", source = o.source ?? "agency", org = o.org ?? A;
  const by = source === "agency" && org === A ? aOwner : null;
  const id: string = (await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,
       permit_employer_kind,permit_employer_name,posted_by_membership_id,hidden_reason,badge)
     values ($1,$2,$3,$4,'Fake Recruit','it','critical_skills',$5,now()+interval '20 days','https://example.test/a',to_tsvector('english','x'),40000,
       'client',$6,$7,$8,$9) returning id`,
    [org, source, src, uid("Role "), status, o.client ?? "Fake Client Ltd", by, status === "hidden" ? "admin" : null, source === "fetched" ? "critical_skills_eligible" : null])).rows[0].id;
  if (o.posted) await su.query("update job set posted_at=$2 where id=$1", [id, o.posted]); // job_guard stamps now() on an insert straight to live
  return id;
}
async function get(cookie: string | undefined, qs = "") {
  const res = await LIST(new Request(`${BASE}/api/portal/agency-jobs${qs}`, { headers: cookie ? { cookie } : {} }));
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}
async function press(cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await PRESS(new Request(`${BASE}/api/portal/agency-jobs/not-recognised`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers }));
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text, code: (JSON.parse(text) as { code?: string }).code };
}
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
const counts = async (jobId: string) => (await su.query(
  `select (select count(*)::int from report where target_job_id = $1) reports, (select count(*)::int from strike) strikes,
     (select count(*)::int from notification where template_key = 'job_hidden' and params->>'jobId' = $1::text) notices,
     (select count(*)::int from email_outbox where template = 'job_hidden' and params->>'jobId' = $1::text) emails`, [jobId])).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: LIST } = await import("../../../apps/portal/app/api/portal/agency-jobs/route"));
  ({ POST: PRESS } = await import("../../../apps/portal/app/api/portal/agency-jobs/not-recognised/route"));
  src = (await su.query("select id from job_source where kind='portal' and board='employer'")).rows[0].id;
  C = await F.org({ name: "Fake Client Ltd" });
  D = await F.org({ name: "Fake Other Client" });
  X = await F.org({ name: "Fake Bystander" });
  A = await F.org({ name: "Fake Recruit", kind: "agency", wrc: uid("EA") });
  await named(C, "Fake Client Ltd");
  await named(C, "Fake Client Trading");
  await named(D, "Fake Other Client");
  owner = await member(C, "account_owner");
  viewer = await member(C, "viewer");
  recruiter = await member(C, "recruiter");
  agencyOwner = await login();
  aOwner = await F.member(A, agencyOwner.id, { role: "account_owner" });
  other = await member(X, "account_owner");
  loner = await login();
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit"); });

describe("the list", () => {
  it("shows the client's members exactly the live and under-review agency jobs naming them, newest first, and pages", async () => {
    const mine = [await job({ posted: "2026-11-01" }), await job({ status: "under_review", posted: "2026-11-02" }), await job({ client: "fake client trading!", posted: "2026-11-03" })];
    await job({ status: "hidden" }); await job({ status: "closed" }); await job({ status: "draft" }); // not shown
    await job({ client: "Fake Other Client" }); // the agency's other client
    await job({ org: C, source: "employer", client: "Fake Client Ltd" }); // the client's own job naming itself
    await job({ org: X, source: "fetched", client: "Fake Client Ltd" }); // a fetched job
    await job({ client: "Nobody We Know" }); // no matched name: listed to nobody
    for (const l of [owner, viewer, recruiter]) {
      const r = await get(l.cookie);
      expect(r.status).toBe(200);
      expect(r.json.jobs.map((j: { id: string }) => j.id)).toEqual([...mine].reverse());
      expect(r.json.jobs[0]).toMatchObject({ agencyName: "Fake Recruit", status: "live" });
      expect(Object.keys(r.json.jobs[0]).sort()).toEqual(["agencyId", "agencyName", "id", "postedAt", "status", "title"]);
      expect(r.json.next).toBeNull();
      expect(replyProblems(loadSpec("portal"), "GET", "/api/portal/agency-jobs", r.status, r.json)).toEqual([]);
    }
    expect((await get(other.cookie)).json.jobs).toEqual([]);
    expect((await get(agencyOwner.cookie)).json.jobs).toEqual([]);
    // paging: 22 more for C, same posted time (ties break on id)
    for (let i = 0; i < 22; i++) await job({ posted: "2026-11-10" });
    const p1 = await get(viewer.cookie);
    expect(p1.json.jobs.length).toBe(20);
    const p2 = await get(viewer.cookie, `?after=${p1.json.next}`);
    expect(p2.json.jobs.length).toBe(5);
    expect(p2.json.next).toBeNull();
    const all = [...p1.json.jobs, ...p2.json.jobs].map((j: { id: string }) => j.id);
    expect(new Set(all).size).toBe(25);
    expect(all.slice(-3)).toEqual([...mine].reverse());
  });
  it("refuses signed out, a junk session, a login with no company and hostile query strings", async () => {
    expect((await get(undefined)).status).toBe(401);
    expect((await get("better-auth.session_token=junk")).status).toBe(401);
    expect(await get(loner.cookie)).toMatchObject({ status: 404, json: { code: "NO_COMPANY" } });
    for (const qs of ["?after=", "?after=%00", "?after=" + "a".repeat(300), "?x=1", "?after=abc&after=abc", "?after=eyJ0IjoiMSIsImkiOiIxIn0", "?organisationId=" + D])
      expect(await get(owner.cookie, qs), qs).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
  });
  it("stays inside its statement and time budget", async () => {
    const [r, statements] = await counted(() => get(owner.cookie));
    expect(r.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET.list);
    expect(await median(() => get(owner.cookie))).toBeLessThan(BUDGET.listMs);
  });
});

describe("I don't recognise this", () => {
  it("files one report, hides a live job at once, tells the agency, opens no strike, and a second press writes nothing", async () => {
    const id = await job();
    const strikes = (await counts(id)).strikes;
    const [r, statements] = await counted(() => press(owner.cookie, { jobId: id }));
    expect([r.status, r.json]).toEqual([200, { ok: true, hidden: true }]);
    expect(statements).toBeLessThanOrEqual(BUDGET.press);
    expect(replyProblems(loadSpec("portal"), "POST", "/api/portal/agency-jobs/not-recognised", r.status, r.json)).toEqual([]);
    const j = (await su.query("select status, hidden_reason, hidden_report_id from job where id=$1", [id])).rows[0];
    const rep = (await su.query("select * from report where target_job_id=$1", [id])).rows;
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ target_kind: "job", reason: "not_recognised", status: "job_hidden", reporter_portal_user_id: owner.id });
    expect(j).toEqual({ status: "hidden", hidden_reason: "report", hidden_report_id: rep[0].id });
    expect(await counts(id)).toEqual({ reports: 1, strikes, notices: 1, emails: 1 });
    // no email to the client: nothing queued for any member of C
    expect((await su.query("select count(*)::int n from email_outbox e join membership m on m.portal_user_id = e.portal_user_id where m.organisation_id=$1", [C])).rows[0].n).toBe(0);
    // the staff reports queue shows it
    const ts = await F.staff();
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'trust_and_safety',true)", [ts]);
    const q = await listReports(db.pool("app_admin"), ts);
    expect(q.items.find((x) => x.id === rep[0].id)).toMatchObject({ reason: "not_recognised", status: "job_hidden", targetJobId: id });
    // a second press, the same answer, nothing written
    expect(await press(owner.cookie, { jobId: id })).toMatchObject({ status: 200, json: { ok: true, hidden: true } });
    expect(await counts(id)).toEqual({ reports: 1, strikes, notices: 1, emails: 1 });
  });
  it("a job under review is reported, not hidden (it is not public)", async () => {
    const id = await job({ status: "under_review" });
    expect((await press(owner.cookie, { jobId: id })).json).toEqual({ ok: true, hidden: false });
    expect((await su.query("select status from job where id=$1", [id])).rows[0].status).toBe("under_review");
    expect((await su.query("select status, reason from report where target_job_id=$1", [id])).rows).toEqual([{ status: "open", reason: "not_recognised" }]);
    expect((await press(owner.cookie, { jobId: id })).json).toEqual({ ok: true, hidden: false });
    expect((await counts(id)).reports).toBe(1);
  });
  it("two presses at once file one report", async () => {
    const id = await job();
    const rs = await Promise.all([press(owner.cookie, { jobId: id }), press(owner.cookie, { jobId: id })]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect((await counts(id)).reports).toBe(1);
  });
  it("refuses every other role and a job not posted for this company, and writes nothing", async () => {
    const id = await job(), forD = await job({ client: "Fake Other Client" }), own = await job({ org: C, source: "employer" });
    const hidden = await job({ status: "hidden" }), closed = await job({ status: "closed" }), fetched = await job({ org: X, source: "fetched" });
    expect(await press(viewer.cookie, { jobId: id })).toMatchObject({ status: 403, code: "NOT_OWNER" });
    expect(await press(recruiter.cookie, { jobId: id })).toMatchObject({ status: 403, code: "NOT_OWNER" });
    expect(await press(loner.cookie, { jobId: id })).toMatchObject({ status: 403, code: "NOT_A_MEMBER" });
    expect(await press(other.cookie, { jobId: id })).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    expect(await press(agencyOwner.cookie, { jobId: id })).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    expect(await press(undefined, { jobId: id })).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect(await press("better-auth.session_token=junk", { jobId: id })).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect(await press(owner.cookie, { jobId: id }, { origin: "https://evil.example" })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect(await press(owner.cookie, { jobId: id }, { origin: null })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    for (const j of [forD, own, hidden, closed, fetched, "999999999"]) expect(await press(owner.cookie, { jobId: j }), j).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    for (const raw of ["not json", "[]", "null", "{}", JSON.stringify({ jobId: Number(id) }), JSON.stringify({ jobId: "0" }), JSON.stringify({ jobId: "-1" }), JSON.stringify({ jobId: `${id}\u0000` }),
      JSON.stringify({ jobId: "9".repeat(30) }), JSON.stringify({ jobId: id, reason: "other" }), JSON.stringify({ jobId: id, organisationId: C }), JSON.stringify({ jobId: "1 or 1=1" })])
      expect(await press(owner.cookie, null, { raw }), raw).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await press(owner.cookie, null, { raw: JSON.stringify({ jobId: id, x: "y".repeat(5000) }) })).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    expect((await su.query("select count(*)::int n from report where target_job_id = any($1::bigint[])", [[id, forD, own, hidden, closed, fetched]])).rows[0].n).toBe(0);
    expect((await su.query("select status from job where id=$1", [id])).rows[0].status).toBe("live");
  });
  it("a blocked login is refused; the report rate limit applies", async () => {
    const b = await member(D, "account_owner");
    await su.query("update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='x' where id=$1", [b.id]);
    expect(await press(b.cookie, { jobId: await job({ client: "Fake Other Client" }) })).toMatchObject({ status: 403, code: "REFUSED" });
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await press(owner.cookie, { jobId: await job() })).status);
    expect(codes).toEqual([...Array(10).fill(200), 429]);
  });
  it("the database refuses the function to every caller but a client owner", async () => {
    const id = await job();
    const app = db.pool("app_portal");
    await expect(app.query("select private.client_not_recognised($1,$2)", [viewer.id, id])).rejects.toThrow(/NOT_OWNER/);
    await expect(app.query("select private.client_not_recognised($1,$2)", [other.id, id])).rejects.toThrow(/JOB_NOT_FOUND/);
    await expect(app.query("select private.client_not_recognised($1,$2)", ["nobody", id])).rejects.toThrow(/REFUSED/);
    for (const role of ["app_candidate", "app_fetcher", "app_admin"] as const)
      await expect(db.pool(role).query("select private.client_not_recognised($1,$2)", [owner.id, id]), role).rejects.toThrow(/permission denied/);
  });
  it("stays inside its time budget", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await job());
    let k = 0;
    await su.query("delete from portal_rate_limit");
    expect(await median(() => press(owner.cookie, { jobId: ids[k++] }))).toBeLessThan(BUDGET.pressMs);
  });
});
