// Integration: the audit log viewer (step 13d, #234 D2) through the real /api/audit handler, real staff sessions, the real test database as app_admin.
// An administrator reads every row with filters, 50 a page by keyset; every other role reads only the rows where they are the actor; nothing can edit or
// delete a row. The largest filters have a page budget on a log of 30,000 rows. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_PAGE_SQL } from "../src/audit-read";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";
import { assertPageBudget, measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Measured on 13 November 2026: requireStaff is 2 statements, the role check 1, the page 1 (4 in all; B59 adds one read for the staff names and object labels, 5). Medians over 9 warm calls through the route on a log of
// 30,000 rows: 1 to 3 ms. Pages are 8 kB pages touched by one page of 51 rows (planning + execution + serialisation), measured: no filter 10, one staff member 23,
// a rare action 7 (through audit_event_action_idx, 0023; without it the whole log is read), a two-day range 7, one object 11, every filter together 19, kind data_access 10 and one case 10 (through the 0069 indexes; without them each read the whole log, 498 pages). Limits are about 3 times that.
const BUDGET = { statements: 5, ms: 15, pages: { none: 40, staff: 80, rare: 30, range: 30, object: 40, combined: 60, kind: 30, case: 30 } };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
const get = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/audit", who, undefined, { ...o, query });
const q = (p: Record<string, string>) => "?" + new URLSearchParams(p).toString();
type Ev = { id: string; at: string; action: string; objectType: string | null; objectId: string | null; actor: { staff: string | null } };

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  route = await import("../../../apps/admin/app/api/audit/route");
  for (const n of ["ad1", "ad2"]) await h.makeStaff(n, ["administrator"]);
  for (const r of ROLE_NAMES) if (r !== "administrator") await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  // The log: 130 rows by cycling actors, actions and objects over five days; 60 of them share one instant (ties in the keyset).
  const actors = Object.values(h.staff);
  await su.query(
    `insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, source, at)
     select 'admin_action', ($1::text[])[1 + g % $2], 'test.act' || (g % 4), case when g % 3 = 0 then 'thing' else 'other' end, 'obj' || (g % 7), 'panel',
            case when g <= 60 then timestamptz '2026-03-10 12:00:00+00' else timestamptz '2026-03-10 12:00:00+00' + make_interval(hours => g) end
       from generate_series(1, 130) g`, [actors, actors.length]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("access", () => {
  it("refuses a call with no session, a forged one and a disabled login", async () => {
    await h.no(get(null), 401, "no_session");
    await h.no(get("disabled"), 401, "not_active");
    await h.no(get(null, "", { cookie: "better-auth.session_token=forged" }), 401, "no_session");
  });
  it("has no way to write: no other method, and app_admin holds select and insert on the log, nothing else", async () => {
    expect(Object.keys(route).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    const admin = db.pool("app_admin");
    await expect(admin.query("update audit_event set action = 'x' where false")).rejects.toThrow(/permission denied/);
    await expect(admin.query("delete from audit_event where false")).rejects.toThrow(/permission denied/);
    await expect(admin.query("truncate audit_event")).rejects.toThrow(/permission denied/);
    // and it cannot write a row in someone else's name
    await expect(admin.query("insert into audit_event(kind, actor_staff_user_id, action) values ('admin_action', $1, 'test.forged')", [h.staff.ad2])).rejects.toThrow(/acting staff id/);
  });
  it("an administrator reads every actor's rows", async () => {
    const r = await h.ok(get("ad1"));
    const actors = new Set((r.events as Ev[]).map((e) => e.actor.staff));
    expect(actors.size).toBeGreaterThan(3);
  });
  it("every other role reads only the rows where they are the actor, and is refused another member's id", async () => {
    for (const who of ROLE_NAMES.filter((r) => r !== "administrator").map((r) => `only_${r}`).concat("norole")) {
      const all: Ev[] = [];
      let after = "";
      for (;;) {
        const r = await h.ok(get(who, after));
        all.push(...r.events);
        if (!r.next) break;
        after = q({ after: r.next });
      }
      expect(all.length, who).toBeGreaterThan(0);
      expect(all.every((e) => e.actor.staff === h.staff[who]), who).toBe(true);
      const own = (await su.query("select count(*)::int n from audit_event where actor_staff_user_id = $1", [h.staff[who]])).rows[0].n;
      expect(all.length, who).toBe(own);
      await h.no(get(who, q({ staff: h.staff.ad1! })), 403, "not_administrator");
      expect((await h.ok(get(who, q({ staff: h.staff[who]! })))).events.length, who).toBeGreaterThan(0); // their own id is fine
    }
  });
  it("a staff member's own filters narrow their own rows, never widen them", async () => {
    const who = "only_content_editor";
    const r = await h.ok(get(who, q({ action: "test.act1" })));
    expect(r.events.every((e: Ev) => e.actor.staff === h.staff[who] && e.action === "test.act1")).toBe(true);
    expect((await h.ok(get(who, q({ objectId: "obj-none" })))).events).toEqual([]);
  });
});

describe("the page", () => {
  it("is newest first, 50 a page by keyset, with no row twice or missed, ties included", async () => {
    const seen: Ev[] = [];
    let after = "";
    let pages = 0;
    for (;;) {
      const r = await h.ok(get("ad1", after));
      expect(r.events.length).toBeLessThanOrEqual(50);
      if (r.next) expect(r.events.length).toBe(50);
      seen.push(...r.events);
      pages++;
      if (!r.next) break;
      after = q({ after: r.next });
    }
    const total = (await su.query("select count(*)::int n from audit_event")).rows[0].n;
    expect(seen.length).toBe(total);
    expect(new Set(seen.map((e) => e.id)).size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 50));
    const order = (await su.query("select id::text id from audit_event order by at desc, id desc")).rows.map((r) => r.id);
    expect(seen.map((e) => e.id)).toEqual(order);
  });
  it("shows what an auditor needs and no more: ids, codes and the changed values, never a password or a token", async () => {
    const r = await h.ok(get("ad1", q({ action: "test.act1" })));
    expect(Object.keys(r.events[0]).sort()).toEqual(["action", "actor", "after", "at", "before", "changedColumns", "id", "kind", "objectId", "objectLabel", "objectType", "reasonCode", "relatedCase", "roleInForce", "secondStaff", "secondStaffName", "source"]);
    expect(Object.keys(r.events[0].actor).sort()).toEqual(["candidate", "portal", "staff", "staffName", "system"]);
    expect(JSON.stringify(r)).not.toMatch(/password|token|hash/i);
  });
});

describe("filters", () => {
  const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows.map((r) => r.id as string);
  const ids = async (query: string) => {
    const out: string[] = [];
    let after = "";
    for (;;) {
      const r = await h.ok(get("ad1", query + after));
      out.push(...r.events.map((e: Ev) => e.id));
      if (!r.next) return out;
      after = (query ? "&" : "?") + "after=" + r.next;
    }
  };
  it("filters by staff member, action, object type, object id and a date range, alone and together", async () => {
    const t = h.staff.only_trust_and_safety!;
    expect(await ids(q({ staff: t }))).toEqual(await rows("select id::text id from audit_event where actor_staff_user_id = $1 order by at desc, id desc", [t]));
    expect(await ids(q({ action: "test.act2" }))).toEqual(await rows("select id::text id from audit_event where action = 'test.act2' order by at desc, id desc"));
    expect(await ids(q({ objectType: "thing" }))).toEqual(await rows("select id::text id from audit_event where object_type = 'thing' order by at desc, id desc"));
    expect(await ids(q({ objectId: "obj3" }))).toEqual(await rows("select id::text id from audit_event where object_id = 'obj3' order by at desc, id desc"));
    expect(await ids(q({ from: "2026-03-11", to: "2026-03-12" }))).toEqual(await rows("select id::text id from audit_event where at >= '2026-03-11+00' and at < '2026-03-13+00' order by at desc, id desc"));
    expect(await ids(q({ action: "test.act1", objectType: "other", objectId: "obj2", from: "2026-03-10", to: "2026-03-14" })))
      .toEqual(await rows("select id::text id from audit_event where action = 'test.act1' and object_type = 'other' and object_id = 'obj2' and at >= '2026-03-10+00' and at < '2026-03-15+00' order by at desc, id desc"));
    expect((await ids(q({ from: "2026-03-10", to: "2026-03-10" }))).length).toBeGreaterThanOrEqual(60); // the day's ties are all there
    expect(await ids(q({ staff: "nobody-here" }))).toEqual([]);
  });
  it("refuses a bad filter or a bad cursor", async () => {
    for (const bad of [{ staff: "a b" }, { staff: "a".repeat(65) }]) await h.no(get("ad1", q(bad)), 400, "bad_staff_id");
    for (const a of ["Bad", "1abc", "a b", "a;b", "a".repeat(82), "a'--"]) await h.no(get("ad1", q({ action: a })), 400, "bad_action");
    for (const t of ["Bad", "a.b", "a".repeat(42)]) await h.no(get("ad1", q({ objectType: t })), 400, "bad_object_type");
    for (const o of ["a b", "a;b", "a".repeat(101), "a\nb"]) await h.no(get("ad1", q({ objectId: o })), 400, "bad_object_id");
    for (const d of ["2026-02-30", "2026-13-01", "26-03-10", "2026-03-10T00:00:00Z", "yesterday", "2026-3-1", ""]) { await h.no(get("ad1", q({ from: d })), 400, "bad_from"); await h.no(get("ad1", q({ to: d })), 400, "bad_to"); }
    await h.no(get("ad1", q({ from: "2026-03-12", to: "2026-03-11" })), 400, "bad_range");
    const forged = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const c of ["x", "!!!", "a".repeat(300), forged({ t: "now", i: "1" }), forged({ t: "2026-11-11 10:00:00+00", i: "1; drop table audit_event" }), forged(null), forged([1])]) await h.no(get("ad1", q({ after: c })), 400, "bad_cursor");
  });
  it("refuses an unknown or repeated query parameter", async () => {
    await h.no(get("ad1", "?x=1"), 400, "bad_query");
    await h.no(get("ad1", "?action=a&action=b"), 400, "bad_query");
    await h.no(get("ad1", "?kind=security&kind=security"), 400, "bad_query");
    await h.no(get("ad1", "?case=a&case=b"), 400, "bad_query");
  });
});

describe("the replies match docs/openapi/admin.yaml (decision #248)", () => {
  it("a page with its cursor, the next page, and the 400 and 401 bodies", async () => {
    const spec = loadSpec("admin");
    const first = await get("ad1");
    const checks = [first, await get("ad1", q({ after: first.json.next as string })), await get("only_content_editor"), await get("ad1", "?x=1"), await get(null)];
    expect(checks.map((r) => r.status)).toEqual([200, 200, 200, 400, 401]);
    for (const r of checks) expect(replyProblems(spec, "GET", "/api/audit", r.status, r.json), `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`).toEqual([]);
  });
});

describe("performance", () => {
  it("stays inside the statement and time budgets and each filter inside its page budget, on a log of 30,000 rows", async () => {
    const actors = Object.values(h.staff);
    await su.query(
      `insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, source, at)
       select 'admin_action', ($1::text[])[1 + g % $2], 'bulk.act' || (g % 25), 'org', (g % 5000)::text, 'panel', now() - make_interval(mins => g * 25)
         from generate_series(1, 30000) g`, [actors, actors.length]);
    await su.query("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, source, at) select 'admin_action', $1, 'rare.action', 'org', 'rare' || g, 'panel', now() - make_interval(days => g * 30) from generate_series(1, 10) g", [h.staff.ad1]);
    // B59: ten personal data views and ten rows of one case, a month apart, among the 30,000 (0069 indexes both filters)
    await su.query("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, related_case, source, at) select 'data_access', $1, 'case_document.open', 'case_document', g::text, case when g <= 10 then 'strike:7' end, 'panel', now() - make_interval(days => g * 30) from generate_series(1, 10) g", [h.staff.ad1]);
    await su.query("vacuum (analyze) audit_event");
    const [, n] = await counted(() => get("ad1", q({ action: "bulk.act3" })));
    expect(n).toBe(BUDGET.statements);
    const ms = await median(() => get("ad1", q({ action: "bulk.act3" })));
    expect(ms).toBeLessThan(BUDGET.ms);
    const none = [null, null, null, null, null, null, null, null, null, null];
    const stmt = (i: Record<number, unknown>) => ({ text: AUDIT_PAGE_SQL, values: none.map((v, k) => i[k] ?? v) });
    const client = await su.connect();
    try {
      for (const [name, values] of Object.entries({
        none: stmt({}),
        staff: stmt({ 0: h.staff.only_content_editor }),
        rare: stmt({ 1: "rare.action" }),
        range: stmt({ 4: "2026-10-01", 5: "2026-10-03" }),
        object: stmt({ 3: "42" }),
        combined: stmt({ 0: h.staff.ad1, 1: "bulk.act3", 2: "org", 3: "42", 4: "2025-01-01", 5: "2026-12-31" }),
        kind: stmt({ 8: "data_access" }),
        case: stmt({ 9: "strike:7" }),
      })) assertPageBudget(`audit page, ${name} filter`, await measurePages(client, [values]), BUDGET.pages[name as keyof typeof BUDGET.pages]);
    } finally { client.release(); }
  });
});
