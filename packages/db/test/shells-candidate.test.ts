// Step 16 wave 1 (P1): the candidate site frame read (apps/candidate/lib/data.ts readSiteFrame) on the test database as app_candidate with the real candidate
// login: signed out, signed in, suspended, a made-up cookie, and the rules date from the real minimums route. Only Next's request context is stood in
// (next/headers gives the headers a test sets; server-only is empty); no network. Fake data only.
// Budget (measured 23 November 2026, see the printed line): the frame read is 0 statements for a visitor with the rules kept and 2 for a signed-in candidate
// (the session by token, the user by id); median under 15 ms.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));

const BUDGET = { visitorStatements: 0, signedInStatements: 2, medianMs: 15 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, AUTH: Handler, MINIMUMS: Handler;
let D: typeof import("../../../apps/candidate/lib/data");

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: MINIMUMS } = await import("../../../apps/candidate/app/api/minimums/route"));
  D = await import("../../../apps/candidate/lib/data");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
async function login() {
  const email = `fake.frame${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string };
}
const as = <T>(cookie: string | undefined, fn: () => Promise<T>) => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": "203.0.113.9" });
  return fn();
};
const frame = (cookie?: string) => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": "203.0.113.9" });
  return D.readSiteFrame();
};
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("P1: the candidate site frame read", () => {
  it("gives a visitor the signed-out frame with the standing line, whose date is the minimums route's rulesCheckedOn (read, never typed)", async () => {
    const m = await MINIMUMS(new Request(`${BASE}/api/minimums`, { headers: { "x-vercel-forwarded-for": "203.0.113.8" } }));
    const { rulesCheckedOn } = (await m.json()) as { rulesCheckedOn: string };
    const f = await frame();
    expect(f).toEqual({ signedIn: false, standingLine: `Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on ${rulesCheckedOn}.`, origin: BASE });
    const stored = (await su.query("select data->>'checkedOn' d from rules_version where kind = 'minimums' and effective_from <= current_date order by effective_from desc, id desc limit 1")).rows[0].d;
    expect(rulesCheckedOn).toBe(stored);
  });
  it("a signed-in candidate gets the signed-in frame", async () => {
    const { cookie } = await login();
    expect((await frame(cookie)).signedIn).toBe(true);
    expect(await as(cookie, () => D.readSignedIn())).toBe(true); // the reader a page calls (the home page hides its sign-up block)
    expect(await as(undefined, () => D.readSignedIn())).toBe(false);
  });
  it("a suspended or deleted candidate, a made-up cookie and another login's cookie get the signed-out frame, never an error", async () => {
    const a = await login();
    await su.query("update candidate_user set suspended_at = now() where id = $1", [a.id]);
    expect((await frame(a.cookie)).signedIn).toBe(false);
    const b = await login();
    await su.query("update candidate_user set deleted_at = now() where id = $1", [b.id]);
    expect((await frame(b.cookie)).signedIn).toBe(false);
    for (const cookie of ["candidate.session_token=not-a-real-token", "portal.session_token=abc; staff.session_token=def", "candidate.session_token=" + "x".repeat(5000)]) {
      const f = await frame(cookie);
      expect(f.signedIn, cookie.slice(0, 40)).toBe(false);
      expect(f.standingLine).toContain("Rules last checked on");
    }
  });
  it("stays within the statement and time budget", async () => {
    const { cookie } = await login();
    await frame(); await frame(cookie); // warm: the rules are kept
    const [, visitor] = await counted(() => frame());
    const [, signedIn] = await counted(() => frame(cookie));
    const t: number[] = [];
    for (let i = 0; i < 21; i++) { const s = performance.now(); await frame(cookie); t.push(performance.now() - s); }
    const median = t.sort((x, y) => x - y)[10]!;
    console.log(`P1 frame read: visitor ${visitor} statements, signed in ${signedIn}, median ${median.toFixed(1)} ms`);
    expect(visitor).toBeLessThanOrEqual(BUDGET.visitorStatements);
    expect(signedIn).toBeLessThanOrEqual(BUDGET.signedInStatements);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
