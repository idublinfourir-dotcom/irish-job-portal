// Integration: B51, the posting form's reads, on the real test database through the real auth route and the real route handlers of apps/portal (as app_portal): the
// sponsorship statement wording, the occupation list, the #66 range note with the graduate minimum from rules data, and the company flags (publicPayTier, permitHistory)
// on GET /api/portal/company. Every role is tried, then hostile input. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, makeAuth, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { occupationPicker } from "../src/page-reads";
import { getRules } from "../src/rules-data";

// Statements counted on every pg.Client.query call, measured 25 Nov 2026: the form read (4) = the session reads, the statement text, the rules (cached after the first call) and
// nothing per occupation; the company read gained no statement (the rules come from the same cache). Medians 3.5 and 2.9 ms; the time limits are about 8 times that.
const BUDGET = { form: { statements: 4, medianMs: 30 }, company: { statements: 5, medianMs: 30 } };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, FORM: Handler, COMPANY: Handler;
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };
let candidateCookie: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: FORM } = await import("../../../apps/portal/app/api/portal/jobs/form/route"));
  ({ GET: COMPANY } = await import("../../../apps/portal/app/api/portal/company/route"));
  const cand = makeAuth("candidate", db.pool("app_candidate"));
  const h = { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": "198.51.100.250" };
  const body = { email: "fake.candidate.b51@example.test", password: "Fake-password-12345", name: "Fake" };
  expect((await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-up/email", { method: "POST", headers: h, body: JSON.stringify({ ...body, ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [body.email]);
  const r = await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-in/email", { method: "POST", headers: h, body: JSON.stringify({ email: body.email, password: body.password }) }));
  candidateCookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(candidateCookie).toContain("candidate.session_token");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit"); });

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
async function login() {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from portal_user where email = $1", [email])).rows[0].id as string };
}
async function company(o: { name?: string; kind?: string; roles?: string[] } = {}) {
  const org = String(await F.org({ name: o.name ?? `Fake Widgets ${uid("")} Limited`, kind: o.kind, status: "verified" }));
  const m: Record<string, { cookie: string }> = {};
  for (const role of o.roles ?? ["account_owner", "recruiter", "poster", "viewer"]) { const u = await login(); await F.member(org, u.id, { role, signer: role === "account_owner" }); m[role] = u; }
  return { org, m };
}
async function get(handler: Handler, path: string, cookie?: string) {
  const res = await handler(new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} }));
  return { status: res.status, json: await res.json(), type: res.headers.get("content-type") };
}
const form = (cookie?: string, q = "") => get(FORM, `/api/portal/jobs/form${q}`, cookie);
const comp = (cookie?: string) => get(COMPANY, "/api/portal/company", cookie);
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => { const ms: number[] = []; for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); } return ms.sort((a, b) => a - b)[4]!; };

describe("B51: the form read", () => {
  it("every member role gets the same read; with no statement published yet the statement is null", async () => {
    const c = await company();
    for (const [role, who] of Object.entries(c.m)) {
      const r = await form(who.cookie);
      expect([role, r.status, r.json.statement]).toEqual([role, 200, null]);
    }
    expect((await form((await login()).cookie)).status).toBe(200); // a login with no company yet reads it too, like the grades
  });

  it("the statement is the newest published wording of purpose sponsorship_statement, with its version and time", async () => {
    const c = await company();
    await su.query("insert into consent_text(purpose, version, body, published_at) values ('sponsorship_statement', 'v1', 'First wording.', now() - interval '2 days'), ('application', 'v9', 'Not this one.', now())");
    expect((await form(c.m.account_owner!.cookie)).json.statement).toMatchObject({ version: "v1", body: "First wording." });
    await su.query("insert into consent_text(purpose, version, body, published_at) values ('sponsorship_statement', 'v2', 'Newer wording.', now() - interval '1 day')");
    const r = await form(c.m.account_owner!.cookie);
    expect(r.json.statement).toEqual({ version: "v2", body: "Newer wording.", publishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) });
  });

  it("the occupations are the candidate site's picker list (same codes, titles, slugs and list status); the graduate minimum and the #66 note come from the rules in force", async () => {
    const c = await company();
    const r = await form(c.m.account_owner!.cookie);
    const rules = await getRules(db.pool("app_portal"));
    expect(r.json.occupations).toEqual((await occupationPicker(db.pool("app_portal"))).occupations);
    expect(r.json.occupations.length).toBeGreaterThan(300);
    expect(new Set(r.json.occupations.map((o: { listStatus: string }) => o.listStatus))).toEqual(new Set(["critical-skills", "ineligible", "other"]));
    expect(r.json.graduateMinimum).toBe(rules.minimums.graduate);
    expect(r.json.rangeNote).toBe(`Pay depends on where you start on the scale. Experienced candidates, and recent graduates (€${rules.minimums.graduate.toLocaleString("en-IE")} minimum), usually qualify. Employer-paid health insurance also counts.`);
    expect(r.type).toMatch(/json/);
    expect(replyProblems(loadSpec("portal"), "GET", "/api/portal/jobs/form", 200, r.json)).toEqual([]);
  });

  it("refuses a signed-out visitor, a candidate login and a forged cookie; any query key is 400", async () => {
    const c = await company();
    expect((await form()).status).toBe(401);
    expect((await form(candidateCookie)).status).toBe(401);
    expect((await form("portal.session_token=forged.value")).status).toBe(401);
    for (const q of ["?x=1", "?occupation=2134", "?after=1", "?statement=v1", "?a=1&a=2"]) expect(await form(c.m.account_owner!.cookie, q), q).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
    expect(replyProblems(loadSpec("portal"), "GET", "/api/portal/jobs/form", 400, { code: "BAD_REQUEST" })).toEqual([]);
  });
});

describe("B51: the company flags", () => {
  it("publicPayTier is 1 for a company named on the public pay-deal list, 0 for any other and always 0 for an agency; permitHistory is the company's own", async () => {
    const hse = await company({ name: "Health Service Executive", kind: "public_body", roles: ["account_owner", "viewer"] });
    const plain = await company();
    const agency = await company({ name: "Health Service Executive", kind: "agency", roles: ["account_owner"] });
    await su.query("update organisation set permit_history = 'first_time' where id = $1", [plain.org]);
    await su.query("update organisation set permit_history = 'has_history' where id = $1", [hse.org]);
    for (const who of Object.values(hse.m)) expect((await comp(who.cookie)).json.company).toMatchObject({ publicPayTier: 1, permitHistory: "has_history" });
    expect((await comp(plain.m.account_owner!.cookie)).json.company).toMatchObject({ publicPayTier: 0, permitHistory: "first_time" });
    expect((await comp(agency.m.account_owner!.cookie)).json.company).toMatchObject({ publicPayTier: 0, permitHistory: "not_linked" }); // an agency never has the public pay tier (#67, #39, CF98)
    const r = await comp(hse.m.account_owner!.cookie);
    expect(replyProblems(loadSpec("portal"), "GET", "/api/portal/company", 200, r.json)).toEqual([]);
    expect((await comp()).status).toBe(401);
    expect((await comp(candidateCookie)).status).toBe(401);
  });

  it("a company reads only its own flags: another company's name or history never shows", async () => {
    const a = await company({ name: "Health Service Executive", kind: "public_body", roles: ["account_owner"] });
    const b = await company({ roles: ["account_owner"] });
    expect((await comp(b.m.account_owner!.cookie)).json.company).toMatchObject({ publicPayTier: 0, organisationId: b.org });
    expect((await comp(a.m.account_owner!.cookie)).json.company.organisationId).toBe(a.org);
  });
});

describe("B51: budgets", () => {
  it("the form read and the company read stay inside their statement count and median time", async () => {
    const c = await company({ roles: ["account_owner"] });
    const cookie = c.m.account_owner!.cookie;
    for (const [name, run, b] of [["form", () => form(cookie), BUDGET.form], ["company", () => comp(cookie), BUDGET.company]] as const) {
      await run();
      const [, st] = await counted(run);
      const ms = await median(run);
      console.log(`${name}: ${st} statements, median ${ms.toFixed(1)} ms`);
      expect(st, `${name} statements`).toBeLessThanOrEqual(b.statements);
      expect(ms, `${name} time`).toBeLessThan(b.medianMs);
    }
  });
});
