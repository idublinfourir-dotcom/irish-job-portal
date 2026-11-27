// SEC-5: the limit per account on password sign-in, for the candidate, portal and staff pools, and SEC-2: the daily budget of account emails, for the
// candidate and portal pools (staff send none), through each pool's real auth handler (createAuth) on the test database as the pool's own login.
// Fake people only; email goes to a fake sender that counts sends, nothing calls the network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { createAuth, dayBudgetKey, EMAIL_DAY_BUDGET, emailBudgetOn, refuseEmail, SIGN_IN_LIMIT, signInLimitKey, type LoginPool, type SendEmail } from "../../auth/src";
import { DAILY_CAP } from "../src/outbox-cli";
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
const tasks: Promise<unknown>[] = [];
// The budget is on here as on a deployed site (off by default in tests); the sign-in tests do not send enough to reach it.
const make = (pool: LoginPool, background = false): Auth =>
  createAuth(pool, { database: db.pool(role[pool]), baseURL: BASE, secret, sendEmail: pool === "staff" ? refuseEmail : fakeSend, emailBudget: true, ...(background ? { background: (t) => void tasks.push(t) } : {}) });

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
});
afterAll(async () => { await Promise.allSettled(tasks); await db.drop(); });

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

describe("SEC-2 unit: the daily email budget", () => {
  it("with the outbox's 200 stays under Brevo Free's 300 a day, verify and reset apart, keyed on the UTC day", () => {
    const apps = Object.values(EMAIL_DAY_BUDGET).flatMap((b) => Object.values(b)).reduce((a, b) => a + b, 0);
    expect(DAILY_CAP + apps).toBeLessThanOrEqual(300);
    expect(dayBudgetKey("verify", new Date("2026-11-27T23:59:59.999Z"))).toBe("email-day:verify:2026-11-27");
    expect(dayBudgetKey("verify", new Date("2026-11-28T00:00:00.000+01:00"))).toBe("email-day:verify:2026-11-27"); // the UTC day, not local
    expect(dayBudgetKey("reset", new Date("2026-11-28T00:00:00Z"))).toBe("email-day:reset:2026-11-28");
  });
  it("is on wherever the app is deployed, so a missing setting cannot turn it off; off on a developer machine and in tests", () => {
    expect([emailBudgetOn({ VERCEL: "1" }), emailBudgetOn({ VERCEL: "1", VERCEL_ENV: "preview" }), emailBudgetOn({ NODE_ENV: "production" })]).toEqual([true, true, true]);
    expect([emailBudgetOn({}), emailBudgetOn({ NODE_ENV: "development" }), emailBudgetOn({ NODE_ENV: "test" })]).toEqual([false, false, false]);
  });
});

for (const pool of ["candidate", "portal"] as const) {
  describe(`${pool}: SEC-2 the daily budget of account emails`, () => {
    const B = EMAIL_DAY_BUDGET[pool];
    const verifySent = () => sent.filter((m) => m.pool === pool && m.kind === "verify").length;
    const resetSent = () => sent.filter((m) => m.pool === pool && m.kind === "reset").length;
    it(`${B.verify + 1} sign-ups from many addresses send ${B.verify} verify emails, every reply the same; a reset after that still sends`, async () => {
      const auth = make(pool, true), errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const known = await account(make(pool), pool); // made before the flood, without the budget's count (no background: the count is the same)
        await su.query(`delete from ${pool}_rate_limit where key like 'email-day:%'`);
        const before = verifySent(), replies = new Set<string>();
        const last = `fake.flood.${pool}.last@example.test`;
        for (let i = 0; i <= B.verify; i++) {
          const email = i === B.verify ? last : `fake.flood.${pool}.${i}@example.test`;
          const r = await call(auth, pool, "sign-up/email", { email, password: PASSWORD, name: "Fake Flood", ...(pool === "candidate" ? answers : portalAnswers) });
          const j = JSON.parse(r.text) as { user?: object };
          replies.add(`${r.status} ${Object.keys(j).sort()} ${Object.keys(j.user ?? {}).sort()}`); // the same shape; the values are each person's own
        }
        expect(verifySent() - before, "each send was started before its reply").toBe(B.verify);
        await Promise.all(tasks);
        expect(replies.size, [...replies].join("\n")).toBe(1);
        expect([...replies][0]!.slice(0, 3)).toBe("200");
        expect(verifySent() - before).toBe(B.verify);
        expect(sent.some((m) => m.to === last)).toBe(false);
        expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(`[auth] ${pool} verify email not sent: today's budget of ${B.verify} is used`);
        expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain("@");
        // a resend for the address left out is counted too: still nothing
        expect((await call(auth, pool, "send-verification-email", { email: last })).status).toBe(200);
        await Promise.all(tasks);
        expect(sent.some((m) => m.to === last)).toBe(false);
        // resets keep their own budget
        const r0 = resetSent();
        expect((await call(auth, pool, "request-password-reset", { email: known, redirectTo: `${BASE}/reset` })).status).toBe(200);
        await Promise.all(tasks);
        expect(resetSent()).toBe(r0 + 1);
      } finally { errors.mockRestore(); }
    });
    it(`resets stop at ${B.reset} a day, with the same reply`, async () => {
      const auth = make(pool, true), errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const known = await account(make(pool), pool);
        await su.query(`insert into ${pool}_rate_limit(id, key, count, last_request) values ($1, $2, $3, $4) on conflict (key) do update set count = excluded.count, last_request = excluded.last_request`,
          [`t-reset-${pool}`, dayBudgetKey("reset", new Date()), B.reset - 1, Date.now() + 86_400_000]);
        const r0 = resetSent();
        const a = await call(auth, pool, "request-password-reset", { email: known, redirectTo: `${BASE}/reset` });
        const b = await call(auth, pool, "request-password-reset", { email: known, redirectTo: `${BASE}/reset` });
        await Promise.all(tasks);
        expect([a.status, a.text]).toEqual([b.status, b.text]);
        expect(resetSent()).toBe(r0 + 1);
      } finally { errors.mockRestore(); }
    });
    it("performance: one statement on the budget per email sent, none for an address that gets no email", async () => {
      const auth = make(pool);
      await su.query(`delete from ${pool}_rate_limit where key like 'email-day:%'`);
      const budgetStatements = async (fn: () => Promise<unknown>) => {
        const q = pg.Client.prototype.query;
        let n = 0;
        pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) {
          if ((a[1] as unknown[] | undefined)?.some?.((p) => typeof p === "string" && p.startsWith("email-day:"))) n++;
          return (q as (...x: unknown[]) => unknown).apply(this, a);
        } as typeof q;
        try { await fn(); return n; } finally { pg.Client.prototype.query = q; }
      };
      expect(await budgetStatements(() => call(auth, pool, "sign-up/email", { email: `fake.perf.${pool}.${++seq}@example.test`, password: PASSWORD, name: "Fake", ...(pool === "candidate" ? answers : portalAnswers) }))).toBe(1);
      expect(await budgetStatements(() => call(auth, pool, "request-password-reset", { email: `fake.nobody.${pool}.${++seq}@example.test`, redirectTo: `${BASE}/reset` }))).toBe(0);
    });
    it("security: past the per-address limit sign-up answers 429 (5 a minute from one client address)", async () => {
      const auth = make(pool), ip = freshIp(), got = [];
      for (let i = 0; i < 6; i++) got.push((await call(auth, pool, "sign-up/email", { email: `fake.ip.${pool}.${++seq}@example.test`, password: PASSWORD, name: "Fake", ...(pool === "candidate" ? answers : portalAnswers) }, ip)).status);
      expect(got).toEqual([200, 200, 200, 200, 200, 429]);
    });
  });
}

describe("staff: SEC-2 no budget rows (the staff pool sends no email)", () => {
  it("a reset request writes no budget count", async () => {
    const auth = make("staff"), email = await account(auth, "staff");
    expect((await call(auth, "staff", "request-password-reset", { email, redirectTo: `${BASE}/reset` })).status).toBeGreaterThanOrEqual(200);
    expect((await su.query("select count(*)::int n from staff_rate_limit where key like 'email-day:%'")).rows[0].n).toBe(0);
  });
});
