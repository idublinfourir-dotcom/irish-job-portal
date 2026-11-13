// Step 15 part 15c: email safety before real email is switched on (slice 2 review findings 4 and 5), for the candidate and portal
// pools, on the test database through each pool's real auth handler (createAuth from packages/auth). The email sender is a fake that
// takes 300 ms per send, like a slow outside service; nothing calls the network. Fake people only.
// Finding 3 (Google pre-hijack) is in candidate-google.test.ts, which has the fake Google; the deleted-account notice is in outbox.test.ts.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { createAuth, EMAIL_LIMIT, emailLimitKey, refuseEmail, type SendEmail } from "../../auth/src";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";

// Gap allowed between the reply for an address with an account and one without (the send takes 300 ms, so waiting for it shows).
const GAP_MS = 100, SEND_MS = 300;
// Statements measured on 13 November 2026 (counting every pg.Client.query call), two runs: a reset request for a known address 6, for an unknown
// one 7, a resend 4 (each includes the 1 statement of the per-address limit and the 2 of the per-IP limit). Raise only on purpose.
const BUDGET = { resetKnown: 6, resetUnknown: 7, resend: 4 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool;
const sent: { pool: string; kind: string; to: string; link: string }[] = [];
const tasks: Promise<unknown>[] = [];
const slow: SendEmail = async (pool, kind, to, link) => { await new Promise((r) => setTimeout(r, SEND_MS)); sent.push({ pool, kind, to, link }); };
type Pool2 = "candidate" | "portal";
const role = { candidate: "app_candidate", portal: "app_portal" } as const;
const make = (pool: Pool2, o: { sendEmail?: SendEmail; background?: boolean; database?: pg.Pool } = {}) =>
  createAuth(pool, { database: o.database ?? db.pool(role[pool]), baseURL: BASE, secret, sendEmail: o.sendEmail ?? slow, ...(o.background === false ? {} : { background: (t) => void tasks.push(t) }) });

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
});
afterAll(async () => {
  await Promise.allSettled(tasks);
  await db.drop();
});

let ipn = 10;
const freshIp = () => `192.0.2.${ipn++ % 250}`;
async function call(auth: { handler: (r: Request) => Promise<Response> }, pool: string, path: string, body: unknown, o: { ip?: string; origin?: string; cookie?: string; raw?: string } = {}) {
  const t = performance.now();
  const res = await auth.handler(new Request(`${BASE}/api/auth/${pool}/${path}`, {
    method: "POST", body: o.raw ?? JSON.stringify(body),
    headers: { "content-type": "application/json", origin: o.origin ?? BASE, "x-vercel-forwarded-for": o.ip ?? freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}) },
  }));
  const ms = performance.now() - t, text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, ms };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
let seq = 0;
const signUpBody = (pool: Pool2, email: string) => ({ email, password: "Fake-password-for-tests-1", name: "Fake Person", ...(pool === "candidate" ? answers : portalAnswers) });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/** A login with an account (sign-up done and its email sent). */
async function known(auth: ReturnType<typeof make>, pool: Pool2) {
  const email = `fake.known.${pool}.${seq++}@example.test`;
  expect((await call(auth, pool, "sign-up/email", signUpBody(pool, email))).status).toBe(200);
  await Promise.all(tasks);
  return email;
}
const fresh = (pool: Pool2) => `fake.new.${pool}.${seq++}@example.test`;

for (const pool of ["candidate", "portal"] as const) {
  describe(`${pool}: sign-up and reset do not wait for the email send (review finding 4)`, () => {
    it("sign-up: a new and an existing address are answered within the gap of each other, and the email still goes", async () => {
      const auth = make(pool), news: number[] = [], olds: number[] = [];
      for (let i = 0; i < 3; i++) {
        const old = await known(auth, pool), neu = fresh(pool);
        const a = await call(auth, pool, "sign-up/email", signUpBody(pool, neu)), b = await call(auth, pool, "sign-up/email", signUpBody(pool, old));
        expect([a.status, b.status]).toEqual([200, 200]);
        news.push(a.ms); olds.push(b.ms);
        await Promise.all(tasks);
        expect(sent.filter((m) => m.to === neu && m.kind === "verify")).toHaveLength(1);
      }
      expect(median(news), `new ${news} existing ${olds}`).toBeLessThan(SEND_MS);
      expect(Math.abs(median(news) - median(olds)), `new ${news} existing ${olds}`).toBeLessThan(GAP_MS);
    });
    it("reset: an address with an account and one without are answered within the gap, the same reply, and the email still goes", async () => {
      const auth = make(pool), hit: number[] = [], miss: number[] = [];
      for (let i = 0; i < 3; i++) {
        const old = await known(auth, pool), none = fresh(pool);
        const a = await call(auth, pool, "request-password-reset", { email: old, redirectTo: `${BASE}/reset` });
        const b = await call(auth, pool, "request-password-reset", { email: none, redirectTo: `${BASE}/reset` });
        expect([a.status, a.json]).toEqual([b.status, b.json]);
        hit.push(a.ms); miss.push(b.ms);
        await Promise.all(tasks);
        expect(sent.filter((m) => m.to === old && m.kind === "reset")).toHaveLength(1);
        expect(sent.some((m) => m.to === none)).toBe(false);
      }
      expect(median(hit), `known ${hit} unknown ${miss}`).toBeLessThan(SEND_MS);
      expect(Math.abs(median(hit) - median(miss)), `known ${hit} unknown ${miss}`).toBeLessThan(GAP_MS);
    });
    it("control: without the background handler the reply waits for the send, so the test above can see the leak", async () => {
      const auth = make(pool, { background: false }), old = await known(make(pool), pool);
      const a = await call(auth, pool, "request-password-reset", { email: old, redirectTo: `${BASE}/reset` });
      const b = await call(auth, pool, "request-password-reset", { email: fresh(pool), redirectTo: `${BASE}/reset` });
      expect(a.ms - b.ms).toBeGreaterThan(SEND_MS - 50);
    });
    it("a send that fails after the reply is logged with console.error (no address in the line), and the reply is unchanged", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const auth = make(pool, { sendEmail: async () => { throw new Error("Brevo send failed: HTTP 500"); } });
        const email = fresh(pool);
        expect((await call(auth, pool, "sign-up/email", signUpBody(pool, email))).status).toBe(200);
        await Promise.all(tasks);
        const lines = errors.mock.calls.map((c) => c.join(" "));
        expect(lines.some((l) => l.includes(`[auth] ${pool} verify email not sent: Brevo send failed: HTTP 500`))).toBe(true);
        expect(lines.join("\n")).not.toContain(email);
      } finally { errors.mockRestore(); }
    });
  });

  describe(`${pool}: a limit per email address on reset and resend (review finding 5)`, () => {
    for (const path of ["request-password-reset", "send-verification-email"]) {
      it(`${path}: the fourth request for one address in the hour is refused, from any IP, while another address still passes`, async () => {
        const auth = make(pool), email = fresh(pool), body = (e: string) => ({ email: e, ...(path === "request-password-reset" ? { redirectTo: `${BASE}/reset` } : {}) });
        const got = [];
        for (let i = 0; i < EMAIL_LIMIT.max + 1; i++) got.push((await call(auth, pool, path, body(i % 2 ? email.toUpperCase() : email))).status);
        expect(got).toEqual([200, 200, 200, 429]);
        expect((await call(auth, pool, path, body(fresh(pool)))).status).toBe(200);
      });
    }
    it("the limit does not show whether the address has an account: the same statuses and replies for both", async () => {
      const auth = make(pool), old = await known(auth, pool), none = fresh(pool);
      const run = async (e: string) => { const r = []; for (let i = 0; i < 4; i++) { const x = await call(auth, pool, "request-password-reset", { email: e, redirectTo: `${BASE}/reset` }); r.push([x.status, x.json]); } return r; };
      const a = await run(old), b = await run(none);
      expect(a).toEqual(b);
      expect(a.map((x) => x[0])).toEqual([200, 200, 200, 429]);
      await Promise.all(tasks);
      expect(sent.filter((m) => m.to === old && m.kind === "reset")).toHaveLength(3);
    });
    it("the table keeps a keyed hash, never the address, and the count starts again when the hour is over", async () => {
      const auth = make(pool), email = fresh(pool);
      for (let i = 0; i < 4; i++) await call(auth, pool, "request-password-reset", { email, redirectTo: `${BASE}/reset` });
      const key = emailLimitKey(secret, "/request-password-reset", email);
      const rows = (await su.query(`select key, count from ${pool}_rate_limit where key like 'email:%'`)).rows;
      expect(rows.map((r) => r.key).join("\n")).not.toMatch(/@|example/);
      expect(rows.find((r) => r.key === key)?.count).toBe(4);
      await su.query(`update ${pool}_rate_limit set last_request = $2 where key = $1`, [key, Date.now() - 1]);
      expect((await call(auth, pool, "request-password-reset", { email, redirectTo: `${BASE}/reset` })).status).toBe(200);
      expect((await su.query(`select count from ${pool}_rate_limit where key = $1`, [key])).rows[0].count).toBe(1);
    });
    it("statements stay inside the budget", async () => {
      const auth = make(pool), old = await known(auth, pool);
      const [, k] = await counted(() => call(auth, pool, "request-password-reset", { email: old, redirectTo: `${BASE}/reset` }));
      const [, u] = await counted(() => call(auth, pool, "request-password-reset", { email: fresh(pool), redirectTo: `${BASE}/reset` }));
      const [, r] = await counted(() => call(auth, pool, "send-verification-email", { email: fresh(pool) }));
      expect(k, `known reset ${k}`).toBeLessThanOrEqual(BUDGET.resetKnown);
      expect(u, `unknown reset ${u}`).toBeLessThanOrEqual(BUDGET.resetUnknown);
      expect(r, `resend ${r}`).toBeLessThanOrEqual(BUDGET.resend);
    });
  });

  describe(`${pool}: hostile input on the changed routes`, () => {
    it("a big body, unknown fields, control or format characters in the email, and a bad Origin send nothing to anyone", async () => {
      const auth = make(pool), before = sent.length;
      const big = await call(auth, pool, "request-password-reset", { email: `${"a".repeat(1_000_000)}@example.test` });
      expect(big.status).toBeGreaterThanOrEqual(400);
      for (const email of ["fake\u0000nul@example.test", "fake\r\nbcc@example.test", "fake‮rlo@example.test", "fake​zw@example.test", "not-an-email", ""]) {
        for (const path of ["request-password-reset", "send-verification-email"])
          expect((await call(auth, pool, path, { email })).status, `${path} ${JSON.stringify(email)}`).toBe(400);
      }
      for (const path of ["request-password-reset", "send-verification-email"])
        expect((await call(auth, pool, path, null, { raw: "{not json" })).status).toBeGreaterThanOrEqual(400);
      // unknown fields are dropped: the reply is the plain one and nothing is sent to the made-up address
      const extra = await call(auth, pool, "request-password-reset", { email: fresh(pool), redirectTo: `${BASE}/reset`, role: "admin", emailVerified: true, __proto__: { x: 1 } });
      expect(extra.status).toBe(200);
      // a foreign Origin with a cookie, and a foreign redirect address, are refused before any lookup
      const evil = "https://evil.example.test";
      expect((await call(auth, pool, "request-password-reset", { email: fresh(pool) }, { origin: evil, cookie: `${pool}.session_token=x` })).status).toBe(403);
      expect((await call(auth, pool, "request-password-reset", { email: fresh(pool), redirectTo: `${evil}/steal` })).status).toBe(403);
      await Promise.all(tasks);
      expect(sent.length).toBe(before);
    });
    it("the wrong database login is refused: the limit cannot be written through another pool's login", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const other = make(pool, { database: db.pool(pool === "candidate" ? "app_portal" : "app_candidate") });
        await expect(call(other, pool, "request-password-reset", { email: fresh(pool), redirectTo: `${BASE}/reset` })).rejects.toThrow(/permission denied for table/);
      } finally { errors.mockRestore(); }
    });
  });
}

describe("the staff pool keeps its behaviour", () => {
  it("has no per-address limit and still refuses to send email", async () => {
    const staff = createAuth("staff", { database: db.pool("app_admin"), baseURL: BASE, secret, sendEmail: refuseEmail });
    for (let i = 0; i < 4; i++) expect((await call(staff, "staff", "request-password-reset", { email: "fake.staff.none@example.test", redirectTo: `${BASE}/reset` })).status).toBe(200);
    expect((await su.query("select count(*)::int n from staff_rate_limit where key like 'email:%'")).rows[0].n).toBe(0);
    expect(staff.options.advanced?.backgroundTasks).toBeUndefined();
  });
});

describe("the apps pass Next's after() as the background handler", () => {
  it("candidate and portal auth have backgroundTasks set", async () => {
    Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
    const { candidateAuth } = await import("../../../apps/candidate/lib/candidate");
    const { portalAuth } = await import("../../../apps/portal/lib/portal");
    expect(typeof candidateAuth().options.advanced?.backgroundTasks?.handler).toBe("function");
    expect(typeof portalAuth().options.advanced?.backgroundTasks?.handler).toBe("function");
    const { getPool } = await import("../src");
    await getPool().end();
  });
});
