// Step 7 slice 2 part B (decision #179): Google sign-in for candidates, end to end on the test database. Everything goes through the
// real route handler of apps/candidate as app_candidate. Google is a fake: the global fetch is replaced, so the token call is answered
// here and any other outside address fails the test. The network guard stays on. Fake people only.
// The steps share state (cookies, ids), so they run in order.
import { pressed } from "./confirm-link";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { createAuth } from "../../auth/src";
import { answers, seedSignupTerms } from "./better-auth-helper";

// Statements measured on 12 November 2026, counting every pg.Client.query call (begin and commit included). The callback that creates
// an account (user, Google account, consent row, session): 17 for a new person (no password hashing, so far faster than email sign-up); a returning user: 12; joining an existing confirmed account: 14 (includes the one consent-row lookup), 16 since 13 November 2026 (step 15: the password
// account and the earlier sessions are deleted, review finding 3). Each one more since 17 November 2026 (C1: the update of last_active_at).
// The sign-in start call is not counted. Raise only on purpose.
const BUDGET = { newUser: 18, returning: 13, link: 17, newUserMs: 200 };
// Time measured three times on 12 November 2026: a new person 39 ms (budget 200, about 5 times).

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool;
let POST: (r: Request) => Promise<Response>, GET: (r: Request) => Promise<Response>, mail: () => { to: string; kind: string; link: string }[];

// The fake Google: a code is the key of a profile; the token call answers with an unsigned id token holding it.
type Profile = { sub: string; email: string; name?: string; email_verified?: unknown };
const profiles = new Map<string, Profile>();
const fetched: string[] = [];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  if (url !== "https://oauth2.googleapis.com/token") throw new Error(`The fake Google does not answer ${url}`);
  const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
  const p = profiles.get(code);
  if (!p) return Response.json({ error: "invalid_grant" }, { status: 400 });
  const idToken = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: "fake-client-id", ...p })}.fake-signature`;
  return Response.json({ access_token: "fake-access", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: "openid email profile" });
};

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  vi.stubGlobal("fetch", fakeFetch);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: "fake-client-id", GOOGLE_CLIENT_SECRET: "fake-client-secret" });
  ({ POST, GET } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ candidateMail: mail } = await import("../../../apps/candidate/lib/candidate"));
  mail = pressed(mail, "candidate");
});
afterAll(async () => {
  vi.unstubAllGlobals();
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let ipn = 10;
const freshIp = () => `203.0.113.${ipn++}`;
async function call(path: string, body?: unknown, o: { cookie?: string; auth?: { handler: (r: Request) => Promise<Response> }; pool?: string; origin?: string } = {}) {
  const post = body !== undefined, handler = o.auth ? o.auth.handler : post ? POST : GET;
  const res = await handler(new Request(`${BASE}/api/auth/${o.pool ?? "candidate"}/${path}`, {
    method: post ? "POST" : "GET", body: post ? JSON.stringify(body) : undefined, redirect: "manual",
    headers: { "content-type": "application/json", origin: o.origin ?? BASE, "x-vercel-forwarded-for": freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}) },
  }));
  const text = await res.text();
  let json: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, location: res.headers.get("location"), cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}

let seq = 0;
const count = async (sql: string, args: unknown[] = []) => (await su.query(`select count(*)::int n from (${sql}) t`, args)).rows[0].n as number;
const users = (email: string) => count("select 1 from candidate_user where email=$1", [email.toLowerCase()]);
const consents = (email: string) => count("select 1 from consent_record c join candidate_user u on u.id=c.candidate_user_id where u.email=$1", [email.toLowerCase()]);
const googleAccounts = (email: string) => count("select 1 from candidate_account a join candidate_user u on u.id=a.user_id where u.email=$1 and a.provider_id='google'", [email.toLowerCase()]);
const everything = async () => [await count("select 1 from candidate_user"), await count("select 1 from candidate_account"), await count("select 1 from consent_record"), await count("select 1 from candidate_session")];
const person = (n: string, extra: Partial<Profile> = {}): Profile => ({ sub: `google-sub-${n}`, email: `fake.g.${n}@example.test`, name: `Fake ${n}`, email_verified: true, ...extra });

/** The whole Google round trip: start (with additionalData), then the callback Google would send the browser back to. */
async function viaGoogle(p: Profile, o: { additionalData?: unknown; query?: string; tamper?: (state: string) => string; noCookie?: boolean; extra?: object } = {}) {
  const start = await call("sign-in/social", { provider: "google", callbackURL: "/welcome", ...("additionalData" in o ? { additionalData: o.additionalData } : { additionalData: answers }), ...o.extra });
  expect(start.status, start.text).toBe(200);
  const url = new URL(start.json!.url);
  const state = o.tamper ? o.tamper(url.searchParams.get("state")!) : url.searchParams.get("state")!;
  const code = `code-${seq++}`;
  profiles.set(code, p);
  const [callback, statements] = await counted(() => call(`callback/google?code=${code}&state=${encodeURIComponent(state)}${o.query ?? ""}`, undefined, { cookie: o.noCookie ? undefined : start.cookie }));
  return { start, url, state, code, callback, statements, ok: !!callback.location && !callback.location.includes("error="), error: new URL(callback.location ?? BASE, BASE).searchParams.get("error") };
}
const sessionOf = async (cookie: string) => (await call("get-session", undefined, { cookie })).json;

describe("Google is off unless both settings are set", () => {
  it("without settings the Google routes refuse and nothing is made", async () => {
    const off = createAuth("candidate", { database: db.pool("app_candidate"), baseURL: BASE, secret, sendEmail: async () => {} });
    const before = await everything();
    const start = await call("sign-in/social", { provider: "google", callbackURL: "/welcome", additionalData: answers }, { auth: off });
    expect(start.status).toBe(404);
    expect(start.json?.code).toBe("PROVIDER_NOT_FOUND");
    const cb = await call("callback/google?code=x&state=y", undefined, { auth: off });
    expect(cb.status).toBe(302);
    expect(cb.location).toMatch(/error=/);
    expect(await everything()).toEqual(before);
  });
});

describe("origin and redirect-address checks on the Google start (review finding 2)", () => {
  const evil = "https://evil.example.test";
  it("a foreign callbackURL, errorCallbackURL or newUserCallbackURL is refused and no state is stored", async () => {
    const states = () => count("select 1 from candidate_verification");
    const before = await states();
    for (const field of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"])
      for (const bad of [`${evil}/steal`, "//evil.example.test/steal", "javascript:alert(1)", "https://localhost.evil.example.test/"]) {
        const r = await call("sign-in/social", { provider: "google", callbackURL: "/welcome", additionalData: answers, [field]: bad });
        expect([r.status, r.json?.code], `${field} ${bad}`).toEqual([403, field === "callbackURL" ? "INVALID_CALLBACK_URL" : field === "errorCallbackURL" ? "INVALID_ERROR_CALLBACK_URL" : "INVALID_NEW_USER_CALLBACK_URL"]);
      }
    expect(await states()).toBe(before);
  });
  it("a foreign origin with a cookie is refused; our own addresses (relative and absolute) work", async () => {
    const body = { provider: "google", callbackURL: "/welcome", additionalData: answers };
    const r = await call("sign-in/social", body, { cookie: "candidate.session_token=anything", origin: evil });
    expect([r.status, r.json?.code]).toEqual([403, "INVALID_ORIGIN"]);
    for (const own of [{ callbackURL: `${BASE}/welcome`, errorCallbackURL: "/sorry", newUserCallbackURL: `${BASE}/hello` }, {}])
      expect((await call("sign-in/social", { ...body, ...own })).status).toBe(200);
  });
});

describe("Google sign-up with the three answers (#179, #8, #106, #175, #176, #178)", () => {
  const ann = person("ann");
  it("sends the person to Google with our callback address, and keeps no outside call of its own", async () => {
    const start = await call("sign-in/social", { provider: "google", callbackURL: "/welcome", additionalData: answers });
    expect(start.status).toBe(200);
    const u = new URL(start.json!.url);
    expect([u.origin + u.pathname, u.searchParams.get("redirect_uri"), u.searchParams.get("client_id")]).toEqual(["https://accounts.google.com/o/oauth2/v2/auth", `${BASE}/api/auth/candidate/callback/google`, "fake-client-id"]);
    expect(u.searchParams.get("scope")).toBe("email profile openid");
    expect(fetched).toEqual([]);
  });
  it("makes the account, the Google link and one consent row together, confirmed, with a session", async () => {
    const r = await viaGoogle(ann), n = r.statements;
    expect(r.ok, r.callback.location ?? "").toBe(true);
    expect(r.callback.location).toBe("/welcome");
    expect(n, `the callback sent ${n} statements`).toBeLessThanOrEqual(BUDGET.newUser);
    expect(r.callback.cookie).toMatch(/candidate\.session_token=/);
    expect((await sessionOf(r.callback.cookie))?.user.email).toBe(ann.email);
    const rows = (await su.query(
      `select c.details, c.given_at, c.withdrawn_at, t.purpose, u.email_verified, u.name, a.account_id
         from consent_record c join consent_text t on t.id = c.consent_text_id join candidate_user u on u.id = c.candidate_user_id
         join candidate_account a on a.user_id = u.id and a.provider_id='google' where u.email=$1`, [ann.email])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ details: answers, purpose: "signup_terms", withdrawn_at: null, email_verified: true, name: "Fake ann", account_id: ann.sub });
    expect(Math.abs(rows[0].given_at.getTime() - Date.now())).toBeLessThan(10000);
    expect(await count("select 1 from candidate_account a join candidate_user u on u.id=a.user_id where u.email=$1 and a.password is not null", [ann.email])).toBe(0);
    expect(mail().filter((m) => m.to === ann.email)).toHaveLength(0);
    expect(new Set(fetched)).toEqual(new Set(["https://oauth2.googleapis.com/token"]));
  });
  it("account creation stays inside its time budget", async () => {
    const t = performance.now();
    expect((await viaGoogle(person("speed"))).ok).toBe(true);
    expect(performance.now() - t).toBeLessThan(BUDGET.newUserMs);
  });
  it("a returning Google user signs in without answering again, and no second consent row is written", async () => {
    const r = await viaGoogle(ann, { additionalData: undefined }), n = r.statements;
    expect(r.ok, r.callback.location ?? "").toBe(true);
    expect(n, `the callback sent ${n} statements`).toBeLessThanOrEqual(BUDGET.returning);
    expect((await sessionOf(r.callback.cookie))?.user.email).toBe(ann.email);
    expect([await users(ann.email), await consents(ann.email), await googleAccounts(ann.email)]).toEqual([1, 1, 1]);
  });
  it("a returning user is not harmed by wrong answers in the new sign-in: they are not read for an existing account", async () => {
    const r = await viaGoogle(ann, { additionalData: { needsPermit: false } });
    expect(r.ok).toBe(true);
    expect([await users(ann.email), await consents(ann.email)]).toEqual([1, 1]);
  });
  it("stores an SQL-looking Google name as plain text", async () => {
    const p = person("sqlname", { name: "Robert'); drop table candidate_user;--" });
    expect((await viaGoogle(p)).ok).toBe(true);
    expect((await su.query("select name from candidate_user where email=$1", [p.email])).rows[0].name).toBe(p.name);
  });
  it("lower-cases the email Google sends", async () => {
    const p = person("capsmail", { email: "Fake.G.CapsMail@Example.Test" });
    expect((await viaGoogle(p)).ok).toBe(true);
    expect(await users("fake.g.capsmail@example.test")).toBe(1);
  });
});

describe("Google sign-up refused: no account, no consent row, no session, no cookie", () => {
  const refused = async (n: string, o: Parameters<typeof viaGoogle>[1], why: RegExp | string, profile: Profile = person(n)) => {
    const label = `${n} ${JSON.stringify(profile.email_verified)} ${JSON.stringify(o).slice(0, 200)}`;
    const before = await everything();
    const r = await viaGoogle(profile, o);
    expect(r.ok, label).toBe(false);
    expect(r.error, label).toMatch(why);
    expect(r.callback.cookie, "no session cookie").not.toMatch(/session_token=[^;]/);
    expect(await everything(), label).toEqual(before);
    expect(await users(profile.email)).toBe(0);
  };
  it("no additionalData at all, an empty one, and answers sent only in the callback address", async () => {
    await refused("none", { additionalData: undefined }, "SIGNUP_ANSWERS_REFUSED");
    // The sign-in page starts Google with no answers and errorCallbackURL /login?error=google (apps/candidate/app/(auth)/forms.tsx):
    // the browser lands on /login with both codes, which the page turns into its "no account yet" line (login/page.tsx, 26 Nov 2026).
    const fromLogin = await viaGoogle(person("from-login"), { additionalData: undefined, extra: { errorCallbackURL: "/login?error=google" } });
    const landed = new URL(fromLogin.callback.location ?? "", BASE);
    expect([landed.pathname, landed.searchParams.getAll("error")]).toEqual(["/login", ["google", "SIGNUP_ANSWERS_REFUSED"]]);
    expect(await users(person("from-login").email)).toBe(0);
    await refused("empty", { additionalData: {} }, "SIGNUP_ANSWERS_REFUSED");
    await refused("late", { additionalData: undefined, query: "&needsPermit=true&over18=true&acceptsTerms=true" }, "SIGNUP_ANSWERS_REFUSED");
  });
  it("'no' to needing a permit, and every answer that is not the plain value true", async () => {
    const bad: Record<string, unknown>[] = [
      { needsPermit: false }, { needsPermit: undefined }, { needsPermit: "true" }, { needsPermit: 1 }, { needsPermit: null }, { needsPermit: [true] }, { needsPermit: { value: true } },
      { over18: false }, { over18: undefined }, { over18: "yes" }, { over18: 1 }, { over18: { value: true } },
      { acceptsTerms: false }, { acceptsTerms: undefined }, { acceptsTerms: "on" }, { acceptsTerms: 0 }, { acceptsTerms: [true] },
      { needsPermit: "'; drop table candidate_user;--" }, { over18: "x".repeat(100000) }, { acceptsTerms: { $ne: null } },
    ];
    for (const [i, extra] of bad.entries()) await refused(`bad${i}`, { additionalData: { ...answers, ...extra } }, "SIGNUP_ANSWERS_REFUSED");
    const before = await everything();
    for (const odd of [[answers], "true", 7, true]) expect((await call("sign-in/social", { provider: "google", callbackURL: "/welcome", additionalData: odd })).status).toBe(400);
    expect(await everything()).toEqual(before);
  });
  it("Google saying the email is not verified, or not saying at all, or saying it as the word false", async () => {
    for (const [n, v] of [["unv1", false], ["unv2", undefined], ["unv3", "false"], ["unv4", 0], ["unv5", null]] as const)
      await refused(n, {}, "EMAIL_NOT_VERIFIED_BY_PROVIDER", person(n, { email_verified: v }));
  });
  it("a changed, cut, empty or made-up state, and a state without the cookie it was made with", async () => {
    const before = await everything();
    for (const [n, o] of [
      ["t1", { tamper: (s: string) => s.slice(0, -1) + (s.endsWith("a") ? "b" : "a") }], ["t2", { tamper: (s: string) => s.slice(1) }],
      ["t3", { tamper: () => "" }], ["t4", { tamper: () => "x'; drop table candidate_verification;--" }], ["t5", { noCookie: true }],
    ] as const) {
      const r = await viaGoogle(person(n), o);
      expect(r.ok, n).toBe(false);
      expect(r.callback.cookie, n).not.toMatch(/session_token=[^;]/);
    }
    expect(await everything()).toEqual(before);
  });
  it("a state used twice: the second use does nothing", async () => {
    const p = person("replay");
    const first = await viaGoogle(p);
    expect(first.ok).toBe(true);
    const sessions = await count("select 1 from candidate_session");
    const again = await call(`callback/google?code=${first.code}&state=${encodeURIComponent(first.state)}`, undefined, { cookie: first.start.cookie });
    expect(again.location).toMatch(/error=/);
    expect(again.cookie).not.toMatch(/session_token=[^;]/);
    expect([await users(p.email), await consents(p.email), await count("select 1 from candidate_session")]).toEqual([1, 1, sessions]);
  });
  it("a link field smuggled into additionalData does not join the new Google account to someone else", async () => {
    const victim = person("victim-pw");
    const v = await call("sign-up/email", { email: victim.email, password: "Fake-victim-password-1", name: "Fake victim", ...answers });
    expect(v.status).toBe(200);
    const [userId] = (await su.query("select id from candidate_user where email=$1", [victim.email])).rows.map((r) => r.id);
    const p = person("smuggler");
    const r = await viaGoogle(p, { additionalData: { ...answers, link: { email: victim.email, userId }, callbackURL: "https://evil.example.test", serverContext: { x: 1 } } });
    expect(r.ok, r.callback.location ?? "").toBe(true);
    expect(r.callback.location).toBe("/welcome");
    expect(await googleAccounts(victim.email)).toBe(0);
    expect([await users(p.email), await googleAccounts(p.email)]).toEqual([1, 1]);
  });
  it("signing in with an id token (no redirect) cannot make an account: with Google's check forced to pass, our own rule refuses it", async () => {
    // The provider's token check is forced to pass, so the refusal below comes from our user-create step and not from the fake
    // refusing Google's key download. A returning Google user (ann) is the control: the same call signs her in.
    const auth = createAuth("candidate", { database: db.pool("app_candidate"), baseURL: BASE, secret, sendEmail: async () => {}, google: { clientId: "fake-client-id", clientSecret: "x", verifyIdToken: async () => true } as never });
    const token = (p: Profile) => `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", aud: "fake-client-id", ...p })}.x`;
    const control = await call("sign-in/social", { provider: "google", idToken: { token: token(person("ann")) } }, { auth });
    expect([control.status, control.json?.user?.email], control.text).toEqual([200, person("ann").email]);
    const p = person("idtoken"), before = await everything();
    const r = await call("sign-in/social", { provider: "google", idToken: { token: token(p) }, additionalData: answers }, { auth });
    expect([r.status, r.json?.code], r.text).toEqual([400, "SIGNUP_ANSWERS_REFUSED"]);
    expect(await everything()).toEqual(before);
    expect(await users(p.email)).toBe(0);
  });
  it("a refused sign-up leaves no half-made rows: every candidate has a consent row", async () => {
    expect(await count("select 1 from candidate_user u left join consent_record c on c.candidate_user_id=u.id where c.id is null")).toBe(0);
    expect(await count("select 1 from candidate_account a left join candidate_user u on u.id=a.user_id where u.id is null")).toBe(0);
  });
  it("fails closed if the hand-off between the user-create and account-create steps ever breaks: no user, no account, no consent row", async () => {
    // Simulates the hand-off failing: lookups of the stored answers miss. Only a value that is exactly the three answers is hidden.
    const get = WeakMap.prototype.get;
    // (A plain replacement, not vi.spyOn: the spy library itself uses WeakMap.get and would loop.)
    WeakMap.prototype.get = function (this: WeakMap<object, unknown>, k: object) {
      const v = get.call(this, k) as object | undefined;
      return v && Object.keys(v).sort().join() === "acceptsTerms,needsPermit,over18" ? undefined : v; // exactly the answers, not the sign-in state
    } as typeof get;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = person("handoff"), before = await everything();
    try {
      const r = await viaGoogle(p);
      expect(r.ok).toBe(false);
      expect(r.callback.cookie).not.toMatch(/session_token=[^;]/);
    } finally { WeakMap.prototype.get = get; logged.mockRestore(); }
    expect(await everything()).toEqual(before);
    expect([await users(p.email), await googleAccounts(p.email), await consents(p.email)]).toEqual([0, 0, 0]);
    expect((await viaGoogle(p)).ok, "works again once the hand-off is back").toBe(true);
  });
  it("when the consent write fails the Google account is rolled back too", async () => {
    const p = person("txfail");
    await su.query(`create function public.fail_consent() returns trigger language plpgsql as $$ begin
      if new.candidate_user_id in (select id from candidate_user where email = '${p.email}') then raise exception 'consent write refused for the test'; end if; return new; end $$`);
    await su.query("create trigger fail_consent before insert on consent_record for each row execute function public.fail_consent()");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await viaGoogle(p);
      expect(r.ok).toBe(false);
      expect(await users(p.email)).toBe(0);
      expect(await googleAccounts(p.email)).toBe(0);
    } finally {
      logged.mockRestore();
      await su.query("drop trigger fail_consent on consent_record");
      await su.query("drop function public.fail_consent()");
    }
  });
});

describe("an existing candidate with the same email (no silent takeover)", () => {
  const pw = (n: string) => ({ email: `fake.g.${n}@example.test`, password: `Fake-${n}-password-1`, name: `Fake ${n}`, ...answers });
  it("an email-and-password account that was never confirmed is not joined, and Google signs nobody in", async () => {
    const e = pw("unconfirmed");
    expect((await call("sign-up/email", e)).status).toBe(200);
    const before = await everything();
    const r = await viaGoogle(person("unconfirmed"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("account_not_linked");
    expect(r.callback.cookie).not.toMatch(/session_token=[^;]/);
    expect(await everything()).toEqual(before);
    expect(await googleAccounts(e.email)).toBe(0);
    expect((await su.query("select email_verified from candidate_user where email=$1", [e.email])).rows[0].email_verified).toBe(false);
    // and the owner of the address can still use the password path once confirmed
    expect(mail().filter((m) => m.to === e.email && m.kind === "verify")).toHaveLength(1);
  });
  it("an unconfirmed account is not joined even when the Google answers are perfect and Google says verified, and not when Google says unverified", async () => {
    const r = await viaGoogle(person("unconfirmed", { email_verified: false }));
    expect(r.ok).toBe(false);
    expect(await googleAccounts(pw("unconfirmed").email)).toBe(0);
  });
  it("a confirmed account is joined by a Google-verified email: same user, no answers needed, no second consent row", async () => {
    const e = pw("confirmed");
    expect((await call("sign-up/email", e)).status).toBe(200);
    const link = mail().filter((m) => m.to === e.email && m.kind === "verify").at(-1)!.link;
    const u = new URL(link);
    expect((await call(u.pathname.replace("/api/auth/candidate/", "") + u.search)).status).toBe(302);
    const idBefore = (await su.query("select id from candidate_user where email=$1", [e.email])).rows[0].id;
    const r = await viaGoogle(person("confirmed", { email: e.email.toUpperCase() }), { additionalData: undefined });
    expect(r.ok, r.callback.location ?? "").toBe(true);
    expect(r.statements, `joining sent ${r.statements} statements`).toBeLessThanOrEqual(BUDGET.link);
    expect((await sessionOf(r.callback.cookie))?.user.id).toBe(idBefore);
    expect([await users(e.email), await consents(e.email), await googleAccounts(e.email)]).toEqual([1, 1, 1]);
    // the password set before Google proved the address is gone (review finding 3; the full case is in "pre-hijack" below)
    const login = await call("sign-in/email", { email: e.email, password: e.password });
    expect(login.status).toBe(401);
  });
  it("a confirmed account is not joined when Google says the email is unverified", async () => {
    const e = pw("confirmed");
    const before = await everything();
    const r = await viaGoogle(person("confirmed-2", { email: e.email, email_verified: false }));
    expect(r.ok).toBe(false);
    expect(await everything()).toEqual(before);
  });
  it("another Google identity for the same confirmed email is a second link to the same person, not a second person", async () => {
    // the sub is the Google identity; an attacker with a different sub but a Google-verified copy of the address is the address owner by Google's word
    const e = pw("confirmed");
    const r = await viaGoogle(person("confirmed-3", { email: e.email }), { additionalData: undefined });
    expect(r.ok).toBe(true);
    expect([await users(e.email), await consents(e.email)]).toEqual([1, 1]);
  });
  it("a suspended or deleted candidate cannot sign in with Google", async () => {
    const p = person("susp");
    expect((await viaGoogle(p)).ok).toBe(true);
    for (const col of ["suspended_at", "deleted_at"]) {
      await su.query(`update candidate_user set ${col}=now() where email=$1`, [p.email]);
      const r = await viaGoogle(p, { additionalData: undefined });
      expect(r.ok, col).toBe(false);
      expect(r.callback.cookie, col).not.toMatch(/session_token=[^;]/);
      await su.query(`update candidate_user set ${col}=null where email=$1`, [p.email]);
    }
  });
});

describe("pre-hijack: Google proves the address, so a password set before that proof goes (review finding 3)", () => {
  const victim = { email: "fake.g.victim@example.test", password: "Fake-attacker-password-1", name: "Fake victim", ...answers };
  const sessions = (email: string) => count("select 1 from candidate_session s join candidate_user u on u.id=s.user_id where u.email=$1", [email]);
  const passwords = (email: string) => count("select 1 from candidate_account a join candidate_user u on u.id=a.user_id where u.email=$1 and a.provider_id='credential'", [email]);
  it("the attacker's password stops working and every earlier session ends when the owner signs in with Google", async () => {
    // someone else signs up with the owner's address and a password they chose
    expect((await call("sign-up/email", victim)).status).toBe(200);
    // the owner confirms by the link in the email, then the attacker signs in with their password
    const link = new URL(mail().filter((m) => m.to === victim.email && m.kind === "verify").at(-1)!.link);
    expect((await call(link.pathname.replace("/api/auth/candidate/", "") + link.search)).status).toBe(302);
    const attacker = await call("sign-in/email", { email: victim.email, password: victim.password });
    expect(attacker.status).toBe(200);
    expect((await sessionOf(attacker.cookie))?.user.email).toBe(victim.email);
    const id = (await su.query("select id from candidate_user where email=$1", [victim.email])).rows[0].id;
    // the owner signs in with Google
    const owner = await viaGoogle(person("victim", { email: victim.email }), { additionalData: undefined });
    expect(owner.ok, owner.callback.location ?? "").toBe(true);
    expect((await sessionOf(owner.callback.cookie))?.user.id).toBe(id);
    expect(await sessionOf(attacker.cookie)).toBeNull();
    expect(await sessions(victim.email)).toBe(1); // only the owner's new one
    expect(await passwords(victim.email)).toBe(0);
    expect((await call("sign-in/email", { email: victim.email, password: victim.password })).status).toBe(401);
    expect([await users(victim.email), await consents(victim.email), await googleAccounts(victim.email)]).toEqual([1, 1, 1]);
  });
  it("the owner can set a password again by reset, and it signs in", async () => {
    expect((await call("request-password-reset", { email: victim.email, redirectTo: `${BASE}/reset` })).status).toBe(200);
    const token = new URL(mail().filter((m) => m.to === victim.email && m.kind === "reset").at(-1)!.link).pathname.split("/").at(-1)!;
    expect((await call("reset-password", { newPassword: "Fake-owner-password-2", token })).status).toBe(200);
    expect(await passwords(victim.email)).toBe(1);
    expect((await call("sign-in/email", { email: victim.email, password: "Fake-owner-password-2" })).status).toBe(200);
    // and a later Google sign-in (the link already exists) leaves the owner's own password alone
    expect((await viaGoogle(person("victim", { email: victim.email }), { additionalData: undefined })).ok).toBe(true);
    expect(await passwords(victim.email)).toBe(1);
  });
  it("the same on an id-token sign-in (/sign-in/social with idToken): the first password no longer signs in and the earlier sessions are gone", async () => {
    const v = { ...victim, email: "fake.g.victim-idtoken@example.test" };
    expect((await call("sign-up/email", v)).status).toBe(200);
    const link = new URL(mail().filter((m) => m.to === v.email && m.kind === "verify").at(-1)!.link);
    expect((await call(link.pathname.replace("/api/auth/candidate/", "") + link.search)).status).toBe(302);
    const attacker = await call("sign-in/email", { email: v.email, password: v.password });
    expect(attacker.status).toBe(200);
    // Google's token check forced to pass, as in the id-token test above
    const auth = createAuth("candidate", { database: db.pool("app_candidate"), baseURL: BASE, secret, sendEmail: async () => {}, google: { clientId: "fake-client-id", clientSecret: "x", verifyIdToken: async () => true } as never });
    const token = `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", aud: "fake-client-id", ...person("victim-idtoken", { email: v.email }) })}.x`;
    const owner = await call("sign-in/social", { provider: "google", idToken: { token } }, { auth });
    expect([owner.status, owner.json?.user?.email], owner.text).toEqual([200, v.email]);
    expect(await sessionOf(attacker.cookie)).toBeNull();
    expect(await sessions(v.email)).toBe(1);
    expect(await passwords(v.email)).toBe(0);
    expect((await call("sign-in/email", { email: v.email, password: v.password })).status).toBe(401);
  });
  it("a candidate who signed up with Google only is unaffected: signing in again, or a second Google identity, ends no session", async () => {
    const p = person("only");
    const first = await viaGoogle(p);
    expect(first.ok).toBe(true);
    expect((await viaGoogle(p, { additionalData: undefined })).ok).toBe(true);
    expect((await viaGoogle(person("only-2", { email: p.email }), { additionalData: undefined })).ok).toBe(true);
    expect((await sessionOf(first.callback.cookie))?.user.email).toBe(p.email);
    expect(await sessions(p.email)).toBe(3);
  });
});

describe("a Google session is a candidate session only", () => {
  it("is no session on the staff route, even renamed to the staff cookie and signed with the same secret", async () => {
    const r = await viaGoogle(person("cookie"));
    expect(r.ok).toBe(true);
    expect(r.callback.cookie).toMatch(/candidate\.session_token=/);
    const staffAuth = createAuth("staff", { database: db.pool("app_admin"), baseURL: BASE, secret, sendEmail: async () => {} });
    const staffCookie = r.callback.cookie.split("; ").filter((c) => c.startsWith("candidate.session_token")).join("").replace("candidate.session_token", "staff.session_token");
    expect(await staffAuth.api.getSession({ headers: new Headers({ cookie: staffCookie }) })).toBeNull();
    const viaRoute = await staffAuth.handler(new Request(`${BASE}/api/auth/staff/get-session`, { headers: { cookie: staffCookie, origin: BASE } }));
    expect(await viaRoute.text()).toBe("null");
    // and there is no Google on the staff or portal pools
    for (const pool of ["staff", "portal"]) {
      const a = createAuth(pool as "staff", { database: db.pool(pool === "staff" ? "app_admin" : "app_portal"), baseURL: BASE, secret, sendEmail: async () => {}, google: { clientId: "x", clientSecret: "y" } });
      expect((await call("sign-in/social", { provider: "google", callbackURL: "/x" }, { auth: a, pool })).status, pool).toBe(404);
    }
  });
});

// Gap C5: a "no" sent through Google counts once, on the pool, after Google proves a new account; the refusal still rolls the sign-up back.
// Measured 18 November 2026: the refused "no" callback sends 12 statements (the count is one of them); budget 13.
describe("C5: a Google 'no' to the permit question is counted once", () => {
  const NO_BUDGET = 13;
  const today = async () => Number((await su.query("select coalesce(sum(count), 0) n from signup_no_count where day = (now() at time zone 'UTC')::date")).rows[0].n);
  it("a new person's 'no' adds one and is refused as before: no account, nothing about the visitor kept", async () => {
    const p = person("c5-no"), before = await today(), rows = await everything();
    const r = await viaGoogle(p, { additionalData: { ...answers, needsPermit: false } });
    expect([r.ok, r.error]).toEqual([false, "SIGNUP_ANSWERS_REFUSED"]);
    console.log(`google no callback: ${r.statements} statements`);
    expect(r.statements, `the callback sent ${r.statements} statements`).toBeLessThanOrEqual(NO_BUDGET);
    expect(await today()).toBe(before + 1);
    expect(await everything()).toEqual(rows);
    expect(JSON.stringify((await su.query("select * from signup_no_count")).rows)).not.toMatch(/fake\.g|google-sub|203\.0/);
    // the same state again does nothing more
    const again = await call(`callback/google?code=${r.code}&state=${encodeURIComponent(r.state)}`, undefined, { cookie: r.start.cookie });
    expect(again.location).toMatch(/error=/);
    expect(await today()).toBe(before + 1);
  });
  it("a 'no' whatever the other answers counts once; hostile values and a yes count nothing", async () => {
    const before = await today();
    await viaGoogle(person("c5-no2"), { additionalData: { needsPermit: false } });
    for (const [i, v] of (["false", 0, null, [false], { value: false }, "x".repeat(10_000)] as unknown[]).entries())
      expect((await viaGoogle(person(`c5-h${i}`), { additionalData: { ...answers, needsPermit: v } })).ok).toBe(false);
    expect((await viaGoogle(person("c5-yes"))).ok).toBe(true);
    expect(await today()).toBe(before + 1);
  });
  it("not counted: a returning Google user (answers not read), and an email Google has not verified", async () => {
    expect((await viaGoogle(person("c5-back"))).ok).toBe(true);
    const before = await today();
    expect((await viaGoogle(person("c5-back"), { additionalData: { needsPermit: false } })).ok).toBe(true);
    expect((await viaGoogle(person("c5-unv", { email_verified: false }), { additionalData: { needsPermit: false } })).error).toBe("EMAIL_NOT_VERIFIED_BY_PROVIDER");
    expect(await today()).toBe(before);
  });
  it("an id-token sign-in's 'no' counts once and is refused", async () => {
    const auth = createAuth("candidate", { database: db.pool("app_candidate"), baseURL: BASE, secret, sendEmail: async () => {}, google: { clientId: "fake-client-id", clientSecret: "x", verifyIdToken: async () => true } as never });
    const token = `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", aud: "fake-client-id", ...person("c5-idt") })}.x`;
    const before = await today();
    const r = await call("sign-in/social", { provider: "google", idToken: { token }, additionalData: { ...answers, needsPermit: false } }, { auth });
    expect([r.status, r.json?.code]).toEqual([400, "SIGNUP_ANSWERS_REFUSED"]);
    expect(await today()).toBe(before + 1);
  });
  it("the start is limited per address: the 6th in a minute is 429 and gets no state to count with", async () => {
    const start = () => POST(new Request(`${BASE}/api/auth/candidate/sign-in/social`, { method: "POST", body: JSON.stringify({ provider: "google", callbackURL: "/welcome", additionalData: { needsPermit: false } }),
      headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "198.51.100.250" } }));
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await start()).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("C4: an account with no password proves itself with a fresh Google sign-in", () => {
  it("a stale Google session cannot delete or change the email; a new Google sign-in can", async () => {
    const { DELETE } = await import("../../../apps/candidate/app/api/candidate/account/route");
    const del = (cookie: string) => DELETE(new Request(`${BASE}/api/candidate/account`, { method: "DELETE", body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json", origin: BASE, cookie } }));
    const p = person("c4");
    const first = await viaGoogle(p);
    expect(first.ok).toBe(true);
    expect(await count("select 1 from candidate_account a join candidate_user u on u.id = a.user_id where u.email = $1 and a.provider_id = 'credential'", [p.email])).toBe(0); // no password
    await su.query("update candidate_session s set created_at = now() - interval '11 minutes' from candidate_user u where u.id = s.user_id and u.email = $1", [p.email]);
    const stale = await del(first.callback.cookie);
    expect([stale.status, await stale.json()]).toEqual([403, { code: "REAUTH_REQUIRED" }]);
    expect((await call("change-email", { newEmail: "fake.g.c4.new@example.test" }, { cookie: first.callback.cookie })).json).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(await count("select 1 from candidate_user where email = $1 and deleted_at is null", [p.email])).toBe(1);
    // linking another Google account (C4 gap round): an attacker's own Google would keep access after a password reset
    const link = (cookie: string) => call("link-social", { provider: "google", callbackURL: "/account" }, { cookie });
    expect(await link(first.callback.cookie)).toMatchObject({ status: 403, json: { code: "REAUTH_REQUIRED" } });
    const again = await viaGoogle(p); // the re-ask: sign in with Google again
    const linked = await link(again.callback.cookie);
    expect([linked.status, new URL(linked.json!.url).hostname]).toEqual([200, "accounts.google.com"]);
    expect((await call("link-social", { provider: "google" })).status).toBe(401);
    expect(again.ok).toBe(true);
    expect((await del(again.callback.cookie)).status).toBe(200);
    expect(await count("select 1 from candidate_user where email = $1 and deleted_at is null", [p.email])).toBe(0);
  });
});
