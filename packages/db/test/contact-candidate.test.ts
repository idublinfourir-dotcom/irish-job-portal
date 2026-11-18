// Decision #55: the contact form on the candidate site, end to end on the test database. Real sign-up and sign-in through the real auth route
// (connected as app_candidate), then the real /api/contact handler with a Request. Visitors, signed-in candidates, the rate limits, hostile input,
// erasure of what the route wrote. Fake people only; no network (vitest.setup.ts refuses it).
// Budget (measured 16 November 2026, see the printed line): a visitor's message is 3 statements (rate count by address, by email, the insert) and a signed-in
// candidate's is 4 (session 2, rate count 1, the insert 1). Statements and median time are budgeted; raise them only on purpose.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { getContact } from "../src/contact-inbox";

const BUDGET = { visitor: 3, signedIn: 4, medianMs: 16 };
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, app: pg.Pool;
let AUTH: Handler, CONTACT: Handler;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  app = db.pool("app_candidate");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ POST: CONTACT } = await import("../../../apps/candidate/app/api/contact/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${Math.floor(Math.random() * 1e6)}`; // one address per call; the rate key just needs it to differ
async function login(o: { suspended?: boolean; deleted?: boolean; name?: string } = {}) {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  const up = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: o.name ?? "Fake Candidate", ...answers }) }));
  expect(up.status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  if (o.suspended) await su.query("update candidate_user set suspended_at=now() where id=$1", [id]);
  if (o.deleted) await su.query("update candidate_user set deleted_at=now() where id=$1", [id]);
  return { cookie, id, email };
}
type Opts = { cookie?: string; origin?: string | null; raw?: string; ip?: string | null; headers?: Record<string, string> };
async function contact(body: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  if (o.ip !== null) headers["x-vercel-forwarded-for"] = o.ip ?? freshIp();
  const res = await CONTACT(new Request(`${BASE}/api/contact`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers }));
  const text = await res.text();
  return { status: res.status, text, code: (JSON.parse(text) as { code?: string }).code };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const form = (o: object = {}) => ({ topic: "general", name: "Fake Visitor", email: `${uid("v.")}@example.test`, body: "Hello, I have a question.", ...o });
const rowsFor = async (email: string) => (await su.query("select * from contact_message where from_email = $1", [email])).rows;
const OK = [200, '{"ok":true}'];

describe("a visitor", () => {
  it("files a message and the answer is only ok; nothing about the sender is linked", async () => {
    const f = form({ body: "Line one\n\tLine two" });
    const r = await contact(f);
    expect([r.status, r.text]).toEqual(OK);
    const [row] = await rowsFor(f.email);
    expect(row).toMatchObject({ surface: "candidate_site", candidate_user_id: null, portal_user_id: null, from_name: "Fake Visitor", topic: "general", body: "Line one\n\tLine two", status: "new", claimed_by_staff_user_id: null, closed_at: null });
  });
  it("the answer is the same whether or not the email belongs to an account", async () => {
    const p = await login();
    const known = await contact(form({ email: p.email }));
    const unknown = await contact(form());
    expect([known.status, known.text]).toEqual([unknown.status, unknown.text]);
    expect((await rowsFor(p.email))[0]).toMatchObject({ candidate_user_id: null }); // a typed email never links the message to the account
  });
  it("the data_request topic makes a review item; the others do not", async () => {
    const f = form({ topic: "data_request" });
    expect((await contact(f)).status).toBe(200);
    const id = (await rowsFor(f.email))[0].id;
    expect((await su.query("select queue, status from review_item where contact_message_id=$1", [id])).rows).toEqual([{ queue: "data_request", status: "open" }]);
    const g = form({ topic: "account" });
    await contact(g);
    expect((await su.query("select 1 from review_item where contact_message_id=$1", [(await rowsFor(g.email))[0].id])).rowCount).toBe(0);
  });
  it("a visitor must give a name and an email", async () => {
    for (const k of ["name", "email"]) expect(await contact(Object.fromEntries(Object.entries(form()).filter(([x]) => x !== k)))).toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });
  it("a portal or junk session cookie makes no difference: the sender is still a visitor", async () => {
    const f = form();
    expect((await contact(f, { cookie: "portal.session_token=junk; candidate.session_token=junk" })).status).toBe(200);
    expect((await rowsFor(f.email))[0]).toMatchObject({ candidate_user_id: null, portal_user_id: null });
  });
});

describe("a signed-in candidate", () => {
  it("the id comes from the session and the account's name and email fill what is left out", async () => {
    const p = await login({ name: "Account Name" });
    const r = await contact({ topic: "account", body: "Please help" }, { cookie: p.cookie });
    expect([r.status, r.text]).toEqual(OK);
    expect((await su.query("select * from contact_message where candidate_user_id=$1", [p.id])).rows).toMatchObject([{ surface: "candidate_site", from_name: "Account Name", from_email: p.email, portal_user_id: null, status: "new" }]);
  });
  it("a name or email in the form is used as given", async () => {
    const p = await login();
    await contact({ topic: "other", name: "Other Name", email: "reply.here@example.test", body: "x" }, { cookie: p.cookie });
    expect((await su.query("select from_name, from_email from contact_message where candidate_user_id=$1", [p.id])).rows).toEqual([{ from_name: "Other Name", from_email: "reply.here@example.test" }]);
  });
  it("an id, surface or status in the body is refused, and nothing is written", async () => {
    const a = await login(), b = await login();
    for (const extra of [{ candidateUserId: b.id }, { candidate_user_id: b.id }, { portalUserId: "x" }, { status: "answered" }, { surface: "portal" }, { claimed_by_staff_user_id: "x" }])
      expect(await contact({ topic: "general", body: "x", ...extra }, { cookie: a.cookie }), JSON.stringify(extra)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect((await su.query("select 1 from contact_message where candidate_user_id in ($1,$2)", [a.id, b.id])).rowCount).toBe(0);
  });
  it("a suspended or deleted candidate is treated as a visitor: name and email are needed, no id is stored", async () => {
    const s = await login({ suspended: true }), d = await login({ deleted: true });
    for (const p of [s, d]) {
      expect(await contact({ topic: "account", body: "I was suspended" }, { cookie: p.cookie })).toMatchObject({ status: 400, code: "BAD_REQUEST" });
      const f = form({ topic: "account" });
      expect((await contact(f, { cookie: p.cookie })).status).toBe(200);
      expect((await rowsFor(f.email))[0].candidate_user_id).toBeNull();
    }
  });
});

describe("C3: a suspended candidate's appeal", () => {
  let staff: string;
  beforeAll(async () => {
    staff = uid("staff-ce-");
    await su.query("insert into staff_user(id, name, email, email_verified) values ($1, 'Fake CE', $1 || '@example.test', true)", [staff]);
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'content_editor', true)", [staff]);
  });
  const read = async (email: string) => getContact(db.pool("app_admin"), staff, (await rowsFor(email))[0].id) as Promise<Record<string, unknown>>;
  it("signed out or with the old cookie, it is filed as from a visitor and staff see the email is a suspended candidate's", async () => {
    const s = await login({ suspended: true }), t = await login({ suspended: true });
    await su.query("delete from candidate_session where user_id=$1", [s.id]); // as setLoginHold does
    expect([(await contact(form({ topic: "appeal", email: s.email }))).text, (await contact(form({ topic: "appeal", email: t.email }), { cookie: t.cookie })).text]).toEqual([OK[1], OK[1]]);
    for (const p of [s, t]) {
      expect((await rowsFor(p.email))[0]).toMatchObject({ surface: "candidate_site", topic: "appeal", candidate_user_id: null });
      expect(await read(p.email)).toMatchObject({ topic: "appeal", fromHeldLogin: true });
    }
  });
  it("an active or deleted candidate's email, or nobody's, is not marked; an active signed-in candidate may not choose appeal", async () => {
    const a = await login(), d = await login({ deleted: true }), e = `${uid("v.")}@example.test`;
    await su.query("update candidate_user set suspended_at=now() where id=$1", [d.id]); // deleted and suspended: no longer a login to restore
    for (const email of [a.email, d.email, e]) {
      expect((await contact(form({ topic: "appeal", email }))).status).toBe(200);
      expect(await read(email), email).toMatchObject({ fromHeldLogin: false });
    }
    const f = form({ topic: "appeal" });
    expect(await contact(f, { cookie: a.cookie })).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await rowsFor(f.email)).toEqual([]);
  });
});

describe("erasure still empties what the route wrote", () => {
  it("on request: name, email, text and the id are gone; otherwise name and email", async () => {
    const a = await login(), b = await login();
    for (const p of [a, b]) await contact({ topic: "data_request", body: "Secret text" }, { cookie: p.cookie });
    const ids = async (p: { id: string }) => (await su.query("select id from contact_message where candidate_user_id=$1", [p.id])).rows.map((r) => r.id);
    const [ia, ib] = [await ids(a), await ids(b)];
    expect((await su.query("select private.erase_candidate($1, true) r", [a.id])).rows[0].r.erased).toBe(true);
    expect((await su.query("select from_name, from_email, body, candidate_user_id from contact_message where id=$1", [ia[0]])).rows).toEqual([{ from_name: null, from_email: null, body: null, candidate_user_id: null }]);
    expect((await su.query("select status from review_item where contact_message_id is null and outcome = 'subject_erased' and candidate_user_id is null limit 1")).rowCount).toBe(1);
    expect((await su.query("select private.erase_candidate($1, false) r", [b.id])).rows[0].r.erased).toBe(true);
    expect((await su.query("select from_name, from_email, body from contact_message where id=$1", [ib[0]])).rows).toEqual([{ from_name: null, from_email: null, body: "Secret text" }]);
  });
});

describe("security: refusals", () => {
  it("a foreign or missing Origin", async () => {
    expect(await contact(form(), { origin: "https://evil.example" })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect(await contact(form(), { origin: "http://localhost:3001" })).toMatchObject({ status: 403, code: "BAD_ORIGIN" }); // the portal's origin on the candidate route
    expect(await contact(form(), { origin: null })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
  });
  it("an oversized body, before and after reading", async () => {
    expect(await contact(form({ body: "x".repeat(30_000) }))).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    expect(await contact(form(), { headers: { "content-length": "999999" } })).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    expect(await contact(form({ body: "x".repeat(5001) }))).toMatchObject({ status: 400, code: "BAD_REQUEST" }); // under the cap, over the limit
  });
  it("hostile input of every shape", async () => {
    const f = form();
    const bodies: unknown[] = ["not json", "[]", "null", "5", '"x"', "{", JSON.stringify({ ...f, body: ["a"] }), JSON.stringify({ ...f, body: { a: 1 } }), JSON.stringify({ ...f, topic: { a: 1 } }), JSON.stringify({ ...f, email: ["a@example.test"] }),
      JSON.stringify({ ...f, email: "a@example.test\r\nBcc: x@example.test" }), JSON.stringify({ ...f, name: "a\u0000b" }), JSON.stringify({ ...f, body: "a\u0000b" }), JSON.stringify({ ...f, topic: "data_request'; drop table contact_message;--" }),
      JSON.stringify({ ...f, status: "spam" }), JSON.stringify([f, f]), `{"topic":"general","body":"x","__proto__":{"candidateUserId":"x"},"name":"a","email":"a@example.test"}`];
    for (const raw of bodies) expect(await contact(null, { raw: raw as string }), String(raw).slice(0, 60)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await rowsFor(f.email)).toEqual([]);
  });
  it("the 5,000-character edge and a 254-character email go through; 255 does not", async () => {
    const at = (len: number) => `${"a".repeat(len - 13)}@example.test`;
    expect((await contact(form({ body: "x".repeat(5000), email: at(254) }))).status).toBe(200);
    expect((await contact(form({ email: at(255) }))).status).toBe(400);
    expect((await contact(form({ body: "x" }))).status).toBe(200);
  });
  it("the app role can do nothing to a message but add one", async () => {
    for (const col of ["from_email", "body", "status", "candidate_user_id"]) await expect(app.query(`select ${col} from contact_message`), col).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("update contact_message set status='answered'")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("delete from contact_message")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("insert into contact_message(surface, topic, body, status) values ('candidate_site','general','x','answered')")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("insert into contact_message(surface, portal_user_id, topic, body) values ('portal',(select id from portal_user limit 1),'general','x')")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("security: rate limits", () => {
  it("per signed-in login: 5 an hour, then 429; another login is not held", async () => {
    const p = await login(), q = await login();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await contact({ topic: "general", body: `m${i}` }, { cookie: p.cookie })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await su.query("select 1 from contact_message where candidate_user_id=$1", [p.id])).rowCount).toBe(5);
    expect((await contact({ topic: "general", body: "x" }, { cookie: q.cookie })).status).toBe(200);
  });
  it("per client address for visitors: 5 an hour whatever the email; another address is not held", async () => {
    const ip = freshIp();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await contact(form(), { ip })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await contact(form(), { ip: freshIp() })).status).toBe(200);
  });
  it("per email for visitors: 5 an hour whatever the address, in any letter case; another email is not held", async () => {
    const email = `${uid("same.")}@example.test`;
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await contact(form({ email: i % 2 ? email.toUpperCase() : email }))).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await su.query("select 1 from contact_message where lower(from_email) = $1", [email])).rowCount).toBe(5);
    expect((await contact(form())).status).toBe(200);
  });
  it("a visitor with no address header shares one bucket, and the keys hold no email address", async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await contact(form(), { ip: null })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const keys = (await su.query("select key from candidate_rate_limit where key like 'contact:%'")).rows.map((r) => r.key as string);
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((k) => /@|example\.test/.test(k))).toEqual([]);
    expect(keys.filter((k) => k.startsWith("contact:email:")).every((k) => /^contact:email:[0-9a-f]{64}$/.test(k))).toBe(true);
  });
  it("a refused body does not use up the limit", async () => {
    const ip = freshIp();
    for (let i = 0; i < 8; i++) expect((await contact({ topic: "nope" }, { ip })).status).toBe(400);
    expect((await contact(form(), { ip })).status).toBe(200);
  });
});

describe("performance: one contact call", () => {
  it("stays inside the statement count and the time budget", async () => {
    const measure = async (send: (i: number) => ReturnType<typeof contact>) => {
      const times: number[] = []; let statements = 0;
      for (let i = 0; i < 9; i++) {
        const t = performance.now();
        const [r, c] = await counted(() => send(i));
        times.push(performance.now() - t);
        expect(r.status).toBe(200);
        statements = Math.max(statements, c);
      }
      return { statements, median: [...times].sort((a, b) => a - b)[4]! };
    };
    const visitor = await measure(() => contact(form()));
    const logins = await Promise.all(Array.from({ length: 9 }, () => login())); // a login may send 5 an hour: one login per call
    const signed = [await measure((i) => contact({ topic: "general", body: "x" }, { cookie: logins[i]!.cookie }))];
    console.log(`contact-candidate: visitor ${visitor.statements} statements, median ${visitor.median.toFixed(1)} ms; signed in ${signed[0]!.statements} statements, median ${signed[0]!.median.toFixed(1)} ms`);
    expect(visitor.statements).toBeLessThanOrEqual(BUDGET.visitor);
    expect(signed[0]!.statements).toBeLessThanOrEqual(BUDGET.signedIn);
    expect(visitor.median).toBeLessThan(BUDGET.medianMs);
    expect(signed[0]!.median).toBeLessThan(BUDGET.medianMs);
  });
});
