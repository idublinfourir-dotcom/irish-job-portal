// C4 (#270) on the candidate site, end to end on the test database through the real route handlers as app_candidate: the delete needs a sign-in
// in the last 10 minutes, the email change takes effect only after the old address confirms and the new one is verified, and "sign out everywhere"
// (Better Auth's /revoke-sessions) ends every session at once. Email goes to the fake sender only; no network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";

// Statements counted on every pg.Client.query call, measured on 19 November 2026: a stale delete is refused after the session read (2); a change-email
// request reads the session in the hook and again in Better Auth's own check, looks up the new address and counts the rate limit; sign out everywhere
// reads the session, deletes the rows and counts the rate limit. Measured (two runs): stale delete 2 statements, 1.5 to 2.0 ms; change-email 7, 5.4 ms;
// revoke 6, 2.3 to 4.0 ms (medians of 9 warm calls). Time budgets are about 5 times that, a floor for a busy laptop. Raise these only on purpose.
const BUDGET = { staleDelete: 2, changeEmail: 7, revoke: 6, staleDeleteMs: 15, changeEmailMs: 25, revokeMs: 20 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: { GET: Handler; POST: Handler }, ACCOUNT: { DELETE: Handler }, PROFILE: { GET: Handler }, EXPORT: { GET: Handler };
let mail: () => { kind: string; to: string; link: string }[];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  AUTH = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route");
  ACCOUNT = await import("../../../apps/candidate/app/api/candidate/account/route");
  PROFILE = await import("../../../apps/candidate/app/api/candidate/profile/route");
  EXPORT = await import("../../../apps/candidate/app/api/candidate/export/route");
  ({ candidateMail: mail } = await import("../../../apps/candidate/lib/candidate"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const ip = () => `198.51.100.${(n++ % 200) + 10}`;
const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function auth(path: string, body: unknown, o: { cookie?: string; origin?: string } = {}) {
  const res = await AUTH.POST(new Request(`${BASE}/api/auth/candidate/${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: o.origin ?? BASE, "x-vercel-forwarded-for": ip(), ...(o.cookie ? { cookie: o.cookie } : {}) } }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, cookie: cookieOf(res) };
}
const click = (link: string) => AUTH.GET(new Request(link, { headers: { "x-vercel-forwarded-for": ip() }, redirect: "manual" }));
async function login() {
  const email = `fake.c4.${++n}@example.test`, password = "Fake-password-12345";
  expect((await auth("sign-up/email", { email, password, name: "Fake", ...answers })).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [email]);
  const signIn = async () => { const r = await auth("sign-in/email", { email, password }); expect(r.status).toBe(200); return r.cookie; };
  const cookie = await signIn();
  const id = (await su.query("select id from candidate_user where email = $1", [email])).rows[0].id as string;
  return { email, cookie, id, signIn };
}
const age = (id: string) => su.query("update candidate_session set created_at = now() - interval '11 minutes' where user_id = $1", [id]);
const del = async (cookie?: string, body: unknown = { confirm: true }) => {
  const res = await ACCOUNT.DELETE(new Request(`${BASE}/api/candidate/account`, { method: "DELETE", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) } }));
  return { status: res.status, json: await res.json() };
};
const profile = async (cookie: string) => (await PROFILE.GET(new Request(`${BASE}/api/candidate/profile`, { headers: { cookie } }))).status;
const emailOf = async (id: string) => (await su.query("select email, deleted_at from candidate_user where id = $1", [id])).rows[0];
const sent = (to: string) => mail().filter((m) => m.to === to);
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

describe("delete account", () => {
  it("a session older than 10 minutes is refused with REAUTH_REQUIRED and nothing changes; signing in again allows it", async () => {
    const a = await login();
    await age(a.id);
    expect(await del(a.cookie)).toEqual({ status: 403, json: { code: "REAUTH_REQUIRED" } });
    expect((await emailOf(a.id)).deleted_at).toBeNull();
    expect(await profile(a.cookie)).toBe(200); // the stale session still works for everything else
    expect((await del(a.cookie, { confirm: false })).status).toBe(400); // the body check still comes first
    expect((await del(undefined)).status).toBe(401);
    const fresh = await a.signIn();
    expect(await del(fresh)).toEqual({ status: 200, json: { ok: true } });
    expect((await emailOf(a.id)).deleted_at).not.toBeNull();
  });
  it(`a stale refusal costs at most ${BUDGET.staleDelete} statements and ${BUDGET.staleDeleteMs} ms median`, async () => {
    const a = await login();
    await age(a.id);
    const [r, statements] = await counted(() => del(a.cookie));
    expect(r.status).toBe(403);
    expect(statements).toBeLessThanOrEqual(BUDGET.staleDelete);
    expect(await median(() => del(a.cookie))).toBeLessThan(BUDGET.staleDeleteMs);
  });
});

describe("download my data (C4 gap round)", () => {
  const exp = async (cookie?: string) => {
    const res = await EXPORT.GET(new Request(`${BASE}/api/candidate/export`, { headers: cookie ? { cookie } : {} }));
    return { status: res.status, json: await res.json(), file: res.headers.get("content-disposition"), cache: res.headers.get("cache-control") };
  };
  const exports = (id: string) => su.query("select count(*)::int n from audit_event where actor_candidate_user_id = $1 and action like '%export%'", [id]).then((r) => r.rows[0].n);
  it("a stale session is REAUTH_REQUIRED with no file and no audit row; a new sign-in downloads it; signed out is 401", async () => {
    const a = await login();
    await age(a.id);
    expect(await exp(a.cookie)).toEqual({ status: 403, json: { code: "REAUTH_REQUIRED" }, file: null, cache: "no-store" });
    expect(await exports(a.id)).toBe(0);
    expect((await exp()).status).toBe(401);
    const r = await exp(await a.signIn());
    expect([r.status, r.file?.startsWith("attachment;")]).toEqual([200, true]);
    expect(await exports(a.id)).toBe(1);
  });
  it(`a stale refusal costs at most ${BUDGET.staleDelete} statements`, async () => {
    const a = await login();
    await age(a.id);
    const [r, statements] = await counted(() => exp(a.cookie));
    expect(r.status).toBe(403);
    expect(statements).toBeLessThanOrEqual(BUDGET.staleDelete);
  });
});

const HOSTILE = ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "/\t/evil.example", "/\n/x", "/ /evil.example", "/x\\y", "https:evil.example", "/" + "a".repeat(1999)];

describe("Better Auth's own verify-email refuses an unsafe callbackURL on a plain (sign-up) link", () => {
  it("each hostile value is 403 INVALID_CALLBACK_URL with no Location, and the email stays unconfirmed; a safe one confirms", async () => {
    const email = `fake.c4.cb${++n}@example.test`;
    expect((await auth("sign-up/email", { email, password: "Fake-password-12345", name: "Fake", ...answers })).status).toBe(200);
    const link = new URL(sent(email).find((m) => m.kind === "verify")!.link);
    // Stopped by Better Auth's originCheck on verify-email (email-verification.mjs:132), via isSafeRelativeURL (trusted-origins.mjs:83 to 93).
    // The space and the long path stay on our site (below), so Better Auth lets them through; every value that would leave the site is refused.
    for (const cb of [...HOSTILE.filter((x) => x !== "/ /evil.example" && x.length < 100), "/%09/evil.example"]) {
      const raw = cb === "/%09/evil.example" ? cb : encodeURIComponent(cb);
      const res = await click(`${BASE}/api/auth/candidate/verify-email?token=${link.searchParams.get("token")}&callbackURL=${raw}`);
      const text = await res.text();
      expect([res.status, res.headers.get("location"), text && JSON.parse(text).code], cb).toEqual([403, null, "INVALID_CALLBACK_URL"]);
    }
    expect((await su.query("select email_verified from candidate_user where email = $1", [email])).rows[0].email_verified).toBe(false);
    // "/ /evil.example" passes Better Auth (a space is not a control character) but stays on our site: the space is percent-encoded, not stripped.
    link.searchParams.set("callbackURL", "/ /evil.example");
    const spaced = await click(link.toString());
    expect(spaced.status).toBe(302);
    expect(new URL(spaced.headers.get("location")!, BASE).href).toBe(`${BASE}/%20/evil.example`);
    link.searchParams.set("callbackURL", "/welcome");
    const ok = await click(link.toString()); // the token is still good for a second click
    expect([ok.status, ok.headers.get("location")]).toEqual([302, "/welcome"]);
  });
});

describe("email change", () => {
  it("takes effect only after the old address confirms and the new address is verified; the old one gets the notice first", async () => {
    const a = await login(), to = `fake.c4.new.${n}@example.test`;
    const r = await auth("change-email", { newEmail: to, callbackURL: "/account" }, { cookie: a.cookie });
    expect([r.status, r.json]).toEqual([200, { status: true }]);
    expect(sent(a.email).map((m) => m.kind)).toEqual(["verify", "change-email"]); // the sign-up email, then the notice
    expect(sent(to)).toEqual([]);
    expect((await emailOf(a.id)).email).toBe(a.email);
    expect((await click(sent(a.email)[1]!.link)).status).toBe(302); // the old address confirms
    expect((await emailOf(a.id)).email).toBe(a.email); // still unchanged
    expect(sent(to).map((m) => m.kind)).toEqual(["new-email"]);
    expect((await click(sent(to)[0]!.link)).status).toBe(302); // the new address verifies
    expect(await emailOf(a.id)).toEqual({ email: to, deleted_at: null });
    expect((await su.query("select email_verified from candidate_user where id = $1", [a.id])).rows[0].email_verified).toBe(true);
    expect((await auth("sign-in/email", { email: to, password: "Fake-password-12345" })).status).toBe(200);
    expect((await auth("sign-in/email", { email: a.email, password: "Fake-password-12345" })).status).toBe(401);
  });
  it("a stale session is refused with REAUTH_REQUIRED and no email is sent; signed out is 401", async () => {
    const a = await login();
    await age(a.id);
    const before = mail().length;
    expect(await auth("change-email", { newEmail: `fake.c4.x${n}@example.test` }, { cookie: a.cookie })).toMatchObject({ status: 403, json: { code: "REAUTH_REQUIRED" } });
    expect((await auth("change-email", { newEmail: `fake.c4.y${n}@example.test` })).status).toBe(401);
    expect(mail().length).toBe(before);
    expect((await auth("change-email", { newEmail: `fake.c4.z${n}@example.test` }, { cookie: await a.signIn() })).status).toBe(200);
  });
  it("an address that already has an account answers the same and sends nothing, so it shows nothing", async () => {
    const a = await login(), b = await login();
    const before = mail().length;
    expect(await auth("change-email", { newEmail: b.email }, { cookie: a.cookie })).toMatchObject({ status: 200, json: { status: true } });
    expect(mail().length).toBe(before);
    expect((await emailOf(a.id)).email).toBe(a.email);
  });
  it("hostile input: not an address, a 300-character address, a wrong type, a foreign Origin; a link for one login cannot move another", async () => {
    const a = await login(), b = await login();
    for (const newEmail of ["not-an-address", `${"x".repeat(290)}@example.test`, 42, null])
      expect((await auth("change-email", { newEmail }, { cookie: a.cookie })).status, String(newEmail)).toBe(400);
    expect((await auth("change-email", { newEmail: `fake.c4.o${n}@example.test` }, { cookie: a.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await emailOf(a.id)).email).toBe(a.email);
    await auth("change-email", { newEmail: `fake.c4.p${n}@example.test` }, { cookie: a.cookie });
    const link = sent(a.email).at(-1)!.link;
    const res = await AUTH.GET(new Request(link, { headers: { cookie: b.cookie, "x-vercel-forwarded-for": ip() }, redirect: "manual" })); // opened while b is signed in
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=");
    expect([(await emailOf(a.id)).email, (await emailOf(b.id)).email]).toEqual([a.email, b.email]);
  });
  it("the race: the new address gets an account between request and link: EMAIL_TAKEN on either link, nothing changes, no 500", async () => {
    for (const step of ["first", "second"] as const) {
      const a = await login(), to = `fake.c4.race${step}${n}@example.test`;
      expect((await auth("change-email", { newEmail: to, callbackURL: "/account" }, { cookie: a.cookie })).status).toBe(200);
      const first = sent(a.email).at(-1)!.link;
      if (step === "second") expect((await click(first)).status).toBe(302);
      expect((await auth("sign-up/email", { email: to, password: "Fake-password-12345", name: "Fake", ...answers })).status).toBe(200); // someone takes it
      const link = step === "first" ? first : sent(to).find((m) => m.kind === "new-email")!.link;
      const res = await click(link);
      expect([res.status, res.headers.get("location")], step).toEqual([302, "/account?error=EMAIL_TAKEN"]);
      const bare = new URL(link);
      bare.searchParams.delete("callbackURL");
      const plain = await click(bare.toString());
      expect([plain.status, (await plain.json()).code], step).toEqual([409, "EMAIL_TAKEN"]);
      expect((await emailOf(a.id)).email).toBe(a.email);
      if (step === "first") expect(sent(to).filter((m) => m.kind === "new-email")).toEqual([]); // the taken address got no link
    }
  });
  it("the race check never redirects off the site and ignores a forged token (no account lookup leak)", async () => {
    const a = await login(), to = `fake.c4.off${n}@example.test`;
    await auth("change-email", { newEmail: to, callbackURL: "/account" }, { cookie: a.cookie });
    await auth("sign-up/email", { email: to, password: "Fake-password-12345", name: "Fake", ...answers });
    const link = new URL(sent(a.email).at(-1)!.link);
    // Review of 07f9a8c: "/\t/evil.example" passed the first check and the URL parser strips the tab, so Location went to evil.example.
    const token = link.searchParams.get("token")!;
    const urls = HOSTILE.map((cb) => [cb, `${BASE}/api/auth/candidate/verify-email?token=${token}&callbackURL=${encodeURIComponent(cb)}`]);
    urls.push(["raw /%09/evil.example", `${BASE}/api/auth/candidate/verify-email?token=${token}&callbackURL=/%09/evil.example`]); // decoded to a tab
    for (const [cb, url] of urls) {
      const res = await click(url!);
      expect([res.status, res.headers.get("location"), (await res.json()).code], cb).toEqual([409, null, "EMAIL_TAKEN"]);
    }
    expect((await emailOf(a.id)).email).toBe(a.email);
    const [h, , sig] = link.searchParams.get("token")!.split("."); // a real header and signature over a payload naming the taken address
    const forged = `${h}.${Buffer.from(JSON.stringify({ email: a.email, updateTo: to, requestType: "change-email-verification", userId: a.id })).toString("base64url")}.${sig}`;
    const res = await click(`${BASE}/api/auth/candidate/verify-email?token=${forged}`);
    expect([res.status, (await res.json()).code]).not.toEqual([409, "EMAIL_TAKEN"]);
    expect((await emailOf(a.id)).email).toBe(a.email);
  });
  it("is limited to 3 requests in 5 minutes per address of the caller", async () => {
    const a = await login(), h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "198.51.100.250", cookie: a.cookie };
    const go = (i: number) => AUTH.POST(new Request(`${BASE}/api/auth/candidate/change-email`, { method: "POST", headers: h, body: JSON.stringify({ newEmail: `fake.c4.rate${i}${n}@example.test` }) }));
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await go(i)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
  it(`a request costs at most ${BUDGET.changeEmail} statements and ${BUDGET.changeEmailMs} ms median`, async () => {
    const a = await login();
    const [r, statements] = await counted(() => auth("change-email", { newEmail: `fake.c4.b${n}@example.test` }, { cookie: a.cookie }));
    expect(r.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET.changeEmail);
    await su.query("delete from candidate_rate_limit");
    let i = 0;
    expect(await median(() => auth("change-email", { newEmail: `fake.c4.m${i++}.${n}@example.test` }, { cookie: a.cookie }))).toBeLessThan(BUDGET.changeEmailMs);
  });
});

describe("sign out everywhere", () => {
  it("revoke-sessions ends every session of the login at once (sessions are read from the database on each request); another login keeps its own", async () => {
    const a = await login(), b = await login();
    const second = await a.signIn();
    await age(a.id); // no fresh sign-in needed to sign out
    expect(await auth("revoke-sessions", {}, { cookie: a.cookie })).toMatchObject({ status: 200, json: { status: true } });
    for (const c of [a.cookie, second]) expect(await profile(c)).toBe(401);
    expect(await profile(b.cookie)).toBe(200);
    expect((await su.query("select count(*)::int n from candidate_session where user_id = $1", [a.id])).rows[0].n).toBe(0);
  });
  it("revoke-other-sessions keeps this one and ends the rest", async () => {
    const a = await login();
    const second = await a.signIn();
    expect((await auth("revoke-other-sessions", {}, { cookie: second })).status).toBe(200);
    expect([await profile(a.cookie), await profile(second)]).toEqual([401, 200]);
  });
  it("is 401 signed out or with a junk cookie, and 403 from a foreign Origin (nothing ends)", async () => {
    const a = await login();
    expect((await auth("revoke-sessions", {})).status).toBe(401);
    expect((await auth("revoke-sessions", {}, { cookie: "candidate.session_token=junk.junk" })).status).toBe(401);
    expect((await auth("revoke-sessions", {}, { cookie: a.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(await profile(a.cookie)).toBe(200);
  });
  it(`costs at most ${BUDGET.revoke} statements and ${BUDGET.revokeMs} ms median`, async () => {
    const a = await login();
    const [r, statements] = await counted(() => auth("revoke-sessions", {}, { cookie: a.cookie }));
    expect(r.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET.revoke);
    const cookies: string[] = [];
    for (let i = 0; i < 9; i++) cookies.push(await a.signIn());
    expect(await median(() => auth("revoke-sessions", {}, { cookie: cookies.pop()! }))).toBeLessThan(BUDGET.revokeMs);
  });
});
