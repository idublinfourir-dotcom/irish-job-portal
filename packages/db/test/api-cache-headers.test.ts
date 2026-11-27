// PERF-11 (step 16, S3b): the public lists the CDN may keep (apps/candidate/lib/api-cache.ts). A signed-in candidate gets the same body as a visitor and no
// Set-Cookie; only a 200 is cacheable (a 429, 404 or 400 never); the routes that depend on the session stay uncached. Real route handlers, test database, no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3000";
const secret = "trial-only-secret-trial-only-secret-32";
const CACHE = "public, s-maxage=300, stale-while-revalidate=3600";
type Handler = (r: Request) => Promise<Response>;
const R: Record<string, Handler> = {};
let db: TestDb, su: pg.Pool, close: () => Promise<void>;
const PATHS = ["/api/minimums", "/api/occupations", "/api/guides", "/api/help/list", "/api/updates", "/api/legal?purpose=signup_terms", "/api/permit-notice"];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  R.auth = (await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route")).POST;
  R["/api/jobs"] = (await import("../../../apps/candidate/app/api/jobs/route")).GET;
  R["/api/minimums"] = (await import("../../../apps/candidate/app/api/minimums/route")).GET;
  R["/api/occupations"] = (await import("../../../apps/candidate/app/api/occupations/route")).GET;
  R["/api/guides"] = (await import("../../../apps/candidate/app/api/guides/route")).GET;
  R["/api/help/list"] = (await import("../../../apps/candidate/app/api/help/list/route")).GET;
  R["/api/updates"] = (await import("../../../apps/candidate/app/api/updates/route")).GET;
  R["/api/legal"] = (await import("../../../apps/candidate/app/api/legal/route")).GET;
  R["/api/permit-notice"] = (await import("../../../apps/candidate/app/api/permit-notice/route")).GET;
  close = async () => { await (await import("../src")).getPool().end(); };
});
afterAll(async () => { await close(); await db.drop(); });

let n = 0;
const ip = () => `203.0.113.${(++n % 240) + 10}`;
const get = (path: string, o: { cookie?: string; ip?: string } = {}) =>
  R[path.split("?")[0]!]!(new Request(`${BASE}${path}`, { headers: { ...(o.cookie ? { cookie: o.cookie } : {}), "x-vercel-forwarded-for": o.ip ?? ip() } }));
async function candidate() {
  const email = `fake.cache${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await R.auth!(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await R.auth!(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

describe("PERF-11: cacheable public lists", () => {
  it("send the CDN header on a 200, with the same body and no cookie for a visitor and a signed-in candidate", async () => {
    const cookie = await candidate();
    for (const p of PATHS) {
      const [v, c] = [await get(p), await get(p, { cookie })];
      if (v.status !== 200) { expect(v.headers.get("cache-control"), p).toBeNull(); continue; } // permit-notice is 404 while staff have it off
      expect([c.status, await c.json()], p).toEqual([200, await v.json()]);
      for (const res of [v, c]) {
        expect(res.headers.get("cache-control"), p).toBe(CACHE);
        expect(res.headers.get("set-cookie"), p).toBeNull();
      }
    }
  });
  it("never mark a refusal cacheable: 429, 404 and 400", async () => {
    for (const p of PATHS) {
      const a = ip();
      await get(p, { ip: a });
      await su.query("update candidate_rate_limit set count = 60 where key = $1", [`read:ip:${a}:60000`]);
      const r = await get(p, { ip: a });
      expect([p, r.status, r.headers.get("cache-control")], p).toEqual([p, 429, null]);
    }
    for (const p of ["/api/legal?purpose=privacy_notice", "/api/legal?purpose=nope", "/api/legal?purpose=x'%20or%201=1--", "/api/updates?after=junk!"]) {
      const r = await get(p);
      expect(r.status, p).not.toBe(200);
      expect(r.headers.get("cache-control"), p).toBeNull();
    }
  });
  it("leave the session-dependent list uncached", async () => {
    expect((await get("/api/jobs")).headers.get("cache-control") ?? "").not.toContain("s-maxage");
  });
});
