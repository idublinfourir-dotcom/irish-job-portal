// SEC-6: the signed-in candidate GETs are counted per login (the read limit the public reads already use, 300 a minute), and the export has its own
// limit (5 an hour), both in one statement before the work. Real routes on the test database; the three auth routes run as the database owner, the only
// way one process holds the three logins (as dal-cross-login.test.ts). Fake people only; no outside service is involved (nothing to fake).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedStaff } from "../src/staff-seed-cli";
import { CANDIDATE_READ_RATES, candidateReadLimits } from "../src/candidate-route";
import { EXPORT_RATE, exportLimit } from "../src/candidate";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
// Statements of one signed-in GET of the profile, measured 27 Nov 2026: 2 for the session, 1 profile read, and now 1 for the count (SEC-6: one more at most).
const PROFILE_STATEMENTS = 4;
const secret = "trial-only-secret-trial-only-secret-32";
const CAND = "http://localhost:3000", PORT = "http://localhost:3001", STAFF = "http://localhost:3002";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let candAuth: Handler, portAuth: Handler, staffAuth: Handler, EXPORT: Handler, PROFILE: Handler, SAVED: Handler;
let portalCookie: string, staffCookie: string;

const H = (base: string, ip = "198.51.100.91") => ({ "content-type": "application/json", origin: base, "x-vercel-forwarded-for": ip });
const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
let n = 0;
async function signUpIn(auth: Handler, base: string, pool: "candidate" | "portal", extra: object) {
  const email = `fake.read.${pool}.${++n}@example.test`, password = "Fake-password-12345", ip = `198.51.100.${(n % 200) + 20}`;
  expect((await auth(new Request(`${base}/api/auth/${pool}/sign-up/email`, { method: "POST", headers: H(base, ip), body: JSON.stringify({ email, password, name: "Fake", ...extra }) }))).status).toBe(200);
  await su.query(`update ${pool}_user set email_verified=true where email=$1`, [email]);
  const r = await auth(new Request(`${base}/api/auth/${pool}/sign-in/email`, { method: "POST", headers: H(base, ip), body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const id = (await su.query(`select id from ${pool}_user where email=$1`, [email])).rows[0].id as string;
  return { cookie: cookieOf(r), id };
}
const get = (route: Handler, path: string, cookie?: string, ip = "203.0.113.7") => route(new Request(`${CAND}${path}`, { headers: { ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip } }));
const audits = async (id: string) => (await su.query("select count(*)::int n from audit_event where action='candidate.export' and actor_candidate_user_id=$1", [id])).rows[0].n as number;
const rows = async () => (await su.query("select count(*)::int n from candidate_rate_limit")).rows[0].n as number;
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, {
    DATABASE_URL: urlFor(db.name), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: CAND, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: PORT, PORTAL_AUTH_SECRET: secret,
    STAFF_AUTH_URL: STAFF, STAFF_AUTH_SECRET: secret,
  });
  ({ POST: candAuth } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ POST: portAuth } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: staffAuth } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
  ({ GET: EXPORT } = await import("../../../apps/candidate/app/api/candidate/export/route"));
  ({ GET: PROFILE } = await import("../../../apps/candidate/app/api/candidate/profile/route"));
  ({ GET: SAVED } = await import("../../../apps/candidate/app/api/candidate/saved/route"));
  portalCookie = (await signUpIn(portAuth, PORT, "portal", portalAnswers)).cookie;
  const c = await su.connect();
  try { await seedStaff(c, { email: "fake.read.staff@example.test", name: "Fake Staff", roles: ["administrator"] }, "Fake-staff-password-1"); } finally { c.release(); }
  const sr = await staffAuth(new Request(`${STAFF}/api/auth/staff/sign-in/email`, { method: "POST", headers: H(STAFF), body: JSON.stringify({ email: "fake.read.staff@example.test", password: "Fake-staff-password-1" }) }));
  expect(sr.status).toBe(200);
  staffCookie = cookieOf(sr);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("limit keys (unit)", () => {
  it("are made from the login id only, the read keys shared with the public reads, the export apart", () => {
    expect(candidateReadLimits("u1")).toEqual([{ key: "read:candidate:u1:60000", rate: { windowMs: 60_000, max: 300 } }]);
    expect(candidateReadLimits("u1", "portal").map((l) => l.key)).toEqual(["read:portal:u1:60000"]); // the portal's case timeline, in portal_rate_limit
    expect(exportLimit("u1")).toEqual([{ key: "export:u1", rate: { windowMs: 3_600_000, max: 5 } }]);
  });
});

describe("the export: 5 an hour per login", () => {
  it("the 6th export in the hour is 429 and writes no audit row; another candidate still exports", async () => {
    const a = await signUpIn(candAuth, CAND, "candidate", answers), b = await signUpIn(candAuth, CAND, "candidate", answers);
    for (let i = 0; i < EXPORT_RATE.max; i++) expect((await get(EXPORT, "/api/candidate/export", a.cookie)).status).toBe(200);
    expect(await audits(a.id)).toBe(EXPORT_RATE.max);
    const over = await get(EXPORT, "/api/candidate/export", a.cookie);
    expect([over.status, await over.json(), over.headers.get("content-disposition"), over.headers.get("cache-control")]).toEqual([429, { code: "TOO_MANY_REQUESTS" }, null, "no-store"]);
    expect(await audits(a.id)).toBe(EXPORT_RATE.max);
    expect((await get(EXPORT, "/api/candidate/export", b.cookie)).status).toBe(200);
    // the hour over: the count starts again
    await su.query("update candidate_rate_limit set last_request = $2 where key = $1", [`export:${a.id}`, Date.now() - 1]);
    expect((await get(EXPORT, "/api/candidate/export", a.cookie)).status).toBe(200);
    expect(await audits(a.id)).toBe(EXPORT_RATE.max + 1);
  });
  it("cannot be reset with query strings, another client address or a second cookie", async () => {
    const a = await signUpIn(candAuth, CAND, "candidate", answers);
    await su.query("insert into candidate_rate_limit(id, key, count, last_request) values ($1, $2, $3, $4)", [`t-${a.id}`, `export:${a.id}`, EXPORT_RATE.max, Date.now() + 3_600_000]);
    for (const [q, ip, cookie] of [["?userId=other", "203.0.113.8", a.cookie], ["?reset=1&key=export", "203.0.113.9", a.cookie], ["", "198.51.100.1", `${a.cookie}; candidate.session_token=forged.value`], ["?x=%00", "none", a.cookie]] as const)
      expect((await get(EXPORT, `/api/candidate/export${q}`, cookie, ip)).status, q).toBe(429);
    expect(await audits(a.id)).toBe(0);
  });
});

describe("the signed-in reads: 300 a minute per login", () => {
  it("the 301st read in the minute is 429 on every signed-in GET; the count is shared with the public reads and per login", async () => {
    const a = await signUpIn(candAuth, CAND, "candidate", answers), b = await signUpIn(candAuth, CAND, "candidate", answers);
    const { key } = candidateReadLimits(a.id)[0]!;
    await su.query("insert into candidate_rate_limit(id, key, count, last_request) values ($1, $2, $3, $4)", [`t-${a.id}`, key, CANDIDATE_READ_RATES[0]!.max - 1, Date.now() + 60_000]);
    expect((await get(PROFILE, "/api/candidate/profile", a.cookie)).status).toBe(200); // the 300th
    for (const [route, path] of [[PROFILE, "/api/candidate/profile"], [SAVED, "/api/candidate/saved"], [EXPORT, "/api/candidate/export"]] as const) {
      const r = await get(route, `${path}?bust=${Math.random()}`, a.cookie, `203.0.113.${(++n % 200) + 10}`);
      expect([r.status, await r.json()], path).toEqual([429, { code: "TOO_MANY_REQUESTS" }]);
    }
    expect(await audits(a.id)).toBe(0); // the refused export did not run
    expect((await get(PROFILE, "/api/candidate/profile", b.cookie)).status).toBe(200);
  });
  it("a visitor, a portal session, a staff session and a forged cookie get 401 and write no count", async () => {
    const before = await rows();
    for (const cookie of [undefined, portalCookie, staffCookie, "candidate.session_token=forged.value"])
      for (const [route, path] of [[PROFILE, "/api/candidate/profile"], [EXPORT, "/api/candidate/export"]] as const)
        expect((await get(route, path, cookie)).status, `${path} ${cookie?.slice(0, 20)}`).toBe(401);
    expect(await rows()).toBe(before);
  });
  it("performance: a signed-in read costs one statement more than before, at most", async () => {
    const a = await signUpIn(candAuth, CAND, "candidate", answers);
    const [r, c] = await counted(() => get(PROFILE, "/api/candidate/profile", a.cookie));
    expect(r.status).toBe(200);
    console.log(`signed-in profile GET: ${c} statements`);
    expect(c).toBeLessThanOrEqual(PROFILE_STATEMENTS);
  });
});
