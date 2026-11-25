// Step 16 page slice P13 (employer landing, sign-up, sign-in, verification): the pages' server code and the emailed links on the test database, through the real routes of
// apps/portal with real portal sessions. Only Next's own request context is stood in (server-only, next/headers, next/navigation's redirect); no test reaches the network, the
// email sender is the fake one that keeps its messages. Fake people and companies only. Also holds the statement and time budgets of the pages (check 5) and the role, hostile
// input and open-redirect tests (check 6).
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { normaliseCompanyName } from "../src/registers";

const ctx = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => ctx.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  useRouter: () => ({ replace() {}, refresh() {} }),
}));

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
// Budgets (check 5), measured 24 Nov 2026 (printed lines): statements per page render and the median of 9 warm renders; about 2 times the statements, and a time floor for a busy laptop.
const BUDGET = { landing: 1, claim: 6, verification: 14, terms: 6, ms: 60 }; // measured: landing 0, claim 3, verification 7, terms 3 statements; medians 1 to 4 ms

type Page = (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<import("react").ReactElement>;
let db: TestDb, su: pg.Pool, AUTH: { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
let D: typeof import("../../../apps/portal/lib/data");
let M: typeof import("../../../apps/portal/lib/portal");
let MSG: typeof import("../../../apps/portal/app/(auth)/messages");
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };
const pages: Record<string, Page> = {};
const ROUTES: Record<string, Record<string, (r: Request) => Promise<Response>>> = {};

// The page modules are .tsx files and this package has no JSX setting: their paths are held in variables (the type checker does not follow them) and typed by hand.
const load = async (rel: string): Promise<Page> => ((await import(/* @vite-ignore */ `../../../apps/portal/app/${rel}`)) as { default: Page }).default;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret, CANDIDATE_AUTH_URL: "https://candidates.example.test" });
  AUTH = (await import("../../../apps/portal/app/api/auth/portal/[...all]/route")) as typeof AUTH;
  for (const [k, p] of [["claim", "claim"], ["search", "claim/search"], ["register", "register"], ["answer", "review-answer"], ["team", "team"]] as const)
    ROUTES[k] = (await import(/* @vite-ignore */ `../../../apps/portal/app/api/portal/${p}/route`)) as never;
  D = await import("../../../apps/portal/lib/data");
  M = await import("../../../apps/portal/lib/portal");
  MSG = await import("../../../apps/portal/app/(auth)/messages");
  for (const [k, f] of Object.entries({ landing: "page", signIn: "(auth)/sign-in/page", signUp: "(auth)/sign-up/page", account: "(auth)/sign-up/account/page", claim: "(auth)/sign-up/claim/page", first: "(auth)/sign-up/first-time/page",
    agency: "(auth)/sign-up/agency/page", forgot: "(auth)/forgot-password/page", reset: "(auth)/reset-password/page", verifyEmail: "(auth)/verify-email/page", verification: "verification/page",
    accept: "team/accept/page", terms: "terms/page", privacy: "privacy/page", dashboard: "dashboard/page" })) pages[k] = await load(f);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const ip = () => `198.51.100.${(++n % 200) + 10}`;
const post = (path: string, body: unknown, address = ip()) => AUTH.POST(new Request(`${BASE}/api/auth/portal/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": address }, body: JSON.stringify(body) }));
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const PASSWORD = "Fake-password-12345";

/** A signed-up login. `verified` marks its email confirmed in the database (sign-in needs it); the cookie is for the page's request headers. */
async function login(o: { verified?: boolean; email?: string; callbackURL?: string } = {}) {
  const email = o.email ?? `fake.p13.${++n}.${Date.now().toString(36)}@example.test`;
  const r = await post("sign-up/email", { email, password: PASSWORD, name: "Fake Person", ...portalAnswers, ...(o.callbackURL ? { callbackURL: o.callbackURL } : {}) });
  expect(r.status).toBe(200);
  const id = (await one("select id from portal_user where email=$1", [email])).id as string;
  if (o.verified === false) return { email, id, cookie: "" };
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const s = await post("sign-in/email", { email, password: PASSWORD });
  expect(s.status).toBe(200);
  return { email, id, cookie: s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
type Who = { email: string; id: string; cookie: string };
/** A company in `status` whose `role` member is `who`; the owner of it is `who` when the role is account_owner. */
async function company(status: string, who: Who, role = "account_owner", o: { cro?: string | null; name?: string } = {}) {
  const org = String(await F.org({ status, name: o.name ?? "Fake Payments Limited", cro: o.cro === undefined ? null : o.cro }));
  await F.member(org, who.id, { role, signer: role === "account_owner" });
  return org;
}
/** Runs `fn` as a request carrying `cookie` (none: a visitor). */
const as = <T>(cookie: string | undefined, fn: () => Promise<T>): Promise<T> => { ctx.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip() }); return fn(); };
type El = import("react").ReactElement<unknown> & { type: (p: unknown) => unknown };
/** The page as HTML. A page that is an element of an async component (the legal pages) has that component run first, as Next does. */
const open = (name: string, cookie: string | undefined, q: Record<string, string | string[] | undefined> = {}) => as(cookie, async () => {
  let el = (await pages[name]!({ searchParams: Promise.resolve(q) })) as unknown as El;
  while (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") el = (await el.type(el.props)) as El;
  return renderToStaticMarkup(el);
});
/** The address a page redirects to, or null when it rendered. */
async function redirectOf(name: string, cookie: string | undefined, q: Record<string, string | string[] | undefined> = {}): Promise<string | null> {
  try { await open(name, cookie, q); return null; } catch (e) { return (e as { url?: string }).url ?? Promise.reject(e); }
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => { const ms: number[] = []; for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); } return ms.sort((a, b) => a - b)[4]!; };
const call = async (h: (r: Request) => Promise<Response>, cookie: string, body?: unknown, url = `${BASE}/api/portal/x`) => {
  const res = await h(new Request(url, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json.code as string | undefined, json };
};
const mailTo = (email: string, kind: string) => M.portalMail().filter((m) => m.to === email && m.kind === kind).at(-1)!;

describe("emailed links end on our own pages (24 Nov lesson)", () => {
  it("sign-up verification: a good link confirms the address and lands on /verify-email with the return path; an opened link again, and an ended one, land there too", async () => {
    const next = "/sign-up/agency";
    const cb = `/verify-email?next=${encodeURIComponent(next)}`;
    const who = await login({ verified: false, callbackURL: cb });
    const link = mailTo(who.email, "verify").link;
    expect(new URL(link).origin).toBe(BASE);
    expect(new URL(link).searchParams.get("callbackURL")).toBe(cb);
    const good = await AUTH.GET(new Request(link));
    expect(good.status).toBe(302);
    const to = new URL(good.headers.get("location")!, BASE);
    expect(to.pathname).toBe("/verify-email");
    expect(to.searchParams.get("next")).toBe(next);
    expect(to.searchParams.has("error")).toBe(false);
    expect((await one("select email_verified from portal_user where email=$1", [who.email])).email_verified).toBe(true);
    const again = await AUTH.GET(new Request(link)); // an address already confirmed: still our page, never the library's error page
    expect(new URL(again.headers.get("location")!, BASE).pathname).toBe("/verify-email");
    // the page the good link ends on
    const p = await open("verifyEmail", undefined, Object.fromEntries(to.searchParams));
    expect(p).toMatch(/Email <span[^>]*>confirmed/);
    expect(p).toContain(`href="/sign-in?next=${encodeURIComponent(next)}"`);
    // an ended link (1 hour: ask the clock 2 hours on)
    const late = await login({ verified: false, callbackURL: cb });
    const old = mailTo(late.email, "verify").link;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 3600_000 });
    let ended: Response;
    try { ended = await AUTH.GET(new Request(old)); } finally { vi.useRealTimers(); }
    const end = new URL(ended.headers.get("location")!, BASE);
    expect(end.pathname).toBe("/verify-email");
    expect(end.searchParams.has("error")).toBe(true);
    expect((await one("select email_verified from portal_user where email=$1", [late.email])).email_verified).toBe(false);
    const pe = await open("verifyEmail", undefined, Object.fromEntries(end.searchParams));
    expect(pe).toMatch(/does not work/);
    expect(pe).toMatch(/type="email"/); // the resend form
    // a forged token: still our page
    const forged = await AUTH.GET(new Request(`${BASE}/api/auth/portal/verify-email?token=abc.def.ghi&callbackURL=${encodeURIComponent(cb)}`));
    expect(new URL(forged.headers.get("location")!, BASE).pathname).toBe("/verify-email");
  });
  it("resend: send-verification-email with our callback sends a new link that lands on our page", async () => {
    const who = await login({ verified: false });
    const cb = "/verify-email";
    expect((await post("send-verification-email", { email: who.email, callbackURL: cb })).status).toBe(200);
    const link = mailTo(who.email, "verify").link;
    const r = await AUTH.GET(new Request(link));
    expect(new URL(r.headers.get("location")!, BASE).pathname).toBe("/verify-email");
  });
  it("sign-in before the address is confirmed is 403 EMAIL_NOT_VERIFIED, and the page's message says to confirm it", async () => {
    const who = await login({ verified: false });
    const r = await post("sign-in/email", { email: who.email, password: PASSWORD });
    const body = await r.json();
    expect([r.status, body.code]).toEqual([403, "EMAIL_NOT_VERIFIED"]);
    expect(MSG.signInMessage({ status: r.status, code: body.code })).toMatch(/Confirm your email/);
  });
  it("password reset: a good link lands on /reset-password with its token (also for a signed-in visitor), a used link and an ended link land there with an error", async () => {
    const who = await login();
    expect((await post("request-password-reset", { email: who.email, redirectTo: "/reset-password" })).status).toBe(200);
    const link = mailTo(who.email, "reset").link;
    const token = new URL(link).pathname.split("/").at(-1)!;
    expect((await one("select count(*)::int c from portal_verification where identifier = $1", [`reset-password:${token}`])).c).toBe(1); // the link's token is the table's
    const good = await AUTH.GET(new Request(link));
    const to = new URL(good.headers.get("location")!, BASE);
    expect([to.pathname, to.searchParams.get("token")]).toEqual(["/reset-password", token]);
    // the page: the form for a token, also when the visitor is already signed in (the token is kept, nobody is redirected away)
    for (const cookie of [undefined, who.cookie]) {
      const p = await open("reset", cookie, { token });
      expect(p).toMatch(/Repeat new password/);
    }
    expect((await post("reset-password", { newPassword: "Fake-new-password-12345", token })).status).toBe(200);
    const used = new URL((await AUTH.GET(new Request(link))).headers.get("location")!, BASE);
    expect(used.pathname).toBe("/reset-password");
    expect(used.searchParams.get("error")).toBe("INVALID_TOKEN");
    expect(await open("reset", undefined, { error: "INVALID_TOKEN" })).toMatch(/does not work/);
    // ended
    expect((await post("request-password-reset", { email: who.email, redirectTo: "/reset-password" }, ip())).status).toBe(200);
    const link2 = mailTo(who.email, "reset").link;
    const t2 = new URL(link2).pathname.split("/").at(-1)!;
    await su.query("update portal_verification set expires_at = now() - interval '1 minute' where identifier = $1", [`reset-password:${t2}`]);
    const ended = new URL((await AUTH.GET(new Request(link2))).headers.get("location")!, BASE);
    expect([ended.pathname, ended.searchParams.get("error")]).toEqual(["/reset-password", "INVALID_TOKEN"]);
  });
  it("a bad or missing token, or a token of the wrong type, gives the 'does not work' state, never the form", async () => {
    for (const q of [{}, { token: "" }, { token: ["a", "b"] }, { token: "x".repeat(201) }, { token: "ok", error: "INVALID_TOKEN" }])
      expect(await open("reset", undefined, q), JSON.stringify(q)).toMatch(/does not work/);
  });
});

describe("where each login goes (landing, sign-in, dashboard)", () => {
  it("no company: the claim step; in review or asked for more: the verification page; live: the dashboard; a visitor sees the landing and the sign-in form", async () => {
    const none = await login(), pending = await login(), needs = await login(), live = await login();
    await company("pending_review", pending);
    await company("needs_info", needs);
    await company("verified", live);
    expect(await redirectOf("landing", none.cookie)).toBe("/sign-up/claim");
    expect(await redirectOf("landing", pending.cookie)).toBe("/verification");
    expect(await redirectOf("landing", needs.cookie)).toBe("/verification");
    expect(await redirectOf("landing", live.cookie)).toBe("/dashboard");
    expect(await redirectOf("signIn", live.cookie)).toBe("/dashboard");
    expect(await redirectOf("signIn", none.cookie, { next: "/team/accept?token=abc" })).toBe("/team/accept?token=abc");
    expect(await redirectOf("account", none.cookie)).toBe("/sign-up/claim");
    expect(await redirectOf("forgot", pending.cookie)).toBe("/verification");
    expect(await redirectOf("dashboard", none.cookie)).toBe("/sign-up/claim");
    expect(await redirectOf("dashboard", pending.cookie)).toBe("/verification");
    expect(await redirectOf("dashboard", undefined)).toBe("/sign-in");
    expect(await open("dashboard", live.cookie)).toMatch(/Good (morning|afternoon|evening)/); // P18 replaced the stand-in page
    const landing = await open("landing", undefined);
    expect(landing).toMatch(/Hire people/);
    expect(landing.match(/<h1/g)).toHaveLength(1);
    expect(landing).toContain('href="https://candidates.example.test/"'); // For candidates, from CANDIDATE_AUTH_URL
    expect(await open("signIn", undefined)).toMatch(/Employer <span[^>]*>sign in/);
    expect(await open("signUp", undefined)).toMatch(/name="kind"/);
    expect(await open("account", undefined, { kind: "agency" })).toMatch(/Next you give your agency licence/);
  });
  it("a forged cookie, a blocked login and a deleted login are visitors", async () => {
    const who = await login(), blocked = await login(), gone = await login();
    await company("verified", who);
    await su.query("update portal_user set status='blocked' where id=$1", [blocked.id]);
    await su.query("update portal_user set deleted_at=now() where id=$1", [gone.id]);
    for (const cookie of [who.cookie.replace(/=[^;]+/g, "=forged"), blocked.cookie, gone.cookie]) expect(await redirectOf("landing", cookie)).toBeNull();
  });
});

describe("the sign-up steps (E03, E04, E05)", () => {
  it("each step needs a login with no company: a visitor goes to sign-in and back, a login with a company goes home", async () => {
    const none = await login(), pending = await login(), live = await login();
    await company("pending_review", pending);
    await company("verified", live);
    for (const [name, path] of [["claim", "/sign-up/claim"], ["first", "/sign-up/first-time"], ["agency", "/sign-up/agency"]] as const) {
      expect(await redirectOf(name, undefined), name).toBe(`/sign-in?next=${encodeURIComponent(path)}`);
      expect(await redirectOf(name, pending.cookie), name).toBe("/verification");
      expect(await redirectOf(name, live.cookie), name).toBe("/dashboard");
      const page = await open(name, none.cookie);
      expect(page, name).toContain(none.email);
      expect(page.match(/data-slot="public-data-credit"/g)?.length ?? 0, name).toBe(name === "agency" ? 0 : 1); // S14: the two steps that show CRO register rows credit the CRO
    }
  });
  it("the first-time step looks up a CRO number the claim step handed over: found in the register, none, already on the site; a free email provider gets the review note", async () => {
    const who = await login({ email: `fake.free.${Date.now().toString(36)}@gmail.com` });
    await su.query("insert into cro_company(cro_number, name, normalised_name, status, county, last_seen_on) values ('881001','FAKE REGISTER LIMITED',$1,'Normal','Cork',current_date)", [normaliseCompanyName("FAKE REGISTER LIMITED")]);
    await su.query("insert into organisation(slug, display_name, kind, status, cro_number) values ('fake-site-co','Fake Site Co Limited','employer','unclaimed','881002')");
    const found = await open("first", who.cookie, { cro: "881001", name: "FAKE REGISTER LIMITED" });
    expect(found).toMatch(/Found: FAKE REGISTER LIMITED · Cork/);
    expect(found).toMatch(/free email provider/);
    expect(await open("first", who.cookie, { cro: "IE 881001" })).toMatch(/Found: FAKE REGISTER LIMITED/);
    expect(await open("first", who.cookie, { cro: "881099" })).toMatch(/did not find this number/);
    expect(await open("first", who.cookie, { cro: "881002" })).toMatch(/already on the site/);
    const work = await login();
    expect(await open("first", work.cookie)).not.toMatch(/free email provider/);
  });
  it("the claim search route finds companies and register rows, and every refusal the claim and register routes give has its own message", async () => {
    const a = await login(), b = await login(), c = await login();
    await su.query("insert into organisation(slug, display_name, kind, status, cro_number) values ('fake-claim-co','Fake Claim Company Limited','employer','unclaimed','882001')");
    await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) select id, display_name, $1, 'legal', 'dete' from organisation where slug='fake-claim-co'", [normaliseCompanyName("Fake Claim Company Limited")]);
    const search = await call(ROUTES.search!.GET!, a.cookie, undefined, `${BASE}/api/portal/claim/search?q=fake%20claim`);
    expect(search.status).toBe(200);
    const id = (search.json.results as { organisationId: string; name: string }[])[0]!;
    expect(id.name).toBe("Fake Claim Company Limited");
    const codes: [string, number, string][] = [];
    const claim = await call(ROUTES.claim!.POST!, a.cookie, { organisationId: id.organisationId });
    expect(claim.status).toBe(200);
    expect(["verified", "pending_review"]).toContain(claim.json.status);
    for (const [who, body, route] of [[a, { organisationId: id.organisationId }, "claim"], [b, { organisationId: id.organisationId }, "claim"], [b, { kind: "employer", displayName: "Fake Dup Limited", croNumber: "882001" }, "register"]] as const) {
      const r = await call(ROUTES[route]!.POST!, who.cookie, body);
      codes.push([route, r.status, r.code!]);
    }
    expect(codes).toEqual([["claim", 409, "ALREADY_IN_A_COMPANY"], ["claim", 409, "ORGANISATION_NOT_AVAILABLE"], ["register", 409, "NUMBER_ALREADY_REGISTERED"]]);
    const words = new Set(codes.map(([, status, code]) => MSG.companyMessage({ status, code })));
    expect(words.size).toBe(3);
    // an unconfirmed email is refused by the database function itself, with its own code
    await su.query("update portal_user set email_verified=false where id=$1", [c.id]);
    const r = await call(ROUTES.claim!.POST!, c.cookie, { organisationId: "1" });
    expect(MSG.companyMessage({ status: r.status, code: r.code })).toMatch(/\S/);
    // the register route for a new company, then the verification page shows it
    const d = await login();
    const reg = await call(ROUTES.register!.POST!, d.cookie, { kind: "agency", displayName: "Fake Agency Limited", wrcLicenceNumber: "EA7001" });
    expect([reg.status, reg.json.status]).toEqual([200, "pending_review"]);
    expect(await open("verification", d.cookie)).toMatch(/in review/);
  });
});

describe("verification (E06)", () => {
  it("signed out goes to sign-in, no company goes to the claim step", async () => {
    const none = await login();
    expect(await redirectOf("verification", undefined)).toBe("/sign-in?next=%2Fverification");
    expect(await redirectOf("verification", none.cookie)).toBe("/sign-up/claim");
  });
  it("in review: the email, the CRO row, the DETE match and the time the review opened, from the real read", async () => {
    const o = await login();
    const org = await company("pending_review", o, "account_owner", { cro: "883001" });
    await su.query("insert into cro_company(cro_number, name, normalised_name, status, county, last_seen_on) values ('883001','FAKE VERIFY LIMITED','fake verify','Normal','Cork',current_date)");
    await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'claim')", [org]);
    const p = await open("verification", o.cookie);
    for (const t of [o.email, "CRO record found", "FAKE VERIFY LIMITED · Normal", "Not in the permit records", "In the queue since"]) expect(p).toContain(t);
    expect(p).not.toMatch(/organisationId|"id"/);
  });
  it("needs more info: the owner sees the question and the box; a poster and a viewer see neither the question nor a box, and a viewer no draft link", async () => {
    const o = await login(), poster = await login(), viewer = await login();
    const org = await company("needs_info", o);
    await F.member(org, poster.id, { role: "poster" });
    await F.member(org, viewer.id, { role: "viewer" });
    await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'claim')", [org]);
    await su.query("insert into notification(portal_user_id, organisation_id, category, template_key, params) values ($1,$2,'account','account_needs_info',$3)", [o.id, org, JSON.stringify({ question: "Please tell us which director signed up." })]);
    const owner = await open("verification", o.cookie);
    expect(owner).toContain("Please tell us which director signed up.");
    expect(owner).toMatch(/<textarea/);
    for (const who of [poster, viewer]) {
      const html = await open("verification", who.cookie);
      expect(html).toMatch(/Ask them to open this page/);
      expect(html).not.toMatch(/which director|<textarea/);
    }
    expect(await open("verification", poster.cookie)).toMatch(/Draft a job/); // P19 built /jobs/new (JOB_FORM_LIVE is true)
    expect(await open("verification", viewer.cookie)).not.toMatch(/Draft a job/);
  });
  it("the answer: the owner's note moves the company back to review; a member who is not the owner is refused, and that answer has a message", async () => {
    const o = await login(), poster = await login();
    const org = await company("needs_info", o);
    await F.member(org, poster.id, { role: "poster" });
    await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'claim')", [org]);
    const refused = await call(ROUTES.answer!.POST!, poster.cookie, { note: "Hello" });
    expect([refused.status, refused.code]).toEqual([403, "REFUSED"]);
    expect(MSG.answerMessage({ status: refused.status, code: refused.code })).toMatch(/account owner/);
    expect((await call(ROUTES.answer!.POST!, o.cookie, { note: "Our CRO number is on the letterhead." })).status).toBe(200);
    expect(await open("verification", o.cookie)).not.toMatch(/We need one more thing/);
    const again = await call(ROUTES.answer!.POST!, o.cookie, { note: "Again" });
    expect([again.status, again.code]).toEqual([409, "NOT_WAITING_FOR_ANSWER"]);
  });
  it("live and ended companies have their own states", async () => {
    const live = await login(), gone = await login();
    await company("verified", live);
    await company("rejected", gone);
    expect(await open("verification", live.cookie)).toMatch(/Your account is <span[^>]*>live/);
    expect(await open("verification", gone.cookie)).toMatch(/not active/);
  });
});

describe("the team invitation link", () => {
  const token = "A".repeat(43);
  it("a bad or missing token is an error state; a visitor is sent to sign in or sign up and back, with the token in the return path", async () => {
    for (const q of [{}, { token: "short" }, { token: ["a", "b"] }, { token: "A".repeat(44) }, { token: "A".repeat(42) + "<" }, { token: "../../etc" }])
      expect(await open("accept", undefined, q), JSON.stringify(q)).toMatch(/not complete/);
    const p = await open("accept", undefined, { token });
    expect(p).toContain(`href="/sign-in?next=${encodeURIComponent(`/team/accept?token=${token}`)}"`);
    expect(p).toContain(`/sign-up/account?kind=employer&amp;next=${encodeURIComponent(`/team/accept?token=${token}`)}`);
  });
  it("a login with no company gets the accept button; a login in a company is told so; a made-up token is refused by the team route with a message", async () => {
    const none = await login(), member = await login();
    await company("verified", member);
    expect(await open("accept", none.cookie, { token })).toMatch(/Accept the invitation/);
    expect(await open("accept", member.cookie, { token })).toMatch(/already belong to a company/);
    const r = await call(ROUTES.team!.POST!, none.cookie, { action: "accept", token });
    expect([r.status, r.code]).toEqual([404, "INVITE_NOT_VALID"]);
    expect(MSG.acceptMessage({ status: r.status, code: r.code })).toMatch(/invitation has ended/);
  });
});

describe("terms and privacy", () => {
  it("the text in force shows as text; a purpose with no text shows its own state", async () => {
    expect(await open("terms", undefined)).toContain("Test text");
    expect(await open("privacy", undefined)).toMatch(/Not published yet/);
  });
});

describe("security: return addresses, hostile params, no leaks", () => {
  it("?next= is kept only as a path on our own site", () => {
    for (const ok of ["/", "/sign-up/claim", "/team/accept?token=" + "A".repeat(43), "/verification"]) expect(D.checkedNext(ok), ok).toBe(ok);
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "http://localhost:3001/", "/%2Fevil.example", "/%5Cevil.example", "/a\\b", "/\t/evil.example", "javascript:alert(1)", "evil.example", "", "/" + "a".repeat(1001), ["/ok"], undefined, null, 7, {}]) expect(D.checkedNext(bad), JSON.stringify(bad)).toBeNull();
  });
  it("sign-in, verify-email and sign-up pages never send a signed-in person to a foreign address", async () => {
    const none = await login();
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "/%2Fevil.example"]) {
      expect(await redirectOf("signIn", none.cookie, { next }), next).toBe("/sign-up/claim");
      const verify = await open("verifyEmail", undefined, { next });
      expect(verify, next).not.toContain("evil.example");
      expect(await open("account", undefined, { next }), next).not.toContain("evil.example");
    }
  });
  it("hostile query values give the page and never an error: arrays, very long text, markup, a null byte", async () => {
    const none = await login();
    for (const q of [{ q: ["a", "b"] }, { q: "x".repeat(5000) }, { q: "<script>alert(1)</script>" }, { q: "%00" }]) expect(await open("claim", none.cookie, q), JSON.stringify(q)).toContain(none.email);
    const html = await open("first", none.cookie, { cro: ["1", "2"], name: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert");
    const long = await open("first", none.cookie, { cro: "9".repeat(5000), name: "n".repeat(5000) });
    expect(long.length).toBeLessThan(60_000);
    expect(await open("account", undefined, { kind: ["agency", "employer"] })).toMatch(/Next you find your company/); // an array is the default, not the first element
    expect(await open("account", undefined, { kind: "<script>" })).toMatch(/Next you find your company/);
  });
  it("what a role must not see is not in the HTML: no one else's company, no staff note, no internal id, no password field value", async () => {
    const o = await login(), other = await login();
    const org = await company("needs_info", o, "account_owner", { name: "Fake Secret Company Limited" });
    await su.query("insert into review_item(queue, organisation_id, reason, detail) values ('account_review', $1, 'claim', $2)", [org, JSON.stringify({ staff_note: "INTERNAL STAFF NOTE" })]);
    for (const who of [o, other]) {
      const html = await open("verification", who.cookie).catch((e) => `REDIRECT ${e.url}`);
      expect(html).not.toMatch(/INTERNAL STAFF NOTE|Fake Secret Company/);
    }
    expect(await open("signIn", undefined)).not.toMatch(/value="/);
  });
});

describe("performance: statements and time of the pages (check 5)", () => {
  it("each page render stays inside its statement budget and median time", async () => {
    const o = await login(), none = await login();
    const org = await company("pending_review", o, "account_owner", { cro: "884001" });
    await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'claim')", [org]);
    const rows: [string, string, string | undefined, number][] = [
      ["landing (visitor)", "landing", undefined, BUDGET.landing], ["claim step", "claim", none.cookie, BUDGET.claim], ["verification", "verification", o.cookie, BUDGET.verification], ["terms", "terms", undefined, BUDGET.terms],
    ];
    for (const [label, name, cookie, limit] of rows) {
      await open(name, cookie); // warm
      const [, statements] = await counted(() => open(name, cookie));
      const ms = await median(() => open(name, cookie));
      console.log(`P13 ${label}: ${statements} statements, median ${ms.toFixed(1)} ms`);
      expect(statements, label).toBeLessThanOrEqual(limit);
      expect(ms, label).toBeLessThan(BUDGET.ms);
    }
  });
});
