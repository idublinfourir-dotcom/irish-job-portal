// Step 8 status page, end to end on the test database through the real /api/portal/status handlers, connected as app_portal, with real
// portal sessions (sign-up, confirm and sign-in through the real auth route). No test calls the real network. Fake people only.
// Strike rows are seeded as the database owner with triggers off (session_replication_role = replica) so dates and levels are free.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";

// Statements counted on every pg.Client.query call, measured on 12 November 2026: the status page 4 (requirePortal 3, the page 1); a reply 5 (requirePortal 3, rate count 1, the function).
// Times, median of 9 calls, measured warm: page 1.7 to 2.3 ms, reply 5.0 to 6.5 ms (four runs of this file). Budgets are about 4 times the slowest median, with a floor for a busy laptop. Raise these only on purpose.
const BUDGET = { get: 4, post: 5, getMs: 10, postMs: 30 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, statusGET: Handler, statusPOST: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number | string, user: string | null, o?: object): Promise<number>; staff(): Promise<string> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: statusGET, POST: statusPOST } = await import("../../../apps/portal/app/api/portal/status/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit where key like 'status:%'"); });

let ipn = 0;
const freshIp = () => `10.8.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
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
// A status POST. origin: null sends no Origin header.
async function post(cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return reply(await statusPOST(new Request(`${BASE}/api/portal/status`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers })));
}
const page = async (cookie?: string) => reply(await statusGET(new Request(`${BASE}/api/portal/status`, { headers: cookie ? { cookie } : {} })));
const act = (cookie: string | undefined, action: string, caseId: string, text = "Our reply.") => post(cookie, { action, caseId, text });
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

let n = 0;
type Login = { email: string; cookie: string; id: string };
async function login(domain = "elsewhere.example.test"): Promise<Login> {
  const p = { email: `fake.s${++n}@${domain}`, password: `Fake-s${n}-password-1`, name: `Fake S${n}`, ...portalAnswers };
  expect((await authCall("sign-up/email", p)).status).toBe(200);
  await click(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link);
  const r = await authCall("sign-in/email", { email: p.email, password: p.password });
  expect(r.status, r.text).toBe(200);
  return { email: p.email, cookie: r.cookie, id: (await one("select id from portal_user where email=$1", [p.email])).id };
}
type Company = { org: string; owner: Login & { mem: string }; viewer: Login & { mem: string } };
async function company(status = "verified"): Promise<Company> {
  const org = String(await F.org({ status }));
  const owner = await login(), viewer = await login();
  return {
    org,
    owner: { ...owner, mem: String(await F.member(org, owner.id, { role: "account_owner", signer: true })) },
    viewer: { ...viewer, mem: String(await F.member(org, viewer.id, { role: "viewer" })) },
  };
}
const DAY = "interval '1 day'";
type Seed = { kind?: string; reason?: string; level?: number | null; stage?: string; outcome?: string | null; reply?: string | null; decided?: string | null; appealDue?: string | null; appealed?: string | null; appealDecided?: string | null; approval?: boolean; appealStaff?: boolean };
// A strike row. Times are SQL expressions, e.g. "now() + interval '3 days'".
async function strike(org: string, s: Seed = {}): Promise<string> {
  const c = await su.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    let approval: string | null = null;
    if (s.approval) {
      const a = await F.staff(), b = await F.staff();
      approval = (await c.query("insert into approval_request(kind, target_table, target_id, proposed_by_staff_user_id, confirmed_by_staff_user_id, status) values ('strike_2','strike','x',$1,$2,'confirmed') returning id", [a, b])).rows[0].id;
    }
    const staff = s.appealStaff ? await F.staff() : null;
    const id = (await c.query(
      `insert into strike(organisation_id, case_kind, reason_code, notice_summary, level, stage, outcome, reply_due_at, decided_at, appeal_due_at, appealed_at, appeal_decided_at, approval_request_id, appeal_decided_by_staff_user_id)
       values ($1, $2, $3, 'Fake notice', $4, $5, $6, ${s.reply ?? "null"}, ${s.decided ?? "null"}, ${s.appealDue ?? "null"}, ${s.appealed ?? "null"}, ${s.appealDecided ?? "null"}, $7, $8) returning id`,
      [org, s.kind ?? "false_claim", s.reason ?? "false_sponsorship", s.level ?? null, s.stage ?? "reply_window", s.outcome ?? null, approval, staff])).rows[0].id;
    await c.query("commit");
    return String(id);
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally { c.release(); }
}
const waiting = (org: string, o: Seed = {}) => strike(org, { reply: `now() + 3 * ${DAY}`, stage: "reply_window", ...o });
const decided = (org: string, o: Seed = {}) => strike(org, { reply: `now() - 10 * ${DAY}`, decided: `now() - 2 * ${DAY}`, appealDue: `now() + 12 * ${DAY}`, stage: "decided", outcome: "strike", level: 1, ...o });
const row = (id: string) => one("select stage, employer_reply, replied_at, appeal_text, appealed_at from strike where id=$1", [id]);
const KEYS = ["id", "caseKind", "reasonCode", "jobId", "jobTitle", "noticeSummary", "stage", "outcome", "level", "replyDueAt", "employerReply", "repliedAt", "decidedAt", "appealDueAt", "appealText", "appealedAt", "appealDecidedAt", "canReply", "canAppeal"].sort();
const found = (r: Reply, id: string) => r.json!.page.cases.find((c: { id: string }) => c.id === id);

describe("GET", () => {
  it("is 401 without a session and 404 NO_COMPANY for a login with no company (as the company GET)", async () => {
    expect((await page()).status).toBe(401);
    const l = await login();
    const r = await page(l.cookie);
    expect([r.status, r.json]).toEqual([404, { code: "NO_COMPANY" }]);
  });
  it("shows an empty company, to the owner and to a viewer", async () => {
    const c = await company();
    for (const l of [c.owner, c.viewer]) {
      const r = await page(l.cookie);
      expect(r.status).toBe(200);
      expect(r.json!.page).toMatchObject({ organisationId: c.org, status: "verified", isOwner: l === c.owner, strikesLast12Months: 0, cases: [], restrictedUntil: null });
    }
  });
  it("shows each state of a case with the right fields, never staff or report ids", async () => {
    const c = await company(), other = await company();
    const w = await waiting(c.org), d = await decided(c.org);
    const a = await decided(c.org, { stage: "appealed", appealed: `now() - ${DAY}` });
    const o = await decided(c.org, { stage: "overturned", appealed: `now() - 3 * ${DAY}`, appealDecided: `now() - ${DAY}`, appealDue: `now() - ${DAY}`, appealStaff: true });
    const hidden = await strike(c.org, { stage: "case_open" });
    const foreign = await waiting(other.org);
    const r = await page(c.owner.cookie);
    const ids = r.json!.page.cases.map((x: { id: string }) => x.id);
    expect(ids).toEqual([o, a, d, w]); // newest first
    expect(ids).not.toContain(hidden);
    expect(ids).not.toContain(foreign);
    for (const x of r.json!.page.cases) expect(Object.keys(x).sort()).toEqual(KEYS);
    expect(r.text).not.toMatch(/report_id|reportId|staff/i);
    expect(found(r, w)).toMatchObject({ stage: "reply_window", canReply: true, canAppeal: false, employerReply: null, noticeSummary: "Fake notice" });
    expect(found(r, d)).toMatchObject({ stage: "decided", outcome: "strike", level: 1, canReply: false, canAppeal: true });
    expect(found(r, a)).toMatchObject({ stage: "appealed", canAppeal: false });
    expect(found(r, o)).toMatchObject({ stage: "overturned", canAppeal: false });
    const v = await page(c.viewer.cookie);
    expect(found(v, w)).toMatchObject({ canReply: false, canAppeal: false });
    expect(found(v, d)).toMatchObject({ canAppeal: false });
    expect(r.json!.page.strikesLast12Months).toBe(2); // d and a count (an appealed strike stands); o is overturned, w is undecided
  });
  it("counts strikes of the last 12 months only, shows a restriction and a suspension", async () => {
    const c = await company();
    await decided(c.org); await decided(c.org, { level: 2, approval: true });
    await decided(c.org, { decided: `now() - interval '13 months'`, appealDue: `now() - interval '13 months'` });
    const k = await su.connect(); // the guard only lets a strike_2 request set this, so switch triggers off for the seed
    try {
      await k.query("begin");
      await k.query("set local session_replication_role = replica");
      await k.query("update organisation set restricted_until = now() + interval '30 days' where id=$1", [c.org]);
      await k.query("commit");
    } finally { k.release(); }
    let r = await page(c.owner.cookie);
    expect(r.json!.page.strikesLast12Months).toBe(2);
    expect(r.json!.page.restrictedUntil).not.toBeNull();
    const ban = await company("suspended");
    const b = await decided(ban.org, { kind: "instant_ban", reason: "fake_company", level: null, outcome: "ban", approval: true });
    r = await page(ban.owner.cookie);
    expect(r.json!.page.status).toBe("suspended");
    expect(found(r, b)).toMatchObject({ caseKind: "instant_ban", outcome: "ban", level: null });
    expect(r.json!.page.strikesLast12Months).toBe(0);
  });
});

describe("POST reply and appeal", () => {
  it("replies inside the window, once", async () => {
    const c = await company(), id = await waiting(c.org);
    const r = await act(c.owner.cookie, "reply", id, "  We are sorry.  ");
    expect([r.status, r.json]).toEqual([200, { caseId: id, kind: "reply" }]);
    expect(await row(id)).toMatchObject({ employer_reply: "We are sorry.", stage: "reply_window" });
    expect((await row(id)).replied_at).not.toBeNull();
    const again = await act(c.owner.cookie, "reply", id, "Second");
    expect([again.status, again.json]).toEqual([409, { code: "ALREADY_REPLIED" }]);
    expect((await row(id)).employer_reply).toBe("We are sorry.");
  });
  it("refuses a reply after the window and on a decided case", async () => {
    const c = await company();
    const late = await strike(c.org, { reply: `now() - ${DAY}` }), dec = await decided(c.org);
    for (const id of [late, dec]) {
      const r = await act(c.owner.cookie, "reply", id);
      expect([r.status, r.json]).toEqual([409, { code: "REPLY_CLOSED" }]);
      expect((await row(id)).employer_reply).toBeNull();
    }
  });
  it("appeals inside the window, once, and refuses outside it and on an undecided case", async () => {
    const c = await company(), id = await decided(c.org);
    const r = await act(c.owner.cookie, "appeal", id, "We appeal.");
    expect([r.status, r.json]).toEqual([200, { caseId: id, kind: "appeal" }]);
    expect(await row(id)).toMatchObject({ stage: "appealed", appeal_text: "We appeal." });
    expect((await row(id)).appealed_at).not.toBeNull();
    expect((await act(c.owner.cookie, "appeal", id)).json).toEqual({ code: "ALREADY_APPEALED" });
    const old = await decided(c.org, { appealDue: `now() - ${DAY}` }), open = await waiting(c.org);
    for (const x of [old, open]) {
      const e = await act(c.owner.cookie, "appeal", x);
      expect([e.status, e.json]).toEqual([409, { code: "APPEAL_CLOSED" }]);
      expect((await row(x)).appeal_text).toBeNull();
    }
  });
  it("C4: an appeal needs a sign-in in the last 10 minutes, from every role; a reply does not", async () => {
    const c = await company(), id = await decided(c.org), w = await waiting(c.org);
    const age = (user: string, sql: string) => su.query(`update portal_session set created_at = ${sql} where user_id = $1`, [user]);
    for (const who of [c.owner, c.viewer]) await age(who.id, "now() - interval '11 minutes'");
    for (const who of [c.owner, c.viewer]) expect(await act(who.cookie, "appeal", id), "stale").toMatchObject({ status: 403, json: { code: "REAUTH_REQUIRED" } });
    expect(await row(id)).toMatchObject({ appeal_text: null, stage: "decided" });
    expect((await act(c.owner.cookie, "reply", w)).status).toBe(200); // a stale session may still reply
    for (const who of [c.owner, c.viewer]) await age(who.id, "now() - interval '9 minutes'");
    expect(await act(c.viewer.cookie, "appeal", id)).toMatchObject({ status: 403, json: { code: "NOT_OWNER" } }); // fresh, then the role check
    expect(await act(c.owner.cookie, "appeal", id)).toMatchObject({ status: 200, json: { kind: "appeal" } });
  });
  it("stores SQL-looking text verbatim", async () => {
    const c = await company(), id = await waiting(c.org), text = "'); drop table strike; --";
    expect((await act(c.owner.cookie, "reply", id, text)).status).toBe(200);
    expect((await row(id)).employer_reply).toBe(text);
  });
});

describe("security", () => {
  it("a viewer is refused, another company's owner finds no case, nothing changes", async () => {
    const c = await company(), other = await company(), w = await waiting(c.org), d = await decided(c.org);
    for (const [who, action, id, code, status] of [[c.viewer, "reply", w, "NOT_OWNER", 403], [c.viewer, "appeal", d, "NOT_OWNER", 403],
      [other.owner, "reply", w, "CASE_NOT_FOUND", 404], [other.owner, "appeal", d, "CASE_NOT_FOUND", 404]] as const) {
      const r = await act(who.cookie, action, id);
      expect([r.status, r.json], `${action} ${code}`).toEqual([status, { code }]);
    }
    expect(await row(w)).toMatchObject({ employer_reply: null });
    expect(await row(d)).toMatchObject({ appeal_text: null, stage: "decided" });
    expect((await act(c.owner.cookie, "reply", "999999999")).json).toEqual({ code: "CASE_NOT_FOUND" });
    const hidden = await strike(c.org, { stage: "case_open" });
    expect((await act(c.owner.cookie, "reply", hidden)).json).toEqual({ code: "CASE_NOT_FOUND" });
  });
  it("a login with no company is NOT_A_MEMBER", async () => {
    const l = await login(), c = await company(), id = await waiting(c.org);
    const r = await act(l.cookie, "reply", id);
    expect([r.status, r.json]).toEqual([403, { code: "NOT_A_MEMBER" }]);
  });
  it("a removed member can neither read nor write", async () => {
    const c = await company(), id = await waiting(c.org);
    await su.query("update membership set status='removed', removed_at=now() where id=$1", [c.owner.mem]);
    expect([403, 404]).toContain((await page(c.owner.cookie)).status); // NOT_A_MEMBER or NO_COMPANY, never the page
    const g = await page(c.owner.cookie);
    expect(g.json?.page ?? null).toBeNull();
    const r = await act(c.owner.cookie, "reply", id);
    expect([r.status, r.json]).toEqual([403, { code: "NOT_A_MEMBER" }]);
    expect((await row(id)).employer_reply).toBeNull();
  });
  it("a blocked login is REFUSED", async () => {
    const c = await company(), id = await waiting(c.org);
    await db.query("app_admin", "update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='fake' where id=$1", [c.owner.id]);
    for (const r of [await act(c.owner.cookie, "reply", id), await page(c.owner.cookie)]) expect([r.status, r.json]).toEqual([403, { code: "REFUSED" }]);
    expect((await row(id)).employer_reply).toBeNull();
  });
});

describe("hostile bodies", () => {
  let c: Company, id: string;
  beforeAll(async () => { c = await company(); id = await waiting(c.org); });
  it("refuses a foreign or missing Origin", async () => {
    const good = { action: "reply", caseId: id, text: "x" };
    const f = await post(c.owner.cookie, good, { origin: "https://evil.example" });
    expect([f.status, f.json]).toEqual([403, { code: "BAD_ORIGIN" }]);
    expect((await post(c.owner.cookie, good, { origin: null })).status).toBe(403);
  });
  it("refuses a big body, bad JSON, unknown fields and bad values", async () => {
    expect((await post(c.owner.cookie, { action: "reply", caseId: id, text: "x".repeat(2100) })).status).toBe(413);
    expect((await post(c.owner.cookie, null, { raw: "{nope" })).status).toBe(400);
    expect((await post(c.owner.cookie, { action: "reply", caseId: id, text: "x", extra: 1 })).status).toBe(400);
    for (const caseId of [5, Number(id), -1, 0, 1e30, 1.5, "0", `0${id}`, "-1", "9".repeat(19), `${id};drop`]) expect((await act(c.owner.cookie, "reply", caseId as string)).status, String(caseId)).toBe(400);
    // the text cap (1,800) sits inside MAX_BODY (2,048), so the route itself refuses 1,801 characters
    expect((await post(c.owner.cookie, { action: "reply", caseId: id, text: "x".repeat(1801) })).status).toBe(400);
    for (const text of ["", "   ", "\n\t", "a\u202eb", "a\u0000b", "a\u200bb"]) {
      expect((await post(c.owner.cookie, { action: "reply", caseId: id, text })).status, JSON.stringify(text.slice(0, 5))).toBe(400);
    }
    expect((await act(c.owner.cookie, "decide", id)).status).toBe(400);
    expect((await post(undefined, { action: "reply", caseId: id, text: "x" })).status).toBe(401);
    expect((await row(id)).employer_reply).toBeNull();
  });
  it("limits a login to 10 POSTs in the window", async () => {
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await act(c.viewer.cookie, "reply", id)).status);
    expect(codes.slice(0, 10).every((s) => s === 403)).toBe(true); // NOT_OWNER: counted, then refused
    expect(codes[10]).toBe(429);
  });
});

describe("the replies match docs/openapi/portal.yaml", () => {
  it("the page with cases, a reply and the 404 with no company: ids as text, times with Z", async () => {
    const spec = loadSpec("portal");
    const c = await company(), w = await waiting(c.org);
    await decided(c.org);
    const g = await page(c.owner.cookie);
    expect([g.status, replyProblems(spec, "GET", "/api/portal/status", g.status, g.json)]).toEqual([200, []]);
    expect(found(g, w).replyDueAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const r = await act(c.owner.cookie, "reply", w);
    expect([r.status, r.json, replyProblems(spec, "POST", "/api/portal/status", r.status, r.json)]).toEqual([200, { caseId: w, kind: "reply" }, []]);
    const none = await page((await login()).cookie);
    expect([none.status, replyProblems(spec, "GET", "/api/portal/status", none.status, none.json)]).toEqual([404, []]);
  });
});

describe("budgets: median of 9 calls", () => {
  it("stays inside the statement and time budgets", async () => {
    const c = await company();
    for (let i = 0; i < 5; i++) await decided(c.org);
    const [r, sg] = await counted(() => page(c.owner.cookie));
    expect(r.status).toBe(200);
    expect(sg, `${sg} get statements`).toBeLessThanOrEqual(BUDGET.get);
    const getMs = await median(() => page(c.owner.cookie));
    expect(getMs).toBeLessThan(BUDGET.getMs);
    const ids = await Promise.all(Array.from({ length: 10 }, () => waiting(c.org)));
    let i = 0;
    const [p, sp] = await counted(() => act(c.owner.cookie, "reply", ids[i++]!));
    expect(p.status).toBe(200);
    expect(sp, `${sp} post statements`).toBeLessThanOrEqual(BUDGET.post);
    const postMs = await median(async () => { expect((await act(c.owner.cookie, "reply", ids[i++]!)).status).toBe(200); });
    expect(postMs).toBeLessThan(BUDGET.postMs);
    console.log(`status budgets: get ${sg} statements, median ${getMs.toFixed(1)} ms; reply ${sp} statements, median ${postMs.toFixed(1)} ms`);
  });
});
