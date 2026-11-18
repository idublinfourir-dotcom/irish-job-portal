// C5 (#253): the staff read of the daily "no" counts through the real GET /api/signup-no-counts handler, real staff sessions, the test database as app_admin.
// Any active staff member reads it (a date and a count, nothing about any visitor); signed out, forged and disabled logins are refused. No network. Fake people only.
// Measured 18 November 2026: requireStaff 2 statements and the read 1 (3 in all), median 2 ms on a full year. Budget: 3 statements, median 15 ms.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const BUDGET = { statements: 3, ms: 15 };
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
const get = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/signup-no-counts", who, undefined, { ...o, query });

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  route = await import("../../../apps/admin/app/api/signup-no-counts/route");
  await oneOfEachRole(h);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  await su.query("insert into signup_no_count(day, count) select (now() at time zone 'UTC')::date - g, 1 + g from generate_series(0, 399) g");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("GET /api/signup-no-counts", () => {
  it("every active staff member reads the last 366 days, newest first, each a day and a count", async () => {
    for (const who of [...ROLE_NAMES.map((r) => `only_${r}`), "norole"]) {
      const r = await h.ok(get(who));
      expect(r.days, who).toHaveLength(366);
      expect(Object.keys(r.days[0]).sort()).toEqual(["count", "day"]);
      expect(r.days[0].count).toBe(1);
      expect(r.days[1].day < r.days[0].day).toBe(true);
    }
  });
  it("refuses signed out, forged and disabled logins, and any query key; there is no way to write", async () => {
    await h.no(get(null), 401, "no_session");
    await h.no(get(null, "", { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(get("disabled"), 401, "not_active");
    for (const q of ["?days=9999", "?after=x", "?x=" + "a".repeat(5000)]) await h.no(get("only_administrator", q), 400, "bad_query");
    expect(Object.keys(route).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
  it("matches docs/openapi/admin.yaml", async () => {
    const spec = loadSpec("admin");
    for (const r of [await get("only_content_editor"), await get(null), await get("only_content_editor", "?x=1")])
      expect(replyProblems(spec, "GET", "/api/signup-no-counts", r.status, r.json), String(r.status)).toEqual([]);
  });
  it("stays inside the statement and time budgets", async () => {
    const [, s] = await counted(() => get("only_administrator"));
    expect(s, `${s} statements`).toBeLessThanOrEqual(BUDGET.statements);
    const ms = await median(() => get("only_administrator"));
    expect(ms).toBeLessThan(BUDGET.ms);
    console.log(`signup no read budget: ${s} statements, median ${ms.toFixed(1)} ms`);
  });
});
