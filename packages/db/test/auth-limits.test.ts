// SEC-5: the limit per account on password sign-in, for the candidate, portal and staff pools, through each pool's real auth handler (createAuth)
// on the test database as the pool's own login. Fake people only; email goes to a fake sender, nothing calls the network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { createAuth, refuseEmail, SIGN_IN_LIMIT, signInLimitKey, type LoginPool, type SendEmail } from "../../auth/src";
import { seedStaff } from "../src/staff-seed-cli";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
const PASSWORD = "Fake-password-for-tests-1";
let db: TestDb, su: pg.Pool;
const sent: { pool: string; kind: string; to: string }[] = [];
const fakeSend: SendEmail = async (pool, kind, to) => void sent.push({ pool, kind, to });
const role = { candidate: "app_candidate", portal: "app_portal", staff: "app_admin" } as const;
type Auth = ReturnType<typeof createAuth>;
const make = (pool: LoginPool): Auth => createAuth(pool, { database: db.pool(role[pool]), baseURL: BASE, secret, sendEmail: pool === "staff" ? refuseEmail : fakeSend });

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
});
afterAll(async () => { await db.drop(); });

let ipn = 0;
const freshIp = () => `198.18.${Math.floor(++ipn / 250)}.${ipn % 250}`;
async function call(auth: Auth, pool: LoginPool, path: string, body: unknown, ip = freshIp()) {
  const t = performance.now();
  const res = await auth.handler(new Request(`${BASE}/api/auth/${pool}/${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip },
  }));
  const ms = performance.now() - t, text = await res.text();
  return { status: res.status, text, ms };
}
const signIn = (auth: Auth, pool: LoginPool, email: string, password: string) => call(auth, pool, "sign-in/email", { email, password });
let seq = 0;
/** An account with a password; confirmed unless asked otherwise. */
async function account(auth: Auth, pool: LoginPool, verified = true) {
  const email = `fake.limit.${pool}.${++seq}@example.test`;
  if (pool === "staff") {
    const c = await su.connect();
    try { await seedStaff(c, { email, name: "Fake Staff", roles: ["administrator"] }, PASSWORD); } finally { c.release(); }
    return email;
  }
  expect((await call(auth, pool, "sign-up/email", { email, password: PASSWORD, name: "Fake Person", ...(pool === "candidate" ? answers : portalAnswers) })).status).toBe(200);
  if (verified) await su.query(`update ${pool}_user set email_verified = true where email = $1`, [email]);
  return email;
}
const count = async (pool: LoginPool, email: string) => (await su.query(`select count from ${pool}_rate_limit where key = $1`, [signInLimitKey(secret, email)])).rows[0]?.count as number | undefined;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/** Counts the statements that touch the sign-in count. */
async function limitStatements<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) {
    const params = a[1] as unknown[] | undefined;
    if (Array.isArray(params) && params.some((p) => typeof p === "string" && p.startsWith("signin:"))) n++;
    return (q as (...x: unknown[]) => unknown).apply(this, a);
  } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}

describe("unit: the key", () => {
  it("is a keyed hash of the lower-cased address, apart from the email limit's keys", () => {
    const k = signInLimitKey(secret, "Fake.Person@Example.test");
    expect(k).toBe(signInLimitKey(secret, "fake.person@example.test"));
    expect(k).toMatch(/^signin:[0-9a-f]{64}$/);
    expect(k).not.toBe(signInLimitKey("another-secret-another-secret-12345", "fake.person@example.test"));
    expect(SIGN_IN_LIMIT).toEqual({ max: 10, windowMs: 3_600_000 });
  });
});

for (const pool of ["candidate", "portal", "staff"] as const) {
  describe(`${pool}: ${SIGN_IN_LIMIT.max} failed sign-ins an hour per account`, () => {
    it("10 wrong passwords from 10 addresses, then the right one is refused with the wrong-password reply, and accepted once the window is over", async () => {
      const auth = make(pool), email = await account(auth, pool);
      const wrong = [];
      for (let i = 0; i < SIGN_IN_LIMIT.max; i++) wrong.push(await signIn(auth, pool, i % 2 ? email.toUpperCase() : email, `Wrong-password-${i}`));
      expect(new Set(wrong.map((w) => `${w.status} ${w.text}`))).toEqual(new Set([`401 ${wrong[0]!.text}`]));
      const locked = await signIn(auth, pool, email, PASSWORD);
      expect([locked.status, locked.text]).toEqual([401, wrong[0]!.text]);
      expect(await count(pool, email)).toBe(SIGN_IN_LIMIT.max + 1);
      await su.query(`update ${pool}_rate_limit set last_request = $2 where key = $1`, [signInLimitKey(secret, email), Date.now() - 1]);
      expect((await signIn(auth, pool, email, PASSWORD)).status).toBe(200);
    });
    it("only failures count: a good sign-in takes its count back, and another account is not touched", async () => {
      const auth = make(pool), email = await account(auth, pool), other = await account(auth, pool);
      for (let i = 0; i < SIGN_IN_LIMIT.max - 1; i++) expect((await signIn(auth, pool, email, "Wrong-password-x")).status).toBe(401);
      expect((await signIn(auth, pool, email, PASSWORD)).status).toBe(200);
      expect(await count(pool, email)).toBe(SIGN_IN_LIMIT.max - 1);
      expect((await signIn(auth, pool, email, "Wrong-password-y")).status).toBe(401); // the 10th failure is still checked
      expect((await signIn(auth, pool, email, PASSWORD)).status).toBe(401); // the 11th attempt is refused
      expect((await signIn(auth, pool, other, PASSWORD)).status).toBe(200);
    });
    it("parallel guesses cannot slip past: 15 at once are all counted", async () => {
      const auth = make(pool), email = await account(auth, pool);
      const all = await Promise.all(Array.from({ length: 15 }, (_, i) => signIn(auth, pool, email, `Wrong-parallel-${i}`)));
      expect(all.every((r) => r.status === 401)).toBe(true);
      expect(await count(pool, email)).toBe(15);
      expect((await signIn(auth, pool, email, PASSWORD)).status).toBe(401);
    });
    it("security: an unknown address, a wrong password and a locked account give the same reply in about the same time", async () => {
      const auth = make(pool), known = await account(auth, pool), lockedEmail = await account(auth, pool);
      for (let i = 0; i < SIGN_IN_LIMIT.max; i++) await signIn(auth, pool, lockedEmail, "Wrong-password-z");
      const runs: Record<string, { status: number; text: string; ms: number }[]> = { unknown: [], wrong: [], locked: [] };
      for (let i = 0; i < 7; i++) {
        runs.unknown!.push(await signIn(auth, pool, `fake.nobody.${pool}.${++seq}@example.test`, "Wrong-password-u"));
        runs.wrong!.push(await signIn(auth, pool, known, "Wrong-password-w"));
        runs.locked!.push(await signIn(auth, pool, lockedEmail, PASSWORD));
        await su.query(`delete from ${pool}_rate_limit where key = $1`, [signInLimitKey(secret, known)]); // keep the known account under its limit
      }
      const replies = new Set(Object.values(runs).flat().map((r) => `${r.status} ${r.text}`));
      expect(replies.size, [...replies].join("\n")).toBe(1);
      const [u, w, l] = [median(runs.unknown!.map((r) => r.ms)), median(runs.wrong!.map((r) => r.ms)), median(runs.locked!.map((r) => r.ms))];
      console.log(`${pool} sign-in medians: unknown ${u.toFixed(1)} ms, wrong ${w.toFixed(1)} ms, locked ${l.toFixed(1)} ms`);
      // the password check dominates; a locked reply that skipped it would be about w faster
      expect(Math.abs(l - w), `locked ${l} wrong ${w}`).toBeLessThan(w / 2);
      expect(Math.abs(u - w), `unknown ${u} wrong ${w}`).toBeLessThan(w / 2);
    });
    it("performance: one statement on the count per failed sign-in, two per good one", async () => {
      const auth = make(pool), email = await account(auth, pool);
      const [bad, nBad] = await limitStatements(() => signIn(auth, pool, email, "Wrong-password-p"));
      const [good, nGood] = await limitStatements(() => signIn(auth, pool, email, PASSWORD));
      expect([bad.status, good.status, nBad, nGood]).toEqual([401, 200, 1, 2]);
    });
    it("hostile input: a long address is not counted, and no address is stored in the table", async () => {
      const auth = make(pool), before = (await su.query(`select count(*)::int n from ${pool}_rate_limit where key like 'signin:%'`)).rows[0].n;
      expect((await signIn(auth, pool, `${"a".repeat(300)}@example.test`, "Wrong-password-h")).status).toBeGreaterThanOrEqual(400);
      expect((await signIn(auth, pool, 42 as unknown as string, "x")).status).toBeGreaterThanOrEqual(400);
      expect((await su.query(`select count(*)::int n from ${pool}_rate_limit where key like 'signin:%'`)).rows[0].n).toBe(before);
      const keys = (await su.query(`select key from ${pool}_rate_limit`)).rows.map((r) => r.key).join("\n");
      expect(keys).not.toMatch(/@|example/);
    });
  });
}

describe("candidate and portal: an unconfirmed account does not show a right password while locked", () => {
  for (const pool of ["candidate", "portal"] as const) {
    it(pool, async () => {
      const auth = make(pool), email = await account(auth, pool, false);
      expect((await signIn(auth, pool, email, PASSWORD)).status).toBe(403); // before the lock: Better Auth's own "confirm your email"
      for (let i = 0; i < SIGN_IN_LIMIT.max; i++) await signIn(auth, pool, email, "Wrong-password-v");
      expect((await signIn(auth, pool, email, PASSWORD)).status).toBe(401);
    });
  }
});
