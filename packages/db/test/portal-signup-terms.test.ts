// Step 7 slice 4 (#188, #194): employer and agency sign-up records the tick for their own terms text (purpose portal_signup_terms).
// Everything runs on the test database: the real route handler of apps/portal (connected as app_portal), the real terms command (as
// app_admin) and the migration 0012 approval rule. Email is the fake sender, nothing touches the network. Fake people only.
// The steps share state (texts, ids), so they run in order.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { createAuth, writeConsent } from "../../auth/src";
import { answers as candidateAnswers, seedSignupTerms } from "./better-auth-helper";

// Measured on 12 November 2026, counting every pg.Client.query call (begin and commit included): a portal sign-up with the tick (account,
// consent row, rate limit) sends 10 statements on the first request of an instance (which includes Better Auth's one-off column list read),
// the same as a candidate sign-up; budget 11. Time: median of 9 sign-ups was 73, 75 and 85 ms over three runs; budget 350 ms, about 4 times
// the slowest median (hashing the password dominates). Raise these only on purpose.
const BUDGET = { signUp: 11, signUpMedianMs: 350 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const CLI = fileURLToPath(new URL("../src/signup-terms-cli.ts", import.meta.url));
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
const tick = { acceptsTerms: true } as const;
let db: TestDb, su: pg.Pool;
let POST: (r: Request) => Promise<Response>;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let ipn = 10;
const freshIp = () => `198.51.100.${ipn++}`;
async function signUp(body: unknown, o: { raw?: string } = {}) {
  const res = await POST(new Request(`${BASE}/api/auth/portal/sign-up/email`, {
    method: "POST", body: o.raw ?? JSON.stringify(body), redirect: "manual",
    headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() },
  }));
  const text = await res.text();
  let json: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
const person = (n: string) => ({ email: `fake.${n}@example.test`, password: `Fake-${n}-password-1`, name: `Fake ${n}` });
const count = async (sql: string, args: unknown[] = []) => (await su.query(`select count(*)::int n from (${sql}) t`, args)).rows[0].n as number;
const logins = (email: string) => count("select 1 from portal_user where email=$1", [email]);
// nothing of a refused sign-up may remain: no login, no account row, no consent row
const everything = () => count("select id from portal_user union all select id from portal_account union all select id::text from consent_record");

const cli = (args: string[], role = "app_admin") =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" } });
const texts = (purpose: string) => count("select 1 from consent_text where purpose=$1", [purpose]);
const requests = () => count("select 1 from approval_request");
async function staff(role: string) {
  const id = `st-${Math.random().toString(36).slice(2, 10)}`;
  await su.query("insert into staff_user(id,name,email,email_verified) values($1,'Fake Staff',$2,true)", [id, `${id}@example.test`]);
  await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [id, role]);
  return id;
}
// One transaction as app_admin, acting as the given staff member.
async function asAdmin<T>(who: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.pool("app_admin").connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.staff_user_id', $1, true)", [who]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}
const request = (c: pg.PoolClient, target: string) =>
  c.query("insert into approval_request(kind, target_table, target_id, reason) values ('terms_privacy_page','consent_text',$1,'test') returning id", [target]).then((r) => r.rows[0].id as string);
const addText = (c: pg.PoolClient, purpose: string, version: string, approval: string | null) =>
  c.query("insert into consent_text(purpose, version, body, approval_request_id) values ($1,$2,'Fake wording',$3)", [purpose, version, approval]);

let a: string, b: string, writer: string;
beforeAll(async () => { a = await staff("content_editor"); b = await staff("administrator"); writer = await staff("content_editor"); });

describe("migration 0012: the approval rule covers portal_signup_terms (#194)", () => {
  it("refuses a portal_signup_terms text with no approval request, with a request for another target, and with a pending one", async () => {
    const refused = (fn: (c: pg.PoolClient) => Promise<unknown>) => asAdmin(a, fn).then(() => "accepted", (e) => (e as Error).message);
    expect(await refused((c) => addText(c, "portal_signup_terms", "v-none", null))).toMatch(/two-person/);
    expect(await refused(async (c) => addText(c, "portal_signup_terms", "v-wrong", await request(c, "portal_signup_terms:other-version")))).toMatch(/two-person/);
    expect(await refused(async (c) => addText(c, "portal_signup_terms", "v-pending", await request(c, "portal_signup_terms:v-pending")))).toMatch(/two-person/);
    expect(await texts("portal_signup_terms")).toBe(0);
  });
  it("refuses a request that names the other purpose, and a confirmed request for the wrong kind", async () => {
    const id = await asAdmin(a, (c) => request(c, "signup_terms:v-cross"));
    await asAdmin(b, (c) => c.query("update approval_request set status='confirmed' where id=$1", [id]));
    expect(await asAdmin(a, (c) => addText(c, "portal_signup_terms", "v-cross", id)).then(() => "accepted", (e) => (e as Error).message)).toMatch(/two-person/);
    expect(await texts("portal_signup_terms")).toBe(0);
  });
  it("one person cannot propose and confirm", async () => {
    const id = await asAdmin(a, (c) => request(c, "portal_signup_terms:v-same"));
    const r = await asAdmin(a, (c) => c.query("update approval_request set status='confirmed' where id=$1", [id])).then(() => "accepted", (e) => (e as Error).message);
    expect(r).not.toBe("accepted");
    expect(await asAdmin(a, (c) => addText(c, "portal_signup_terms", "v-same", id)).then(() => "accepted", (e) => (e as Error).message)).toMatch(/two-person/);
    // a confirmer who is not an administrator is refused as well
    const id2 = await asAdmin(a, (c) => request(c, "portal_signup_terms:v-writer"));
    expect(await asAdmin(writer, (c) => c.query("update approval_request set status='confirmed' where id=$1", [id2])).then(() => "accepted", (e) => (e as Error).message)).toMatch(/confirmer does not hold the role/);
    expect(await texts("portal_signup_terms")).toBe(0);
  });
  it("accepts a confirmed request once, and refuses to use it a second time", async () => {
    const id = await asAdmin(a, (c) => request(c, "portal_signup_terms:v-good"));
    await asAdmin(b, (c) => c.query("update approval_request set status='confirmed' where id=$1", [id]));
    await asAdmin(a, (c) => addText(c, "portal_signup_terms", "v-good", id));
    expect(await texts("portal_signup_terms")).toBe(1);
    await su.query("delete from consent_text where purpose='portal_signup_terms'"); // the owner clears the text; the used request stays used
    expect(await asAdmin(a, (c) => addText(c, "portal_signup_terms", "v-good", id)).then(() => "accepted", (e) => (e as Error).message)).toMatch(/already used/);
    expect(await texts("portal_signup_terms")).toBe(0);
  });
  it("the other purposes' rules are unchanged: a text of another purpose may not carry a request, signup_terms still needs one", async () => {
    const id = await asAdmin(a, (c) => request(c, "visibility:v"));
    await asAdmin(b, (c) => c.query("update approval_request set status='confirmed' where id=$1", [id]));
    expect(await asAdmin(a, (c) => addText(c, "visibility", "v", id)).then(() => "accepted", (e) => (e as Error).message)).toMatch(/consent_text_check/);
    expect(await asAdmin(a, (c) => addText(c, "signup_terms", "v-none", null)).then(() => "accepted", (e) => (e as Error).message)).toMatch(/two-person/);
  });
});

describe("portal sign-up before the employer and agency wording exists", () => {
  it("is refused cleanly (503), even though a candidate text exists, and makes no login", async () => {
    await seedSignupTerms(su); // the candidate text: the portal must not use it
    const r = await signUp({ ...person("early"), ...tick });
    expect(r.status).toBe(503);
    expect(r.json?.code).toBe("SIGNUP_TERMS_MISSING");
    expect(await everything()).toBe(0);
  });
  it("gives a missing tick the same refusal as it will later (400 SIGNUP_ANSWERS_REFUSED), text or no text", async () => {
    const r = await signUp(person("early2"));
    expect([r.status, r.json?.code]).toEqual([400, "SIGNUP_ANSWERS_REFUSED"]);
    expect(await everything()).toBe(0);
  });
});

describe("the terms command with --portal (#194)", () => {
  it("is refused for every other login, and writes nothing", async () => {
    const before = await requests();
    for (const role of ["app_candidate", "app_portal", "app_fetcher"]) {
      const r = cli(["--portal", a, b], role);
      expect(r.status, `${role}: ${r.stdout}`).toBe(1);
      expect(r.stdout, role).toMatch(/refused/);
    }
    expect([await texts("portal_signup_terms"), await requests()]).toEqual([0, before]);
  });
  it("is refused when the confirmer is not an administrator, and rolls back", async () => {
    const before = await requests();
    expect(cli(["--portal", a, writer]).stdout).toMatch(/refused: .*confirmer does not hold the role/);
    expect([await texts("portal_signup_terms"), await requests()]).toEqual([0, before]);
  });
  it("saves the portal placeholder through a two-person request, and leaves the candidate text alone", async () => {
    const before = await requests();
    const r = cli(["--portal", a, b]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/saved the placeholder employer and agency sign-up text/);
    const rows = (await su.query(
      `select t.version, t.body, q.kind, q.target_id, q.status, q.proposed_by_staff_user_id p, q.confirmed_by_staff_user_id c, q.applied_at is not null used
         from consent_text t join approval_request q on q.id = t.approval_request_id where t.purpose='portal_signup_terms'`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: "placeholder-2026-11-12", kind: "terms_privacy_page", target_id: "portal_signup_terms:placeholder-2026-11-12", status: "confirmed", p: a, c: b, used: true });
    expect(rows[0].body).toMatch(/^PLACEHOLDER TEXT.*employer and agency/);
    expect(await requests()).toBe(before + 1);
    expect((await su.query("select version from consent_text where purpose='signup_terms'")).rows).toEqual([{ version: "test" }]);
  });
  it("is safe to run twice: the second run writes nothing", async () => {
    const before = await requests();
    const r = cli(["--portal", a, b]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already there; nothing was written/);
    expect([await texts("portal_signup_terms"), await requests()]).toEqual([1, before]);
  });
  it("without the flag it still works on the candidate purpose only: the candidate text is another one, so it stops", async () => {
    const r = cli([a, b]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/stopped: a sign-up text is already saved/);
    expect([await texts("signup_terms"), await texts("portal_signup_terms")]).toEqual([1, 1]);
  });
  it("stops when another portal text exists, and writes nothing", async () => {
    await su.query("delete from consent_text where purpose='portal_signup_terms'"); // the owner clears the placeholder, then a solicitor's text goes in
    const id = await asAdmin(a, (c) => request(c, "portal_signup_terms:solicitor-2"));
    await asAdmin(b, (c) => c.query("update approval_request set status='confirmed' where id=$1", [id]));
    await asAdmin(a, (c) => addText(c, "portal_signup_terms", "solicitor-2", id));
    const before = await requests();
    const r = cli(["--portal", a, b]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/stopped: an employer and agency sign-up text is already saved/);
    expect([await texts("portal_signup_terms"), await requests()]).toEqual([1, before]);
    await su.query("delete from consent_text where purpose='portal_signup_terms'");
    expect(cli(["--portal", a, b]).status).toBe(0); // the placeholder goes back in for the sign-up steps below
  });
});

describe("portal sign-up with the tick (#188, #194)", () => {
  const ann = person("ann");
  it("makes the login and exactly one consent row together, on the newest portal text and never the candidate text", async () => {
    const [r, n] = await counted(() => signUp({ ...ann, ...tick }));
    expect(r.status, r.text).toBe(200);
    expect(n, `portal sign-up sent ${n} statements`).toBeLessThanOrEqual(BUDGET.signUp);
    const rows = (await su.query(
      `select c.details, c.given_at, c.withdrawn_at, c.candidate_user_id, c.organisation_id, c.job_id, t.purpose, t.version, u.email_verified
         from consent_record c join consent_text t on t.id = c.consent_text_id join portal_user u on u.id = c.portal_user_id where u.email=$1`, [ann.email])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ details: tick, purpose: "portal_signup_terms", version: "placeholder-2026-11-12", withdrawn_at: null, candidate_user_id: null, organisation_id: null, job_id: null, email_verified: false });
    expect(Math.abs(rows[0].given_at.getTime() - Date.now())).toBeLessThan(10000);
  });
  it("points at the newest portal text once a newer one is published", async () => {
    const id = await asAdmin(a, (c) => request(c, "portal_signup_terms:solicitor-1"));
    await asAdmin(b, (c) => c.query("update approval_request set status='confirmed' where id=$1", [id]));
    await asAdmin(a, (c) => addText(c, "portal_signup_terms", "solicitor-1", id));
    const bob = person("bob");
    expect((await signUp({ ...bob, ...tick })).status).toBe(200);
    expect((await su.query("select t.version from consent_record c join consent_text t on t.id=c.consent_text_id join portal_user u on u.id=c.portal_user_id where u.email=$1", [bob.email])).rows).toEqual([{ version: "solicitor-1" }]);
  });
  it("sign-up stays inside its time budget (median of 9)", async () => {
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t = performance.now();
      expect((await signUp({ ...person(`speed${i}`), ...tick })).status).toBe(200);
      ms.push(performance.now() - t);
    }
    ms.sort((x, y) => x - y);
    expect(ms[4], `median ${ms[4]!.toFixed(0)} ms`).toBeLessThan(BUDGET.signUpMedianMs);
  });

  it("refuses every tick that is not the plain value true, with no login, account or consent row made", async () => {
    const before = await everything();
    const bad: unknown[] = [false, undefined, null, "true", "yes", "on", 1, 0, [true], [], {}, { value: true }, { $ne: null }, "'; drop table portal_user;--", "x".repeat(200000), { a: { a: { a: { a: { a: { a: true } } } } } }];
    for (const [i, v] of bad.entries()) {
      const p = person(`bad${i}`);
      const r = await signUp({ ...p, acceptsTerms: v });
      expect([r.status, r.json?.code], JSON.stringify(v)?.slice(0, 30)).toEqual([400, "SIGNUP_ANSWERS_REFUSED"]);
      expect(await logins(p.email)).toBe(0);
    }
    expect(await everything()).toBe(before);
  });
  it("refuses a body with no tick, a list body, a text body and nothing at all", async () => {
    const before = await everything();
    expect((await signUp(person("none"))).json?.code).toBe("SIGNUP_ANSWERS_REFUSED");
    expect((await signUp(undefined, { raw: JSON.stringify([{ ...person("list"), ...tick }]) })).status).toBe(400);
    expect((await signUp(undefined, { raw: "not json" })).status).toBeGreaterThanOrEqual(400);
    expect((await signUp(undefined, { raw: "" })).status).toBeGreaterThanOrEqual(400);
    expect(await everything()).toBe(before);
  });
  it("the candidate answers do not stand in for the tick, and extra candidate answers are ignored", async () => {
    expect((await signUp({ ...person("cand1"), needsPermit: true, over18: true })).json?.code).toBe("SIGNUP_ANSWERS_REFUSED");
    const p = person("cand2");
    expect((await signUp({ ...p, ...candidateAnswers })).status).toBe(200);
    expect((await su.query("select c.details from consent_record c join portal_user u on u.id=c.portal_user_id where u.email=$1", [p.email])).rows).toEqual([{ details: tick }]);
  });
  it("a refusal is the same whether or not the email already has a login", async () => {
    const p = person("dup");
    expect((await signUp({ ...p, ...tick })).status).toBe(200);
    const [fresh, taken] = [await signUp({ ...person("dupnew"), password: p.password, name: p.name }), await signUp({ email: p.email, password: p.password, name: p.name })];
    expect([taken.status, taken.json?.code]).toEqual([fresh.status, fresh.json?.code]);
    expect(taken.json?.code).toBe("SIGNUP_ANSWERS_REFUSED");
    // with the tick, an existing email makes no second consent row
    const rows = await count("select 1 from consent_record c join portal_user u on u.id=c.portal_user_id where u.email=$1", [p.email]);
    await signUp({ ...p, ...tick });
    expect(await count("select 1 from consent_record c join portal_user u on u.id=c.portal_user_id where u.email=$1", [p.email])).toBe(rows);
  });
  it("ignores a text id, a user id, an organisation, a job, a time or a status sent by the client: only the server sets them", async () => {
    const p = { ...person("sneaky"), ...tick, consentTextId: 999, consent_text_id: 999, portalUserId: "someone-else", portal_user_id: "someone-else", candidateUserId: "x", organisationId: 1, organisation_id: 1, jobId: 1, givenAt: "2001-01-01", given_at: "2001-01-01", withdrawnAt: "2001-01-01", details: { acceptsTerms: false }, emailVerified: true, status: "blocked" };
    expect((await signUp(p)).status).toBe(200);
    const r = (await su.query(
      `select c.consent_text_id::text t, c.portal_user_id u, c.organisation_id, c.job_id, c.candidate_user_id, c.given_at, c.withdrawn_at, c.details, x.id, x.email_verified, x.status
         from consent_record c join portal_user x on x.id = c.portal_user_id where x.email=$1`, [p.email])).rows;
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe((await su.query("select id::text from consent_text where purpose='portal_signup_terms' order by published_at desc, id desc limit 1")).rows[0].id);
    expect(r[0]).toMatchObject({ u: r[0].id, organisation_id: null, job_id: null, candidate_user_id: null, withdrawn_at: null, details: tick, email_verified: false, status: "active" });
    expect(r[0].given_at.getFullYear()).toBeGreaterThan(2020);
  });
  it("an SQL-looking name is stored as plain text", async () => {
    const p = { ...person("sql"), ...tick, name: "Robert'); drop table portal_user;--" };
    expect((await signUp(p)).status).toBe(200);
    expect((await su.query("select name from portal_user where email=$1", [p.email])).rows[0].name).toBe(p.name);
  });
  it("refuses an empty, blank or over-long name (400 SIGNUP_NAME_REFUSED) and makes no login", async () => {
    for (const [i, name] of ["", "   ", "x".repeat(101), "x".repeat(200000)].entries()) {
      const p = { ...person(`name${i}`), ...tick, name };
      const r = await signUp(p);
      expect([r.status, r.json?.code], `name of ${name.length}`).toEqual([400, "SIGNUP_NAME_REFUSED"]);
      expect(await logins(p.email)).toBe(0);
    }
  });
  it("every portal login has exactly one consent row, whatever happened above", async () => {
    expect(await count("select 1 from portal_user u where (select count(*) from consent_record c where c.portal_user_id = u.id) <> 1")).toBe(0);
    expect(await count("select 1 from consent_record c join consent_text t on t.id = c.consent_text_id where c.portal_user_id is not null and t.purpose <> 'portal_signup_terms'")).toBe(0);
  });
});

describe("a failed consent write undoes the login; the write fails closed outside the sign-up transaction", () => {
  it("rolls back the login and the account when the consent insert fails", async () => {
    await su.query("create function public.fail_consent() returns trigger language plpgsql as $$ begin raise exception 'fake consent failure'; end $$");
    await su.query("create trigger fail_consent before insert on consent_record for each row execute function public.fail_consent()");
    try {
      const p = person("rollback");
      const before = await everything();
      const r = await signUp({ ...p, ...tick });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await logins(p.email)).toBe(0);
      expect(await everything()).toBe(before);
    } finally {
      await su.query("drop trigger fail_consent on consent_record");
      await su.query("drop function public.fail_consent()");
    }
    expect((await signUp({ ...person("after"), ...tick })).status).toBe(200); // and sign-up works again
  });
  it("writeConsent refuses to run outside a transaction", async () => {
    const auth = createAuth("portal", { database: db.pool("app_portal"), baseURL: BASE, secret, sendEmail: async () => {} });
    const adapter = (await auth.$context).adapter;
    await expect(writeConsent(adapter, "nobody", tick, "portal")).rejects.toThrow(/inside the sign-up transaction/);
  });
});

describe("candidate sign-up is unchanged", () => {
  it("still writes its signup_terms row on the candidate text, with the three answers", async () => {
    process.env.DATABASE_URL = urlFor(db.name, "app_candidate");
    const auth = createAuth("candidate", { database: db.pool("app_candidate"), baseURL: "http://localhost:3000", secret, sendEmail: async () => {} });
    const p = person("cand-ok");
    const res = await auth.handler(new Request("http://localhost:3000/api/auth/candidate/sign-up/email", {
      method: "POST", body: JSON.stringify({ ...p, ...candidateAnswers }),
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": freshIp() },
    }));
    expect(res.status).toBe(200);
    expect((await su.query(
      "select c.details, t.purpose, t.version from consent_record c join consent_text t on t.id=c.consent_text_id join candidate_user u on u.id=c.candidate_user_id where u.email=$1", [p.email])).rows)
      .toEqual([{ details: candidateAnswers, purpose: "signup_terms", version: "test" }]);
  });
});
