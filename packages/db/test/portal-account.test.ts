// Audit row R1: a portal login downloads its own data and deletes itself, end to end on the test database through the real auth route and the real route
// handlers of apps/portal (connected as app_portal), with memoryStore() as the file store. Every pool and role is tried, then hostile input. Companies,
// members and cases are written as postgres. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, makeAuth, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { exportFilename } from "../src/candidate";

// Statements counted on every pg.Client.query call, measured on 18 November 2026: export 3 (the session read 2, the function), delete 4 (the session read 2,
// the rate count, the function). Medians of 9 warm calls on a member with 500 notices and 200 audit rows: export 11.1 ms, delete 7.3 ms (each delete
// erases a fresh member). Time budgets are about 3 and 5 times the measure; the page budgets are in perf/self-service.perf.ts. Raise these only on purpose.
const BUDGET = { export: { statements: 3, medianMs: 35 }, delete: { statements: 4, medianMs: 40 } };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler;
const R = {} as { account: { DELETE: Handler }; export: { GET: Handler }; close: { POST: Handler } };
let F: { org(o?: object): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number>; text(p?: string): Promise<number> };
let store: MemoryStore;
let candidateCookie: string, staffCookie: string;

async function signIn(auth: { handler: Handler }, base: string, path: string, body: object, ip: string) {
  const h = { "content-type": "application/json", origin: base, "x-vercel-forwarded-for": ip };
  const r = await auth.handler(new Request(`${base}${path}/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify(body) }));
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  R.account = await import("../../../apps/portal/app/api/portal/account/route");
  R.export = await import("../../../apps/portal/app/api/portal/account/export/route");
  R.close = await import("../../../apps/portal/app/api/portal/company/close/route");
  store = memoryStore();
  setFileStore(store);
  // a real candidate session and a real staff session (their own pools and cookies), to show the portal routes take neither
  const cand = makeAuth("candidate", db.pool("app_candidate"));
  const c = { email: "fake.candidate.r1@example.test", password: "Fake-password-12345", name: "Fake" };
  const h = { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": "198.51.100.250" };
  expect((await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-up/email", { method: "POST", headers: h, body: JSON.stringify({ ...c, ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [c.email]);
  candidateCookie = await signIn(cand, "http://localhost:3000", "/api/auth/candidate", { email: c.email, password: c.password }, "198.51.100.250");
  const { seedStaff } = await import("../src/staff-seed-cli");
  const sc = await su.connect();
  try { await seedStaff(sc, { email: "fake.staff.r1@example.test", name: "Fake Staff", roles: ["administrator"] }, "Fake-staff-password-1"); } finally { sc.release(); }
  staffCookie = await signIn(makeAuth("staff", db.pool("app_admin")), "http://localhost:3000", "/api/auth/staff", { email: "fake.staff.r1@example.test", password: "Fake-staff-password-1" }, "198.51.100.251");
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit"); });

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
async function login() {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from portal_user where email = $1", [email])).rows[0].id as string;
  return { cookie, id, email };
}
type Who = { cookie?: string };
async function company(status = "verified") {
  const name = `Fake Widgets ${uid("")} Limited`;
  const org = Number(await F.org({ name, status }));
  const owner = await login(), recruiter = await login();
  await F.member(org, owner.id, { role: "account_owner", signer: true });
  await F.member(org, recruiter.id, { role: "recruiter" });
  return { org, name, owner, recruiter };
}
type Opts = { origin?: string | null; raw?: string; length?: string; query?: string };
async function call(method: "GET" | "DELETE", who: Who, json?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = who.cookie ? { cookie: who.cookie } : {};
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  if (json !== undefined || o.raw !== undefined) headers["content-type"] = "application/json";
  if (o.length) headers["content-length"] = o.length;
  const body = o.raw ?? (json === undefined ? undefined : JSON.stringify(json));
  const req = new Request(`${BASE}/api/portal/account${method === "GET" ? "/export" : ""}${o.query ?? ""}`, { method, headers, body });
  const res = await (method === "GET" ? R.export.GET(req) : R.account.DELETE(req));
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, json: parsed, code: parsed?.code as string | undefined, headers: res.headers, text };
}
const del = (who: Who) => call("DELETE", who, { confirm: true });
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
async function caseFor(user: string, status = "received") {
  const k = (await one("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [user, await F.text("services_request")])).id;
  const closed = status === "closed" ? ["closed_at, close_reason, ", "now(), 'withdrawn', "] : ["", ""];
  return String((await one(`insert into services_case(portal_user_id, consent_record_id, ${closed[0]}status, dedupe_key) values ($1, $2, ${closed[1]}$3, $4) returning id`, [user, k, status, uid("dk")])).id);
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: (i: number) => Promise<unknown>) => {
  const ms: number[] = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(i); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};

describe("download my data", () => {
  it("holds the login's own account, memberships, notices, consents, actions, reports and requests; never a teammate's data; one audit row", async () => {
    const c = await company();
    await su.query("insert into notification(portal_user_id, organisation_id, category, template_key, params) values ($1, $2, 'account', 'fake_notice', '{\"n\":1}'), ($3, $2, 'account', 'other_notice', '{}')",
      [c.recruiter.id, c.org, c.owner.id]);
    await su.query("insert into contact_message(surface, portal_user_id, from_name, from_email, topic, body) values ('portal', $1, 'Fake', $2, 'general', 'My own question')", [c.recruiter.id, c.recruiter.email]);
    await su.query("insert into contact_message(surface, portal_user_id, from_name, from_email, topic, body) values ('portal', $1, 'Fake', $2, 'general', 'The owner''s question')", [c.owner.id, c.owner.email]);
    await su.query("insert into report(target_kind, target_organisation_id, reporter_portal_user_id, reason, evidence_text) values ('organisation', $1, $2, 'other', 'My own report')", [c.org, c.recruiter.id]);
    await caseFor(c.recruiter.id, "closed");
    const r = await call("GET", c.recruiter, undefined, { query: `?id=${c.owner.id}` }); // the query string is ignored
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${exportFilename(new Date())}"`);
    const d = r.json;
    expect(d.account).toMatchObject({ email: c.recruiter.email, emailConfirmed: true, signInMethods: ["credential"] });
    expect(d.memberships).toEqual([expect.objectContaining({ organisationId: c.org, organisation: c.name, role: "recruiter", status: "active" })]);
    expect(d.notices.map((x: { templateKey: string }) => x.templateKey)).toEqual(["fake_notice"]);
    expect(d.consents.length).toBeGreaterThanOrEqual(2); // the sign-up terms and the case's consent
    expect(d.messagesYouSent).toEqual([expect.objectContaining({ body: "My own question" })]);
    expect(d.reportsYouMade).toEqual([expect.objectContaining({ evidenceText: "My own report", reason: "other" })]);
    expect(d.servicesRequests).toHaveLength(1);
    expect(d.yourActions[0]).toMatchObject({ kind: "data_access", action: "portal_user.export" });
    for (const k of ["notificationSettings", "emailsWeSent", "documentsYouUploaded"]) expect(Array.isArray(d[k])).toBe(true);
    // nothing of the owner's: email, id, notice or message
    for (const x of [c.owner.email, c.owner.id, "other_notice", "The owner's question"]) expect(r.text).not.toContain(x);
    expect(r.text).not.toMatch(/token|password|storage_key|storageKey|dedupe/i);
    expect((await one("select count(*)::int n from audit_event where actor_portal_user_id = $1 and action = 'portal_user.export'", [c.recruiter.id])).n).toBe(1);
  });

  it("a login with no company exports too", async () => {
    const p = await login();
    const r = await call("GET", p);
    expect([r.status, r.json.memberships]).toEqual([200, []]);
  });

  it(`within ${BUDGET.export.statements} statements and ${BUDGET.export.medianMs} ms median, for a member with 500 notices and 200 audit rows`, async () => {
    const p = await login();
    await su.query("insert into notification(portal_user_id, category, template_key, params) select $1, 'account', 'fake', jsonb_build_object('n', g) from generate_series(1, 500) g", [p.id]);
    await su.query("insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, source) select 'security', $1, 'fake.action', 'job', g::text, 'site' from generate_series(1, 200) g", [p.id]);
    const [r, statements] = await counted(() => call("GET", p));
    expect(r.json.notices).toHaveLength(500);
    expect(r.json.yourActions).toHaveLength(201);
    const ms = await median(() => call("GET", p));
    console.log(`portal export: ${statements} statements, median ${ms.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.export.statements);
    expect(ms).toBeLessThan(BUDGET.export.medianMs);
  });
});

describe("delete my login", () => {
  it("a recruiter deletes: erased as erase_portal_user decides, its stored files removed from the store, every session ended, the company's records kept", async () => {
    const c = await company();
    const kase = await caseFor(c.recruiter.id, "closed");
    const key = `case/${uid("fake")}`;
    await store.put(key, new Uint8Array([1, 2, 3]), "application/pdf");
    await su.query("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, portal_user_id) values ($1, $2, 'offer.pdf', 'pdf', 3, $3)", [kase, key, c.recruiter.id]);
    const job = (await one("select id from job_source where kind = 'portal' and board = 'employer'")).id;
    await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector, application_route)
      values ($1, 'employer', $2, 'Fake role', 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 40000, 'x', 'own_page')`, [c.org, job]);
    const r = await del(c.recruiter);
    expect([r.status, r.json]).toEqual([200, { ok: true, filesRemoved: 1 }]);
    expect(store.objects.has(key)).toBe(false);
    expect(await one("select count(*)::int n from portal_user where id = $1", [c.recruiter.id])).toEqual({ n: 0 });
    expect(await one("select count(*)::int n from portal_session where user_id = $1", [c.recruiter.id])).toEqual({ n: 0 });
    expect(await one("select count(*)::int n from portal_account where user_id = $1", [c.recruiter.id])).toEqual({ n: 0 });
    expect(await one("select storage_key, file_name, copy_deleted_at is not null as gone from case_document where services_case_id = $1", [kase])).toEqual({ storage_key: null, file_name: null, gone: true });
    expect(await one("select requester_erased_at is not null as erased from services_case where id = $1", [kase])).toEqual({ erased: true });
    expect(await one("select count(*)::int n from audit_event where actor_portal_user_id = $1 or object_id = $1", [c.recruiter.id])).toEqual({ n: 0 }); // pseudonymised
    expect((await one("select count(*)::int n from audit_event where action = 'portal_user.erase' and actor_system = 'erase_portal_user by app_portal'")).n).toBeGreaterThan(0);
    // the company, its owner and its job stay
    expect(await one("select status from organisation where id = $1", [c.org])).toEqual({ status: "verified" });
    expect(await one("select count(*)::int n from membership where organisation_id = $1 and status = 'active'", [c.org])).toEqual({ n: 1 });
    expect(await one("select count(*)::int n from job where organisation_id = $1 and status = 'live'", [c.org])).toEqual({ n: 1 });
    // the old cookie no longer works
    expect((await call("GET", c.recruiter)).status).toBe(401);
    expect((await del(c.recruiter)).status).toBe(401);
  });

  it("the account owner of a company with other active members is refused (transfer first); nothing changes", async () => {
    const c = await company();
    expect((await del(c.owner)).code).toBe("OWNER_MUST_TRANSFER");
    expect((await del(c.owner)).status).toBe(409);
    expect(await one("select count(*)::int n from portal_user where id = $1", [c.owner.id])).toEqual({ n: 1 });
  });

  it("the sole member and owner of an open company is refused (close it first), and allowed once the company is closed", async () => {
    const name = `Fake Solo ${uid("")} Limited`;
    const org = await F.org({ name });
    const owner = await login();
    await F.member(org, owner.id, { role: "account_owner", signer: true });
    expect([(await del(owner)).status, (await del(owner)).code]).toEqual([409, "CLOSE_COMPANY_FIRST"]);
    const close = await R.close.POST(new Request(`${BASE}/api/portal/company/close`, { method: "POST", headers: { cookie: owner.cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ confirmName: name }) }));
    expect(close.status).toBe(200);
    expect((await del(owner)).status).toBe(200);
    expect(await one("select status from organisation where id = $1", [org])).toEqual({ status: "closed" });
  });

  it("the sole owner of a company that is no longer open (suspended) may delete", async () => {
    const org = await F.org({ status: "suspended" });
    const owner = await login();
    await F.member(org, owner.id, { role: "account_owner" });
    expect((await del(owner)).status).toBe(200);
  });

  it("an open services case refuses (the erase function's own refusal); nothing changes", async () => {
    const p = await login();
    await caseFor(p.id);
    expect([(await del(p)).status, (await del(p)).code]).toEqual([409, "OPEN_SERVICES_CASE"]);
    expect(await one("select count(*)::int n from portal_session where user_id = $1", [p.id])).toEqual({ n: 1 });
  });

  it(`within ${BUDGET.delete.statements} statements and ${BUDGET.delete.medianMs} ms median, for a member with 500 notices and 200 audit rows`, async () => {
    const people: Awaited<ReturnType<typeof login>>[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await login();
      await su.query("insert into notification(portal_user_id, category, template_key) select $1, 'account', 'fake' from generate_series(1, 500)", [p.id]);
      await su.query("insert into audit_event(kind, actor_portal_user_id, action, source) select 'security', $1, 'fake.action', 'site' from generate_series(1, 200)", [p.id]);
      people.push(p);
    }
    const [r, statements] = await counted(() => del(people[9]!));
    expect(r.status).toBe(200);
    const ms = await median((i) => del(people[i]!));
    console.log(`portal delete: ${statements} statements, median ${ms.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.delete.statements);
    expect(ms).toBeLessThan(BUDGET.delete.medianMs);
  });
});

describe("security", () => {
  it("no login, a candidate session and a staff session are 401 on both routes; a blocked login is 403", async () => {
    for (const who of [{}, { cookie: candidateCookie }, { cookie: staffCookie }, { cookie: "portal.session_token=forged.token" }]) {
      expect((await call("GET", who)).code).toBe("NO_SESSION");
      expect((await del(who)).code).toBe("NO_SESSION");
    }
    const p = await login();
    await su.query("update portal_user set status = 'blocked' where id = $1", [p.id]);
    expect([(await call("GET", p)).code, (await del(p)).code]).toEqual(["REFUSED", "REFUSED"]);
  });

  it("hostile input: wrong or missing Origin, oversized body, bad JSON and any other body are refused before the session is read", async () => {
    const p = await login();
    expect((await call("DELETE", p, { confirm: true }, { origin: "https://evil.example.test" })).code).toBe("BAD_ORIGIN");
    expect((await call("DELETE", p, { confirm: true }, { origin: null })).code).toBe("BAD_ORIGIN");
    expect((await call("DELETE", p, { confirm: true }, { length: "999999" })).code).toBe("BODY_TOO_LARGE");
    expect((await call("DELETE", p, undefined, { raw: JSON.stringify({ confirm: true, pad: "x".repeat(3000) }) })).code).toBe("BODY_TOO_LARGE");
    for (const raw of ["", "not json", "[]", "null", "true", '{"confirm":"true"}', '{"confirm":false}', "{}", '{"confirm":1}'])
      expect((await call("DELETE", p, undefined, { raw })).code, raw).toBe("BAD_REQUEST");
    // a login cannot name another: any extra field is refused
    const other = await login();
    expect((await call("DELETE", p, { confirm: true, userId: other.id })).code).toBe("BAD_REQUEST");
    expect(await one("select count(*)::int n from portal_user where id in ($1, $2)", [p.id, other.id])).toEqual({ n: 2 });
  });

  it("the delete is rate limited per login", async () => {
    const p = await login();
    await caseFor(p.id); // every try is refused, so the login stays
    for (let i = 0; i < 10; i++) expect((await del(p)).code).toBe("OPEN_SERVICES_CASE");
    expect([(await del(p)).status, (await del(p)).code]).toEqual([429, "TOO_MANY_REQUESTS"]);
  });

  it("app_portal cannot run erase_portal_user, and the functions it may run act only on the login whose live session token they get", async () => {
    const victim = await login(), me = await login();
    const ap = db.pool("app_portal");
    await expect(ap.query("select private.erase_portal_user($1, true)", [victim.id])).rejects.toThrow(/permission denied/);
    await expect(ap.query("select private.portal_session_user($1)", ["x"])).rejects.toThrow(/permission denied/);
    // a user id, an expired token, a blocked login's token: all NO_SESSION
    await expect(ap.query("select private.portal_account_delete($1)", [victim.id])).rejects.toThrow(/account refused: NO_SESSION/);
    await expect(ap.query("select private.portal_account_export($1)", [victim.id])).rejects.toThrow(/account refused: NO_SESSION/);
    const token = (await one("select token from portal_session where user_id = $1", [me.id])).token as string;
    await su.query("update portal_session set expires_at = now() - interval '1 second' where user_id = $1", [me.id]);
    await expect(ap.query("select private.portal_account_delete($1)", [token])).rejects.toThrow(/NO_SESSION/);
    for (const role of ["app_candidate", "app_admin", "app_fetcher", "anon"] as const)
      await expect(db.pool(role).query("select private.portal_account_delete($1)", [token]), role).rejects.toThrow(/permission denied/);
    expect(await one("select count(*)::int n from portal_user where id in ($1, $2)", [victim.id, me.id])).toEqual({ n: 2 });
  });
});
