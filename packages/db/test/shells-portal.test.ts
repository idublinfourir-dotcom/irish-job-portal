// Step 16 wave 1 (P3): the portal sidebar read (apps/portal/lib/data.ts readShell and requireLogin) on the test database as app_portal with real portal
// logins: each membership role, a login with no company, a removed member, a blocked login, a visitor and a candidate's cookie. Role refusals of the
// pages the hidden links lead to are proven by the route tests named in the report (jobs-route.test.ts NOT_A_POSTER, services-requests-portal.test.ts
// ROLE_REFUSED); here the sidebar read gives the role the layout hides links by. Only Next's request context is stood in; no network. Fake people only.
// Budget (measured 23 November 2026, see the printed line): the shell read is 7 statements for a member (two requirePortal of 3 each, the company read), 0 for a visitor.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, makeAuth, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));

const BUDGET = { memberStatements: 7, visitorStatements: 0, medianMs: 20 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, AUTH: Handler;
let F: { org(o?: object): Promise<string>; member(org: string, user: string | null, o?: object): Promise<number> };
let D: typeof import("../../../apps/portal/lib/data");
let candidateCookie: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  D = await import("../../../apps/portal/lib/data");
  const cand = makeAuth("candidate", db.pool("app_candidate"));
  const h = { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": "198.51.100.250" };
  const body = { email: "fake.candidate.shell@example.test", password: "Fake-password-12345", name: "Fake" };
  expect((await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-up/email", { method: "POST", headers: h, body: JSON.stringify({ ...body, ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [body.email]);
  const r = await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-in/email", { method: "POST", headers: h, body: JSON.stringify({ email: body.email, password: body.password }) }));
  candidateCookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
async function login() {
  const email = `fake.shell${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from portal_user where email = $1", [email])).rows[0].id as string };
}
const as = <T>(cookie: string | undefined, fn: () => Promise<T>): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": "203.0.113.9" });
  return fn();
};
const redirected = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as Error).message; } };
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("P3: the portal sidebar read", () => {
  it("gives each member of a company its company name and its own role", async () => {
    const org = await F.org({ name: "Fake Shell Company Ltd" });
    for (const role of ["viewer", "poster", "recruiter", "account_owner"]) {
      const u = await login();
      await F.member(org, u.id, { role });
      expect(await as(u.cookie, () => D.readShell()), role).toEqual({ companyName: "Fake Shell Company Ltd", role });
    }
  });
  it("gives a visitor, a login with no company, a removed member, a blocked login and a candidate's cookie nothing (the bare page)", async () => {
    const org = await F.org();
    const noCompany = await login();
    const removed = await login();
    await F.member(org, removed.id, { role: "poster", status: "removed" });
    const blocked = await login();
    await F.member(org, blocked.id, { role: "poster" });
    await su.query("update portal_user set status = 'blocked' where id = $1", [blocked.id]);
    for (const [who, cookie] of [["visitor", undefined], ["no company", noCompany.cookie], ["removed", removed.cookie], ["blocked", blocked.cookie], ["candidate cookie", candidateCookie], ["made-up cookie", "portal.session_token=abc"]] as const)
      expect(await as(cookie, () => D.readShell()), who).toBeNull();
  });
  it("requireLogin sends a visitor, a blocked login and a candidate to the sign-in page, and lets a login with or without a company through", async () => {
    const org = await F.org();
    const member = await login();
    await F.member(org, member.id, { role: "viewer" });
    const noCompany = await login();
    const blocked = await login();
    await su.query("update portal_user set status = 'blocked' where id = $1", [blocked.id]);
    for (const cookie of [undefined, blocked.cookie, candidateCookie, "portal.session_token=abc"]) expect(await as(cookie, () => redirected(D.requireLogin())), String(cookie)).toBe(`REDIRECT:${D.PORTAL_SIGN_IN}`);
    expect((await as(member.cookie, () => D.requireLogin())).membership?.role).toBe("viewer");
    expect((await as(noCompany.cookie, () => D.requireLogin())).membership).toBeNull();
  });
  it("a company name with markup is returned as stored (the layout escapes it)", async () => {
    const org = await F.org({ name: "<b>Fake</b> & Co" });
    const u = await login();
    await F.member(org, u.id, { role: "viewer" });
    expect((await as(u.cookie, () => D.readShell()))?.companyName).toBe("<b>Fake</b> & Co");
  });
  it("stays within the statement and time budget", async () => {
    const org = await F.org();
    const u = await login();
    await F.member(org, u.id, { role: "recruiter" });
    await as(u.cookie, () => D.readShell());
    const [, member] = await counted(() => as(u.cookie, () => D.readShell()));
    const [, visitor] = await counted(() => as(undefined, () => D.readShell()));
    const t: number[] = [];
    for (let i = 0; i < 21; i++) { const s = performance.now(); await as(u.cookie, () => D.readShell()); t.push(performance.now() - s); }
    const median = t.sort((x, y) => x - y)[10]!;
    console.log(`P3 shell read: member ${member} statements, visitor ${visitor}, median ${median.toFixed(1)} ms`);
    expect(member).toBeLessThanOrEqual(BUDGET.memberStatements);
    expect(visitor).toBeLessThanOrEqual(BUDGET.visitorStatements);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
