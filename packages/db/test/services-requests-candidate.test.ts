// Step 15 SV-A: the candidate's permit services routes (M1 request, M2 tracker, withdraw) end to end on the test database, through the real auth
// route and the real route handlers of apps/candidate (connected as app_candidate). The consent texts come from the real seed command. Fake people only.
// A statement count includes the 2 session statements and the rate-limit statement of a write.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { saveServicesTexts, SERVICES_TEXT_VERSION } from "../src/services-texts-cli";
import { TRACKER_SQL } from "../src/services-request";
import { loadSpec, replyProblems } from "./openapi";

// list pages: the page of 21 rows on the index, then per row the reader wrapper (about 27 buffer hits of function planning), the timeline for the
// last change (about 38) and the copy count; measured 1,518 for 50 own cases among 2,000 others. It does not grow with the number of cases (the
// portal file measures 500). ponytail: a plpgsql last-change wrapper would cut it; add one if the tracker page is slow.
const BUDGET = { request: { statements: 13, medianMs: 60 }, list: { statements: 3, medianMs: 40, pages: 2000 }, one: { statements: 3, medianMs: 30 }, withdraw: { statements: 5, medianMs: 40 } };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request, ctx: never) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST", Handler>>;
let db: TestDb, su: pg.Pool;
let AUTH: (r: Request) => Promise<Response>;
const R = {} as Record<"cases" | "one" | "withdraw", Route>;
let F: { text(p?: string): Promise<string>; org(o?: object): Promise<string>; portal(): Promise<string>; cand(): Promise<string>; staff(): Promise<string> };
const answered: string[] = [];
let src: string, employerJob: string, agencyJob: string, closedJob: string, hiddenJob: string, employerOrg: string, agencyOrg: string;

const job = async (org: string, status = "live", closes = "now() + interval '20 days'") => String((await su.query(
  `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,salary_high,pay_grade,hidden_reason)
   values ($1,'admin_manual',$2,'Fake Developer','Fake Org','it','critical_skills',$3,${closes},'https://example.test/a',to_tsvector('english','developer'),50000,60000,'g1',
     case when $3 = 'hidden' then 'admin' end) returning id`, [org, src, status])).rows[0].id);

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret,
    PORTAL_AUTH_URL: "http://localhost:3001", PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  R.cases = await import("../../../apps/candidate/app/api/candidate/cases/route");
  R.one = await import("../../../apps/candidate/app/api/candidate/cases/[id]/route");
  R.withdraw = await import("../../../apps/candidate/app/api/candidate/cases/[id]/withdraw/route");
  employerOrg = await F.org();
  agencyOrg = await F.org({ kind: "agency" });
  src = (await su.query("insert into job_source(kind,board) values ('portal','sv-a') returning id")).rows[0].id;
  employerJob = await job(employerOrg);
  agencyJob = await job(agencyOrg);
  closedJob = await job(employerOrg, "closed");
  hiddenJob = await job(employerOrg, "hidden");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
async function login() {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  return { cookie, id };
}
type Opts = { origin?: string | null; body?: unknown; raw?: string; params?: Record<string, string>; query?: string };
async function call(route: Route, method: keyof Route, p: { cookie?: string }, o: Opts = {}) {
  const headers: Record<string, string> = p.cookie ? { cookie: p.cookie } : {};
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  const body = method === "GET" ? undefined : (o.raw ?? (o.body === undefined ? "" : JSON.stringify(o.body)));
  const res = await route[method]!(new Request(`${BASE}/api/candidate/cases${o.query ?? ""}`, { method, headers, body }), { params: Promise.resolve(o.params ?? {}) } as never);
  const text = await res.text();
  answered.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : null, code: text ? (JSON.parse(text).code as string | undefined) : undefined };
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
// the services consent records of one login (sign-up writes its own terms record)
const services = async (user: string) => (await one(`select count(*)::int n from consent_record r join consent_text t on t.id = r.consent_text_id
  where r.candidate_user_id = $1 and t.purpose in ('services_request','employer_contact')`, [user]))[0].n as number;
const offer = { occupationCode: "2136", annualPay: "50000", relevantDegree: "true", title: "Fake Developer", notes: "Start in March." };
const ask = (p: { cookie?: string }, body: Record<string, unknown> = {}) => call(R.cases, "POST", p, { body: { permitType: "critical_skills", offerDetails: offer, servicesConsent: true, ...body } });
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; console.info(`measured ${c} statements`); }
}
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function timed(fn: () => Promise<unknown>) {
  const ms: number[] = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  const m = median(ms);
  console.info(`measured median ${m.toFixed(1)} ms`);
  return m;
}
// candidate cases made straight in the table (fixtures for the reads; the request route has its own tests)
async function caseFor(user: string, o: { status?: string; outcome?: string; job?: string } = {}) {
  const k = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [user, await F.text("services_request")]))[0].id;
  const status = o.status ?? "received";
  const closed = status === "closed" ? ", closed_at, close_reason" : "", vals = status === "closed" ? ", now(), 'withdrawn'" : "";
  return String((await one(`insert into services_case(candidate_user_id, consent_record_id, status, decision_outcome, job_id${closed}) values ($1, $2, $3, $4, $5${vals}) returning id`,
    [user, k, status, o.outcome ?? null, o.job ?? (status === "closed" ? null : await job(employerOrg))]))[0].id); // one open case per job (0001 index)
}

describe("the consent texts (S-Q5 A)", () => {
  it("before the seed a request is 503; the seed saves both placeholder texts once", async () => {
    const p = await login();
    expect((await ask(p)).code).toBe("SERVICES_UNAVAILABLE");
    expect(await services(p.id)).toBe(0); // rolled back
    const c = await db.pool("app_admin").connect();
    try {
      expect(await saveServicesTexts(c)).toEqual(["services_request", "employer_contact"]);
      expect(await saveServicesTexts(c)).toEqual([]);
    } finally { c.release(); }
    const rows = await one("select purpose, version, body from consent_text where purpose in ('services_request','employer_contact') order by purpose");
    expect(rows.map((r) => [r.purpose, r.version])).toEqual([["employer_contact", SERVICES_TEXT_VERSION], ["services_request", SERVICES_TEXT_VERSION]]);
    for (const r of rows) expect(r.body).toMatch(/^PLACEHOLDER TEXT/);
  });
});

describe("request (M1)", () => {
  it("on an employer's job with the HR-contact tick: two consent records, the case, the received event and the free check, in one go", async () => {
    const p = await login();
    const r = await ask(p, { jobId: employerJob, employerContact: true });
    expect(r.status).toBe(200);
    expect(r.json.replayed).toBe(false);
    expect(r.json.freeCheck).toMatchObject({ qualifies: true, reason: "listed_degree" });
    expect(r.json.case).toMatchObject({ status: "received", decisionOutcome: null, permitType: "critical_skills", jobId: employerJob, jobTitle: "Fake Developer", documentCount: 0 });
    expect(r.json.case.createdAt).toMatch(/Z$/);
    const c = (await one("select * from services_case where id = $1", [r.json.case.id]))[0];
    expect(c).toMatchObject({ candidate_user_id: p.id, portal_user_id: null, organisation_id: employerOrg, job_id: employerJob, payer: "employer", status: "received", dedupe_key: null, documents_needed: [] });
    expect(c.offer_details).toEqual({ details: offer, freeCheck: r.json.freeCheck });
    const k = await one(`select r.id, t.purpose, r.job_id, r.organisation_id from consent_record r join consent_text t on t.id = r.consent_text_id where r.candidate_user_id = $1 and t.purpose <> 'signup_terms' order by r.id`, [p.id]);
    expect(k.map((x) => [x.purpose, x.job_id, x.organisation_id])).toEqual([["services_request", employerJob, employerOrg], ["employer_contact", employerJob, employerOrg]]);
    expect([c.consent_record_id, c.employer_contact_consent_record_id]).toEqual([k[0].id, k[1].id]);
    expect(await one("select kind, status, candidate_user_id, staff_user_id, detail from case_event where case_id = $1", [c.id]))
      .toEqual([{ kind: "received", status: "received", candidate_user_id: p.id, staff_user_id: null, detail: {} }]);
  });
  it("without the tick there is no employer-contact record; an agency job is paid by the agency; no job: no company, no payer, and no free check without code, pay and degree", async () => {
    const p = await login();
    const a = await ask(p, { jobId: agencyJob });
    expect((await one("select payer, organisation_id, employer_contact_consent_record_id from services_case where id = $1", [a.json.case.id]))[0])
      .toEqual({ payer: "agency", organisation_id: agencyOrg, employer_contact_consent_record_id: null });
    const b = await ask(p, { offerDetails: { employerName: "Fake Employer Limited" } });
    expect(b.status).toBe(200);
    expect(b.json.freeCheck).toBeNull();
    expect((await one("select payer, organisation_id, job_id, offer_details from services_case where id = $1", [b.json.case.id]))[0])
      .toEqual({ payer: null, organisation_id: null, job_id: null, offer_details: { details: { employerName: "Fake Employer Limited" }, freeCheck: null } });
  });
  it("refusals: a second open case on the job, the sixth open case, a closed, hidden or missing job, an unverified login", async () => {
    const p = await login();
    expect((await ask(p, { jobId: employerJob })).status).toBe(200);
    expect((await ask(p, { jobId: employerJob })).code).toBe("CASE_ALREADY_OPEN");
    for (const j of [closedJob, hiddenJob, "987654321"]) expect((await ask(p, { jobId: j })).code).toBe("JOB_NOT_FOUND");
    for (let i = 0; i < 4; i++) expect((await ask(p, { jobId: await job(employerOrg) })).status).toBe(200);
    expect((await ask(p)).code).toBe("CASE_LIMIT");
    expect((await ask(p, { jobId: await job(agencyOrg) })).code).toBe("CASE_LIMIT");
    // a closed case frees a place; a withdrawn job case may be asked again
    const first = (await one("select id from services_case where candidate_user_id = $1 and job_id = $2", [p.id, employerJob]))[0].id;
    expect((await call(R.withdraw, "POST", p, { params: { id: String(first) } })).status).toBe(200);
    expect((await ask(p, { jobId: employerJob })).status).toBe(200);
    const u = await login();
    await su.query("update candidate_user set email_verified = false where id = $1", [u.id]);
    expect((await ask(u)).code).toBe("NOT_VERIFIED");
    expect(await services(u.id)).toBe(0);
  });
  it("two requests at once on the same job make one case", async () => {
    const p = await login();
    const both = await Promise.all([ask(p, { jobId: agencyJob }), ask(p, { jobId: agencyJob })]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await one("select count(*)::int n from services_case where candidate_user_id = $1", [p.id])).toEqual([{ n: 1 }]);
  });
  it("at 4 open cases, six requests at once on six live jobs: exactly one passes, five are CASE_LIMIT (the lock per login holds the cap)", async () => {
    const p = await login();
    for (let i = 0; i < 4; i++) expect((await ask(p, { jobId: await job(employerOrg) })).status).toBe(200);
    const jobs = await Promise.all(Array.from({ length: 6 }, () => job(employerOrg)));
    const all = await Promise.all(jobs.map((j) => ask(p, { jobId: j })));
    expect(all.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(all.filter((x) => x.status === 409).map((x) => x.code)).toEqual(Array(5).fill("CASE_LIMIT"));
    expect(await one("select count(*)::int n from services_case where candidate_user_id = $1 and status <> 'closed'", [p.id])).toEqual([{ n: 5 }]);
  });
  it("the requester's own events notify only through 0063's trigger: received and withdrawn each give one in-app notice and no email", async () => {
    const p = await login();
    const id = (await ask(p, { jobId: await job(employerOrg) })).json.case.id as string;
    const notes = () => one("select n.params->>'kind' kind from notification n where n.candidate_user_id = $1 order by n.id", [p.id]);
    const mails = () => one("select template from email_outbox where candidate_user_id = $1", [p.id]);
    expect(await notes()).toEqual([{ kind: "received" }]);
    expect(await mails()).toEqual([]);
    expect((await call(R.withdraw, "POST", p, { params: { id } })).status).toBe(200);
    expect(await notes()).toEqual([{ kind: "received" }, { kind: "withdrawn" }]);
    expect(await mails()).toEqual([]);
  });
});

describe("tracker (M2) and withdraw", () => {
  it("lists newest first with paging, reads one, and the new columns read through the view (0062)", async () => {
    const p = await login();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push(await caseFor(p.id));
    await su.query("update services_case set status = 'decision', decision_outcome = 'granted', decided_at = now() where id = $1", [ids[0]]);
    await su.query(`insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id, copy_deleted_at)
      values ($1, 'case/fake-a', 'a.pdf', 'pdf', 10, $2, null), ($1, null, 'b.pdf', 'pdf', 10, $2, now())`, [ids[1], p.id]); // a deleted copy is not counted
    const a = await call(R.cases, "GET", p);
    expect(a.json.cases.map((c: { id: string }) => c.id)).toEqual(ids.slice(3).reverse());
    const b = await call(R.cases, "GET", p, { query: `?after=${a.json.next}` });
    expect([b.json.cases.map((c: { id: string }) => c.id), b.json.next]).toEqual([ids.slice(0, 3).reverse(), null]);
    expect(b.json.cases.at(-1)).toMatchObject({ status: "decision", decisionOutcome: "granted" });
    expect(b.json.cases.at(-2).documentCount).toBe(1);
    const o = await call(R.one, "GET", p, { params: { id: ids[0]! } });
    expect(Object.keys(o.json.case).sort()).toEqual(["createdAt", "decisionOutcome", "documentCount", "documentsNeeded", "employerName", "id", "jobId", "jobTitle", "lastChangeAt", "payer", "permitType", "status"]); // B32 added employerName, payer, documentsNeeded
    // the view itself: app_candidate reads the 0061 columns
    expect((await db.pool("app_candidate").query("select decision_outcome, documents_needed, referral_solicitor_id from candidate_services_case where id = $1", [ids[0]])).rows)
      .toEqual([{ decision_outcome: "granted", documents_needed: [], referral_solicitor_id: null }]);
  });
  it("the last change is the newest event", async () => {
    const p = await login();
    const r = await ask(p);
    await su.query("insert into case_event(case_id, at, kind, status) values ($1, now() + interval '1 hour', 'status_changed', 'documents_needed')", [r.json.case.id]);
    const o = await call(R.one, "GET", p, { params: { id: r.json.case.id } });
    expect(Date.parse(o.json.case.lastChangeAt) - Date.parse(o.json.case.createdAt)).toBeGreaterThan(3_000_000);
  });
  it("withdraw closes an open case as withdrawn with its event; a closed or decided case is refused", async () => {
    const p = await login();
    const r = await ask(p);
    const w = await call(R.withdraw, "POST", p, { params: { id: r.json.case.id } });
    expect([w.status, w.json.case.status]).toEqual([200, "closed"]);
    expect((await one("select status, close_reason, closed_at is not null c from services_case where id = $1", [r.json.case.id]))[0]).toEqual({ status: "closed", close_reason: "withdrawn", c: true });
    expect((await one("select kind, status, candidate_user_id from case_event where case_id = $1 order by id", [r.json.case.id])).map((e) => e.kind)).toEqual(["received", "withdrawn"]);
    expect((await call(R.withdraw, "POST", p, { params: { id: r.json.case.id } })).code).toBe("CASE_NOT_OPEN");
    const d = await caseFor(p.id, { status: "decision", outcome: "refused" });
    expect((await call(R.withdraw, "POST", p, { params: { id: d } })).code).toBe("CASE_NOT_OPEN");
    expect((await one("select status from services_case where id = $1", [d]))[0].status).toBe("decision");
  });
});

describe("security", () => {
  it("signed out is 401 on every route; a second candidate sees nothing of the first", async () => {
    const a = await login(), b = await login();
    const c = await caseFor(a.id);
    expect((await call(R.cases, "GET", {})).code).toBe("NO_SESSION");
    expect((await ask({})).code).toBe("NO_SESSION");
    expect((await call(R.one, "GET", {}, { params: { id: c } })).code).toBe("NO_SESSION");
    expect((await call(R.withdraw, "POST", {}, { params: { id: c } })).code).toBe("NO_SESSION");
    expect((await call(R.cases, "GET", b)).json.cases).toEqual([]);
    expect((await call(R.one, "GET", b, { params: { id: c } })).code).toBe("CASE_NOT_FOUND");
    expect((await call(R.withdraw, "POST", b, { params: { id: c } })).code).toBe("CASE_NOT_FOUND");
    expect((await one("select status from services_case where id = $1", [c]))[0].status).toBe("received");
  });
  it("a portal case, a missing case and a bad id are all 404 (never 403)", async () => {
    const p = await login(), pu = await F.portal();
    const k = (await one("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [pu, await F.text("services_request")]))[0].id;
    const pc = String((await one("insert into services_case(portal_user_id, consent_record_id, dedupe_key) values ($1, $2, $3) returning id", [pu, k, uid("dk")]))[0].id);
    for (const id of [pc, "987654321", "abc", "-1", "1.5", "99999999999999999999", "1\u0000", "x".repeat(10_000)]) {
      expect((await call(R.one, "GET", p, { params: { id } })).status, id.slice(0, 20)).toBe(404);
      expect((await call(R.withdraw, "POST", p, { params: { id } })).status, id.slice(0, 20)).toBe(404);
    }
  });
  it("hostile bodies are 400 or 413 before anything is written; a wrong Origin is 403", async () => {
    const p = await login();
    const base = { permitType: "critical_skills", offerDetails: { notes: "ok" }, servicesConsent: true };
    const bad: unknown[] = [
      { ...base, extra: 1 }, { ...base, servicesConsent: false }, { ...base, servicesConsent: "true" }, { permitType: "critical_skills", offerDetails: {} },
      { ...base, permitType: "stamp4" }, { ...base, permitType: ["critical_skills"] }, { ...base, offerDetails: { salary: "1" } },
      { ...base, offerDetails: { notes: "x".repeat(501) } }, { ...base, offerDetails: { notes: "" } }, { ...base, offerDetails: { notes: "   " } },
      { ...base, offerDetails: { notes: "a\u0000b" } }, { ...base, offerDetails: { notes: "a\nb" } }, { ...base, offerDetails: { notes: "a‮b" } },
      { ...base, offerDetails: { notes: { nested: "x" } } }, { ...base, offerDetails: { notes: ["x"] } }, { ...base, offerDetails: { notes: 5 } }, { ...base, offerDetails: "notes" },
      { ...base, offerDetails: null }, { ...base, jobId: 1 }, { ...base, jobId: "abc" }, { ...base, jobId: "-1" }, { ...base, jobId: "99999999999999999999" },
      { ...base, employerContact: true }, { ...base, jobId: employerJob, employerContact: "yes" }, { ...base, idempotencyKey: "a".repeat(20) },
      { ...base, offerDetails: { occupationCode: "21x6", annualPay: "1", relevantDegree: "true" } }, { ...base, offerDetails: { occupationCode: "2136", annualPay: "lots", relevantDegree: "true" } },
      [base], "x", null, 5,
    ];
    for (const b of bad) expect((await call(R.cases, "POST", p, { body: b })).code, JSON.stringify(b).slice(0, 80)).toBe("BAD_REQUEST");
    expect((await call(R.cases, "POST", p, { raw: "{not json" })).code).toBe("BAD_REQUEST");
    expect((await call(R.cases, "POST", p, { raw: JSON.stringify({ ...base, offerDetails: { notes: "x".repeat(500) }, pad: "y".repeat(10_000) }) })).code).toBe("BODY_TOO_LARGE");
    expect((await call(R.cases, "POST", p, { body: base, origin: "https://evil.example" })).code).toBe("BAD_ORIGIN");
    expect((await call(R.cases, "POST", p, { body: base, origin: null })).code).toBe("BAD_ORIGIN");
    expect((await call(R.withdraw, "POST", p, { params: { id: "1" }, origin: null })).code).toBe("BAD_ORIGIN");
    for (const q of ["?after=abc", "?after=" + Buffer.from(JSON.stringify({ l: "cases", i: "5" })).toString("base64url"), "?page=2", "?after=a&after=b"])
      expect((await call(R.cases, "GET", p, { query: q })).code, q).toBe("BAD_REQUEST");
    expect(await one("select count(*)::int n from services_case where candidate_user_id = $1", [p.id])).toEqual([{ n: 0 }]);
  });
  it("app_candidate: the view shows only candidate cases and writes none for the portal; no update; the withdraw function is its own", async () => {
    const app = db.pool("app_candidate");
    expect((await app.query("select count(*)::int n from candidate_services_case where portal_user_id is not null")).rows[0].n).toBe(0);
    await expect(app.query("update candidate_services_case set status = 'closed'")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("insert into candidate_services_case(portal_user_id, consent_record_id) values ('x', 1)")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("select private.portal_case_withdraw('x', 1)")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool("app_portal").query("select private.candidate_case_withdraw('x', 1)")).rejects.toMatchObject({ code: "42501" });
    const v = await one("select relname, reloptions from pg_class where relname in ('candidate_services_case','portal_services_case') order by relname");
    for (const r of v) expect(r.reloptions).toEqual(expect.arrayContaining(["security_barrier=true", "check_option=cascaded"]));
    const f = await one("select proname, prosecdef, proconfig from pg_proc where proname in ('candidate_case_withdraw','portal_case_withdraw') order by proname");
    expect(f).toEqual([{ proname: "candidate_case_withdraw", prosecdef: true, proconfig: ["search_path=public, pg_temp"] }, { proname: "portal_case_withdraw", prosecdef: true, proconfig: ["search_path=public, pg_temp"] }]);
  });
  it("no reply carries a note, a staff id, a consent id or the offer's free text outside the request reply", async () => {
    const p = await login(), staff = await F.staff();
    const r = await ask(p);
    await su.query("update services_case set assigned_staff_user_id = $2 where id = $1", [r.json.case.id, staff]);
    await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1, $2, 'secret staff note')", [r.json.case.id, staff]);
    const texts = [JSON.stringify((await call(R.cases, "GET", p)).json), JSON.stringify((await call(R.one, "GET", p, { params: { id: r.json.case.id } })).json)];
    for (const t of [...texts, ...answered]) { expect(t).not.toContain(staff); expect(t).not.toContain("secret staff note"); expect(t).not.toMatch(/consent|assigned|staff/i); }
    for (const t of texts) expect(t).not.toContain("Start in March.");
  });
});

describe("the replies match docs/openapi/candidate.yaml (decision #248)", () => {
  it("request, list, one and withdraw, and their refusals", async () => {
    const spec = loadSpec("candidate"), P = "/api/candidate/cases";
    const p = await login();
    const j = await job(employerOrg);
    const checks: [string, string, { status: number; json: unknown }][] = [];
    const r = await ask(p, { jobId: j, employerContact: true });
    checks.push(["POST", P, r], ["POST", P, await ask(p, { jobId: j })], ["POST", P, await ask(p, { jobId: "987654321" })], ["POST", P, await call(R.cases, "POST", p, { body: {} })]);
    checks.push(["POST", P, await call(R.cases, "POST", p, { raw: "x".repeat(3000) })], ["POST", P, await ask({})]);
    checks.push(["GET", P, await call(R.cases, "GET", p)], ["GET", P, await call(R.cases, "GET", p, { query: "?x=1" })]);
    checks.push(["GET", `${P}/{id}`, await call(R.one, "GET", p, { params: { id: r.json.case.id } })], ["GET", `${P}/{id}`, await call(R.one, "GET", p, { params: { id: "abc" } })]);
    checks.push(["POST", `${P}/{id}/withdraw`, await call(R.withdraw, "POST", p, { params: { id: r.json.case.id } })], ["POST", `${P}/{id}/withdraw`, await call(R.withdraw, "POST", p, { params: { id: r.json.case.id } })]);
    expect(checks.map((c) => c[2].status)).toEqual([200, 409, 404, 400, 413, 401, 200, 400, 200, 404, 200, 409]);
    for (const [m, path, x] of checks) expect(replyProblems(spec, m, path, x.status, x.json), `${m} ${path} ${x.status}`).toEqual([]);
  });
});

describe("performance", () => {
  it("the request, the list of 50 cases, one case and a withdrawal stay within their budgets", async () => {
    const p = await login();
    const fj = await job(employerOrg);
    const [first, sReq] = await counted(() => ask(p, { jobId: fj }));
    expect(first.status).toBe(200);
    expect(sReq).toBeLessThanOrEqual(BUDGET.request.statements);
    const reqMs = await timed(async () => { const r = await ask(p); await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'withdrawn' where id = $1", [r.json.case.id]); });
    expect(reqMs).toBeLessThanOrEqual(BUDGET.request.medianMs);
    for (let i = 0; i < 40; i++) await caseFor(p.id, { status: "closed" });
    await su.query("insert into case_event(case_id, kind, status) select c.id, 'status_changed', 'received' from services_case c, generate_series(1, 5) where c.candidate_user_id = $1", [p.id]);
    expect((await one("select count(*)::int n from services_case where candidate_user_id = $1", [p.id]))[0].n).toBeGreaterThanOrEqual(50);
    // 2,000 other candidates' cases, so the index matters
    const others: string[] = [];
    for (let i = 0; i < 20; i++) others.push(await F.cand());
    const text = await F.text("services_request");
    await su.query(`with k as (insert into consent_record(candidate_user_id, consent_text_id) select u, $2 from unnest($1::text[]) u, generate_series(1, 100) returning id, candidate_user_id)
      insert into services_case(candidate_user_id, consent_record_id, status, closed_at, close_reason) select candidate_user_id, id, 'closed', now(), 'withdrawn' from k`, [others, text]);
    await su.query("analyze services_case; analyze case_event; analyze case_document");
    const [, sList] = await counted(() => call(R.cases, "GET", p));
    expect(sList).toBeLessThanOrEqual(BUDGET.list.statements);
    expect(await timed(() => call(R.cases, "GET", p))).toBeLessThanOrEqual(BUDGET.list.medianMs);
    const app = await db.pool("app_candidate").connect();
    try {
      const plan = (await app.query(`explain (analyze, buffers, format json) ${TRACKER_SQL.candidate.list}`, [p.id, "9223372036854775807"])).rows[0]["QUERY PLAN"][0];
      const pages = plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
      console.info(`list pages ${pages}`);
      expect(pages).toBeLessThanOrEqual(BUDGET.list.pages);
    } finally { app.release(); }
    const id = first.json.case.id;
    const [, sOne] = await counted(() => call(R.one, "GET", p, { params: { id } }));
    expect(sOne).toBeLessThanOrEqual(BUDGET.one.statements);
    expect(await timed(() => call(R.one, "GET", p, { params: { id } }))).toBeLessThanOrEqual(BUDGET.one.medianMs);
    const [w, sW] = await counted(() => call(R.withdraw, "POST", p, { params: { id } }));
    expect([w.status, sW <= BUDGET.withdraw.statements]).toEqual([200, true]);
    const fresh = await Promise.all(Array.from({ length: 9 }, () => caseFor(p.id)));
    let i = 0;
    expect(await timed(() => call(R.withdraw, "POST", p, { params: { id: fresh[i++]! } }))).toBeLessThanOrEqual(BUDGET.withdraw.medianMs);
  });
});
