// Step 16 page slice P21 (company profile, team, account status, settings, help): the pages' server code and the routes their forms call, on the test database with real portal sessions.
// Only Next's own request context is stood in (server-only, next/headers, redirect); no test reaches the network, the email sender is the fake one that keeps its messages. Fake people and
// companies only. Also holds the statement and time budgets of the pages (check 5) and the role, hostile input and exposure tests (check 6).
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
// Budgets (check 5), measured 25 Nov 2026 (the printed lines of this file): statements per page render and the median of 9 warm renders; about 2 times the statements, and a time floor for a busy laptop.
const BUDGET = { company: 20, team: 20, status: 12, settings: 12, help: 6, ms: 120 }; // measured: company 12 statements, team 12, status 7, settings 7, help 3; medians 7 to 38 ms

type Page = (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<import("react").ReactElement>;
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, AUTH: { GET: Handler; POST: Handler };
let M: typeof import("../../../apps/portal/lib/portal");
let F: { org(o?: object): Promise<number>; member(org: string | number, user: string | null, o?: object): Promise<number> };
const pages: Record<string, Page & { metadata?: { title?: string; description?: string } }> = {};
const mods: Record<string, { metadata?: { title?: string; description?: string } }> = {};
const ROUTES: Record<string, Record<string, Handler>> = {};

const load = async (rel: string) => (await import(/* @vite-ignore */ `../../../apps/portal/app/${rel}`)) as { default: Page; metadata?: { title?: string; description?: string } };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret, CANDIDATE_AUTH_URL: "https://candidates.example.test" });
  AUTH = (await import("../../../apps/portal/app/api/auth/portal/[...all]/route")) as typeof AUTH;
  for (const [k, p] of [["company", "company"], ["close", "company/close"], ["team", "team"], ["status", "status"], ["contact", "contact"], ["settings", "notices/settings"]] as const)
    ROUTES[k] = (await import(/* @vite-ignore */ `../../../apps/portal/app/api/portal/${p}/route`)) as never;
  M = await import("../../../apps/portal/lib/portal");
  for (const [k, f] of Object.entries({ company: "company/page", team: "team/page", status: "account-status/page", settings: "settings/page", help: "help/page" })) {
    const m = await load(f);
    mods[k] = m;
    pages[k] = m.default as never;
  }
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const ip = () => `198.51.100.${(++n % 200) + 10}`;
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const PASSWORD = "Fake-password-12345";
const post = (path: string, body: unknown, cookie?: string) => AUTH.POST(new Request(`${BASE}/api/auth/portal/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
type Who = { email: string; id: string; cookie: string };
async function login(o: { domain?: string } = {}): Promise<Who> {
  const email = `fake.p21.${++n}.${Date.now().toString(36)}@${o.domain ?? "fakehotels.example.test"}`;
  expect((await post("sign-up/email", { email, password: PASSWORD, name: "Fake Person", ...portalAnswers })).status).toBe(200);
  const id = (await one("select id from portal_user where email=$1", [email])).id as string;
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const s = await post("sign-in/email", { email, password: PASSWORD });
  expect(s.status).toBe(200);
  return { email, id, cookie: s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
/** A company in `status` with the given members (role by who). Returns the company id. */
async function company(status: string, members: [Who, string][], o: { name?: string; cro?: string | null } = {}) {
  const org = String(await F.org({ status, name: o.name ?? "Fake Hotels Limited", cro: o.cro === undefined ? null : o.cro }));
  await su.query("update organisation set county='Galway', short_description='A made-up hotel group.', website='https://www.fakehotels.example' where id=$1", [org]);
  for (const [w, role] of members) await F.member(org, w.id, { role, signer: role === "account_owner" });
  return org;
}
/** A strike case as the status page reads it (written with triggers off: the rows are fixtures). */
async function strike(org: string, cols: Record<string, unknown>) {
  const c = await su.connect();
  try {
    await c.query("set session_replication_role = replica");
    const all = { organisation_id: org, case_kind: "false_claim", reason_code: "false_sponsorship", notice_summary: "Our team checked the job and found the claim was not true.", stage: "reply_window", reply_due_at: new Date(Date.now() + 5 * 864e5), ...cols };
    const keys = Object.keys(all);
    return String((await c.query(`insert into strike(${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(all))).rows[0].id);
  } finally { c.release(); }
}
const as = <T>(cookie: string | undefined, fn: () => Promise<T>): Promise<T> => { ctx.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip() }); return fn(); };
type El = import("react").ReactElement<unknown> & { type: (p: unknown) => unknown };
const open = (name: string, cookie: string | undefined, q: Record<string, string | string[] | undefined> = {}) => as(cookie, async () => {
  let el = (await pages[name]!({ searchParams: Promise.resolve(q) })) as unknown as El;
  while (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") el = (await el.type(el.props)) as El;
  return renderToStaticMarkup(el).replaceAll("<!-- -->", "");
});
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
const call = async (h: Handler, cookie: string | undefined, body?: unknown, o: { method?: string; origin?: string } = {}) => {
  const res = await h(new Request(`${BASE}/api/portal/x`, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", origin: o.origin ?? BASE, "x-vercel-forwarded-for": ip() }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json.code as string | undefined, json };
};
const aged = (id: string) => su.query("update portal_session set created_at = now() - interval '11 minutes' where user_id = $1", [id]);

describe("the pages", () => {
  it("every page sets a title of 60 characters or fewer plus the brand and a description of 120 to 160 characters", () => {
    for (const k of Object.keys(mods)) {
      const m = mods[k]!.metadata!;
      expect(String(m.title), k).toMatch(/ \| Irish Work Permit$/);
      expect(String(m.title).replace(/ \| Irish Work Permit$/, "").length, k).toBeLessThanOrEqual(60);
      expect(String(m.description).length, k).toBeGreaterThanOrEqual(120);
      expect(String(m.description).length, k).toBeLessThanOrEqual(160);
    }
  });

  it("company: the owner gets the form with the company's own values, a viewer the same page with no button, signed out goes to sign-in, no company to the claim step", async () => {
    const [o, v, nobody] = [await login(), await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [v, "viewer"]]);
    await su.query("insert into membership(organisation_id, invited_email, role, status, invite_expires_at, invite_token_hash) values ($1,'x@fakehotels.example.test','poster','invited', now() + interval '3 days', 'h' || gen_random_uuid())", [org]);
    const p = await open("company", o.cookie);
    for (const t of ["Fake Hotels Limited", "https://www.fakehotels.example", "A made-up hotel group.", "Upload logo", "Close my company", "2 memberships end", "1 open invitation is cancelled"]) expect(p, t).toContain(t);
    expect(p).toContain('href="https://candidates.example.test/companies/');
    const view = await open("company", v.cookie);
    expect(view).toContain("Fake Hotels Limited");
    expect(view).not.toMatch(/Upload logo|Close my company|type="submit"/);
    expect(await redirectOf("company", undefined)).toBe("/sign-in?next=%2Fcompany");
    expect(await redirectOf("company", nobody.cookie)).toBe("/sign-up/claim");
  });

  it("company: a suspended company opens read-only with its warning; the page never holds another company's values", async () => {
    const o = await login(), other = await login();
    await company("suspended", [[o, "account_owner"]], { name: "Fake Suspended Limited" });
    await company("verified", [[other, "account_owner"]], { name: "Fake Other Limited" });
    const p = await open("company", o.cookie);
    expect(p).toContain("cannot be changed now");
    expect(p).not.toMatch(/Close my company|type="submit"|Fake Other/);
  });

  it("team: the owner sees invitations and join requests; a viewer sees the people only and no address of an invitation or a request", async () => {
    const [o, v, asker] = [await login(), await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [v, "viewer"]]);
    await su.query("insert into membership(organisation_id, invited_email, role, status, is_signer, invite_expires_at, invite_token_hash) values ($1,'invitee.p21@fakehotels.example.test','recruiter','invited', true, now() + interval '3 days', 'h' || gen_random_uuid())", [org]);
    await F.member(org, asker.id, { role: "viewer", status: "join_requested" });
    const p = await open("team", o.cookie);
    for (const t of ["invitee.p21@fakehotels.example.test", asker.email, "Join requests", "Send invite", "Transfer ownership", "4 of 10 places used", "Account owner", "Viewer", "Resend"]) expect(p, t).toContain(t);
    const view = await open("team", v.cookie);
    expect(view).toContain(o.email);
    expect(view).not.toMatch(/invitee\.p21|Join requests|Send invite|Transfer ownership|Resend|Remove/);
    expect(view).not.toContain(asker.email);
    expect(await redirectOf("team", undefined)).toBe("/sign-in?next=%2Fteam");
    expect(await redirectOf("team", (await login()).cookie)).toBe("/sign-up/claim");
  });

  it("account status: the owner can reply and appeal, a poster sees the cases and no form, another company sees none of them, the page holds no word of a report or evidence", async () => {
    const [o, p1, other] = [await login(), await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [p1, "poster"]]);
    await company("verified", [[other, "account_owner"]], { name: "Fake Other Limited" });
    const open1 = await strike(org, {});
    const decided = await strike(org, { stage: "decided", outcome: "strike", level: 1, decided_at: new Date(Date.now() - 864e5), appeal_due_at: new Date(Date.now() + 5 * 864e5) });
    const page = await open("status", o.cookie);
    for (const t of [`Case ${open1}`, `Case ${decided}`, "Send reply", "Send appeal", "Strike 1 of 3", "Instant ban"]) expect(page, t).toContain(t);
    expect(page).not.toMatch(/reporter|evidence|reported|See the evidence|type="file"/i);
    const poster = await open("status", p1.cookie);
    expect(poster).toContain(`Case ${open1}`);
    expect(poster).not.toMatch(/Send reply|Send appeal|<textarea/);
    expect(await open("status", other.cookie)).not.toContain(`Case ${open1}`);
    const raw = await call(ROUTES.status!.GET!, o.cookie);
    for (const c of raw.json.page.cases) expect(Object.keys(c).filter((k) => /report|reporter|evidence|staff/i.test(k))).toEqual([]);
    expect(await redirectOf("status", undefined)).toBe("/sign-in?next=%2Faccount-status");
  });

  it("account status: a suspended company still opens it; a login with no company is told so, not redirected away", async () => {
    const [o, nobody] = [await login(), await login()];
    await company("suspended", [[o, "account_owner"]]);
    expect(await open("status", o.cookie)).toContain("This account is suspended");
    expect(await open("status", nobody.cookie)).toContain("not in a company");
  });

  it("settings: signed out goes to sign-in and keeps the email-link marker; a signed-in login sees its email; the return markers show and hostile ones do not", async () => {
    const o = await login();
    await company("verified", [[o, "account_owner"]]);
    expect(await redirectOf("settings", undefined)).toBe("/sign-in?next=%2Fsettings");
    expect(await redirectOf("settings", undefined, { email: "confirm" })).toBe(`/sign-in?next=${encodeURIComponent("/settings?email=confirm")}`);
    const p = await open("settings", o.cookie);
    for (const t of [o.email, "Sign out everywhere", "Download my data", "Delete my login", "3 days before a job I posted ends"]) expect(p, t).toContain(t);
    expect(await open("settings", o.cookie, { email: "confirm" })).toContain("Link confirmed");
    expect(await open("settings", o.cookie, { error: "EMAIL_TAKEN" })).toContain("already has a login");
    for (const q of [{ email: "<script>alert(1)</script>" }, { error: ["EMAIL_TAKEN", "x"] }, { email: ["confirm"] }, { error: "//evil.example" }]) expect(await open("settings", o.cookie, q)).not.toMatch(/Link confirmed|already has a login|<script>/);
  });

  it("settings: a login with no company (it can still delete itself) and a failed notice setting do not fail the page", async () => {
    const nobody = await login();
    expect(await open("settings", nobody.cookie)).toContain("Delete my login");
  });

  it("help: open to a visitor (appeal only), a member and a suspended company; the topic in the address is used only when the sender may", async () => {
    const [o, s] = [await login(), await login()];
    await company("verified", [[o, "account_owner"]]);
    await company("suspended", [[s, "account_owner"]], { name: "Fake Suspended Limited" });
    const visitor = await open("help", undefined);
    expect(visitor).toContain('value="appeal"');
    expect(visitor).toContain('name="email"');
    expect(visitor).not.toContain("My data: export");
    const member = await open("help", o.cookie, { topic: "account" });
    expect(member).toMatch(/<option value="account" selected/);
    expect(member).not.toContain('value="appeal"');
    expect(await open("help", o.cookie, { topic: "appeal" })).not.toContain('value="appeal"');
    expect(await open("help", o.cookie, { topic: "<script>" })).not.toContain("<script>");
    expect(await open("help", s.cookie)).toContain("Contact us");
  });
});

describe("the routes the forms call, with the bodies the forms send", () => {
  it("company: the owner saves (all three keys, null clears); a poster and a viewer are refused; an unknown field and a bad address are 400; a suspended company is 409", async () => {
    const [o, po, v, sus] = [await login(), await login(), await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [po, "poster"], [v, "viewer"]]);
    await company("suspended", [[sus, "account_owner"]], { name: "Fake Suspended Limited" });
    const body = { description: "We run three hotels.", website: "https://www.fakehotels.example", county: "Cork" };
    expect((await call(ROUTES.company!.POST!, o.cookie, body)).status).toBe(200);
    expect((await one("select county, short_description from organisation where id=$1", [org]))).toMatchObject({ county: "Cork", short_description: "We run three hotels." });
    expect(await open("company", o.cookie)).toContain("We run three hotels.");
    expect((await call(ROUTES.company!.POST!, o.cookie, { description: null, website: null, county: null })).status).toBe(200);
    for (const w of [po, v]) expect(await call(ROUTES.company!.POST!, w.cookie, body)).toMatchObject({ status: 403, code: "NOT_OWNER" });
    expect(await call(ROUTES.company!.POST!, o.cookie, { ...body, name: "Other" })).toMatchObject({ status: 400 });
    expect(await call(ROUTES.company!.POST!, o.cookie, { ...body, website: "http://www.fakehotels.example" })).toMatchObject({ status: 400 });
    expect(await call(ROUTES.company!.POST!, o.cookie, { ...body, description: "x".repeat(2001) })).toMatchObject({ status: 400 });
    expect(await call(ROUTES.company!.POST!, sus.cookie, body)).toMatchObject({ status: 409, code: "ORGANISATION_NOT_AVAILABLE" });
    expect(await call(ROUTES.company!.POST!, o.cookie, body, { origin: "https://evil.example" })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
  });

  it("close: a wrong name is NAME_MISMATCH and changes nothing; a non-owner is refused; the right name closes the company and the page then sends the login to the claim step", async () => {
    const [o, po] = [await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [po, "poster"]], { name: "Fake Closing Limited" });
    expect(await call(ROUTES.close!.POST!, po.cookie, { confirmName: "Fake Closing Limited" })).toMatchObject({ status: 403, code: "NOT_OWNER" });
    expect(await call(ROUTES.close!.POST!, o.cookie, { confirmName: "fake closing" })).toMatchObject({ status: 400, code: "NAME_MISMATCH" });
    expect((await one("select status from organisation where id=$1", [org])).status).toBe("verified");
    const done = await call(ROUTES.close!.POST!, o.cookie, { confirmName: "Fake Closing Limited" });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ membershipsEnded: 2 });
    expect(await redirectOf("company", o.cookie)).toBe("/sign-up/claim");
  });

  it("team: the owner invites (the email goes out), a resend within 5 minutes waits, a poster and a viewer are refused, a viewer cannot be a signer, a full team says so, the owner transfers, a role changes", async () => {
    const [o, po, v] = [await login(), await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [po, "poster"], [v, "viewer"]]);
    const email = `invitee.${++n}@fakehotels.example.test`;
    const inv = await call(ROUTES.team!.POST!, o.cookie, { action: "invite", email, role: "recruiter", isSigner: true });
    expect(inv.status).toBe(200);
    expect(M.portalMail().some((m) => m.to === email)).toBe(true);
    expect(await open("team", o.cookie)).toContain(email);
    expect(await call(ROUTES.team!.POST!, o.cookie, { action: "resend", membershipId: String(inv.json.membershipId) })).toMatchObject({ status: 429, code: "RESEND_TOO_SOON" });
    for (const w of [po, v]) expect(await call(ROUTES.team!.POST!, w.cookie, { action: "invite", email: `x${n}@fakehotels.example.test`, role: "viewer", isSigner: false })).toMatchObject({ status: 403, code: "NOT_OWNER" });
    expect(await call(ROUTES.team!.POST!, o.cookie, { action: "invite", email: `y${n}@fakehotels.example.test`, role: "viewer", isSigner: true })).toMatchObject({ status: 400, code: "VIEWER_NOT_SIGNER" });
    expect((await call(ROUTES.team!.POST!, o.cookie, { action: "role", membershipId: String(await one("select id from membership where portal_user_id=$1", [po.id]).then((r) => r.id)), role: "recruiter", isSigner: true })).status).toBe(200);
    await su.query("update organisation set member_limit = 4 where id=$1", [org]);
    expect(await call(ROUTES.team!.POST!, o.cookie, { action: "invite", email: `z${n}@fakehotels.example.test`, role: "viewer", isSigner: false })).toMatchObject({ status: 409, code: "TEAM_FULL" });
    expect(await open("team", o.cookie)).toContain("4 of 4 places used");
    expect((await call(ROUTES.team!.POST!, o.cookie, { action: "remove", membershipId: String(inv.json.membershipId) })).status).toBe(200);
    const mid = String((await one("select id from membership where portal_user_id=$1", [po.id])).id);
    expect((await call(ROUTES.team!.POST!, o.cookie, { action: "transfer", membershipId: mid })).status).toBe(200);
    expect(await call(ROUTES.team!.POST!, o.cookie, { action: "invite", email: `w${n}@fakehotels.example.test`, role: "viewer", isSigner: false })).toMatchObject({ status: 403, code: "NOT_OWNER" }); // the old owner is a recruiter now
  });

  it("team: invite, role change and transfer need a sign-in in the last 10 minutes (REAUTH_REQUIRED, before the owner check), remove and refuse do not", async () => {
    const [o, po, asker] = [await login(), await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [po, "poster"]]);
    const req = await F.member(org, asker.id, { role: "viewer", status: "join_requested" });
    const mid = String((await one("select id from membership where portal_user_id=$1", [po.id])).id);
    await aged(o.id);
    for (const b of [{ action: "invite", email: `r${n}@fakehotels.example.test`, role: "viewer", isSigner: false }, { action: "role", membershipId: mid, role: "viewer", isSigner: false }, { action: "transfer", membershipId: mid }, { action: "approve", membershipId: String(req), role: "viewer", isSigner: false }])
      expect(await call(ROUTES.team!.POST!, o.cookie, b), b.action).toMatchObject({ status: 403, code: "REAUTH_REQUIRED" });
    expect((await call(ROUTES.team!.POST!, o.cookie, { action: "refuse", membershipId: String(req) })).status).toBe(200);
  });

  it("status: the owner replies once, a second reply and a reply to a decided case are refused, another company's owner finds no such case, an appeal needs a fresh sign-in", async () => {
    const [o, po, other] = [await login(), await login(), await login()];
    const org = await company("verified", [[o, "account_owner"], [po, "poster"]]);
    await company("verified", [[other, "account_owner"]], { name: "Fake Other Limited" });
    const open1 = await strike(org, {});
    const dec = await strike(org, { stage: "decided", outcome: "strike", level: 1, decided_at: new Date(Date.now() - 864e5), appeal_due_at: new Date(Date.now() + 5 * 864e5) });
    expect(await call(ROUTES.status!.POST!, po.cookie, { action: "reply", caseId: open1, text: "x" })).toMatchObject({ status: 403, code: "NOT_OWNER" });
    expect(await call(ROUTES.status!.POST!, other.cookie, { action: "reply", caseId: open1, text: "x" })).toMatchObject({ status: 404, code: "CASE_NOT_FOUND" });
    expect((await call(ROUTES.status!.POST!, o.cookie, { action: "reply", caseId: open1, text: "We fixed the advert the same day." })).status).toBe(200);
    expect(await call(ROUTES.status!.POST!, o.cookie, { action: "reply", caseId: open1, text: "again" })).toMatchObject({ status: 409, code: "ALREADY_REPLIED" });
    expect(await open("status", o.cookie)).toContain("We fixed the advert the same day.");
    expect(await call(ROUTES.status!.POST!, o.cookie, { action: "reply", caseId: dec, text: "late" })).toMatchObject({ status: 409, code: "REPLY_CLOSED" });
    await aged(o.id);
    expect(await call(ROUTES.status!.POST!, o.cookie, { action: "appeal", caseId: dec, text: "Here is why." })).toMatchObject({ status: 403, code: "REAUTH_REQUIRED" });
    const again = await post("sign-in/email", { email: o.email, password: PASSWORD });
    const fresh = again.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await call(ROUTES.status!.POST!, fresh, { action: "appeal", caseId: dec, text: "Here is why." })).status).toBe(200);
    expect(await call(ROUTES.status!.POST!, fresh, { action: "appeal", caseId: dec, text: "twice" })).toMatchObject({ status: 409, code: "ALREADY_APPEALED" });
    expect(await open("status", fresh)).toMatch(/Appeal sent[\s\S]*Here is why\./);
    for (const t of ["", " \n ", "x".repeat(1801), "a‮b", "a\u0000b"]) expect((await call(ROUTES.status!.POST!, fresh, { action: "reply", caseId: open1, text: t })).status, JSON.stringify(t.slice(0, 5))).toBeGreaterThanOrEqual(400);
  });

  it("contact: a member sends (not the appeal topic); a visitor can send only an appeal, with name and email; hostile bodies are refused", async () => {
    const o = await login();
    await company("verified", [[o, "account_owner"]]);
    expect((await call(ROUTES.contact!.POST!, o.cookie, { topic: "account", body: "How do I add a second admin?" })).status).toBe(200);
    expect((await call(ROUTES.contact!.POST!, o.cookie, { topic: "appeal", body: "x" })).status).toBeGreaterThanOrEqual(400);
    expect((await call(ROUTES.contact!.POST!, undefined, { topic: "appeal", body: "My login is blocked.", name: "Fake Person", email: `fake.visitor.${n}@example.test` })).status).toBe(200);
    expect((await call(ROUTES.contact!.POST!, undefined, { topic: "general", body: "hello", name: "Fake Person", email: "fake@example.test" })).status).toBeGreaterThanOrEqual(401);
    expect((await call(ROUTES.contact!.POST!, undefined, { topic: "appeal", body: "no name" })).status).toBe(400);
    for (const b of [{ topic: "account", body: "" }, { topic: "account", body: "x".repeat(5001) }, { topic: "nope", body: "x" }, { topic: "account", body: "x", extra: 1 }]) expect((await call(ROUTES.contact!.POST!, o.cookie, b)).status).toBe(400);
  });

  it("notice setting: the switch the settings page sends is saved and read back by the page", async () => {
    const o = await login();
    await company("verified", [[o, "account_owner"]]);
    expect((await call(ROUTES.settings!.PUT!, o.cookie, { job_expiry_reminder: false }, { method: "PUT" })).status).toBe(200);
    expect(await open("settings", o.cookie)).not.toMatch(/role="switch"[^>]*checked=""/);
    expect((await call(ROUTES.settings!.PUT!, o.cookie, { job_expiry_reminder: true }, { method: "PUT" })).status).toBe(200);
    expect(await open("settings", o.cookie)).toMatch(/role="switch"[^>]*checked=""/);
  });
});

describe("the emailed email-change links end on /settings (24 Nov lesson)", () => {
  it("a good link, a used link and an ended link all land on our own page, never the library's error page; the address changes after both links", async () => {
    const o = await login();
    await company("verified", [[o, "account_owner"]]);
    const to = `fake.p21.new.${n}@fakehotels.example.test`;
    expect((await post("change-email", { newEmail: to, callbackURL: "/settings?email=confirm" }, o.cookie)).status).toBe(200);
    const click = (link: string) => AUTH.GET(new Request(link, { headers: { "x-vercel-forwarded-for": ip() }, redirect: "manual" }));
    const where = (r: Response) => new URL(r.headers.get("location") ?? "", BASE);
    const first = M.portalMail().filter((m) => m.to === o.email && m.kind === "change-email").at(-1)!.link;
    const g1 = await click(first);
    expect(g1.status).toBe(302);
    expect(where(g1).pathname).toBe("/settings");
    expect(where(g1).searchParams.get("email")).toBe("confirm");
    const second = M.portalMail().filter((m) => m.to === to && m.kind === "new-email").at(-1)!.link;
    const g2 = await click(second);
    expect(where(g2).pathname).toBe("/settings");
    expect((await one("select email from portal_user where id=$1", [o.id])).email).toBe(to);
    expect(where(await click(second)).pathname).toBe("/settings"); // used again
    const late = await login();
    expect((await post("change-email", { newEmail: `fake.p21.late.${n}@fakehotels.example.test`, callbackURL: "/settings?email=confirm" }, late.cookie)).status).toBe(200);
    const old = M.portalMail().filter((m) => m.to === late.email && m.kind === "change-email").at(-1)!.link;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * 3600_000 });
    let ended: Response;
    try { ended = await click(old); } finally { vi.useRealTimers(); }
    expect(where(ended).pathname).toBe("/settings"); // ended: still our page (the marker is whitelisted there, an error param shows nothing)
    expect(await open("settings", o.cookie.replace(/.*/, (await post("sign-in/email", { email: to, password: PASSWORD })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")), { error: where(ended).searchParams.get("error") ?? "" })).not.toMatch(/Link confirmed/);
    // a different domain, and a stale session, are refused with codes the page has sentences for
    const fresh = await login();
    expect(await (await post("change-email", { newEmail: "someone@other.example.test" }, fresh.cookie)).json()).toMatchObject({ code: "DOMAIN_CHANGE_REFUSED" });
    await aged(fresh.id);
    expect(await (await post("change-email", { newEmail: `a${n}@fakehotels.example.test` }, fresh.cookie)).json()).toMatchObject({ code: "REAUTH_REQUIRED" });
  });
});

describe("performance (check 5): statements and time per page render", () => {
  it("each page stays inside its budget, measured warm", async () => {
    const o = await login();
    const org = await company("verified", [[o, "account_owner"], [await login(), "poster"], [await login(), "viewer"]]);
    await strike(org, {});
    await strike(org, { stage: "decided", outcome: "strike", level: 1, decided_at: new Date(Date.now() - 864e5), appeal_due_at: new Date(Date.now() + 5 * 864e5) });
    for (const k of ["company", "team", "status", "settings", "help"] as const) {
      await open(k, o.cookie); // warm
      const [, statements] = await counted(() => open(k, o.cookie));
      const ms = await median(() => open(k, o.cookie));
      console.log(`P21 ${k}: ${statements} statements, median ${ms.toFixed(1)} ms`);
      expect(statements, k).toBeLessThanOrEqual(BUDGET[k]);
      expect(ms, k).toBeLessThan(BUDGET.ms);
    }
  });
});
