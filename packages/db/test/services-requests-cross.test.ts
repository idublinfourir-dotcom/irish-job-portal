// Step 15 SV-A: the other side's session on every permit services route is no session (401), on both apps, and nothing is written. The real
// auth routes and route handlers of both apps run as the database owner here (the only way one process holds both logins, as
// dal-cross-login.test.ts); the per-side grants are proved in services-requests-candidate.test.ts and services-requests-portal.test.ts.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { saveServicesTexts } from "../src/services-texts-cli";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const CAND = "http://localhost:3000", PORT = "http://localhost:3001";
type Handler = (r: Request, ctx?: never) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST", Handler>>;
let db: TestDb, su: pg.Pool;
let candAuth: Handler, portAuth: Handler;
const C = {} as Record<"cases" | "one" | "withdraw", Route>, P = {} as typeof C;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
  const c = await su.connect();
  try { await saveServicesTexts(c); } finally { c.release(); }
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: CAND, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: PORT, PORTAL_AUTH_SECRET: secret });
  ({ POST: candAuth } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ POST: portAuth } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  for (const [side, R] of [["candidate", C], ["portal", P]] as const) {
    R.cases = await import(`../../../apps/${side}/app/api/${side}/cases/route`);
    R.one = await import(`../../../apps/${side}/app/api/${side}/cases/[id]/route`);
    R.withdraw = await import(`../../../apps/${side}/app/api/${side}/cases/[id]/withdraw/route`);
  }
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const H = (base: string) => ({ "content-type": "application/json", origin: base, "x-vercel-forwarded-for": "198.51.100.91" });
async function signUpIn(auth: Handler, base: string, pool: "candidate" | "portal", email: string, extra: object) {
  const password = "Fake-password-12345";
  expect((await auth(new Request(`${base}/api/auth/${pool}/sign-up/email`, { method: "POST", headers: H(base), body: JSON.stringify({ email, password, name: "Fake", ...extra }) }))).status).toBe(200);
  await su.query(`update ${pool}_user set email_verified=true where email=$1`, [email]);
  const r = await auth(new Request(`${base}/api/auth/${pool}/sign-in/email`, { method: "POST", headers: H(base), body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

it("a portal session on the candidate routes and a candidate session on the portal routes are 401, and write nothing", async () => {
  const cand = await signUpIn(candAuth, CAND, "candidate", "sv.cand@example.test", answers);
  const portal = await signUpIn(portAuth, PORT, "portal", "sv.portal@example.test", portalAnswers);
  const body = JSON.stringify({ permitType: "general", offerDetails: { notes: "x" }, servicesConsent: true, idempotencyKey: "cross-key-0123456789" });
  for (const [base, R, cookie] of [[CAND, C, portal], [PORT, P, cand]] as const) {
    const ctx = { params: Promise.resolve({ id: "1" }) } as never;
    const req = (m: string, b?: string) => new Request(`${base}/api/x`, { method: m, headers: { cookie, origin: base }, body: b });
    for (const res of [await R.cases.GET!(req("GET")), await R.cases.POST!(req("POST", body)), await R.one.GET!(req("GET"), ctx), await R.withdraw.POST!(req("POST", ""), ctx)])
      expect([res.status, (await res.json()).code]).toEqual([401, "NO_SESSION"]);
  }
  expect((await su.query("select count(*)::int n from services_case")).rows[0].n).toBe(0);
});
