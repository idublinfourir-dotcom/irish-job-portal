// Integration: step 15 small wave 3 through the admin app's real route handlers and the real daily command, on the real test database as app_admin,
// with real staff sessions. Q3 the scheduled reminders (scheduled-checks-cli.ts, /api/scheduled-checks), Q12 the overdue view (/api/overdue), Q14
// the company seed through two people (/api/companies/seed) and the stale guides (/api/content?stale=1), R2 a setting through two people
// (/api/settings). No network. Fake people and companies only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main as remindersMain, type Dated } from "../src/scheduled-checks-cli";
import { CONTENT_STALE, STALE_DAYS } from "../src/content-admin";
import { OVERDUE, OVERDUE_APPROVALS, SCHEDULED_LIST, workingDayBefore } from "../src/staff-tools";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { assertPageBudget, measurePages } from "./perf/pages";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements per call through the route (requireStaff is 2): a list is the role check and its read (4; settings 5, two reads); a write is begin,
// role check, its statements, commit. Medians over 9 warm calls, measured 18 Nov 2026: 2.0 to 3.5 ms; limit 15. Pages of one read on the bulk rows
// below (planning + execution + serialisation), measured: scheduled list 17, overdue 17, stale guides 6; limits about 3 times that. Overdue is 5 (two
// reads, 0047; approvals 37 pages on 1,000 pending, approval_request_pending_idx); a seed confirm is 16 for a one-line file (seedRows 10, use_company_seed 1, lock, status, audit, begin and commit).
const BUDGET = {
  scheduledList: 4, scheduledDone: 6, overdue: 5, settingsList: 5, settingPropose: 8, settingConfirm: 10, seedPropose: 7, seedConfirm: 16, stale: 4,
  ms: 15, pages: { scheduled: 50, overdue: 50, overdueApprovals: 100, stale: 20 }, cliStatements: 2, cliMs: 100,
};

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
const routes: Record<string, Route> = {};
const spec = loadSpec("admin");
const call = (path: string, who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(routes[path]!, path, who, body, o);
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);
const NOT_ADMIN = ROLE_NAMES.filter((r) => r !== "administrator").map((r) => `only_${r}`);
const ENV = (role = "app_admin") => ({ SCHEDULED_ADMIN_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
const runReminders = async (env: Record<string, string> = ENV(), bodies: Dated[] = []) => {
  const out: string[] = [];
  return { code: await remindersMain([], env, (l) => out.push(l), bodies), out };
};
const scheduled = async () => (await su.query("select reason, detail, status from review_item where queue = 'scheduled_check' order by id")).rows;

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  for (const p of ["scheduled-checks", "overdue", "settings", "companies/seed", "content"]) routes[`/api/${p}`] = await import(`../../../apps/admin/app/api/${p}/route`);
  await oneOfEachRole(h);
  await h.makeStaff("ad2", ["administrator"]);
  await h.makeStaff("re2", ["rules_data_editor"]);
  await h.makeStaff("readmin", ["rules_data_editor", "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("every route: signed out, a forged session and a disabled login are refused", () => {
  it("answers 401 on each GET and POST", async () => {
    for (const p of ["/api/scheduled-checks", "/api/overdue", "/api/settings", "/api/companies/seed"]) {
      await no(call(p, null), 401, "no_session");
      await no(call(p, "disabled"), 401, "not_active");
      await no(call(p, null, undefined, { cookie: "staff.session_token=forged" }), 401, "no_session");
      if (p !== "/api/overdue") await no(call(p, null, { action: "refuse", requestId: "1" }), 401, "no_session");
    }
    await no(call("/api/content", null, undefined, { query: "?stale=1" }), 401, "no_session");
  });
  it("refuses a write from another origin or with no origin, and an unknown query key", async () => {
    for (const p of ["/api/scheduled-checks", "/api/settings", "/api/companies/seed"]) {
      await no(call(p, "only_administrator", { action: "refuse", requestId: "1" }, { origin: "https://evil.example" }), 403, "bad_origin");
      await no(call(p, "only_administrator", { action: "refuse", requestId: "1" }, { origin: null }), 403, "bad_origin");
    }
    for (const p of ["/api/scheduled-checks", "/api/overdue", "/api/settings", "/api/companies/seed"]) await no(call(p, "only_administrator", undefined, { query: "?x=1" }), 400, "bad_query");
  });
});

describe("Q3: the scheduled reminders", () => {
  it("the daily command writes the four fixed reminders and the due big-company names, and a second run writes nothing", async () => {
    // one name due for review, one later, one never (as seeded)
    await su.query(`update rules_version set data = $1::jsonb where kind = 'big_company_names'`, [JSON.stringify([
      { name: "fake due brand", test: "brand", link: "https://example.test/a", readOn: "2026-01-01", reviewOn: "2026-02-01" },
      { name: "fake later brand", test: "brand", link: "https://example.test/b", readOn: "2026-01-01", reviewOn: "2999-01-01" },
      { name: "fake seeded brand", test: "brand", link: null, readOn: null, reviewOn: null },
    ])]);
    const first = await runReminders();
    expect(first).toEqual({ code: 0, out: ["scheduled checks: 5 due, 5 new"] });
    const rows = await scheduled();
    expect(rows.map((r) => [r.reason, r.detail.role, r.status])).toEqual([
      ["dete_notice_check", "rules_data_editor", "open"], ["hand_check_100", "fetched_job_reviewer", "open"], ["big_company_review", "rules_data_editor", "open"],
      ["role_review", "administrator", "open"], ["big_company_name_review", "rules_data_editor", "open"],
    ]);
    expect(rows[4].detail).toMatchObject({ key: "big_company_name_review:fake due brand:2026-02-01", name: "fake due brand", reviewOn: "2026-02-01" });
    expect(await runReminders()).toEqual({ code: 0, out: ["scheduled checks: 5 due, 0 new"] });
    // a done item keeps its key: still nothing new
    await su.query("update review_item set status = 'done' where queue = 'scheduled_check' and reason = 'role_review'");
    expect((await runReminders()).out).toEqual(["scheduled checks: 5 due, 0 new"]);
    expect((await scheduled()).length).toBe(5);
  });
  it("the command refuses with no login, an argument, or a login that may not write review items", async () => {
    expect((await remindersMain([], {}, () => {}))).toBe(2);
    expect((await remindersMain(["x"], ENV(), () => {}))).toBe(2);
    const r = await runReminders(ENV("app_portal"));
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^refused: permission denied/);
  });
  it("each role sees only its own reminders, an administrator all; any other role is refused", async () => {
    const reasons = async (who: string) => (await ok(call("/api/scheduled-checks", who))).items.map((i: { reason: string }) => i.reason);
    expect(await reasons("only_rules_data_editor")).toEqual(["dete_notice_check", "big_company_review", "big_company_name_review"]);
    expect(await reasons("only_fetched_job_reviewer")).toEqual(["hand_check_100"]);
    expect(await reasons("only_administrator")).toEqual(["dete_notice_check", "hand_check_100", "big_company_review", "big_company_name_review"]); // role_review is done
    for (const who of ["only_account_reviewer", "only_trust_and_safety", "only_services_case_handler", "only_content_editor", "norole"]) {
      await no(call("/api/scheduled-checks", who), 403, "not_scheduled_staff");
      await no(call("/api/scheduled-checks", who, { action: "done", itemId: "1" }), 403, "not_scheduled_staff");
    }
    const r = await call("/api/scheduled-checks", "only_administrator");
    expect(replyProblems(spec, "GET", "/api/scheduled-checks", r.status, r.json)).toEqual([]);
  });
  it("done closes an item of one's own role once, with its audit row; another role's item is not found", async () => {
    const id = async (reason: string) => (await su.query("select id::text from review_item where queue = 'scheduled_check' and reason = $1", [reason])).rows[0].id;
    const hand = await id("hand_check_100"), dete = await id("dete_notice_check");
    await no(call("/api/scheduled-checks", "only_rules_data_editor", { action: "done", itemId: hand }), 404, "not_found");
    const r = await call("/api/scheduled-checks", "only_fetched_job_reviewer", { action: "done", itemId: hand });
    expect([r.status, r.json, replyProblems(spec, "POST", "/api/scheduled-checks", r.status, r.json)]).toEqual([200, { ok: true }, []]);
    await no(call("/api/scheduled-checks", "only_fetched_job_reviewer", { action: "done", itemId: hand }), 409, "already_decided");
    expect((await su.query("select status, outcome, decided_by_staff_user_id by from review_item where id = $1", [hand])).rows[0]).toEqual({ status: "done", outcome: "done", by: h.staff.only_fetched_job_reviewer });
    expect((await su.query("select actor_staff_user_id a, action from audit_event where object_type = 'review_item' and object_id = $1", [hand])).rows).toEqual([{ a: h.staff.only_fetched_job_reviewer, action: "scheduled_check.done" }]);
    await ok(call("/api/scheduled-checks", "only_administrator", { action: "done", itemId: dete }));
  });
  it("refuses hostile input: bad ids, unknown fields, wrong types, an id of another queue", async () => {
    const who = "only_administrator";
    for (const itemId of ["0", "-1", "abc", "99999999999999999999", 5, null, "1 or 1=1"]) await no(call("/api/scheduled-checks", who, { action: "done", itemId }), 400, "bad_item_id");
    await no(call("/api/scheduled-checks", who, { action: "done", itemId: "1", extra: 1 }), 400, "bad_body");
    await no(call("/api/scheduled-checks", who, { action: "drop", itemId: "1" }), 400, "bad_action");
    await no(call("/api/scheduled-checks", who, undefined, { raw: "x".repeat(300) }), 400, "bad_body");
    await no(call("/api/scheduled-checks", who, { action: "done", itemId: "999999" }), 404, "not_found");
    // an item of another queue is not a reminder
    await su.query("insert into job_source(kind, board) values ('portal', 'fake-s3')");
    const org = (await su.query("insert into organisation(slug, display_name, kind) values ('fake-s3-co', 'Fake S3 Co', 'employer') returning id")).rows[0].id;
    const item = (await su.query("insert into review_item(queue, organisation_id) values ('account_review', $1) returning id::text", [org])).rows[0].id;
    await no(call("/api/scheduled-checks", who, { action: "done", itemId: item }), 404, "not_found");
    expect((await su.query("select status from review_item where id = $1", [item])).rows[0].status).toBe("open");
  });
  it("S6: a registration body whose review date has come gets one item for rules_data_editor, once; a later one none", async () => {
    const bodies = [{ id: "fake_body", reviewOn: "2026-01-01" }, { id: "fake_later", reviewOn: "2999-01-01" }];
    const first = await runReminders(ENV(), bodies);
    expect(first.out).toEqual(["scheduled checks: 6 due, 1 new"]);
    expect((await runReminders(ENV(), bodies)).out).toEqual(["scheduled checks: 6 due, 0 new"]);
    const rows = (await scheduled()).filter((r) => r.reason === "registration_body_review");
    expect(rows.map((r) => r.detail)).toEqual([{ key: "registration_body_review:fake_body:2026-01-01", role: "rules_data_editor", name: "fake_body", reviewOn: "2026-01-01" }]);
    const reasons = async (who: string) => (await ok(call("/api/scheduled-checks", who))).items.map((i: { reason: string }) => i.reason);
    expect(await reasons("only_rules_data_editor")).toContain("registration_body_review");
    expect(await reasons("only_fetched_job_reviewer")).not.toContain("registration_body_review");
    for (const who of ["only_content_editor", "only_account_reviewer", "norole"]) await no(call("/api/scheduled-checks", who), 403, "not_scheduled_staff");
    const r = await call("/api/scheduled-checks", "only_administrator");
    expect(replyProblems(spec, "GET", "/api/scheduled-checks", r.status, r.json)).toEqual([]);
  });
});

describe("S7 upkeep: the quarterly pay scales review", () => {
  it("is not written before a pay_scales version is in force (nor for one still to come), then once a quarter for rules_data_editor", async () => {
    const pays = async () => (await scheduled()).filter((r) => r.reason === "pay_scales_review");
    // as the owner: one seeded version, first still to come, then moved into force (a version in force is all the reminder reads)
    const asOwner = async (sql: string) => {
      const c = await su.connect();
      try {
        await c.query("begin");
        await c.query("set local role portal_owner");
        await c.query(sql);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback");
        throw e;
      } finally { c.release(); }
    };
    await runReminders();
    expect(await pays()).toEqual([]);
    await asOwner("insert into rules_version(kind, data, effective_from, seeded_by_owner) values ('pay_scales', '[]'::jsonb, '2999-01-01', true)"); // not yet in force
    await runReminders();
    expect(await pays()).toEqual([]);
    await asOwner("update rules_version set effective_from = '2026-06-01' where kind = 'pay_scales'");
    const before = (await scheduled()).length;
    const r = await runReminders();
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/, 1 new$/);
    const today = (await su.query("select (now() at time zone 'Europe/Dublin')::date::text d")).rows[0].d as string;
    const quarter = `${today.slice(0, 4)}-Q${Math.ceil(Number(today.slice(5, 7)) / 3)}`;
    expect((await pays()).map((x) => x.detail)).toEqual([{ key: `pay_scales_review:${quarter}`, role: "rules_data_editor" }]);
    expect((await runReminders()).out[0]).toMatch(/, 0 new$/);
    expect((await scheduled()).length).toBe(before + 1);
    const reasons = async (who: string) => (await ok(call("/api/scheduled-checks", who))).items.map((i: { reason: string }) => i.reason);
    expect(await reasons("only_rules_data_editor")).toContain("pay_scales_review");
    expect(await reasons("only_administrator")).toContain("pay_scales_review");
    expect(await reasons("only_fetched_job_reviewer")).not.toContain("pay_scales_review");
    for (const who of ["only_content_editor", "only_account_reviewer", "norole"]) await no(call("/api/scheduled-checks", who), 403, "not_scheduled_staff");
    const res = await call("/api/scheduled-checks", "only_rules_data_editor");
    expect(replyProblems(spec, "GET", "/api/scheduled-checks", res.status, res.json)).toEqual([]);
  });
});

describe("Q12: the overdue view", () => {
  it("lists open and claimed items of every queue older than one working day, oldest first, for an administrator only", async () => {
    await su.query("delete from review_item");
    const old = (await su.query("insert into review_item(queue, reason, detail, created_at) values ('scheduled_check', 'a', '{\"key\":\"t:a\"}', now() - interval '10 days'), ('scheduled_check', 'b', '{\"key\":\"t:b\"}', now() - interval '9 days') returning id::text")).rows.map((r) => r.id);
    await su.query("insert into review_item(queue, reason, detail, created_at) values ('scheduled_check', 'new', '{\"key\":\"t:c\"}', now())");
    await su.query("insert into review_item(queue, reason, detail, status, created_at) values ('scheduled_check', 'closed', '{\"key\":\"t:d\"}', 'done', now() - interval '20 days')");
    await su.query("update review_item set status = 'claimed', claimed_by_staff_user_id = $1, claimed_at = now() where id = $2", [h.staff.only_administrator, old[1]]);
    const r = await call("/api/overdue", "only_administrator");
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: { id: string; status: string; claimed_by: string | null }) => [i.id, i.status, i.claimed_by])).toEqual([[old[0], "open", null], [old[1], "claimed", h.staff.only_administrator]]);
    expect(Math.abs(Date.parse(r.json.before) - workingDayBefore(new Date()).getTime())).toBeLessThan(60_000);
    expect(r.json.truncated).toBe(false);
    expect(replyProblems(spec, "GET", "/api/overdue", r.status, r.json)).toEqual([]);
    for (const who of [...NOT_ADMIN, "norole"]) await no(call("/api/overdue", who), 403, "not_administrator");
  });

  it("lists approval requests still waiting for a second person after one working day; not a fresh, decided or used one", async () => {
    const propose = async (key: string, value: number) => (await ok(call("/api/settings", "only_administrator", { action: "propose", key, value }))).requestId as string;
    const [waiting, fresh, decided] = [await propose("contact_message", 25), await propose("claim_needs_info", 31), await propose("inactive_profile", 13)];
    await ok(call("/api/settings", "ad2", { action: "refuse", requestId: decided }));
    await su.query("update approval_request set created_at = now() - interval '10 days' where id = any($1::bigint[])", [[waiting, decided]]);
    const r = await call("/api/overdue", "only_administrator");
    expect([r.status, replyProblems(spec, "GET", "/api/overdue", r.status, r.json)]).toEqual([200, []]);
    const mine = r.json.approvals.filter((a: { id: string }) => [waiting, fresh, decided].includes(a.id));
    expect(mine).toEqual([{ id: waiting, kind: "setting", target_table: "setting", target_id: "contact_message", proposed_by: h.staff.only_administrator, created_at: expect.any(String) }]);
    expect(r.json.approvalsTruncated).toBe(false);
    for (const who of [...NOT_ADMIN, "norole"]) await no(call("/api/overdue", who), 403, "not_administrator");
    for (const id of [waiting, fresh]) await ok(call("/api/settings", "only_administrator", { action: "refuse", requestId: id }));
  });
});

describe("R2: a setting's value through two administrators", () => {
  const value = async (key: string) => (await su.query("select value, updated_by_staff_user_id by from setting where key = $1", [key])).rows[0];
  const guess = async (key: string) => (await su.query("select is_guess from setting where key = $1", [key])).rows[0].is_guess;
  it("one administrator proposes, a different one confirms, and the value is written with its audit row naming both", async () => {
    const p = await call("/api/settings", "only_administrator", { action: "propose", key: "draft_job", value: 6 });
    expect([p.status, replyProblems(spec, "POST", "/api/settings", p.status, p.json)]).toEqual([200, []]);
    expect((await value("draft_job")).value).toBe(12); // nothing yet
    const l = await call("/api/settings", "ad2");
    expect([l.status, replyProblems(spec, "GET", "/api/settings", l.status, l.json)]).toEqual([200, []]);
    expect(l.json.pending).toEqual([{ requestId: p.json.requestId, key: "draft_job", value: 6, proposedBy: h.staff.only_administrator, createdAt: expect.any(String) }]);
    expect(l.json.settings.find((s: { key: string }) => s.key === "draft_job")).toMatchObject({ value: 12, unit: "months" });
    await no(call("/api/settings", "only_administrator", { action: "confirm", requestId: p.json.requestId }), 409, "same_person");
    await no(call("/api/settings", "ad2", { action: "propose", key: "draft_job", value: 7 }), 409, "decision_pending");
    const c = await call("/api/settings", "ad2", { action: "confirm", requestId: p.json.requestId });
    expect([c.status, c.json, replyProblems(spec, "POST", "/api/settings", c.status, c.json)]).toEqual([200, { ok: true, key: "draft_job", value: 6 }, []]);
    expect(await value("draft_job")).toEqual({ value: 6, by: h.staff.ad2 });
    expect(await guess("draft_job")).toBe(false); // seeded as a guess; two administrators decided it
    // the database's own row (setting_guard: second is the request's confirmer) and the confirm row naming the proposer
    expect((await su.query("select action, actor_staff_user_id a, second_staff_user_id s, after->>'value' v from audit_event where action in ('setting.change', 'setting.confirm') and object_id = 'draft_job' order by id")).rows)
      .toEqual([{ action: "setting.change", a: h.staff.ad2, s: h.staff.ad2, v: "6" }, { action: "setting.confirm", a: h.staff.ad2, s: h.staff.only_administrator, v: "6" }]);
    await no(call("/api/settings", "ad2", { action: "confirm", requestId: p.json.requestId }), 409, "request_not_pending");
  });
  it("null clears a value; the same value is no change; the proposer withdraws and another administrator refuses", async () => {
    const p = (await ok(call("/api/settings", "ad2", { action: "propose", key: "apply_click", value: null }))).requestId;
    await ok(call("/api/settings", "only_administrator", { action: "confirm", requestId: p }));
    expect((await value("apply_click")).value).toBeNull();
    // cleared means not set, so still to be decided: a decided setting cleared becomes a guess again
    expect(await guess("review_item_done")).toBe(false);
    await ok(call("/api/settings", "only_administrator", { action: "confirm", requestId: (await ok(call("/api/settings", "ad2", { action: "propose", key: "review_item_done", value: null }))).requestId }));
    expect([(await value("review_item_done")).value, await guess("review_item_done")]).toEqual([null, true]);
    await no(call("/api/settings", "ad2", { action: "propose", key: "apply_click", value: null }), 409, "no_change");
    const w = (await ok(call("/api/settings", "ad2", { action: "propose", key: "apply_click", value: 14 }))).requestId;
    await ok(call("/api/settings", "ad2", { action: "refuse", requestId: w }));
    const f = (await ok(call("/api/settings", "ad2", { action: "propose", key: "apply_click", value: 14 }))).requestId;
    await ok(call("/api/settings", "only_administrator", { action: "refuse", requestId: f }));
    expect((await su.query("select id::text, status from approval_request where id = any($1::bigint[]) order by id", [[w, f]])).rows).toEqual([{ id: w, status: "withdrawn" }, { id: f, status: "refused" }]);
    expect((await value("apply_click")).value).toBeNull();
  });
  it("refuses every other role, unknown keys and hostile values; the database still refuses a value with no confirmed request", async () => {
    for (const who of [...NOT_ADMIN, "norole"]) {
      await no(call("/api/settings", who), 403, "not_administrator");
      await no(call("/api/settings", who, { action: "propose", key: "draft_job", value: 1 }), 403, "not_administrator");
      await no(call("/api/settings", who, { action: "confirm", requestId: "1" }), 403, "not_administrator");
    }
    const who = "only_administrator";
    await no(call("/api/settings", who, { action: "propose", key: "no_such_setting", value: 1 }), 404, "not_found");
    for (const key of ["Draft_job", "draft job", "x".repeat(64), "draft_job'; drop table setting; --", 5, null]) await no(call("/api/settings", who, { action: "propose", key, value: 1 }), 400, "bad_key");
    for (const v of [-1, 1.5, 100_001, "6", true, [6], { v: 6 }]) await no(call("/api/settings", who, { action: "propose", key: "draft_job", value: v }), 400, "bad_value");
    await no(call("/api/settings", who, { action: "propose", key: "draft_job" }), 400, "bad_value");
    await no(call("/api/settings", who, { action: "confirm", requestId: "abc" }), 400, "bad_request_id");
    await no(call("/api/settings", who, { action: "confirm", requestId: "999999" }), 404, "not_found");
    // a role-grant request id is not a setting request
    const grant = (await su.query("select id::text from approval_request where kind <> 'setting' limit 1")).rows[0]?.id;
    if (grant) await no(call("/api/settings", who, { action: "confirm", requestId: grant }), 404, "not_found");
    const c = await db.pool("app_admin").connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.only_administrator]);
      await expect(c.query("update setting set value = 1 where key = 'draft_job'")).rejects.toThrow(/two-person rule/);
    } finally { await c.query("rollback"); c.release(); }
  });
});

describe("Q14: the company seed through two people", () => {
  const HEAD = "display_name\tkind\tbrand_names\tdete_names";
  const file = (...rows: string[]) => [HEAD, ...rows].join("\n") + "\n";
  it("a rules data editor proposes, an administrator who did not propose confirms, and the companies are written then", async () => {
    const text = file("Fake Seed Co\temployer\tFake Seed ;; Fake Seed Brand\t", "Fake Other Co\tagency\tFake Other\t");
    const p = await call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text });
    expect([p.status, p.json.rows, replyProblems(spec, "POST", "/api/companies/seed", p.status, p.json)]).toEqual([200, 2, []]);
    expect((await su.query("select count(*)::int n from organisation where display_name in ('Fake Seed Co', 'Fake Other Co')")).rows[0].n).toBe(0);
    const l = await call("/api/companies/seed", "only_administrator");
    expect([l.status, l.json.pending.length, l.json.pending[0].rows.length, replyProblems(spec, "GET", "/api/companies/seed", l.status, l.json)]).toEqual([200, 1, 2, []]);
    await no(call("/api/companies/seed", "re2", { action: "propose", text }), 409, "decision_pending");
    await no(call("/api/companies/seed", "only_rules_data_editor", { action: "confirm", requestId: p.json.requestId }), 403, "not_administrator");
    const c = await call("/api/companies/seed", "only_administrator", { action: "confirm", requestId: p.json.requestId });
    expect([c.status, c.json.created, c.json.namesAdded, replyProblems(spec, "POST", "/api/companies/seed", c.status, c.json)]).toEqual([200, 2, 3, []]);
    expect((await su.query("select display_name, kind from organisation where display_name in ('Fake Seed Co', 'Fake Other Co') order by display_name")).rows)
      .toEqual([{ display_name: "Fake Other Co", kind: "agency" }, { display_name: "Fake Seed Co", kind: "employer" }]);
    expect((await su.query("select status, confirmed_by_staff_user_id c, applied_at is not null used from approval_request where id = $1", [p.json.requestId])).rows[0]).toEqual({ status: "confirmed", c: h.staff.only_administrator, used: true });
    expect((await su.query("select action, second_staff_user_id s from audit_event where object_type = 'approval_request' and object_id = $1 order by id", [p.json.requestId])).rows)
      .toEqual([{ action: "company_seed.propose", s: null }, { action: "company_seed.confirm", s: h.staff.only_rules_data_editor }]);
    await no(call("/api/companies/seed", "ad2", { action: "confirm", requestId: p.json.requestId }), 409, "request_not_pending");
  });
  it("one person holding both roles cannot confirm their own file; the proposer withdraws, an administrator refuses", async () => {
    const a = (await ok(call("/api/companies/seed", "readmin", { action: "propose", text: file("Fake Third Co\temployer\tFake Third\t") }))).requestId;
    await no(call("/api/companies/seed", "readmin", { action: "confirm", requestId: a }), 409, "same_person");
    await ok(call("/api/companies/seed", "readmin", { action: "refuse", requestId: a }));
    const b = (await ok(call("/api/companies/seed", "re2", { action: "propose", text: file("Fake Third Co\temployer\tFake Third\t") }))).requestId;
    await ok(call("/api/companies/seed", "ad2", { action: "refuse", requestId: b }));
    expect((await su.query("select status from approval_request where id = any($1::bigint[]) order by id", [[a, b]])).rows.map((r) => r.status)).toEqual(["withdrawn", "refused"]);
    expect((await su.query("select count(*)::int n from organisation where display_name = 'Fake Third Co'")).rows[0].n).toBe(0);
  });
  it("refuses a bad file whole, saying which lines, and stores hostile names as plain text", async () => {
    const bad = await call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: file("Fake Bad Co\tnot_a_kind\tFake Bad\t") });
    expect([bad.status, bad.json.error, bad.json.stage]).toEqual([400, "bad_data", 'line 2: kind must be employer, public_body, agency, found "not_a_kind"']);
    await no(call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: "wrong header\n" }), 400, "bad_data");
    await no(call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: HEAD + "\n" }), 400, "bad_data");
    for (const text of ["", 5, null, ["x"]]) await no(call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text }), 400, "bad_text");
    await no(call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: "x".repeat(1_000_001) }), 400, "bad_text");
    await no(call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: "x" }, { length: "2000000" }), 400, "bad_body");
    const hostile = "Fake Co'); drop table organisation; --";
    const p = (await ok(call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: file(`${hostile}\temployer\t<script>x</script> Fake\t`) }))).requestId;
    await ok(call("/api/companies/seed", "ad2", { action: "confirm", requestId: p }));
    expect((await su.query("select count(*)::int n from organisation where display_name = $1", [hostile])).rows[0].n).toBe(1);
  });
  it("the database holds app_admin's seed writes to a confirmed company_seed request used once, in the same transaction", async () => {
    const asAdmin = async (fn: (c: pg.PoolClient) => Promise<unknown>) => {
      const c = await db.pool("app_admin").connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad2]);
        return await fn(c);
      } finally { await c.query("rollback"); c.release(); }
    };
    const insOrg = "insert into organisation(slug, display_name, kind, signup_path) values ('fake-direct-co', 'Fake Direct Co', 'employer', 'admin')";
    await expect(asAdmin((c) => c.query(insOrg))).rejects.toThrow(/two-person rule: organisation rows are added only by a confirmed company_seed request/);
    const org = (await su.query("select id from organisation limit 1")).rows[0].id;
    await expect(asAdmin((c) => c.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Fake Direct', 'fake direct', 'alias', 'admin')", [org])))
      .rejects.toThrow(/two-person rule: organisation_name rows are added only/);
    // a used request cannot be used again (the second apply), a pending one or another kind cannot be used at all
    const used = (await su.query("select id::text from approval_request where kind = 'company_seed' and status = 'confirmed' and applied_at is not null limit 1")).rows[0].id;
    await expect(asAdmin((c) => c.query("select private.use_company_seed($1)", [used]))).rejects.toThrow(/already used/);
    const pending = (await ok(call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: file("Fake Direct Co\temployer\tFake Direct\t") }))).requestId;
    await expect(asAdmin((c) => c.query("select private.use_company_seed($1)", [pending]))).rejects.toThrow(/is pending, not confirmed/);
    const setting = (await su.query("select id::text from approval_request where kind = 'setting' and status = 'confirmed' limit 1")).rows[0].id;
    await expect(asAdmin((c) => c.query("select private.use_company_seed($1)", [setting]))).rejects.toThrow(/needs company_seed|already used/);
    for (const role of ["app_portal", "app_candidate", "app_fetcher", "anon", "authenticated"] as const)
      await expect(db.query(role, "select private.use_company_seed($1)", [pending]), role).rejects.toMatchObject({ code: "42501" });
    await expect(asAdmin((c) => c.query("update approval_request set applied_at = now() where id = $1", [pending]))).rejects.toMatchObject({ code: "42501" });
    await ok(call("/api/companies/seed", "only_rules_data_editor", { action: "refuse", requestId: pending }));
    expect((await su.query("select count(*)::int n from organisation where display_name = 'Fake Direct Co'")).rows[0].n).toBe(0);
  });
  it("refuses every other role", async () => {
    for (const who of ["only_account_reviewer", "only_fetched_job_reviewer", "only_trust_and_safety", "only_services_case_handler", "only_content_editor", "norole"]) {
      await no(call("/api/companies/seed", who), 403, "not_seed_staff");
      await no(call("/api/companies/seed", who, { action: "propose", text: file("Fake X Co\temployer\tFake X\t") }), 403, "not_rules_data_editor");
      await no(call("/api/companies/seed", who, { action: "confirm", requestId: "1" }), 403, "not_administrator");
      await no(call("/api/companies/seed", who, { action: "refuse", requestId: "1" }), 403, "not_seed_staff");
    }
    await no(call("/api/companies/seed", "only_administrator", { action: "propose", text: file("Fake X Co\temployer\tFake X\t") }), 403, "not_rules_data_editor");
  });
});

describe("Q14: the stale guides", () => {
  it("lists published guides not checked for STALE_DAYS, oldest first, to the content roles only", async () => {
    const ins = (slug: string, days: number, status = "published", kind = "guide") => su.query(
      "insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at) values ($1, $2, 'Fake', 'Fake body', 'https://example.test/s', current_date - $3::int, $4, now())",
      [kind, slug, days, status]);
    await ins("fresh", 10);
    await ins("old", 400);
    await ins("stale", STALE_DAYS + 1);
    await ins("edge", STALE_DAYS);
    await ins("withdrawn-old", 500, "withdrawn");
    await ins("update-old", 500, "published", "update");
    const r = await call("/api/content", "only_content_editor", undefined, { query: "?stale=1" });
    expect([r.status, r.json.staleDays, r.json.items.map((i: { slug: string }) => i.slug), replyProblems(spec, "GET", "/api/content", r.status, r.json)]).toEqual([200, STALE_DAYS, ["old", "stale"], []]);
    for (const who of ["only_rules_data_editor", "only_administrator"]) await ok(call("/api/content", who, undefined, { query: "?stale=1" }));
    for (const who of ["only_account_reviewer", "only_fetched_job_reviewer", "only_trust_and_safety", "only_services_case_handler", "norole"])
      await no(call("/api/content", who, undefined, { query: "?stale=1" }), 403, "not_content_staff");
    for (const q of ["?stale=0", "?stale=1&kind=guide", "?stale=1&stale=1", "?stale=yes"]) await no(call("/api/content", "only_content_editor", undefined, { query: q }), 400, "bad_query");
  });
});

describe("performance", () => {
  it("each route and the daily command stay inside their statement, time and page budgets", async () => {
    // bulk: 300 open reminders of each role and 3,000 done items, 2,000 open items of another queue less than a day old, 300 published guides
    await su.query("insert into review_item(queue, reason, detail, created_at) select 'scheduled_check', 'bulk', jsonb_build_object('key', 'bulk:' || g, 'role', (array['rules_data_editor','fetched_job_reviewer','administrator'])[1 + g % 3]), now() - (g || ' minutes')::interval from generate_series(1, 900) g");
    await su.query("insert into review_item(queue, reason, detail, status, created_at) select 'scheduled_check', 'bulk', jsonb_build_object('key', 'done:' || g, 'role', 'rules_data_editor'), 'done', now() - interval '30 days' from generate_series(1, 3000) g");
    await su.query("insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at) select 'guide', 'bulk-' || g, 'Fake', 'Fake body', 'https://example.test/s', current_date - (g % 400), 'published', now() from generate_series(1, 300) g");
    // 2,000 approval requests, half still pending, a tenth of those older than a working day
    const ac = await su.connect();
    try {
      await ac.query("select set_config('app.staff_user_id', $1, false)", [h.staff.only_administrator]);
      await ac.query("insert into approval_request(kind, target_table, target_id, change, reason) select 'pay_floor', 'pay_floor', 'bulk:' || g, '{}', 'bulk' from generate_series(1, 2000) g");
      await ac.query("select set_config('app.staff_user_id', $1, false)", [h.staff.ad2]);
      await ac.query("update approval_request set status = 'refused' where target_id like 'bulk:%' and right(target_id, 1) in ('0','2','4','6','8')");
      await ac.query("update approval_request set created_at = now() - interval '9 days' where target_id like 'bulk:%' and right(target_id, 2) in ('11','31','51','71','91')");
    } finally { ac.release(); }
    await su.query("analyze review_item; analyze content_page; analyze approval_request");
    const done = (await su.query("select id::text from review_item where queue = 'scheduled_check' and status = 'open' and detail->>'role' = 'rules_data_editor' order by id limit 20")).rows.map((r) => r.id);
    const counts = [
      (await counted(() => call("/api/scheduled-checks", "only_rules_data_editor")))[1],
      (await counted(() => call("/api/scheduled-checks", "only_rules_data_editor", { action: "done", itemId: done[0] })))[1],
      (await counted(() => call("/api/overdue", "only_administrator")))[1],
      (await counted(() => call("/api/settings", "only_administrator")))[1],
      (await counted(() => call("/api/content", "only_content_editor", undefined, { query: "?stale=1" })))[1],
    ];
    expect(counts).toEqual([BUDGET.scheduledList, BUDGET.scheduledDone, BUDGET.overdue, BUDGET.settingsList, BUDGET.stale]);
    const [p, proposeN] = await counted(() => call("/api/settings", "only_administrator", { action: "propose", key: "fetch_run", value: 6 }));
    const [, confirmN] = await counted(() => call("/api/settings", "ad2", { action: "confirm", requestId: p.json.requestId }));
    const [, seedN] = await counted(() => call("/api/companies/seed", "only_rules_data_editor", { action: "propose", text: "display_name\tkind\tbrand_names\tdete_names\nFake Perf Co\temployer\tFake Perf\t\n" }));
    const seedPending = (await su.query("select id::text from approval_request where kind = 'company_seed' and status = 'pending'")).rows[0].id;
    const [, seedConfirmN] = await counted(() => call("/api/companies/seed", "only_administrator", { action: "confirm", requestId: seedPending }));
    expect([proposeN, confirmN, seedN, seedConfirmN]).toEqual([BUDGET.settingPropose, BUDGET.settingConfirm, BUDGET.seedPropose, BUDGET.seedConfirm]);
    const measured: Record<string, number> = {};
    for (const [path, who, q] of [["/api/scheduled-checks", "only_rules_data_editor", ""], ["/api/overdue", "only_administrator", ""], ["/api/settings", "only_administrator", ""], ["/api/content", "only_content_editor", "?stale=1"]] as const)
      expect(measured[path + q] = await median(() => ok(call(path, who, undefined, { query: q }))), path).toBeLessThan(BUDGET.ms);
    expect(measured.done = await median((i) => ok(call("/api/scheduled-checks", "only_rules_data_editor", { action: "done", itemId: done[i + 1] })))).toBeLessThan(BUDGET.ms);
    const client = await su.connect();
    try {
      for (const [name, text, values, budget] of [["scheduled list", SCHEDULED_LIST, [["rules_data_editor"]], BUDGET.pages.scheduled], ["overdue", OVERDUE, [workingDayBefore(new Date()).toISOString()], BUDGET.pages.overdue],
        ["overdue approvals", OVERDUE_APPROVALS, [workingDayBefore(new Date()).toISOString()], BUDGET.pages.overdueApprovals],
        ["stale guides", CONTENT_STALE, [STALE_DAYS], BUDGET.pages.stale]] as const) {
        const cost = await measurePages(client, [{ text, values: [...values] }]);
        measured[`${name} pages`] = cost[0]!.pages;
        assertPageBudget(name, cost, budget);
      }
    } finally { client.release(); }
    console.log("staff tools measured (ms, pages):", JSON.stringify(measured));
    const a = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
    await a.connect();
    try {
      const { writeReminders } = await import("../src/scheduled-checks-cli");
      const [, cliN] = await counted(() => writeReminders(a));
      expect(cliN).toBe(BUDGET.cliStatements);
      expect(await median(() => writeReminders(a))).toBeLessThan(BUDGET.cliMs);
    } finally { await a.end(); }
  });
});
