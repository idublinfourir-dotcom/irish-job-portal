// Step 15 SV-A: the portal's permit services routes (M1 request, M2 tracker, withdraw; S-Q1 B) end to end on the test database, through the real
// auth route and the real route handlers of apps/portal (connected as app_portal). An active Owner or Recruiter requests; the requester and the
// company's Owners and Recruiters read; only the requester withdraws. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { saveServicesTexts } from "../src/services-texts-cli";
import { TRACKER_SQL } from "../src/services-request";
import { loadSpec, replyProblems } from "./openapi";

// A statement count includes the 3 session statements (session, user, membership) and the rate-limit statement of a write.
// list pages: the page of 21 rows, then the reader wrapper, the timeline and the copy count per row (see the candidate file); the Owner of a
// company with 500 cases reads about what the requester of 50 does.
const BUDGET = { request: { statements: 14, medianMs: 60 }, list: { statements: 4, medianMs: 40, pages: 2000 }, withdraw: { statements: 6, medianMs: 40 } };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request, ctx: never) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST", Handler>>;
let db: TestDb, su: pg.Pool;
let AUTH: (r: Request) => Promise<Response>;
const R = {} as Record<"cases" | "one" | "withdraw", Route>;
let F: { text(p?: string): Promise<string>; org(o?: object): Promise<string>; member(org: string, user: string, o?: object): Promise<string>; cand(): Promise<string> };
let src: string;

const job = async (org: string, status = "live") => String((await su.query(
  `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,salary_high,pay_grade)
   values ($1,'admin_manual',$2,'Fake Nurse','Fake Org','health','critical_skills',$3,now() + interval '20 days','https://example.test/a',to_tsvector('english','nurse'),50000,60000,'g1') returning id`,
  [org, src, status])).rows[0].id);

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  const c = await db.pool("app_admin").connect();
  try { await saveServicesTexts(c); } finally { c.release(); }
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret,
    CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  R.cases = await import("../../../apps/portal/app/api/portal/cases/route");
  R.one = await import("../../../apps/portal/app/api/portal/cases/[id]/route");
  R.withdraw = await import("../../../apps/portal/app/api/portal/cases/[id]/withdraw/route");
  src = (await su.query("insert into job_source(kind,board) values ('portal','sv-a-portal') returning id")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
type Login = { cookie?: string; id?: string };
async function login(org?: string, role?: string, status = "active"): Promise<Required<Login>> {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from portal_user where email=$1", [email])).rows[0].id as string;
  if (org) await F.member(org, id, { role, status });
  return { cookie, id };
}
/** A company with its four roles. */
async function company(kind = "employer") {
  const org = await F.org({ kind });
  return { org, owner: await login(org, "account_owner"), recruiter: await login(org, "recruiter"), poster: await login(org, "poster"), viewer: await login(org, "viewer") };
}
type Opts = { origin?: string | null; body?: unknown; raw?: string; params?: Record<string, string>; query?: string };
async function call(route: Route, method: keyof Route, p: Login, o: Opts = {}) {
  const headers: Record<string, string> = p.cookie ? { cookie: p.cookie } : {};
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  const body = method === "GET" ? undefined : (o.raw ?? (o.body === undefined ? "" : JSON.stringify(o.body)));
  const res = await route[method]!(new Request(`${BASE}/api/portal/cases${o.query ?? ""}`, { method, headers, body }), { params: Promise.resolve(o.params ?? {}) } as never);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, code: text ? (JSON.parse(text).code as string | undefined) : undefined, text };
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const offer = { occupationCode: "2231", annualPay: "45000", relevantDegree: "true", title: "Fake Nurse" };
const ask = (p: Login, body: Record<string, unknown> = {}) =>
  call(R.cases, "POST", p, { body: { permitType: "critical_skills", offerDetails: offer, servicesConsent: true, idempotencyKey: uid("key-0123456789abcdef"), ...body } });
const ids = (r: { json: { cases: { id: string }[] } }) => r.json.cases.map((c) => c.id);
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; console.info(`measured ${c} statements`); }
}
async function timed(fn: () => Promise<unknown>) {
  const ms: number[] = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  const m = ms.sort((a, b) => a - b)[4]!;
  console.info(`measured median ${m.toFixed(1)} ms`);
  return m;
}

describe("request (M1)", () => {
  it("an Owner asks on the company's job: the case, one consent record, the received event, the free check; the payer is the company's kind", async () => {
    const c = await company("agency");
    const j = await job(c.org);
    const key = "replay-key-0123456789";
    const r = await ask(c.owner, { jobId: j, idempotencyKey: key });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ replayed: false, freeCheck: { qualifies: true }, case: { status: "received", jobId: j, jobTitle: "Fake Nurse", permitType: "critical_skills" } });
    const row = (await one("select * from services_case where id = $1", [r.json.case.id]))[0];
    expect(row).toMatchObject({ portal_user_id: c.owner.id, candidate_user_id: null, organisation_id: c.org, job_id: j, payer: "agency", dedupe_key: `${c.owner.id}:${key}`, employer_contact_consent_record_id: null });
    expect(row.offer_details).toEqual({ details: offer, freeCheck: r.json.freeCheck });
    expect(await one("select t.purpose, r.job_id, r.organisation_id from consent_record r join consent_text t on t.id = r.consent_text_id where r.id = $1", [row.consent_record_id]))
      .toEqual([{ purpose: "services_request", job_id: j, organisation_id: c.org }]);
    expect(await one("select kind, status, portal_user_id, staff_user_id from case_event where case_id = $1", [row.id])).toEqual([{ kind: "received", status: "received", portal_user_id: c.owner.id, staff_user_id: null }]);
    // the replay of the same key is the same case, nothing new written; another key on the same job is another hire
    const again = await ask(c.owner, { jobId: j, idempotencyKey: key });
    expect([again.status, again.json.replayed, again.json.case.id]).toEqual([200, true, r.json.case.id]);
    expect(await one("select count(*)::int n from consent_record where portal_user_id = $1", [c.owner.id])).toEqual([{ n: 2 }]); // sign-up terms and this request
    expect((await ask(c.owner, { jobId: j })).status).toBe(200);
    // the same key from another login is that login's own request
    expect((await ask(c.recruiter, { jobId: j, idempotencyKey: key })).json.replayed).toBe(false);
  });
  it("Owner and Recruiter may ask, with or without a job; Poster, Viewer, no company, a member awaiting approval and a suspended company may not", async () => {
    const c = await company();
    expect((await ask(c.recruiter)).status).toBe(200);
    const none = await ask(c.owner);
    expect(none.status).toBe(200);
    expect((await one("select payer, organisation_id, job_id from services_case where id = $1", [none.json.case.id]))[0]).toEqual({ payer: "employer", organisation_id: c.org, job_id: null });
    for (const p of [c.poster, c.viewer, await login(), await login(c.org, "recruiter", "awaiting_approval")]) expect((await ask(p)).code).toBe("ROLE_REFUSED");
    const s = await company();
    await su.query("update organisation set status = 'suspended' where id = $1", [s.org]);
    expect((await ask(s.owner)).code).toBe("ROLE_REFUSED");
    expect(await one("select count(*)::int n from services_case where portal_user_id = any($1)", [[c.poster.id, c.viewer.id, s.owner.id]])).toEqual([{ n: 0 }]);
  });
  it("another company's job, a closed job and a missing job are 404; the sixth open case is refused", async () => {
    const c = await company(), d = await company();
    for (const j of [await job(d.org), await job(c.org, "closed"), "987654321"]) expect((await ask(c.owner, { jobId: j })).code).toBe("JOB_NOT_FOUND");
    for (let i = 0; i < 5; i++) expect((await ask(c.owner)).status).toBe(200);
    expect((await ask(c.owner)).code).toBe("CASE_LIMIT");
    expect((await ask(c.recruiter)).status).toBe(200); // the cap is per requester
  });
  it("ten taps with one key at once make one case", async () => {
    const c = await company();
    const key = uid("tap-key-0123456789");
    const all = await Promise.all(Array.from({ length: 10 }, () => ask(c.owner, { idempotencyKey: key })));
    expect(all.map((x) => x.status)).toEqual(Array(10).fill(200));
    expect(new Set(all.map((x) => x.json.case.id)).size).toBe(1);
    expect(all.filter((x) => !x.json.replayed)).toHaveLength(1);
  });
});

describe("tracker (M2) and withdraw (S-Q1 B)", () => {
  it("the requester, the Owner and the Recruiters read the company's cases; a Poster, a Viewer and another company do not", async () => {
    const c = await company(), d = await company();
    const a = (await ask(c.recruiter)).json.case.id, b = (await ask(c.owner)).json.case.id, other = (await ask(d.owner)).json.case.id;
    // a candidate's case naming the company is never the company's (20d:109)
    const cand = await F.cand();
    const k = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text("services_request")]))[0].id;
    const cc = String((await one("insert into services_case(candidate_user_id, consent_record_id, organisation_id) values ($1, $2, $3) returning id", [cand, k, c.org]))[0].id);
    for (const p of [c.owner, c.recruiter]) expect(ids(await call(R.cases, "GET", p))).toEqual([b, a]);
    for (const p of [c.poster, c.viewer]) expect(ids(await call(R.cases, "GET", p))).toEqual([]);
    expect(ids(await call(R.cases, "GET", d.owner))).toEqual([other]);
    for (const p of [c.owner, c.recruiter]) expect((await call(R.one, "GET", p, { params: { id: a } })).json.case.id).toBe(a);
    for (const p of [c.poster, c.viewer, d.owner, d.recruiter]) expect((await call(R.one, "GET", p, { params: { id: a } })).code).toBe("CASE_NOT_FOUND");
    for (const p of [c.owner, c.recruiter, c.poster]) expect((await call(R.one, "GET", p, { params: { id: cc } })).code).toBe("CASE_NOT_FOUND");
    // a Recruiter made Poster loses the company's cases but keeps their own
    await su.query("update membership set role = 'poster' where portal_user_id = $1", [c.recruiter.id]);
    expect(ids(await call(R.cases, "GET", c.recruiter))).toEqual([a]);
    expect((await call(R.one, "GET", c.recruiter, { params: { id: b } })).code).toBe("CASE_NOT_FOUND");
  });
  it("only the requester withdraws: an Owner on a Recruiter's case is NOT_REQUESTER, a Poster and another company 404", async () => {
    const c = await company(), d = await company();
    const a = (await ask(c.recruiter)).json.case.id;
    expect((await call(R.withdraw, "POST", c.owner, { params: { id: a } })).code).toBe("NOT_REQUESTER");
    for (const p of [c.poster, c.viewer, d.owner]) expect((await call(R.withdraw, "POST", p, { params: { id: a } })).code).toBe("CASE_NOT_FOUND");
    expect((await one("select status from services_case where id = $1", [a]))[0].status).toBe("received");
    const w = await call(R.withdraw, "POST", c.recruiter, { params: { id: a } });
    expect([w.status, w.json.case.status]).toEqual([200, "closed"]);
    expect(await one("select kind, status, portal_user_id from case_event where case_id = $1 order by id", [a]))
      .toEqual([{ kind: "received", status: "received", portal_user_id: c.recruiter.id }, { kind: "withdrawn", status: "closed", portal_user_id: c.recruiter.id }]);
    expect((await call(R.withdraw, "POST", c.recruiter, { params: { id: a } })).code).toBe("CASE_NOT_OPEN");
    // the Owner still reads the closed case
    expect((await call(R.one, "GET", c.owner, { params: { id: a } })).json.case).toMatchObject({ status: "closed", decisionOutcome: null });
  });
});

describe("security", () => {
  it("signed out is 401; a candidate case id, a missing id and bad ids are 404; app_portal reads the new columns and only portal rows", async () => {
    const c = await company();
    const a = (await ask(c.owner)).json.case.id;
    expect((await call(R.cases, "GET", {})).code).toBe("NO_SESSION");
    expect((await ask({})).code).toBe("NO_SESSION");
    expect((await call(R.one, "GET", {}, { params: { id: a } })).code).toBe("NO_SESSION");
    expect((await call(R.withdraw, "POST", {}, { params: { id: a } })).code).toBe("NO_SESSION");
    const cand = await F.cand();
    const k = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text("services_request")]))[0].id;
    const cc = String((await one("insert into services_case(candidate_user_id, consent_record_id) values ($1, $2) returning id", [cand, k]))[0].id);
    for (const id of [cc, "987654321", "abc", "-1", "99999999999999999999", "1\u0000", "x".repeat(10_000)]) {
      expect((await call(R.one, "GET", c.owner, { params: { id } })).status).toBe(404);
      expect((await call(R.withdraw, "POST", c.owner, { params: { id } })).status).toBe(404);
    }
    const app = db.pool("app_portal");
    await su.query("update services_case set status = 'decision', decision_outcome = 'granted', documents_needed = '{passport}' where id = $1", [a]);
    expect((await app.query("select decision_outcome, documents_needed from portal_services_case where id = $1", [a])).rows).toEqual([{ decision_outcome: "granted", documents_needed: ["passport"] }]);
    expect((await app.query("select count(*)::int n from portal_services_case where candidate_user_id is not null")).rows[0].n).toBe(0);
    await expect(app.query("update portal_services_case set status = 'closed'")).rejects.toMatchObject({ code: "42501" });
    expect((await call(R.withdraw, "POST", c.owner, { params: { id: a } })).code).toBe("CASE_NOT_OPEN"); // a decided case
  });
  it("hostile bodies are 400 or 413 and write nothing; a wrong Origin is 403", async () => {
    const c = await company();
    const base = { permitType: "general", offerDetails: { notes: "ok" }, servicesConsent: true, idempotencyKey: "a-good-key-0123456789" };
    const bad: unknown[] = [
      { ...base, employerContact: true }, { ...base, employerContact: false }, { ...base, idempotencyKey: undefined }, { ...base, idempotencyKey: "short" },
      { ...base, idempotencyKey: "k".repeat(65) }, { ...base, idempotencyKey: "bad key with spaces 0123" }, { ...base, idempotencyKey: 12345678901234567 },
      { ...base, offerDetails: { unknown: "x" } }, { ...base, offerDetails: { notes: "x".repeat(501) } }, { ...base, offerDetails: { notes: "a\u0007b" } },
      { ...base, offerDetails: { notes: { a: 1 } } }, { ...base, jobId: "1; drop table job" }, { ...base, servicesConsent: undefined }, { ...base, permitType: null },
    ];
    for (const b of bad) expect((await call(R.cases, "POST", c.owner, { body: b })).code, JSON.stringify(b).slice(0, 80)).toBe("BAD_REQUEST");
    expect((await call(R.cases, "POST", c.owner, { raw: JSON.stringify({ ...base, pad: "y".repeat(10_000) }) })).code).toBe("BODY_TOO_LARGE");
    expect((await call(R.cases, "POST", c.owner, { body: base, origin: "http://localhost:3000" })).code).toBe("BAD_ORIGIN");
    expect(await one("select count(*)::int n from services_case where organisation_id = $1", [c.org])).toEqual([{ n: 0 }]);
    for (const p of [c.owner, c.recruiter]) {
      const all = [await call(R.cases, "GET", p), await ask(p)];
      for (const r of all) expect(r.text).not.toMatch(/consent|assigned|staff|dedupe|portalUserId|candidate/i);
    }
  });
});

describe("the replies match docs/openapi/portal.yaml (decision #248)", () => {
  it("request, replay, list, one and withdraw, and their refusals", async () => {
    const spec = loadSpec("portal"), P = "/api/portal/cases";
    const c = await company();
    const key = uid("doc-key-0123456789");
    const checks: [string, string, { status: number; json: unknown }][] = [];
    const r = await ask(c.recruiter, { idempotencyKey: key });
    checks.push(["POST", P, r], ["POST", P, await ask(c.recruiter, { idempotencyKey: key })], ["POST", P, await ask(c.poster)], ["POST", P, await ask(c.owner, { jobId: "987654321" })]);
    checks.push(["GET", P, await call(R.cases, "GET", c.owner)], ["GET", `${P}/{id}`, await call(R.one, "GET", c.owner, { params: { id: r.json.case.id } })]);
    checks.push(["POST", `${P}/{id}/withdraw`, await call(R.withdraw, "POST", c.owner, { params: { id: r.json.case.id } })], ["POST", `${P}/{id}/withdraw`, await call(R.withdraw, "POST", c.recruiter, { params: { id: r.json.case.id } })]);
    expect(checks.map((x) => x[2].status)).toEqual([200, 200, 403, 404, 200, 200, 403, 200]);
    for (const [m, path, x] of checks) expect(replyProblems(spec, m, path, x.status, x.json), `${m} ${path} ${x.status}`).toEqual([]);
  });
});

describe("performance", () => {
  it("the request, the requester's list of 50, the Owner's list of a company with 500 cases, and a withdrawal stay within their budgets", async () => {
    const c = await company();
    const [first, sReq] = await counted(() => ask(c.recruiter));
    expect(first.status).toBe(200);
    expect(sReq).toBeLessThanOrEqual(BUDGET.request.statements);
    expect(await timed(async () => {
      const r = await ask(c.owner);
      await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'withdrawn' where id = $1", [r.json.case.id]);
    })).toBeLessThanOrEqual(BUDGET.request.medianMs);
    // the recruiter's 50, then 450 more from 9 teammates, then 2,000 at other companies, each with 5 events
    const text = await F.text("services_request");
    const bulk = async (users: string[], org: string | null, each: number) => su.query(
      `with k as (insert into consent_record(portal_user_id, consent_text_id) select u, $2 from unnest($1::text[]) u, generate_series(1, $4::int) returning id, portal_user_id)
       insert into services_case(portal_user_id, consent_record_id, organisation_id, dedupe_key) select portal_user_id, id, $3::bigint, gen_random_uuid()::text from k`, [users, text, org, each]);
    await bulk([c.recruiter.id], c.org, 49);
    const mates: string[] = [];
    for (let i = 0; i < 9; i++) mates.push((await login(c.org, "recruiter")).id);
    await bulk(mates, c.org, 50);
    const others = await company();
    await bulk([others.owner.id], others.org, 2000);
    await su.query("insert into case_event(case_id, kind, status) select c.id, 'status_changed', 'received' from services_case c, generate_series(1, 5) where c.portal_user_id is not null");
    await su.query("analyze services_case; analyze case_event; analyze case_document");
    expect((await one("select count(*)::int n from services_case where organisation_id = $1", [c.org]))[0].n).toBeGreaterThanOrEqual(500);
    const app = await db.pool("app_portal").connect();
    const pages = async (args: unknown[]) => {
      const plan = (await app.query(`explain (analyze, buffers, format json) ${TRACKER_SQL.portal.list}`, args)).rows[0]["QUERY PLAN"][0].Plan;
      return plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
    };
    try {
      const own = await pages([c.recruiter.id, "9223372036854775807", null]), owner = await pages([c.owner.id, "9223372036854775807", c.org]);
      console.info(`list pages: requester of 50 ${own}, Owner of 500 ${owner}`);
      expect(own).toBeLessThanOrEqual(BUDGET.list.pages);
      expect(owner).toBeLessThanOrEqual(BUDGET.list.pages);
    } finally { app.release(); }
    for (const p of [c.recruiter, c.owner]) {
      const [l, s] = await counted(() => call(R.cases, "GET", p));
      expect([l.json.cases.length, l.json.next !== null]).toEqual([20, true]);
      expect(s).toBeLessThanOrEqual(BUDGET.list.statements);
      expect(await timed(() => call(R.cases, "GET", p))).toBeLessThanOrEqual(BUDGET.list.medianMs);
    }
    const id = first.json.case.id;
    const [w, sW] = await counted(() => call(R.withdraw, "POST", c.recruiter, { params: { id } }));
    expect([w.status, sW <= BUDGET.withdraw.statements]).toEqual([200, true]);
    const fresh: string[] = [];
    const extra = await company();
    for (let i = 0; i < 9; i++) fresh.push((await ask(i < 5 ? extra.owner : extra.recruiter)).json.case.id);
    let i = 0;
    expect(await timed(() => call(R.withdraw, "POST", i < 5 ? extra.owner : extra.recruiter, { params: { id: fresh[i++]! } }))).toBeLessThanOrEqual(BUDGET.withdraw.medianMs);
  });
});
