// Step 15 P13: the member limit route of the admin app (/api/companies/member-limit) on the real test database, through the real route handler with real staff
// sessions, connected as app_admin. Every staff role, a disabled staff member, hostile input, the bounds, and the effect on the team's TEAM_FULL check.
// Companies and members are written as postgres. No network. Fake people only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

// Measured on 18 November 2026: 3 statements (requireStaff 2, the function 1), median 2.3 ms. The time budget is about 8 times the measure.
const BUDGET = { statements: 3, medianMs: 20 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
let db: TestDb;
let h: Awaited<ReturnType<typeof staffHarness>>;
let route: Route;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string | null, o?: object): Promise<number> };
const P = "/api/companies/member-limit";

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  route = { GET: async () => new Response(null, { status: 405 }), ...(await import("../../../apps/admin/app/api/companies/member-limit/route")) };
  await oneOfEachRole(h);
  await h.makeStaff("disabled", ["account_reviewer", "administrator"]);
  await h.su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]); // after sign-in: the open session is refused too
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

async function org(active = 3) {
  const o = Number(await F.org());
  for (let i = 0; i < active; i++) await F.member(o, await F.portal(), { role: i === 0 ? "account_owner" : "recruiter" });
  return o;
}
const set = (who: string | null, organisationId: number, memberLimit: number, o = {}) =>
  h.call(route, P, who, { organisationId: String(organisationId), memberLimit, reason: "growing_team" }, o);
const limit = async (o: number) => (await h.su.query("select member_limit from organisation where id = $1", [o])).rows[0].member_limit as number;

describe("member limit route", () => {
  it("the account reviewer and the administrator set it, with one audit row; every other role is refused and nothing changes", async () => {
    for (const r of ROLE_NAMES) {
      const o = await org();
      const x = await set(`only_${r}`, o, 25);
      if (r === "account_reviewer" || r === "administrator") {
        expect([x.status, x.json], r).toEqual([200, { ok: true, organisationId: String(o), memberLimit: 25, activeMembers: 3 }]);
        const a = (await h.su.query("select kind, actor_staff_user_id, changed_columns, before, after, reason_code, source from audit_event where action = 'organisation.member_limit' and object_id = $1", [String(o)])).rows;
        expect(a).toEqual([{ kind: "admin_action", actor_staff_user_id: h.staff[`only_${r}`], changed_columns: ["member_limit"], before: { member_limit: 10 }, after: { member_limit: 25 }, reason_code: "growing_team", source: "panel" }]);
      } else {
        expect([x.status, x.json.error], r).toEqual([403, "not_limit_staff"]);
        expect(await limit(o), r).toBe(10);
      }
    }
  });
  it("a disabled staff member, no session and a wrong Origin are refused", async () => {
    const o = await org();
    await h.no(set("disabled", o, 20), 401, "not_active");
    expect((await set(null, o, 20)).status).toBe(401);
    await h.no(set("only_administrator", o, 20, { origin: "https://evil.example.test" }), 403, "bad_origin");
    await h.no(set("only_administrator", o, 20, { origin: null }), 403, "bad_origin");
    expect(await limit(o)).toBe(10);
  });
  it("lowers it, but never below the active members; never above 50 or below 1", async () => {
    const o = await org(4);
    await h.su.query("insert into membership(organisation_id, invited_email, role, status, invite_token_hash, invite_expires_at) values ($1, 'fake.inv.p13@example.test', 'poster', 'invited', repeat('b', 64), now() + interval '7 days')", [o]);
    await h.ok(set("only_account_reviewer", o, 4)); // the invite does not count: only active members
    await h.no(set("only_account_reviewer", o, 3), 409, "below_active");
    for (const n of [0, -1, 51, 1000, 2.5]) await h.no(set("only_account_reviewer", o, n), 400, "bad_limit");
    await h.ok(set("only_account_reviewer", o, 50));
    expect(await limit(o)).toBe(50);
    await h.no(set("only_account_reviewer", 999999, 20), 404, "not_found");
  });
  it("the raised limit lets the team grow past 10: the TEAM_FULL check reads it", async () => {
    const o = await org(10);
    const owner = (await h.su.query("select portal_user_id from membership where organisation_id = $1 and role = 'account_owner'", [o])).rows[0].portal_user_id;
    const invite = (email: string) => db.query("app_portal", "select private.team_invite($1, $2, 'poster', false, $3)", [owner, email, "c".repeat(63) + email.length % 10]);
    await expect(invite("fake.full1@example.test")).rejects.toThrow(/TEAM_FULL/);
    await h.ok(set("only_administrator", o, 11));
    await expect(invite("fake.full2@example.test")).resolves.toBeDefined();
  });
  it("hostile input: odd bodies, free-text reasons, unknown fields, big bodies", async () => {
    const o = await org();
    const raw = (body: string, x = {}) => h.call(route, P, "only_administrator", undefined, { raw: body, ...x });
    for (const b of ["", "x", "[]", "null", "{"]) await h.no(raw(b), 400, "bad_body");
    await h.no(raw(JSON.stringify({ organisationId: String(o), memberLimit: 20, reason: "x", extra: 1 })), 400, "bad_body");
    await h.no(raw(JSON.stringify({ organisationId: String(o), memberLimit: "20", reason: "x" })), 400, "bad_body");
    for (const id of ["0", "1 or 1=1", "-1", o]) await h.no(raw(JSON.stringify({ organisationId: id, memberLimit: 20, reason: "x" })), 400, "bad_input");
    for (const reason of ["Free text here", "", "<script>", "a".repeat(64), "x;drop"]) await h.no(raw(JSON.stringify({ organisationId: String(o), memberLimit: 20, reason })), 400, "bad_reason");
    await h.no(raw("x".repeat(2000)), 400, "bad_body");
    await h.no(raw(JSON.stringify({ organisationId: String(o), memberLimit: 20, reason: "x" }), { length: "100000" }), 400, "bad_body");
    expect(await limit(o)).toBe(10);
  });
  it("the database refuses what the route would: app_admin's call checks the role, app_portal cannot call it, the column holds 1 to 50", async () => {
    const o = await org();
    await expect(db.query("app_admin", "select private.member_limit_set($1, $2, 20, 'x')", [h.staff.only_content_editor, o])).rejects.toThrow(/NOT_LIMIT_STAFF/);
    await expect(db.query("app_admin", "select private.member_limit_set($1, $2, 51, 'x')", [h.staff.only_administrator, o])).rejects.toThrow(/BAD_LIMIT/);
    await expect(db.query("app_portal", "select private.member_limit_set($1, $2, 20, 'x')", [h.staff.only_administrator, o])).rejects.toThrow(/permission denied/);
    await expect(db.query("app_portal", "update organisation set member_limit = 50 where id = $1", [o])).rejects.toThrow(/permission denied/);
    await expect(h.su.query("update organisation set member_limit = 51 where id = $1", [o])).rejects.toThrow(/member_limit_check/);
  });
});

describe("performance", () => {
  it("the limit change stays inside its statement and time budget", async () => {
    const o = await org();
    const [, n] = await counted(() => h.ok(set("only_account_reviewer", o, 12)));
    const ms = await median((i) => set("only_account_reviewer", o, 12 + (i % 5)));
    process.stdout.write(`member-limit perf: ${n} statements, median ${ms.toFixed(1)} ms\n`);
    expect(n).toBeLessThanOrEqual(BUDGET.statements);
    expect(ms).toBeLessThan(BUDGET.medianMs);
  });
});
