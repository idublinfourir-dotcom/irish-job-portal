// N3: the portal notice reader end to end on the test database, through the real /api/portal/notices handlers connected as app_portal, with real
// portal sessions (sign-up, confirm and sign-in through the real auth route). A #93 notice is written by the real writer (rules-admin.ts NOTICES, as
// app_admin). Candidate and staff sessions are real session rows with correctly signed cookies. No test calls the real network. Fake people only.
import { pressed } from "./confirm-link";
import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { NOTICES } from "../src/rules-admin";
import { NOTICE_PAGE, UNREAD_CAP } from "../src/notices";
import { NOTICE_RATE } from "../../../apps/portal/lib/notices";
import { loadSpec, replyProblems } from "./openapi";

// Statements counted on every pg.Client.query call: GET = requirePortal 3 + page 1 + unread count 1; POST = requirePortal 3 + the update 1.
// Times, median of 9 calls, warm, on 1,000 notices for the user, measured on 18 November 2026 (three runs): list 3.0 to 3.4 ms, mark all 1.8 to 1.9 ms. Budgets are about
// 4 times the slowest median, with a floor for a busy laptop. Raise these only on purpose.
// post: 4 statements were measured before the notices POST had a rate limit; the limit adds exactly one (its insert is budgeted in perf/rate-limit.perf.ts).
const BUDGET = { get: 5, post: 5, getMs: 15, postMs: 15 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, authGET: Handler, GET: Handler, POST: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number>; cand(): Promise<string>; staff(): Promise<string> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST, GET: authGET } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET, POST } = await import("../../../apps/portal/app/api/portal/notices/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
  mail = pressed(mail, "portal");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let ipn = 0;
const freshIp = () => `10.9.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
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
  const p = { email: `fake.n${++n}@elsewhere.example.test`, password: `Fake-n${n}-password-1`, name: `Fake N${n}`, ...portalAnswers };
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

const list = async (cookie?: string, after?: string) =>
  reply(await GET(new Request(`${BASE}/api/portal/notices${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`, { headers: cookie ? { cookie } : {} })));
async function post(cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string; length?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(o.length ? { "content-length": o.length } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return reply(await POST(new Request(`${BASE}/api/portal/notices`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers })));
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
// Notices written as the owner, n of them for one user, `ties` sharing one created_at so the id breaks the tie.
const seed = (user: string, count: number, read = false) =>
  su.query(`insert into notification(portal_user_id, category, template_key, params, created_at, read_at)
    select $1, 'rules', 'fake_notice', jsonb_build_object('n', g), now() - interval '1 day' + (g / 3) * interval '1 second', case when $3 then now() end from generate_series(1, $2) g`, [user, count, read]);

let owner: Login, recruiter: Login, other: Login, lone: Login, orgA: number;
beforeAll(async () => {
  [owner, recruiter, other, lone] = [await login(), await login(), await login(), await login()];
  orgA = await F.org();
  const orgB = await F.org();
  await F.member(orgA, owner.id, { role: "account_owner", signer: true });
  await F.member(orgA, recruiter.id, { role: "recruiter" });
  await F.member(orgB, other.id, { role: "account_owner", signer: true });
  const src = (await one("select id from job_source where kind = 'portal' and board = 'employer'")).id;
  for (const o of [orgA, orgB])
    await su.query("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url) values ($1, 'employer', $2, 't', 'e', 'it', 'critical_skills', 'draft', now() + interval '5 days', 'https://x.example.ie/1')", [o, src]);
});

describe("the reader", () => {
  it("a #93 notice from the real writer shows to its company's owner only, with the unread count; mark one read", async () => {
    expect((await db.pool("app_admin").query(NOTICES, [1, "2026-12-01"])).rows[0].emails).toBe(2);
    const a = await list(owner.cookie);
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ unread: 1, next: null, items: [{ category: "rules", templateKey: "rules_minimums_changed", readAt: null, params: { organisationId: String(orgA), versionId: "1", effectiveFrom: "2026-12-01" } }] });
    expect(a.json!.items[0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); // ISO 8601 in UTC with Z, ids inside params as text
    const id = a.json!.items[0].id as string;
    expect((await list(recruiter.cookie)).json).toEqual({ items: [], next: null, unread: 0 }); // the writer notifies the owner only
    expect((await list(lone.cookie)).json).toEqual({ items: [], next: null, unread: 0 });
    const b = (await list(other.cookie)).json!;
    expect(b.items).toHaveLength(1);
    expect(b.items[0].params.organisationId).not.toBe(String(orgA));

    // another user's id changes nothing, from every other portal login
    for (const who of [recruiter, other, lone]) expect(await post(who.cookie, { action: "read", id })).toEqual({ status: 200, json: { marked: 0 } });
    expect((await list(owner.cookie)).json!.unread).toBe(1);
    expect(await post(owner.cookie, { action: "read", id })).toEqual({ status: 200, json: { marked: 1 } });
    expect(await post(owner.cookie, { action: "read", id })).toEqual({ status: 200, json: { marked: 0 } }); // already read
    expect(await post(owner.cookie, { action: "read", id: "9223372036854775807" })).toEqual({ status: 200, json: { marked: 0 } });
    const after = (await list(owner.cookie)).json!;
    expect(after.unread).toBe(0);
    expect(after.items[0].readAt).not.toBeNull();
    expect((await list(other.cookie)).json!.unread).toBe(1); // untouched
  });

  it("pages 50 at a time newest first, ties broken by id, with no gap or repeat; the count stops at the cap", async () => {
    const u = await login();
    await seed(u.id, 2 * NOTICE_PAGE + 21);
    await seed(u.id, 300, true); // read ones are listed too, at the same times (more ties)
    const ids: string[] = [];
    const keys: [string, bigint][] = [];
    let after: string | undefined, pages = 0;
    for (;;) {
      const r = await list(u.cookie, after);
      expect(r.status).toBe(200);
      expect(r.json!.items.length).toBeLessThanOrEqual(NOTICE_PAGE);
      expect(r.json!.unread).toBe(2 * NOTICE_PAGE + 21);
      for (const it of r.json!.items) { ids.push(it.id); keys.push([it.createdAt, BigInt(it.id)]); }
      pages++;
      if (r.json!.next === null) break;
      after = r.json!.next;
    }
    expect(pages).toBe(Math.ceil((2 * NOTICE_PAGE + 21 + 300) / NOTICE_PAGE));
    expect(new Set(ids).size).toBe(2 * NOTICE_PAGE + 21 + 300);
    // one zone (UTC) and fractions without trailing zeros, so text order is time order here; ids of two and three digits both appear
    expect(keys.some(([, i]) => i >= 100n) && keys.some(([, i]) => i < 100n)).toBe(true);
    for (let k = 1; k < keys.length; k++) {
      const [t0, i0] = keys[k - 1]!, [t1, i1] = keys[k]!;
      expect(t0 > t1 || (t0 === t1 && i0 > i1), `${t0} ${i0} then ${t1} ${i1}`).toBe(true);
    }
  });

  it("mark all read marks only this user's; the count is exact under the cap and stops at it", async () => {
    const u = await login();
    await seed(u.id, 7);
    expect((await list(u.cookie)).json!.unread).toBe(7);
    await seed(u.id, UNREAD_CAP + 50);
    expect((await list(u.cookie)).json!.unread).toBe(UNREAD_CAP);
    const othersBefore = (await list(other.cookie)).json!.unread;
    expect(await post(u.cookie, { action: "read_all" })).toEqual({ status: 200, json: { marked: UNREAD_CAP + 57 } });
    expect((await list(u.cookie)).json!.unread).toBe(0);
    expect(await post(u.cookie, { action: "read_all" })).toEqual({ status: 200, json: { marked: 0 } });
    expect((await list(other.cookie)).json!.unread).toBe(othersBefore);
  });
});

describe("security", () => {
  it("no login, a candidate session and a staff session get no notices and mark nothing, even with their token under the portal cookie name", async () => {
    const cand = await otherSession("candidate"), staff = await otherSession("staff");
    const before = await one("select count(*)::int n from notification where read_at is null");
    for (const cookie of [undefined, cand.own, cand.asPortal, staff.own, staff.asPortal, "portal.session_token=forged.c2lnbmF0dXJl"]) {
      expect(await list(cookie), String(cookie)).toEqual({ status: 401, json: { code: "NO_SESSION" } });
      expect(await post(cookie, { action: "read_all" }), String(cookie)).toEqual({ status: 401, json: { code: "NO_SESSION" } });
    }
    expect(await one("select count(*)::int n from notification where read_at is null")).toEqual(before);
  });

  it("hostile input: bad and huge page tokens, bad ids, extra fields, wrong or missing Origin, oversized bodies", async () => {
    const tok = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const after of ["", "x".repeat(100_000), "%%%", tok({ t: "2026-11-18 10:00:00+00", i: "1; delete from notification" }), tok({ t: "now()", i: "1" }), tok({ t: "2026-11-18 10:00:00+00" })])
      expect(await list(owner.cookie, after), after.slice(0, 20)).toEqual({ status: 400, json: { code: "BAD_CURSOR" } });
    const before = await one("select count(*)::int n from notification where read_at is null");
    for (const body of [{ action: "read", id: "0" }, { action: "read", id: 5 }, { action: "read", id: "1 or 1=1" }, { action: "read", id: "99999999999999999999" },
      { action: "read_all", portalUserId: other.id }, { action: "read", id: "1", portalUserId: other.id }, { action: "unread", id: "1" }, [], null])
      expect(await post(owner.cookie, body), JSON.stringify(body)).toEqual({ status: 400, json: { code: "BAD_REQUEST" } });
    expect(await post(owner.cookie, null, { raw: "{not json" })).toEqual({ status: 400, json: { code: "BAD_REQUEST" } });
    expect(await post(owner.cookie, { action: "read_all" }, { origin: "https://evil.example.test" })).toEqual({ status: 403, json: { code: "BAD_ORIGIN" } });
    expect(await post(owner.cookie, { action: "read_all" }, { origin: null })).toEqual({ status: 403, json: { code: "BAD_ORIGIN" } });
    expect(await post(owner.cookie, null, { raw: JSON.stringify({ action: "read_all", pad: "x".repeat(5000) }) })).toEqual({ status: 413, json: { code: "BODY_TOO_LARGE" } });
    expect(await post(owner.cookie, { action: "read_all" }, { length: "999999" })).toEqual({ status: 413, json: { code: "BODY_TOO_LARGE" } });
    expect(await one("select count(*)::int n from notification where read_at is null")).toEqual(before);
  });

  it("app_portal can set read_at through its view and nothing else: no notice text edit, no delete, no direct table access", async () => {
    const p = db.pool("app_portal");
    const id = (await one("select id from notification where portal_user_id = $1 limit 1", [other.id])).id;
    const denied = /permission denied/;
    for (const sql of [
      "update portal_notification set template_key = 'x' where id = $1", "update portal_notification set params = '{}' where id = $1",
      "update portal_notification set category = 'x' where id = $1", "update portal_notification set portal_user_id = 'x' where id = $1",
      "update portal_notification set created_at = now() where id = $1", "delete from portal_notification where id = $1",
      "update notification set read_at = now() where id = $1", "delete from notification where id = $1", "select id from notification where id = $1",
    ]) await expect(p.query(sql, [id]), sql).rejects.toThrow(denied);
    await expect(p.query("insert into notification(portal_user_id, category, template_key) values ($1, 'x', 'y')", [other.id])).rejects.toThrow(denied);
    await expect(p.query("select id from candidate_notification limit 1")).rejects.toThrow(denied);
    expect((await p.query("update portal_notification set read_at = read_at where id = $1", [id])).rowCount).toBe(1);
  });
});

describe("rate limit and the documented shape", () => {
  it("marks are limited per login (NOTICE_RATE), then 429; another login is not held back; an address header does not reset it", async () => {
    const u = await login(), seq: number[] = [];
    for (let i = 0; i < NOTICE_RATE.max; i++) seq.push((await post(u.cookie, { action: "read_all" })).status);
    expect(seq.every((x) => x === 200)).toBe(true);
    expect(await post(u.cookie, { action: "read_all" })).toEqual({ status: 429, json: { code: "TOO_MANY_REQUESTS" } });
    // the limit is per login: new address headers change nothing
    const spoofed = await POST(new Request(`${BASE}/api/portal/notices`, { method: "POST", body: JSON.stringify({ action: "read_all" }),
      headers: { "content-type": "application/json", origin: BASE, cookie: u.cookie, "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9", "x-vercel-forwarded-for": "203.0.113.9" } }));
    expect(spoofed.status).toBe(429);
    expect((await post((await login()).cookie, { action: "read_all" })).status).toBe(200);
    // a refusal before the session (bad Origin, bad body) does not count
    const v = await login();
    for (let i = 0; i < 5; i++) await post(v.cookie, { action: "read_all" }, { origin: "https://evil.example" });
    expect((await post(v.cookie, { action: "read_all" })).status).toBe(200);
  });
  it("the list, a mark and the 429 match docs/openapi/portal.yaml: ids as text, times with Z", async () => {
    const spec = loadSpec("portal");
    const u = await login();
    await seed(u.id, 3);
    const l = await list(u.cookie);
    expect([l.status, replyProblems(spec, "GET", "/api/portal/notices", l.status, l.json)]).toEqual([200, []]);
    expect(l.json!.items[0].createdAt).toMatch(/Z$/);
    const m = await post(u.cookie, { action: "read", id: l.json!.items[0].id });
    expect([m.status, replyProblems(spec, "POST", "/api/portal/notices", m.status, m.json)]).toEqual([200, []]);
    const bad = await post(u.cookie, { action: "read", id: 5 });
    expect([bad.status, replyProblems(spec, "POST", "/api/portal/notices", bad.status, bad.json)]).toEqual([400, []]);
  });
});

describe("budget", () => {
  it("list and mark stay inside their statement and time budgets on a user with over 1,000 notices", async () => {
    const u = await login();
    await seed(u.id, 1000);
    const [, get] = await counted(() => list(u.cookie));
    const [, mark] = await counted(() => post(u.cookie, { action: "read", id: "1" }));
    const [, all] = await counted(() => post(u.cookie, { action: "read_all" }));
    const getMs = await median(() => list(u.cookie));
    const postMs = await median(() => post(u.cookie, { action: "read_all" }));
    console.log("notices: statements get", get, "mark", mark, "mark all", all, "median ms get", getMs.toFixed(1), "mark all", postMs.toFixed(1));
    expect(get).toBeLessThanOrEqual(BUDGET.get);
    expect(mark).toBeLessThanOrEqual(BUDGET.post);
    expect(all).toBeLessThanOrEqual(BUDGET.post);
    expect(getMs).toBeLessThanOrEqual(BUDGET.getMs);
    expect(postMs).toBeLessThanOrEqual(BUDGET.postMs);
  });
});
