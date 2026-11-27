// Audit of 27 Nov 2026, wave B (auth): SEC-9 (reset tokens stored hashed), SEC-10 (/update-user), PERF-4 (no schema read at start, the same check
// here in CI instead) and PERF-6 (one session read per request). The real createAuth on the real test database as app_candidate, app_portal and
// app_admin. Fake people only, no network.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requirePortal, requireStaff, sessionOnce, setSessionScope, staffSession, PortalRefused, StaffRefused, type LoginPool } from "../../auth/src";
import { answers, mail, makeAuth, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { seedStaff } from "../src/staff-seed-cli";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const ROLE: Record<LoginPool, string> = { candidate: "app_candidate", portal: "app_portal", staff: "app_admin" };
const BASE = "http://localhost:3000";
const PW = "Fake-password-123456";
let db: TestDb, su: pg.Pool;
const auths = {} as Record<LoginPool, ReturnType<typeof makeAuth>>;
let ipn = 10;

async function call(pool: LoginPool, path: string, body: unknown, cookie?: string) {
  const res = await auths[pool].handler(new Request(`${BASE}/api/auth/${pool}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${ipn++}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") };
}
/** A verified candidate or portal login, signed in. */
async function member(pool: "candidate" | "portal", tag: string) {
  const email = `${pool}.${tag}@example.test`;
  const up = await call(pool, "sign-up/email", { ...(pool === "candidate" ? answers : portalAnswers), email, password: PW, name: `Fake ${tag}` });
  expect(up.status, JSON.stringify(up.json)).toBe(200);
  await su.query(`update ${pool}_user set email_verified = true where email = $1`, [email]);
  const s = await call(pool, "sign-in/email", { email, password: PW });
  expect(s.status).toBe(200);
  return { email, cookie: s.cookie, id: (await su.query(`select id from ${pool}_user where email = $1`, [email])).rows[0].id as string };
}
async function staffMember(tag: string) {
  const email = `staff.${tag}@example.test`;
  const c = await su.connect();
  let id: string;
  try { id = await seedStaff(c, { email, name: `Fake ${tag}`, roles: ["content_editor"] }, PW); } finally { c.release(); }
  const s = await call("staff", "sign-in/email", { email, password: PW });
  expect(s.status).toBe(200);
  return { email, cookie: s.cookie, id };
}
/** A pool whose every statement is counted (n), and its own auth instance: a fresh function instance. */
function countingAuth(pool: LoginPool) {
  const p = new pg.Pool({ connectionString: urlFor(db.name, ROLE[pool]), max: 2 });
  const seen: string[] = [];
  p.on("connect", (c) => { const q = c.query.bind(c) as (...a: unknown[]) => unknown; (c as unknown as { query: unknown }).query = (...a: unknown[]) => { seen.push(String(typeof a[0] === "string" ? a[0] : (a[0] as { text?: string })?.text)); return q(...a); }; });
  return { auth: makeAuth(pool, p), seen, end: () => p.end() };
}
const H = (cookie: string) => new Headers({ cookie });

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  for (const n of ["candidate", "portal", "staff"] as const) auths[n] = makeAuth(n, db.pool(ROLE[n] as never));
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
});
afterAll(async () => { setSessionScope(() => undefined); await db.drop(); });

describe("PERF-4: the schema check runs here, not on each new instance", () => {
  for (const n of ["candidate", "portal", "staff"] as const)
    it(`${n}: createAuth turns the runtime check off, and the explicit check passes on the migrated database as ${ROLE[n]}`, async () => {
      const ctx = await auths[n].$context;
      expect(ctx.options.advanced?.database?.validateSchema).toBe(false);
      expect(ctx.checkSchema).toBeUndefined(); // no request waits for it
      expect(typeof ctx.explicitSchemaCheck).toBe("function"); // still there, so this check is not vacuous
      await ctx.explicitSchemaCheck!();
    });
  it("the explicit check fails when a Better Auth column is missing (its own database copy)", async () => {
    const other = await createTestDb();
    try {
      await other.query("postgres", "alter table candidate_session drop column user_agent");
      const ctx = await makeAuth("candidate", other.pool("app_candidate")).$context;
      await expect(ctx.explicitSchemaCheck!()).rejects.toThrow(/user_agent/);
    } finally { await other.drop(); }
  });
  it("a fresh instance's first getSession reads no catalog (pg_attribute, information_schema) and sends 2 statements", async () => {
    const m = await member("candidate", "cold");
    const c = countingAuth("candidate");
    try {
      const s = await c.auth.api.getSession({ headers: H(m.cookie) });
      expect(s?.user.email).toBe(m.email);
      expect(c.seen.filter((q) => /pg_catalog|pg_attribute|information_schema/i.test(q))).toEqual([]);
      expect(c.seen.length).toBeLessThanOrEqual(2);
    } finally { await c.end(); }
  });
  it("sign-in, sign-out and a suspended login still behave", async () => {
    const m = await member("candidate", "susp");
    expect((await call("candidate", "get-session", undefined, m.cookie)).json?.user).toBeTruthy();
    await su.query("update candidate_user set suspended_at = now() where id = $1", [m.id]);
    expect((await call("candidate", "sign-in/email", { email: m.email, password: PW })).status).toBe(403);
    const out = await call("candidate", "sign-out", {}, m.cookie);
    expect(out.status).toBe(200);
    expect((await call("candidate", "get-session", undefined, m.cookie)).json).toBeNull();
  });
});

describe("SEC-9: verification tokens are stored as a hash", () => {
  const hash = (id: string) => createHash("sha256").update(id).digest("base64url");
  for (const n of ["candidate", "portal", "staff"] as const)
    it(`${n}: a reset request stores the token's hash, not the token`, async () => {
      const m = n === "staff" ? await staffMember("reset") : await member(n, "reset");
      mail.length = 0;
      expect((await call(n, "request-password-reset", { email: m.email, redirectTo: "/reset" })).status).toBe(200);
      const token = new URL(mail.at(-1)!.url).pathname.split("/").at(-1)!;
      const rows = (await su.query(`select identifier from ${n}_verification where value = $1`, [m.id])).rows.map((r) => r.identifier);
      expect(rows).toEqual([hash(`reset-password:${token}`)]);
      expect(rows.join()).not.toContain(token);
      expect((await call(n, "reset-password", { token, newPassword: "Fake-new-password-1" })).status).toBe(200);
      expect((await call(n, "reset-password", { token, newPassword: "Fake-new-password-2" })).status).toBe(400); // used once
    });
  it("a link sent before the deploy (its token stored plain) still works once, then is refused", async () => {
    const m = await member("portal", "old-link");
    const token = "fakeOldPlainToken0000000000000001";
    await su.query("insert into portal_verification(id, identifier, value, expires_at, created_at, updated_at) values ($1, $2, $3, now() + interval '1 hour', now(), now())", ["v-old-link", `reset-password:${token}`, m.id]);
    expect((await call("portal", "reset-password", { token, newPassword: "Fake-new-password-3" })).status).toBe(200);
    expect((await call("portal", "reset-password", { token, newPassword: "Fake-new-password-4" })).status).toBe(400);
    expect((await call("portal", "sign-in/email", { email: m.email, password: "Fake-new-password-3" })).status).toBe(200);
  });
  it("hostile tokens are refused and change nothing", async () => {
    for (const token of ["", "x'; drop table portal_verification;--", "%", "reset-password:", "a".repeat(5000)])
      expect((await call("portal", "reset-password", { token, newPassword: "Fake-new-password-5" })).status, token.slice(0, 20)).toBeGreaterThanOrEqual(400);
    expect((await su.query("select to_regclass('portal_verification') is not null ok")).rows[0].ok).toBe(true);
  });
});

describe("SEC-10: /update-user", () => {
  it("staff: the route does not exist (also with a trailing slash), and the name is unchanged", async () => {
    const s = await staffMember("rename");
    for (const path of ["update-user", "update-user/"]) {
      const r = await call("staff", path, { name: "Fake Administrator" }, s.cookie);
      expect(r.status, path).toBe(404);
    }
    expect((await su.query("select name from staff_user where id = $1", [s.id])).rows[0].name).toBe("Fake rename");
  });
  for (const n of ["candidate", "portal"] as const)
    it(`${n}: the name rule holds and no image is taken; a good name still saves`, async () => {
      const m = await member(n, "rename");
      for (const bad of [{ name: "" }, { name: "   " }, { name: "x".repeat(101) }, { name: 42 }, { name: ["a"] }, { image: "https://evil.example/x.png" }, { image: null }, { name: "Ok", image: "x" }]) {
        const r = await call(n, "update-user", bad, m.cookie);
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
      const row = async () => (await su.query(`select name, image from ${n}_user where id = $1`, [m.id])).rows[0];
      expect(await row()).toEqual({ name: "Fake rename", image: null });
      expect((await call(n, "update-user", { name: "Fake Renamed" }, m.cookie)).status).toBe(200);
      expect((await row()).name).toBe("Fake Renamed");
      expect((await call(n, "update-user", { name: "Fake x" })).status).toBe(401); // no session
    });
});

describe("PERF-6: one session read per request", () => {
  const als = new AsyncLocalStorage<NonNullable<ReturnType<Parameters<typeof setSessionScope>[0]>>>();
  beforeAll(() => setSessionScope(() => als.getStore()));
  const request = <T>(fn: () => Promise<T>) => als.run(new Map(), fn);
  // a page render that checks the login as often as the signed-in candidate home does (8 lookups, audit PERF-6)
  const READS = 8;

  it("candidate: 8 lookups in one request send 2 session statements, not 16; without a request scope each sends its own", async () => {
    const m = await member("candidate", "memo");
    const c = countingAuth("candidate");
    try {
      const each = () => Promise.all(Array.from({ length: READS }, () => sessionOnce(c.auth, H(m.cookie))));
      await each(); // outside a request: no memo (route handlers, CLIs)
      const before = c.seen.length;
      c.seen.length = 0;
      const got = await request(each);
      expect(got.every((s) => s?.user.id === m.id)).toBe(true);
      expect([before, c.seen.length]).toEqual([2 * READS, 2]);
    } finally { await c.end(); }
  });
  it("staff: the sidebar and the page's reads share one read; a fresh check is still judged on each call", async () => {
    const s = await staffMember("memo");
    const c = countingAuth("staff");
    try {
      await request(async () => {
        for (let i = 0; i < READS; i++) expect(await requireStaff(c.auth, H(s.cookie))).toBe(s.id);
        expect(c.seen.length).toBeLessThanOrEqual(3); // session, user, and at most one refresh of the session row (updateAge)
        await su.query("update staff_session set created_at = now() - interval '11 minutes' where user_id = $1", [s.id]);
        expect((await staffSession(c.auth, H(s.cookie))).fresh).toBe(true); // the memo is this request's own reading
      });
      await request(async () => {
        await expect(requireStaff(c.auth, H(s.cookie), true)).rejects.toThrow("reauth_required"); // next request: the stale session is refused
        expect(await requireStaff(c.auth, H(s.cookie))).toBe(s.id);
      });
      await su.query("update staff_user set status = 'disabled' where id = $1", [s.id]);
      await request(() => expect(requireStaff(c.auth, H(s.cookie))).rejects.toBeInstanceOf(StaffRefused)); // disabled: refused on the next request
    } finally { await c.end(); }
  });
  it("portal: a blocked login is refused on the next request", async () => {
    const m = await member("portal", "memo");
    const c = countingAuth("portal");
    try {
      await request(async () => {
        for (let i = 0; i < READS; i++) expect((await requirePortal(c.auth, H(m.cookie))).userId).toBe(m.id);
        expect(c.seen.length).toBe(2 + READS); // 2 session statements once, then the membership read on each call
      });
      await su.query("update portal_user set status = 'blocked' where id = $1", [m.id]);
      await request(() => expect(requirePortal(c.auth, H(m.cookie))).rejects.toBeInstanceOf(PortalRefused));
    } finally { await c.end(); }
  });
  it("two requests at once with different cookies never share an entry; a forged cookie in one gets no session", async () => {
    const [a, b] = [await member("candidate", "par-a"), await member("candidate", "par-b")];
    const c = countingAuth("candidate");
    try {
      const run = (cookie: string) => request(() => Promise.all(Array.from({ length: READS }, () => sessionOnce(c.auth, H(cookie)))));
      const [ra, rb, rx] = await Promise.all([run(a.cookie), run(b.cookie), run(a.cookie.replace(/=([^.;]*)/, "=forged"))]);
      expect(ra.map((s) => s?.user.id)).toEqual(Array(READS).fill(a.id));
      expect(rb.map((s) => s?.user.id)).toEqual(Array(READS).fill(b.id));
      expect(rx.every((s) => s === null)).toBe(true);
      // one request with both cookies (cannot happen in a browser, but the key must still tell them apart)
      const both = await request(() => Promise.all([sessionOnce(c.auth, H(a.cookie)), sessionOnce(c.auth, H(b.cookie))]));
      expect(both.map((s) => s?.user.id)).toEqual([a.id, b.id]);
    } finally { await c.end(); }
  });
});
