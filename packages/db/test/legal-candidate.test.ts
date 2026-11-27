// Integration: R5 on the candidate site, through the real route handlers on the real test database as app_candidate. GET /api/legal gives the text
// in force for signup_terms or privacy_notice, to a visitor and a signed-in candidate, rate limited as the other public reads; a candidate who signs
// up after a new version consents to that version. Texts are published through the real legal-texts.ts functions as app_admin. No network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, publishLegal } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

// Measured 19 Nov 2026: a visitor's read is 2 statements (the rate count, the read; PERF-3 on 27 Nov 2026 counts both windows in one statement), a candidate's 4 (session 2, rate count, the read); median 0.9 ms.
const BUDGET = { visitor: 2, candidate: 4, medianMs: 15 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, admin: pg.Pool;
let AUTH: Handler, LEGAL: Handler;
const spec = loadSpec("candidate");

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: LEGAL } = await import("../../../apps/candidate/app/api/legal/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}`;
const get = async (query: string, o: { cookie?: string; ip?: string } = {}) => {
  const res = await LEGAL(new Request(`${BASE}/api/legal${query}`, { headers: { ...(o.cookie ? { cookie: o.cookie } : {}), "x-vercel-forwarded-for": o.ip ?? `${freshIp()}.${n}` } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, retry: res.headers.get("retry-after") };
};
async function signUp() {
  const email = `fake.legal${++n}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }));
  return { status: r.status, email, password, h };
}
async function login() {
  const s = await signUp();
  expect(s.status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [s.email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: s.h, body: JSON.stringify({ email: s.email, password: s.password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), email: s.email };
}
const consented = async (email: string) => (await su.query(
  "select x.purpose, x.version from candidate_consent_record c join consent_text x on x.id = c.consent_text_id join candidate_user u on u.id = c.candidate_user_id where u.email = $1", [email])).rows;
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("GET /api/legal (candidate site)", () => {
  it("before any version: 404 for each purpose; another purpose, none or the portal's is 400", async () => {
    for (const p of ["signup_terms", "privacy_notice"]) expect(await get(`?purpose=${p}`)).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    for (const q of ["", "?purpose=", "?purpose=portal_signup_terms", "?purpose=visibility", "?purpose=pay_floor", "?purpose=SIGNUP_TERMS", "?purpose=signup_terms%00", "?purpose=" + "x".repeat(5000)]) {
      const g = await get(q);
      expect([g.status, g.body, replyProblems(spec, "GET", "/api/legal", g.status, g.body)], q).toEqual([400, { code: "BAD_REQUEST" }, []]);
    }
  });
  it("a sign-up before any terms text is refused cleanly", async () => {
    expect((await signUp()).status).toBe(503);
  });
  it("after one version: the text, its version and date, the same to a visitor and a candidate; the newest after a second", async () => {
    await publishLegal(su, admin, "signup_terms", "v1", "PLACEHOLDER terms v1.\nLine two.");
    await publishLegal(su, admin, "privacy_notice", "p1");
    const v = await get("?purpose=signup_terms");
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ purpose: "signup_terms", version: "v1", body: "PLACEHOLDER terms v1.\nLine two.", publishedAt: expect.any(String) });
    expect(replyProblems(spec, "GET", "/api/legal", v.status, v.body)).toEqual([]);
    const first = await login();
    expect(await consented(first.email)).toEqual([{ purpose: "signup_terms", version: "v1" }]);
    expect((await get("?purpose=signup_terms", { cookie: first.cookie })).body).toEqual(v.body);
    expect((await get("?purpose=privacy_notice", { cookie: first.cookie })).body).toMatchObject({ purpose: "privacy_notice", version: "p1" });
    await publishLegal(su, admin, "signup_terms", "v2");
    await publishLegal(su, admin, "privacy_notice", "p2");
    for (const cookie of [undefined, first.cookie, "candidate.session_token=forged", "portal.session_token=x; staff.session_token=y"]) {
      expect((await get("?purpose=signup_terms", { cookie })).body, cookie).toMatchObject({ version: "v2", body: "PLACEHOLDER signup_terms v2." });
      expect((await get("?purpose=privacy_notice", { cookie })).body, cookie).toMatchObject({ version: "p2" });
    }
    // a new sign-up consents to the new version; the earlier candidate keeps the version they agreed to (re-consent is not in this slice)
    const second = await login();
    expect(await consented(second.email)).toEqual([{ purpose: "signup_terms", version: "v2" }]);
    expect(await consented(first.email)).toEqual([{ purpose: "signup_terms", version: "v1" }]);
  });
  it("a portal text never shows here", async () => {
    await publishLegal(su, admin, "portal_signup_terms", "e1");
    expect((await get("?purpose=portal_signup_terms")).status).toBe(400);
  });
  it("is rate limited per address for a visitor (60 a minute, Retry-After)", async () => {
    const ip = "192.0.2.77";
    for (let i = 0; i < 60; i++) expect((await get("?purpose=privacy_notice", { ip })).status).toBe(200);
    const over = await get("?purpose=privacy_notice", { ip });
    expect([over.status, over.body, Number(over.retry) > 0, replyProblems(spec, "GET", "/api/legal", over.status, over.body)]).toEqual([429, { code: "TOO_MANY_REQUESTS" }, true, []]);
    expect((await get("?purpose=privacy_notice", { ip: "192.0.2.78" })).status).toBe(200);
  });
  it("keeps the statements and time within budget", async () => {
    const c = await login();
    const [, visitor] = await counted(() => get("?purpose=signup_terms"));
    const [, candidate] = await counted(() => get("?purpose=signup_terms", { cookie: c.cookie }));
    expect([visitor, candidate]).toEqual([BUDGET.visitor, BUDGET.candidate]);
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await get("?purpose=signup_terms"); ms.push(performance.now() - t); }
    const median = ms.sort((a, b) => a - b)[4]!;
    console.log("legal read (candidate) median ms:", median.toFixed(2));
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
