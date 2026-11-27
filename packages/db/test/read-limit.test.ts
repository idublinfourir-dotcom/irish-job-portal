// PERF-3: the read limit of the candidate pages, end to end on the test database as app_candidate. The real home loader (apps/candidate/app/_home/load.ts)
// and the real job reads go through the real lib/data.ts; only Next's request context is stood in: next/headers gives each fake request its headers,
// server-only is empty, and React's cache keeps one answer per fake request (AsyncLocalStorage), as React does per server render. Fake data only; no network.
// Measured 27 Nov 2026 (printed by the test): a visitor's home render was 17 statements, 12 of them rate upserts (audit PERF-3, live); now 6, one of
// them the rate count. Raise HOME_STATEMENTS only on purpose.
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

const HOME_STATEMENTS = 6;
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const request = new AsyncLocalStorage<{ headers: Headers; memo: Map<unknown, unknown> }>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => request.getStore()!.headers }));
vi.mock("react", async (real) => ({
  ...(await real<typeof import("react")>()),
  // React's cache for a Server Component: one answer per function and arguments, for one request. The gate takes no argument.
  cache: <A extends unknown[], R>(fn: (...a: A) => R) => {
    const id = Symbol("cached");
    return (...a: A): R => {
      const memo = request.getStore()!.memo, key = `${String(id.description)}${JSON.stringify(a)}`;
      const own = (memo.get(id) as Map<string, R> | undefined) ?? new Map<string, R>();
      memo.set(id, own);
      if (!own.has(key)) own.set(key, fn(...a));
      return own.get(key)!;
    };
  },
}));

const BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool;
let loadHome: typeof import("../../../apps/candidate/app/_home/load").loadHome, data: typeof import("../../../apps/candidate/lib/data");
let AUTH: (r: Request) => Promise<Response>;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ loadHome } = await import("../../../apps/candidate/app/_home/load"));
  data = await import("../../../apps/candidate/lib/data");
});
afterAll(async () => {
  (await import("../src")).getPool().end();
  await db.drop();
});

/** One page request: the headers it came with, and a fresh React cache. */
const page = <T>(h: Record<string, string>, fn: () => Promise<T>) => request.run({ headers: new Headers(h), memo: new Map() }, fn);
const ipKeys = (ip: string) => [`read:ip:${ip}:60000`, `read:ip:${ip}:3600000`];
const counts = async (keys: string[]) => (await su.query<{ key: string; count: number }>("select key, count from candidate_rate_limit where key = any($1)", [keys])).rows.reduce<Record<string, number>>((o, r) => ({ ...o, [r.key]: r.count }), {});
/** Statements sent and the most in flight at once (each pool client is one connection). */
async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; statements: string[]; peak: number }> {
  const q = pg.Client.prototype.query, statements: string[] = [];
  let live = 0, peak = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) {
    statements.push(String(typeof a[0] === "string" ? a[0] : (a[0] as { text?: string }).text));
    peak = Math.max(peak, ++live);
    const r = (q as (...x: unknown[]) => Promise<unknown>).apply(this, a);
    return Promise.resolve(r).finally(() => live--);
  } as typeof q;
  try { return { value: await fn(), statements, peak }; } finally { pg.Client.prototype.query = q; }
}
const rateStatements = (s: string[]) => s.filter((t) => t.includes("candidate_rate_limit"));

describe("PERF-3: a page counts once per request, in one statement", () => {
  it("a visitor's home render: 6 statements, 1 of them the count, both windows up by exactly 1", async () => {
    await page({ "x-vercel-forwarded-for": "198.18.0.1" }, () => loadHome()); // the rules are kept per instance after the first read
    const ip = "198.18.0.2";
    const { value: home, statements, peak } = await counted(() => page({ "x-vercel-forwarded-for": ip }, () => loadHome()));
    console.log(`home visitor render: ${statements.length} statements, ${rateStatements(statements).length} rate, at most ${peak} connections at once`);
    expect([home.jobs.ok, home.sectors.ok, home.minimums.ok, home.guides.ok, home.updates.ok, home.occupations.ok]).toEqual([true, true, true, true, true, true]);
    expect(rateStatements(statements)).toHaveLength(1);
    expect(statements.length).toBe(HOME_STATEMENTS);
    expect(await counts(ipKeys(ip))).toEqual({ [ipKeys(ip)[0]!]: 1, [ipKeys(ip)[1]!]: 1 });
  });

  it("reads with other queries in one request share the count; reads of no table are not counted", async () => {
    const ip = "198.18.0.3";
    const { statements } = await counted(() => page({ "x-vercel-forwarded-for": ip, rsc: "1" }, () => Promise.all([
      data.readJobs({ sort: "newest" }), data.readJobs({ sort: "salary", q: "fake" }), data.readJobs({ sort: "newest", junk: String(Math.random()) }), data.readUpdates(),
      data.readOccupations(), data.readRegistrationBodies(), data.readChecker({ occupationCode: "2231", annualPay: "70000", relevantDegree: "true" }),
    ])));
    expect(rateStatements(statements)).toHaveLength(1);
    expect(await counts(ipKeys(ip))).toEqual({ [ipKeys(ip)[0]!]: 1, [ipKeys(ip)[1]!]: 1 });
    const free = await counted(() => page({ "x-vercel-forwarded-for": "198.18.0.4" }, () => Promise.all([data.readOccupations(), data.readRegistrationBodies(), data.readChecker({ occupationCode: "2231", annualPay: "70000", relevantDegree: "true" })])));
    expect(free.statements).toEqual([]); // no session lookup, no count, the rules from memory
  });

  it("each request counts once: two requests of three reads each count 2", async () => {
    const ip = "198.18.0.5";
    for (let i = 0; i < 2; i++) await page({ "x-vercel-forwarded-for": ip }, () => Promise.all([data.readJobs(), data.readUpdates(), data.readGuides()]));
    expect(await counts(ipKeys(ip))).toEqual({ [ipKeys(ip)[0]!]: 2, [ipKeys(ip)[1]!]: 2 });
  });
});

describe("PERF-3: the limit still holds", () => {
  it("the 61st page view in a minute is refused, on every read of that page, with Retry-After", async () => {
    const ip = "198.18.0.6";
    await page({ "x-vercel-forwarded-for": ip }, () => data.readJobs());
    await su.query("update candidate_rate_limit set count = 60 where key = $1", [ipKeys(ip)[0]]);
    const home = await page({ "x-vercel-forwarded-for": ip }, () => loadHome());
    for (const s of [home.jobs, home.sectors, home.minimums, home.guides, home.updates]) expect(s).toMatchObject({ ok: false, status: 429, code: "TOO_MANY_REQUESTS" });
    expect(home.jobs.ok ? 0 : (home.jobs as { retryAfter?: number }).retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("two requests at once at count 59: exactly one is let through, and the count is 61", async () => {
    const ip = "198.18.0.7";
    await page({ "x-vercel-forwarded-for": ip }, () => data.readJobs());
    await su.query("update candidate_rate_limit set count = 59 where key = $1", [ipKeys(ip)[0]]);
    const both = await Promise.all([0, 1].map(() => page({ "x-vercel-forwarded-for": ip }, () => data.readJobs())));
    expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
    expect((await counts([ipKeys(ip)[0]!]))[ipKeys(ip)[0]!]).toBe(61);
  });

  it("a forged x-forwarded-for, a query string or the RSC header does not change the key", async () => {
    const ip = "198.18.0.8";
    for (const h of <Record<string, string>[]>[{ "x-forwarded-for": "10.9.9.9" }, { "x-forwarded-for": "198.18.0.99", "x-real-ip": "1.2.3.4" }, { rsc: "1", "next-router-prefetch": "1" }, {}])
      await page({ "x-vercel-forwarded-for": ip, ...h }, () => data.readJobs({ sort: "newest", n: String(Math.random()) }));
    expect(await counts(ipKeys(ip))).toEqual({ [ipKeys(ip)[0]!]: 4, [ipKeys(ip)[1]!]: 4 });
    expect((await su.query("select count(*)::int as n from candidate_rate_limit where key like '%10.9.9.9%' or key like '%198.18.0.99%' or key like '%1.2.3.4%'")).rows[0].n).toBe(0);
  });

  it("a signed-in candidate is counted per login, not per address, once per request", async () => {
    const email = `fake.limit${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
    const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "198.51.100.77" };
    expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
    await su.query("update candidate_user set email_verified = true where email = $1", [email]);
    const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
    const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const id = (await su.query("select id from candidate_user where email = $1", [email])).rows[0].id as string;
    const ip = "198.18.0.9";
    const { value: home, statements } = await counted(() => page({ cookie, "x-vercel-forwarded-for": ip }, () => loadHome()));
    expect(home.signedIn).toBe(true);
    expect(rateStatements(statements)).toHaveLength(1);
    expect(await counts([`read:candidate:${id}:60000`, ...ipKeys(ip)])).toEqual({ [`read:candidate:${id}:60000`]: 1 });
  });
});
