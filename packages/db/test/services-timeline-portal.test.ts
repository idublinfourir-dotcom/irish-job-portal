// Integration: GET /api/portal/cases/[id]/timeline (SV-B2, S-Q9) through the portal app's real route and auth on the real test database as
// app_portal. The reader rule is 0061's: the requester, or the Owner or a Recruiter of the company on a portal case. Fake people only; no network.
// Measured 20 Nov 2026 (warm, median of 9, this file alone): 4 statements (3 for the portal session, 1 read), 3.0 ms; budget 4 statements, 12 ms.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median } from "./staff-routes-harness";

const BUDGET = { statements: 4, medianMs: 12 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32", BASE = "http://localhost:3001";
type Handler = (r: Request, ctx: never) => Promise<Response>;
let db: TestDb, su: pg.Pool, AUTH: (r: Request) => Promise<Response>, TL: { GET: Handler }, CAND_TL: { GET: Handler };
let F: { text(p?: string): Promise<string>; staff(): Promise<string>; org(): Promise<string>; cand(): Promise<string>; member(o: string, u: string, x?: { role?: string }): Promise<string> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret,
    CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  TL = await import("../../../apps/portal/app/api/portal/cases/[id]/timeline/route");
  CAND_TL = await import("../../../apps/candidate/app/api/candidate/cases/[id]/timeline/route");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
async function login() {
  const email = `fake.${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from portal_user where email = $1", [email])).rows[0].id as string };
}
const spec = loadSpec("portal");
const get = async (route: { GET: Handler }, cookie: string | null, id: string) => {
  const res = await route.GET(new Request(`${BASE}/api/portal/cases/${id}/timeline`, { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ id }) } as never);
  const json = await res.json();
  if (route === TL) expect(replyProblems(spec, "GET", "/api/portal/cases/{id}/timeline", res.status, json)).toEqual([]); // every reply matches the spec (#248)
  return { status: res.status, json };
};

describe("GET /api/portal/cases/[id]/timeline", () => {
  it("the requester, the company's Owner and a Recruiter read it; a Poster, a Viewer, another company's Owner and signed out do not", async () => {
    const org = await F.org(), other = await F.org();
    const requester = await login(), owner = await login(), recruiter = await login(), poster = await login(), viewer = await login(), stranger = await login(), otherOwner = await login();
    for (const [u, role] of [[requester, "recruiter"], [owner, "account_owner"], [recruiter, "recruiter"], [poster, "poster"], [viewer, "viewer"]] as const) await F.member(org, u.id, { role });
    await F.member(other, otherOwner.id, { role: "account_owner" });
    const k = (await su.query("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [requester.id, await F.text("services_request")])).rows[0].id;
    const c = String((await su.query("insert into services_case(portal_user_id, organisation_id, consent_record_id, dedupe_key, status, decided_at, decision_outcome) values ($1, $2, $3, $4, 'decision', now(), 'granted') returning id",
      [requester.id, org, k, `k${Date.now()}`])).rows[0].id);
    const staff = await F.staff();
    await su.query("insert into case_event(case_id, kind, status, portal_user_id) values ($1, 'received', 'received', $2)", [c, requester.id]);
    await su.query("insert into case_event(case_id, kind, status, staff_user_id, detail) values ($1, 'decision', 'decision', $2, '{\"outcome\":\"granted\"}')", [c, staff]);
    const want = { events: [{ at: expect.any(String), kind: "received", status: "received" },
      { at: expect.any(String), kind: "decision", status: "decision", outcome: { code: "granted", label: "Permit granted" } }] };
    for (const u of [requester, owner, recruiter]) expect(await get(TL, u.cookie, c)).toEqual({ status: 200, json: want });
    for (const u of [poster, viewer, stranger, otherOwner]) expect(await get(TL, u.cookie, c)).toEqual({ status: 404, json: { code: "CASE_NOT_FOUND" } });
    expect(await get(TL, null, c)).toEqual({ status: 401, json: { code: "NO_SESSION" } });
    expect(JSON.stringify((await get(TL, owner.cookie, c)).json)).not.toContain(staff);
    // a candidate's case that names the company is never the company's (20d:109)
    const cand = await F.cand();
    const ck = (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text("services_request")])).rows[0].id;
    const cc = String((await su.query("insert into services_case(candidate_user_id, organisation_id, consent_record_id) values ($1, $2, $3) returning id", [cand, org, ck])).rows[0].id);
    await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'received', 'received', $2)", [cc, cand]);
    for (const u of [owner, recruiter]) expect((await get(TL, u.cookie, cc)).status).toBe(404);
    // the candidate route on this (portal) login: no candidate session
    expect((await get(CAND_TL, owner.cookie, cc)).status).toBe(401);
    for (const bad of ["abc", "0x1", "1".repeat(30)]) expect((await get(TL, owner.cookie, bad)).status).toBe(400);

    const [, statements] = await counted(() => get(TL, owner.cookie, c));
    const ms = await median(() => get(TL, owner.cookie, c));
    console.log(`portal timeline: ${statements} statements, ${ms.toFixed(2)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements);
    expect(ms).toBeLessThanOrEqual(BUDGET.medianMs);
  });
});
