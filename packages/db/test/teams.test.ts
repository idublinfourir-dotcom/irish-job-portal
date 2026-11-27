// Step 8 slice 8.3 (#52, #103, #130, #132, #184, #191): teams for employers and agencies, end to end on the test database through the
// real /api/portal/team handlers, connected as app_portal, with real portal sessions (sign-up, confirm and sign-in through the real
// auth route). The invite email goes to the fake sender only; no test calls the real network. Fake people only.
import { pressConfirm } from "./confirm-link";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { createAuth, requirePortal } from "../../auth/src";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";

// Statements counted on every pg.Client.query call, measured on 12 November 2026: the team list 4 (requirePortal 3, the list 1); an
// invite 7 (requirePortal 3, rate count 1, begin, the function, commit); an accept 5 (requirePortal 3, rate count 1, the function).
// Times, median of 9 calls, measured warm on the laptop over three runs of this file: list 1.7 to 1.9 ms, invite 5.6 to 6.3 ms,
// accept 5.0 to 6.0 ms. Budgets are about 4 times the slowest median. Raise these only on purpose.
const BUDGET = { list: 4, invite: 7, accept: 5, listMs: 8, inviteMs: 25, acceptMs: 25 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, teamGET: Handler, teamPOST: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let auth: () => ReturnType<typeof createAuth>;
let F: { org(o?: object): Promise<number>; member(org: number | string, user: string | null, o?: object): Promise<number> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: teamGET, POST: teamPOST } = await import("../../../apps/portal/app/api/portal/team/route"));
  ({ portalMail: mail, portalAuth: auth } = await import("../../../apps/portal/lib/portal"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
// Most tests make more team calls per owner than the rate limit allows; the rate-limit test makes its own in one go.
beforeEach(async () => { await su.query("delete from portal_rate_limit where key like 'team:%'"); });

let ipn = 0;
const freshIp = () => `10.9.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
type Reply = { status: number; json: Record<string, any> | null; text: string; cookie: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const authCall = async (path: string, body: unknown) => reply(await authPOST(new Request(`${BASE}/api/auth/portal/${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } })));
const click = async (link: string) => reply(await (await import("../../../apps/portal/app/api/auth/portal/[...all]/route")).GET(new Request(link, { headers: { "x-vercel-forwarded-for": freshIp() }, redirect: "manual" })));
// A team POST. origin: null sends no Origin header.
async function team(cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return reply(await teamPOST(new Request(`${BASE}/api/portal/team`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers })));
}
const list = async (cookie?: string) => reply(await teamGET(new Request(`${BASE}/api/portal/team`, { headers: cookie ? { cookie } : {} })));
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};

const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const count = async (sql: string, args: unknown[] = []) => (await one(`select count(*)::int n from (${sql}) t`, args)).n as number;
const mem = (id: string) => one("select status, role, is_signer, portal_user_id, invited_email, invite_token_hash, organisation_id::text org from membership where id=$1", [id]);
const audits = (action: string, id: string) => su.query("select kind, actor_portal_user_id, before, after, reason_text from audit_event where action=$1 and object_type='membership' and object_id=$2", [action, String(id)]).then((r) => r.rows);
// the session's membership with its ids as the routes send them (text)
const me = async (cookie: string) => {
  const m = (await requirePortal(auth(), new Headers({ cookie }))).membership;
  return m && { ...m, id: String(m.id), organisationId: String(m.organisationId) };
};
const tokenFor = (email: string) => new URL(mail().filter((m) => m.to === email && m.kind === "invite").at(-1)!.link).searchParams.get("token")!;

let n = 0;
type Login = { email: string; password: string; cookie: string; id: string };
// A confirmed, signed-in portal login with a fresh email on the given domain.
async function login(domain = "elsewhere.example.test"): Promise<Login> {
  const p = { email: `fake.t${++n}@${domain}`, password: `Fake-t${n}-password-1`, name: `Fake T${n}`, ...portalAnswers };
  expect((await authCall("sign-up/email", p)).status).toBe(200);
  await click(pressConfirm(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link, "portal"));
  const r = await authCall("sign-in/email", { email: p.email, password: p.password });
  expect(r.status, r.text).toBe(200);
  return { email: p.email, password: p.password, cookie: r.cookie, id: (await one("select id from portal_user where email=$1", [p.email])).id };
}
type Company = { org: string; domain: string; owner: Login & { mem: string } };
let dn = 0;
// A company (verified unless said) with its own email domain and an owner (signer) with a session.
async function company(status = "verified"): Promise<Company> {
  const domain = `team${++dn}.example.test`;
  const org = String(await F.org({ status }));
  await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'seed')", [org, domain]);
  const owner = await login(domain);
  return { org, domain, owner: { ...owner, mem: String(await F.member(org, owner.id, { role: "account_owner", signer: true })) } };
}
// A member of the company with a session, put in place by the database owner.
async function joined(c: Company, role: string, signer = false): Promise<Login & { mem: string }> {
  const l = await login(c.domain);
  return { ...l, mem: String(await F.member(c.org, l.id, { role, signer })) };
}
const invite = (c: Company, email: string, role = "poster", isSigner = false) => team(c.owner.cookie, { action: "invite", email, role, isSigner });
// Holds a row locked as the database owner (lockSql), starts act, waits until act is blocked on that lock, makes change in the same
// transaction, then lets go. So a change lands exactly between a function's first read and its lock, every time.
async function underLock<T>(lockSql: string, args: unknown[], act: () => Promise<T>, change: (c: pg.PoolClient) => Promise<unknown>): Promise<T> {
  const c = await su.connect();
  try {
    await c.query("begin");
    await c.query(lockSql, args);
    const p = act();
    for (let t = Date.now(); !(await count("select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")); ) {
      if (Date.now() - t > 5000) { await c.query("rollback"); await p; throw new Error("the call never waited for the lock"); }
      await new Promise((r) => setTimeout(r, 10));
    }
    await change(c);
    await c.query("commit");
    return await p;
  } finally { c.release(); }
}
const ORG_LOCK = "select 1 from organisation where id = $1 for update", USER_LOCK = "select 1 from portal_user where id = $1 for update";
const ban = (value: string, column: "email_domain" | "email_address" = "email_domain") => su.connect().then(async (c) => {
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(`insert into ban(${column}, reason_code, strike_id, approval_request_id) values ($1, 'fake_company', 0, 0)`, [value]);
    await c.query("commit");
  } finally { c.release(); }
});

describe("invite then accept", () => {
  let c: Company, ivy: Login, membershipId: string, token: string;
  beforeAll(async () => { c = await company(); ivy = await login(c.domain); });
  it("the owner invites by email; the email goes to the fake sender with a link; only the token's hash is stored; one audit row of codes", async () => {
    await list(c.owner.cookie); // warm
    const [r, stmts] = await counted(() => invite(c, ` ${ivy.email.toUpperCase()} `, "poster", true)); // its time: the budgets test below (a retry of this test would meet its own invite)
    expect(stmts, `${stmts} statements`).toBeLessThanOrEqual(BUDGET.invite);
    expect(r.status, r.text).toBe(200);
    membershipId = r.json!.membershipId;
    const days = (new Date(r.json!.expiresAt).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    const sent = mail().filter((m) => m.kind === "invite" && m.to === ivy.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.link.startsWith(`${BASE}/team/accept?token=`)).toBe(true);
    token = tokenFor(ivy.email);
    const row = await mem(membershipId);
    expect(row).toMatchObject({ status: "invited", role: "poster", is_signer: true, portal_user_id: null, invited_email: ivy.email, org: c.org });
    expect(row.invite_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(await count("select 1 from membership m where position($1 in to_jsonb(m)::text) > 0", [token])).toBe(0);
    expect(await count("select 1 from audit_event a where position($1 in to_jsonb(a)::text) > 0 or position($2 in to_jsonb(a)::text) > 0", [token, ivy.email])).toBe(0);
    expect(await audits("membership.invite", membershipId)).toEqual([{ kind: "security", actor_portal_user_id: c.owner.id, before: null, after: { role: "poster", is_signer: true, status: "invited" }, reason_text: null }]);
  });
  it("before accepting, the invitee has no company: the list shows nothing and owner actions are refused", async () => {
    expect((await list(ivy.cookie)).json).toEqual({ team: null, joinRequest: null });
    expect((await team(ivy.cookie, { action: "remove", membershipId })).json).toEqual({ code: "NOT_OWNER" });
  });
  it("the invitee accepts with the token, and becomes a poster with the signer switch; the invite columns are emptied", async () => {
    const r = await team(ivy.cookie, { action: "accept", token });
    expect([r.status, r.json]).toEqual([200, { organisationId: c.org, membershipId }]);
    expect(await me(ivy.cookie)).toMatchObject({ id: membershipId, organisationId: c.org, role: "poster", isSigner: true });
    expect(await mem(membershipId)).toMatchObject({ status: "active", portal_user_id: ivy.id, invited_email: null, invite_token_hash: null });
    expect((await audits("membership.accept", membershipId))[0]).toMatchObject({ actor_portal_user_id: ivy.id, before: { status: "invited" }, after: { status: "active", role: "poster", is_signer: true } });
  });
  it("the same token again is refused", async () => {
    expect((await team(ivy.cookie, { action: "accept", token })).json).toEqual({ code: "INVITE_NOT_VALID" });
  });
  it("an email that cannot be sent undoes the invite", async () => {
    const box = mail() as unknown as { push: (...a: unknown[]) => number };
    const push = box.push;
    box.push = () => { throw new Error("fake send failure"); };
    try {
      const r = await invite(c, "fake.nobody@example.test");
      expect([r.status, r.json]).toEqual([502, { code: "EMAIL_FAILED" }]);
    } finally { box.push = push; }
    expect(await count("select 1 from membership where invited_email='fake.nobody@example.test'")).toBe(0);
    expect(await count("select 1 from audit_event where action='membership.invite' and actor_portal_user_id=$1", [c.owner.id])).toBe(1);
  });
});

describe("the team list (GET): roles decide what is shown", () => {
  let c: Company, poster: Login & { mem: string }, invited: number, request: number, asker: Login;
  beforeAll(async () => {
    c = await company();
    poster = await joined(c, "poster");
    invited = (await invite(c, "fake.later@example.test", "viewer")).json!.membershipId;
    asker = await login(c.domain);
    request = (await team(asker.cookie, { action: "request", organisationId: c.org })).json!.membershipId;
  });
  it("the owner sees members, open invites and join requests, within its statement and time budget", async () => {
    await list(c.owner.cookie);
    const [r, stmts] = await counted(() => list(c.owner.cookie));
    expect(stmts, `${stmts} statements`).toBeLessThanOrEqual(BUDGET.list);
    const listMs = await median(() => list(c.owner.cookie));
    console.log(`team budgets: list ${stmts} statements, median ${listMs.toFixed(1)} ms`);
    expect(listMs).toBeLessThan(BUDGET.listMs);
    const t = r.json!.team;
    expect(t.members.map((m: { membershipId: string }) => m.membershipId)).toEqual([c.owner.mem, poster.mem]);
    expect(t.members[0]).toMatchObject({ email: c.owner.email, role: "account_owner", isSigner: true });
    expect(t.invites).toEqual([{ membershipId: invited, email: "fake.later@example.test", role: "viewer", isSigner: false, invitedAt: expect.any(String), expiresAt: expect.any(String) }]);
    expect(t.requests).toEqual([{ membershipId: request, name: expect.any(String), email: asker.email }]);
  });
  it("viewer, poster and recruiter see the members only, never the invites or requests", async () => {
    for (const l of [poster, await joined(c, "viewer"), await joined(c, "recruiter", true)]) {
      const t = (await list(l.cookie)).json!.team;
      expect(t.myRole).not.toBe("account_owner");
      expect([t.invites, t.requests, t.members.some((m: { email: string }) => m.email === "fake.later@example.test")]).toEqual([undefined, undefined, false]);
    }
  });
  it("the asker sees only its own request; no session is NO_SESSION; a member of another company sees only its own team", async () => {
    expect((await list(asker.cookie)).json).toEqual({ team: null, joinRequest: { membershipId: request, organisationId: c.org } });
    expect([(await list()).status, (await list()).json]).toEqual([401, { code: "NO_SESSION" }]);
    const other = await company();
    const t = (await list(other.owner.cookie)).json!.team;
    expect([t.organisationId, t.members.length, t.invites, t.requests]).toEqual([other.org, 1, [], []]);
  });
});

describe("request to join, then approve or refuse", () => {
  let c: Company;
  beforeAll(async () => { c = await company(); });
  it("a login on the company's domain asks; the owner approves with the role and switch the owner picks", async () => {
    const a = await login(c.domain);
    const r = await team(a.cookie, { action: "request", organisationId: c.org });
    expect(r.status, r.text).toBe(200);
    const id = r.json!.membershipId;
    expect(await mem(id)).toMatchObject({ status: "join_requested", role: "viewer", is_signer: false, portal_user_id: a.id });
    expect(await me(a.cookie)).toBeNull();
    expect((await team(c.owner.cookie, { action: "approve", membershipId: id, role: "viewer", isSigner: true })).json).toEqual({ code: "VIEWER_NOT_SIGNER" });
    expect((await mem(id)).status).toBe("join_requested");
    expect((await team(c.owner.cookie, { action: "approve", membershipId: id, role: "poster", isSigner: true })).status).toBe(200);
    expect(await me(a.cookie)).toMatchObject({ id, role: "poster", isSigner: true, organisationId: c.org });
    expect((await audits("membership.request", id))[0]).toMatchObject({ actor_portal_user_id: a.id, after: { status: "join_requested" } });
    expect((await audits("membership.approve", id))[0]).toMatchObject({ actor_portal_user_id: c.owner.id, before: { status: "join_requested" }, after: { status: "active", role: "poster", is_signer: true } });
  });
  it("the owner refuses a request; the login can ask again later", async () => {
    const b = await login(c.domain);
    const id = (await team(b.cookie, { action: "request", organisationId: c.org })).json!.membershipId;
    expect((await team(c.owner.cookie, { action: "refuse", membershipId: id })).status).toBe(200);
    expect((await mem(id)).status).toBe("removed");
    expect(await audits("membership.refuse", id)).toHaveLength(1);
    expect((await team(c.owner.cookie, { action: "approve", membershipId: id, role: "viewer", isSigner: false })).json).toEqual({ code: "MEMBER_NOT_FOUND" });
    expect((await team(b.cookie, { action: "request", organisationId: c.org })).status).toBe(200);
  });
  it("the asker can withdraw its own request (leave)", async () => {
    const d = await login(c.domain);
    const id = (await team(d.cookie, { action: "request", organisationId: c.org })).json!.membershipId;
    expect((await team(d.cookie, { action: "leave" })).status).toBe(200);
    expect((await mem(id)).status).toBe("removed");
    expect((await team(d.cookie, { action: "leave" })).json).toEqual({ code: "NOT_A_MEMBER" });
  });
  it("refused: another domain, a free provider, an unclaimed, rejected, banned or unknown company, a second request, a member", async () => {
    const off = await login("gmail.com");
    expect((await team(off.cookie, { action: "request", organisationId: c.org })).json).toEqual({ code: "NOT_ALLOWED_DOMAIN" });
    const a = await login(c.domain);
    for (const status of ["unclaimed", "rejected", "closed", "suspended"]) {
      const o = String(await F.org({ status }));
      await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'seed')", [o, c.domain]);
      expect((await team(a.cookie, { action: "request", organisationId: o })).json, status).toEqual({ code: "ORGANISATION_NOT_AVAILABLE" });
    }
    expect((await team(a.cookie, { action: "request", organisationId: "987654321" })).json).toEqual({ code: "ORGANISATION_NOT_AVAILABLE" });
    // a pending request elsewhere blocks a second one (one company per login, #130)
    const twin = await company();
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'seed')", [twin.org, c.domain]);
    expect((await team(a.cookie, { action: "request", organisationId: c.org })).status).toBe(200);
    expect((await team(a.cookie, { action: "request", organisationId: twin.org })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    expect((await team(a.cookie, { action: "request", organisationId: c.org })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    const owner = c.owner;
    expect((await team(owner.cookie, { action: "request", organisationId: twin.org })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
  });
  it("approval rechecks the company and the requester; another company's owner cannot answer our request", async () => {
    const x = await company(), other = await company();
    const a = await login(x.domain), b = await login(x.domain);
    const ra = (await team(a.cookie, { action: "request", organisationId: x.org })).json!.membershipId;
    const rb = (await team(b.cookie, { action: "request", organisationId: x.org })).json!.membershipId;
    for (const body of [{ action: "approve", membershipId: ra, role: "viewer", isSigner: false }, { action: "refuse", membershipId: ra }])
      expect((await team(other.owner.cookie, body)).json, body.action).toEqual({ code: "MEMBER_NOT_FOUND" });
    await db.query("app_admin", "update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='fake' where id=$1", [b.id]);
    expect((await team(x.owner.cookie, { action: "approve", membershipId: rb, role: "viewer", isSigner: false })).json).toEqual({ code: "REFUSED" });
    await su.query("update organisation set status='suspended' where id=$1", [x.org]);
    expect((await team(x.owner.cookie, { action: "approve", membershipId: ra, role: "viewer", isSigner: false })).json).toEqual({ code: "ORGANISATION_NOT_AVAILABLE" });
    expect([(await mem(ra)).status, (await mem(rb)).status]).toEqual(["join_requested", "join_requested"]);
  });
  it("accepting an invite drops the login's own open request elsewhere", async () => {
    const other = await company();
    const a = await login(c.domain);
    const req = (await team(a.cookie, { action: "request", organisationId: c.org })).json!.membershipId;
    await invite(other, a.email);
    expect((await team(a.cookie, { action: "accept", token: tokenFor(a.email) })).status).toBe(200);
    expect((await mem(req)).status).toBe("removed");
    expect((await me(a.cookie))?.organisationId).toBe(other.org);
  });
});

describe("remove and leave", () => {
  it("the owner removes a member: access ends at once, and the removed member can do nothing", async () => {
    const c = await company(), p = await joined(c, "poster", true);
    expect((await team(c.owner.cookie, { action: "remove", membershipId: p.mem })).status).toBe(200);
    expect(await me(p.cookie)).toBeNull();
    expect((await list(p.cookie)).json!.team).toBeNull();
    expect(await mem(p.mem)).toMatchObject({ status: "removed", portal_user_id: p.id });
    expect((await audits("membership.remove", p.mem))[0]).toMatchObject({ before: { status: "active" }, after: { status: "removed" } });
    for (const body of [{ action: "remove", membershipId: c.owner.mem }, { action: "transfer", membershipId: c.owner.mem }, { action: "leave" }])
      expect((await team(p.cookie, body)).status, JSON.stringify(body)).toBeGreaterThanOrEqual(403);
    expect((await team(c.owner.cookie, { action: "remove", membershipId: p.mem })).json).toEqual({ code: "MEMBER_NOT_FOUND" });
  });
  it("the owner withdraws an invite: its token stops working", async () => {
    const c = await company(), l = await login(c.domain);
    const id = (await invite(c, l.email)).json!.membershipId;
    expect((await team(c.owner.cookie, { action: "remove", membershipId: id })).status).toBe(200);
    expect(await mem(id)).toMatchObject({ status: "removed", invited_email: null, invite_token_hash: null });
    expect((await team(l.cookie, { action: "accept", token: tokenFor(l.email) })).json).toEqual({ code: "INVITE_NOT_VALID" });
  });
  it("the owner cannot remove itself, and cannot leave while others are active", async () => {
    const c = await company();
    await joined(c, "viewer");
    expect((await team(c.owner.cookie, { action: "remove", membershipId: c.owner.mem })).json).toEqual({ code: "MEMBER_NOT_FOUND" });
    expect((await team(c.owner.cookie, { action: "leave" })).json).toEqual({ code: "OWNER_MUST_TRANSFER" });
    expect((await mem(c.owner.mem)).status).toBe("active");
  });
  it("a member leaves", async () => {
    const c = await company(), r = await joined(c, "recruiter");
    expect((await team(r.cookie, { action: "leave" })).status).toBe(200);
    expect((await mem(r.mem)).status).toBe("removed");
    expect((await audits("membership.leave", r.mem))[0]).toMatchObject({ actor_portal_user_id: r.id, after: { status: "removed", dropped_pending: 0 } });
  });
  it("the last member of a verified company leaves: the company stays verified with its jobs, and its open invites and requests go (#132)", async () => {
    const c = await company(), l = await login(c.domain), asker = await login(c.domain);
    const inv = (await invite(c, l.email)).json!.membershipId;
    const req = (await team(asker.cookie, { action: "request", organisationId: c.org })).json!.membershipId;
    expect((await team(c.owner.cookie, { action: "leave" })).status).toBe(200);
    expect((await one("select status, claimed_at from organisation where id=$1", [c.org])).status).toBe("verified");
    expect([(await mem(inv)).status, (await mem(req)).status, (await mem(c.owner.mem)).status]).toEqual(["removed", "removed", "removed"]);
    expect((await audits("membership.leave", c.owner.mem))[0].after).toEqual({ status: "removed", dropped_pending: 2 });
    expect((await team(l.cookie, { action: "accept", token: tokenFor(l.email) })).json).toEqual({ code: "INVITE_NOT_VALID" });
  });
});

describe("role and signer switch", () => {
  it("the owner changes a member's role and switch; one audit row with before and after", async () => {
    const c = await company(), p = await joined(c, "poster");
    expect((await team(c.owner.cookie, { action: "role", membershipId: p.mem, role: "recruiter", isSigner: true })).status).toBe(200);
    expect(await me(p.cookie)).toMatchObject({ role: "recruiter", isSigner: true });
    expect((await audits("membership.role", p.mem))[0]).toMatchObject({ before: { role: "poster", is_signer: false }, after: { role: "recruiter", is_signer: true } });
    expect((await team(c.owner.cookie, { action: "role", membershipId: p.mem, role: "viewer", isSigner: false })).status).toBe(200);
    expect(await me(p.cookie)).toMatchObject({ role: "viewer", isSigner: false });
  });
  it("a viewer is never a signer, by invite or by role change (#103)", async () => {
    const c = await company(), p = await joined(c, "poster", true);
    expect((await team(c.owner.cookie, { action: "role", membershipId: p.mem, role: "viewer", isSigner: true })).json).toEqual({ code: "VIEWER_NOT_SIGNER" });
    expect((await invite(c, "fake.v@example.test", "viewer", true)).json).toEqual({ code: "VIEWER_NOT_SIGNER" });
    expect(await mem(p.mem)).toMatchObject({ role: "poster", is_signer: true });
  });
  it("refused on the owner itself, an invite, a removed member and another company's member", async () => {
    const c = await company(), other = await company(), theirs = await joined(other, "poster"), gone = await joined(c, "poster");
    await team(c.owner.cookie, { action: "remove", membershipId: gone.mem });
    const inv = (await invite(c, "fake.r@example.test")).json!.membershipId;
    for (const membershipId of [c.owner.mem, inv, gone.mem, theirs.mem, other.owner.mem])
      expect((await team(c.owner.cookie, { action: "role", membershipId, role: "recruiter", isSigner: false })).json, String(membershipId)).toEqual({ code: "MEMBER_NOT_FOUND" });
    expect(await mem(theirs.mem)).toMatchObject({ role: "poster", status: "active" });
  });
});

describe("owner transfer", () => {
  it("to an active member: the new owner can manage the team, the old owner is a recruiter with its signer switch", async () => {
    const c = await company(), r = await joined(c, "poster");
    expect((await team(c.owner.cookie, { action: "transfer", membershipId: r.mem })).status).toBe(200);
    expect(await me(r.cookie)).toMatchObject({ role: "account_owner" });
    expect(await me(c.owner.cookie)).toMatchObject({ role: "recruiter", isSigner: true });
    expect(await count("select 1 from membership where organisation_id=$1 and role='account_owner' and status='active'", [c.org])).toBe(1);
    expect((await invite(c, "fake.x@example.test")).json).toEqual({ code: "NOT_OWNER" });
    expect((await team(r.cookie, { action: "invite", email: "fake.x@example.test", role: "viewer", isSigner: false })).status).toBe(200);
    expect((await audits("membership.transfer", r.mem))[0]).toMatchObject({ actor_portal_user_id: c.owner.id, before: { role: "poster", old_owner_membership: Number(c.owner.mem) }, after: { role: "account_owner", old_owner_role: "recruiter" } });
  });
  it("refused to itself, an invite, a join request, another company's member, and a blocked or deleted member", async () => {
    const c = await company(), other = await company(), asker = await login(c.domain);
    const inv = (await invite(c, "fake.y@example.test")).json!.membershipId;
    const req = (await team(asker.cookie, { action: "request", organisationId: c.org })).json!.membershipId;
    for (const membershipId of [c.owner.mem, inv, req, other.owner.mem])
      expect((await team(c.owner.cookie, { action: "transfer", membershipId })).json, String(membershipId)).toEqual({ code: "MEMBER_NOT_FOUND" });
    const b = await joined(c, "recruiter"), d = await joined(c, "recruiter");
    await db.query("app_admin", "update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='fake' where id=$1", [b.id]);
    await su.query("update portal_user set deleted_at=now() where id=$1", [d.id]);
    for (const x of [b, d]) expect((await team(c.owner.cookie, { action: "transfer", membershipId: x.mem })).json).toEqual({ code: "REFUSED" });
    expect((await mem(c.owner.mem)).role).toBe("account_owner");
  });
});

describe("C4: transfer, invite, approve and role need a sign-in in the last 10 minutes", () => {
  const age = (id: string, sql = "now() - interval '11 minutes'") => su.query(`update portal_session set created_at = ${sql} where user_id = $1`, [id]);
  // One company with a member of every role, a target member and an open join request; each test ages the actor's session.
  async function setup() {
    const c = await company(), target = await joined(c, "recruiter"), asker = await login(c.domain);
    const req = (await team(asker.cookie, { action: "request", organisationId: c.org })).json!.membershipId as string;
    const actors: Record<string, Login> = {
      owner: c.owner, posterSigner: await joined(c, "poster", true), poster: await joined(c, "poster"), recruiter: await joined(c, "recruiter"),
      viewer: await joined(c, "viewer"), noCompany: await login(c.domain),
    };
    return { c, target, req, actors };
  }
  const sensitive = (x: Awaited<ReturnType<typeof setup>>, i: number) => [
    { action: "transfer", membershipId: x.target.mem },
    { action: "invite", email: `fake.c4.${i}@${x.c.domain}`, role: "viewer", isSigner: false },
    { action: "approve", membershipId: x.req, role: "viewer", isSigner: false },
    { action: "role", membershipId: x.target.mem, role: "poster", isSigner: true },
  ];
  it("every role with a stale session gets REAUTH_REQUIRED on each, and nothing changes; fresh, the owner may and the others get their usual refusal", async () => {
    const x = await setup();
    let i = 0;
    for (const [name, who] of Object.entries(x.actors)) {
      await age(who.id);
      for (const body of sensitive(x, i++)) expect(await team(who.cookie, body), `${name} ${body.action}`).toMatchObject({ status: 403, json: { code: "REAUTH_REQUIRED" } });
    }
    expect(await mem(x.target.mem)).toMatchObject({ status: "active", role: "recruiter", is_signer: false });
    expect(await mem(x.req)).toMatchObject({ status: "join_requested" });
    expect(await count("select 1 from membership where organisation_id = $1 and status = 'invited'", [x.c.org])).toBe(0);
    expect(mail().filter((m) => m.kind === "invite" && m.to.startsWith("fake.c4."))).toEqual([]);
    for (const [name, who] of Object.entries(x.actors)) {
      if (name === "owner") continue;
      await age(who.id, "now()");
      for (const body of sensitive(x, i++)) expect(["NOT_OWNER", "NOT_A_MEMBER"], `${name} ${body.action}`).toContain((await team(who.cookie, body)).json!.code); // the database's own refusal
    }
    await age(x.c.owner.id, "now() - interval '9 minutes'");
    const [transfer, inv, approve, role] = sensitive(x, i++);
    for (const body of [inv, approve, role, transfer]) expect((await team(x.c.owner.cookie, body!)).status, body!.action).toBe(200);
    expect(await mem(x.target.mem)).toMatchObject({ role: "account_owner" });
  });
  it("remove, refuse, leave, request and accept still work with a stale session", async () => {
    const x = await setup();
    const invited = await login(x.c.domain);
    expect((await invite(x.c, invited.email)).status).toBe(200);
    for (const who of [x.c.owner, invited, x.actors.viewer!, x.actors.noCompany!]) await age(who.id);
    expect((await team(invited.cookie, { action: "accept", token: tokenFor(invited.email) })).status).toBe(200);
    expect((await team(x.c.owner.cookie, { action: "refuse", membershipId: x.req })).status).toBe(200);
    expect((await team(x.c.owner.cookie, { action: "remove", membershipId: x.target.mem })).status).toBe(200);
    expect((await team(x.actors.viewer!.cookie, { action: "leave" })).status).toBe(200);
    expect((await team(x.actors.noCompany!.cookie, { action: "request", organisationId: x.c.org })).status).toBe(200);
  });
  it("a stale refusal costs requirePortal's 3 statements only (no rate count, no function)", async () => {
    const x = await setup();
    await age(x.c.owner.id);
    const [r, stmts] = await counted(() => team(x.c.owner.cookie, { action: "transfer", membershipId: x.target.mem }));
    expect(r.status).toBe(403);
    expect(stmts).toBeLessThanOrEqual(3);
  });
});

describe("the member limit (#103: 10, counting members, live invites and join requests)", () => {
  it("the 11th person is refused for an invite and a request; an expired invite frees its place; app_admin can raise the limit", async () => {
    const c = await company();
    for (let i = 0; i < 5; i++) await joined(c, "viewer"); // 6 members
    for (let i = 0; i < 3; i++) expect((await invite(c, `fake.full${i}@example.test`)).status).toBe(200); // 9
    const asker = await login(c.domain);
    expect((await team(asker.cookie, { action: "request", organisationId: c.org })).status).toBe(200); // 10
    expect((await invite(c, "fake.full9@example.test")).json).toEqual({ code: "TEAM_FULL" });
    expect((await team((await login(c.domain)).cookie, { action: "request", organisationId: c.org })).json).toEqual({ code: "TEAM_FULL" });
    await su.query("update membership set invite_expires_at = now() - interval '1 second' where organisation_id=$1 and invited_email='fake.full0@example.test'", [c.org]);
    expect((await invite(c, "fake.full9@example.test")).status).toBe(200);
    expect(await count("select 1 from membership where organisation_id=$1 and invited_email='fake.full0@example.test'", [c.org])).toBe(0);
    expect((await invite(c, "fake.full10@example.test")).json).toEqual({ code: "TEAM_FULL" });
    await db.query("app_admin", "update organisation set member_limit = 11 where id=$1", [c.org]);
    expect((await invite(c, "fake.full10@example.test")).status).toBe(200);
    expect(await count("select 1 from membership where organisation_id=$1 and status <> 'removed'", [c.org])).toBe(11);
  });
});

describe("security", () => {
  let c: Company, viewer: Login & { mem: string }, poster: Login & { mem: string }, recruiter: Login & { mem: string };
  beforeAll(async () => {
    c = await company();
    viewer = await joined(c, "viewer"); poster = await joined(c, "poster", true); recruiter = await joined(c, "recruiter", true);
  });
  const ownerActions = (target: string) => [
    { action: "invite", email: "fake.sneak@example.test", role: "recruiter", isSigner: true }, { action: "remove", membershipId: target },
    { action: "role", membershipId: target, role: "recruiter", isSigner: true }, { action: "transfer", membershipId: target },
    { action: "approve", membershipId: target, role: "recruiter", isSigner: true }, { action: "refuse", membershipId: target },
  ];
  const unchanged = async () => {
    expect(await count("select 1 from membership where organisation_id=$1 and status='active'", [c.org])).toBe(4);
    expect((await mem(c.owner.mem)).role).toBe("account_owner");
    expect(await count("select 1 from membership where invited_email='fake.sneak@example.test'")).toBe(0);
  };
  it("viewer, poster and recruiter cannot do any owner action", async () => {
    for (const l of [viewer, poster, recruiter]) for (const body of ownerActions(viewer.mem === l.mem ? poster.mem : viewer.mem))
      expect((await team(l.cookie, body)).json, `${l.email} ${body.action}`).toEqual({ code: "NOT_OWNER" });
    await unchanged();
  });
  it("a login with no company, an invited login that has not accepted, a removed member: NOT_OWNER", async () => {
    const none = await login(), inv = await login(c.domain), gone = await joined(c, "poster");
    await invite(c, inv.email);
    await team(c.owner.cookie, { action: "remove", membershipId: gone.mem });
    for (const l of [none, inv, gone]) for (const body of ownerActions(viewer.mem)) expect((await team(l.cookie, body)).json, body.action).toEqual({ code: "NOT_OWNER" });
    await unchanged();
  });
  it("the owner and a member of another company reach nothing here: our ids are not found for them", async () => {
    const other = await company(), theirs = await joined(other, "recruiter");
    for (const body of ownerActions(viewer.mem).slice(1)) {
      expect((await team(other.owner.cookie, body)).json, body.action).toEqual({ code: "MEMBER_NOT_FOUND" });
      expect((await team(theirs.cookie, body)).json, body.action).toEqual({ code: "NOT_OWNER" });
    }
    expect((await team(other.owner.cookie, { action: "request", organisationId: c.org })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    await unchanged();
  });
  it("a blocked and a deleted login: refused by the route on the open session, and by the functions when called directly", async () => {
    const owner2 = await company(), boss = owner2.owner;
    const b = await joined(owner2, "viewer"), d = await joined(owner2, "viewer");
    await db.query("app_admin", "update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='fake' where id = any($1)", [[b.id, boss.id]]);
    await su.query("update portal_user set deleted_at=now() where id=$1", [d.id]);
    for (const l of [b, d, boss]) for (const body of [{ action: "leave" }, ...ownerActions(viewer.mem)])
      expect((await team(l.cookie, body)).json, body.action).toEqual({ code: "REFUSED" });
    expect((await list(b.cookie)).json).toEqual({ code: "REFUSED" });
    const direct = (sql: string, args: unknown[]) => db.query("app_portal", sql, args).then(() => "ok", (e) => e.message);
    const hash = "0".repeat(64);
    for (const [sql, args] of [
      ["select private.team_invite($1, 'fake.d@example.test', 'viewer', false, $2)", [boss.id, hash]], ["select private.team_remove($1, $2)", [boss.id, 1]],
      ["select private.team_set_role($1, $2, 'viewer', false)", [boss.id, 1]], ["select private.team_transfer($1, $2)", [boss.id, 1]],
      ["select private.team_answer($1, $2, true, 'viewer', false)", [boss.id, 1]], ["select private.team_leave($1)", [b.id]], ["select private.team_leave($1)", [d.id]],
      ["select private.team_accept($1, $2)", [b.id, hash]], ["select private.team_accept($1, $2)", [d.id, hash]],
      ["select private.team_request($1, $2)", [b.id, c.org]], ["select private.team_request($1, $2)", [d.id, c.org]],
      ["select private.team_invite($1, 'fake.d@example.test', 'viewer', false, $2)", ["no-such-user", hash]],
    ] as [string, unknown[]][]) expect(await direct(sql, args), `${sql} ${args[0]}`).toMatch(/^team refused: REFUSED/);
    expect([(await mem(b.mem)).status, (await mem(d.mem)).status, (await mem(owner2.owner.mem)).status]).toEqual(["active", "active", "active"]);
  });
  it("an unconfirmed email cannot accept or request", async () => {
    const u = await login(c.domain);
    await invite(c, u.email);
    await su.query("update portal_user set email_verified=false where id=$1", [u.id]);
    expect((await team(u.cookie, { action: "accept", token: tokenFor(u.email) })).json).toEqual({ code: "EMAIL_NOT_VERIFIED" });
    expect((await team(u.cookie, { action: "request", organisationId: c.org })).json).toEqual({ code: "EMAIL_NOT_VERIFIED" });
  });
  it("a banned email domain: no invite to it, no accept and no request from it, each the generic REFUSED (#191)", async () => {
    const x = await company(), victim = await login("banned-team.example.test");
    await invite(x, victim.email);
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, 'banned-team.example.test', 'seed')", [x.org]);
    const asker = await login("banned-team.example.test");
    await team(asker.cookie, { action: "request", organisationId: x.org });
    const reqId = (await one("select id from membership where portal_user_id=$1", [asker.id])).id;
    await ban("banned-team.example.test");
    for (const r of [await invite(x, "fake.other@banned-team.example.test"), await team(victim.cookie, { action: "accept", token: tokenFor(victim.email) }),
      await team((await login("banned-team.example.test")).cookie, { action: "request", organisationId: x.org }),
      await team(x.owner.cookie, { action: "approve", membershipId: String(reqId), role: "viewer", isSigner: false })])
      expect([r.status, r.text]).toEqual([403, JSON.stringify({ code: "REFUSED" })]);
    expect(await me(victim.cookie)).toBeNull();
    expect(await me(asker.cookie)).toBeNull();
  });
  it("a banned exact address (#215, migration 0015): no invite to it, no accept and no request by it, no approval of it; the rest of its domain is not banned", async () => {
    const x = await company(), victim = await login(x.domain), asker = await login(x.domain), later = await login(x.domain);
    await invite(x, victim.email);
    await team(asker.cookie, { action: "request", organisationId: x.org });
    const reqId = (await one("select id from membership where portal_user_id=$1", [asker.id])).id;
    for (const e of [victim.email, asker.email, later.email]) await ban(e.toLowerCase(), "email_address");
    for (const r of [await team(victim.cookie, { action: "accept", token: tokenFor(victim.email) }),
      await team(x.owner.cookie, { action: "approve", membershipId: String(reqId), role: "viewer", isSigner: false }),
      await team(later.cookie, { action: "request", organisationId: x.org }), await invite(x, later.email)])
      expect([r.status, r.text]).toEqual([403, JSON.stringify({ code: "REFUSED" })]);
    expect(await me(victim.cookie)).toBeNull();
    expect(await me(asker.cookie)).toBeNull();
    const fine = await login(x.domain);
    expect((await invite(x, fine.email)).status).toBe(200);
  });
  it("invite refuses the owner's own email, a member's, a join request's, and a live invite's (any case)", async () => {
    const x = await company(), m = await joined(x, "viewer"), asker = await login(x.domain);
    await team(asker.cookie, { action: "request", organisationId: x.org });
    await invite(x, "fake.twice@example.test");
    for (const email of [x.owner.email, m.email.toUpperCase(), asker.email, "Fake.Twice@example.test"])
      expect((await invite(x, email)).json, email).toEqual({ code: "ALREADY_IN_TEAM" });
    // an invited person who is also a member elsewhere can be invited, but cannot accept (one company per login, #130)
    expect((await invite(x, c.owner.email)).status).toBe(200);
    expect((await team(c.owner.cookie, { action: "accept", token: tokenFor(c.owner.email) })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    expect((await me(c.owner.cookie))?.organisationId).toBe(c.org);
  });
  it("companies that cannot take on people: no invite, no accept", async () => {
    const x = await company(), u = await login();
    await invite(x, u.email);
    await su.query("update organisation set status='closed' where id=$1", [x.org]);
    expect((await invite(x, "fake.closed@example.test")).json).toEqual({ code: "ORGANISATION_NOT_AVAILABLE" });
    expect((await team(u.cookie, { action: "accept", token: tokenFor(u.email) })).json).toEqual({ code: "ORGANISATION_NOT_AVAILABLE" });
  });

  describe("token attacks", () => {
    let x: Company, ann: Login, bob: Login;
    beforeAll(async () => { x = await company(); ann = await login(); bob = await login(); await invite(x, ann.email); });
    it("a wrong, guessed, empty or hash-for-token value is refused", async () => {
      const real = tokenFor(ann.email);
      expect((await team(ann.cookie, { action: "accept", token: "A".repeat(43) })).json).toEqual({ code: "INVITE_NOT_VALID" });
      expect((await team(ann.cookie, { action: "accept", token: real.replace(/.$/, real.endsWith("A") ? "B" : "A") })).json).toEqual({ code: "INVITE_NOT_VALID" });
      for (const token of ["", " ", createHash("sha256").update(real).digest("hex"), "' or '1'='1", null])
        expect((await team(ann.cookie, { action: "accept", token })).json, String(token)).toEqual({ code: "BAD_REQUEST" });
      // the stored hash itself, as a token, is hashed again and matches nothing
      expect((await team(ann.cookie, { action: "accept", token: Buffer.from(createHash("sha256").update(real).digest()).toString("base64url").slice(0, 43) })).json).toEqual({ code: "INVITE_NOT_VALID" });
      expect(await me(ann.cookie)).toBeNull();
    });
    it("another email's token is refused, and stays usable by its owner", async () => {
      expect((await team(bob.cookie, { action: "accept", token: tokenFor(ann.email) })).json).toEqual({ code: "INVITE_NOT_VALID" });
      expect(await me(bob.cookie)).toBeNull();
    });
    it("an expired token is refused", async () => {
      const late = await login();
      await invite(x, late.email);
      await su.query("update membership set invite_expires_at = now() - interval '1 second' where invited_email=$1", [late.email]);
      expect((await team(late.cookie, { action: "accept", token: tokenFor(late.email) })).json).toEqual({ code: "INVITE_NOT_VALID" });
    });
    it("a token for another company, used by a member of a company, is refused", async () => {
      await invite(x, recruiter.email);
      expect((await team(recruiter.cookie, { action: "accept", token: tokenFor(recruiter.email) })).json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
      expect((await me(recruiter.cookie))?.organisationId).toBe(c.org);
    });
    it("its rightful owner then accepts; reused, it is refused", async () => {
      const t = tokenFor(ann.email);
      expect((await team(ann.cookie, { action: "accept", token: t })).status).toBe(200);
      expect((await team(ann.cookie, { action: "accept", token: t })).json).toEqual({ code: "INVITE_NOT_VALID" });
    });
  });

  describe("races", () => {
    it("two accepts of one invite at once: one wins", async () => {
      const x = await company(), u = await login();
      await invite(x, u.email);
      const t = tokenFor(u.email);
      const rs = await Promise.all([1, 2, 3].map(() => team(u.cookie, { action: "accept", token: t })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 404, 404]);
      expect(await count("select 1 from membership where portal_user_id=$1 and status='active'", [u.id])).toBe(1);
    });
    it("one login accepting invites from two companies at once joins one", async () => {
      const x = await company(), y = await company(), u = await login();
      await invite(x, u.email); const tx = tokenFor(u.email);
      await invite(y, u.email); const ty = tokenFor(u.email);
      const rs = await Promise.all([team(u.cookie, { action: "accept", token: tx }), team(u.cookie, { action: "accept", token: ty })]);
      expect(rs.map((r) => r.json?.code ?? "ok").sort()).toEqual(["ALREADY_IN_A_COMPANY", "ok"]);
      expect(await count("select 1 from membership where portal_user_id=$1 and status='active'", [u.id])).toBe(1);
    });
    it("two transfers at once: one owner, the other refused", async () => {
      const x = await company(), a = await joined(x, "poster"), b = await joined(x, "poster");
      const rs = await Promise.all([team(x.owner.cookie, { action: "transfer", membershipId: a.mem }), team(x.owner.cookie, { action: "transfer", membershipId: b.mem })]);
      expect(rs.map((r) => r.json?.code ?? "ok").sort()).toEqual(["NOT_OWNER", "ok"]);
      expect(await count("select 1 from membership where organisation_id=$1 and role='account_owner' and status='active'", [x.org])).toBe(1);
    });
    it("invites racing to fill the team, while one invite is being accepted: never more than the limit", async () => {
      const x = await company();
      for (let i = 0; i < 7; i++) await joined(x, "viewer"); // 8
      const u = await login();
      await invite(x, u.email); // 9
      const rs = await Promise.all([team(u.cookie, { action: "accept", token: tokenFor(u.email) }), ...[0, 1, 2, 3].map((i) => invite(x, `fake.rush${i}@example.test`))]);
      expect(rs[0].status).toBe(200);
      expect(rs.slice(1).filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.slice(1).filter((r) => r.json?.code === "TEAM_FULL")).toHaveLength(3);
      expect(await count("select 1 from membership where organisation_id=$1 and status <> 'removed'", [x.org])).toBe(10);
    });
    it("join requests racing for the last places: never more than the limit", async () => {
      const x = await company();
      for (let i = 0; i < 7; i++) await joined(x, "viewer"); // 8
      const askers = await Promise.all([0, 1, 2, 3].map(() => login(x.domain)));
      const rs = await Promise.all(askers.map((a) => team(a.cookie, { action: "request", organisationId: x.org })));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
      expect(await count("select 1 from membership where organisation_id=$1 and status <> 'removed'", [x.org])).toBe(10);
    });
    it("the owner transferring and removing the same member at once: one wins, one owner stays", async () => {
      const x = await company(), a = await joined(x, "poster");
      const rs = await Promise.all([team(x.owner.cookie, { action: "transfer", membershipId: a.mem }), team(x.owner.cookie, { action: "remove", membershipId: a.mem })]);
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await count("select 1 from membership where organisation_id=$1 and role='account_owner' and status='active'", [x.org])).toBe(1);
    });
    it("staff remove the owner while the owner transfers: never two owners, never an owner who was removed", async () => {
      const x = await company(), a = await joined(x, "poster");
      const rs = await Promise.all([
        team(x.owner.cookie, { action: "transfer", membershipId: a.mem }),
        db.query("app_admin", "update membership set status='removed', removed_at=now() where id=$1", [x.owner.mem]),
      ]);
      expect((rs[0] as Reply).status === 200 || (rs[0] as Reply).json?.code === "NOT_OWNER").toBe(true);
      expect(await count("select 1 from membership where organisation_id=$1 and role='account_owner' and status='active'", [x.org])).toBeLessThanOrEqual(1);
      expect((await mem(x.owner.mem)).status).toBe("removed");
    });
  });

  describe("a change that lands while a call waits for its lock", () => {
    it("staff remove the owner while its transfer waits: refused, nothing moves", async () => {
      const x = await company(), a = await joined(x, "poster");
      const r = await underLock(ORG_LOCK, [x.org], () => team(x.owner.cookie, { action: "transfer", membershipId: a.mem }),
        (c) => c.query("update membership set status='removed', removed_at=now() where id=$1", [x.owner.mem]));
      expect(r.json).toEqual({ code: "NOT_OWNER" });
      expect([(await mem(a.mem)).role, await audits("membership.transfer", a.mem)]).toEqual(["poster", []]);
    });
    it("the invite is withdrawn while its accept waits: refused, the login joins nothing", async () => {
      const x = await company(), u = await login();
      const id = (await invite(x, u.email)).json!.membershipId;
      const r = await underLock(ORG_LOCK, [x.org], () => team(u.cookie, { action: "accept", token: tokenFor(u.email) }),
        (c) => c.query("update membership set status='removed', removed_at=now(), invited_email=null, invite_token_hash=null where id=$1", [id]));
      expect(r.json).toEqual({ code: "INVITE_NOT_VALID" });
      expect([await me(u.cookie), await audits("membership.accept", id)]).toEqual([null, []]);
    });
    it("the member is removed while its leave waits: refused, no leave is logged", async () => {
      const x = await company(), a = await joined(x, "poster");
      const r = await underLock(ORG_LOCK, [x.org], () => team(a.cookie, { action: "leave" }),
        (c) => c.query("update membership set status='removed', removed_at=now() where id=$1", [a.mem]));
      expect(r.json).toEqual({ code: "NOT_A_MEMBER" });
      expect(await audits("membership.leave", a.mem)).toEqual([]);
    });
    it("a join request elsewhere lands while the login's request waits: the second is refused", async () => {
      const x = await company(), y = await company(), u = await login(x.domain);
      const r = await underLock(USER_LOCK, [u.id], () => team(u.cookie, { action: "request", organisationId: x.org }),
        (c) => c.query("insert into membership(organisation_id, portal_user_id, role, status) values ($1, $2, 'viewer', 'join_requested')", [y.org, u.id]));
      expect(r.json).toEqual({ code: "ALREADY_IN_A_COMPANY" });
    });
    it("a join request elsewhere lands while the login's accept waits: the accept drops it", async () => {
      const x = await company(), y = await company(), u = await login();
      await invite(x, u.email);
      let req = 0;
      const r = await underLock(USER_LOCK, [u.id], () => team(u.cookie, { action: "accept", token: tokenFor(u.email) }),
        async (c) => { req = (await c.query("insert into membership(organisation_id, portal_user_id, role, status) values ($1, $2, 'viewer', 'join_requested') returning id", [y.org, u.id])).rows[0].id; });
      expect(r.status).toBe(200);
      expect((await mem(String(req))).status).toBe("removed");
    });
  });

  it("a body naming another user or company is refused", async () => {
    for (const body of [{ action: "leave", portalUserId: viewer.id }, { action: "invite", email: "fake.z@example.test", role: "viewer", isSigner: false, organisationId: 1 },
      { action: "remove", membershipId: viewer.mem, organisationId: c.org }, { action: "accept", token: "A".repeat(43), portal_user_id: viewer.id },
      { action: "transfer", membershipId: recruiter.mem, userId: recruiter.id }])
      expect((await team(c.owner.cookie, body)).json, JSON.stringify(body)).toEqual({ code: "BAD_REQUEST" });
    await unchanged();
  });
  it("a missing or foreign Origin is refused before anything is read", async () => {
    for (const origin of [null, "https://evil.example.test", "null", "http://localhost:3000", "http://localhost:3001.evil.example.test"])
      expect((await team(c.owner.cookie, { action: "remove", membershipId: viewer.mem }, { origin })).json, String(origin)).toEqual({ code: "BAD_ORIGIN" });
    await unchanged();
  });
  it("odd, oversized and SQL-looking bodies are refused; an SQL-looking address is stored as plain text", async () => {
    for (const raw of ["", "not json", "[1]", "null", "1", `{"action": "remove", "membershipId": "1 or 1=1"}`, `{"action": "remove; drop table membership"}`,
      `{"action": "role", "membershipId": 1, "role": "account_owner", "isSigner": true}`, `{"action": "leave", "action": "remove"}`])
      expect((await team(c.owner.cookie, undefined, { raw })).json, raw).toEqual({ code: "BAD_REQUEST" });
    expect((await team(c.owner.cookie, undefined, { raw: JSON.stringify({ action: "leave", pad: "x".repeat(5000) }) })).json).toEqual({ code: "BODY_TOO_LARGE" });
    let read = false;
    const req = { headers: new Headers({ origin: BASE, "content-length": "99999999" }), text: async () => { read = true; return "{}"; } } as unknown as Request;
    expect([(await reply(await teamPOST(req))).status, read]).toEqual([413, false]);
    await unchanged();
    const x = await company();
    const r = await invite(x, "o'brien;drop-table@example.test");
    expect(r.status, r.text).toBe(200);
    expect((await mem(r.json!.membershipId)).invited_email).toBe("o'brien;drop-table@example.test");
    // the function refuses a bad role, email or hash even if the route let one through
    for (const [sql, args] of [["select private.team_invite($1, 'x', 'viewer', false, $2)", [x.owner.id, "0".repeat(64)]], ["select private.team_invite($1, 'a@b.test', 'account_owner', false, $2)", [x.owner.id, "0".repeat(64)]],
      ["select private.team_invite($1, 'a@b.test', 'viewer', false, 'raw-token')", [x.owner.id]], ["select private.team_set_role($1, $2, 'account_owner', true)", [c.owner.id, viewer.mem]]] as [string, unknown[]][])
      await expect(db.query("app_portal", sql, args)).rejects.toThrow(/team refused: BAD_REQUEST/);
  });
  it("20 team calls in 10 minutes per login, then 429; another login is not held back", async () => {
    const u = await login(), seq = [];
    for (let i = 0; i < 22; i++) seq.push((await team(u.cookie, { action: "leave" })).status);
    expect(seq).toEqual([...Array(20).fill(403), 429, 429]); // NOT_A_MEMBER is 403, as on the jobs and status routes
    expect((await team((await login()).cookie, { action: "leave" })).status).toBe(403);
  });
  it("the portal login still cannot write membership directly (#184)", async () => {
    await expect(db.query("app_portal", "update membership set role='account_owner' where id=$1", [viewer.mem])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the replies match docs/openapi/portal.yaml", () => {
  it("the owner's team with an invite and a request, the invite reply, a leave with no company (403): ids as text, times with Z", async () => {
    const spec = loadSpec("portal");
    const c = await company();
    await joined(c, "poster", true);
    const inv = await invite(c, "fake.schema@example.test");
    expect([inv.status, replyProblems(spec, "POST", "/api/portal/team", inv.status, inv.json)]).toEqual([200, []]);
    expect(inv.json!.expiresAt).toMatch(/Z$/);
    expect(typeof inv.json!.membershipId).toBe("string");
    await team((await login(c.domain)).cookie, { action: "request", organisationId: c.org });
    const g = await list(c.owner.cookie);
    expect([g.status, replyProblems(spec, "GET", "/api/portal/team", g.status, g.json)]).toEqual([200, []]);
    expect(g.json!.team.invites[0].expiresAt).toMatch(/Z$/);
    expect(typeof g.json!.team.myMembershipId).toBe("string");
    const leave = await team((await login()).cookie, { action: "leave" });
    expect([leave.status, leave.json, replyProblems(spec, "POST", "/api/portal/team", leave.status, leave.json)]).toEqual([403, { code: "NOT_A_MEMBER" }, []]);
  });
});

describe("budgets: median of 9 calls", () => {
  it("invite and accept stay within their statement and time budgets", async () => {
    const x = await company();
    await db.query("app_admin", "update organisation set member_limit = 50 where id=$1", [x.org]);
    const people = await Promise.all(Array.from({ length: 11 }, () => login()));
    let i = 0;
    await invite(x, people[i++]!.email); // warm
    const [, si] = await counted(() => invite(x, people[i++]!.email));
    expect(si, `${si} invite statements`).toBeLessThanOrEqual(BUDGET.invite);
    i = 2;
    const inviteMs = await median(() => invite(x, people[i++]!.email));
    expect(inviteMs).toBeLessThan(BUDGET.inviteMs);
    await team(people[0]!.cookie, { action: "accept", token: tokenFor(people[0]!.email) }); // warm
    const [, sa] = await counted(() => team(people[1]!.cookie, { action: "accept", token: tokenFor(people[1]!.email) }));
    expect(sa, `${sa} accept statements`).toBeLessThanOrEqual(BUDGET.accept);
    i = 2;
    const acceptMs = await median(async () => { const p = people[i++]!; expect((await team(p.cookie, { action: "accept", token: tokenFor(p.email) })).status).toBe(200); });
    expect(acceptMs).toBeLessThan(BUDGET.acceptMs);
    console.log(`team budgets: invite ${si} statements, median ${inviteMs.toFixed(1)} ms; accept ${sa} statements, median ${acceptMs.toFixed(1)} ms`);
  });
});

// Step 16 B55 (frame E19): last active, the invite's send date and the resend action.
describe("B55: last active, invitedAt and resend", () => {
  const ageInvite = (mem: string, minutes: number) => su.query("update membership set invite_expires_at = now() + interval '7 days' - make_interval(mins => $2) where id = $1", [mem, minutes]);
  it("a portal sign-in sets last_active_at; the list shows it to every member, null when never set", async () => {
    const c = await company(), poster = await joined(c, "poster");
    const row = await one("select last_active_at from portal_user where id = $1", [poster.id]);
    expect(Date.now() - +row.last_active_at).toBeLessThan(60_000);
    const old = new Date("2026-01-02T03:04:05.000Z");
    await su.query("update portal_user set last_active_at = $2 where id = $1", [poster.id, old]);
    for (const who of [c.owner, poster]) {
      const t = (await list(who.cookie)).json!.team;
      expect(t.members.find((m: { membershipId: string }) => m.membershipId === poster.mem).lastActiveAt).toBe("2026-01-02T03:04:05.000Z");
      expect(t.members.find((m: { membershipId: string }) => m.membershipId === c.owner.mem).lastActiveAt).toMatch(/Z$/);
    }
    await su.query("update portal_user set last_active_at = null where id = $1", [poster.id]);
    expect((await list(c.owner.cookie)).json!.team.members.find((m: { membershipId: string }) => m.membershipId === poster.mem).lastActiveAt).toBeNull();
  });
  it("a session refresh sets it again; the staff pool is untouched (no such column write)", async () => {
    const c = await company();
    await su.query("update portal_user set last_active_at = '2026-01-01' where id = $1", [c.owner.id]);
    const again = await authCall("sign-in/email", { email: c.owner.email, password: c.owner.password });
    expect(again.status).toBe(200);
    expect(+(await one("select last_active_at from portal_user where id = $1", [c.owner.id])).last_active_at).toBeGreaterThan(Date.now() - 60_000);
  });
  it("the owner's invite list has invitedAt (7 days before the expiry), for the owner only", async () => {
    const c = await company(), poster = await joined(c, "poster");
    const r = await invite(c, "fake.invitedat@example.test", "viewer");
    const i = (await list(c.owner.cookie)).json!.team.invites[0];
    expect(+new Date(i.expiresAt) - +new Date(i.invitedAt)).toBe(7 * 86_400_000);
    expect(Date.now() - +new Date(i.invitedAt)).toBeLessThan(60_000);
    expect(r.json!.membershipId).toBe(i.membershipId);
    expect((await list(poster.cookie)).json!.team.invites).toBeUndefined();
  });
  it("resend: a new token (the old link stops), 7 more days, the same address, one audit row; the reply does not repeat the address", async () => {
    const c = await company(), who = await login("elsewhere.example.test");
    const inv = (await invite(c, who.email, "poster", true)).json!;
    const oldToken = tokenFor(who.email);
    expect((await team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId })).json).toEqual({ code: "RESEND_TOO_SOON" });
    await ageInvite(inv.membershipId, 10);
    const sent = mail().length;
    const r = await team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId });
    expect([r.status, Object.keys(r.json!).sort()]).toEqual([200, ["expiresAt", "membershipId"]]);
    expect(mail().length).toBe(sent + 1);
    expect(mail().at(-1)).toMatchObject({ kind: "invite", to: who.email });
    const fresh = tokenFor(who.email);
    expect(fresh).not.toBe(oldToken);
    expect(+new Date(r.json!.expiresAt) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect((await mem(inv.membershipId)).invite_token_hash).toBe(createHash("sha256").update(fresh).digest("hex"));
    expect(await audits("membership.resend", inv.membershipId)).toEqual([{ kind: "security", actor_portal_user_id: c.owner.id, before: null, after: { status: "invited" }, reason_text: null }]);
    expect((await team(who.cookie, { action: "accept", token: oldToken })).json).toEqual({ code: "INVITE_NOT_VALID" });
    expect((await team(who.cookie, { action: "accept", token: fresh })).status).toBe(200);
    expect((await mem(inv.membershipId))).toMatchObject({ status: "active", role: "poster", is_signer: true });
  });
  it("resend revives an expired invite; a second resend within 5 minutes is refused (429), nothing is sent", async () => {
    const c = await company(), who = await login();
    const inv = (await invite(c, who.email, "viewer")).json!;
    await su.query("update membership set invite_expires_at = now() - interval '1 day' where id = $1", [inv.membershipId]);
    expect((await team(who.cookie, { action: "accept", token: tokenFor(who.email) })).json).toEqual({ code: "INVITE_NOT_VALID" });
    expect((await team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId })).status).toBe(200);
    const sent = mail().length;
    const again = await team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId });
    expect([again.status, again.json, mail().length]).toEqual([429, { code: "RESEND_TOO_SOON" }, sent]);
    expect((await team(who.cookie, { action: "accept", token: tokenFor(who.email) })).status).toBe(200);
  });
  it("an email that cannot be sent leaves the old link working (502 EMAIL_FAILED)", async () => {
    const c = await company(), who = await login();
    const inv = (await invite(c, who.email, "poster")).json!;
    await ageInvite(inv.membershipId, 10);
    const before = await mem(inv.membershipId);
    const box = mail() as unknown as { push: (...a: unknown[]) => number };
    const push = box.push;
    box.push = () => { throw new Error("fake send failure"); };
    try { expect((await team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId })).json).toEqual({ code: "EMAIL_FAILED" }); } finally { box.push = push; }
    expect(await mem(inv.membershipId)).toEqual(before);
    expect(await audits("membership.resend", inv.membershipId)).toEqual([]);
  });
  it("refused: every other role, no session, another company's owner (404, as a missing id), an active member, a removed invite, a banned domain; a stale session may resend (no power is granted)", async () => {
    const c = await company(), d = await company(), who = await login(`banned${++dn}.example.test`); // its own domain: the ban below must not reach other tests
    const inv = (await invite(c, who.email, "poster")).json!;
    await ageInvite(inv.membershipId, 10);
    const roles = [await joined(c, "poster"), await joined(c, "recruiter"), await joined(c, "viewer")];
    const body = { action: "resend", membershipId: inv.membershipId };
    for (const r of roles) expect((await team(r.cookie, body)).json, r.email).toEqual({ code: "NOT_OWNER" });
    expect((await team(undefined, body)).json).toEqual({ code: "NO_SESSION" });
    expect((await team((await login()).cookie, body)).json).toEqual({ code: "NOT_OWNER" });
    expect((await team(d.owner.cookie, body)).json).toEqual({ code: "MEMBER_NOT_FOUND" });
    expect((await team(c.owner.cookie, { action: "resend", membershipId: roles[0]!.mem })).json).toEqual({ code: "MEMBER_NOT_FOUND" }); // an active member
    expect((await team(c.owner.cookie, { action: "resend", membershipId: c.owner.mem })).json).toEqual({ code: "MEMBER_NOT_FOUND" });
    expect((await team(c.owner.cookie, { action: "resend", membershipId: "999999999" })).json).toEqual({ code: "MEMBER_NOT_FOUND" });
    for (const bad of [{}, { membershipId: 5 }, { membershipId: "0" }, { membershipId: "1.5" }, { membershipId: "1; drop table membership" }, { membershipId: "9".repeat(30) }, { membershipId: inv.membershipId, role: "viewer" }, { membershipId: inv.membershipId, email: "a@b.test" }])
      expect((await team(c.owner.cookie, { action: "resend", ...bad })).json, JSON.stringify(bad)).toEqual({ code: "BAD_REQUEST" });
    expect((await team(c.owner.cookie, body, { origin: "https://evil.example.test" })).json).toEqual({ code: "BAD_ORIGIN" });
    expect(await audits("membership.resend", inv.membershipId)).toEqual([]);
    await su.query("update portal_session set created_at = now() - interval '11 minutes' where user_id = $1", [c.owner.id]);
    await ban(who.email.split("@")[1]!);
    expect((await team(c.owner.cookie, body)).json).toEqual({ code: "REFUSED" });
    await su.query("update membership set status = 'removed', invited_email = null, invite_token_hash = null where id = $1", [inv.membershipId]);
    expect((await team(c.owner.cookie, body)).json).toEqual({ code: "MEMBER_NOT_FOUND" });
    expect((await list(c.owner.cookie)).text).not.toMatch(/token|hash/i);
  });
  it("a company that cannot take on people cannot resend", async () => {
    const c = await company(), who = await login();
    const inv = (await invite(c, who.email, "viewer")).json!;
    await ageInvite(inv.membershipId, 10);
    await su.query("update organisation set status = 'suspended' where id = $1", [c.org]);
    expect((await team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId })).json).toEqual({ code: "ORGANISATION_NOT_AVAILABLE" });
  });
  it("a resend stays within its statement and time budget, and the reply matches the contract", async () => {
    const c = await company(), who = await login();
    const inv = (await invite(c, who.email, "viewer")).json!;
    const spec = loadSpec("portal");
    const run = async () => { await ageInvite(inv.membershipId, 10); return team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId }); };
    await run();
    await ageInvite(inv.membershipId, 10);
    const [r, stmts] = await counted(() => team(c.owner.cookie, { action: "resend", membershipId: inv.membershipId }));
    expect([r.status, replyProblems(spec, "POST", "/api/portal/team", r.status, r.json)]).toEqual([200, []]);
    expect(stmts, `${stmts} resend statements`).toBeLessThanOrEqual(7); // as an invite: requirePortal 3, rate count, begin, the function, commit
    const ms = await median(run);
    expect(ms).toBeLessThan(25);
  });
});
