// Integration: the pay scales rules kind (#269, step 15 S7) on the real test database. Version 1 goes through the real /api/rules handlers with real
// staff sessions (a rules data editor proposes, another administrator confirms), as step15/s7-live-steps.sh does live; the loader takes it, refuses a
// broken one, and still loads when no version exists. No network. Fake people only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PayScale } from "@portal/rules";
import { loadRules } from "../src/rules-data";
import { createTestDb, type TestDb } from "./db";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements on every pg.Client.query call, measured 19 November 2026 (as rules-versions.test.ts counts them): propose = begin, role check, version
// in force, insert, audit, commit and the session (8); confirm = begin, role check, lock, confirm, insert version, audit, commit and the session (9). Medians of 9 warm calls with the 40-grade
// list, measured 37 ms for a propose and confirm pair (two staff sessions read each time); the limit is rules-versions.test.ts's propose plus confirm (30 + 40).
const BUDGET = { propose: 8, confirm: 9, pairMs: 70 };
const V1 = JSON.parse(readFileSync(new URL("../../rules/data/pay-scales-v1.json", import.meta.url), "utf8")) as PayScale[];

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, today: string;
beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  route = await import("../../../apps/admin/app/api/rules/route");
  today = (await h.su.query("select current_date::text d")).rows[0].d;
  await h.makeStaff("ed1", ["rules_data_editor"]);
  await h.makeStaff("ad1", ["administrator"]);
  await h.makeStaff("both", ["rules_data_editor", "administrator"]);
  await oneOfEachRole(h);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const call = (who: string | null, body?: unknown, o = {}) => h.call(route, "/api/rules", who, body, o);
const propose = (who: string, data: unknown, effectiveFrom = today) => call(who, { action: "propose", kind: "pay_scales", effectiveFrom, data });
const decide = (who: string, action: string, requestId: string) => call(who, { action, requestId });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

describe("version 1 of the pay scales through the two-person route", () => {
  it("before any version the rules still load, with no pay scales", async () => {
    expect((await loadRules(db.pool("app_fetcher"), today)).payScales).toBeUndefined();
    expect((await h.ok(call("ed1"))).inForce.map((v: { kind: string }) => v.kind)).not.toContain("pay_scales");
  });
  it("only a rules data editor proposes; only another administrator confirms; broken data is refused", async () => {
    for (const r of ROLE_NAMES.filter((x) => x !== "rules_data_editor")) await h.no(propose(`only_${r}`, V1), 403, "not_rules_editor");
    await h.no(call(null, { action: "propose", kind: "pay_scales", effectiveFrom: today, data: V1 }), 401, "no_session");
    for (const data of [[], {}, [{ ...V1[0], code: "x'); drop table job; --" }], [{ ...V1[0], firstEur: 99999, lastEur: 1 }], [V1[0], V1[0]], [{ ...V1[0], sourceUrl: "http://x.test" }]])
      await h.no(propose("ed1", data), 400, "bad_data");
    await h.no(call("ed1", { action: "propose", kind: "pay_scale", effectiveFrom: today, data: V1 }), 400, "bad_kind");
    await h.no(propose("ed1", V1, addDays(today, -1)), 409, "date_in_past");
    const p = await h.ok(propose("ed1", V1));
    expect([Object.keys(p.change.added).length, Object.keys(p.change.removed).length, Object.keys(p.change.changed).length]).toEqual([40, 0, 0]);
    await h.no(propose("ed1", V1), 409, "decision_pending");
    for (const r of ROLE_NAMES.filter((x) => x !== "administrator")) await h.no(decide(`only_${r}`, "confirm", p.requestId), 403, "not_administrator");
    const pending = (await h.ok(call("only_content_editor"))).pending.find((x: { requestId: string }) => x.requestId === p.requestId);
    expect(pending).toMatchObject({ kind: "pay_scales", effectiveFrom: today });
    const v = await h.ok(decide("ad1", "confirm", p.requestId));
    expect(v.versionId).toMatch(/^\d+$/);
    expect(await h.su.query("select kind, proposed_by_staff_user_id p from rules_version where id = $1", [v.versionId]).then((r) => r.rows[0])).toEqual({ kind: "pay_scales", p: h.staff.ed1 });
    expect((await loadRules(db.pool("app_portal"), today)).payScales).toEqual(V1);
    await h.no(propose("ed1", V1), 409, "no_change");
  });
  it("the proposer cannot confirm their own version", async () => {
    const p = await h.ok(propose("both", [...V1.slice(1)], addDays(today, 30)));
    await h.no(decide("both", "confirm", p.requestId), 409, "same_person");
    await h.ok(decide("both", "withdraw", p.requestId));
  });
  it("the database refuses a version with no confirmed request, whoever writes it", async () => {
    await expect(db.pool("app_admin").query("insert into rules_version(kind, data, effective_from) values ('pay_scales', $1::jsonb, current_date + 1)", [JSON.stringify(V1)])).rejects.toThrow(/two-person rule/);
    await expect(db.pool("app_portal").query("insert into rules_version(kind, data, effective_from) values ('pay_scales', '[]', current_date + 1)")).rejects.toThrow(/permission denied/);
    await expect(h.su.query("insert into approval_request(kind, target_table, target_id) values ('pay_scale', 'rules_version', 'pay_scales')")).rejects.toThrow(/approval_request_kind_check|acting staff/);
  });
  it("a broken or empty version in force stops the loader (the fetch and posting checks run on nothing)", async () => {
    const c = await h.su.connect();
    try {
      for (const data of ["[]", JSON.stringify([{ ...V1[0], lastEur: 1 }])]) {
        await c.query("begin");
        await c.query("set local role portal_owner");
        await c.query("insert into rules_version(kind, data, effective_from, seeded_by_owner) values ('pay_scales', $1::jsonb, current_date, true)", [data]);
        await expect(loadRules(c, today)).rejects.toThrow(/the pay_scales version in force .* is not valid/);
        await c.query("rollback");
      }
    } finally { c.release(); }
    expect((await loadRules(db.pool("app_fetcher"), today)).payScales).toHaveLength(40);
  });
});

describe("performance", () => {
  it("a propose and a confirm of the 40-grade list stay inside their statement and time budgets", async () => {
    const at = (i: number) => addDays(today, 100 + i);
    const [p, proposeN] = await counted(() => h.ok(propose("ed1", V1.slice(1), at(0))));
    const [, confirmN] = await counted(() => h.ok(decide("ad1", "confirm", p.requestId)));
    expect([proposeN, confirmN]).toEqual([BUDGET.propose, BUDGET.confirm]);
    // each round puts back or takes away the first grade, so every proposal is a change against the version in force today (V1)
    const ms = await median(async (i) => { const r = await h.ok(propose("ed1", i % 2 ? V1.slice(3) : V1.slice(2), at(i + 1))); await h.ok(decide("ad1", "confirm", r.requestId)); });
    console.log(`pay scales propose and confirm: median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET.pairMs);
  });
});
