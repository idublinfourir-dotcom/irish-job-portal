// Integration: staff accounts from the admin panel (step 13d, #233, #234 D4 and D5) through the real /api/staff handlers, real staff sessions, the real test database
// as app_admin. An administrator proposes a role and a different one confirms; one administrator removes a role or disables a login at once; the last active
// administrator cannot be removed or disabled; a disabled login's open sessions are gone. Every other role is tried on every action. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STAFF_ROLE_LIST, STAFF_LIST } from "../src/staff-admin";
import { STAFF_ROLES } from "../src/staff-seed-cli";
import { createTestDb, type TestDb } from "./db";
import { BASE, counted, median, PW, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";
import { assertPageBudget, measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Measured on 13 November 2026, statements counted on every pg.Client.query call (requireStaff is 2 of each): list = role check + staff + pending (5);
// propose = begin, role check, target, set acting id, insert request, audit, commit (9); confirm = begin, role check, lock request, target, set acting id,
// confirm, insert role, audit, commit (11); disable = begin, role check, lock admins, count admins, update, delete sessions, audit, commit (10).
// Times are medians of 9 warm calls through the route; limits are about 4 times the slowest of three runs, with a floor for a busy laptop.
// Medians measured 1.8 to 2.2 ms (list), 2.1 to 2.8 (propose), 2.7 to 4.9 (confirm), 2.4 to 3.0 (disable). Pages are 8 kB pages touched by the two staff list statements on a team of 70 logins: measured 5.
const BUDGET = { list: 5, propose: 9, confirm: 11, disable: 10, listMs: 12, proposeMs: 12, confirmMs: 20, disableMs: 12, pages: 60 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/staff", who, body, o);
const act = (who: string | null, action: string, extra: object = {}) => call(who, { action, ...extra });
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  route = await import("../../../apps/admin/app/api/staff/route");
  for (const n of ["ad1", "ad2", "ad3"]) await h.makeStaff(n, ["administrator"]);
  for (const r of ROLE_NAMES) if (r !== "administrator") await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]); // after sign-in: the open session is refused too
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const roles = async (id: string) => (await su.query("select role from staff_role where staff_user_id = $1 order by role", [id])).rows.map((r) => r.role);
const audits = (target: string) => su.query("select action, actor_staff_user_id a, second_staff_user_id s, after from audit_event where object_type = 'staff_user' and object_id = $1 and action <> 'staff.seed' order by id", [target]).then((r) => r.rows);
const requests = (target: string) => su.query("select id, kind, status, proposed_by_staff_user_id p, confirmed_by_staff_user_id c, applied_at is not null as applied, change from approval_request where target_table = 'staff_role' and target_id = $1 order by id", [target]).then((r) => r.rows);
/** A fresh login holding the given roles, signed in. */
let n = 0;
async function login(rs: string[] = ["content_editor"]) { const name = `t${n++}`; await h.makeStaff(name, rs); return name; }
const sessions = (id: string) => one("select count(*)::int n from staff_session where user_id = $1", [id]).then((r) => r.n);
/** Runs `fn` with only `keep` as the active administrators (the others disabled by the owner role, then restored). */
async function onlyAdmins<T>(keep: string[], fn: () => Promise<T>): Promise<T> {
  const others = (await su.query("select u.id from staff_user u join staff_role r on r.staff_user_id = u.id and r.role = 'administrator' where u.status = 'active' and u.id <> all($1)", [keep.map((k) => h.staff[k]!)])).rows.map((r) => r.id);
  await su.query("update staff_user set status = 'disabled' where id = any($1)", [others]);
  try { return await fn(); } finally { await su.query("update staff_user set status = 'active' where id = any($1)", [others]); }
}

describe("the role list", () => {
  it("matches the owner's command and the database check", async () => {
    expect([...STAFF_ROLE_LIST]).toEqual(STAFF_ROLES);
    expect([...ROLE_NAMES]).toEqual(STAFF_ROLES);
    const check = (await su.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'staff_role_role_check'")).rows[0].d as string;
    for (const r of STAFF_ROLES) expect(check).toContain(`'${r}'`);
  });
});

describe("access", () => {
  it("refuses a call with no session, a forged one, and a disabled login", async () => {
    await no(call(null), 401, "no_session");
    await no(call("disabled"), 401, "not_active");
    await no(act("disabled", "disable", { staffId: h.staff.ad1 }), 401, "not_active");
    await no(act(null, "disable", { staffId: h.staff.ad1 }), 401, "no_session");
    await no(call(null, { action: "disable", staffId: h.staff.ad1 }, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    expect((await one("select status from staff_user where id = $1", [h.staff.ad1])).status).toBe("active");
  });
  it("a disabled login, and one disabled just now through this route, is refused on every admin route", async () => {
    const t = await login(["administrator", "account_reviewer", "rules_data_editor", "trust_and_safety", "fetched_job_reviewer", "content_editor"]);
    const routes: [string, Route][] = [
      ["/api/staff", route], ["/api/audit", await import("../../../apps/admin/app/api/audit/route")], ["/api/content", await import("../../../apps/admin/app/api/content/route")],
      ["/api/fetched-jobs", await import("../../../apps/admin/app/api/fetched-jobs/route")], ["/api/pay-floors", await import("../../../apps/admin/app/api/pay-floors/route")],
      ["/api/account-review", await import("../../../apps/admin/app/api/account-review/route")], ["/api/trust-safety/cases", await import("../../../apps/admin/app/api/trust-safety/cases/route")],
      ["/api/trust-safety/reports", await import("../../../apps/admin/app/api/trust-safety/reports/route")],
    ];
    for (const [path, r] of routes) expect((await h.call(r, path, t)).status, path).not.toBe(401); // works while active
    await ok(act("ad1", "disable", { staffId: h.staff[t] }));
    for (const [path, r] of routes) {
      const get = await h.call(r, path, "disabled");
      expect([path, get.status, get.json.error]).toEqual([path, 401, "not_active"]);
      if (r.POST) {
        const post = await h.call(r, path, "disabled", { action: "claim", itemId: "1" });
        expect([path, post.status, post.json.error]).toEqual([path, 401, "not_active"]);
      }
      const gone = await h.call(r, path, null, undefined, { cookie: h.signedIn(t) }); // its own cookie: the session row is gone
      expect([path, gone.status, gone.json.error]).toEqual([path, 401, "no_session"]);
    }
  });
  it("refuses every other role on the list and on every action, and changes nothing", async () => {
    const t = await login(["content_editor"]);
    const before = [await one("select count(*)::int n from staff_role"), await one("select count(*)::int n from audit_event"), await one("select count(*)::int n from approval_request")];
    const bodies = [
      { action: "propose_role", staffId: h.staff[t], role: "fetched_job_reviewer" }, { action: "confirm_role", requestId: "1" }, { action: "refuse_role", requestId: "1" },
      { action: "remove_role", staffId: h.staff[t], role: "content_editor" }, { action: "disable", staffId: h.staff[t] }, { action: "enable", staffId: h.staff[t] },
    ];
    for (const who of ROLE_NAMES.filter((r) => r !== "administrator").map((r) => `only_${r}`).concat("norole")) {
      await no(call(who), 403, "not_administrator");
      for (const b of bodies) await no(call(who, b), 403, "not_administrator");
    }
    expect([await one("select count(*)::int n from staff_role"), await one("select count(*)::int n from audit_event"), await one("select count(*)::int n from approval_request")]).toEqual(before);
    expect(await roles(h.staff[t]!)).toEqual(["content_editor"]);
  });
  it("lets an administrator who also holds another role act; roles are read from the database on every call", async () => {
    const t = await login(["administrator", "content_editor"]);
    await ok(call(t));
    await su.query("delete from staff_role where staff_user_id = $1 and role = 'administrator'", [h.staff[t]]);
    await no(call(t), 403, "not_administrator");
  });
});

describe("the list", () => {
  it("shows every login with its roles and status, and the grants waiting for a second administrator", async () => {
    const t = await login(["content_editor"]);
    const p = await ok(act("ad1", "propose_role", { staffId: h.staff[t], role: "trust_and_safety" }));
    for (const who of ["ad1", "ad2"]) {
      const r = await ok(call(who));
      expect(r.truncated).toBe(false);
      expect(r.staff.find((x: { id: string }) => x.id === h.staff[t])).toMatchObject({ name: `Fake ${t}`, email: `${t}@example.test`, status: "active", roles: ["content_editor"] });
      expect(r.staff.find((x: { id: string }) => x.id === h.staff.disabled)).toMatchObject({ status: "disabled", roles: ["administrator"] });
      expect(r.pending).toContainEqual(expect.objectContaining({ requestId: p.requestId, staffId: h.staff[t], role: "trust_and_safety", proposedBy: h.staff.ad1 }));
    }
    expect(JSON.stringify(await ok(call("ad1")))).not.toMatch(/password|token|hash/i);
  });
  it("refuses a query string", async () => {
    await no(call("ad1", undefined, { query: "?x=1" }), 400, "bad_query");
  });
});

describe("a role grant: one administrator proposes, a different one confirms", () => {
  it("proposes, then a different administrator confirms: the role is written, the request used once, two audit rows", async () => {
    const t = await login(["content_editor"]);
    const p = await ok(act("ad1", "propose_role", { staffId: h.staff[t], role: "fetched_job_reviewer" }));
    expect(await roles(h.staff[t]!)).toEqual(["content_editor"]); // a proposal changes nothing
    await no(act("ad1", "confirm_role", { requestId: p.requestId }), 409, "same_person");
    const c = await ok(act("ad2", "confirm_role", { requestId: p.requestId }));
    expect(c).toEqual({ ok: true, staffId: h.staff[t], role: "fetched_job_reviewer" });
    expect(await roles(h.staff[t]!)).toEqual(["content_editor", "fetched_job_reviewer"]);
    expect(await requests(h.staff[t]!)).toEqual([{ id: p.requestId, kind: "grant_role", status: "confirmed", p: h.staff.ad1, c: h.staff.ad2, applied: true, change: { role: "fetched_job_reviewer" } }]);
    expect((await audits(h.staff[t]!)).map((a) => [a.action, a.a, a.s])).toEqual([["staff.role_propose", h.staff.ad1, null]]);
    expect((await su.query("select actor_staff_user_id a, second_staff_user_id s, after from audit_event where action = 'staff.role_grant' and after->>'approvalRequestId' = $1", [p.requestId])).rows)
      .toEqual([{ a: h.staff.ad2, s: h.staff.ad1, after: { role: "fetched_job_reviewer", approvalRequestId: p.requestId } }]);
    await no(act("ad3", "confirm_role", { requestId: p.requestId }), 409, "request_not_pending");
    expect((await one("select granted_by_staff_user_id g, approval_request_id::text r from staff_role where staff_user_id = $1 and role = 'fetched_job_reviewer'", [h.staff[t]]))).toEqual({ g: h.staff.ad2, r: p.requestId });
  });
  it("granting administrator uses the administrator kind", async () => {
    const t = await login(["content_editor"]);
    const p = await ok(act("ad1", "propose_role", { staffId: h.staff[t], role: "administrator" }));
    expect((await requests(h.staff[t]!))[0]).toMatchObject({ kind: "grant_administrator", status: "pending" });
    await ok(act("ad2", "confirm_role", { requestId: p.requestId }));
    expect(await roles(h.staff[t]!)).toEqual(["administrator", "content_editor"]);
    await ok(call(t)); // the new administrator can use the panel
  });
  it("refuses a second pending grant of the same kind for one login, a role already held, an unknown login and a login that is not active", async () => {
    const t = await login(["content_editor"]);
    await ok(act("ad1", "propose_role", { staffId: h.staff[t], role: "trust_and_safety" }));
    await no(act("ad2", "propose_role", { staffId: h.staff[t], role: "account_reviewer" }), 409, "grant_pending");
    await no(act("ad1", "propose_role", { staffId: h.staff[t], role: "trust_and_safety" }), 409, "grant_pending");
    await no(act("ad1", "propose_role", { staffId: h.staff[t], role: "content_editor" }), 409, "already_holds");
    await no(act("ad1", "propose_role", { staffId: "nobody-here", role: "content_editor" }), 404, "not_found");
    await no(act("ad1", "propose_role", { staffId: h.staff.disabled, role: "content_editor" }), 409, "target_not_active");
    expect((await requests(h.staff[t]!)).length).toBe(1);
  });
  it("a refusal by a different administrator ends it as refused, the proposer's own refusal withdraws it, and neither writes a role", async () => {
    const [a, b] = [await login(), await login()];
    const pa = await ok(act("ad1", "propose_role", { staffId: h.staff[a], role: "trust_and_safety" }));
    const pb = await ok(act("ad1", "propose_role", { staffId: h.staff[b], role: "trust_and_safety" }));
    await ok(act("ad2", "refuse_role", { requestId: pa.requestId }));
    await ok(act("ad1", "refuse_role", { requestId: pb.requestId }));
    expect((await requests(h.staff[a]!))[0]).toMatchObject({ status: "refused", c: h.staff.ad2 });
    expect((await requests(h.staff[b]!))[0]).toMatchObject({ status: "withdrawn" });
    for (const [t, req] of [[a, pa], [b, pb]] as const) {
      await no(act("ad2", "confirm_role", { requestId: req.requestId }), 409, "request_not_pending");
      expect(await roles(h.staff[t]!)).toEqual(["content_editor"]);
    }
    expect((await audits(h.staff[a]!)).map((x) => x.action)).toEqual(["staff.role_propose", "staff.role_refuse"]);
    expect((await audits(h.staff[b]!)).map((x) => x.action)).toEqual(["staff.role_propose", "staff.role_withdraw"]);
  });
  it("only a staff role request can be confirmed here, and an unknown request is 404", async () => {
    const c = await su.connect();
    let other: string;
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad1]);
      other = (await c.query("insert into approval_request(kind, target_table, target_id, change) values ('threshold','setting','x','{}') returning id::text id")).rows[0].id;
      await c.query("commit");
    } finally { c.release(); }
    for (const id of ["987654321", other]) await no(act("ad2", "confirm_role", { requestId: id }), 404, "not_found");
    for (const id of [other]) await no(act("ad2", "refuse_role", { requestId: id }), 404, "not_found");
    expect((await one("select status from approval_request where id = $1", [other])).status).toBe("pending");
  });
  it("the database refuses the same grant if the request were used twice or confirmed by the proposer", async () => {
    const t = await login();
    const admin = db.pool("app_admin");
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad1]);
      const rid = (await c.query("insert into approval_request(kind, target_table, target_id, change) values ('grant_role','staff_role',$1,'{\"role\":\"trust_and_safety\"}') returning id", [h.staff[t]])).rows[0].id;
      await expect(c.query("update approval_request set status='confirmed' where id=$1", [rid])).rejects.toThrow(); // confirmer = proposer
      await c.query("rollback");
    } finally { c.release(); }
    await expect(admin.query("insert into staff_role(staff_user_id, role, granted_by_staff_user_id, approval_request_id) values ($1,'trust_and_safety',$2,null)", [h.staff[t], h.staff.ad1])).rejects.toThrow(); // no request
    expect(await roles(h.staff[t]!)).toEqual(["content_editor"]);
  });
});

describe("remove a role (one administrator, at once)", () => {
  it("removes a role and writes one audit row", async () => {
    const t = await login(["content_editor", "trust_and_safety"]);
    await ok(act("ad1", "remove_role", { staffId: h.staff[t], role: "trust_and_safety" }));
    expect(await roles(h.staff[t]!)).toEqual(["content_editor"]);
    expect((await audits(h.staff[t]!)).map((a) => [a.action, a.a, a.after])).toEqual([["staff.role_remove", h.staff.ad1, { role: "trust_and_safety" }]]);
    await no(act("ad1", "remove_role", { staffId: h.staff[t], role: "trust_and_safety" }), 404, "not_found");
  });
  it("takes the administrator role from another administrator while one remains, and refuses to take the last one", async () => {
    const t = await login(["administrator"]);
    await ok(act("ad1", "remove_role", { staffId: h.staff[t], role: "administrator" }));
    await onlyAdmins(["ad1"], async () => {
      await no(act("ad1", "remove_role", { staffId: h.staff.ad1, role: "administrator" }), 409, "last_administrator");
      expect(await roles(h.staff.ad1!)).toContain("administrator");
    });
  });
  it("a disabled administrator does not count as one left", async () => {
    await onlyAdmins(["ad1", "ad2"], async () => {
      // ad3 and the disabled login are out; ad1 and ad2 remain. Removing ad2's role is fine, then ad1 is the last.
      await ok(act("ad1", "remove_role", { staffId: h.staff.ad2, role: "administrator" }));
      await no(act("ad1", "remove_role", { staffId: h.staff.ad1, role: "administrator" }), 409, "last_administrator");
      await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'administrator',true)", [h.staff.ad2]);
    });
  });
});

describe("disable and enable (one administrator, at once)", () => {
  it("disables a login, ends every open session of it in the same transaction, and the old cookies are refused everywhere", async () => {
    const t = await login(["content_editor"]);
    const second = await h.AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
      method: "POST", body: JSON.stringify({ email: `${t}@example.test`, password: PW }),
      headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "198.51.100.250" },
    }));
    expect(second.status).toBe(200);
    expect(await sessions(h.staff[t]!)).toBe(2);
    expect(await ok(act("ad1", "disable", { staffId: h.staff[t] }))).toEqual({ ok: true, sessionsEnded: 2 });
    expect(await sessions(h.staff[t]!)).toBe(0);
    expect((await one("select status from staff_user where id = $1", [h.staff[t]])).status).toBe("disabled");
    for (const cookie of [h.signedIn(t), second.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ")]) {
      await no(call(null, undefined, { cookie }), 401, "no_session");
      await no(call(null, { action: "disable", staffId: h.staff.ad1 }, { cookie }), 401, "no_session");
    }
    const again = await h.AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
      method: "POST", body: JSON.stringify({ email: `${t}@example.test`, password: PW }),
      headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "198.51.100.251" },
    }));
    expect(again.status).not.toBe(200); // a disabled login gets no new session
    expect(await sessions(h.staff[t]!)).toBe(0);
    expect((await audits(h.staff[t]!)).map((a) => [a.action, a.a, a.after])).toEqual([["staff.disable", h.staff.ad1, { sessionsEnded: 2 }]]);
  });
  it("refuses an unknown login, one already disabled, and the last active administrator (also itself)", async () => {
    await no(act("ad1", "disable", { staffId: "nobody-here" }), 404, "not_found");
    await no(act("ad1", "disable", { staffId: h.staff.disabled }), 409, "already_disabled");
    await onlyAdmins(["ad1"], async () => {
      await no(act("ad1", "disable", { staffId: h.staff.ad1 }), 409, "last_administrator");
      expect((await one("select status from staff_user where id = $1", [h.staff.ad1])).status).toBe("active");
    });
    // with a second administrator an administrator may disable themselves
    const spare = await login(["administrator"]);
    await ok(act(spare, "disable", { staffId: h.staff[spare] }));
    expect((await one("select status from staff_user where id = $1", [h.staff[spare]])).status).toBe("disabled");
  });
  it("two administrators disabling each other at once: exactly one wins and one stays active", async () => {
    const [x, y] = [await login(["administrator"]), await login(["administrator"])];
    await onlyAdmins([x, y], async () => {
      const rs = await Promise.all([act(x, "disable", { staffId: h.staff[y] }), act(y, "disable", { staffId: h.staff[x] })]);
      expect(rs.filter((r) => r.status === 200).length).toBe(1);
      expect(["last_administrator", "not_active", "not_active_staff"]).toContain(rs.find((r) => r.status !== 200)!.json.error); // which, depends on who commits first
      expect((await su.query("select count(*)::int n from staff_user u join staff_role r on r.staff_user_id = u.id and r.role = 'administrator' where u.status = 'active' and u.id = any($1)", [[h.staff[x], h.staff[y]]])).rows[0].n).toBe(1);
    });
  });
  it("a disable that waits for the administrators' lock counts again afterwards, so it cannot take the last one", async () => {
    const [x, y] = [await login(["administrator"]), await login(["administrator"])];
    await onlyAdmins([x, y], async () => {
      const other = await su.connect();
      try {
        await other.query("begin");
        await other.query("select u.id from staff_user u join staff_role r on r.staff_user_id = u.id and r.role = 'administrator' where u.status = 'active' order by u.id for update of u");
        const waiting = act(x, "disable", { staffId: h.staff[y] }); // passes the role check, then waits for the lock
        await new Promise((r) => setTimeout(r, 500));
        await other.query("update staff_user set status = 'disabled' where id = $1", [h.staff[x]]); // meanwhile x is disabled by someone else
        await other.query("commit");
        await no(waiting, 409, "last_administrator");
        expect((await one("select status from staff_user where id = $1", [h.staff[y]])).status).toBe("active");
      } finally { other.release(); }
    });
    await su.query("update staff_user set status = 'active' where id = $1", [h.staff[x]]);
  });
  it("enables a disabled login that holds no role, and refuses one that still holds a role, or is not disabled", async () => {
    const [a, b] = [await login(["content_editor"]), await login(["content_editor"])];
    for (const t of [a, b]) await ok(act("ad1", "disable", { staffId: h.staff[t] }));
    await no(act("ad1", "enable", { staffId: h.staff[a] }), 409, "holds_roles"); // migration 0004: a role holder is not turned back on without the two-person grant
    await ok(act("ad1", "remove_role", { staffId: h.staff[a], role: "content_editor" }));
    await ok(act("ad1", "enable", { staffId: h.staff[a] }));
    expect((await one("select status from staff_user where id = $1", [h.staff[a]])).status).toBe("active");
    await no(act("ad1", "enable", { staffId: h.staff[a] }), 409, "not_disabled");
    await no(act("ad1", "enable", { staffId: "nobody-here" }), 404, "not_found");
    expect((await audits(h.staff[a]!)).map((x) => x.action)).toEqual(["staff.disable", "staff.role_remove", "staff.enable"]);
    // the database says the same, whatever the route did
    await expect(db.pool("app_admin").query("update staff_user set status = 'active' where id = $1", [h.staff[b]])).rejects.toThrow(/not turned back on/);
  });
  it("no other action makes a login (invite, step 15 Q15, is tested in staff-notices.test.ts)", async () => {
    for (const action of ["create", "create_login", "add_staff"]) await no(act("ad1", action, { email: "x@example.test" }), 400, "bad_action");
    expect((await one("select count(*)::int n from staff_user where email = 'x@example.test'")).n).toBe(0);
  });
});

describe("hostile requests", () => {
  it("refuses a missing or foreign Origin, a long body and bad JSON, and writes nothing", async () => {
    const t = await login();
    const good = { action: "disable", staffId: h.staff[t] };
    await no(call("ad1", good, { origin: null }), 403, "bad_origin");
    await no(call("ad1", good, { origin: "https://evil.example.test" }), 403, "bad_origin");
    await no(call("ad1", good, { length: "100000" }), 400, "bad_body");
    await no(call("ad1", undefined, { raw: "x".repeat(600) }), 400, "bad_body");
    for (const raw of ["", "{", "null", "[]", "1", '"disable"']) await no(call("ad1", undefined, { raw }), 400, "bad_body");
    expect((await one("select status from staff_user where id = $1", [h.staff[t]])).status).toBe("active");
  });
  it("refuses unknown actions, unknown fields and bad ids or roles", async () => {
    const t = await login();
    for (const action of ["toString", "__proto__", "", 5, null, "DISABLE"]) await no(call("ad1", { action, staffId: h.staff[t] }), 400, "bad_action");
    for (const extra of [{ status: "active" }, { email: "x@example.test" }, { roles: ["administrator"] }, { sessionsEnded: 0 }]) await no(call("ad1", { action: "disable", staffId: h.staff[t], ...extra }), 400, "bad_body");
    for (const staffId of [5, null, "", "a b", "a;b", "a'b", "a".repeat(65), "ａｂ", "a\nb", "a‮b", ["x"], { a: 1 }, "x or 1=1", "../x"]) await no(call("ad1", { action: "disable", staffId }), 400, "bad_staff_id");
    for (const role of ["boss", "Administrator", "", 5, null, "administrator;", "admin", "a".repeat(41)]) await no(call("ad1", { action: "propose_role", staffId: h.staff[t], role }), 400, "bad_role");
    for (const requestId of [5, null, "", "0", "01", "-1", "1.5", "1e3", "1 or 1=1", "12345678901234567890", ["1"]]) await no(call("ad1", { action: "confirm_role", requestId }), 400, "bad_request_id");
    expect(await roles(h.staff[t]!)).toEqual(["content_editor"]);
  });
});

describe("performance", () => {
  it("list, propose, confirm and disable stay inside their statement and time budgets; the staff list stays under its page budget", async () => {
    const t = [await login(), await login(), await login()];
    const [, listN] = await counted(() => call("ad1"));
    const [p, proposeN] = await counted(() => act("ad1", "propose_role", { staffId: h.staff[t[0]!], role: "trust_and_safety" }));
    const [, confirmN] = await counted(() => act("ad2", "confirm_role", { requestId: p.json.requestId }));
    const [, disableN] = await counted(() => act("ad1", "disable", { staffId: h.staff[t[1]!] }));
    expect([listN, proposeN, confirmN, disableN]).toEqual([BUDGET.list, BUDGET.propose, BUDGET.confirm, BUDGET.disable]);
    const roleList = ["fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "account_reviewer"];
    const targets = await Promise.all(Array.from({ length: 9 }, () => login()));
    const tl = await median(() => call("ad1"));
    const reqs: string[] = [];
    const tp = await median(async (i) => { reqs.push((await ok(act("ad1", "propose_role", { staffId: h.staff[targets[i]!], role: roleList[i % roleList.length] }))).requestId); });
    const tc = await median((i) => ok(act("ad2", "confirm_role", { requestId: reqs[i] })));
    const more = await Promise.all(Array.from({ length: 9 }, () => login()));
    const td = await median((i) => ok(act("ad1", "disable", { staffId: h.staff[more[i]!] })));
    expect(tl).toBeLessThan(BUDGET.listMs);
    expect(tp).toBeLessThan(BUDGET.proposeMs);
    expect(tc).toBeLessThan(BUDGET.confirmMs);
    expect(td).toBeLessThan(BUDGET.disableMs);
    for (let i = 0; i < 60; i++) await su.query("insert into staff_user(id, name, email, email_verified, status) values ($1,$2,$3,true,'active')", [`bulk${i}`, `Bulk ${i}`, `bulk${i}@example.test`]);
    const client = await su.connect();
    try {
      const costs = await measurePages(client, STAFF_LIST);
      assertPageBudget("staff list", costs, BUDGET.pages);
    } finally { client.release(); }
  });
});
