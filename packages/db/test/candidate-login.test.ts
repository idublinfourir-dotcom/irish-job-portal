// Step 7 slice 2 part A (#174 to #178): the candidate app's login, end to end on the test database. Sign-up, confirmation, sign-in,
// resend and reset go through the real route handler of apps/candidate with a Request, connected as app_candidate. Email is the
// fake sender (in memory, localhost only). The placeholder wording is saved by the real command as app_admin. Fake people only.
// The steps share state (cookies, ids), so they run in order.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { createAuth } from "../../auth/src";
import { seedSignupTerms } from "./better-auth-helper";

// Statements measured on 12 November 2026, counting every pg.Client.query call (begin and commit included). Sign-up (account plus
// consent row, with the rate limit): 10 on the first request of an instance, which includes Better Auth's one-off column list read.
// Sign-in: 6, and 7 since 17 November 2026 (C1: the update of last_active_at). A server-side getSession is 2, and 4 through the route
// (the rate limit adds 2). Raise these only on purpose.
const BUDGET = { signUp: 10, signIn: 7, getSession: 2, signUpMs: 700, concurrentMs: 2100, signInMs: 740 };
// Times measured three times on 12 November 2026 (about 5 times the measured value): sign-up 141 ms (budget 700), 10 concurrent sign-ups
// 420 ms (2100), sign-in 148 ms (740). Hashing the password dominates sign-up and sign-in.

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const CLI = fileURLToPath(new URL("../src/signup-terms-cli.ts", import.meta.url));
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool;
let POST: (r: Request) => Promise<Response>, GET: (r: Request) => Promise<Response>, mail: () => { pool: string; kind: string; to: string; link: string }[];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST, GET } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ candidateMail: mail } = await import("../../../apps/candidate/lib/candidate"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let ipn = 10;
const freshIp = () => `198.51.100.${ipn++}`;
async function call(path: string, body?: unknown, o: { ip?: string; cookie?: string; raw?: string; origin?: string } = {}) {
  const post = body !== undefined || o.raw !== undefined, handler = post ? POST : GET;
  const res = await handler(new Request(`${BASE}/api/auth/candidate/${path}`, {
    method: post ? "POST" : "GET", body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual",
    headers: { "content-type": "application/json", origin: o.origin ?? BASE, "x-vercel-forwarded-for": o.ip ?? freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}) },
  }));
  const text = await res.text();
  let json: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, location: res.headers.get("location"), cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
// Counts every statement any pg client in this process sends while fn runs.
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}

const yes = { needsPermit: true, over18: true, acceptsTerms: true };
const person = (n: string) => ({ email: `fake.${n}@example.test`, password: `Fake-${n}-password-1`, name: `Fake ${n}`, ...yes });
const count = async (sql: string, args: unknown[] = []) => (await su.query(`select count(*)::int n from (${sql}) t`, args)).rows[0].n as number;
const users = (email: string) => count("select 1 from candidate_user where email=$1", [email]);
const linkFor = (email: string, kind: string) => mail().filter((m) => m.to === email && m.kind === kind).at(-1)!.link;
const click = (link: string) => { const u = new URL(link); return call(u.pathname.replace("/api/auth/candidate/", "") + u.search); };

const cli = (args: string[], role = "app_admin") =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" } });
const termsRows = () => count("select 1 from consent_text where purpose='signup_terms'");
const requests = () => count("select 1 from approval_request");
async function staff(role: string) {
  const id = `st-${Math.random().toString(36).slice(2, 10)}`;
  await su.query("insert into staff_user(id,name,email,email_verified) values($1,'Fake Staff',$2,true)", [id, `${id}@example.test`]);
  await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [id, role]);
  return id;
}

describe("sign-up before the sign-up wording exists", () => {
  it("is refused cleanly (503) and makes no account", async () => {
    const r = await call("sign-up/email", person("early"));
    expect(r.status).toBe(503);
    expect(r.json?.code).toBe("SIGNUP_TERMS_MISSING");
    expect(await users(person("early").email)).toBe(0);
  });
});

describe("placeholder wording command (#176)", () => {
  let a: string, b: string, writer: string;
  beforeAll(async () => { a = await staff("content_editor"); b = await staff("administrator"); writer = await staff("content_editor"); });

  it("refuses the same staff id twice, odd ids and the wrong number of arguments, before it connects", () => {
    expect(cli([a, a]).stdout).toMatch(/two different/);
    for (const bad of ["x'; drop table consent_text;--", "", "a b", "x".repeat(65)]) expect(cli([bad, b]).stdout, bad).toMatch(/staff id is 1 to 64/);
    expect(cli([a]).stdout).toMatch(/usage/);
    expect(cli([a, b, "extra"]).stdout).toMatch(/usage/);
  });
  it("is refused for every other login, and writes nothing", async () => {
    for (const role of ["app_candidate", "app_portal", "app_fetcher"]) {
      const r = cli([a, b], role);
      expect(r.status, `${role}: ${r.stdout}`).toBe(1);
      expect(r.stdout, role).toMatch(/refused/);
    }
    expect([await termsRows(), await requests()]).toEqual([0, 0]);
  });
  it("is refused when the confirmer is not an administrator, or the staff ids are unknown, and rolls everything back", async () => {
    expect(cli([a, writer]).stdout).toMatch(/refused: .*confirmer does not hold the role/);
    expect(cli([a, "no-such-staff-member"]).stdout).toMatch(/refused/);
    expect(cli(["no-such-staff-member", b]).stdout).toMatch(/refused/);
    expect([await termsRows(), await requests()]).toEqual([0, 0]);
  });
  it("saves the text through a request proposed by one person and confirmed by the other, used once", async () => {
    const r = cli([a, b]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/saved the placeholder/);
    const row = (await su.query(
      `select t.version, t.body, q.kind, q.target_id, q.status, q.proposed_by_staff_user_id p, q.confirmed_by_staff_user_id c, q.applied_at is not null used
         from consent_text t join approval_request q on q.id = t.approval_request_id where t.purpose='signup_terms'`)).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ version: "placeholder-2026-11-12", kind: "terms_privacy_page", target_id: "signup_terms:placeholder-2026-11-12", status: "confirmed", p: a, c: b, used: true });
    expect(row[0].body).toMatch(/PLACEHOLDER/);
  });
  it("is safe to run twice: the second run writes nothing", async () => {
    const r = cli([a, b]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already there; nothing was written/);
    expect([await termsRows(), await requests()]).toEqual([1, 1]);
  });
});

describe("sign-up with the three answers (#8, #106, #175, #176, #178)", () => {
  const ann = person("ann");
  it("makes the account and its consent row together, sends the confirmation link, and logs nobody in", async () => {
    const [r, n] = await counted(() => call("sign-up/email", ann));
    expect(r.status, r.text).toBe(200);
    expect(n, `sign-up sent ${n} statements`).toBeLessThanOrEqual(BUDGET.signUp);
    expect(r.json?.token).toBeNull();
    expect(r.cookie).toBe("");
    const rows = (await su.query(
      `select c.details, c.given_at, c.withdrawn_at, t.purpose, t.version, u.email_verified
         from consent_record c join consent_text t on t.id = c.consent_text_id join candidate_user u on u.id = c.candidate_user_id where u.email=$1`, [ann.email])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ details: yes, purpose: "signup_terms", version: "placeholder-2026-11-12", withdrawn_at: null, email_verified: false });
    expect(Math.abs(rows[0].given_at.getTime() - Date.now())).toBeLessThan(10000);
    expect(mail().filter((m) => m.to === ann.email).map((m) => [m.pool, m.kind])).toEqual([["candidate", "verify"]]);
  });
  it("sign-up stays inside its time budget", async () => {
    const t = performance.now();
    expect((await call("sign-up/email", person("speed"))).status).toBe(200);
    expect(performance.now() - t).toBeLessThan(BUDGET.signUpMs);
  });

  it("refuses 'no' to needing a permit, and every answer that is not the plain value true, with no account made", async () => {
    const bad: Record<string, unknown>[] = [
      { needsPermit: false }, { needsPermit: undefined }, { needsPermit: "true" }, { needsPermit: 1 }, { needsPermit: null }, { needsPermit: [true] }, { needsPermit: { value: true } },
      { over18: false }, { over18: undefined }, { over18: "yes" }, { over18: 1 }, { over18: { value: true } },
      { acceptsTerms: false }, { acceptsTerms: undefined }, { acceptsTerms: "on" }, { acceptsTerms: 0 }, { acceptsTerms: [true] },
      { needsPermit: "'; drop table candidate_user;--" }, { over18: "x".repeat(100000) }, { acceptsTerms: { $ne: null } },
    ];
    for (const [i, extra] of bad.entries()) {
      const p = { ...person(`bad${i}`), ...extra };
      const r = await call("sign-up/email", p);
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.json?.code, JSON.stringify(extra)).toBe("SIGNUP_ANSWERS_REFUSED");
      expect(await users(p.email), JSON.stringify(extra)).toBe(0);
    }
  });
  it("refuses a body with no answers at all, a list or a text body, and an empty or huge name", async () => {
    const p = person("noanswers");
    expect((await call("sign-up/email", { email: p.email, password: p.password, name: p.name })).status).toBe(400);
    expect((await call("sign-up/email", { ...person("nm1"), name: "" })).json?.code).toBe("SIGNUP_NAME_REFUSED");
    expect((await call("sign-up/email", { ...person("nm2"), name: "x".repeat(101) })).json?.code).toBe("SIGNUP_NAME_REFUSED");
    expect((await call("sign-up/email", { ...person("nm3"), name: { first: "x" } })).status).toBe(400);
    expect((await call("sign-up/email", undefined, { raw: JSON.stringify([yes]) })).status).toBe(400);
    expect((await call("sign-up/email", undefined, { raw: "not json" })).status).toBeGreaterThanOrEqual(400);
    expect(await count("select 1 from candidate_user where email like 'fake.nm%' or email=$1", [p.email])).toBe(0);
  });
  it("keeps Better Auth's limits on the email and the password", async () => {
    expect((await call("sign-up/email", { ...person("short"), password: "short" })).status).toBe(400);
    expect((await call("sign-up/email", { ...person("long"), password: "x".repeat(129) })).status).toBe(400);
    expect((await call("sign-up/email", { ...person("mail"), email: "not-an-email" })).status).toBe(400);
    expect(await count("select 1 from candidate_user where email like 'fake.short%' or email like 'fake.long%' or email like 'fake.mail%'")).toBe(0);
  });
  it("stores an SQL-looking name as plain text", async () => {
    const p = { ...person("sql"), name: "Robert'); drop table candidate_user;--" };
    expect((await call("sign-up/email", p)).status).toBe(200);
    expect((await su.query("select name from candidate_user where email=$1", [p.email])).rows[0].name).toBe(p.name);
  });
  it("ignores a text id, a user id or a time sent by the client: the server picks the current text", async () => {
    const p = { ...person("sneaky"), consentTextId: 999, consent_text_id: 999, candidateUserId: "someone-else", givenAt: "2001-01-01", given_at: "2001-01-01", emailVerified: true, status: "x" };
    expect((await call("sign-up/email", p)).status).toBe(200);
    const r = (await su.query(`select c.consent_text_id::text t, c.candidate_user_id u, c.given_at, x.id, x.email_verified, x.suspended_at
       from consent_record c join candidate_user x on x.id = c.candidate_user_id where x.email=$1`, [p.email])).rows;
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe((await su.query("select id::text from consent_text where purpose='signup_terms'")).rows[0].id);
    expect(r[0].u).toBe(r[0].id);
    expect(r[0].email_verified).toBe(false);
    expect(r[0].suspended_at).toBeNull();
    expect(r[0].given_at.getFullYear()).toBeGreaterThan(2020);
  });
  it("refuses a body that tries to set a status column (suspendedAt, deletedAt), and makes no account", async () => {
    for (const extra of [{ suspendedAt: "2001-01-01" }, { deletedAt: "2001-01-01" }, { lastActiveAt: "2001-01-01" }]) {
      const p = { ...person("cols"), ...extra };
      expect((await call("sign-up/email", p)).status, JSON.stringify(extra)).toBe(400);
      expect(await users(p.email)).toBe(0);
    }
  });
  it("uses the newest signup_terms text once there is one", async () => {
    const [a, b] = [await staff("content_editor"), await staff("administrator")];
    const c = await db.pool("app_admin").connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [a]);
      const id = (await c.query("insert into approval_request(kind,target_table,target_id) values ('terms_privacy_page','consent_text','signup_terms:v2') returning id")).rows[0].id;
      await c.query("select set_config('app.staff_user_id', $1, true)", [b]);
      await c.query("update approval_request set status='confirmed' where id=$1", [id]);
      await c.query("insert into consent_text(purpose,version,body,approval_request_id,published_at) values ('signup_terms','v2','Second text',$1, now() + interval '1 second')", [id]);
      await c.query("commit");
    } finally { c.release(); }
    const p = person("v2");
    expect((await call("sign-up/email", p)).status).toBe(200);
    expect((await su.query("select t.version from consent_record c join consent_text t on t.id=c.consent_text_id join candidate_user u on u.id=c.candidate_user_id where u.email=$1", [p.email])).rows[0].version).toBe("v2");
  });

  it("an existing email gets the same reply as a new one, and makes no second account or consent row", async () => {
    const [fresh, again] = [await call("sign-up/email", person("dup")), await call("sign-up/email", person("dup"))];
    const capitals = await call("sign-up/email", { ...person("dup"), email: person("dup").email.toUpperCase() });
    for (const r of [again, capitals]) {
      expect(r.status).toBe(fresh.status);
      expect(Object.keys(r.json ?? {}).sort()).toEqual(Object.keys(fresh.json ?? {}).sort());
      expect(Object.keys(r.json?.user ?? {}).sort()).toEqual(Object.keys(fresh.json?.user ?? {}).sort());
      expect(r.json?.token).toBeNull();
    }
    expect(await users(person("dup").email)).toBe(1);
    expect(await count("select 1 from consent_record c join candidate_user u on u.id=c.candidate_user_id where u.email=$1", [person("dup").email])).toBe(1);
    expect(mail().filter((m) => m.to === person("dup").email)).toHaveLength(1);
  });
  it("bad answers on an existing email are refused the same way as on a new one (the address is not revealed)", async () => {
    const existing = await call("sign-up/email", { ...person("dup"), over18: false });
    const unknown = await call("sign-up/email", { ...person("nobody"), over18: false });
    expect([existing.status, existing.json?.code]).toEqual([unknown.status, unknown.json?.code]);
    expect(existing.status).toBe(400);
  });

  it("settled: no account can exist without its consent row, because the row is written inside Better Auth's own transaction", async () => {
    // Make the consent insert fail for one person only. The account row, written just before it, must not survive.
    const p = person("tx");
    await su.query(`create function pg_temp.dummy() returns int language sql as 'select 1'`).catch(() => {});
    await su.query(`create function public.fail_consent() returns trigger language plpgsql as $$ begin
      if new.candidate_user_id in (select id from candidate_user where email = '${p.email}') then raise exception 'consent write refused for the test'; end if; return new; end $$`);
    await su.query("create trigger fail_consent before insert on consent_record for each row execute function public.fail_consent()");
    try {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let r;
      try { r = await call("sign-up/email", p); } finally { logged.mockRestore(); }
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await users(p.email)).toBe(0);
      expect(await count("select 1 from candidate_account a left join candidate_user u on u.id = a.user_id where u.id is null")).toBe(0);
      expect(mail().filter((m) => m.to === p.email)).toHaveLength(0);
    } finally {
      await su.query("drop trigger fail_consent on consent_record");
      await su.query("drop function public.fail_consent()");
    }
    expect((await call("sign-up/email", p)).status).toBe(200);
  });
  it("10 sign-ups at once on a pool of 5 connections all finish (the sign-up asks the pool for no second connection) and each has its consent row", async () => {
    const t = performance.now();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call("sign-up/email", person(`conc${i}`))));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(performance.now() - t).toBeLessThan(BUDGET.concurrentMs);
    expect(await count("select 1 from consent_record c join candidate_user u on u.id=c.candidate_user_id where u.email like 'fake.conc%'")).toBe(10);
  });
  it("holds for every candidate made so far: none without a consent row", async () => {
    expect(await count("select 1 from candidate_user u where not exists (select 1 from consent_record c where c.candidate_user_id = u.id and c.consent_text_id is not null)")).toBe(0);
    expect(await count("select 1 from candidate_user")).toBeGreaterThan(5);
  });
});

describe("email confirmation (#54)", () => {
  const eve = person("eve");
  it("sign-in is refused until the link is clicked (403)", async () => {
    expect((await call("sign-up/email", eve)).status).toBe(200);
    const r = await call("sign-in/email", { email: eve.email, password: eve.password });
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("EMAIL_NOT_VERIFIED");
    expect(r.cookie).toBe("");
  });
  it("a forged or damaged link confirms nothing", async () => {
    const link = linkFor(eve.email, "verify");
    const u = new URL(link), token = u.searchParams.get("token")!;
    const others = [token.slice(0, -3) + "AAA", token.slice(0, 20), "", "not.a.token", `${token.split(".")[0]}.${token.split(".")[1]}.`, "../../etc/passwd", "' or 1=1 --"];
    for (const t of others) {
      const r = await call(`verify-email?token=${encodeURIComponent(t)}`);
      expect(r.status === 200 && r.json?.status === true, t).toBe(false);
      expect(r.cookie, t).toBe("");
    }
    // a token for another address does not confirm this one
    const ann = linkFor(person("ann").email, "verify");
    await click(ann);
    expect((await su.query("select email_verified from candidate_user where email=$1", [eve.email])).rows[0].email_verified).toBe(false);
    expect((await call("sign-in/email", { email: eve.email, password: eve.password })).status).toBe(403);
  });
  it("resend sends a new link, and the rate limit stops a fourth in five minutes", async () => {
    const ip = freshIp(), before = mail().filter((m) => m.to === eve.email).length;
    const seq = [];
    // other addresses after the first, so only the per-IP limit counts here (the per-address limit has its own tests)
    for (let i = 0; i < 5; i++) seq.push((await call("send-verification-email", { email: i ? `fake.ip${i}@example.test` : eve.email }, { ip })).status);
    expect(seq).toEqual([200, 200, 200, 429, 429]);
    expect(mail().filter((m) => m.to === eve.email).length).toBe(before + 1);
    // another IP address is not held back by it
    expect((await call("send-verification-email", { email: eve.email })).status).toBe(200);
  });
  it("resend for an unknown address looks the same and sends nothing", async () => {
    const known = await call("send-verification-email", { email: eve.email });
    const unknown = await call("send-verification-email", { email: "fake.nobody@example.test" });
    expect([unknown.status, unknown.json]).toEqual([known.status, known.json]);
    expect(mail().some((m) => m.to === "fake.nobody@example.test")).toBe(false);
  });
  it("the real link confirms the address; the same link used again does no harm", async () => {
    const link = linkFor(eve.email, "verify");
    const first = await click(link);
    expect(first.status, first.text).toBeLessThan(400);
    expect((await su.query("select email_verified from candidate_user where email=$1", [eve.email])).rows[0].email_verified).toBe(true);
    const sessions = await count("select 1 from candidate_session s join candidate_user u on u.id=s.user_id where u.email=$1", [eve.email]);
    await click(link);
    expect(await count("select 1 from candidate_session s join candidate_user u on u.id=s.user_id where u.email=$1", [eve.email])).toBe(sessions);
    expect(await users(eve.email)).toBe(1);
  });
  let cookie: string;
  it("sign-in then works, within its statement and time budget; the session lasts 7 days", async () => {
    const t = performance.now();
    const [r, n] = await counted(() => call("sign-in/email", { email: eve.email, password: eve.password }));
    expect(performance.now() - t).toBeLessThan(BUDGET.signInMs);
    expect(r.status, r.text).toBe(200);
    expect(n, `sign-in sent ${n} statements`).toBeLessThanOrEqual(BUDGET.signIn);
    cookie = r.cookie;
    expect(cookie).toMatch(/^candidate\.session_token=/);
    const days = ((await su.query("select expires_at from candidate_session s join candidate_user u on u.id=s.user_id where u.email=$1 order by s.created_at desc limit 1", [eve.email])).rows[0].expires_at.getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
  });
  it("a server-side getSession (what pages will use) reads the session in at most 2 statements; through the route, the 2 rate-limit statements are added", async () => {
    const headers = new Headers({ cookie });
    const { candidateAuth } = await import("../../../apps/candidate/lib/candidate");
    const [s, n] = await counted(() => candidateAuth().api.getSession({ headers }));
    expect(s?.user.email).toBe(eve.email);
    expect(n, `${n} statements`).toBeLessThanOrEqual(BUDGET.getSession);
    const [r, m] = await counted(() => call("get-session", undefined, { cookie }));
    expect(r.json?.user?.email).toBe(eve.email);
    expect(m, `${m} statements`).toBeLessThanOrEqual(BUDGET.getSession + 2);
  });
  it("C1: sign-in and the daily session refresh mark the candidate active, so the dormant rules pass them over and a warning already sent is cancelled", async () => {
    const state = async () => (await su.query("select last_active_at > now() - interval '1 minute' as active, inactive_warned_at is null as unwarned from candidate_user where email = $1", [eve.email])).rows[0];
    const dormant = async () => { // two statements: a change of last_active_at clears inactive_warned_at in the same row (0002 trigger)
      await su.query("update candidate_user set last_active_at = now() - interval '13 months' where email = $1", [eve.email]);
      await su.query("update candidate_user set inactive_warned_at = now() - interval '60 days' where email = $1", [eve.email]);
      expect(await state()).toEqual({ active: false, unwarned: false });
    };
    await dormant();
    expect((await call("sign-in/email", { email: eve.email, password: eve.password })).status).toBe(200);
    expect(await state()).toEqual({ active: true, unwarned: true });
    await dormant(); // a session used every day is refreshed once a day (Better Auth's updateAge), not made again
    await su.query("update candidate_session s set expires_at = now() + interval '5 days' from candidate_user u where u.id = s.user_id and u.email = $1", [eve.email]);
    expect((await call("get-session", undefined, { cookie })).json?.user?.email).toBe(eve.email);
    expect(await state()).toEqual({ active: true, unwarned: true });
    await db.query("app_admin", "select private.run_retention()");
    expect((await su.query("select deleted_at from candidate_user where email = $1", [eve.email])).rows[0].deleted_at).toBeNull();
  });
  it("a wrong password is 401 and then the rate limit holds the address: 5 tries a minute, then 429", async () => {
    const ip = freshIp(), seq = [];
    for (let i = 0; i < 7; i++) seq.push((await call("sign-in/email", { email: eve.email, password: "Wrong-password-123456" }, { ip })).status);
    expect(seq).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect((await call("sign-in/email", { email: eve.email, password: eve.password }, { ip })).status).toBe(429);
  });
  it("sign-up is limited to 5 a minute from one address", async () => {
    const ip = freshIp(), seq = [];
    for (let i = 0; i < 6; i++) seq.push((await call("sign-up/email", person(`rate${i}`), { ip })).status);
    expect(seq).toEqual([200, 200, 200, 200, 200, 429]);
  });

  describe("cookies do not cross between the candidate and staff pools", () => {
    it("a staff cookie, even renamed to the candidate cookie with a valid signature, is no candidate session; a candidate cookie is no staff session", async () => {
      const staffAuth = createAuth("staff", { database: db.pool("app_admin"), baseURL: BASE, secret, sendEmail: async () => {} });
      const ctx = await staffAuth.$context;
      const user = await ctx.internalAdapter.createUser({ email: eve.email, name: "Fake staff", emailVerified: true }, { method: "email-password" });
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash("Fake-staff-password-1") });
      const res = await staffAuth.handler(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
        method: "POST", body: JSON.stringify({ email: eve.email, password: "Fake-staff-password-1" }),
        headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } }));
      const staffCookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      expect(staffCookie).toMatch(/^staff\.session_token=/);
      for (const c of [staffCookie, staffCookie.replace("staff.session_token", "candidate.session_token")])
        expect((await call("get-session", undefined, { cookie: c })).json, c).toBeNull();
      const asStaff = await staffAuth.api.getSession({ headers: new Headers({ cookie: cookie.replace("candidate.session_token", "staff.session_token") }) });
      expect(asStaff).toBeNull();
      expect((await call("get-session", undefined, { cookie })).json?.user?.email).toBe(eve.email);
    });
  });

  describe("suspended and deleted candidates (#177)", () => {
    it("a suspended candidate cannot sign in, and a deleted one cannot either", async () => {
      await db.query("app_admin", "update candidate_user set suspended_at=now() where email=$1", [eve.email]);
      const s = await call("sign-in/email", { email: eve.email, password: eve.password });
      expect([s.status, s.json?.message]).toEqual([403, "This account cannot sign in."]);
      await db.query("app_admin", "update candidate_user set suspended_at=null where email=$1", [eve.email]);
      expect((await call("sign-in/email", { email: eve.email, password: eve.password })).status).toBe(200);
      await db.query("app_admin", "update candidate_user set deleted_at=now() where email=$1", [eve.email]);
      expect((await call("sign-in/email", { email: eve.email, password: eve.password })).status).toBe(403);
      await db.query("app_admin", "update candidate_user set deleted_at=null where email=$1", [eve.email]);
    });
  });
});

describe("password reset (#54)", () => {
  const fay = person("fay");
  const newPassword = "Fake-fay-new-password-2";
  it("a reset link comes through the fake, sets a new password, works once, and the old password stops working", async () => {
    await call("sign-up/email", fay);
    await click(linkFor(fay.email, "verify"));
    const req = await call("request-password-reset", { email: fay.email, redirectTo: `${BASE}/reset` });
    expect(req.status).toBe(200);
    const link = linkFor(fay.email, "reset");
    const token = new URL(link).pathname.split("/").at(-1)!;
    expect((await call("reset-password", { newPassword, token })).status).toBe(200);
    expect((await call("sign-in/email", { email: fay.email, password: newPassword })).status).toBe(200);
    expect((await call("sign-in/email", { email: fay.email, password: fay.password })).status).toBe(401);
    expect((await call("reset-password", { newPassword: "Fake-fay-third-password-3", token })).status).toBeGreaterThanOrEqual(400);
    expect((await call("sign-in/email", { email: fay.email, password: "Fake-fay-third-password-3" })).status).toBe(401);
  });
  it("a reset ends every other session: a cookie from before the reset stops working", async () => {
    const gus = person("gus");
    await call("sign-up/email", gus);
    await click(linkFor(gus.email, "verify"));
    const [a, b] = [await call("sign-in/email", { email: gus.email, password: gus.password }), await call("sign-in/email", { email: gus.email, password: gus.password })];
    for (const r of [a, b]) expect((await call("get-session", undefined, { cookie: r.cookie })).json?.user.email).toBe(gus.email);
    await call("request-password-reset", { email: gus.email, redirectTo: `${BASE}/reset` });
    const token = new URL(linkFor(gus.email, "reset")).pathname.split("/").at(-1)!;
    expect((await call("reset-password", { newPassword: "Fake-gus-new-password-2", token })).status).toBe(200);
    for (const r of [a, b]) expect((await call("get-session", undefined, { cookie: r.cookie })).json).toBeNull();
    expect(await count("select 1 from candidate_session s join candidate_user u on u.id=s.user_id where u.email=$1", [gus.email])).toBe(0);
    expect((await call("sign-in/email", { email: gus.email, password: "Fake-gus-new-password-2" })).status).toBe(200);
  });
  it("a made-up reset token and a too-short new password change nothing", async () => {
    expect((await call("reset-password", { newPassword, token: "made-up" })).status).toBeGreaterThanOrEqual(400);
    await call("request-password-reset", { email: fay.email, redirectTo: `${BASE}/reset` });
    const token = new URL(linkFor(fay.email, "reset")).pathname.split("/").at(-1)!;
    expect((await call("reset-password", { newPassword: "short", token })).status).toBe(400);
  });
  it("an unknown address looks the same as a known one and sends nothing; reset requests are limited to 3 in five minutes", async () => {
    const known = await call("request-password-reset", { email: fay.email, redirectTo: `${BASE}/reset` });
    const unknown = await call("request-password-reset", { email: "fake.nobody@example.test", redirectTo: `${BASE}/reset` });
    expect([unknown.status, unknown.json]).toEqual([known.status, known.json]);
    expect(mail().some((m) => m.to === "fake.nobody@example.test")).toBe(false);
    const ip = freshIp(), seq = [];
    for (let i = 0; i < 4; i++) seq.push((await call("request-password-reset", { email: `fake.ip${i}@example.test`, redirectTo: `${BASE}/reset` }, { ip })).status);
    expect(seq).toEqual([200, 200, 200, 429]);
  });
});

// The origin, CSRF and redirect-address checks run in tests exactly as in production (advanced.disableOriginCheck is false; Better Auth's
// own default would switch them off under NODE_ENV=test, so no test would ever see them).
describe("origin and redirect-address checks (review finding 2)", () => {
  const evil = "https://evil.example.test";
  const foreign = [`${evil}/steal`, "//evil.example.test/steal", "/\\evil.example.test", "javascript:alert(1)", "https://localhost.evil.example.test/", "http://localhost:3000@evil.example.test/", "http://localhost:3001/other-app"];
  const hal = person("hal");
  let cookie: string;
  it("sets up a confirmed, signed-in candidate", async () => {
    await call("sign-up/email", hal);
    await click(linkFor(hal.email, "verify"));
    cookie = (await call("sign-in/email", { email: hal.email, password: hal.password })).cookie;
    expect((await call("get-session", undefined, { cookie })).json?.user.email).toBe(hal.email);
  });
  it("a request that carries the session cookie from a foreign origin is refused, and our own origin still works", async () => {
    for (const origin of [evil, "http://localhost:3001", "null"]) {
      const r = await call("sign-out", {}, { cookie, origin });
      expect([r.status, r.json?.code], origin).toEqual([403, origin === "null" ? "MISSING_OR_NULL_ORIGIN" : "INVALID_ORIGIN"]);
    }
    expect((await call("get-session", undefined, { cookie })).json?.user.email).toBe(hal.email);
    expect((await call("sign-out", {}, { cookie })).status).toBe(200);
    expect((await call("get-session", undefined, { cookie })).json).toBeNull();
  });
  it("a foreign callbackURL is refused on sign-up, sign-in, resend and verify; nothing is made or sent", async () => {
    const sent = mail().length, accounts = await users("fake.cb@example.test");
    for (const bad of foreign) {
      const up = await call("sign-up/email", { ...person("cb"), callbackURL: bad });
      expect([up.status, up.json?.code], bad).toEqual([403, "INVALID_CALLBACK_URL"]);
      expect((await call("sign-in/email", { email: hal.email, password: hal.password, callbackURL: bad })).status, bad).toBe(403);
      expect((await call("send-verification-email", { email: hal.email, callbackURL: bad })).status, bad).toBe(403);
    }
    expect(await users("fake.cb@example.test")).toBe(accounts);
    expect(mail().length).toBe(sent);
  });
  it("a foreign redirectTo is refused on a reset request, and no email is sent", async () => {
    const sent = mail().length;
    for (const bad of foreign) {
      const r = await call("request-password-reset", { email: hal.email, redirectTo: bad });
      expect([r.status, r.json?.code], bad).toEqual([403, "INVALID_REDIRECT_URL"]);
    }
    expect(mail().length).toBe(sent);
  });
  it("a verify link with a foreign callbackURL does not confirm the address", async () => {
    const ivy = person("ivy");
    await call("sign-up/email", ivy);
    const token = new URL(linkFor(ivy.email, "verify")).searchParams.get("token")!;
    for (const bad of foreign) expect((await call(`verify-email?token=${token}&callbackURL=${encodeURIComponent(bad)}`)).status, bad).toBe(403);
    expect((await su.query("select email_verified from candidate_user where email=$1", [ivy.email])).rows[0].email_verified).toBe(false);
  });
  it("our own address still works, relative or absolute", async () => {
    const jan = person("jan");
    expect((await call("sign-up/email", { ...jan, callbackURL: `${BASE}/welcome` })).status).toBe(200);
    expect((await call("sign-in/email", { email: hal.email, password: hal.password, callbackURL: "/welcome" })).status).toBe(200);
    expect((await call("request-password-reset", { email: hal.email, redirectTo: `${BASE}/reset` })).status).toBe(200);
    expect((await call("send-verification-email", { email: jan.email, callbackURL: "/welcome" })).status).toBe(200);
    const token = new URL(linkFor(jan.email, "verify")).searchParams.get("token")!;
    expect((await call(`verify-email?token=${token}&callbackURL=${encodeURIComponent("/welcome")}`)).status).toBe(302);
    expect((await su.query("select email_verified from candidate_user where email=$1", [jan.email])).rows[0].email_verified).toBe(true);
  });
});

describe("placeholder wording command when another text exists (review finding 7)", () => {
  it("stops, writes nothing and says why, so the placeholder can never become the newest text", async () => {
    const other = await createTestDb();
    try {
      const su2 = other.pool("postgres");
      await seedSignupTerms(su2); // the solicitor's text stands in here: version 'test', saved first
      const before = [await su2.query("select version from consent_text where purpose='signup_terms'"), await su2.query("select id from approval_request")].map((r) => r.rows);
      const r = spawnSync(process.execPath, [CLI, "terms-proposer", "terms-confirmer"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(other.name, "app_admin"), DATABASE_SSL: "disable" } });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/stopped: a sign-up text is already saved/);
      const after = [await su2.query("select version from consent_text where purpose='signup_terms'"), await su2.query("select id from approval_request")].map((x) => x.rows);
      expect(after).toEqual(before);
      expect(after[0]).toEqual([{ version: "test" }]);
    } finally { await other.drop(); }
  });
});
