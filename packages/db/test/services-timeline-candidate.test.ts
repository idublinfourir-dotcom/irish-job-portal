// Integration: GET /api/candidate/cases/[id]/timeline (SV-B2, S-Q9) through the candidate app's real route and auth on the real test database as
// app_candidate. Fixture cases and staff events are made as postgres through 0061's schema. Fake people only; no network.
// Measured 20 Nov 2026 (warm, median of 9, this file alone): 3 statements (2 for the session, 1 read), 3.5 ms; budget 3 statements, 12 ms.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median } from "./staff-routes-harness";

const BUDGET = { statements: 3, medianMs: 12 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32", BASE = "http://localhost:3000";
type Handler = (r: Request, ctx: never) => Promise<Response>;
let db: TestDb, su: pg.Pool, AUTH: (r: Request) => Promise<Response>, TL: { GET: Handler }, PORTAL_TL: { GET: Handler };
let F: { text(p?: string): Promise<string>; staff(): Promise<string>; org(): Promise<string>; portal(): Promise<string> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret,
    PORTAL_AUTH_URL: "http://localhost:3001", PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  TL = await import("../../../apps/candidate/app/api/candidate/cases/[id]/timeline/route");
  PORTAL_TL = await import("../../../apps/portal/app/api/portal/cases/[id]/timeline/route");
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
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from candidate_user where email = $1", [email])).rows[0].id as string };
}
const spec = loadSpec("candidate");
const get = async (route: { GET: Handler }, cookie: string | null, id: string) => {
  const res = await route.GET(new Request(`${BASE}/api/candidate/cases/${id}/timeline`, { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ id }) } as never);
  const json = await res.json();
  if (route === TL) expect(replyProblems(spec, "GET", "/api/candidate/cases/{id}/timeline", res.status, json)).toEqual([]); // every reply matches the spec (#248)
  return { status: res.status, json };
};
async function caseOf(cand: string) {
  const k = (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text("services_request")])).rows[0].id;
  const c = String((await su.query("insert into services_case(candidate_user_id, consent_record_id) values ($1, $2) returning id", [cand, k])).rows[0].id);
  await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'received', 'received', $2)", [c, cand]);
  return c;
}

describe("GET /api/candidate/cases/[id]/timeline", () => {
  it("the requester reads every step with labels and no staff id, name or note; anyone else gets 404; signed out 401; a bad id 400", async () => {
    const me = await login(), other = await login();
    const c = await caseOf(me.id), staff = await F.staff();
    await su.query("insert into case_event(case_id, kind, status, staff_user_id, detail) values ($1, 'assigned', 'received', $2, $3), ($1, 'documents_needed', 'documents_needed', $2, $4)",
      [c, staff, JSON.stringify({ assignedStaffUserId: staff }), JSON.stringify({ documentsNeeded: ["offer_letter"] })]);
    await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1, $2, 'Secret staff note')", [c, staff]);
    const r = await get(TL, me.cookie, c);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ events: [
      { at: expect.any(String), kind: "received", status: "received" },
      { at: expect.any(String), kind: "assigned", status: "received" },
      { at: expect.any(String), kind: "documents_needed", status: "documents_needed", documentsNeeded: [{ code: "offer_letter", label: "Job offer letter" }] },
    ] });
    for (const bad of [staff, "Fake Staff", "Secret", "assignedStaffUserId"]) expect(JSON.stringify(r.json)).not.toContain(bad);
    expect(await get(TL, other.cookie, c)).toEqual({ status: 404, json: { code: "CASE_NOT_FOUND" } });
    expect(await get(TL, me.cookie, "999999999")).toEqual({ status: 404, json: { code: "CASE_NOT_FOUND" } });
    expect(await get(TL, null, c)).toEqual({ status: 401, json: { code: "NO_SESSION" } });
    for (const bad of ["abc", "-1", "1".repeat(30), "1 or 1=1", "%00"]) expect(await get(TL, me.cookie, bad)).toEqual({ status: 400, json: { code: "BAD_REQUEST" } });
  });

  it("a portal case is not the candidate's (404), and the portal route on the candidate login is refused", async () => {
    const me = await login();
    const org = await F.org(), pu = await F.portal();
    const k = (await su.query("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [pu, await F.text("services_request")])).rows[0].id;
    const c = String((await su.query("insert into services_case(portal_user_id, organisation_id, consent_record_id, dedupe_key) values ($1, $2, $3, $4) returning id", [pu, org, k, `k${Date.now()}`])).rows[0].id);
    expect((await get(TL, me.cookie, c)).status).toBe(404);
    expect((await get(PORTAL_TL, me.cookie, c)).status).not.toBe(200); // no portal session on a candidate cookie
  });

  it("perf: the read is one statement after the session (2), within budget", async () => {
    const me = await login();
    const c = await caseOf(me.id);
    await get(TL, me.cookie, c);
    const [, statements] = await counted(() => get(TL, me.cookie, c));
    const ms = await median(() => get(TL, me.cookie, c));
    console.log(`candidate timeline: ${statements} statements, ${ms.toFixed(2)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements);
    expect(ms).toBeLessThanOrEqual(BUDGET.medianMs);
  });
});
