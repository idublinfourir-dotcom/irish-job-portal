// Step 16 wave 3, agent p17b (profile and CV, settings, delete account, the goodbye): the pages' server code and the routes behind them, end to end on the test
// database as app_candidate. Real Better Auth routes, real account routes, real reads through apps/candidate/lib/data.ts and the real page functions (called with
// their searchParams, the element rendered to HTML). Only Next's request context is stood in. Emails go to the app's fake sender: no network. Fake people only.
// Budgets (measured 25 November 2026, see the printed line): statements per page render counted from the call, the session read included, and the median time.
import { pressed } from "./confirm-link";
import pg from "pg";
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { saveServicesTexts } from "../src/services-texts-cli";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const BUDGET = { statements: { profile: 19, settings: 14, delete: 9, goodbye: 0 }, medianMs: 120 }; // SEC-6 (27 Nov 2026): each signed-in read now writes its read count; one count per page render is round 2 work (S3a), then lower these again
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Page = (a?: unknown) => Promise<unknown>;
let db: TestDb, su: pg.Pool;
let AUTH: { GET: Handler; POST: Handler }, PROFILE: { PUT: Handler }, NOTIF: { PUT: Handler }, ACCOUNT: { DELETE: Handler }, EXPORT: { GET: Handler }, CASES: { POST: Handler };
let mail: () => { kind: string; to: string; link: string }[];
const P = {} as Record<"profile" | "settings" | "delete" | "goodbye", Page>;
let sayAccount: typeof import("../../../apps/candidate/app/account/settings-messages").sayAccount;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  const c = await su.connect();
  try { await saveServicesTexts(c); } finally { c.release(); }
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  AUTH = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route");
  PROFILE = await import("../../../apps/candidate/app/api/candidate/profile/route");
  NOTIF = await import("../../../apps/candidate/app/api/candidate/notifications/route");
  ACCOUNT = await import("../../../apps/candidate/app/api/candidate/account/route");
  EXPORT = await import("../../../apps/candidate/app/api/candidate/export/route");
  CASES = await import("../../../apps/candidate/app/api/candidate/cases/route");
  ({ candidateMail: mail } = await import("../../../apps/candidate/lib/candidate"));
  mail = pressed(mail, "candidate");
  ({ sayAccount } = await import("../../../apps/candidate/app/account/settings-messages"));
  const page = async (p: string) => (await import(p)).default as Page;
  P.profile = await page("../../../apps/candidate/app/account/profile/page");
  P.settings = await page("../../../apps/candidate/app/account/settings/page");
  P.delete = await page("../../../apps/candidate/app/account/settings/delete/page");
  P.goodbye = await page("../../../apps/candidate/app/account-deleted/page");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const ip = () => `198.51.100.${(n++ % 200) + 10}`;
const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const headersFor = (cookie?: string) => ({ "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip(), ...(cookie ? { cookie } : {}) });
const call = (h: Handler, method: string, path: string, cookie: string | undefined, body?: unknown) =>
  h(new Request(`${BASE}${path}`, { method, headers: headersFor(cookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const auth = async (path: string, body: unknown, cookie?: string) => { const r = await call(AUTH.POST, "POST", `/api/auth/candidate/${path}`, cookie, body); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null, cookie: cookieOf(r) }; };
const as = <T>(cookie: string | undefined, fn: () => Promise<T>): Promise<T> => { state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip() }); return fn(); };
const render = async (cookie: string | undefined, page: Page, q: Record<string, string | string[]> = {}) => html((await as(cookie, () => page({ searchParams: Promise.resolve(q) }))) as never);
const redirectsTo = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return String((e as Error).message).replace("NEXT_REDIRECT ", ""); } return null; };
async function member(tag: string) {
  const email = `fake.p17b.${tag}${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  expect((await auth("sign-up/email", { email, password, name: `Fake ${tag}`, ...answers })).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [email]);
  const r = await auth("sign-in/email", { email, password });
  expect(r.status).toBe(200);
  const id = (await su.query("select id from candidate_user where email = $1", [email])).rows[0].id as string;
  return { email, password, cookie: r.cookie, id };
}
const age = (id: string) => su.query("update candidate_session set created_at = now() - interval '11 minutes' where user_id = $1", [id]);
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => { const t: number[] = []; for (let i = 0; i < 9; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } return t.sort((a, b) => a - b)[4]!; };
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("signed out and the wrong person", () => {
  it("each account page sends a visitor to sign-in and back; the goodbye page needs no sign-in", async () => {
    expect(await redirectsTo(() => render(undefined, P.profile))).toBe("/login?next=%2Faccount%2Fprofile");
    expect(await redirectsTo(() => render(undefined, P.settings))).toBe("/login?next=%2Faccount%2Fsettings");
    expect(await redirectsTo(() => render(undefined, P.delete))).toBe("/login?next=%2Faccount%2Fsettings%2Fdelete");
    expect(await redirectsTo(() => render(undefined, P.goodbye))).toBeNull();
    expect(await redirectsTo(() => render("candidate.session_token=forged.value", P.profile))).toBe("/login?next=%2Faccount%2Fprofile");
  });
  it("one person's page never holds another person's details; hostile query strings do not reach the markup", async () => {
    const a = await member("a"), b = await member("b");
    expect((await call(PROFILE.PUT, "PUT", "/api/candidate/profile", a.cookie, { fullName: "Fake Alpha Person", phone: "+353 1 555 0100", locationKind: "abroad" })).status).toBe(200);
    expect(await render(a.cookie, P.profile)).toContain("Fake Alpha Person");
    const other = await render(b.cookie, P.profile);
    expect(other).not.toContain("Fake Alpha Person");
    expect(other).not.toContain("555 0100");
    const evil = await render(b.cookie, P.settings, { error: ["<script>alert(1)</script>", "x"], email: ["link", "link"] });
    expect(evil).not.toContain("<script>");
    expect(evil).not.toContain(a.email);
    expect(await render(b.cookie, P.settings, { error: "<script>alert(1)</script>" })).not.toContain("<script>alert");
  });
});

describe("the profile page", () => {
  it("shows what was saved, the minimums read, the degree month picker for a recent degree, and the Stamp 4 notice with alerts paused (DD2, DD14)", async () => {
    const m = await member("prof");
    const month = new Date(); month.setUTCMonth(month.getUTCMonth() - 3);
    const awarded = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const put = await call(PROFILE.PUT, "PUT", "/api/candidate/profile", m.cookie, { fullName: "Fake Nurse", occupationCode: "2231", yearsExperience: 4, hasRelevantDegree: true, degreeAwardedMonth: awarded, registrationBody: "nmbi", registrationStatus: "in_progress", locationKind: "ireland", currentStamp: "1G" });
    expect(put.status).toBe(200);
    const h = await render(m.cookie, P.profile);
    expect(h).toMatch(/<input[^>]*name="degreeMonth"[^>]*type="month"|<input[^>]*type="month"[^>]*name="degreeMonth"/);
    expect(h).toContain(`value="${awarded.slice(0, 7)}"`);
    expect(text(h)).toMatch(/recent graduate your Critical Skills minimum is €[\d,]+/);
    expect(h).toContain("Nursing and Midwifery Board of Ireland");
    expect(h).toMatch(/<option[^>]*value="2231"[^>]*selected/);
    expect(h).not.toMatch(/Nationality|Country you live|Launch B|Sample|completeness|Preview what employers/i);
    expect(h).not.toContain("alerts");
    const stamp4 = await call(PROFILE.PUT, "PUT", "/api/candidate/profile", m.cookie, { fullName: "Fake Nurse", locationKind: "ireland", currentStamp: "4" });
    expect(await stamp4.json()).toMatchObject({ deletionOffered: true });
    expect(text(await render(m.cookie, P.profile))).toContain("With this stamp you generally do not need a permit");
  });
  it("a profile that does not exist yet still renders (first visit)", async () => {
    const m = await member("empty");
    const h = await render(m.cookie, P.profile);
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(text(h)).toContain("No CV yet");
    expect(h).not.toMatch(/ModuleNotFound|undefined|\[object/);
  });
});

describe("the settings page and the emailed links of an email change (DD4)", () => {
  it("shows the email, the password date, the job alerts switch as saved, and an empty who-viewed log", async () => {
    const m = await member("set");
    expect((await call(NOTIF.PUT, "PUT", "/api/candidate/notifications", m.cookie, { job_alerts: false })).status).toBe(200);
    const h = await render(m.cookie, P.settings);
    expect(text(h)).toContain(m.email);
    expect(text(h)).toMatch(/Last changed \d{1,2} \w{3} 20\d\d/);
    expect(h.match(/<input[^>]*role="switch"[^>]*>/)![0]).not.toContain('checked=""');
    expect(text(h)).toContain("No employer or staff member has viewed your data.");
    expect(h).not.toMatch(/currency|Nationality|Quota and processing|Launch B/i);
  });
  it("change-password: a wrong current password has its own words; a right one is saved", async () => {
    const m = await member("pw");
    const bad = await auth("change-password", { currentPassword: "not-the-password-1", newPassword: "Another-password-123" }, m.cookie);
    expect(sayAccount({ ok: false, status: bad.status, code: bad.json?.code }).text).toMatch(/not your current password/);
    expect((await auth("change-password", { currentPassword: m.password, newPassword: "Another-password-123", revokeOtherSessions: true }, m.cookie)).status).toBe(200);
  });
  it("the change-email links end on /account/settings: first link, second link, address changed; a taken address ends on ?error=EMAIL_TAKEN", async () => {
    const m = await member("em"), to = `fake.p17b.new${Date.now().toString(36)}@example.test`;
    const cb = "/account/settings?email=link";
    expect((await auth("change-email", { newEmail: to, callbackURL: cb }, m.cookie)).status).toBe(200);
    const first = mail().filter((x) => x.to === m.email && x.kind === "change-email").at(-1)!;
    const r1 = await AUTH.GET(new Request(first.link, { headers: { "x-vercel-forwarded-for": ip() } }));
    expect(new URL(r1.headers.get("location")!, BASE).pathname).toBe("/account/settings");
    const second = mail().filter((x) => x.to === to && x.kind === "new-email").at(-1)!;
    const r2 = await AUTH.GET(new Request(second.link, { headers: { "x-vercel-forwarded-for": ip() } }));
    expect(new URL(r2.headers.get("location")!, BASE).pathname).toBe("/account/settings");
    expect((await su.query("select 1 from candidate_user where email = $1", [to])).rowCount).toBe(1);
    expect(text(await render(m.cookie, P.settings, { email: "link" }))).toContain("That link worked");
    // the race: the new address got an account before the second link was opened
    const o = await member("em2"), taken = `fake.p17b.taken${Date.now().toString(36)}@example.test`;
    expect((await auth("change-email", { newEmail: taken, callbackURL: cb }, o.cookie)).status).toBe(200);
    const l1 = mail().filter((x) => x.to === o.email && x.kind === "change-email").at(-1)!;
    await AUTH.GET(new Request(l1.link, { headers: { "x-vercel-forwarded-for": ip() } }));
    const l2 = mail().filter((x) => x.to === taken && x.kind === "new-email").at(-1)!;
    expect((await auth("sign-up/email", { email: taken, password: "Fake-password-12345", name: "Fake Taker", ...answers })).status).toBe(200);
    const r3 = await AUTH.GET(new Request(l2.link, { headers: { "x-vercel-forwarded-for": ip() } }));
    const loc = new URL(r3.headers.get("location")!, BASE);
    expect([loc.pathname, loc.searchParams.get("error")]).toEqual(["/account/settings", "EMAIL_TAKEN"]);
    expect(text(await render(o.cookie, P.settings, { error: "EMAIL_TAKEN" }))).toContain("Your address has not changed");
  });
});

describe("a sign-in older than 10 minutes (DD10) and sign out everywhere (BA25)", () => {
  it("export, delete and change-email answer REAUTH_REQUIRED, and the words ask for a new sign-in", async () => {
    const m = await member("old");
    await age(m.id);
    for (const r of [await call(EXPORT.GET, "GET", "/api/candidate/export", m.cookie), await call(ACCOUNT.DELETE, "DELETE", "/api/candidate/account", m.cookie, { confirm: true })]) {
      const body = (await r.json()) as { code: string };
      expect([r.status, body.code]).toEqual([403, "REAUTH_REQUIRED"]);
      expect(sayAccount({ ok: false, status: r.status, code: body.code }).reauth).toBe(true);
    }
    expect((await auth("change-email", { newEmail: "fake.p17b.x@example.test" }, m.cookie)).json.code).toBe("REAUTH_REQUIRED");
    expect((await su.query("select deleted_at from candidate_user where id = $1", [m.id])).rows[0].deleted_at).toBeNull();
    // the delete page still opens for the stale session: the route is what asks for the sign-in
    expect(await redirectsTo(() => render(m.cookie, P.delete))).toBeNull();
  });
  it("revoke-sessions ends every session: the pages send the person to sign-in", async () => {
    const m = await member("rev");
    const second = await auth("sign-in/email", { email: m.email, password: m.password });
    expect(await redirectsTo(() => render(second.cookie, P.settings))).toBeNull();
    expect((await auth("revoke-sessions", {}, m.cookie)).status).toBe(200);
    expect(await redirectsTo(() => render(m.cookie, P.settings))).toMatch(/^\/login\?next=/);
    expect(await redirectsTo(() => render(second.cookie, P.settings))).toMatch(/^\/login\?next=/);
  });
});

describe("delete account", () => {
  it("an open permit case shows the keep-until-closed line; with none it does not; the delete itself ends the login and the goodbye page renders", async () => {
    const m = await member("del");
    expect(text(await render(m.cookie, P.delete))).not.toContain("open permit case");
    expect((await call(CASES.POST, "POST", "/api/candidate/cases", m.cookie, { permitType: "critical_skills", offerDetails: { occupationCode: "2231", annualPay: "42000", relevantDegree: "true", title: "Fake Nurse" }, servicesConsent: true })).status).toBe(200);
    const h = await render(m.cookie, P.delete);
    expect(text(h)).toContain("You have an open permit case");
    expect(text(h)).toMatch(/30 days later/);
    expect(text(h)).toContain("6 years after a case closes");
    expect(h).not.toMatch(/deleted at once|Launch B|open applications/i);
    const gone = await call(ACCOUNT.DELETE, "DELETE", "/api/candidate/account", m.cookie, { confirm: true });
    expect(gone.status).toBe(200);
    expect(await redirectsTo(() => render(m.cookie, P.delete))).toMatch(/^\/login\?next=/);
    expect((await auth("sign-in/email", { email: m.email, password: m.password })).status).toBe(403);
    expect(text(await render(undefined, P.goodbye))).toContain("Your account is deleted");
  });
  it("a Google-only account is told Google asks it to confirm", async () => {
    const m = await member("goo");
    await su.query("update candidate_account set provider_id = 'google', password = null where user_id = $1", [m.id]);
    expect(text(await render(m.cookie, P.delete))).toContain("You sign in with Google");
  });
});

describe("budgets", () => {
  it("statements and median time per page render stay in budget", async () => {
    const m = await member("perf");
    await call(PROFILE.PUT, "PUT", "/api/candidate/profile", m.cookie, { fullName: "Fake Perf", occupationCode: "2231", locationKind: "abroad" });
    const rows: Record<string, number> = {};
    for (const [name, page, who] of [["profile", P.profile, m.cookie], ["settings", P.settings, m.cookie], ["delete", P.delete, m.cookie], ["goodbye", P.goodbye, undefined]] as const) {
      const run = () => render(who, page);
      const [, statements] = await counted(run);
      rows[name] = statements;
      expect(statements, name).toBeLessThanOrEqual(BUDGET.statements[name]);
      expect(await median(run), name).toBeLessThan(BUDGET.medianMs);
    }
    process.stderr.write(`p17b statements per page: ${JSON.stringify(rows)}\n`);
  });
});
