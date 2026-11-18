// Decision #55: the contact form on the portal, end to end on the test database. Real sign-up and sign-in through the real auth route (connected as
// app_portal), then the real /api/portal/contact handler. Signed-in portal users only. Fake people only; no network.
// Budget (measured 16 November 2026, see the printed line): a message is 5 statements (session 2, membership 1, rate count 1, the insert 1); median 16 ms (measured 2.8 to 3.6 ms).
// C3 appeal (18 November 2026): a signed-out appeal is 3 statements (rate count by address, by email, the insert), the same as a candidate-site visitor.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { getContact } from "../src/contact-inbox";

const BUDGET = { statements: 5, appeal: 3, medianMs: 16 };
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, app: pg.Pool;
let AUTH: Handler, CONTACT: Handler;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  app = db.pool("app_portal");
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: CONTACT } = await import("../../../apps/portal/app/api/portal/contact/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
async function login(o: { blocked?: boolean; name?: string } = {}) {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  const up = await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: o.name ?? "Fake Employer", ...portalAnswers }) }));
  expect(up.status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from portal_user where email=$1", [email])).rows[0].id as string;
  if (o.blocked) await su.query("update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='x' where id=$1", [id]);
  return { cookie, id, email };
}
type Opts = { cookie?: string; origin?: string | null; raw?: string; headers?: Record<string, string> };
async function contact(body: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await CONTACT(new Request(`${BASE}/api/portal/contact`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers }));
  const text = await res.text();
  return { status: res.status, text, code: (JSON.parse(text) as { code?: string }).code };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const mine = async (id: string) => (await su.query("select * from contact_message where portal_user_id=$1", [id])).rows;

describe("a signed-in portal user", () => {
  it("files a message: the id from the session, the account's name and email fill what is left out, the answer is only ok", async () => {
    const p = await login({ name: "Employer Name" });
    const r = await contact({ topic: "account", body: "Please help" }, p);
    expect([r.status, r.text]).toEqual([200, '{"ok":true}']);
    expect(await mine(p.id)).toMatchObject([{ surface: "portal", candidate_user_id: null, from_name: "Employer Name", from_email: p.email, topic: "account", body: "Please help", status: "new" }]);
  });
  it("a name or email in the form is used as given", async () => {
    const p = await login();
    await contact({ topic: "other", name: "Other Name", email: "reply.here@example.test", body: "x" }, p);
    expect(await mine(p.id)).toMatchObject([{ from_name: "Other Name", from_email: "reply.here@example.test" }]);
  });
  it("a data_request message gets its review item", async () => {
    const p = await login();
    await contact({ topic: "data_request", body: "x" }, p);
    const [row] = await mine(p.id);
    expect((await su.query("select queue, status from review_item where contact_message_id=$1", [row.id])).rows).toEqual([{ queue: "data_request", status: "open" }]);
  });
  it("an id, surface or status in the body is refused", async () => {
    const a = await login(), b = await login();
    for (const extra of [{ portalUserId: b.id }, { portal_user_id: b.id }, { candidateUserId: "x" }, { status: "answered" }, { surface: "candidate_site" }])
      expect(await contact({ topic: "general", body: "x", ...extra }, a), JSON.stringify(extra)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect([...(await mine(a.id)), ...(await mine(b.id))]).toEqual([]);
  });
  it("erasing the portal user empties name and email, and the text on request", async () => {
    const p = await login();
    await contact({ topic: "data_request", body: "Secret text" }, p);
    const [{ id }] = await mine(p.id);
    expect((await su.query("select private.erase_portal_user($1, true) r", [p.id])).rows[0].r.erased).toBe(true);
    expect((await su.query("select from_name, from_email, body, portal_user_id from contact_message where id=$1", [id])).rows).toEqual([{ from_name: null, from_email: null, body: null, portal_user_id: null }]);
  });
});

describe("security", () => {
  it("no session, a junk session or a blocked login is refused", async () => {
    const f = { topic: "general", body: "x" };
    expect(await contact(f)).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect(await contact(f, { cookie: "portal.session_token=junk; candidate.session_token=junk" })).toMatchObject({ status: 401, code: "NO_SESSION" });
    const b = await login({ blocked: true });
    expect(await contact(f, b)).toMatchObject({ status: 403, code: "REFUSED" });
    expect(await mine(b.id)).toEqual([]);
  });
  it("a foreign or missing Origin, an oversized body, hostile input", async () => {
    const p = await login();
    const f = { topic: "general", body: "x" };
    expect(await contact(f, { ...p, origin: "https://evil.example" })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect(await contact(f, { ...p, origin: "http://localhost:3000" })).toMatchObject({ status: 403, code: "BAD_ORIGIN" }); // the candidate site's origin on the portal route
    expect(await contact(f, { ...p, origin: null })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect(await contact({ ...f, body: "x".repeat(30_000) }, p)).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    expect(await contact(f, { ...p, headers: { "content-length": "999999" } })).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    for (const raw of ["not json", "[]", "null", JSON.stringify({ ...f, body: ["a"] }), JSON.stringify({ ...f, body: "x".repeat(5001) }), JSON.stringify({ ...f, topic: "x" }), JSON.stringify({ ...f, body: "a\u0000b" }), JSON.stringify({ ...f, email: "no" })])
      expect(await contact(null, { ...p, raw }), raw.slice(0, 50)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await mine(p.id)).toEqual([]);
  });
  it("5 an hour per login, then 429; another login is not held", async () => {
    const p = await login(), q = await login();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await contact({ topic: "general", body: `m${i}` }, p)).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await mine(p.id)).length).toBe(5);
    expect((await contact({ topic: "general", body: "x" }, q)).status).toBe(200);
  });
  it("the app role can do nothing to a message but add one for itself", async () => {
    for (const col of ["from_email", "body", "status", "portal_user_id"]) await expect(app.query(`select ${col} from contact_message`), col).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("update contact_message set status='answered'")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("delete from contact_message")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("insert into contact_message(surface, topic, body, status) values ('portal','general','x','spam')")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("insert into contact_message(surface, candidate_user_id, topic, body) values ('candidate_site',(select id from candidate_user limit 1),'general','x')")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("C3: an appeal from a blocked login (which holds no session)", () => {
  let ip = 0;
  const fromIp = () => ({ "x-vercel-forwarded-for": `192.0.2.${(++ip % 250) + 1}` });
  const appeal = (email: string, o: object = {}) => ({ topic: "appeal", name: "Fake Blocked", email, body: "Please look at my block again.", ...o });
  const byEmail = async (email: string) => (await su.query("select * from contact_message where from_email=$1", [email])).rows;
  let staff: string;
  beforeAll(async () => {
    staff = uid("staff-sc-");
    await su.query("insert into staff_user(id, name, email, email_verified) values ($1, 'Fake SC', $1 || '@example.test', true)", [staff]);
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'services_case_handler', true)", [staff]);
  });
  const read = async (id: string) => getContact(db.pool("app_admin"), staff, id) as Promise<Record<string, unknown>>;

  it("signed out, a blocked login's appeal is filed as from a visitor; staff see that its email is a blocked login's", async () => {
    const b = await login({ blocked: true });
    await su.query("delete from portal_session where user_id=$1", [b.id]); // as setLoginHold does
    const r = await contact(appeal(b.email.toUpperCase()), { headers: fromIp() });
    expect([r.status, r.text]).toEqual([200, '{"ok":true}']);
    const [row] = await byEmail(b.email.toUpperCase());
    expect(row).toMatchObject({ surface: "portal", topic: "appeal", portal_user_id: null, candidate_user_id: null, from_name: "Fake Blocked", status: "new" });
    expect(await read(row.id)).toMatchObject({ topic: "appeal", fromHeldLogin: true, portalUserId: null });
  });
  it("a blocked login still holding a session cookie may appeal, and nothing else", async () => {
    const b = await login({ blocked: true });
    expect(await contact(appeal(b.email), { ...b, headers: fromIp() })).toMatchObject({ status: 200 });
    for (const topic of ["general", "account", "data_request", "other"]) expect(await contact({ topic, body: "x" }, { ...b, headers: fromIp() }), topic).toMatchObject({ status: 403, code: "REFUSED" });
    expect((await byEmail(b.email)).map((x) => x.topic)).toEqual(["appeal"]);
  });
  it("signed out, every other topic is still refused; an appeal needs a name and an email", async () => {
    for (const topic of ["general", "account", "data_request", "other"]) expect(await contact({ topic, name: "n", email: "fake.x@example.test", body: "x" }), topic).toMatchObject({ status: 401, code: "NO_SESSION" });
    const e = `${uid("fake.noname.")}@example.test`;
    for (const f of [{ topic: "appeal", body: "x" }, { topic: "appeal", name: "n", body: "x" }, { topic: "appeal", email: e, body: "x" }])
      expect(await contact(f, { headers: fromIp() }), JSON.stringify(f)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await byEmail(e)).toEqual([]);
  });
  it("an active login may not choose appeal", async () => {
    const p = await login();
    expect(await contact(appeal(p.email), p)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await mine(p.id)).toEqual([]);
  });
  it("an email that is no blocked login is filed the same (the reply says nothing), and staff see it is not", async () => {
    const active = await login(), e = `${uid("fake.nobody.")}@example.test`;
    expect([(await contact(appeal(e), { headers: fromIp() })).text, (await contact(appeal(active.email), { headers: fromIp() })).text]).toEqual(['{"ok":true}', '{"ok":true}']);
    expect(await read((await byEmail(e))[0].id)).toMatchObject({ fromHeldLogin: false });
    expect(await read((await byEmail(active.email))[0].id)).toMatchObject({ fromHeldLogin: false });
    await contact({ topic: "general", body: "x" }, active);
    expect(await read((await mine(active.id))[0].id)).toMatchObject({ fromHeldLogin: null }); // other topics: no mark
  });
  it("hostile input: an id in the body, SQL in the email, control characters, a wrong-typed topic", async () => {
    const b = await login({ blocked: true });
    for (const f of [appeal(b.email, { portalUserId: b.id }), appeal(b.email, { status: "answered" }), appeal("x'; drop table portal_user;--@example.test"), appeal(b.email, { name: "a\u0000b" }), appeal(b.email, { body: "x".repeat(5001) })])
      expect(await contact(f, { headers: fromIp() }), JSON.stringify(f).slice(0, 60)).toMatchObject({ status: 400 });
    for (const topic of [["appeal"], "Appeal", { appeal: 1 }]) expect(await contact({ ...appeal(b.email), topic }, { headers: fromIp() }), JSON.stringify(topic)).toMatchObject({ status: 401, code: "NO_SESSION" }); // not the appeal: as before
    expect(await byEmail(b.email)).toEqual([]);
    expect((await contact(appeal(b.email), { origin: "https://evil.example", headers: fromIp() }))).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
  });
  it("the visitor limits: 5 an hour per address, and 5 an hour per email from any address", async () => {
    const one = { "x-vercel-forwarded-for": "192.0.2.254" };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await contact(appeal(`${uid("fake.lim.")}@example.test`), { headers: one })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const b = await login({ blocked: true }), byMail = [];
    for (let i = 0; i < 6; i++) byMail.push((await contact(appeal(i % 2 ? b.email : b.email.toUpperCase()), { headers: fromIp() })).status);
    expect(byMail).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await su.query("select count(*)::int n from contact_message where lower(from_email)=$1", [b.email])).rows[0].n).toBe(5);
    expect((await su.query("select count(*)::int n from portal_rate_limit where key like $1", [`%${b.email}%`])).rows[0].n).toBe(0); // the email is hashed in the key
  });
  it("is 3 statements and inside the time budget", async () => {
    const times: number[] = []; let statements = 0;
    for (let i = 0; i < 9; i++) {
      const t = performance.now();
      const [r, c] = await counted(() => contact(appeal(`${uid("fake.perf.")}@example.test`), { headers: fromIp() }));
      times.push(performance.now() - t);
      expect(r.status).toBe(200);
      statements = Math.max(statements, c);
    }
    const median = [...times].sort((a, b) => a - b)[4]!;
    console.log(`contact-portal appeal: ${statements} statements, median ${median.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.appeal);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});

describe("performance: one contact call", () => {
  it("stays inside the statement count and the time budget", async () => {
    const logins = await Promise.all(Array.from({ length: 9 }, () => login())); // 5 an hour per login: one login per call
    const times: number[] = []; let statements = 0;
    for (const l of logins) {
      const t = performance.now();
      const [r, c] = await counted(() => contact({ topic: "general", body: "x" }, l));
      times.push(performance.now() - t);
      expect(r.status).toBe(200);
      statements = Math.max(statements, c);
    }
    const median = [...times].sort((a, b) => a - b)[4]!;
    console.log(`contact-portal: ${statements} statements, median ${median.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
