// N7: the portal notice settings end to end on the test database, through the real /api/portal/notices/settings handlers connected as app_portal, with real
// portal sessions (sign-up, confirm and sign-in through the real auth route), and the real expiry sender (private.expire_employer_jobs, as app_admin)
// honouring the switch. Candidate and staff sessions are real session rows with correctly signed cookies. No test calls the real network. Fake people only.
import { pressed } from "./confirm-link";
import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { SETTINGS_RATE } from "../../../apps/portal/lib/notices";
import { loadSpec, replyProblems } from "./openapi";

// Statements counted on every pg.Client.query call: GET = requirePortal 3 + the read 1; PUT = requirePortal 3 + rate limit 1 + upsert 1 + the read 1.
// Times: median of 9 warm calls, measured on 18 November 2026 (three runs): get 1.4 to 2.5 ms, put 2.3 to 3.3 ms. Budgets are about 4 times the slowest median, with a floor for a busy laptop. Raise these only on purpose.
const BUDGET = { get: 4, put: 6, getMs: 15, putMs: 15 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, authGET: Handler, GET: Handler, PUT: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number>; cand(): Promise<string>; staff(): Promise<string> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST, GET: authGET } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET, PUT } = await import("../../../apps/portal/app/api/portal/notices/settings/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
  mail = pressed(mail, "portal");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let ipn = 0;
const freshIp = () => `10.19.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
type Reply = { status: number; json: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
const reply = async (res: Response): Promise<Reply> => {
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
};
const authCall = async (path: string, body: unknown) => authPOST(new Request(`${BASE}/api/auth/portal/${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } }));
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

let n = 0;
type Login = { cookie: string; id: string };
async function login(): Promise<Login> {
  const p = { email: `fake.ns${++n}@elsewhere.example.test`, password: `Fake-ns${n}-password-1`, name: `Fake NS${n}`, ...portalAnswers };
  expect((await authCall("sign-up/email", p)).status).toBe(200);
  await authGET(new Request(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link, { headers: { "x-vercel-forwarded-for": freshIp() }, redirect: "manual" }));
  const r = await authCall("sign-in/email", { email: p.email, password: p.password });
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await one("select id from portal_user where email=$1", [p.email])).id };
}
// A real session row in another login pool, with its cookie signed the way Better Auth signs it (token.HMAC-SHA256, URI-encoded).
async function otherSession(pool: "candidate" | "staff"): Promise<{ own: string; asPortal: string }> {
  const user = pool === "candidate" ? await F.cand() : await F.staff();
  const token = `fake${pool}token${++n}xxxxxxxxxxxxxxxx`;
  await su.query(`insert into ${pool}_session(id, expires_at, token, updated_at, user_id) values ($1, now() + interval '1 day', $2, now(), $3)`, [`s-${pool}-${n}`, token, user]);
  const signed = encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
  return { own: `${pool}.session_token=${signed}`, asPortal: `portal.session_token=${signed}` };
}

const URL_ = `${BASE}/api/portal/notices/settings`;
const get = async (cookie?: string) => reply(await GET(new Request(URL_, { headers: cookie ? { cookie } : {} })));
async function put(cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string; length?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(o.length ? { "content-length": o.length } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return reply(await PUT(new Request(URL_, { method: "PUT", body: o.raw ?? JSON.stringify(body), headers })));
}
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
const prefs = async (user: string) => (await su.query("select category, channel, enabled from notification_preference where portal_user_id = $1 order by category", [user])).rows;
const ON = { settings: { job_expiry_reminder: true, account: true } }, OFF = { settings: { job_expiry_reminder: false, account: true } };

let owner: Login, recruiter: Login, viewer: Login, other: Login, orgA: number, ownerM: number, recruiterM: number, src: number;
beforeAll(async () => {
  [owner, recruiter, viewer, other] = [await login(), await login(), await login(), await login()];
  orgA = Number(await F.org());
  const orgB = Number(await F.org());
  ownerM = Number(await F.member(orgA, owner.id, { role: "account_owner", signer: true }));
  recruiterM = Number(await F.member(orgA, recruiter.id, { role: "recruiter" }));
  await F.member(orgA, viewer.id, { role: "viewer" });
  await F.member(orgB, other.id, { role: "account_owner", signer: true });
  src = (await one("select id from job_source where kind = 'portal' and board = 'employer'")).id;
});
// A live employer job of company A ending in 2 days, posted by the given membership (null: the poster has gone).
const dueJob = async (by: number | null) => (await one(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at,
    own_page_url, salary_low, search_vector, posted_by_membership_id) values ($1, 'employer', $2, 'Fake', 'Fake', 'it', 'critical_skills', 'live', now() + interval '2 days',
    'https://x.example.ie/1', 50000, 'x', $3) returning id::text`, [orgA, src, by])).id as string;
const reminded = async (job: string) => (await su.query("select portal_user_id from email_outbox where template = 'job_expiry_reminder' and params->>'jobId' = $1", [job])).rows.map((r) => r.portal_user_id);

describe("the settings", () => {
  it("default on; a member switches the expiry reminder off and on, and only their own row changes", async () => {
    expect(await get(recruiter.cookie)).toEqual({ status: 200, json: ON });
    expect(await put(recruiter.cookie, { job_expiry_reminder: false })).toEqual({ status: 200, json: OFF });
    expect(await get(recruiter.cookie)).toEqual({ status: 200, json: OFF });
    expect(await prefs(recruiter.id)).toEqual([{ category: "job_expiry_reminder", channel: "email", enabled: false }]);
    for (const who of [owner, viewer, other]) expect(await get(who.cookie)).toEqual({ status: 200, json: ON });
    expect(await put(recruiter.cookie, { job_expiry_reminder: true, account: true })).toEqual({ status: 200, json: ON });
    expect(await put(recruiter.cookie, { job_expiry_reminder: false })).toEqual({ status: 200, json: OFF });
    expect(await put(viewer.cookie, { account: true })).toEqual({ status: 200, json: ON }); // every role, viewers too
    const lone = await login(); // no company at all: still their own settings
    expect(await put(lone.cookie, { job_expiry_reminder: false })).toEqual({ status: 200, json: OFF });
  });

  it("the expiry sender honours the switch: the recruiter who switched off gets nothing, the owner still gets theirs and an orphaned job's", async () => {
    await put(recruiter.cookie, { job_expiry_reminder: false });
    const byRecruiter = await dueJob(recruiterM), byOwner = await dueJob(ownerM), orphan = await dueJob(null);
    await db.pool("app_admin").query("select private.expire_employer_jobs()");
    expect(await reminded(byRecruiter)).toEqual([]);
    expect(await reminded(byOwner)).toEqual([owner.id]);
    expect(await reminded(orphan)).toEqual([owner.id]);
    // the owner switches off too: the next due job, theirs or orphaned, is not reminded
    await put(owner.cookie, { job_expiry_reminder: false });
    const byOwner2 = await dueJob(ownerM), orphan2 = await dueJob(null);
    await db.pool("app_admin").query("select private.expire_employer_jobs()");
    expect(await reminded(byOwner2)).toEqual([]);
    expect(await reminded(orphan2)).toEqual([]);
    // back on: the recruiter's job is reminded on the next run (the dedupe key held nothing back)
    await put(recruiter.cookie, { job_expiry_reminder: true });
    await db.pool("app_admin").query("select private.expire_employer_jobs()");
    expect(await reminded(byRecruiter)).toEqual([recruiter.id]);
    await put(owner.cookie, { job_expiry_reminder: true });
  });
});

describe("security", () => {
  it("no login, a candidate session and a staff session read and change nothing, even with their token under the portal cookie name", async () => {
    const cand = await otherSession("candidate"), staff = await otherSession("staff");
    const before = await one("select count(*)::int n from notification_preference");
    for (const cookie of [undefined, cand.own, cand.asPortal, staff.own, staff.asPortal, "portal.session_token=forged.c2lnbmF0dXJl"]) {
      expect(await get(cookie), String(cookie)).toEqual({ status: 401, json: { code: "NO_SESSION" } });
      expect(await put(cookie, { job_expiry_reminder: false }), String(cookie)).toEqual({ status: 401, json: { code: "NO_SESSION" } });
    }
    expect(await one("select count(*)::int n from notification_preference")).toEqual(before);
  });

  it("a blocked login is refused", async () => {
    const b = await login();
    await su.query("update portal_user set status = 'blocked' where id = $1", [b.id]);
    expect(await get(b.cookie)).toEqual({ status: 403, json: { code: "REFUSED" } });
    expect(await put(b.cookie, { job_expiry_reminder: false })).toEqual({ status: 403, json: { code: "REFUSED" } });
  });

  it("hostile input: account off, unknown keys, another user's id, wrong types, empty, wrong or missing Origin, oversized bodies", async () => {
    const before = await prefs(other.id);
    for (const body of [{ account: false }, { job_expiry_reminder: false, account: false }, {}, { job_alerts: false }, { job_expiry_reminder: "false" }, { job_expiry_reminder: 0 },
      { job_expiry_reminder: null }, { job_expiry_reminder: false, portalUserId: owner.id }, { __proto__: false }, { ["x".repeat(1000)]: false }, [], null, "x", 1])
      expect(await put(other.cookie, body), JSON.stringify(body)).toEqual({ status: 400, json: { code: "BAD_REQUEST" } });
    expect(await put(other.cookie, null, { raw: "{not json" })).toEqual({ status: 400, json: { code: "BAD_REQUEST" } });
    expect(await put(other.cookie, null, { raw: '{"__proto__": false}' })).toEqual({ status: 400, json: { code: "BAD_REQUEST" } });
    expect(await put(other.cookie, { job_expiry_reminder: false }, { origin: "https://evil.example.test" })).toEqual({ status: 403, json: { code: "BAD_ORIGIN" } });
    expect(await put(other.cookie, { job_expiry_reminder: false }, { origin: null })).toEqual({ status: 403, json: { code: "BAD_ORIGIN" } });
    expect(await put(other.cookie, null, { raw: JSON.stringify({ job_expiry_reminder: false, pad: "x".repeat(5000) }) })).toEqual({ status: 413, json: { code: "BODY_TOO_LARGE" } });
    expect(await put(other.cookie, { job_expiry_reminder: false }, { length: "999999" })).toEqual({ status: 413, json: { code: "BODY_TOO_LARGE" } });
    expect(await prefs(other.id)).toEqual(before);
  });

  it("security notices cannot be switched off: an account row set off through the view is ignored, the removal and owner transfer notices still go", async () => {
    const p = db.pool("app_portal");
    const a = await login(), b = await login(), org = Number(await F.org());
    await F.member(org, a.id, { role: "account_owner", signer: true });
    const mb = Number(await F.member(org, b.id, { role: "recruiter" }));
    // the routes refuse account: false; a hostile app_portal session writes it through the view anyway
    await p.query("insert into portal_notification_preference(portal_user_id, category, channel, enabled) values ($1, 'account', 'email', false), ($1, 'account', 'in_app', false)", [b.id]);
    expect((await get(b.cookie)).json).toEqual(ON); // reads as on: the read never takes account from the table
    await p.query("select private.team_transfer($1, $2)", [a.id, mb]);
    expect((await su.query("select template_key from notification where portal_user_id = $1 and category = 'account'", [b.id])).rows).toEqual([{ template_key: "owner_transferred" }]);
    expect((await su.query("select template from email_outbox where portal_user_id = $1", [b.id])).rows).toEqual([{ template: "owner_transferred" }]);
    // app_portal still cannot touch another side or the table itself
    const denied = /permission denied/;
    await expect(p.query("update notification_preference set enabled = true where portal_user_id = $1", [b.id])).rejects.toThrow(denied);
    await expect(p.query("select 1 from candidate_notification_preference limit 1")).rejects.toThrow(denied);
    await expect(p.query("insert into portal_notification_preference(candidate_user_id, category, channel, enabled) values ($1, 'job_alerts', 'email', false)", [await F.cand()])).rejects.toThrow();
  });
});

describe("rate limit and the documented shape", () => {
  it("changes are limited per login (SETTINGS_RATE), then 429; another login is not held back", async () => {
    const u = await login(), seq: number[] = [];
    for (let i = 0; i < SETTINGS_RATE.max; i++) seq.push((await put(u.cookie, { job_expiry_reminder: i % 2 === 0 })).status);
    expect(seq.every((x) => x === 200)).toBe(true);
    expect(await put(u.cookie, { job_expiry_reminder: false })).toEqual({ status: 429, json: { code: "TOO_MANY_REQUESTS" } });
    expect((await put((await login()).cookie, { job_expiry_reminder: false })).status).toBe(200);
  });
  it("the read, a change and a refusal match docs/openapi/portal.yaml", async () => {
    const spec = loadSpec("portal");
    const u = await login();
    const g = await get(u.cookie);
    expect([g.status, replyProblems(spec, "GET", "/api/portal/notices/settings", g.status, g.json)]).toEqual([200, []]);
    const w = await put(u.cookie, { job_expiry_reminder: false });
    expect([w.status, replyProblems(spec, "PUT", "/api/portal/notices/settings", w.status, w.json)]).toEqual([200, []]);
    const bad = await put(u.cookie, { account: false });
    expect([bad.status, replyProblems(spec, "PUT", "/api/portal/notices/settings", bad.status, bad.json)]).toEqual([400, []]);
  });
});

describe("budget", () => {
  it("read and change stay inside their statement and time budgets", async () => {
    const u = await login();
    const [, g] = await counted(() => get(u.cookie));
    const [, w] = await counted(() => put(u.cookie, { job_expiry_reminder: false }));
    const getMs = await median(() => get(u.cookie));
    const putMs = await median(() => put(u.cookie, { job_expiry_reminder: true }));
    console.log("notice settings: statements get", g, "put", w, "median ms get", getMs.toFixed(1), "put", putMs.toFixed(1));
    expect(g).toBeLessThanOrEqual(BUDGET.get);
    expect(w).toBeLessThanOrEqual(BUDGET.put);
    expect(getMs).toBeLessThanOrEqual(BUDGET.getMs);
    expect(putMs).toBeLessThanOrEqual(BUDGET.putMs);
  });
});
