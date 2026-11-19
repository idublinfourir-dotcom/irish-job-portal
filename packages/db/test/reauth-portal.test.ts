// C4 (#270) on the portal, end to end on the test database through the real auth route as app_portal: the email change needs a fresh session,
// keeps the domain, and takes effect only after the old address confirms and the new one is verified; "sign out everywhere" ends every session at
// once. The delete, pay-floor sign and appeal checks are in portal-account, pay-floors-portal and status-route. Fake sender only; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

// Measured on 19 November 2026 (two runs): change-email 7 statements, 5.2 to 5.4 ms; revoke 6, 2.4 ms (medians of 9 warm calls). Raise only on purpose.
const BUDGET = { changeEmail: 7, revoke: 6, changeEmailMs: 25, revokeMs: 20 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: { GET: Handler; POST: Handler }, STATUS: { GET: Handler };
let mail: () => { kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number | string, user: string | null, o?: object): Promise<number> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  AUTH = await import("../../../apps/portal/app/api/auth/portal/[...all]/route");
  STATUS = await import("../../../apps/portal/app/api/portal/status/route");
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const ip = () => `10.12.${Math.floor(n / 250)}.${n++ % 250}`;
const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function auth(path: string, body: unknown, o: { cookie?: string; origin?: string } = {}) {
  const res = await AUTH.POST(new Request(`${BASE}/api/auth/portal/${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: o.origin ?? BASE, "x-vercel-forwarded-for": ip(), ...(o.cookie ? { cookie: o.cookie } : {}) } }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const click = (link: string) => AUTH.GET(new Request(link, { headers: { "x-vercel-forwarded-for": ip() }, redirect: "manual" }));
async function login(role?: string) {
  const email = `fake.p4.${++n}@widgets.example.test`, password = "Fake-password-12345";
  expect((await auth("sign-up/email", { email, password, name: "Fake", ...portalAnswers })).status).toBe(200);
  await su.query("update portal_user set email_verified = true where email = $1", [email]);
  const signIn = async () => {
    const r = await AUTH.POST(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", body: JSON.stringify({ email, password }), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip() } }));
    expect(r.status).toBe(200);
    return cookieOf(r);
  };
  const cookie = await signIn();
  const id = (await su.query("select id from portal_user where email = $1", [email])).rows[0].id as string;
  if (role) await F.member(await F.org({ status: "verified" }), id, { role, signer: role === "account_owner" });
  return { email, cookie, id, signIn };
}
const age = (id: string) => su.query("update portal_session set created_at = now() - interval '11 minutes' where user_id = $1", [id]);
const emailOf = async (id: string) => (await su.query("select email from portal_user where id = $1", [id])).rows[0].email as string;
const status = async (cookie: string) => (await STATUS.GET(new Request(`${BASE}/api/portal/status`, { headers: { cookie } }))).status;
const sent = (to: string, kind: string) => mail().filter((m) => m.to === to && m.kind === kind);
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
const ROLES = ["account_owner", "poster", "recruiter", "viewer", undefined]; // undefined: a login with no company yet

describe("email change", () => {
  for (const role of ROLES)
    it(`${role ?? "no company"}: stale is REAUTH_REQUIRED; fresh moves the address only after both links`, async () => {
      const a = await login(role), to = `fake.p4.new${n}@widgets.example.test`;
      await age(a.id);
      expect(await auth("change-email", { newEmail: to }, { cookie: a.cookie })).toMatchObject({ status: 403, json: { code: "REAUTH_REQUIRED" } });
      expect(sent(a.email, "change-email")).toEqual([]);
      const fresh = await a.signIn();
      expect((await auth("change-email", { newEmail: to }, { cookie: fresh })).status).toBe(200);
      expect(await emailOf(a.id)).toBe(a.email);
      await click(sent(a.email, "change-email")[0]!.link);
      expect(await emailOf(a.id)).toBe(a.email);
      await click(sent(to, "new-email")[0]!.link);
      expect(await emailOf(a.id)).toBe(to);
    });
  it("refuses a new address on another domain (the company tie and domain bans were checked on this one), and nothing is sent", async () => {
    const a = await login("account_owner"), before = mail().length;
    for (const newEmail of [`fake.p4.x${n}@gmail.example.test`, `fake.p4.y${n}@WIDGETS.example.test.evil`, `fake@x.widgets.example.test`])
      expect(await auth("change-email", { newEmail }, { cookie: a.cookie }), newEmail).toMatchObject({ status: 400, json: { code: "DOMAIN_CHANGE_REFUSED" } });
    expect(mail().length).toBe(before);
    expect((await auth("change-email", { newEmail: `Fake.P4.Upper${n}@Widgets.Example.Test` }, { cookie: a.cookie })).status).toBe(200); // the domain's case does not matter
  });
  it("hostile input: signed out, a junk cookie, a foreign Origin, a wrong type, an overlong address", async () => {
    const a = await login("viewer");
    expect((await auth("change-email", { newEmail: `fake.p4.s${n}@widgets.example.test` })).status).toBe(401);
    expect((await auth("change-email", { newEmail: `fake.p4.s${n}@widgets.example.test` }, { cookie: "portal.session_token=junk.junk" })).status).toBe(401);
    expect((await auth("change-email", { newEmail: `fake.p4.s${n}@widgets.example.test` }, { cookie: a.cookie, origin: "https://evil.example" })).status).toBe(403);
    for (const newEmail of [7, [], `${"x".repeat(250)}@widgets.example.test`]) expect((await auth("change-email", { newEmail }, { cookie: a.cookie })).status).toBe(400);
    expect(await emailOf(a.id)).toBe(a.email);
  });
  it(`a request costs at most ${BUDGET.changeEmail} statements and ${BUDGET.changeEmailMs} ms median`, async () => {
    const a = await login("recruiter");
    const [r, statements] = await counted(() => auth("change-email", { newEmail: `fake.p4.b${n}@widgets.example.test` }, { cookie: a.cookie }));
    expect(r.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET.changeEmail);
    await su.query("delete from portal_rate_limit");
    let i = 0;
    expect(await median(() => auth("change-email", { newEmail: `fake.p4.m${i++}.${n}@widgets.example.test` }, { cookie: a.cookie }))).toBeLessThan(BUDGET.changeEmailMs);
  });
});

describe("callbackURL on verify-email (review of 07f9a8c: an open redirect)", () => {
  const OFFSITE = ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "/\t/evil.example", "/\n/x", "/x\\y", "https:evil.example", "/%2F%2Fevil.example", "/%5c%5cevil.example"];
  const verify = (token: string, cb: string, raw = false) => click(`${BASE}/api/auth/portal/verify-email?token=${token}&callbackURL=${raw ? cb : encodeURIComponent(cb)}`);
  it("Better Auth itself refuses an off-site callbackURL on a plain sign-up link (403 INVALID_CALLBACK_URL, no Location, not confirmed)", async () => {
    const email = `fake.p4.cb${++n}@widgets.example.test`;
    expect((await auth("sign-up/email", { email, password: "Fake-password-12345", name: "Fake", ...portalAnswers })).status).toBe(200);
    const token = new URL(sent(email, "verify")[0]!.link).searchParams.get("token")!;
    for (const [cb, raw] of [...OFFSITE.map((x) => [x, false] as const), ["/%09/evil.example", true] as const]) {
      const res = await verify(token, cb, raw);
      expect([res.status, res.headers.get("location"), (await res.json()).code], cb).toEqual([403, null, "INVALID_CALLBACK_URL"]);
    }
    expect((await su.query("select email_verified from portal_user where email = $1", [email])).rows[0].email_verified).toBe(false);
  });
  it("our EMAIL_TAKEN answer redirects only to a strict own-site path; anything else is a plain 409 with no Location", async () => {
    const a = await login("viewer"), to = `fake.p4.taken${n}@widgets.example.test`;
    expect((await auth("change-email", { newEmail: to, callbackURL: "/account" }, { cookie: a.cookie })).status).toBe(200);
    expect((await auth("sign-up/email", { email: to, password: "Fake-password-12345", name: "Fake", ...portalAnswers })).status).toBe(200);
    const token = new URL(sent(a.email, "change-email")[0]!.link).searchParams.get("token")!;
    const cases = [...OFFSITE, "/ /evil.example", "/" + "a".repeat(1999)].map((x) => [x, false] as const);
    for (const [cb, raw] of [...cases, ["/%09/evil.example", true] as const]) {
      const res = await verify(token, cb, raw);
      expect([res.status, res.headers.get("location"), (await res.json()).code], cb.slice(0, 40)).toEqual([409, null, "EMAIL_TAKEN"]);
    }
    const safe = await verify(token, "/account");
    expect([safe.status, safe.headers.get("location")]).toEqual([302, "/account?error=EMAIL_TAKEN"]);
    expect(await emailOf(a.id)).toBe(a.email);
  });
});

describe("sign out everywhere", () => {
  for (const role of ROLES)
    it(`${role ?? "no company"}: revoke-sessions ends every session at once, even from a stale one; others keep theirs`, async () => {
      const a = await login(role), b = await login(role);
      const second = await a.signIn();
      await age(a.id);
      expect((await auth("revoke-sessions", {}, { cookie: a.cookie })).status).toBe(200);
      for (const c of [a.cookie, second]) expect(await status(c)).toBe(401);
      expect(await status(b.cookie)).not.toBe(401);
    });
  it("revoke-other-sessions keeps this one; signed out and a foreign Origin are refused", async () => {
    const a = await login("viewer"), second = await a.signIn();
    expect((await auth("revoke-sessions", {})).status).toBe(401);
    expect((await auth("revoke-sessions", {}, { cookie: a.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await auth("revoke-other-sessions", {}, { cookie: second })).status).toBe(200);
    expect([await status(a.cookie), await status(second)]).toEqual([401, 200]);
  });
  it(`costs at most ${BUDGET.revoke} statements and ${BUDGET.revokeMs} ms median`, async () => {
    const a = await login("viewer");
    const [r, statements] = await counted(() => auth("revoke-sessions", {}, { cookie: a.cookie }));
    expect(r.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET.revoke);
    const cookies: string[] = [];
    for (let i = 0; i < 9; i++) cookies.push(await a.signIn());
    expect(await median(() => auth("revoke-sessions", {}, { cookie: cookies.pop()! }))).toBeLessThan(BUDGET.revokeMs);
  });
});
