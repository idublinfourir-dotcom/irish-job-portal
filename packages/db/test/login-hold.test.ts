// Step 15 C3: staff suspend a candidate login or block a portal login, and lift either, through the real /api/accounts handler, real staff sessions and
// the real test database as app_admin. The held login's sessions end in the same transaction and its next request is refused by the session hook's rule;
// one audit row with the reason code. Every other staff role, a disabled login, no session, a bad Origin and hostile bodies are refused. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements: requireStaff (2), begin, role check, update, delete sessions, audit, commit = 8 for a hold; a lift has no session delete (7).
// Median time measured 2.2 to 3.1 ms (three runs) on 18 Nov 2026; the limit is about 4 times that with a floor for a busy laptop.
const BUDGET = { hold: 8, lift: 7, ms: 12 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
let F: { cand(o?: object): Promise<string>; portal(o?: object): Promise<string> };
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/accounts", who, body, o);
const act = (who: string | null, action: string, userId: string, reason = "fake_documents") => call(who, { action, userId, reason });
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const session = (pool: "candidate" | "portal", user: string, id: string) =>
  su.query(`insert into ${pool}_session(id, expires_at, token, updated_at, user_id) values ($1, now() + interval '1 day', $2, now(), $3)`, [id, `tok-${id}`, user]);
const sessions = (pool: string, user: string) => one(`select count(*)::int n from ${pool}_session where user_id = $1`, [user]).then((r) => r.n);
const audits = (user: string) => su.query("select action, actor_staff_user_id a, reason_code, after from audit_event where object_id = $1 order by id", [user]).then((r) => r.rows);

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  route = (await import("../../../apps/admin/app/api/accounts/route")) as unknown as Route; // POST only
  await h.makeStaff("ad1", ["administrator"]);
  for (const r of ROLE_NAMES) if (r !== "administrator") await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("gone", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("suspend and lift a candidate login", () => {
  it("suspends, ends every session of that login only, audits the reason, and the session rule now refuses it", async () => {
    const c = await F.cand(), other = await F.cand();
    await session("candidate", c, `s-${c}-1`); await session("candidate", c, `s-${c}-2`); await session("candidate", other, `s-${other}`);
    expect(await h.ok(act("ad1", "suspend_candidate", c))).toEqual({ ok: true, sessionsEnded: 2 });
    expect([await sessions("candidate", c), await sessions("candidate", other)]).toEqual([0, 1]);
    // the Identity module's refusal rule (packages/auth refusedSql)
    expect((await su.query("select 1 from candidate_user where id=$1 and (suspended_at is not null or deleted_at is not null)", [c])).rowCount).toBe(1);
    await h.no(act("ad1", "suspend_candidate", c), 409, "already_held");
    expect(await h.ok(act("ad1", "lift_candidate", c, "appeal_upheld"))).toEqual({ ok: true, sessionsEnded: 0 });
    expect(await one("select suspended_at from candidate_user where id = $1", [c])).toEqual({ suspended_at: null });
    await h.no(act("ad1", "lift_candidate", c), 409, "not_held");
    expect(await audits(c)).toEqual([
      { action: "account.suspend", a: h.staff.ad1, reason_code: "fake_documents", after: { sessionsEnded: 2 } },
      { action: "account.unsuspend", a: h.staff.ad1, reason_code: "appeal_upheld", after: {} },
    ]);
  });
  it("the candidate pool only: a portal id is not found there", async () => {
    const p = await F.portal();
    await h.no(act("ad1", "suspend_candidate", p), 404, "not_found");
    await h.no(act("ad1", "suspend_candidate", "nobody-here"), 404, "not_found");
  });
});

describe("block and lift a portal login", () => {
  it("blocks with the reason code, ends its sessions, and lifts it back to active", async () => {
    const p = await F.portal();
    await session("portal", p, `s-${p}`);
    expect(await h.ok(act("ad1", "block_portal", p, "impersonation"))).toEqual({ ok: true, sessionsEnded: 1 });
    expect(await one("select status, blocked_at is not null as b, blocked_reason_code from portal_user where id = $1", [p])).toEqual({ status: "blocked", b: true, blocked_reason_code: "impersonation" });
    expect(await sessions("portal", p)).toBe(0);
    await h.no(act("ad1", "block_portal", p), 409, "already_held");
    await h.ok(act("ad1", "lift_portal", p, "appeal_upheld"));
    expect(await one("select status, blocked_at, blocked_reason_code from portal_user where id = $1", [p])).toEqual({ status: "active", blocked_at: null, blocked_reason_code: null });
    await h.no(act("ad1", "lift_portal", p), 409, "not_held");
    expect((await audits(p)).map((a) => [a.action, a.reason_code])).toEqual([["account.block", "impersonation"], ["account.unblock", "appeal_upheld"]]);
    await h.no(act("ad1", "block_portal", await F.cand()), 404, "not_found");
  });
});

describe("who may not", () => {
  it("every staff role but administrator, a disabled login, no session and a forged one; nothing changes", async () => {
    const c = await F.cand(), p = await F.portal();
    for (const r of ROLE_NAMES) if (r !== "administrator") {
      await h.no(act(`only_${r}`, "suspend_candidate", c), 403, "not_administrator");
      await h.no(act(`only_${r}`, "block_portal", p), 403, "not_administrator");
    }
    await h.no(act("gone", "suspend_candidate", c), 401, "not_active");
    await h.no(act(null, "suspend_candidate", c), 401, "no_session");
    await h.no(call(null, { action: "suspend_candidate", userId: c, reason: "x" }, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(call("ad1", { action: "suspend_candidate", userId: c, reason: "x" }, { origin: "https://evil.example" }), 403, "bad_origin");
    await h.no(call("ad1", { action: "suspend_candidate", userId: c, reason: "x" }, { origin: null }), 403, "bad_origin");
    expect(await one("select suspended_at from candidate_user where id = $1", [c])).toEqual({ suspended_at: null });
    expect(await one("select status from portal_user where id = $1", [p])).toEqual({ status: "active" });
  });
  it("the logins themselves cannot lift a hold: app_candidate and app_portal have no right on those columns", async () => {
    const c = await F.cand({ suspended: new Date() }), p = await F.portal();
    await su.query("update portal_user set status = 'blocked' where id = $1", [p]);
    await expect(db.pool("app_candidate").query("update candidate_user set suspended_at = null where id = $1", [c])).rejects.toThrow(/permission denied/);
    await expect(db.pool("app_portal").query("update portal_user set status = 'active' where id = $1", [p])).rejects.toThrow(/permission denied/);
  });
  it("hostile bodies: wrong types, long strings, unknown fields and actions, SQL in the id, free text as the reason", async () => {
    const c = await F.cand();
    const bad: [unknown, number, string][] = [
      [{ action: "suspend_candidate", userId: 5, reason: "x" }, 400, "bad_user_id"],
      [{ action: "suspend_candidate", userId: "a".repeat(65), reason: "x" }, 400, "bad_user_id"],
      [{ action: "suspend_candidate", userId: "x' or '1'='1", reason: "x" }, 400, "bad_user_id"],
      [{ action: "suspend_candidate", userId: c, reason: "He sent fake papers" }, 400, "bad_reason"],
      [{ action: "suspend_candidate", userId: c, reason: ["x"] }, 400, "bad_reason"],
      [{ action: "suspend_candidate", userId: c }, 400, "bad_reason"],
      [{ action: "suspend_candidate", userId: c, reason: "x", note: "hi" }, 400, "bad_body"],
      [{ action: "disable", userId: c, reason: "x" }, 400, "bad_action"],
      [[1], 400, "bad_body"],
      [{ action: "suspend_candidate", userId: c, reason: "x".repeat(400) }, 400, "bad_body"],
    ];
    for (const [body, status, error] of bad) await h.no(call("ad1", body), status, error);
    await h.no(call("ad1", undefined, { raw: "{not json" }), 400, "bad_body");
    await h.no(call("ad1", { action: "suspend_candidate", userId: c, reason: "x" }, { length: "100000" }), 400, "bad_body");
    expect(await one("select suspended_at from candidate_user where id = $1", [c])).toEqual({ suspended_at: null });
    expect(await audits(c)).toEqual([]);
  });
});

describe("performance", () => {
  it("statements and median time inside budget", async () => {
    const c = await F.cand();
    const [, hold] = await counted(() => h.ok(act("ad1", "suspend_candidate", c)));
    const [, lift] = await counted(() => h.ok(act("ad1", "lift_candidate", c)));
    expect([hold, lift]).toEqual([BUDGET.hold, BUDGET.lift]);
    const ms = await median((i) => h.ok(act("ad1", i % 2 ? "lift_candidate" : "suspend_candidate", c)));
    console.log(`accounts route: ${hold} statements (hold), ${lift} (lift), median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET.ms);
  });
});
