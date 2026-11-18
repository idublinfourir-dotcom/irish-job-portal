// D6 (#49): the staff read of DETE permit rises through the real GET /api/permit-rises handler, real staff sessions, the test database as app_admin.
// Any active staff member reads it; signed out, forged and disabled logins and any query key are refused. No network. Fake names only.
// Budget: requireStaff 2 statements and the read 1 (3 in all), median under 25 ms with 5,000 rise rows.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const BUDGET = { statements: 3, ms: 25 };
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
const get = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/permit-rises", who, undefined, { ...o, query });

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  route = await import("../../../apps/admin/app/api/permit-rises/route");
  await oneOfEachRole(h);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  // an older import (not shown), then the newest: 5,000 rises, one hostile name stored as plain text
  await su.query("insert into dete_permit_rise(found_at, dete_name, year, permits_before, permits_after) values (now() - interval '40 days', 'Fake Old Ltd', 2026, 1, 900)");
  await su.query("insert into dete_permit_rise(dete_name, year, permits_before, permits_after) select 'Fake Rise ' || g, 2026, g, g + 1 + (g % 7) from generate_series(1, 4999) g");
  await su.query("insert into dete_permit_rise(dete_name, year, permits_before, permits_after) values ($1, 2026, 0, 50)", ["<script>x</script>'; drop table job; --"]);
  await su.query("analyze dete_permit_rise");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("GET /api/permit-rises", () => {
  it("every active staff member reads the newest import's rises, biggest first, at most 200; an older import is left out", async () => {
    for (const who of [...ROLE_NAMES.map((r) => `only_${r}`), "norole"]) {
      const r = await h.ok(get(who));
      expect(r.rises, who).toHaveLength(200);
      expect(r.rises[0]).toMatchObject({ deteName: "<script>x</script>'; drop table job; --", before: 0, after: 50, organisationId: null, organisation: null });
      expect(r.rises.some((x: { deteName: string }) => x.deteName === "Fake Old Ltd")).toBe(false);
      expect(r.rises[1].after - r.rises[1].before).toBeLessThanOrEqual(r.rises[0].after - r.rises[0].before);
    }
  });
  it("refuses signed out, forged and disabled logins, and any query key; there is no way to write", async () => {
    await h.no(get(null), 401, "no_session");
    await h.no(get(null, "", { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(get("disabled"), 401, "not_active");
    for (const q of ["?limit=9999", "?x=" + "a".repeat(5000)]) await h.no(get("only_administrator", q), 400, "bad_query");
    expect(Object.keys(route).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
  it("matches docs/openapi/admin.yaml", async () => {
    const spec = loadSpec("admin");
    for (const r of [await get("only_content_editor"), await get(null), await get("only_content_editor", "?x=1")])
      expect(replyProblems(spec, "GET", "/api/permit-rises", r.status, r.json), String(r.status)).toEqual([]);
  });
  it("stays inside the statement and time budgets", async () => {
    const [, s] = await counted(() => get("only_administrator"));
    expect(s, `${s} statements`).toBeLessThanOrEqual(BUDGET.statements);
    const ms = await median(() => get("only_administrator"));
    expect(ms).toBeLessThan(BUDGET.ms);
    console.log(`permit rises read budget: ${s} statements, median ${ms.toFixed(1)} ms`);
  });
});
