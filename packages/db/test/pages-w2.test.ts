// Step 16 wave 2, agent W2 (P11 sign-up and sign-in pages, P12 permit services): the pages' server code and the routes behind them, end to end on the test
// database as app_candidate. Real Better Auth routes, real case routes, real reads through apps/candidate/lib/data.ts and the real page functions (a page is
// a function: it is called with its searchParams and its element is looked at or rendered). Only Next's request context is stood in (next/headers gives the
// headers a test sets, next/navigation's redirect throws as Next's does, server-only is empty) and BotID is the existing fake. The confirmation emails go to
// the app's own fake sender (candidateMail): no network. Fake data only.
// Budgets (measured 24 November 2026, see the printed line): statements per page render counted from the call, the session read included.
import { createHmac } from "node:crypto";
import pg from "pg";
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkBotId } from "botid/server";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { saveServicesTexts } from "../src/services-texts-cli";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("botid/server", () => ({ checkBotId: vi.fn() }));
const verdict = vi.mocked(checkBotId) as unknown as ReturnType<typeof vi.fn>;

// Statements counted from the call, the session read included: a visitor's pages read nothing signed-in; the notice is one gated public read (3 statements:
// two read-limit counts and the read), the occupation picker another, a job another; a signed-in candidate adds the session (2) and the case list (3).
const BUDGET = {
  statements: { landingVisitor: 3, landingSignedIn: 9, requestSignedIn: 9, requestWithJob: 14, loginVisitor: 0, signupVisitor: 0, verifyPage: 0, resetPage: 0, noAnswer: 3 },
  medianMs: 25,
  firstLoadKb: 275,
};
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Data = typeof import("../../../apps/candidate/lib/data");
let db: TestDb, su: pg.Pool, D: Data, mail: () => { pool: string; kind: string; to: string; link: string }[];
let AUTH_GET: Handler, AUTH: Handler, CASES: Handler, DOCS: Handler;
const P = {} as Record<"signup" | "login" | "verify" | "reset" | "landing" | "request", (a?: unknown) => Promise<{ type: { name: string }; props: Record<string, unknown> }>>;
let org: string, src: string;
const searchOf = (q: Record<string, string | string[] | undefined> = {}) => ({ searchParams: Promise.resolve(q) });

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  const c = await su.connect();
  try { await saveServicesTexts(c); } finally { c.release(); }
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: "http://localhost:3001" });
  ({ GET: AUTH_GET, POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ POST: CASES } = await import("../../../apps/candidate/app/api/candidate/cases/route"));
  ({ POST: DOCS } = await import("../../../apps/candidate/app/api/candidate/cases/[id]/documents/route"));
  ({ candidateMail: mail } = await import("../../../apps/candidate/lib/candidate"));
  D = await import("../../../apps/candidate/lib/data");
  const page = async (p: string) => (await import(p)).default;
  P.signup = await page("../../../apps/candidate/app/signup/page");
  P.login = await page("../../../apps/candidate/app/login/page");
  P.verify = await page("../../../apps/candidate/app/verify/page");
  P.reset = await page("../../../apps/candidate/app/reset/page");
  P.landing = await page("../../../apps/candidate/app/permit-services/page");
  P.request = await page("../../../apps/candidate/app/permit-services/request/page");
  org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-w2-org', 'Fake W2 Org', 'employer', 'verified') returning id")).rows[0].id;
  src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-w2') returning id")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `10.${((++n) >> 8) & 255}.${n & 255}.9`;
const json = { "content-type": "application/json", origin: BASE };
const post = (path: string, body: unknown, ip = freshIp()) => AUTH(new Request(`${BASE}/api/auth/candidate/${path}`, { method: "POST", headers: { ...json, "x-vercel-forwarded-for": ip }, body: JSON.stringify(body) }));
const open = (link: string | URL, ip = freshIp()) => AUTH_GET(new Request(link, { headers: { "x-vercel-forwarded-for": ip } }));
const as = <T>(cookie: string | undefined, fn: () => Promise<T>, ip = freshIp()): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip });
  return fn();
};
const body = async (r: Response) => ({ ...((await r.json().catch(() => ({}))) as { code?: string }), status: r.status });
const person = (tag: string) => ({ email: `fake.w2.${tag}${++n}${Date.now().toString(36)}@example.test`, password: "Fake-password-12345", name: `Fake ${tag}` });
const FULL = (p: { email: string; password: string; name: string }, callbackURL?: string) => ({ ...p, ...answers, ...(callbackURL ? { callbackURL } : {}) });
const mails = (to: string, kind?: string) => mail().filter((m) => m.to === to && (!kind || m.kind === kind));
async function member(tag: string, o: { verified?: boolean } = {}) {
  const p = person(tag);
  expect((await post("sign-up/email", FULL(p))).status).toBe(200);
  if (o.verified !== false) await su.query("update candidate_user set email_verified = true where email = $1", [p.email]);
  const r = o.verified === false ? null : await post("sign-in/email", { email: p.email, password: p.password });
  if (r) expect(r.status).toBe(200);
  const cookie = r ? r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") : undefined;
  return { ...p, cookie, id: (await su.query("select id from candidate_user where email = $1", [p.email])).rows[0].id as string };
}
const job = async (title: string, status = "live") => (await su.query(
  `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector, salary_low, salary_high, hidden_reason)
   values ($1, 'admin_manual', $2, $3, 'Fake W2 Employer', 'Cork', 'health', '2231', 'critical_skills', 'critical_skills_eligible', false, $4, now() + interval '20 days', 'https://example.test/a', to_tsvector('english','nurse'), 41000, 45000, case when $4 = 'hidden' then 'admin' end)
   returning id::text`, [org, src, title, status])).rows[0].id as string;
const caseBody = (jobId?: string, extra: object = {}) => ({ permitType: "critical_skills", ...(jobId ? { jobId } : {}), offerDetails: { occupationCode: "2231", annualPay: "42000", relevantDegree: "true", title: "Fake Nurse" }, servicesConsent: true, ...extra });
const request = (cookie: string | undefined, b: unknown, raw?: string) => CASES(new Request(`${BASE}/api/candidate/cases`, { method: "POST", headers: { ...json, "x-vercel-forwarded-for": freshIp(), ...(cookie ? { cookie } : {}) }, body: raw ?? JSON.stringify(b) }));
const redirectsTo = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return String((e as Error).message).replace("NEXT_REDIRECT ", ""); } return null; };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object, key = secret) => { const [h, p] = [b64({ alg: "HS256" }), b64(payload)]; return `${h}.${p}.${createHmac("sha256", key).update(`${h}.${p}`).digest("base64url")}`; };
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const t: number[] = [];
  for (let i = 0; i < 11; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[5]!;
};
const verifiedUrl = (next: string) => `/verify?verified=1&next=${encodeURIComponent(next)}`;

describe("emailed links land on our own pages (24 Nov 2026: a link without a landing address ended on the auth library's error page)", () => {
  it("sign-up verify link: a good link ends on /verify?verified=1 with the return address kept, the email is then verified, and the page shows the verified screen", async () => {
    const p = person("a"), next = "/jobs/staff-nurse-cork-4821?x=1&y=2";
    expect((await post("sign-up/email", FULL(p, verifiedUrl(next)))).status).toBe(200);
    const [m] = mails(p.email, "verify");
    expect(new URL(m!.link).origin).toBe(BASE);
    const r = await open(m!.link);
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!, BASE);
    expect([to.pathname, to.searchParams.get("verified"), to.searchParams.get("error"), to.searchParams.get("next")]).toEqual(["/verify", "1", null, next]);
    expect((await su.query("select email_verified from candidate_user where email = $1", [p.email])).rows[0].email_verified).toBe(true);
    const el = await as(undefined, () => P.verify(searchOf(Object.fromEntries(to.searchParams))));
    expect(el.props).toMatchObject({ signedIn: false, continueHref: next, loginHref: `/login?next=${encodeURIComponent(next)}` });
    expect(html(el as never)).toMatch(/Email[\s\S]*verified/);
    // the person then signs in with the password they chose
    expect((await post("sign-in/email", { email: p.email, password: p.password })).status).toBe(200);
  });
  it("used link: the library treats a confirmed address as done, so the same link lands on the verified screen again (not an error)", async () => {
    const p = person("used");
    await post("sign-up/email", FULL(p, "/verify?verified=1"));
    const link = mails(p.email, "verify")[0]!.link;
    expect((await open(link)).status).toBe(302);
    const again = await open(link);
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get("location")!, BASE).searchParams.get("error")).toBeNull();
    expect(new URL(again.headers.get("location")!, BASE).searchParams.get("verified")).toBe("1");
  });
  it("ended link and unknown or tampered token: the address gets ?error=, which the page words and wins over verified; nothing is verified", async () => {
    const p = person("ended");
    await post("sign-up/email", FULL(p, "/verify?verified=1"));
    const real = new URL(mails(p.email, "verify")[0]!.link);
    const userId = JSON.parse(Buffer.from(real.searchParams.get("token")!.split(".")[1]!, "base64url").toString()).userId as string;
    const now = Math.floor(Date.now() / 1000);
    const cb = "&callbackURL=%2Fverify%3Fverified%3D1";
    const cases: [string, string, string][] = [
      ["ended", jwt({ email: p.email, userId, iat: now - 7200, exp: now - 3600 }), "TOKEN_EXPIRED"],
      ["wrong signature", jwt({ email: p.email, userId, iat: now, exp: now + 3600 }, "another-secret-another-secret-another"), "INVALID_TOKEN"],
      ["not a token", "garbage", "INVALID_TOKEN"],
      ["tampered", `${real.searchParams.get("token")!.slice(0, -3)}abc`, "INVALID_TOKEN"],
    ];
    for (const [name, token, code] of cases) {
      const r = await open(`${BASE}/api/auth/candidate/verify-email?token=${token}${cb}`);
      expect(r.status, name).toBe(302);
      const to = new URL(r.headers.get("location")!, BASE);
      expect(to.searchParams.get("error"), name).toBe(code);
      const el = await as(undefined, () => P.verify(searchOf(Object.fromEntries(to.searchParams))));
      expect(el.props, name).toMatchObject({ email: null, initialFlash: { kind: "error" } });
      expect(String((el.props.initialFlash as { text: string }).text), name).toMatch(/expired or was already used/);
    }
    expect((await su.query("select email_verified from candidate_user where email = $1", [p.email])).rows[0].email_verified).toBe(false);
  });
  it("resend link: 'Resend email' passes the same landing address, and a new link verifies", async () => {
    const p = person("resend");
    await post("sign-up/email", FULL(p, "/verify?verified=1"));
    expect((await post("send-verification-email", { email: p.email, callbackURL: "/verify?verified=1" })).status).toBe(200);
    const [, second] = mails(p.email, "verify");
    const r = await open(second!.link);
    expect(new URL(r.headers.get("location")!, BASE).pathname).toBe("/verify");
    expect((await su.query("select email_verified from candidate_user where email = $1", [p.email])).rows[0].email_verified).toBe(true);
  });
  it("change of an unverified address ('Wrong address? Change it'): the new address gets a link that verifies it and ends on a path of our own site; the old link dies", async () => {
    const p = person("chg"), to = `fake.w2.moved${++n}@example.test`;
    await post("sign-up/email", FULL(p, "/verify?verified=1"));
    const oldLink = mails(p.email, "verify")[0]!.link;
    const r = await post("change-unverified-email", { email: p.email, password: p.password, newEmail: to, callbackURL: "/verify?verified=1" });
    expect(r.status).toBe(200);
    const sent = mails(to, "verify");
    expect(sent).toHaveLength(1);
    const landed = await open(sent[0]!.link);
    const loc = landed.headers.get("location")!;
    expect(landed.status).toBe(302);
    expect(loc.startsWith("/") && !loc.startsWith("//")).toBe(true); // an own path (today "/": the route does not pass the callbackURL on yet, see the report)
    expect((await su.query("select email_verified from candidate_user where email = $1", [to])).rows[0].email_verified).toBe(true);
    const old = new URL((await open(oldLink)).headers.get("location")!, BASE);
    expect(old.searchParams.get("error")).toBe("USER_NOT_FOUND"); // the old link names the old address: it no longer works
  });
  it("password reset link: the table's token, opened, lands on /reset?token=; a good reset ends the link; the used link and an ended link land on /reset?error=; a signed-in visitor keeps the token", async () => {
    const m = await member("reset");
    expect((await post("request-password-reset", { email: m.email, redirectTo: "/reset" })).status).toBe(200);
    const token = (await su.query("select identifier from candidate_verification where identifier like 'reset-password:%' order by id desc limit 1")).rows[0].identifier.split(":")[1] as string;
    const link = mails(m.email, "reset").at(-1)!.link;
    expect(link).toContain(`/reset-password/${token}`);
    expect(link).toContain("callbackURL=%2Freset");
    const r = await open(link);
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!, BASE);
    expect([to.pathname, to.searchParams.get("token")]).toEqual(["/reset", token]);
    const form = await as(undefined, () => P.reset(searchOf({ token })));
    expect(form.type.name).toBe("ResetFlow");
    const signed = await as(m.cookie, () => P.reset(searchOf({ token })));
    expect(signed.type.name).toBe("ResetFlow"); // opened in a browser that is already signed in: the token is kept
    expect(signed.props).toEqual({ token });
    expect(await as(m.cookie, () => redirectsTo(() => P.reset(searchOf({}))))).toBe("/jobs"); // the bare address sends them to their account
    expect((await post("reset-password", { token, newPassword: "Fake-new-password-2" })).status).toBe(200);
    expect((await post("sign-in/email", { email: m.email, password: "Fake-new-password-2" })).status).toBe(200);
    expect((await post("sign-in/email", { email: m.email, password: m.password })).status).toBe(401);
    const used = new URL((await open(link)).headers.get("location")!, BASE);
    expect([used.pathname, used.searchParams.get("error")]).toEqual(["/reset", "INVALID_TOKEN"]);
    const usedPage = await as(undefined, () => P.reset(searchOf(Object.fromEntries(used.searchParams))));
    expect(usedPage.type.name).toBe("ResetView");
    expect(html(usedPage as never)).toMatch(/expired or was already used/);
    expect(await body(await post("reset-password", { token, newPassword: "Fake-new-password-3" }))).toMatchObject({ status: 400, code: "INVALID_TOKEN" });
    // an ended link
    await post("request-password-reset", { email: m.email, redirectTo: "/reset" });
    await su.query("update candidate_verification set expires_at = now() - interval '1 minute' where identifier like 'reset-password:%'");
    const ended = new URL((await open(mails(m.email, "reset").at(-1)!.link)).headers.get("location")!, BASE);
    expect([ended.pathname, ended.searchParams.get("error")]).toEqual(["/reset", "INVALID_TOKEN"]);
  });
  it("a return address that is not ours is refused by the library before any email is sent (sign-up, resend and reset)", async () => {
    const p = person("evil");
    for (const cb of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const r = await post("sign-up/email", FULL(p, cb));
      expect(r.status, cb).toBe(403);
      expect((await post("request-password-reset", { email: p.email, redirectTo: cb })).status, cb).toBe(403);
    }
    expect(mails(p.email)).toHaveLength(0);
    expect((await su.query("select count(*)::int n from candidate_user where email = $1", [p.email])).rows[0].n).toBe(0);
  });
});

describe("the 'No' answer (C24, C5 #253): one day count, nothing else", () => {
  it("posting exactly what the form sends adds one to today's count, answers 400 SIGNUP_ANSWERS_REFUSED, and creates no user, no consent record, no session, no email", async () => {
    const { NO_ANSWER_BODY } = await import("../../../apps/candidate/app/(auth)/messages");
    const sum = async () => (await su.query("select coalesce(sum(count),0)::int n from signup_no_count")).rows[0].n as number;
    const rows = async () => [(await su.query("select count(*)::int n from candidate_user")).rows[0].n, (await su.query("select count(*)::int n from consent_record")).rows[0].n, (await su.query("select count(*)::int n from candidate_session")).rows[0].n, mail().length];
    const [before, kept] = [await sum(), await rows()];
    const [r, statements] = await counted(() => post("sign-up/email", NO_ANSWER_BODY));
    expect(await body(r)).toMatchObject({ status: 400, code: "SIGNUP_ANSWERS_REFUSED" });
    expect(await sum()).toBe(before + 1);
    expect(await rows()).toEqual(kept);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements.noAnswer);
    expect((await su.query("select column_name from information_schema.columns where table_name = 'signup_no_count' order by 1")).rows.map((x) => x.column_name)).toEqual(["count", "day"]); // no address, no IP
  });
});

describe("every answer code of the sign-up, sign-in, verify, reset and change-address routes reaches a clear sentence", () => {
  it("through the real routes: unverified, suspended, wrong password, unknown address, 429, answers, name, short password, taken address (never said), bot check", async () => {
    const { say } = await import("../../../apps/candidate/app/(auth)/messages");
    const said = async (flow: Parameters<typeof say>[0], r: Response) => { const b = await body(r); return { ...b, ...say(flow, { ok: r.ok, status: b.status, code: b.code }) }; };
    // unverified: 403 EMAIL_NOT_VERIFIED shows the check-your-email screen
    const unv = await member("unv", { verified: false });
    expect(await said("signin", await post("sign-in/email", { email: unv.email, password: unv.password }))).toMatchObject({ status: 403, code: "EMAIL_NOT_VERIFIED", screen: "check-email", text: "Your email is not verified yet." });
    // suspended: 403 with no code
    const sus = await member("sus");
    await su.query("update candidate_user set suspended_at = now() where id = $1", [sus.id]);
    const s = await said("signin", await post("sign-in/email", { email: sus.email, password: sus.password }));
    expect(s.status).toBe(403);
    expect(s.text).toMatch(/cannot sign in/);
    // wrong password and unknown address: the same answer, so the page cannot tell which
    const ok = await member("ok");
    const wrong = await said("signin", await post("sign-in/email", { email: ok.email, password: "wrong-password-1" }));
    const unknown = await said("signin", await post("sign-in/email", { email: "nobody.w2@example.test", password: "wrong-password-1" }));
    expect(wrong).toEqual(unknown);
    expect(wrong).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", text: "That email and password do not match. Try again or reset your password." });
    // sign-up
    const fresh = person("su");
    expect((await said("signup", await post("sign-up/email", { ...FULL(fresh), over18: false }))).text).toMatch(/18 or over/);
    expect((await said("signup", await post("sign-up/email", { ...FULL(fresh), name: "   " }))).text).toMatch(/name/);
    expect((await said("signup", await post("sign-up/email", { ...FULL(fresh), password: "short" }))).text).toMatch(/at least 8/);
    expect((await said("signup", await post("sign-up/email", { ...FULL(fresh), name: "x".repeat(101) }))).text).toMatch(/name/);
    // the same address twice: both answer 200 with the same shape, so the page says "check your email" either way and never "taken"
    const a = await post("sign-up/email", FULL(fresh)), b = await post("sign-up/email", FULL(fresh));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Object.keys(await a.json()).sort()).toEqual(Object.keys(await b.json()).sort());
    // reset and resend: never say whether the address has an account
    for (const email of [ok.email, "nobody.w2@example.test"]) expect(await body(await post("request-password-reset", { email, redirectTo: "/reset" }))).toMatchObject({ status: 200 });
    for (const email of [ok.email, "nobody.w2@example.test"]) expect((await post("send-verification-email", { email, callbackURL: "/verify?verified=1" })).status).toBe(200);
    expect(await said("reset", await post("reset-password", { token: "bad", newPassword: "Fake-password-12345" }))).toMatchObject({ status: 400, code: "INVALID_TOKEN", text: expect.stringMatching(/expired or was already used/) });
    // change of address: a wrong password and an unknown address are one answer; a verified account is ALREADY_VERIFIED
    const w = await said("change-email", await post("change-unverified-email", { email: unv.email, password: "wrong-password-1", newEmail: "x.w2@example.test" }));
    expect(w).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", text: expect.stringMatching(/password does not match/) });
    expect(await said("change-email", await post("change-unverified-email", { email: "nobody.w2@example.test", password: "wrong-password-1", newEmail: "x.w2@example.test" }))).toMatchObject({ status: 401 });
    expect(await said("change-email", await post("change-unverified-email", { email: ok.email, password: ok.password, newEmail: "y.w2@example.test" }))).toMatchObject({ status: 400, code: "ALREADY_VERIFIED", text: expect.stringMatching(/already verified/) });
    expect((await said("change-email", await post("change-unverified-email", { email: unv.email, password: unv.password, newEmail: "not-an-email" }))).text).toMatch(/real one/);
  });
  it("429: the sixth sign-in in a minute from one address, the fourth resend in five minutes, say 'too many tries'", async () => {
    const { say } = await import("../../../apps/candidate/app/(auth)/messages");
    const ip = freshIp(), p = person("rl");
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await post("sign-in/email", { email: p.email, password: "wrong-password-1" }, ip)).status;
    expect(last).toBe(429);
    expect(say("signin", { ok: false, status: 429 }).text).toMatch(/Too many tries/);
    const ip2 = freshIp(), r: number[] = [];
    for (let i = 0; i < 4; i++) r.push((await post("send-verification-email", { email: `rl${i}.w2@example.test`, callbackURL: "/verify?verified=1" }, ip2)).status);
    expect(r).toEqual([200, 200, 200, 429]);
    expect(say("resend", { ok: false, status: 429 }).text).toMatch(/Too many tries/);
  });
  it("bot check: BOT_SUSPECTED on every route the pages post to, before anything is read or written, worded as 'could not check that you are a person'", async () => {
    const { say } = await import("../../../apps/candidate/app/(auth)/messages");
    process.env.BOT_CHECK = "on";
    verdict.mockResolvedValue({ isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false });
    try {
      const users = (await su.query("select count(*)::int n from candidate_user")).rows[0].n;
      for (const [path, flow] of [["sign-up/email", "signup"], ["sign-in/email", "signin"], ["request-password-reset", "reset-request"], ["send-verification-email", "resend"], ["change-unverified-email", "change-email"]] as const) {
        const b = await body(await post(path, { email: "bot.w2@example.test", password: "Fake-password-12345", newEmail: "b2.w2@example.test", ...answers, name: "Fake Bot" }));
        expect(b, path).toMatchObject({ status: 403, code: "BOT_SUSPECTED" });
        expect(say(flow, { ok: false, status: 403, code: "BOT_SUSPECTED" }).text).toMatch(/person/);
      }
      expect((await su.query("select count(*)::int n from candidate_user")).rows[0].n).toBe(users);
    } finally { delete process.env.BOT_CHECK; verdict.mockReset(); }
  });
});

describe("the sign-up, sign-in, verify and reset pages (server code): render, redirect, metadata, hostile parameters", () => {
  it("a visitor gets each page, with no signed-in read and no statement; the Google button is hidden and the employer portal link comes from the setting", async () => {
    for (const [name, fn, key] of [["signup", () => P.signup(searchOf()), "signupVisitor"], ["login", () => P.login(searchOf()), "loginVisitor"], ["verify", () => P.verify(searchOf()), "verifyPage"], ["reset", () => P.reset(searchOf()), "resetPage"]] as const) {
      const [el, statements] = await counted(() => as(undefined, fn));
      expect(el.type, name).toBeTruthy();
      expect(statements, name).toBeLessThanOrEqual(BUDGET.statements[key]);
    }
    const page = html((await as(undefined, () => P.signup(searchOf({ next: "/jobs/a-1" })))) as never);
    expect(page).not.toMatch(/Continue with Google/);
    expect(page).toContain('href="http://localhost:3001/"');
    expect(page).toContain('href="/login?next=%2Fjobs%2Fa-1"');
  });
  it("a signed-in candidate on /signup or /login goes to the checked return address or the account; an open redirect never happens", async () => {
    const m = await member("pg");
    for (const p of [P.signup, P.login]) {
      expect(await as(m.cookie, () => redirectsTo(() => p(searchOf({ next: "/jobs/staff-nurse-cork-4821?x=1" }))))).toBe("/jobs/staff-nurse-cork-4821?x=1");
      expect(await as(m.cookie, () => redirectsTo(() => p(searchOf())))).toBe("/jobs");
      for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/%2F/evil.example", "/jobs/a\\b", "/login", "/api/auth/candidate/sign-out", `/${"a".repeat(1100)}`]) expect(await as(m.cookie, () => redirectsTo(() => p(searchOf({ next: bad })))), bad).toBe("/jobs");
      expect(await as(m.cookie, () => redirectsTo(() => p(searchOf({ next: ["/jobs/a-1", "//evil.example"] }))))).toBe("/jobs");
    }
  });
  it("a suspended or deleted candidate, a forged cookie and a visitor are all signed out to these pages (the form, not a redirect)", async () => {
    const sus = await member("sus2");
    await su.query("update candidate_user set suspended_at = now() where id = $1", [sus.id]);
    for (const cookie of [sus.cookie, "candidate.session_token=forged.value", undefined]) expect(await as(cookie, () => redirectsTo(() => P.login(searchOf()))), String(cookie)).toBeNull();
  });
  it("every page's metadata is noindex with a title of 60 characters or fewer and a description of 120 to 160", async () => {
    const metas = [(await import("../../../apps/candidate/app/signup/page")).generateMetadata, (await import("../../../apps/candidate/app/login/page")).generateMetadata, (await import("../../../apps/candidate/app/verify/page")).generateMetadata, (await import("../../../apps/candidate/app/reset/page")).generateMetadata];
    for (const [i, generateMetadata] of metas.entries()) {
      const f = ["signup", "login", "verify", "reset"][i]!;
      const m = generateMetadata();
      expect(m.robots, f).toEqual({ index: false, follow: false });
      expect(String(m.title).replace(" | Irish Work Permit", "").length, f).toBeLessThanOrEqual(60);
      expect(String(m.description).length, f).toBeGreaterThanOrEqual(120);
      expect(String(m.description).length, f).toBeLessThanOrEqual(160);
    }
    expect((await import("../../../apps/candidate/app/reset/page")).generateMetadata().referrer).toBe("no-referrer");
  });
  it("hostile parameters never break a page or reach its markup: huge, repeated, wrong-typed and script values", async () => {
    const evil = "<script>alert(1)</script>";
    for (const q of [{ error: evil }, { token: evil }, { next: evil }, { verified: evil, error: evil }, { error: ["a", "b"] }, { token: ["a", "b"] }, { next: "x".repeat(100_000) }, { token: "x".repeat(5000) }, { error: "\u0000" }]) {
      for (const p of [P.signup, P.login, P.verify, P.reset]) {
        const el = await as(undefined, () => p(searchOf(q as Record<string, string | string[]>)));
        const markup = html(el as never);
        expect(markup, JSON.stringify(q).slice(0, 50)).not.toContain(evil);
        expect(markup).not.toMatch(/dangerouslySetInnerHTML|undefined/);
      }
    }
  });
});

describe("the permit services pages (server code)", () => {
  it("the landing, by who is looking: visitor, signed in with no request, with only a closed request, with an open one, with several; one person never sees another's case", async () => {
    expect((await as(undefined, () => P.landing())).props).toMatchObject({ variant: "visitor", startHref: "/login?next=%2Fpermit-services%2Frequest" });
    const a = await member("land-a"), b = await member("land-b");
    expect((await as(a.cookie, () => P.landing())).props).toMatchObject({ variant: "no-case", startHref: "/permit-services/request" });
    const j1 = await job("Fake Nurse One");
    const r1 = await body(await request(a.cookie, caseBody(j1)));
    expect(r1.status).toBe(200);
    const c1 = (await su.query("select id::text from services_case where candidate_user_id = $1 order by id", [a.id])).rows[0].id as string;
    expect((await as(a.cookie, () => P.landing())).props).toMatchObject({ variant: "open-case", open: { count: 1, href: `/account/cases/${c1}` } });
    const other = await as(b.cookie, () => P.landing()); // the wrong user: no case of a's, and not a's case address
    expect(other.props.variant).toBe("no-case");
    expect(JSON.stringify(other.props)).not.toContain(`/account/cases/${c1}`);
    expect(html((await as(b.cookie, () => P.landing())) as never)).not.toContain(c1 === "" ? "x" : `cases/${c1}`);
    await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'withdrawn' where id = $1", [c1]);
    expect((await as(a.cookie, () => P.landing())).props.variant).toBe("no-case");
    const [j2, j3] = [await job("Fake Nurse Two"), await job("Fake Nurse Three")];
    await request(a.cookie, caseBody(j2));
    await request(a.cookie, caseBody(j3));
    expect((await as(a.cookie, () => P.landing())).props).toMatchObject({ variant: "open-case", open: { count: 2, href: "/account" } });
  });
  it("the DETE closed notice (#291) shows while staff have it published, as plain text, and disappears when withdrawn", async () => {
    await su.query("delete from content_page where kind = 'notice'");
    expect((await as(undefined, () => P.landing())).props.notice).toBeNull();
    await su.query("insert into content_page(kind, slug, title, body, status, published_at) values ('notice', 'dete-portal-closed', 'DETE portal closed', E'Cases wait.\\n<script>alert(1)</script>', 'published', now())");
    const el = await as(undefined, () => P.landing());
    expect(el.props.notice).toEqual({ title: "DETE portal closed", body: "Cases wait.\n<script>alert(1)</script>" });
    const markup = html(el as never);
    expect(markup).toMatch(/data-notice="closed"/);
    expect(markup).not.toContain("<script>alert(1)</script>");
    expect(markup).toContain("&lt;script&gt;");
    const m = await member("notice");
    expect(html((await as(m.cookie, () => P.request(searchOf()))) as never)).toMatch(/DETE portal closed/);
    await su.query("update content_page set status = 'withdrawn' where kind = 'notice'");
    expect((await as(undefined, () => P.landing())).props.notice).toBeNull();
  });
  it("the landing still renders when a read is refused: over the visitor limit the notice is hidden, the page does not fail", async () => {
    await su.query("update content_page set status = 'published' where kind = 'notice'");
    const ip = freshIp();
    for (let i = 0; i < 61; i++) await as(undefined, () => D.readPermitNotice(), ip);
    const el = await as(undefined, () => P.landing(), ip);
    expect(el.props.variant).toBe("visitor");
    expect(el.props.notice).toBeNull(); // the 429 hides the notice, it does not take the page down
    await su.query("update content_page set status = 'withdrawn' where kind = 'notice'");
  });
  it("the request form: a visitor goes to log in and comes back (the job kept only as digits); a signed-in candidate gets the form with every occupation", async () => {
    expect(await as(undefined, () => redirectsTo(() => P.request(searchOf({ job: "1042" }))))).toBe("/login?next=%2Fpermit-services%2Frequest%3Fjob%3D1042");
    for (const bad of ["1042x", "../1", "1".repeat(19), ["1", "2"], "1&next=//evil.example"]) expect(await as(undefined, () => redirectsTo(() => P.request(searchOf({ job: bad as string })))), JSON.stringify(bad)).toBe("/login?next=%2Fpermit-services%2Frequest");
    const m = await member("req");
    const el = await as(m.cookie, () => P.request(searchOf()));
    expect((el.props.occupations as unknown[]).length).toBeGreaterThan(300);
    expect(el.props.job).toBeNull();
  });
  it("?job= fills the form from a live job, only with the five fields the form needs; a closed, hidden or missing job is ignored; the markup holds no pay or outside address", async () => {
    const m = await member("reqjob");
    const live = await job("Fake Live Nurse"), closed = await job("Fake Closed Nurse", "closed"), hidden = await job("Fake Hidden Nurse", "hidden");
    const el = await as(m.cookie, () => P.request(searchOf({ job: live })));
    expect(el.props.job).toEqual({ id: live, title: "Fake Live Nurse", employerName: "Fake W2 Employer", occupationCode: "2231", contractMonths: null });
    const markup = html(el as never);
    expect(markup).not.toMatch(/41000|example\.test\/a/);
    expect(markup).toMatch(/name="employerContact"/);
    for (const id of [closed, hidden, "999999"]) expect((await as(m.cookie, () => P.request(searchOf({ job: id })))).props.job, id).toBeNull();
  });
  it("the page never shows another person's address or id: a request page and a landing contain no other candidate's email", async () => {
    const a = await member("leak-a"), b = await member("leak-b");
    for (const [cookie, who] of [[a.cookie, b], [b.cookie, a]] as const) {
      const markup = html((await as(cookie, () => P.request(searchOf()))) as never) + html((await as(cookie, () => P.landing())) as never);
      expect(markup).not.toContain(who.email);
      expect(markup).not.toMatch(/session_token|passwordHash|candidate_user/);
    }
  });
  it("title, description and noindex of the two pages", async () => {
    const l = (await import("../../../apps/candidate/app/permit-services/page")).generateMetadata();
    const r = (await import("../../../apps/candidate/app/permit-services/request/page")).generateMetadata();
    for (const m of [l, r]) {
      expect(String(m.title).replace(" | Irish Work Permit", "").length).toBeLessThanOrEqual(60);
      expect(String(m.description).length).toBeGreaterThanOrEqual(120);
      expect(String(m.description).length).toBeLessThanOrEqual(160);
    }
    expect(r.robots).toEqual({ index: false, follow: false });
  });
});

describe("every answer code of the request and upload routes reaches a clear sentence (the form's error states)", () => {
  it("through the real routes: not verified, job gone, already open, the limit of 5, bad body, too large, wrong origin, no session", async () => {
    const { say } = await import("../../../apps/candidate/app/(auth)/messages");
    const said = async (r: Response) => { const b = await body(r); return { ...b, ...say("request", { ok: r.ok, status: b.status, code: b.code }) }; };
    const m = await member("codes");
    const closed = await job("Fake Gone Nurse", "closed");
    expect(await said(await request(m.cookie, caseBody(closed)))).toMatchObject({ status: 404, code: "JOB_NOT_FOUND", text: expect.stringMatching(/no longer listed/) });
    expect(await said(await request(m.cookie, caseBody(undefined, { offerDetails: { annualPay: "x".repeat(600) } })))).toMatchObject({ status: 400, code: "BAD_REQUEST", text: expect.stringMatching(/Check the details/) });
    expect(await said(await request(m.cookie, { permitType: "critical_skills" }))).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await said(await request(m.cookie, undefined, "x".repeat(5000)))).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    expect(await said(await request(undefined, caseBody()))).toMatchObject({ status: 401, code: "NO_SESSION", text: expect.stringMatching(/Log in again/) });
    const wrongOrigin = await CASES(new Request(`${BASE}/api/candidate/cases`, { method: "POST", headers: { ...json, origin: "https://evil.example", cookie: m.cookie!, "x-vercel-forwarded-for": freshIp() }, body: JSON.stringify(caseBody()) }));
    expect(await body(wrongOrigin)).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect((await said(await request(m.cookie, caseBody()))).status).toBe(200); // the first with no job
    expect(await said(await request(m.cookie, caseBody()))).toMatchObject({ status: 409, code: "CASE_ALREADY_OPEN", text: expect.stringMatching(/already have an open request/) });
    for (let i = 0; i < 4; i++) expect((await request(m.cookie, caseBody(await job(`Fake Many ${i}`)))).status).toBe(200);
    expect(await said(await request(m.cookie, caseBody(await job("Fake Fifth"))))).toMatchObject({ status: 409, code: "CASE_LIMIT", text: expect.stringMatching(/5 open requests/) });
    // not verified: an account whose email stopped being confirmed after it signed in (the form shows the verify prompt)
    const v = await member("codes2");
    await su.query("update candidate_user set email_verified = false where id = $1", [v.id]);
    expect(await said(await request(v.cookie, caseBody()))).toMatchObject({ status: 403, code: "NOT_VERIFIED", screen: "check-email" });
    // suspended: REFUSED
    const s = await member("codes3");
    await su.query("update candidate_user set suspended_at = now() where id = $1", [s.id]);
    expect(await said(await request(s.cookie, caseBody()))).toMatchObject({ status: 403, code: "REFUSED", text: expect.stringMatching(/cannot ask for permit help/) });
  });
  it("uploads: no file, a wrong type, another person's case, a visitor, and where storage is not set up, each say what to do", async () => {
    const { say } = await import("../../../apps/candidate/app/(auth)/messages");
    const m = await member("up"), other = await member("up2");
    await request(m.cookie, caseBody());
    const id = (await su.query("select id::text from services_case where candidate_user_id = $1", [m.id])).rows[0].id as string;
    const up = async (cookie: string | undefined, form: FormData | string, caseId = id) => {
      const r = await DOCS(new Request(`${BASE}/api/candidate/cases/${caseId}/documents`, { method: "POST", headers: { origin: BASE, "x-vercel-forwarded-for": freshIp(), ...(cookie ? { cookie } : {}) }, body: form }), { params: Promise.resolve({ id: caseId }) });
      const b = await body(r);
      return { ...b, text: say("upload", { ok: r.ok, status: b.status, code: b.code }).text };
    };
    const file = (bytes: BlobPart, name = "a.pdf") => { const f = new FormData(); f.set("file", new File([bytes], name)); return f; };
    expect(await up(undefined, file("x"))).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect((await up(m.cookie, "not multipart")).code).toBe("BAD_REQUEST");
    expect((await up(m.cookie, "not multipart")).text).toMatch(/Choose one PDF, JPG or PNG/);
    expect(await up(other.cookie, file("x"))).toMatchObject({ status: 404, code: "CASE_NOT_FOUND", text: expect.stringMatching(/could not find that request/) });
    const typed = await up(m.cookie, file("this is plain text, not a pdf"));
    expect([415, 503]).toContain(typed.status); // 415 WRONG_FILE_TYPE, or 503 FILES_UNAVAILABLE where no file store is set up in the test run
    expect(typed.text).toMatch(/Upload a PDF, JPG or PNG|not open yet/);
  });
});

describe("performance: the pages' reads stay within their statement and time budgets", () => {
  it("landing: a visitor, a signed-in candidate; request form: signed in, with a job", async () => {
    const m = await member("perf"), live = await job("Fake Perf Nurse");
    await su.query("delete from content_page where kind = 'notice'");
    const rows: Record<string, number> = {};
    const runs: [string, () => Promise<unknown>, number][] = [
      ["landingVisitor", () => as(undefined, () => P.landing()), BUDGET.statements.landingVisitor],
      ["landingSignedIn", () => as(m.cookie, () => P.landing()), BUDGET.statements.landingSignedIn],
      ["requestSignedIn", () => as(m.cookie, () => P.request(searchOf())), BUDGET.statements.requestSignedIn],
      ["requestWithJob", () => as(m.cookie, () => P.request(searchOf({ job: live }))), BUDGET.statements.requestWithJob],
    ];
    for (const [name, run, limit] of runs) {
      const [, statements] = await counted(run);
      rows[name] = statements;
      expect(statements, name).toBeLessThanOrEqual(limit);
      const ms = await median(run);
      rows[`${name}Ms`] = Math.round(ms * 10) / 10;
      expect(ms, name).toBeLessThan(BUDGET.medianMs);
    }
    process.stdout.write(`W2 pages: ${JSON.stringify(rows)}\n`);
  });
});

describe("the six checks' security rows that need the routes: no field a role must not see", () => {
  it("the free check and the case the request route returns hold no staff name, id or note", async () => {
    const m = await member("shape");
    const r = await request(m.cookie, caseBody(await job("Fake Shape Nurse")));
    const text = JSON.stringify(await r.json());
    expect(Object.keys(JSON.parse(text).case).sort()).toEqual(["createdAt", "decisionOutcome", "documentCount", "documentsNeeded", "employerName", "id", "jobId", "jobTitle", "lastChangeAt", "payer", "permitType", "status"]);
    expect(text).not.toMatch(/"(staff\w*|handler\w*|assign\w*|notes?|referral\w*)"\s*:/i);
    expect(text).toMatch(/freeCheck/);
  });
  it("the page markup of a signed-in candidate sets no cookie and holds no token of the reset or verify routes", async () => {
    const m = await member("tok");
    const markup = html((await as(m.cookie, () => P.landing())) as never) + html((await as(m.cookie, () => P.request(searchOf()))) as never);
    expect(markup).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/); // no JWT
    expect(markup).not.toMatch(/set-cookie|reset-password:/i);
  });
});
