// Step 16 page slice P18 (employer dashboard, jobs list, close and renew, notices, pay floors): the pages' server code and the emailed links on the test database, through the real routes of
// apps/portal with real portal sessions. Only Next's own request context is stood in (server-only, next/headers, next/navigation's redirect); no test reaches the network, the
// email sender is the fake one that keeps its messages. Fake people and companies only. Also holds the statement and time budgets of the pages (check 5) and the role, hostile
// input and open-redirect tests (check 6).
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

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
const BUDGET = { dashboard: 30, jobs: 16, notices: 12, floors: 12, ms: 200 }; // measured 25 Nov 2026 with 25 jobs and 50 notices: dashboard 23, jobs 11, notices 8, pay floors 8 statements; medians 8 to 72 ms

type Page = (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<import("react").ReactElement>;
let db: TestDb, su: pg.Pool, AUTH: { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number>; text(purpose: string): Promise<number> };
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
  for (const [k, p] of [["close", "jobs/close"], ["renew", "jobs/renew"], ["notices", "notices"], ["floors", "pay-floors"]] as const)
    ROUTES[k] = (await import(/* @vite-ignore */ `../../../apps/portal/app/api/portal/${p}/route`)) as never;
  for (const [k, f] of Object.entries({ dashboard: "dashboard/page", jobs: "jobs/page", notices: "notices/page", floors: "pay-floors/page" })) pages[k] = await load(f);
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
let src: string;
type JobOpt = { status?: string; title?: string; closes?: string; closeReason?: string; reason?: string; hidden?: string; code?: string };
/** A job of `org` in any state (as postgres). `closes` is an SQL interval from now. */
async function job(org: string, o: JobOpt = {}): Promise<string> {
  const status = o.status ?? "live", live = status === "live";
  src ??= (await one("insert into job_source(kind, board) values ('portal', 'portal') returning id::text")).id;
  return (await one(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, close_reason, closed_at, hidden_reason, under_review_reason, salary_low, search_vector, closes_at, own_page_url)
     values ($1, 'employer', $2, $3, 'Fake Org', 'it', 'critical_skills', $4, $5, $6, $7, $8, 40000, ${live ? "'fake:1'::tsvector" : "null"}, now() + $9::interval, 'https://example.test/apply') returning id::text`,
    [org, src, o.title ?? `Fake role ${++n}`, status, o.closeReason ?? (status === "closed" ? "closed" : null), status === "closed" ? new Date() : null, o.hidden ?? (status === "hidden" ? "admin" : null), o.reason ?? (status === "under_review" ? "pay_check" : null), o.closes ?? "20 days"])).id;
}
const stat = (id: string, ago: number, views: number, clicks: number) =>
  su.query("insert into job_daily_stat(job_id, day, views, apply_clicks) values ($1, (now() at time zone 'Europe/Dublin')::date - $2::int, $3, $4)", [id, ago, views, clicks]);
const note = (user: string, key: string) => su.query("insert into notification(portal_user_id, category, template_key, params, dedupe_key) values ($1, 'account', $2, '{}', $3)", [user, key, `p18-${++n}`]);
/** A company with an owner, a viewer, a poster and a bystander of another company, and a set of jobs in every state. */
async function setup(status = "verified") {
  const owner = await login(), viewer = await login(), poster = await login(), outsider = await login();
  const org = await company(status, owner);
  await F.member(org, viewer.id, { role: "viewer" });
  await F.member(org, poster.id, { role: "poster" });
  const other = await company("verified", outsider, "account_owner", { name: "Fake Other Limited" });
  return { owner, viewer, poster, outsider, org, other };
}

describe("dashboard, jobs, notices and pay floors: what each role sees (checks 4 and 6)", () => {
  it("dashboard: tiles come from the reads, 'Apply clicks' not 'Applied', no Hire recorded tile, real role names, an ending job has Renew and Close", async () => {
    const c = await setup();
    const a = await job(c.org, { title: "Fake Sous Chef", closes: "20 days" }), b = await job(c.org, { title: "Fake Chef de Partie", closes: "2 days" });
    await job(c.org, { status: "under_review", title: "Fake Manager" });
    await stat(a, 1, 40, 4); await stat(b, 2, 30, 1); await stat(b, 40, 99, 9); // the 40-day-old row is outside the 30 days
    const html = await open("dashboard", c.owner.cookie);
    expect(html).toMatch(/data-tile="Live jobs"[^>]*>.*?<span class="block font-heading text-5xl tabular-nums">2</);
    expect(html).toMatch(/data-tile="Job views, 30 days"[^>]*>.*?tabular-nums">70</);
    expect(html).toMatch(/data-tile="Apply clicks, 30 days"[^>]*>.*?tabular-nums">5</);
    expect(html).toMatch(/Fake Chef de Partie ends in 2 days/);
    expect(html).toMatch(/>Renew</); expect(html).toMatch(/>Close</);
    expect(html).not.toMatch(/Hire recorded|New applicants|>Applied</);
    expect(html).toMatch(/Account owner/); expect(html).toMatch(/Poster/); expect(html).toMatch(/Viewer/);
    expect(html).not.toMatch(/Member|company domain|Fake Other Limited|Abroad/);
  });
  it("dashboard: a viewer sees the numbers and no button that writes; a poster does; a signed-out visitor is sent to sign in", async () => {
    const c = await setup();
    await job(c.org, { title: "Fake Ending", closes: "1 day" });
    const v = await open("dashboard", c.viewer.cookie);
    expect(v).toMatch(/Fake Ending/); expect(v).not.toMatch(/>Renew<|>Close<|Invite|Request permit services|Pay floors for big/);
    expect(await open("dashboard", c.poster.cookie)).toMatch(/>Renew</);
    expect(await redirectOf("dashboard", undefined)).toBe("/sign-in");
  });
  it("dashboard: a suspended, closed or restricted company still opens it; a company in review goes to its verification page; no company goes to the claim step", async () => {
    for (const status of ["suspended", "closed", "verified_restricted"]) {
      const c = await setup(status === "verified_restricted" ? status : "verified");
      await job(c.org, { title: "Fake Held Job" });
      if (status !== "verified_restricted") await su.query("update organisation set status = $2 where id = $1", [c.org, status]);
      expect(await open("dashboard", c.owner.cookie), status).toMatch(/Account status/);
    }
    const p = await setup("pending_review");
    expect(await redirectOf("dashboard", p.owner.cookie)).toBe("/verification");
    expect(await redirectOf("jobs", p.owner.cookie)).toBe("/verification");
    const none = await login();
    expect(await redirectOf("dashboard", none.cookie)).toBe("/sign-up/claim");
    expect(await redirectOf("floors", none.cookie)).toBe("/sign-up/claim");
  });
  it("jobs: tabs count the list's states by one rule, In review and Closed have their own tab, another company's jobs never show", async () => {
    const c = await setup();
    await job(c.org, { title: "Fake Live A" }); await job(c.org, { title: "Fake Live B" });
    await job(c.org, { status: "in_review", title: "Fake In Review", reason: undefined });
    await job(c.org, { status: "under_review", title: "Fake Under Review" });
    await job(c.org, { status: "closed", title: "Fake Closed By You" });
    await job(c.org, { status: "closed", closeReason: "expired", title: "Fake Expired" });
    await job(c.org, { status: "hidden", title: "Fake Hidden" });
    await job(c.other, { title: "Fake Other Company Job" });
    const all = await open("jobs", c.owner.cookie);
    for (const t of ["All 7", "Live 2", "In review 1", "Under review 1", "Expired 1", "Closed 1", "Removed 1", "Drafts 0"]) expect(all, t).toContain(t);
    expect(all).not.toMatch(/Fake Other/);
    expect(await open("jobs", c.owner.cookie, { tab: "in_review" })).toMatch(/Fake In Review/);
    const closed = await open("jobs", c.owner.cookie, { tab: "closed" });
    expect(closed).toMatch(/Fake Closed By You/); expect(closed).not.toMatch(/Fake Live A/);
    expect(await open("jobs", c.owner.cookie, { tab: "expired" })).toMatch(/Fake Expired/);
    expect(await open("jobs", c.owner.cookie, { tab: "removed" })).toMatch(/Fake Hidden/);
  });
  it("jobs: a long list pages with Previous and Next, never page numbers; hostile address values change nothing", async () => {
    const c = await setup();
    for (let i = 0; i < 23; i++) await job(c.org, { title: `Fake Bulk ${i}` });
    const first = await open("jobs", c.owner.cookie);
    expect(first).toMatch(/rel="next"/); expect(first).not.toMatch(/rel="prev"/);
    const second = await open("jobs", c.owner.cookie, { from: "20" });
    expect(second).toMatch(/rel="prev"/); expect(second).not.toMatch(/rel="next"/);
    for (const q of [{ tab: "<script>alert(1)</script>" }, { tab: ["live", "closed"] }, { from: "-5" }, { from: "99999999999999" }, { from: "1e9" }, { from: "20.5" }, { job: "abc" }, { job: "0 or 1=1" }, { job: "9".repeat(5000) }, { tab: "x".repeat(10000) }]) {
      const html = await open("jobs", c.owner.cookie, q as never);
      expect(html, JSON.stringify(q).slice(0, 40)).toMatch(/<h1[^>]*>Jobs</); expect(html).not.toMatch(/<script>alert/);
    }
  });
  it("jobs: the stats card of another company's job id shows nothing of it; a viewer sees no write button", async () => {
    const c = await setup();
    await job(c.org, { title: "Fake Mine", closes: "1 day" });
    const theirs = await job(c.other, { title: "Fake Theirs Secret" });
    await stat(theirs, 1, 777, 77);
    const html = await open("jobs", c.owner.cookie, { job: theirs });
    expect(html).not.toMatch(/Fake Theirs Secret|777/);
    const v = await open("jobs", c.viewer.cookie);
    expect(v).toMatch(/Fake Mine/); expect(v).not.toMatch(/>Renew<|>Close</);
    expect(await redirectOf("jobs", undefined)).toBe("/sign-in?next=%2Fjobs");
  });
  it("the write routes the buttons call refuse a viewer and another company's job the same way (NOT_A_POSTER, JOB_NOT_FOUND)", async () => {
    const c = await setup();
    const id = await job(c.org, { title: "Fake Close Me" });
    expect((await call(ROUTES.close!.POST!, c.viewer.cookie, { jobId: id, hireAnswer: "no" })).code).toBe("NOT_A_POSTER");
    expect((await call(ROUTES.renew!.POST!, c.viewer.cookie, { jobId: id })).code).toBe("NOT_A_POSTER");
    expect((await call(ROUTES.close!.POST!, c.outsider.cookie, { jobId: id, hireAnswer: "no" })).code).toBe("JOB_NOT_FOUND");
    expect((await call(ROUTES.close!.POST!, c.poster.cookie, { jobId: id })).status).toBe(400); // a live job needs the hire answer
    const draft = await job(c.org, { status: "draft", title: "Fake Draft" });
    expect((await call(ROUTES.close!.POST!, c.poster.cookie, { jobId: draft })).status).toBe(200); // B52: a draft closes with no question
    expect((await call(ROUTES.close!.POST!, c.poster.cookie, { jobId: id, hireAnswer: "yes" })).status).toBe(200);
    expect(await redirectOf("jobs", c.owner.cookie)).toBeNull();
  });
  it("notices: words by key, an unknown key reads as a general notice, Previous and Next, a bad cursor is a message, any login (with no company too) opens it, a stranger sees none of another's", async () => {
    const c = await setup(), none = await login();
    await note(c.owner.id, "job_hidden"); await note(c.owner.id, "some_future_key"); await note(none.id, "account_approved");
    const html = await open("notices", c.owner.cookie);
    expect(html).toMatch(/One of your jobs was hidden/); expect(html).toMatch(/You have a notice/); expect(html).not.toMatch(/some_future_key|job_hidden|Your company account is approved/);
    expect(html).toMatch(/2 unread/);
    expect(await open("notices", none.cookie)).toMatch(/Your company account is approved/);
    expect(await open("notices", c.owner.cookie, { after: "not a token!" })).toMatch(/One of your jobs was hidden/); // a token outside the alphabet is dropped, not passed on
    expect(await open("notices", c.owner.cookie, { after: "bm90LWEtdG9rZW4" })).toMatch(/not available/);
    for (let i = 0; i < 52; i++) await note(c.owner.id, "job_hidden");
    const p1 = await open("notices", c.owner.cookie);
    const next = /href="\/notices\?after=([^"]+)"/.exec(p1)?.[1];
    expect(next).toBeTruthy();
    const p2 = await open("notices", c.owner.cookie, { after: decodeURIComponent(next!.replaceAll("&amp;", "&")) });
    expect(p2).toMatch(/rel="prev"/);
    expect(await redirectOf("notices", undefined)).toBe("/sign-in?next=%2Fnotices");
  });
  it("pay floors: the wording and the form for a role that can sign, only the list for a viewer, a floor of another company never shows", async () => {
    const c = await setup();
    const text = String(await F.text("pay_floor"));
    const owner = await open("floors", c.owner.cookie), viewer = await open("floors", c.viewer.cookie);
    expect(owner).toMatch(/Sign a pay floor/); expect(owner).toMatch(/data-floor-wording/); expect(owner).toMatch(/name="roleFamily"/);
    expect(viewer).not.toMatch(/name="roleFamily"/); expect(viewer).toMatch(/not sign them/);
    expect(await redirectOf("floors", undefined)).toBe("/sign-in?next=%2Fpay-floors");
    const sign = await call(ROUTES.floors!.POST!, c.viewer.cookie, { action: "sign", roleFamily: "2136", floorEur: 60000, consentTextId: text });
    expect(sign.status).toBe(403); // REAUTH_REQUIRED or NOT_SIGNER: a viewer never signs
  });
});

describe("performance: statements and time of the pages (check 5)", () => {
  it("each page render stays inside its statement budget and median time, with 25 jobs and 50 notices", async () => {
    const c = await setup();
    for (let i = 0; i < 25; i++) { const id = await job(c.org, { title: `Fake Perf ${i}` }); await stat(id, i % 30, 10, 1); }
    for (let i = 0; i < 50; i++) await note(c.owner.id, "job_hidden");
    const rows: [string, string, number][] = [["dashboard", "dashboard", BUDGET.dashboard], ["jobs", "jobs", BUDGET.jobs], ["notices", "notices", BUDGET.notices], ["pay floors", "floors", BUDGET.floors]];
    for (const [label, name, limit] of rows) {
      await open(name, c.owner.cookie); // warm
      const [, statements] = await counted(() => open(name, c.owner.cookie));
      const ms = await median(() => open(name, c.owner.cookie));
      console.log(`P18 ${label}: ${statements} statements, median ${ms.toFixed(1)} ms`);
      expect(statements, label).toBeLessThanOrEqual(limit);
      expect(ms, label).toBeLessThan(BUDGET.ms);
    }
  });
});
