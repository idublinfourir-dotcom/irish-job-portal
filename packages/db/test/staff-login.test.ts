// Step 7 slice 1 (#169 to #172): the admin app's staff login, end to end on the test database. The owner's seed command runs as a
// child process with the password piped in; sign-in goes through the real route handler of apps/admin with a Request; every
// session is read by the real requireStaff. The admin app connects as app_admin. Email is a refusing fake. Fake people only.
// The steps share state (cookies, ids), so they run in order.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, mail, makeAuth, seedSignupTerms } from "./better-auth-helper";

// Statements measured on 11 November 2026: requireStaff is one getSession (session by token, user by id; the user row carries
// status, so the active check is free), plus 1 when the session row is refreshed. Sign-in reads the rate limit, the user, the
// account, runs the hook, writes the session and the rate limit: 8 on the instance's first request, which includes Better Auth's
// one-off column list read. Raise these only on purpose.
const BUDGET = { requireStaff: 2, refresh: 3, signIn: 8 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const CLI = fileURLToPath(new URL("../src/staff-seed-cli.ts", import.meta.url));
const secret = "trial-only-secret-trial-only-secret-32"; // the helper's, so a candidate cookie is validly signed for the swap test
let db: TestDb, su: pg.Pool;
let POST: (r: Request) => Promise<Response>, requireStaff: (h: Headers) => Promise<string>, StaffRefused: new (...a: never[]) => Error;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: "http://localhost:3002", STAFF_AUTH_SECRET: secret });
  ({ POST } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
  ({ requireStaff } = await import("../../../apps/admin/lib/staff"));
  ({ StaffRefused } = await import("../../auth/src"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const seed = (args: string[], password: string, role = "postgres") =>
  spawnSync(process.execPath, [CLI, ...args], { input: `${password}\n`, encoding: "utf8", env: { ...process.env, DATABASE_URL_MIGRATE: urlFor(db.name, role), DATABASE_SSL: "disable" } });
const counts = async () =>
  (await su.query("select (select count(*) from staff_user)::int u, (select count(*) from staff_account)::int a, (select count(*) from staff_role)::int r, (select count(*) from audit_event where action='staff.seed')::int e")).rows[0];

let ipn = 10;
const freshIp = () => `198.51.100.${ipn++}`;
async function call(path: string, body: unknown, ip = freshIp(), cookie?: string) {
  const res = await POST(new Request(`http://localhost:3002/api/auth/staff/${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost:3002", "x-vercel-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
  }));
  return { status: res.status, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const refusal = (h: Headers) => requireStaff(h).then(() => "accepted", (e) => (e instanceof StaffRefused ? e.message : `other: ${e}`));
// Counts every statement any pg client in this process sends while fn runs.
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}

const owner = { email: "fake.owner@example.test", pw: "Fake-owner-password-1" };
const other = { email: "fake.leaver@example.test", pw: "Fake-leaver-password-2" };
let ownerId: string, cookie: string;

describe("owner seed command (#170)", () => {
  it("is refused when run as app_admin or any other app role, and writes nothing", async () => {
    for (const role of ["app_admin", "app_candidate", "app_portal", "app_fetcher"]) {
      const r = seed([owner.email, "Fake Owner", "administrator"], owner.pw, role);
      expect(r.status, `${role}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, role).toMatch(/only as the database owner/);
    }
    expect(await counts()).toEqual({ u: 0, a: 0, r: 0, e: 0 });
  });
  it("refuses a weak password, an odd email, an unknown role and a long name before it connects", async () => {
    expect(seed([owner.email, "Fake Owner", "administrator"], "short-pw").stdout).toMatch(/at least 12/);
    expect(seed(["fake.owner@example.test'; drop table staff_user;--", "Fake", "administrator"], owner.pw).stdout).toMatch(/email/);
    expect(seed([owner.email, "Fake Owner", "administrator,superuser"], owner.pw).stdout).toMatch(/unknown role/);
    expect(seed([owner.email, "x".repeat(10000), "administrator"], owner.pw).stdout).toMatch(/name/);
    expect(await counts()).toEqual({ u: 0, a: 0, r: 0, e: 0 });
  });
  it("makes one staff login as the owner: user, credential account, roles seeded by the owner, one audit row; the password is never printed", async () => {
    const r = seed(["Fake.Owner@Example.TEST", "Fake Owner", "administrator,fetched_job_reviewer"], owner.pw);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(owner.pw);
    const u = (await su.query("select id, email, status, email_verified from staff_user")).rows[0];
    ownerId = u.id;
    expect(u).toMatchObject({ email: owner.email, status: "active", email_verified: true });
    const a = (await su.query("select provider_id, account_id, password from staff_account where user_id=$1", [ownerId])).rows[0];
    expect(a.provider_id).toBe("credential");
    expect(a.account_id).toBe(ownerId);
    expect(a.password).not.toContain(owner.pw);
    expect((await su.query("select role, seeded_by_owner from staff_role where staff_user_id=$1 order by role", [ownerId])).rows)
      .toEqual([{ role: "administrator", seeded_by_owner: true }, { role: "fetched_job_reviewer", seeded_by_owner: true }]);
    const e = (await su.query("select kind, actor_system, object_id, after, source from audit_event where action='staff.seed'")).rows;
    expect(e).toEqual([{ kind: "admin_action", actor_system: "staff-seed-cli by postgres", object_id: ownerId, after: { roles: ["administrator", "fetched_job_reviewer"] }, source: "scheduled_job" }]);
  });
  it("is safe to run twice: the second run (same email, any case) is refused and writes nothing", async () => {
    const before = await counts();
    const r = seed(["FAKE.OWNER@example.test", "Someone Else", "content_editor"], "Another-password-123");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/already exists; nothing was written/);
    expect(await counts()).toEqual(before);
  });
  it("hostile but valid text is stored as text: an SQL-looking name", async () => {
    const r = seed([other.email, "Robert'); drop table staff_user;--", "content_editor"], other.pw);
    expect(r.status, r.stdout).toBe(0);
    expect((await su.query("select name from staff_user where email=$1", [other.email])).rows[0].name).toBe("Robert'); drop table staff_user;--");
  });
});

describe("staff sign-in through the admin route and requireStaff (#169, #171)", () => {
  it("the seeded password signs in through the real route handler; requireStaff returns the staff id", async () => {
    const [r, n] = await counted(() => call("sign-in/email", { email: owner.email, password: owner.pw }));
    expect(r.status).toBe(200);
    expect(n, `sign-in sent ${n} statements`).toBeLessThanOrEqual(BUDGET.signIn);
    cookie = r.cookie;
    expect(cookie).toMatch(/^staff\.session_token=/);
    expect(await requireStaff(new Headers({ cookie }))).toBe(ownerId);
  });
  it("requireStaff costs at most 2 statements on a signed-in request", async () => {
    const [id, n] = await counted(() => requireStaff(new Headers({ cookie })));
    expect(id).toBe(ownerId);
    expect(n, `${n} statements`).toBeLessThanOrEqual(BUDGET.requireStaff);
  });
  it("no cookie, a made-up cookie and a signed-out session are refused", async () => {
    expect(await refusal(new Headers())).toBe("no_session");
    expect(await refusal(new Headers({ cookie: "staff.session_token=made-up.value" }))).toBe("no_session");
    const s = await call("sign-in/email", { email: owner.email, password: owner.pw });
    await call("sign-out", {}, freshIp(), s.cookie);
    expect(await refusal(new Headers({ cookie: s.cookie }))).toBe("no_session");
  });
  it("a walk-in sign-up through the route is refused and makes no row", async () => {
    const r = await call("sign-up/email", { email: "walk.in@example.test", password: "Walk-in-password-123", name: "Stranger" });
    expect(r.status).toBe(400);
    expect((await su.query("select count(*)::int n from staff_user where email='walk.in@example.test'")).rows[0].n).toBe(0);
  });
  it("a staff password reset sends nothing: the refusing sender throws, and the answer is Better Auth's usual 200 (it never says if an address exists)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await call("request-password-reset", { email: owner.email, redirectTo: "http://localhost:3002/reset" });
      expect(r.status).toBe(200);
      await vi.waitFor(() => expect(logged.mock.calls.flat().join(" ")).toMatch(/not set up for the staff pool/));
    } finally { logged.mockRestore(); }
  });
  it("wrong password: 401, then the rate limit: 5 tries a minute from one address, then 429", async () => {
    const ip = freshIp(), seq = [];
    for (let i = 0; i < 7; i++) seq.push((await call("sign-in/email", { email: owner.email, password: "Wrong-password-123456" }, ip)).status);
    expect(seq).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // even the right password is held back from that address
    expect((await call("sign-in/email", { email: owner.email, password: owner.pw }, ip)).status).toBe(429);
  });
  it("a candidate or portal cookie is no staff session, even renamed to the staff cookie", async () => {
    await seedSignupTerms(su); // candidate sign-up needs a saved signup_terms text (made here, after the seed-count tests)
    for (const [pool, role] of [["candidate", "app_candidate"], ["portal", "app_portal"]] as const) {
      const auth = makeAuth(pool, db.pool(role));
      const go = async (path: string, body?: unknown) => {
        const res = await auth.handler(new Request(`http://localhost:3000/api/auth/${pool}/${path}`, {
          method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
          headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": freshIp() } }));
        return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      };
      const email = `fake.${pool}@example.test`, password = `Fake-${pool}-password-1`;
      await go("sign-up/email", { email, password, name: "Fake", ...(pool === "candidate" ? answers : {}) });
      await go(`verify-email?${new URL(mail.filter((m) => m.pool === pool && m.email === email).at(-1)!.url).searchParams}`);
      const c = await go("sign-in/email", { email, password });
      expect(c, pool).toMatch(new RegExp(`^${pool}\\.session_token=`));
      expect(await refusal(new Headers({ cookie: c })), pool).toBe("no_session");
      expect(await refusal(new Headers({ cookie: c.replace(`${pool}.session_token`, "staff.session_token") })), pool).toBe("no_session");
    }
  });
  it("a disabled staff member's open session is refused at once, even with the session row still there", async () => {
    const s = await call("sign-in/email", { email: other.email, password: other.pw });
    const id = await requireStaff(new Headers({ cookie: s.cookie }));
    await db.query("app_admin", "update staff_user set status='disabled' where id=$1", [id]);
    expect((await su.query("select count(*)::int n from staff_session where user_id=$1", [id])).rows[0].n).toBeGreaterThan(0);
    expect(await refusal(new Headers({ cookie: s.cookie }))).toBe("not_active");
    expect((await call("sign-in/email", { email: other.email, password: other.pw })).status).toBe(403);
  });
});

describe("staff idle limit: 8 hours without use (#172)", () => {
  const expiry = async (c: string) => {
    const token = decodeURIComponent(c.split("=")[1]!).split(".")[0];
    return (await su.query("select expires_at from staff_session where token=$1", [token])).rows[0]?.expires_at as Date | undefined;
  };
  const hours = (d: Date | undefined) => ((d?.getTime() ?? 0) - Date.now()) / 36e5;
  const setExpiry = (c: string, sql: string) => su.query(`update staff_session set expires_at = ${sql} where token=$1`, [decodeURIComponent(c.split("=")[1]!).split(".")[0]]);

  it("a new staff session ends 8 hours from sign-in", async () => {
    expect(hours(await expiry(cookie))).toBeGreaterThan(7.9);
    expect(hours(await expiry(cookie))).toBeLessThanOrEqual(8);
  });
  it("rememberMe: false cannot stretch it to Better Auth's 1 day", async () => {
    const s = await call("sign-in/email", { email: owner.email, password: owner.pw, rememberMe: false });
    expect(s.status).toBe(200);
    expect(hours(await expiry(s.cookie))).toBeLessThanOrEqual(8);
  });
  it("use keeps it alive: a session last refreshed 10 minutes ago is moved out to 8 hours from now", async () => {
    await setExpiry(cookie, "now() + interval '7 hours 50 minutes'");
    const [id, n] = await counted(() => requireStaff(new Headers({ cookie })));
    expect(id).toBe(ownerId);
    expect(n).toBeLessThanOrEqual(BUDGET.refresh);
    expect(hours(await expiry(cookie))).toBeGreaterThan(7.99);
  });
  it("8 idle hours end it: the session is refused once its end has passed", async () => {
    await setExpiry(cookie, "now() - interval '1 second'");
    expect(await refusal(new Headers({ cookie }))).toBe("no_session");
  });
});
