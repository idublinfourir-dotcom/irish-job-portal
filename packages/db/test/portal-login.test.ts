// Step 7 slice 3 part A (#184 to #191): the employer and agency login, end to end on the test database. Sign-up, confirmation,
// sign-in, resend and reset go through the real auth route of apps/portal with a Request, connected as app_portal; claim and
// register go through the real /api/portal/claim and /api/portal/register handlers. Email is the fake sender. Fake people only.
// The steps share state (cookies, ids), so they run in order.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { createAuth, requirePortal } from "../../auth/src";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

// Statements measured on 12 November 2026, counting every pg.Client.query call. requirePortal: 3 (the session read is 2, the
// membership read 1). A claim or register through the route: 5 (session 2, membership 1, rate count 1, the function 1).
// Times measured over three runs on 12 November 2026 (warm): requirePortal 2.2 to 4.1 ms a call, a claim 11 to 19 ms. In full parallel runs
// of the whole suite one requirePortal call took 26 ms and one claim 95 ms, so requirePortal is judged on the median of 9 calls (budget
// about 4 times the slowest median) and the one-off claim on its single call (about 5 times, the margin the candidate tests use).
// Raise these only on purpose.
const BUDGET = { requirePortal: 3, claim: 5, requirePortalMs: 15, claimMs: 100 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let GET: Handler, POST: Handler, claimPOST: Handler, registerPOST: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let auth: () => ReturnType<typeof createAuth>;
let F: { org(o?: object): Promise<number>; cro(o?: object): Promise<number>; wrc(o?: object): Promise<number>; member(org: number | string, user: string | null, o?: object): Promise<number> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms"); // portal sign-up needs the saved employer and agency terms and the tick (step 7 slice 4)
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ GET, POST } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: claimPOST } = await import("../../../apps/portal/app/api/portal/claim/route"));
  ({ POST: registerPOST } = await import("../../../apps/portal/app/api/portal/register/route"));
  ({ portalMail: mail, portalAuth: auth } = await import("../../../apps/portal/lib/portal"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let ipn = 10;
const freshIp = () => `198.51.100.${ipn++}`;
type Reply = { status: number; json: Record<string, any> | null; text: string; cookie: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
async function call(path: string, body?: unknown, o: { ip?: string; cookie?: string } = {}) {
  const post = body !== undefined;
  return reply(await (post ? POST : GET)(new Request(`${BASE}/api/auth/portal/${path}`, {
    method: post ? "POST" : "GET", body: post ? JSON.stringify(body) : undefined, redirect: "manual",
    headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": o.ip ?? freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}) },
  })));
}
// A claim or register POST. origin: null sends no Origin header at all.
async function company(which: "claim" | "register", body: unknown, o: { cookie?: string; origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  const req = new Request(`${BASE}/api/portal/${which}`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers });
  return reply(await (which === "claim" ? claimPOST : registerPOST)(req));
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}

const person = (n: string, domain = "example.test") => ({ email: `fake.${n}@${domain}`, password: `Fake-${n}-password-1`, name: `Fake ${n}`, ...portalAnswers });
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const count = async (sql: string, args: unknown[] = []) => (await one(`select count(*)::int n from (${sql}) t`, args)).n as number;
const linkFor = (email: string, kind: string) => mail().filter((m) => m.to === email && m.kind === kind).at(-1)!.link;
const click = (link: string) => { const u = new URL(link); return call(u.pathname.replace("/api/auth/portal/", "") + u.search); };
const userId = async (email: string) => (await one("select id from portal_user where email=$1", [email])).id as string;
// A confirmed, signed-in portal login. Returns its cookie and id.
async function login(n: string, domain?: string) {
  const p = person(n, domain);
  expect((await call("sign-up/email", p)).status).toBe(200);
  await click(linkFor(p.email, "verify"));
  const r = await call("sign-in/email", { email: p.email, password: p.password });
  expect(r.status, r.text).toBe(200);
  return { ...p, cookie: r.cookie, id: await userId(p.email) };
}
// A ban row, written by the database owner with triggers and foreign keys off (a real ban needs a strike-3 case and an approval).
const ban = (col: "email_domain" | "cro_number", value: string) => db.pool("postgres").connect().then(async (c) => {
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(`insert into ban(${col}, reason_code, strike_id, approval_request_id) values ($1, 'fake_company', 0, 0)`, [value]);
    await c.query("commit");
  } finally { c.release(); }
});
// fixtures return bigint ids as text; the routes take numbers
const newOrg = async (o?: object) => String(await F.org(o));
const orgRow = (id: string) => one("select status, signup_path, claimed_at is not null claimed, verified_at is not null verified from organisation where id=$1", [id]);
const reviews = (org: string) => count("select 1 from review_item where queue='account_review' and organisation_id=$1", [org]);
const memberships = (user: string) => count("select 1 from membership where portal_user_id=$1", [user]);

describe("sign-up, confirmation, sign-in, resend and reset (#54, #189)", () => {
  const ann = person("ann");
  it("sign-up makes the login, sends the confirmation link through the fake, and logs nobody in", async () => {
    const r = await call("sign-up/email", ann);
    expect(r.status, r.text).toBe(200);
    expect(r.cookie).toBe("");
    expect(mail().filter((m) => m.to === ann.email).map((m) => [m.pool, m.kind])).toEqual([["portal", "verify"]]);
    expect(await one("select email_verified, status from portal_user where email=$1", [ann.email])).toEqual({ email_verified: false, status: "active" });
  });
  it("a body that tries to set the status or block columns is refused, and makes no login", async () => {
    for (const extra of [{ blockedAt: "2001-01-01" }, { blockedReasonCode: "x" }, { deletedAt: "2001-01-01" }, { lastActiveAt: "2001-01-01" }]) {
      const p = { ...person("cols"), ...extra };
      expect((await call("sign-up/email", p)).status, JSON.stringify(extra)).toBe(400);
    }
    expect(await count("select 1 from portal_user where email=$1", [person("cols").email])).toBe(0);
  });
  it("a status sent at sign-up is ignored: the login is always made active", async () => {
    const p = { ...person("stat"), status: "blocked" };
    const r = await call("sign-up/email", p);
    expect([r.status, await count("select 1 from portal_user where email=$1 and status='active'", [p.email])]).toEqual([200, 1]);
  });
  it("sign-in is refused until the link is clicked", async () => {
    const r = await call("sign-in/email", { email: ann.email, password: ann.password });
    expect([r.status, r.json?.code, r.cookie]).toEqual([403, "EMAIL_NOT_VERIFIED", ""]);
  });
  it("resend sends a new link, and the rate limit stops a fourth in five minutes", async () => {
    const ip = freshIp(), before = mail().filter((m) => m.to === ann.email).length, seq = [];
    for (let i = 0; i < 5; i++) seq.push((await call("send-verification-email", { email: ann.email }, { ip })).status);
    expect(seq).toEqual([200, 200, 200, 429, 429]);
    expect(mail().filter((m) => m.to === ann.email).length).toBe(before + 3);
  });
  it("the link confirms the address; sign-in then gives a portal cookie and a 7-day session", async () => {
    expect((await click(linkFor(ann.email, "verify"))).status).toBeLessThan(400);
    const r = await call("sign-in/email", { email: ann.email, password: ann.password });
    expect(r.status, r.text).toBe(200);
    expect(r.cookie).toMatch(/^portal\.session_token=/);
    const days = ((await one("select s.expires_at from portal_session s join portal_user u on u.id=s.user_id where u.email=$1 order by s.created_at desc limit 1", [ann.email])).expires_at.getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    const c = (await auth().$context).sessionConfig;
    expect([c.expiresIn, c.updateAge]).toEqual([604800, 86400]);
  });
  it("a wrong password is 401, then 429 after 5 tries a minute; sign-up is limited to 5 a minute from one address", async () => {
    let ip = freshIp(), seq = [];
    for (let i = 0; i < 7; i++) seq.push((await call("sign-in/email", { email: ann.email, password: "Wrong-password-123456" }, { ip })).status);
    expect(seq).toEqual([401, 401, 401, 401, 401, 429, 429]);
    ip = freshIp(); seq = [];
    for (let i = 0; i < 6; i++) seq.push((await call("sign-up/email", person(`rate${i}`), { ip })).status);
    expect(seq).toEqual([200, 200, 200, 200, 200, 429]);
  });
  it("no Google sign-in for employers (#190)", async () => {
    const r = await call("sign-in/social", { provider: "google", callbackURL: "/" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).toMatch(/provider/i);
  });
  it("a reset link sets a new password, ends the old sessions, and works once", async () => {
    const bea = await login("bea");
    await call("request-password-reset", { email: bea.email, redirectTo: `${BASE}/reset` });
    const token = new URL(linkFor(bea.email, "reset")).pathname.split("/").at(-1)!;
    expect((await call("reset-password", { newPassword: "Fake-bea-new-password-2", token })).status).toBe(200);
    expect((await call("get-session", undefined, { cookie: bea.cookie })).json).toBeNull();
    expect((await call("sign-in/email", { email: bea.email, password: bea.password })).status).toBe(401);
    expect((await call("sign-in/email", { email: bea.email, password: "Fake-bea-new-password-2" })).status).toBe(200);
    expect((await call("reset-password", { newPassword: "Fake-bea-third-password-3", token })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("requirePortal", () => {
  it("refuses no session and a made-up cookie", async () => {
    for (const cookie of ["", "portal.session_token=made-up.sig"])
      await expect(requirePortal(auth(), new Headers(cookie ? { cookie } : {}))).rejects.toThrow("no_session");
  });
  it("a login with no company gets membership null, within its statement and time budget", async () => {
    const cat = await login("cat");
    const headers = new Headers({ cookie: cat.cookie });
    await requirePortal(auth(), headers); // warm
    const [me, n] = await counted(() => requirePortal(auth(), headers));
    // the median of 9 calls, so one slow moment on a busy machine does not fail the run
    const ms = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await requirePortal(auth(), headers); ms.push(performance.now() - t); }
    expect(ms.sort((a, b) => a - b)[4]).toBeLessThan(BUDGET.requirePortalMs);
    expect(n, `${n} statements`).toBeLessThanOrEqual(BUDGET.requirePortal);
    expect(me).toEqual({ userId: cat.id, email: cat.email, fresh: true, membership: null });
  });
  it("a removed membership is no company", async () => {
    const dan = await login("dan");
    await F.member(await newOrg(), dan.id, { status: "removed" });
    expect((await requirePortal(auth(), new Headers({ cookie: dan.cookie }))).membership).toBeNull();
  });
  it("an awaiting_approval membership is no company either (the login is not yet a member)", async () => {
    const eve = await login("eve2");
    await F.member(await newOrg(), eve.id, { status: "awaiting_approval" });
    expect((await requirePortal(auth(), new Headers({ cookie: eve.cookie }))).membership).toBeNull();
  });
});

describe("claiming an existing sponsor (20b path 1, #20, #37)", () => {
  let acme: string, boss: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    acme = await newOrg({ status: "unclaimed", name: "Acme Fake" });
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, 'acme-fake.test', 'seed')", [acme]);
    boss = await login("boss", "acme-fake.test");
  });
  it("a company-domain email gives verified, no review item, and the login becomes owner and signer, within budget", async () => {
    await requirePortal(auth(), new Headers({ cookie: boss.cookie })); // warm
    const [r, n] = await counted(() => company("claim", { organisationId: acme }, { cookie: boss.cookie }));
    expect(n, `${n} statements`).toBeLessThanOrEqual(BUDGET.claim);
    expect([r.status, r.json]).toEqual([200, { organisationId: acme, status: "verified" }]);
    expect(await orgRow(acme)).toEqual({ status: "verified", signup_path: "dete_claim", claimed: true, verified: true });
    expect(await reviews(acme)).toBe(0);
    const me = await requirePortal(auth(), new Headers({ cookie: boss.cookie }));
    expect(me.membership).toMatchObject({ organisationId: Number(acme), role: "account_owner", isSigner: true, organisationStatus: "verified", organisationKind: "employer" });
  });
  it("claiming stays inside its time budget", async () => {
    // a company and a login of its own each time: a late clock number is tried again (vitest.config.ts), and a company can be claimed once
    const org = await newOrg({ status: "unclaimed" }), who = await login(`speed${Date.now()}`);
    const t = performance.now();
    expect((await company("claim", { organisationId: org }, { cookie: who.cookie })).status).toBe(200);
    expect(performance.now() - t).toBeLessThan(BUDGET.claimMs);
  });
  it("any other email gives pending_review and exactly one account_review item", async () => {
    const other = await newOrg({ status: "unclaimed" });
    const eve = await login("eve");
    const r = await company("claim", { organisationId: other }, { cookie: eve.cookie });
    expect([r.status, r.json]).toEqual([200, { organisationId: other, status: "pending_review" }]);
    expect((await orgRow(other)).status).toBe("pending_review");
    expect(await reviews(other)).toBe(1);
  });
  it("a domain shared with another company is not enough for verified", async () => {
    const twin = await newOrg({ status: "unclaimed" });
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, 'acme-fake.test', 'seed')", [twin]);
    const r = await company("claim", { organisationId: twin }, { cookie: (await login("boss2", "acme-fake.test")).cookie });
    expect(r.json?.status).toBe("pending_review");
  });
  it("a second claimant of the same company is refused, and the first owner stays", async () => {
    const fox = await login("fox", "acme-fake.test");
    const r = await company("claim", { organisationId: acme }, { cookie: fox.cookie });
    expect([r.status, r.json]).toEqual([409, { code: "ORGANISATION_NOT_AVAILABLE" }]);
    expect(await memberships(fox.id)).toBe(0);
    expect((await one("select portal_user_id from membership where organisation_id=$1 and role='account_owner'", [acme])).portal_user_id).toBe(boss.id);
  });
  it("an unknown or verified company is refused the same way", async () => {
    const gil = await login("gil");
    for (const organisationId of ["987654321", await newOrg({ status: "verified" })])
      expect((await company("claim", { organisationId }, { cookie: gil.cookie })).json).toEqual({ code: "ORGANISATION_NOT_AVAILABLE" });
  });
  it("a login that already has a company cannot claim or register a second (one_company_per_login)", async () => {
    const free = await newOrg({ status: "unclaimed" });
    expect((await company("claim", { organisationId: free }, { cookie: boss.cookie })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    expect((await company("register", { kind: "employer", displayName: "Second Fake", croNumber: "555001" }, { cookie: boss.cookie })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    // the database index itself, for a login whose membership is awaiting approval (requirePortal shows it no company)
    const hal = await login("hal");
    await F.member(await newOrg(), hal.id, { status: "awaiting_approval" });
    const r = await company("claim", { organisationId: free }, { cookie: hal.cookie });
    expect([r.status, r.json]).toEqual([409, { code: "ALREADY_IN_A_COMPANY" }]);
    expect((await orgRow(free)).status).toBe("unclaimed");
    expect((await company("register", { kind: "employer", displayName: "Hal Fake", croNumber: "555002" }, { cookie: hal.cookie })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    expect(await count("select 1 from organisation where cro_number='555002'")).toBe(0);
  });
  it("10 logins claiming one company at once: one owner, the rest refused", async () => {
    const prize = await newOrg({ status: "unclaimed" });
    const logins = await Promise.all(Array.from({ length: 10 }, (_, i) => login(`race${i}`)));
    const rs = await Promise.all(logins.map((l) => company("claim", { organisationId: prize }, { cookie: l.cookie })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.json?.code === "ORGANISATION_NOT_AVAILABLE")).toHaveLength(9);
    expect(await count("select 1 from membership where organisation_id=$1", [prize])).toBe(1);
  });
});

describe("registering a new employer or agency (20b paths 2 and 3, #21, #22, #185)", () => {
  let cro: string, wrc: string;
  beforeAll(async () => {
    cro = (await one("select cro_number from cro_company where id=$1", [await F.cro({ number: "610001", name: "Fake Bakery Limited" })])).cro_number;
    wrc = (await one("select licence_number from wrc_licence where id=$1", [await F.wrc({ number: "EA-0101", name: "Fake Recruitment Limited" })])).licence_number;
  });
  const detail = async (org: string) => (await one("select detail from review_item where queue='account_review' and organisation_id=$1", [org])).detail;
  it("an employer found in the CRO sample is pending_review with one review item saying it was found and the name matches", async () => {
    const ian = await login("ian");
    const r = await company("register", { kind: "employer", displayName: "Fake Bakery Limited", croNumber: cro }, { cookie: ian.cookie });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ organisationId: expect.any(String), status: "pending_review" });
    expect(await orgRow(r.json!.organisationId)).toMatchObject({ status: "pending_review", signup_path: "first_time" });
    expect(await reviews(r.json!.organisationId)).toBe(1);
    expect(await detail(r.json!.organisationId)).toEqual({ register: "cro_company", found: true, name_matches: true, status: "Normal" });
    expect((await requirePortal(auth(), new Headers({ cookie: ian.cookie }))).membership).toMatchObject({ role: "account_owner", organisationStatus: "pending_review" });
  });
  it("an agency found in the WRC sample is pending_review too", async () => {
    const r = await company("register", { kind: "agency", displayName: "Fake Recruitment Limited", wrcLicenceNumber: wrc }, { cookie: (await login("jo")).cookie });
    expect(r.json?.status).toBe("pending_review");
    expect(await orgRow(r.json!.organisationId)).toMatchObject({ signup_path: "agency" });
    expect(await detail(r.json!.organisationId)).toEqual({ register: "wrc_licence", found: true, name_matches: true, possibly_lapsed: false });
  });
  it("a number not in the register still goes to review, marked not found; the reply does not say so", async () => {
    const r = await company("register", { kind: "employer", displayName: "Fake Unknown Ltd", croNumber: "610999" }, { cookie: (await login("kim")).cookie });
    expect(r.json).toEqual({ organisationId: expect.any(String), status: "pending_review" });
    expect((await detail(r.json!.organisationId)).found).toBe(false);
  });
  it("a CRO number another organisation holds is refused", async () => {
    const lee = await login("lee");
    const r = await company("register", { kind: "employer", displayName: "Copy Bakery", croNumber: cro }, { cookie: lee.cookie });
    expect([r.status, r.json]).toEqual([409, { code: "NUMBER_ALREADY_REGISTERED" }]);
    expect(await memberships(lee.id)).toBe(0);
  });
  it("a kind other than employer or agency is refused by the route and by the function", async () => {
    const mo = await login("mo");
    for (const kind of ["public_body", "admin", "", null])
      expect((await company("register", { kind, displayName: "Fake Body", croNumber: "610777" }, { cookie: mo.cookie })).status, String(kind)).toBe(400);
    await expect(db.query("app_portal", "select private.register_organisation($1, 'public_body', 'Fake Body', null, null)", [mo.id])).rejects.toThrow(/kind must be employer or agency/);
    expect(await memberships(mo.id)).toBe(0);
  });
  it("an SQL-looking name is stored as plain text", async () => {
    const name = "Robert'); drop table organisation;--";
    const r = await company("register", { kind: "employer", displayName: name, croNumber: "610555" }, { cookie: (await login("ned")).cookie });
    expect((await one("select display_name from organisation where id=$1", [r.json!.organisationId])).display_name).toBe(name);
  });
});

describe("security", () => {
  it("a direct membership insert or update as app_portal is still refused (#184)", async () => {
    const org = await newOrg({ status: "unclaimed" }), u = await login("ola");
    for (const sql of [
      ["insert into membership(organisation_id, portal_user_id, role, status, is_signer) values ($1, $2, 'account_owner', 'active', true)", [org, u.id]],
      ["update membership set role='account_owner' where portal_user_id=$1", [u.id]],
    ] as const) await expect(db.query("app_portal", sql[0], [...sql[1]])).rejects.toMatchObject({ code: "42501" });
  });
  it("a body naming another portal user id is refused, and nothing changes for either login", async () => {
    const victim = await login("pat"), attacker = await login("quin"), org = await newOrg({ status: "unclaimed" });
    for (const extra of [{ portalUserId: victim.id }, { portal_user_id: victim.id }, { userId: victim.id }]) {
      expect((await company("claim", { organisationId: org, ...extra }, { cookie: attacker.cookie })).json, JSON.stringify(extra)).toEqual({ code: "BAD_REQUEST" });
      expect((await company("register", { kind: "employer", displayName: "Fake", croNumber: "620001", ...extra }, { cookie: attacker.cookie })).status).toBe(400);
    }
    expect([await memberships(victim.id), await memberships(attacker.id), (await orgRow(org)).status]).toEqual([0, 0, "unclaimed"]);
  });
  it("claiming before the email is confirmed is refused (no session at all, and the function refuses one that is unconfirmed)", async () => {
    const p = person("rae");
    await call("sign-up/email", p);
    expect((await call("sign-in/email", { email: p.email, password: p.password })).status).toBe(403);
    expect((await company("claim", { organisationId: "1" })).json).toEqual({ code: "NO_SESSION" });
    // a session whose email was later marked unconfirmed (an email change, say)
    const sam = await login("sam"), org = await newOrg({ status: "unclaimed" });
    await su.query("update portal_user set email_verified=false where id=$1", [sam.id]);
    expect((await company("claim", { organisationId: org }, { cookie: sam.cookie })).json).toEqual({ code: "EMAIL_NOT_VERIFIED" });
    expect((await company("register", { kind: "employer", displayName: "Sam Fake", croNumber: "620002" }, { cookie: sam.cookie })).json).toEqual({ code: "EMAIL_NOT_VERIFIED" });
    expect([(await orgRow(org)).status, await memberships(sam.id)]).toEqual(["unclaimed", 0]);
  });
  for (const how of ["blocked", "deleted"] as const)
    it(`a ${how} login: requirePortal, claim and register refused on the open session, and sign-in refused`, async () => {
      const u = await login(`${how}1`), org = await newOrg({ status: "unclaimed" });
      if (how === "blocked") await db.query("app_admin", "update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='fake' where id=$1", [u.id]);
      else await db.query("app_portal", "update portal_user set deleted_at=now() where id=$1", [u.id]);
      await expect(requirePortal(auth(), new Headers({ cookie: u.cookie }))).rejects.toThrow("not_active");
      expect((await company("claim", { organisationId: org }, { cookie: u.cookie })).json).toEqual({ code: "REFUSED" });
      expect((await company("register", { kind: "employer", displayName: "Gone Fake", croNumber: "620003" }, { cookie: u.cookie })).json).toEqual({ code: "REFUSED" });
      expect((await call("sign-in/email", { email: u.email, password: u.password })).status).toBe(403);
      expect([(await orgRow(org)).status, await memberships(u.id)]).toEqual(["unclaimed", 0]);
    });
  it("a banned email domain and a banned company number get the same generic REFUSED as a blocked login (#191)", async () => {
    await ban("email_domain", "banned-fake.test");
    await ban("cro_number", "666001");
    const org = await newOrg({ status: "unclaimed" }), bannedOrg = await newOrg({ status: "unclaimed", cro: "666001" });
    const bad = await login("tia", "banned-fake.test"), ok = await login("uma");
    const replies = [
      await company("claim", { organisationId: org }, { cookie: bad.cookie }),
      await company("register", { kind: "employer", displayName: "Tia Fake", croNumber: "620004" }, { cookie: bad.cookie }),
      await company("claim", { organisationId: bannedOrg }, { cookie: ok.cookie }),
      await company("register", { kind: "employer", displayName: "Uma Fake", croNumber: "666001" }, { cookie: ok.cookie }),
      await company("register", { kind: "agency", displayName: "Uma Agency", wrcLicenceNumber: "EA-0666", croNumber: "666001" }, { cookie: ok.cookie }),
    ];
    for (const r of replies) expect([r.status, r.text]).toEqual([403, JSON.stringify({ code: "REFUSED" })]);
    expect([await memberships(bad.id), await memberships(ok.id), (await orgRow(org)).status, (await orgRow(bannedOrg)).status]).toEqual([0, 0, "unclaimed", "unclaimed"]);
    // sign-up itself does not check the ban (#191): the banned person has a login, which can do nothing
    expect((await requirePortal(auth(), new Headers({ cookie: bad.cookie }))).membership).toBeNull();
  });
  it("a number written another way is still the same number: a leading zero does not get past a ban or a held number, and a licence in lower case is the held licence", async () => {
    await ban("cro_number", "777001");
    await newOrg({ status: "verified", cro: "888001" });
    await newOrg({ status: "verified", kind: "agency", wrc: "EA-0901" });
    const zed = await login("zed");
    const reg = (b: object) => company("register", b, { cookie: zed.cookie });
    expect((await reg({ kind: "employer", displayName: "Zed Fake", croNumber: "0777001" })).json).toEqual({ code: "REFUSED" });
    expect((await reg({ kind: "employer", displayName: "Zed Fake", croNumber: "00000777001" })).status).toBe(400); // over 8 digits: still refused by the digits rule
    expect((await reg({ kind: "employer", displayName: "Zed Fake", croNumber: "00888001" })).json).toEqual({ code: "NUMBER_ALREADY_REGISTERED" });
    expect((await reg({ kind: "agency", displayName: "Zed Agency", wrcLicenceNumber: "ea-0901" })).json).toEqual({ code: "NUMBER_ALREADY_REGISTERED" });
    expect((await reg({ kind: "agency", displayName: "Zed Agency", wrcLicenceNumber: "EA-0666", croNumber: "0777001" })).json).toEqual({ code: "REFUSED" });
    expect(await count("select 1 from organisation where display_name in ('Zed Fake','Zed Agency')")).toBe(0);
    expect(await memberships(zed.id)).toBe(0);
    // and the stored spelling is the plain one
    const ok = await reg({ kind: "employer", displayName: "Zed Fake", croNumber: "0123456" });
    expect(ok.status).toBe(200);
    expect((await one("select cro_number from organisation where id=$1", [ok.json!.organisationId])).cro_number).toBe("123456");
  });
  it("a body whose content-length is over the limit is refused before the body is read", async () => {
    for (const handler of [claimPOST, registerPOST]) {
      let read = false;
      const req = { headers: new Headers({ origin: BASE, "content-length": "99999999" }), text: async () => { read = true; return "{}"; } } as unknown as Request;
      const res = await reply(await handler(req));
      expect([res.status, res.json, read]).toEqual([413, { code: "BODY_TOO_LARGE" }, false]);
    }
  });
  it("a missing or foreign Origin is refused on claim and register before anything is read", async () => {
    const vic = await login("vic"), org = await newOrg({ status: "unclaimed" });
    for (const origin of [null, "https://evil.example.test", "null", "http://localhost:3000", "http://localhost:3001.evil.example.test", "http://127.0.0.1:3001", "HTTP://LOCALHOST:3001x"]) {
      expect((await company("claim", { organisationId: org }, { cookie: vic.cookie, origin })).json, String(origin)).toEqual({ code: "BAD_ORIGIN" });
      expect((await company("register", { kind: "employer", displayName: "Vic Fake", croNumber: "620005" }, { cookie: vic.cookie, origin })).status).toBe(403);
    }
    expect([await memberships(vic.id), (await orgRow(org)).status]).toEqual([0, "unclaimed"]);
  });
  it("odd bodies are refused: not JSON, huge, wrong types, nested, SQL-looking", async () => {
    const wyn = await login("wyn");
    const raw = ["", "not json", "[1]", "null", "1", '"x"', `{"organisationId": 1, "organisationId": "x"}`, `{"organisationId": "1 or 1=1"}`, `{"organisationId": {"$gt": 0}}`, `{"__proto__": {"organisationId": 1}}`];
    for (const r of raw) expect((await company("claim", undefined, { cookie: wyn.cookie, raw: r })).json, r).toEqual({ code: "BAD_REQUEST" });
    expect((await company("claim", undefined, { cookie: wyn.cookie, raw: JSON.stringify({ organisationId: 1, pad: "x".repeat(5000) }) })).json).toEqual({ code: "BODY_TOO_LARGE" });
    expect((await company("register", undefined, { cookie: wyn.cookie, raw: "[".repeat(3000) })).status).toBe(413);
    for (const b of [{ kind: "employer", displayName: { $ne: null }, croNumber: "1" }, { kind: "employer", displayName: "Fake", croNumber: ["1"] }, { kind: "employer", displayName: "Fake", croNumber: "1; drop table ban" }])
      expect((await company("register", b, { cookie: wyn.cookie })).status, JSON.stringify(b)).toBe(400);
    expect(await memberships(wyn.id)).toBe(0);
  });
  it("claim and register together are limited to 5 calls in 10 minutes per login", async () => {
    const xia = await login("xia"), seq = [];
    for (let i = 0; i < 7; i++) seq.push((await company("claim", { organisationId: String(900000 + i) }, { cookie: xia.cookie })).status);
    expect(seq).toEqual([409, 409, 409, 409, 409, 429, 429]);
    expect((await company("register", { kind: "employer", displayName: "Xia Fake", croNumber: "620006" }, { cookie: xia.cookie })).json).toEqual({ code: "TOO_MANY_REQUESTS" });
    // another login is not held back
    const r = await company("register", { kind: "employer", displayName: "Yan Fake", croNumber: "620007" }, { cookie: (await login("yan")).cookie });
    expect(r.status).toBe(200);
  });

  describe("cookies do not cross between the portal and the candidate and staff pools", () => {
    let portalCookie: string, candidateCookie: string, staffCookie: string;
    let candidateAuth: ReturnType<typeof createAuth>, staffAuth: ReturnType<typeof createAuth>;
    const out: { link: string }[] = [];
    const handle = (a: ReturnType<typeof createAuth>, pool: string, path: string, body: unknown) =>
      a.handler(new Request(`${BASE}/api/auth/${pool}/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } }));
    beforeAll(async () => {
      // the same email and the same secret in all three pools: the hardest case, a renamed cookie with a valid signature
      const zed = await login("zed");
      portalCookie = zed.cookie;
      await seedSignupTerms(su);
      candidateAuth = createAuth("candidate", { database: db.pool("app_candidate"), baseURL: BASE, secret, sendEmail: async (_p, _k, _t, link) => void out.push({ link }) });
      await handle(candidateAuth, "candidate", "sign-up/email", { email: zed.email, password: zed.password, name: "Fake zed", ...answers });
      const v = new URL(out.at(-1)!.link);
      await candidateAuth.handler(new Request(v.toString(), { headers: { "x-vercel-forwarded-for": freshIp() } }));
      candidateCookie = (await handle(candidateAuth, "candidate", "sign-in/email", { email: zed.email, password: zed.password })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      staffAuth = createAuth("staff", { database: db.pool("app_admin"), baseURL: BASE, secret, sendEmail: async () => {} });
      const ctx = await staffAuth.$context;
      const user = await ctx.internalAdapter.createUser({ email: zed.email, name: "Fake staff", emailVerified: true }, { method: "email-password" });
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(zed.password) });
      staffCookie = (await handle(staffAuth, "staff", "sign-in/email", { email: zed.email, password: zed.password })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      expect(candidateCookie).toMatch(/^candidate\.session_token=/);
      expect(staffCookie).toMatch(/^staff\.session_token=/);
    });
    it("candidate and staff cookies, as sent or renamed to the portal cookie, are no portal session on any portal route", async () => {
      const org = await newOrg({ status: "unclaimed" });
      for (const c of [candidateCookie, staffCookie, candidateCookie.replace("candidate.", "portal."), staffCookie.replace("staff.", "portal.")]) {
        expect((await call("get-session", undefined, { cookie: c })).json, c).toBeNull();
        await expect(requirePortal(auth(), new Headers({ cookie: c }))).rejects.toThrow("no_session");
        expect((await company("claim", { organisationId: org }, { cookie: c })).json).toEqual({ code: "NO_SESSION" });
        expect((await company("register", { kind: "employer", displayName: "Cross Fake", croNumber: "620008" }, { cookie: c })).json).toEqual({ code: "NO_SESSION" });
      }
      expect((await orgRow(org)).status).toBe("unclaimed");
    });
    it("a portal cookie, as sent or renamed, is no candidate or staff session", async () => {
      for (const [a, name] of [[candidateAuth, "candidate"], [staffAuth, "staff"]] as const)
        for (const c of [portalCookie, portalCookie.replace("portal.", `${name}.`)])
          expect(await a.api.getSession({ headers: new Headers({ cookie: c }) }), `${name} ${c}`).toBeNull();
      expect((await call("get-session", undefined, { cookie: portalCookie })).json?.user?.email).toBe(person("zed").email);
    });
  });
});
