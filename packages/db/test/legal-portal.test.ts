// Integration: R5 on the portal site, through the real route handlers on the real test database as app_portal. GET /api/legal gives the text in
// force for portal_signup_terms or privacy_notice with no login, rate limited per client address (portal_rate_limit); an employer who signs up
// after a new version consents to that version. Texts are published through the real legal-texts.ts functions as app_admin. No network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { portalAnswers, publishLegal } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

// Measured 19 Nov 2026: a read is 2 statements (the rate count, the read; PERF-3 on 27 Nov 2026 counts both windows in one statement), signed in or not (no session is read); median 0.9 ms.
const BUDGET = { read: 2, medianMs: 15 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, admin: pg.Pool;
let AUTH: Handler, LEGAL: Handler;
const spec = loadSpec("portal");

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: LEGAL } = await import("../../../apps/portal/app/api/legal/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const get = async (query: string, o: { cookie?: string; ip?: string } = {}) => {
  const res = await LEGAL(new Request(`${BASE}/api/legal${query}`, { headers: { ...(o.cookie ? { cookie: o.cookie } : {}), "x-vercel-forwarded-for": o.ip ?? `203.0.113.${(++n % 240) + 10}.${n}` } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, retry: res.headers.get("retry-after") };
};
const auth = (path: string, body: unknown) => AUTH(new Request(`${BASE}/api/auth/portal/${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(++n % 200) + 10}` },
}));
async function login() {
  const p = { email: `fake.employer${++n}@example.test`, password: `Fake-${n}-password-1`, name: "Fake Employer", ...portalAnswers };
  expect((await auth("sign-up/email", p)).status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [p.email]);
  const r = await auth("sign-in/email", { email: p.email, password: p.password });
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), email: p.email };
}
const consented = async (email: string) => (await su.query(
  "select x.purpose, x.version from portal_consent_record c join consent_text x on x.id = c.consent_text_id join portal_user u on u.id = c.portal_user_id where u.email = $1", [email])).rows;
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("GET /api/legal (portal site)", () => {
  it("before any version: 404 for each purpose; another purpose, none or the candidate's is 400", async () => {
    for (const p of ["portal_signup_terms", "privacy_notice"]) {
      const g = await get(`?purpose=${p}`);
      expect([g.status, g.body, replyProblems(spec, "GET", "/api/legal", g.status, g.body)]).toEqual([404, { code: "NOT_FOUND" }, []]);
    }
    await publishLegal(su, admin, "signup_terms", "c1"); // a candidate text never shows here
    for (const q of ["", "?purpose=", "?purpose=signup_terms", "?purpose=visibility", "?purpose=Privacy_notice", "?purpose=privacy_notice%0a", "?purpose=" + "x".repeat(5000)]) {
      const g = await get(q);
      expect([g.status, g.body, replyProblems(spec, "GET", "/api/legal", g.status, g.body)], q).toEqual([400, { code: "BAD_REQUEST" }, []]);
    }
  });
  it("after one version and after a second: the newest, the same signed in or not; a new sign-up consents to the new version", async () => {
    await publishLegal(su, admin, "portal_signup_terms", "e1");
    await publishLegal(su, admin, "privacy_notice", "p1");
    const g = await get("?purpose=portal_signup_terms");
    expect(g.body).toEqual({ purpose: "portal_signup_terms", version: "e1", body: "PLACEHOLDER portal_signup_terms e1.", publishedAt: expect.any(String) });
    expect(replyProblems(spec, "GET", "/api/legal", g.status, g.body)).toEqual([]);
    const first = await login();
    expect(await consented(first.email)).toEqual([{ purpose: "portal_signup_terms", version: "e1" }]);
    await publishLegal(su, admin, "portal_signup_terms", "e2");
    await publishLegal(su, admin, "privacy_notice", "p2");
    for (const cookie of [undefined, first.cookie, "portal.session_token=forged"]) {
      expect((await get("?purpose=portal_signup_terms", { cookie })).body, cookie).toMatchObject({ version: "e2" });
      expect((await get("?purpose=privacy_notice", { cookie })).body, cookie).toMatchObject({ version: "p2" });
    }
    const second = await login();
    expect(await consented(second.email)).toEqual([{ purpose: "portal_signup_terms", version: "e2" }]);
    expect(await consented(first.email)).toEqual([{ purpose: "portal_signup_terms", version: "e1" }]);
  });
  it("is rate limited per client address, signed in or not (60 a minute, Retry-After); the count is in portal_rate_limit", async () => {
    const ip = "192.0.2.90";
    for (let i = 0; i < 60; i++) expect((await get("?purpose=privacy_notice", { ip })).status).toBe(200);
    const over = await get("?purpose=privacy_notice", { ip });
    expect([over.status, over.body, Number(over.retry) > 0, replyProblems(spec, "GET", "/api/legal", over.status, over.body)]).toEqual([429, { code: "TOO_MANY_REQUESTS" }, true, []]);
    expect((await get("?purpose=privacy_notice", { ip: "192.0.2.91" })).status).toBe(200);
    expect((await su.query("select count(*)::int n from portal_rate_limit where key like 'legal:ip:192.0.2.90:%'")).rows[0].n).toBe(2);
  });
  it("keeps the statements and time within budget", async () => {
    const [, read] = await counted(() => get("?purpose=portal_signup_terms"));
    expect(read).toBe(BUDGET.read);
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await get("?purpose=portal_signup_terms"); ms.push(performance.now() - t); }
    const median = ms.sort((a, b) => a - b)[4]!;
    console.log("legal read (portal) median ms:", median.toFixed(2));
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
