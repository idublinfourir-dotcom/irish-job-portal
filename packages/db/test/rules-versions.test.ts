// Integration: the rules versions (step 13 part 13a; #229, #230, #234 D9) on the real test database. The owner's seed, the loader across dates, the
// database's own guard, the real /api/rules handlers with real staff sessions (connected as app_admin), and the daily run. Companies, members, jobs
// and floors are written as postgres (every CHECK, foreign key and trigger still fires). No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedStaff } from "../src/staff-seed-cli";
import { IN_FORCE, loadRules, type Minimums } from "../src/rules-data";
import { NOTICES, PENDING } from "../src/rules-admin";
import { END_FLOORS, LIVE_STATED, QUOTA_FULL, runRules, UNDER_REVIEW } from "../src/rules-run-cli";
import { seedData, seedRules } from "../src/rules-seed-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures, in30 } from "./fixtures";
import { confirmedApproval, makeBig } from "./pay-floors-helpers";
import { assertPageBudget, measurePages } from "./perf/pages";
import * as R from "@portal/rules";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements counted on every pg.Client.query call, measured on 13 November 2026: requireStaff is 2 of each; list = role check + 3 reads (6);
// propose = begin, role check, version in force, insert, audit, commit (8); confirm of minimums = begin, role check, lock, confirm, insert version,
// notices, audit, commit (10); loadRules is one statement. Times are medians of 9 warm calls, limits about 4 times the measured one with a floor
// for a busy laptop (list measured 2.9 ms). Pages: the loader, the pending list, the run's job read and the notices on a database with 300 jobs,
// measured 7 + 7 + 321 + 41 = 376 (the run's read scans job: it runs once per new minimum, ponytail: an index on live portal jobs if that grows).
const BUDGET = { list: 6, propose: 8, confirm: 10, load: 1, listMs: 15, proposeMs: 30, confirmMs: 40, loadMs: 15, pages: 600, quotaPages: 1500, quotaTriggerPages: 10, quotaWriteMs: 130 }; // gap 3 (18 Nov 2026): trigger read 2 pages, a 300-row General write 32 ms
// The job_quota_full trigger's read, as written in migration 0045 (the trigger runs it once per General job written).
const QUOTA_LOOKUP = "select coalesce((select v.data->'generalQuotaFullCodes' from rules_version v where v.kind = 'minimums' and v.effective_from <= current_date " +
  "order by v.effective_from desc, v.id desc limit 1) ? $1::text, false) as full";

const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3002";
let db: TestDb, su: pg.Pool, today: string;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number>; staff(): Promise<string>; text(p?: string): Promise<number> };
let route: { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
let AUTH: (r: Request) => Promise<Response>;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: BASE, STAFF_AUTH_SECRET: secret });
  route = await import("../../../apps/admin/app/api/rules/route");
  ({ POST: AUTH } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
  today = (await su.query("select current_date::text d")).rows[0].d;
  await su.query("delete from rules_version"); // the test template carries the seed (global-setup.ts); these tests start before it
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

// ===== the owner's seed =====
describe("the owner's seed", () => {
  it("refuses to run as app_admin, and writes nothing", async () => {
    const c = await db.pool("app_admin").connect();
    try { await expect(seedRules(c)).rejects.toThrow(/database owner/); } finally { c.release(); }
    expect((await one("select count(*)::int n from rules_version")).n).toBe(0);
  });
  it("writes version 1 of each kind from 2026-03-01, which loads as exactly today's values; a second run is refused", async () => {
    const c = await su.connect();
    try {
      expect(await seedRules(c)).toHaveLength(5);
      await expect(seedRules(c)).rejects.toThrow(/already in the database/);
    } finally { c.release(); }
    expect((await su.query("select kind, effective_from::text f, seeded_by_owner s, run_at is not null r, approval_request_id a from rules_version order by id")).rows)
      .toEqual(["minimums", "critical_skills_list", "ineligible_list", "public_pay_employers", "big_company_names"].map((kind) => ({ kind, f: "2026-03-01", s: true, r: true, a: null })));
    const s = await loadRules(db.pool("app_fetcher"), today);
    expect(s.minimums).toEqual({ criticalSkills: 40904, graduate: 36848, graduateMonths: 12, nonList: 68911, nonListRoute: true, minContractMonths: 24, standardWeekHours: 39, checkedOn: R.RULES_CHECKED_ON });
    const data = seedData();
    expect(s.occupationLists).toEqual([...(data.critical_skills_list as object[]), ...(data.ineligible_list as object[])]);
    expect(s.publicPayEmployers).toEqual(data.public_pay_employers);
    expect(s.bigCompanyNames).toEqual([...R.BIG_COMPANY_BRANDS, ...R.BIG_COMPANY_LIST_150]);
    expect((await one("select action, actor_system from audit_event where action = 'rules.seed'"))).toMatchObject({ action: "rules.seed" });
  });
  it("every app role reads the versions; none but app_admin writes one, and nobody changes or deletes one", async () => {
    for (const r of ["app_fetcher", "app_portal", "app_candidate", "app_admin"] as const) expect((await db.query(r, "select count(*)::int n from rules_version")).rows[0].n, r).toBeGreaterThanOrEqual(5);
    for (const r of ["app_fetcher", "app_portal", "app_candidate"] as const)
      await expect(db.query(r, "insert into rules_version(kind, data, effective_from, approval_request_id) values ('minimums', '{}', current_date, null)"), r).rejects.toMatchObject({ code: "42501" });
    for (const r of ["app_fetcher", "app_portal", "app_candidate", "app_admin"] as const) {
      await expect(db.query(r, "update rules_version set data = '[]'"), r).rejects.toMatchObject({ code: "42501" });
      await expect(db.query(r, "delete from rules_version"), r).rejects.toMatchObject({ code: "42501" });
    }
    await expect(db.query("app_admin", "insert into rules_version(kind, data, effective_from, seeded_by_owner) values ('minimums', '{}', current_date, true)")).rejects.toMatchObject({ code: "42501" });
  });
});

// ===== staff, with real sessions =====
const PW = "Fake-rules-password-1";
const staff: Record<string, string> = {};
const cookies: Record<string, string> = {};
let ipn = 10;
async function makeStaff(name: string, roles: string[]) {
  const c = await su.connect();
  try {
    staff[name] = await seedStaff(c, { email: `${name}@example.test`, name: `Fake ${name}`, roles: roles.length ? roles : ["content_editor"] }, PW);
  } finally { c.release(); }
  if (roles.length === 0) await su.query("delete from staff_role where staff_user_id = $1", [staff[name]]);
  const res = await AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
    method: "POST", body: JSON.stringify({ email: `${name}@example.test`, password: PW }),
    headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${ipn++}` },
  }));
  expect(res.status, name).toBe(200);
  cookies[name] = res.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
}
const EDITORS = ["ed1", "ed2", "both"], ADMINS = ["ad1", "ad2", "both"], OTHERS = ["reviewer", "ts", "fetched", "content", "services", "norole"];
beforeAll(async () => {
  for (const n of ["ed1", "ed2"]) await makeStaff(n, ["rules_data_editor"]);
  for (const n of ["ad1", "ad2"]) await makeStaff(n, ["administrator"]);
  await makeStaff("both", ["rules_data_editor", "administrator"]);
  await makeStaff("reviewer", ["account_reviewer"]);
  await makeStaff("ts", ["trust_and_safety"]);
  await makeStaff("fetched", ["fetched_job_reviewer"]);
  await makeStaff("content", ["content_editor"]);
  await makeStaff("services", ["services_case_handler"]);
  await makeStaff("norole", []);
  await makeStaff("disabled", ["rules_data_editor", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [staff.disabled]); // after sign-in: the open session is refused too
});

type Reply = { status: number; json: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, body?: unknown, o: { origin?: string | null; raw?: string; cookie?: string; length?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = o.cookie ?? (who ? cookies[who] : undefined);
  if (cookie) headers.cookie = cookie;
  if (o.length) headers["content-length"] = o.length;
  const post = body !== undefined || o.raw !== undefined;
  if (post && o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await (post ? route.POST : route.GET)(new Request(`${BASE}/api/rules`, { method: post ? "POST" : "GET", body: post ? (o.raw ?? JSON.stringify(body)) : undefined, headers }));
  return { status: res.status, json: await res.json() };
}
const ok = async (r: Promise<Reply>) => { const x = await r; expect(x.status, JSON.stringify(x.json)).toBe(200); return x.json; };
const no = async (r: Promise<Reply>, status: number, error: string) => { const x = await r; expect([x.status, x.json.error], JSON.stringify(x.json)).toEqual([status, error]); };

const M: Minimums = { criticalSkills: 40904, graduate: 36848, graduateMonths: 12, nonList: 68911, nonListRoute: true, minContractMonths: 24, standardWeekHours: 39, checkedOn: "2026-11-12" };
const propose = (who: string, kind: string, effectiveFrom: string, data: unknown) => call(who, { action: "propose", kind, effectiveFrom, data });
const decide = (who: string, action: "confirm" | "refuse" | "withdraw", requestId: string) => call(who, { action, requestId: String(requestId) });
const requestRow = (id: string) => one("select status, proposed_by_staff_user_id p, confirmed_by_staff_user_id c, applied_at is not null applied from approval_request where id = $1", [id]);
const ineligible = async () => (await loadRules(su, today)).occupationLists.filter((o) => o.list === "ineligible");

describe("access: every role on every action", () => {
  it("refuses a call with no session, a forged cookie and a disabled login", async () => {
    await no(call(null), 401, "no_session");
    await no(call("disabled"), 401, "not_active");
    await no(propose("disabled", "minimums", today, M), 401, "not_active");
    await no(call(null, { action: "confirm", requestId: "1" }, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
  });
  it("every active staff member reads; only a rules data editor proposes; only an administrator decides; only the proposer withdraws", async () => {
    for (const who of [...EDITORS, ...ADMINS, ...OTHERS]) expect((await ok(call(who))).inForce.length, who).toBe(5);
    const data = { ...M, graduateMonths: 13 };
    for (const who of ["ad1", "ad2", ...OTHERS]) {
      await no(propose(who, "minimums", addDays(today, 400), data), 403, "not_rules_editor");
      await no(call(who, { action: "propose_flag", organisationId: "1" }), 403, "not_rules_editor");
    }
    const { requestId } = await ok(propose("ed1", "minimums", addDays(today, 400), data));
    for (const who of ["ed2", ...OTHERS]) {
      await no(decide(who, "confirm", requestId), 403, "not_administrator");
      await no(decide(who, "refuse", requestId), 403, "not_administrator");
    }
    for (const who of ["ed2", "ad1", "both", ...OTHERS]) await no(decide(who, "withdraw", requestId), 403, "not_proposer");
    expect(await requestRow(requestId)).toMatchObject({ status: "pending" });
    await ok(decide("ed1", "withdraw", requestId));
    expect(await requestRow(requestId)).toMatchObject({ status: "withdrawn" });
  });
});

describe("the query string", () => {
  it("GET takes no query keys: any key, repeated or not, is 400 bad_query", async () => {
    for (const q of ["?x=1", "?after=a", "?id=1&id=2", "?kind=minimums"]) {
      const res = await route.GET(new Request(`${BASE}/api/rules${q}`, { headers: { cookie: cookies.ed1! } }));
      expect([res.status, await res.json()], q).toEqual([400, { error: "bad_query" }]);
    }
  });
});

describe("propose, confirm, refuse", () => {
  it("an editor proposes a list change, shown as entries added, removed and changed; a different administrator confirms and it is in force from its date", async () => {
    const before = await ineligible();
    const after = [...before.slice(1).map((e, i) => (i === 0 ? { ...e, title: `${e.title} (changed)` } : e)), { id: "in-9901", code: "9901", title: "Fake new role", list: "ineligible" }];
    const from = addDays(today, 30);
    const p = await ok(propose("ed1", "ineligible_list", from, after));
    expect(Object.keys(p.change.added)).toEqual(["in-9901"]);
    expect(Object.keys(p.change.removed)).toEqual([before[0]!.id]);
    expect(Object.keys(p.change.changed)).toEqual([before[1]!.id]);
    const listed = (await ok(call("ad1"))).pending.find((x: { requestId: string }) => x.requestId === p.requestId);
    expect(listed).toMatchObject({ kind: "ineligible_list", effectiveFrom: from, proposedBy: staff.ed1 });
    expect(Object.keys(listed.change.added)).toEqual(["in-9901"]);
    await no(propose("ed2", "ineligible_list", addDays(today, 40), after), 409, "decision_pending"); // one proposal per kind at a time
    const c = await ok(decide("ad1", "confirm", p.requestId));
    expect(c.notices).toBe(0);
    expect(await requestRow(p.requestId)).toEqual({ status: "confirmed", p: staff.ed1, c: staff.ad1, applied: true });
    expect(await one("select kind, effective_from::text f, proposed_by_staff_user_id p, approval_request_id::text a from rules_version where id = $1", [c.versionId]))
      .toEqual({ kind: "ineligible_list", f: from, p: staff.ed1, a: p.requestId });
    expect((await loadRules(su, addDays(from, -1))).occupationLists.some((o) => o.id === "in-9901")).toBe(false);
    expect((await loadRules(su, from)).occupationLists.some((o) => o.id === "in-9901")).toBe(true);
    const r = await ok(call("ed2"));
    expect(r.upcoming.map((v: { versionId: string }) => v.versionId)).toContain(c.versionId);
    expect(r.inForce.find((v: { kind: string }) => v.kind === "ineligible_list").versionId).not.toBe(c.versionId);
    const audits = (await su.query("select action, actor_staff_user_id a, second_staff_user_id s from audit_event where action like 'rules.%' and after->>'request_id' = $1 order by id", [p.requestId])).rows;
    expect(audits).toEqual([{ action: "rules.propose", a: staff.ed1, s: null }, { action: "rules.confirm", a: staff.ad1, s: staff.ed1 }]);
  });
  it("the proposer cannot confirm or refuse, even holding both roles; a refused or decided request cannot be decided again", async () => {
    const { requestId } = await ok(propose("both", "minimums", addDays(today, 500), { ...M, graduate: 37000 }));
    await no(decide("both", "confirm", requestId), 409, "same_person");
    await no(decide("both", "refuse", requestId), 409, "same_person");
    await ok(decide("ad2", "refuse", requestId));
    expect(await requestRow(requestId)).toMatchObject({ status: "refused", c: staff.ad2, applied: false });
    for (const a of ["confirm", "refuse", "withdraw"] as const) await no(decide("ad1", a, requestId), 409, "not_pending");
    for (const id of ["987654321"]) await no(decide("ad1", "confirm", id), 404, "not_found");
  });
  it("refuses a date in the past, an unchanged version, bad data and a new big-company name without its link and dates", async () => {
    await no(propose("ed1", "minimums", addDays(today, -1), { ...M, graduate: 1 }), 409, "date_in_past");
    await no(propose("ed1", "minimums", "2027-02-30", M), 400, "bad_date");
    await no(propose("ed1", "minimums", addDays(today, 10), M), 409, "no_change");
    await no(propose("ed1", "unclear_role_list", addDays(today, 10), []), 400, "bad_kind");
    for (const data of [{ ...M, criticalSkills: 0 }, { ...M, criticalSkills: undefined }, { ...M, nonList: -5 }, [], {}, "x"]) await no(propose("ed1", "minimums", addDays(today, 10), data), 400, "bad_data");
    await no(propose("ed1", "ineligible_list", addDays(today, 10), []), 400, "bad_data");
    const names = (await one("select data from rules_version where kind = 'big_company_names' and seeded_by_owner")).data as object[];
    const r = await propose("ed1", "big_company_names", addDays(today, 10), [...names, { name: "fake newco", test: "250_staff", link: null, readOn: null, reviewOn: null }]);
    expect([r.status, r.json.error, r.json.detail]).toEqual([400, "bad_data", "fake newco: a new or changed name needs its link, date read and next review date"]);
    await no(propose("ed1", "big_company_names", addDays(today, 10), [...names, { name: "fake ltd", test: "250_staff", link: "https://example.test/a", readOn: today, reviewOn: addDays(today, 365) }]), 400, "bad_data");
    await ok(propose("ed1", "big_company_names", addDays(today, 10), [...names, { name: "fake newco", test: "250_staff", link: "https://example.test/a", readOn: today, reviewOn: addDays(today, 365) }]));
  });
  it("a proposal whose date has passed cannot be confirmed", async () => {
    const { requestId } = await ok(propose("ed1", "public_pay_employers", today, { ...(await loadRules(su, today)).publicPayEmployers, "fake public body": { tier: 1 } }));
    await su.query("update approval_request set change = jsonb_set(change, '{effective_from}', to_jsonb((current_date - 1)::text)) where id = $1", [requestId]);
    await no(decide("ad1", "confirm", requestId), 409, "date_passed");
  });
});

describe("the loader", () => {
  it("picks the version in force on each day, the later one winning on the same date", async () => {
    const a = addDays(today, 200), b = addDays(today, 300);
    for (const [from, cs] of [[a, 42000], [b, 43000], [b, 43500]] as const) {
      const { requestId } = await ok(propose("ed2", "minimums", from, { ...M, criticalSkills: cs }));
      await ok(decide("ad1", "confirm", requestId));
    }
    const at = async (d: string) => (await loadRules(su, d)).minimums.criticalSkills;
    expect([await at(addDays(a, -1)), await at(a), await at(addDays(b, -1)), await at(b), await at("2099-12-31")]).toEqual([40904, 42000, 42000, 43500, 43500]);
  });
  it("throws before the first version, on a bad day and when a version in force is broken", async () => {
    await expect(loadRules(su, "2026-02-28")).rejects.toThrow(/no .* version is in force on 2026-02-28/);
    await expect(loadRules(su, "2026-02-30")).rejects.toThrow(/not a date/);
    await expect(loadRules(su, "x'; drop table job; --")).rejects.toThrow(/not a date/);
    const c = await su.connect();
    try {
      await c.query("begin");
      await c.query("update rules_version set data = '[]' where kind = 'critical_skills_list' and seeded_by_owner");
      await expect(loadRules(c, today)).rejects.toThrow(/critical_skills_list version in force .* not valid .*empty/);
      await c.query("update rules_version set data = data - 'nonList' where kind = 'minimums' and seeded_by_owner");
      await expect(loadRules(c, "2026-03-01")).rejects.toThrow(/minimums version in force on 2026-03-01 is not valid/);
    } finally { await c.query("rollback"); c.release(); }
  });
});

describe("what the database holds even if a route were wrong", () => {
  const admin = async (fn: (c: pg.PoolClient) => Promise<void>) => {
    const c = await db.pool("app_admin").connect();
    try { await c.query("begin"); await c.query("select set_config('app.staff_user_id', $1, true)", [staff.both]); await fn(c); } finally { await c.query("rollback"); c.release(); }
  };
  it("app_admin cannot write a version without a confirmed request, with a request for another kind, or with data the request did not confirm", async () => {
    await admin(async (c) => { await expect(c.query("insert into rules_version(kind, data, effective_from) values ('minimums', $1, current_date)", [M])).rejects.toThrow(/two-person rule/); });
    await admin(async (c) => {
      const id = (await c.query("insert into approval_request(kind, target_table, target_id, change) values ('threshold','rules_version','minimums', $1) returning id", [{ data: M, effective_from: today }])).rows[0].id;
      await expect(c.query("insert into rules_version(kind, data, effective_from, approval_request_id) values ('minimums', $1, current_date, $2)", [M, id])).rejects.toThrow(/not confirmed/);
    });
    const change = { data: { ...M, graduate: 30000 }, effective_from: addDays(today, 3) };
    const rid = await confirmedApproval(su, F.staff, "threshold", "rules_version", "minimums");
    await su.query("update approval_request set change = $2 where id = $1", [rid, change]);
    await admin(async (c) => { await expect(c.query("insert into rules_version(kind, data, effective_from, approval_request_id) values ('minimums', $1, $2::date, $3)", [{ ...M, graduate: 1 }, change.effective_from, rid])).rejects.toThrow(/not the change the request confirmed/); });
    await admin(async (c) => { await expect(c.query("insert into rules_version(kind, data, effective_from, approval_request_id) values ('minimums', $1, $2::date, $3)", [change.data, addDays(today, 4), rid])).rejects.toThrow(/not the change/); });
    await admin(async (c) => { await expect(c.query("insert into rules_version(kind, data, effective_from, approval_request_id) values ('ineligible_list', $1, $2::date, $3)", [JSON.stringify(change.data), change.effective_from, rid])).rejects.toThrow(/two-person rule/); });
    await admin(async (c) => { await expect(c.query("insert into rules_version(kind, data, effective_from, approval_request_id) values ('minimums', $1, current_date - 1, $2)", [change.data, rid])).rejects.toThrow(/in the past/); });
    await admin(async (c) => {
      await c.query("insert into rules_version(kind, data, effective_from, approval_request_id) values ('minimums', $1, $2::date, $3)", [change.data, change.effective_from, rid]);
      await c.query("savepoint s");
      await expect(c.query("insert into rules_version(kind, data, effective_from, approval_request_id) values ('minimums', $1, $2::date, $3)", [change.data, change.effective_from, rid])).rejects.toThrow(/already used|duplicate/);
    });
  });
});

describe("the big-company flag (#230)", () => {
  it("an editor proposes it only for a company whose name matches a name in force; an administrator confirms; other companies are untouched", async () => {
    const match = await F.org({ name: "Pfizer Ireland Pharmaceuticals" }), other = await F.org({ name: "Pfizer Healthcare" }), none = await F.org({ name: "Fake Small Bakery" });
    const alias = await F.org({ name: "Fake Display" });
    await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Grant Thornton Ireland', 'grant thornton ireland fake', 'alias', 'admin')", [alias]);
    await no(call("ed1", { action: "propose_flag", organisationId: String(none) }), 409, "no_name_match");
    await no(call("ed1", { action: "propose_flag", organisationId: "987654321" }), 404, "not_found");
    const p = await ok(call("ed1", { action: "propose_flag", organisationId: String(match) }));
    await no(call("ed2", { action: "propose_flag", organisationId: String(match) }), 409, "decision_pending");
    expect((await ok(call("reviewer"))).pending.find((x: { requestId: string }) => x.requestId === p.requestId)).toMatchObject({ kind: "big_company_flag", organisationId: String(match), displayName: "Pfizer Ireland Pharmaceuticals" });
    await no(decide("ed2", "confirm", p.requestId), 403, "not_administrator");
    await ok(decide("ad2", "confirm", p.requestId));
    const flags = (await su.query("select id, is_big_company b from organisation where id = any($1) order by id", [[match, other, none, alias]])).rows.map((r) => r.b);
    expect(flags).toEqual([true, false, false, false]);
    await no(call("ed1", { action: "propose_flag", organisationId: String(match) }), 409, "already_big");
    const q = await ok(call("ed1", { action: "propose_flag", organisationId: String(alias) })); // matched by its name row, not its display name
    await ok(decide("ed1", "withdraw", q.requestId));
    expect((await one("select is_big_company b from organisation where id = $1", [alias])).b).toBe(false);
  });
});

// ===== the daily run =====
let src: number;
async function company(o: { big?: boolean } = {}) {
  const org = Number(await F.org({ name: `Fake Co ${Math.random().toString(36).slice(2, 8)}` }));
  const owner = await F.portal(), recruiter = await F.portal();
  const ownerM = Number(await F.member(org, owner, { role: "account_owner", signer: true }));
  const recM = Number(await F.member(org, recruiter, { role: "recruiter" }));
  if (o.big) await makeBig(su, F.staff, org);
  return { org, owner, recruiter, ownerM, recM };
}
async function job(c: { org: number; recM: number }, o: { status?: string; pay?: number | null; high?: number; hours?: number; code?: string; route?: string; source?: string } = {}) {
  return String((await one(
    "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, salary_high, weekly_hours, occupation_code, pass_route, search_vector, posted_by_membership_id) " +
    "values ($1, $2, $3, 'Fake role', 'Fake Co', 'it', 'critical_skills', $4, $5, 'https://example.test/j', $6, $7, $8, $9, $10, 'x', $11) returning id",
    [c.org, o.source ?? "employer", src, o.status ?? "live", in30(), o.pay === undefined ? 40904 : o.pay, o.high ?? null, o.hours ?? 39, o.code ?? "2136", o.route ?? "stated_pay", o.source === "fetched" ? null : c.recM])).id);
}
async function activeFloor(c: { org: number; ownerM: number }) {
  const text = await F.text("pay_floor");
  const id = (await one("insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, valid_until) values ($1, '5434', 40000, $2, $3, now() + interval '12 months') returning id", [c.org, text, c.ownerM])).id;
  const rid = await confirmedApproval(su, F.staff, "pay_floor", "pay_floor", id);
  await su.query("update pay_floor set status = 'active', approval_request_id = $2 where id = $1", [id, rid]);
  return String(id);
}
const status = async (id: string) => (await one("select status from job where id = $1", [id])).status;
const run = async () => { const c = await db.pool("app_admin").connect(); try { return await runRules(c); } finally { c.release(); } };

describe("the daily run and the notices (#234 D9)", () => {
  it("does nothing while the minimums in force were already applied (version 1 included)", async () => {
    expect(await run()).toMatchObject({ applied: false, underReview: 0, floorsEnded: 0, quotaChanged: 0 });
  });
  it("a minimums version confirmed for today: one notice per company with a live or draft job, then the run marks the jobs below it and ends every floor, once", async () => {
    src = Number((await one("select id from job_source where kind = 'portal' and board = 'employer'")).id);
    const a = await company({ big: true }), b = await company(), closedOnly = await company(), noJobs = await company(), allPass = await company();
    const fetchedSrc = Number((await one("insert into job_source(kind, board) values ('board', 'fake-board') returning id")).id);
    const jobs = {
      below: await job(a, { pay: 41000 }),
      atNew: await job(a, { pay: 42000 }),
      range: await job(a, { pay: 30000, high: 42000 }),
      hours: await job(b, { pay: 42000, hours: 40 }), // 40 hours need 43,076.92 at the new rate
      publicPay: await job(b, { pay: 1000, route: "public_pay" }),
      draft: await job(b, { status: "draft", pay: 1000 }),
      nonList: await job(b, { code: "9999", pay: 68911 }),
      closed: await job(closedOnly, { status: "closed", pay: 1000 }),
      general: await job(b, { code: "6145", pay: 33000 }), // a General post is not judged against the Critical Skills minimum
      passing: await job(allPass, { pay: 60000 }), // a company whose live jobs all pass: told about the new minimum, not about any job under review
    };
    await su.query("update job set permit_type = 'general' where id = $1", [jobs.general]);
    await su.query("update job set quota_full = true where id = $1", [jobs.general]); // S8: a stale mark (written alone, so the 0045 trigger leaves it) the new version (no General list) clears
    await su.query("update job set closed_at = now(), close_reason = 'closed' where id = $1", [jobs.closed]);
    const fetched = String((await one(
      "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, salary_low, pass_route, badge, search_vector, own_page_url) values ($1, 'fetched', $2, 'Fake', 'Fake', 'it', 'critical_skills', 'live', $3, 1000, 'stated_pay', 'critical_skills_eligible', 'x', 'https://example.test/f') returning id",
      [noJobs.org, fetchedSrc, in30()])).id);
    const floor = await activeFloor(a);

    const { requestId } = await ok(propose("ed1", "minimums", today, { ...M, criticalSkills: 42000 }));
    const c = await ok(decide("ad1", "confirm", requestId));
    expect(c.notices).toBe(3);
    const sent = (await su.query("select template, portal_user_id u, params->>'effectiveFrom' f from email_outbox where template = 'rules_minimums_changed' order by id")).rows;
    expect(sent.map((r) => r.u).sort()).toEqual([a.owner, b.owner, allPass.owner].sort()); // owners only: never the recruiter, never a company with no live or draft job
    expect(sent.every((r) => r.f === today)).toBe(true);
    // #93: the same people get a portal notice, one each, holding their own company's id and nothing else
    const notes = async (key: string) => (await su.query("select portal_user_id u, category, params, read_at from notification where template_key = $1 order by id", [key])).rows;
    const first = await notes("rules_minimums_changed");
    expect(first.map((r) => r.u).sort()).toEqual([a.owner, b.owner, allPass.owner].sort());
    expect(first.every((r) => r.category === "rules" && r.read_at === null && r.params.effectiveFrom === today && String(r.params.versionId) === c.versionId)).toBe(true);
    expect(first.find((r) => r.u === a.owner).params).toEqual({ organisationId: a.org, versionId: Number(c.versionId), effectiveFrom: today });
    const again = await db.pool("app_admin").query(NOTICES, [c.versionId, today]); // a second confirm of the same version cannot repeat either
    expect(again.rows[0].emails).toBe(0);
    expect((await notes("rules_minimums_changed")).length).toBe(3);

    const r = await run();
    expect(r).toEqual({ versionId: c.versionId, applied: true, underReview: 2, floorsEnded: 1, quotaChanged: 1 });
    expect((await one("select quota_full from job where id = $1", [jobs.general])).quota_full).toBe(false);
    expect(Object.fromEntries(await Promise.all(Object.entries(jobs).map(async ([k, id]) => [k, await status(id)])))).toEqual({
      below: "under_review", atNew: "live", range: "live", hours: "under_review", publicPay: "live", draft: "draft", nonList: "live", closed: "closed", general: "live", passing: "live",
    });
    expect(await status(fetched)).toBe("live");
    // gap 2: the move names its reason, which the employer's job list shows as 'pay_check'
    expect((await su.query("select under_review_reason r from job where id = any($1::bigint[])", [[jobs.below, jobs.hours]])).rows).toEqual([{ r: "pay_check" }, { r: "pay_check" }]);
    expect(await one("select status, ended_at is not null ended from pay_floor where id = $1", [floor])).toEqual({ status: "expired", ended: true });
    // N5: the floor's company owner hears it ended, once (ids only); not the recruiter, not another company
    const fp = { organisationId: a.org, floorId: Number(floor), versionId: Number(c.versionId) };
    expect(await notes("pay_floor_expired")).toEqual([{ u: a.owner, category: "rules", params: fp, read_at: null }]);
    expect((await su.query("select portal_user_id u, params, dedupe_key k from email_outbox where template = 'pay_floor_expired'")).rows).toEqual([{ u: a.owner, params: fp, k: `app_admin:pay_floor_expired:${floor}` }]);
    // the employer reads why: the company's own job list gives under_review the reason pay_check (0019)
    const list = (await su.query("select private.portal_jobs($1) j", [a.owner])).rows[0].j as { id: number; reason: string }[];
    expect(list.find((x) => String(x.id) === jobs.below)?.reason).toBe("pay_check");

    // #93: under_review_since is set on the two jobs and on no other; one email and one notice per company that has a job under review, naming its jobs
    expect((await su.query("select id::text id from job where under_review_since is not null order by id")).rows.map((x) => x.id)).toEqual([jobs.below, jobs.hours].sort((x, y) => Number(x) - Number(y)));
    const mails = (await su.query("select portal_user_id u, params, status from email_outbox where template = 'rules_jobs_under_review' order by id")).rows;
    expect(mails.map((m) => m.u).sort()).toEqual([a.owner, b.owner].sort()); // owners only; not allPass, closedOnly or noJobs; nothing is sent here
    expect(mails.every((m) => m.status === "pending")).toBe(true);
    expect(mails.find((m) => m.u === a.owner).params).toEqual({ organisationId: a.org, versionId: Number(c.versionId), count: 1, jobs: [{ id: Number(jobs.below), title: "Fake role" }], closeAfterDays: 30 });
    const under = await notes("rules_jobs_under_review");
    expect(under.map((m) => m.u).sort()).toEqual([a.owner, b.owner].sort());
    expect(under.find((m) => m.u === b.owner).params.jobs).toEqual([{ id: Number(jobs.hours), title: "Fake role" }]);
    // security: every notice goes to an account owner of the company it names, and the jobs it lists belong to that company
    const strays = await su.query(
      "select count(*)::int n from notification n where n.template_key in ('rules_minimums_changed','rules_jobs_under_review') and (not exists (select 1 from membership m where m.portal_user_id = n.portal_user_id " +
      "and m.role = 'account_owner' and m.organisation_id = (n.params->>'organisationId')::bigint) or exists (select 1 from jsonb_array_elements(coalesce(n.params->'jobs', '[]')) e join job j on j.id = (e->>'id')::bigint " +
      "where j.organisation_id <> (n.params->>'organisationId')::bigint))");
    expect(strays.rows[0].n).toBe(0);
    // the employer edits the salary (as the portal): the job is live again and no longer waits for the 30 days
    const restore = await db.pool("app_portal").query("update job set salary_low = 50000, status = 'live', posted_by_membership_id = $2 where id = $1 and organisation_id = $3", [jobs.below, a.recM, a.org]);
    expect(restore.rowCount).toBe(1);
    expect(await one("select status, under_review_since from job where id = $1", [jobs.below])).toEqual({ status: "live", under_review_since: null });
    expect((await one("select under_review_since is not null as since from job where id = $1", [jobs.hours])).since).toBe(true);

    // the same version cannot tell the same company twice: the restored job goes under review again, and no second email or notice is written
    expect((await db.pool("app_admin").query(UNDER_REVIEW, [[jobs.below], c.versionId])).rows[0].jobs).toBe(1);
    expect(await status(jobs.below)).toBe("under_review");
    expect((await su.query("select count(*)::int n from email_outbox where template = 'rules_jobs_under_review'")).rows[0].n).toBe(2);
    expect((await notes("rules_jobs_under_review")).length).toBe(2);

    expect(await run()).toEqual({ versionId: c.versionId, applied: false, underReview: 0, floorsEnded: 0, quotaChanged: 0 });
    expect((await su.query("select count(*)::int n from audit_event where action = 'rules.minimums_in_force'")).rows[0].n).toBe(1);
    // the floor step run twice on the same floor still writes one notice and one email (dedupe key per floor)
    const k = await su.connect();
    try { await k.query("set session_replication_role = replica"); await k.query("update pay_floor set status = 'active', ended_at = null where id = $1", [floor]); } finally { await k.query("reset session_replication_role"); k.release(); }
    expect((await db.pool("app_admin").query(END_FLOORS, [c.versionId])).rows[0].n).toBe(1);
    expect((await notes("pay_floor_expired")).length).toBe(1);
    expect((await su.query("select count(*)::int n from email_outbox where template = 'pay_floor_expired'")).rows[0].n).toBe(1);
  });
});

describe("the quota notice (S8, #85)", () => {
  const G = { general: R.GENERAL_MINIMUM, generalLower: R.GENERAL_LOWER_MINIMUM, generalLowerCodes: [...R.GENERAL_LOWER_CODES] };
  const marks = async (ids: Record<string, string>) => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, (await one("select quota_full from job where id = $1", [id])).quota_full])));
  it("a version that adds a code marks its open General jobs quota_full, and the next version without the code clears them; nothing else is touched", async () => {
    const c = await company();
    const jobs = {
      general: await job(c, { code: "6145", pay: 60000 }), otherCode: await job(c, { code: "5434", pay: 60000 }), critical: await job(c, { code: "6145", pay: 60000 }),
      draft: await job(c, { code: "6145", pay: 60000, status: "draft" }), closed: await job(c, { code: "6145", pay: 60000, status: "closed" }),
    };
    await su.query("update job set permit_type = 'general' where id = any($1::bigint[])", [[jobs.general, jobs.otherCode, jobs.draft, jobs.closed]]);
    await su.query("update job set closed_at = now(), close_reason = 'closed' where id = $1", [jobs.closed]);
    const version = async (codes: string[]) => { const { requestId } = await ok(propose("ed1", "minimums", today, { ...M, ...G, generalQuotaFullCodes: codes })); await ok(decide("ad1", "confirm", requestId)); };
    // the earlier test's live General job of 6145 is marked too: every open General job of the code, whoever's
    const open = async (code: string) => (await one("select count(*)::int n from job where permit_type = 'general' and occupation_code = $1 and status <> 'closed'", [code])).n;
    const [n6145, n5434] = [await open("6145"), await open("5434")];
    expect(n6145).toBeGreaterThanOrEqual(2);
    await version(["6145"]);
    expect(await run()).toMatchObject({ applied: true, quotaChanged: n6145 });
    expect(await marks(jobs)).toEqual({ general: true, otherCode: false, critical: false, draft: true, closed: false });
    const audit = await one("select after from audit_event where action = 'rules.minimums_in_force' order by id desc limit 1");
    expect(audit.after.quota_changed).toBe(n6145);
    await version(["5434"]);
    expect(await run()).toMatchObject({ applied: true, quotaChanged: n6145 + n5434 }); // the 6145 marks cleared, the 5434 ones set
    expect(await marks(jobs)).toEqual({ general: false, otherCode: true, critical: false, draft: false, closed: false });
    expect(await run()).toMatchObject({ applied: false, quotaChanged: 0 });
  });
  it("only app_admin (the rules run's login) may write quota_full: the portal, the fetcher and the candidate site are refused", async () => {
    const c = await company();
    const id = await job(c, { pay: 60000 });
    for (const role of ["app_portal", "app_fetcher", "app_candidate"] as const)
      await expect(db.pool(role).query("update job set quota_full = true where id = $1", [id]), role).rejects.toThrow(/permission denied/);
    expect((await one("select quota_full from job where id = $1", [id])).quota_full).toBe(false);
  });
});

describe("hostile requests", () => {
  it("refuses a missing or foreign Origin, a long body, bad JSON, unknown fields and control characters in data, and writes nothing", async () => {
    const n = async () => (await one("select count(*)::int n from approval_request where status = 'pending'")).n;
    const before = await n();
    const good = { action: "propose", kind: "minimums", effectiveFrom: addDays(today, 900), data: { ...M, graduate: 30001 } };
    await no(call("ed1", good, { origin: null }), 403, "bad_origin");
    await no(call("ed1", good, { origin: "https://evil.example.test" }), 403, "bad_origin");
    await no(call("ed1", good, { origin: BASE + ".evil.test" }), 403, "bad_origin");
    await no(call("ed1", good, { length: "10000000" }), 400, "bad_body");
    await no(call("ed1", undefined, { raw: "x".repeat(300_001) }), 400, "bad_body");
    for (const raw of ["", "{", "null", "[]", "1"]) await no(call("ed1", undefined, { raw }), 400, "bad_body");
    await no(call("ed1", { ...good, status: "confirmed" }), 400, "bad_body");
    await no(call("ed1", { ...good, data: { ...good.data, checkedOn: "2026-11-12‮" } }), 400, "bad_data");
    const list = await ineligible();
    await no(propose("ed1", "ineligible_list", addDays(today, 900), [...list, { id: "in-9902", code: "9902", title: "Fake\u0007role", list: "ineligible" }]), 400, "bad_data");
    await no(propose("ed1", "ineligible_list", addDays(today, 900), [...list, { id: "in-9903", code: "9903", title: "Fake'); drop table job; --", list: "critical-skills" }]), 400, "bad_data");
    for (const requestId of ["0", "1 or 1=1", "-1", "1;drop table job"]) await no(call("ad1", { action: "confirm", requestId }), 400, "bad_id");
    expect(await n()).toBe(before);
  });
});

describe("performance", () => {
  async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
    const q = pg.Client.prototype.query;
    let n = 0;
    pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
    try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
  }
  const median = async (fn: (i: number) => Promise<unknown>) => {
    const ms = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(i); ms.push(performance.now() - t); }
    return ms.sort((a, b) => a - b)[4]!;
  };
  it("list, propose, confirm and the loader stay inside their statement, time and page budgets", async () => {
    const c = await company();
    for (let i = 0; i < 300; i++) await job(c, { pay: 50000 + i });
    const graduate = (i: number) => ({ ...M, criticalSkills: 42000, graduate: 30000 + i });
    const [, listN] = await counted(() => call("ed1"));
    const [p, proposeN] = await counted(() => ok(propose("ed1", "minimums", addDays(today, 1000), graduate(0))));
    const [, confirmN] = await counted(() => ok(decide("ad1", "confirm", p.requestId)));
    const [, loadN] = await counted(() => loadRules(db.pool("app_fetcher"), today));
    expect([listN, proposeN, confirmN, loadN]).toEqual([BUDGET.list, BUDGET.propose, BUDGET.confirm, BUDGET.load]);
    expect(await median(() => call("ed1"))).toBeLessThan(BUDGET.listMs);
    const ids: string[] = [];
    expect(await median(async (i) => ids.push((await ok(propose("ed1", "minimums", addDays(today, 1001 + i), graduate(i + 1)))).requestId) && ok(decide("ad1", "confirm", ids[i]!)))).toBeLessThan(BUDGET.proposeMs + BUDGET.confirmMs);
    expect(await median(() => loadRules(db.pool("app_fetcher"), today))).toBeLessThan(BUDGET.loadMs);
    const client = await su.connect();
    try {
      await client.query("begin");
      const costs = await measurePages(client, [{ text: IN_FORCE, values: [today] }, PENDING, LIVE_STATED, { text: NOTICES, values: [1, today] }]);
      assertPageBudget("rules: loader, pending list, run's job read, notices", costs, BUDGET.pages);
      // S8: the quota step reads every open job once (it runs once per new minimums version) and writes only the rows that change
      assertPageBudget("rules: quota step", await measurePages(client, [{ text: QUOTA_FULL, values: [["2136"]] }]), BUDGET.quotaPages);
      // gap 3: the job_quota_full trigger's read (0045), here with over 1,000 minimums versions, and its cost on a write of 300 General jobs
      const trig = await measurePages(client, [{ text: QUOTA_LOOKUP, values: ["2136"] }]);
      assertPageBudget("rules: quota trigger read", trig, BUDGET.quotaTriggerPages);
      expect(trig[0]!.scans).toContain("rules_version_in_force_idx");
      const writeMs = await median(async (i) => { await client.query("update job set permit_type = $2 where organisation_id = $1", [c.org, i % 2 ? "critical_skills" : "general"]); });
      console.log(`quota trigger: ${trig[0]!.pages} pages; 300-row write median ${writeMs.toFixed(1)} ms`);
      expect(writeMs).toBeLessThan(BUDGET.quotaWriteMs);
    } finally { await client.query("rollback"); client.release(); }
  });
});
