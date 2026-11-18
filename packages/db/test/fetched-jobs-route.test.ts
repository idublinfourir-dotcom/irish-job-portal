// Integration: the fetched-job queue route (step 13d, #193, #234 D7) through the real /api/fetched-jobs handler, real staff sessions, the real test database as
// app_admin. List, item, claim, release, approve and reject over the existing queue functions; every read needs fetched_job_reviewer too, so an administrator, an
// account reviewer or any other role is refused. The rules data is the fetcher's own files (apps/admin/lib/queue-rules.ts). No network. Fake adverts and people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Measured on 13 November 2026 (requireStaff is 2 statements): list = role check + page (4 in all); claim = begin, acting staff, claim, commit (+2 = 6);
// approve = begin, acting staff, lock, write, commit (+2 = 7). Medians over 9 warm calls through the route: 1.9 to 2.5 ms (list), 1.9 to 2.4 (claim), 3.5 to 4.8 (approve: the
// rules chain runs); limits are about 4 times the slowest of three runs, with a floor for a busy laptop.
const BUDGET = { list: 4, claim: 6, approve: 7, listMs: 12, claimMs: 12, approveMs: 20 };
const PAY = "Join our team building fake things. The salary is €60,000 a year.";

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
let id: (prefix: string) => string;
let F: { org: () => Promise<number> };
const spec = loadSpec("admin");
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/fetched-jobs", who, body, o);
const act = (who: string | null, action: string, extra: object = {}) => call(who, { action, ...extra });
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);

beforeAll(async () => {
  db = await createTestDb();
  ({ id, F } = fixtures(db) as unknown as { id: typeof id; F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  route = await import("../../../apps/admin/app/api/fetched-jobs/route");
  for (const n of ["jr1", "jr2"]) await h.makeStaff(n, ["fetched_job_reviewer"]);
  for (const r of ROLE_NAMES) if (r !== "fetched_job_reviewer") await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["fetched_job_reviewer"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

/** A fetched job the fetcher queued, as postgres: the trigger makes its fetched_job item. */
async function queued(o: { title?: string; text?: string | null; county?: string | null; employer?: string } = {}) {
  const src = (await su.query("insert into job_source(kind, board) values ('greenhouse', $1) returning id", [id("b")])).rows[0].id;
  const title = o.title ?? "Fixed-term Platform Engineer";
  const advert = (await su.query(
    "insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason) values ($1, $2, 'https://jobs.example.test/a', $3, $4, 'queued', '7 contract unclear (admin queue)', 'title') returning id::text",
    [src, id("ext"), title, o.employer ?? "Acme Widgets"])).rows[0].id as string;
  const org = await F.org();
  const job = (await su.query(
    `insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
     values ($1, 'fetched', $2, $3, $4, 'Acme Widgets', $5, 'IT', '2134', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', $4), 'https://jobs.example.test/a') returning id::text`,
    [org, src, advert, title, o.county === undefined ? "Dublin" : o.county])).rows[0].id as string;
  if (o.text !== null) await su.query("insert into job_text(job_id, advert_text) values ($1, $2)", [job, o.text ?? PAY]);
  const item = (await su.query("select id::text from review_item where queue = 'fetched_job' and job_id = $1", [job])).rows[0].id as string;
  return { job, item };
}
const itemRow = async (item: string) => (await su.query("select status, claimed_by_staff_user_id by, decided_by_staff_user_id decided, outcome from review_item where id = $1", [item])).rows[0];
const jobRow = async (job: string) => (await su.query("select status, close_reason, badge, pass_route, occupation_code from job where id = $1", [job])).rows[0];

describe("access", () => {
  it("refuses a call with no session, a forged one and a disabled login", async () => {
    await no(call(null), 401, "no_session");
    await no(call("disabled"), 401, "not_active");
    await no(act("disabled", "claim", { itemId: "1" }), 401, "not_active");
    await no(call(null, undefined, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
  });
  it("refuses every role but fetched_job_reviewer on the list, the item and every action (an administrator and an account reviewer included), and changes nothing", async () => {
    const q = await queued();
    const bodies = [
      { action: "claim", itemId: q.item }, { action: "release", itemId: q.item }, { action: "approve", itemId: q.item, occupationCode: "2134", contractConfirmed: true },
      { action: "reject", itemId: q.item, reason: "duplicate" },
    ];
    for (const who of ROLE_NAMES.filter((r) => r !== "fetched_job_reviewer").map((r) => `only_${r}`).concat("norole")) {
      await no(call(who), 403, "not_reviewer");
      await no(call(who, undefined, { query: `?id=${q.item}` }), 403, "not_reviewer");
      for (const b of bodies) await no(call(who, b), 403, "not_reviewer");
    }
    expect(await itemRow(q.item)).toMatchObject({ status: "open", by: null });
    expect((await jobRow(q.job)).status).toBe("in_review");
    expect((await su.query("select count(*)::int n from audit_event where object_id = $1", [q.job])).rows[0].n).toBe(0);
  });
});

describe("list and item", () => {
  it("lists open and claimed items oldest first with a cursor, never another queue's item, and shows one item with its advert text", async () => {
    const mine = [];
    for (let i = 0; i < 24; i++) mine.push(await queued({ title: `Fixed-term Platform Engineer ${i}` }));
    const other = (await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'fake') returning id::text", [await F.org()])).rows[0].id;
    const seen: string[] = [];
    let query = "";
    for (;;) {
      const r = await ok(call("jr1", undefined, { query }));
      expect(r.items.length).toBeLessThanOrEqual(20);
      seen.push(...r.items.map((x: { id: string }) => x.id));
      if (!r.next) break;
      query = `?after=${r.next}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(other);
    const want = mine.map((m) => m.item);
    expect(seen.filter((s) => want.includes(s))).toEqual(want);
    const item = (await ok(call("jr2", undefined, { query: `?id=${mine[0]!.item}` }))).item;
    expect(item).toMatchObject({ id: mine[0]!.item, status: "open", title: "Fixed-term Platform Engineer 0", advertText: PAY, stage: "7 contract unclear (admin queue)" });
    for (const bad of [other, "999999999", "0", "-1", "1 or 1=1", "1e3", "99999999999999999999", "１２"]) await no(call("jr1", undefined, { query: `?id=${bad}` }), 404, "not_found");
    const forged = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const c of ["x", "!!!", "a".repeat(300), forged({ t: "now", i: "1" }), forged({ t: "2026-11-11 10:00:00+00", i: "1; drop table job" }), forged(null)]) await no(call("jr1", undefined, { query: `?after=${c}` }), 400, "bad_cursor");
    await no(call("jr1", undefined, { query: "?x=1" }), 400, "bad_query");
  });

  it("shows staff the WRC licensed agency flag on the list and the item (0042), and the reply matches docs/openapi/admin.yaml", async () => {
    await su.query("insert into wrc_licence(licence_number, agency_name, trading_name) values ('EA9901', 'Fake Listed Recruiters Limited', null) on conflict do nothing");
    const listed = await queued({ title: "Fixed-term Platform Engineer WRC", employer: "Fake Listed Recruiters Limited" });
    const plain = await queued({ title: "Fixed-term Platform Engineer plain" });
    const all: { id: string; wrcAgency: boolean }[] = [];
    for (let query = ""; ;) {
      const r = await call("jr1", undefined, { query });
      expect([r.status, replyProblems(spec, "GET", "/api/fetched-jobs", r.status, r.json)]).toEqual([200, []]);
      all.push(...r.json.items);
      if (!r.json.next) break;
      query = `?after=${r.json.next}`;
    }
    expect([listed.item, plain.item].map((i) => all.find((x) => x.id === i)?.wrcAgency)).toEqual([true, false]);
    const one = await call("jr1", undefined, { query: `?id=${listed.item}` });
    expect([one.json.item.wrcAgency, replyProblems(spec, "GET", "/api/fetched-jobs", one.status, one.json)]).toEqual([true, []]);
  });
});

describe("claim, release, approve, reject", () => {
  it("claims, releases and approves: the job goes live with the claimer's code, one audit row, only the claimer decides", async () => {
    const q = await queued();
    await ok(act("jr1", "claim", { itemId: q.item }));
    expect(await itemRow(q.item)).toMatchObject({ status: "claimed", by: h.staff.jr1 });
    await no(act("jr2", "claim", { itemId: q.item }), 409, "claimed_by_other");
    await no(act("jr2", "release", { itemId: q.item }), 409, "not_claimer");
    await no(act("jr2", "approve", { itemId: q.item, occupationCode: "2134", contractConfirmed: true }), 409, "not_claimer");
    await ok(act("jr1", "release", { itemId: q.item }));
    await no(act("jr1", "release", { itemId: q.item }), 409, "not_claimed");
    await no(act("jr1", "approve", { itemId: q.item, occupationCode: "2134", contractConfirmed: true }), 409, "not_claimed");
    await ok(act("jr2", "claim", { itemId: q.item }));
    const r = await ok(act("jr2", "approve", { itemId: q.item, occupationCode: "2134", contractConfirmed: true }));
    expect(r).toEqual({ ok: true, jobId: q.job, passRoute: "stated_pay" });
    expect(await jobRow(q.job)).toMatchObject({ status: "live", badge: "critical_skills_eligible", occupation_code: "2134", pass_route: "stated_pay" });
    expect(await itemRow(q.item)).toMatchObject({ status: "done", decided: h.staff.jr2, outcome: "approved" });
    await no(act("jr2", "approve", { itemId: q.item, occupationCode: "2134", contractConfirmed: true }), 409, "already_decided");
    const a = (await su.query("select action, actor_staff_user_id a from audit_event where object_type = 'job' and object_id = $1 order by id", [q.job])).rows;
    expect(a).toEqual([{ action: "fetched_job.approve", a: h.staff.jr2 }]);
  });
  it("the stage names the minimum in force from the database, not a fixed 40,904 (#229)", async () => {
    const q = await queued({ title: "Platform Engineer", text: "Salary €60,000.", county: null });
    await ok(act("jr1", "claim", { itemId: q.item }));
    const set = async (eur: number) => {
      await su.query("update rules_version set data = jsonb_set(data, '{criticalSkills}', to_jsonb($1::int)) where kind = 'minimums' and seeded_by_owner", [eur]);
      vi.setSystemTime(Date.now() + 6 * 60_000); // past the 5 minute rules cache
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await set(45000);
      const x = await call("jr1", { action: "approve", itemId: q.item, occupationCode: "2134", salaryLow: 42000 });
      expect([x.status, x.json]).toEqual([409, { error: "rules_failed", stage: "8 salary below €45,000" }]);
    } finally {
      await set(40904);
      const { getRules } = await import("../src");
      await getRules(su); // read the restored rules while the clock is ahead, so the real clock finds a fresh cache with 40,904
      vi.useRealTimers();
    }
    await ok(act("jr1", "reject", { itemId: q.item, reason: "salary_too_low" }));
  });
  it("a failed rules check is a 409 that names the stage, and the item stays claimed so the reviewer can reject it", async () => {
    const q = await queued({ title: "Platform Engineer", text: "Salary €60,000.", county: null });
    await ok(act("jr1", "claim", { itemId: q.item }));
    const x = await call("jr1", { action: "approve", itemId: q.item, occupationCode: "2134", salaryLow: 30000 });
    expect([x.status, x.json]).toEqual([409, { error: "rules_failed", stage: "8 salary below €40,904" }]);
    expect(await itemRow(q.item)).toMatchObject({ status: "claimed" });
    await ok(act("jr1", "reject", { itemId: q.item, reason: "salary_too_low" }));
    expect(await jobRow(q.job)).toMatchObject({ status: "closed", close_reason: "removed" });
    expect(await itemRow(q.item)).toMatchObject({ status: "done", outcome: "rejected", decided: h.staff.jr1 });
    const a = (await su.query("select action, reason_code from audit_event where object_type = 'job' and object_id = $1 order by id", [q.job])).rows;
    expect(a).toEqual([{ action: "fetched_job.reject", reason_code: "salary_too_low" }]);
  });
  it("refuses a code that is on neither list, an ineligible code, and a job with no saved advert", async () => {
    const q = await queued(), none = await queued({ text: null });
    await ok(act("jr1", "claim", { itemId: q.item })); await ok(act("jr1", "claim", { itemId: none.item }));
    await no(act("jr1", "approve", { itemId: q.item, occupationCode: "9999" }), 400, "bad_occupation_code");
    const bad = await call("jr1", { action: "approve", itemId: q.item, occupationCode: "1225" });
    expect([bad.status, bad.json.error]).toEqual([409, "rules_failed"]);
    await no(act("jr1", "approve", { itemId: none.item, occupationCode: "2134" }), 409, "no_advert_text");
    expect((await jobRow(q.job)).status).toBe("in_review");
  });
  it("two reviewers claiming at once: one wins", async () => {
    const q = await queued();
    const rs = await Promise.all([act("jr1", "claim", { itemId: q.item }), act("jr2", "claim", { itemId: q.item })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.json.error).toBe("claimed_by_other");
  });
});

describe("hostile requests", () => {
  it("refuses a missing or foreign Origin, a long body and bad JSON, and writes nothing", async () => {
    const q = await queued();
    const good = { action: "claim", itemId: q.item };
    await no(call("jr1", good, { origin: null }), 403, "bad_origin");
    await no(call("jr1", good, { origin: "https://evil.example.test" }), 403, "bad_origin");
    await no(call("jr1", good, { length: "100000" }), 400, "bad_body");
    await no(call("jr1", undefined, { raw: "x".repeat(700) }), 400, "bad_body");
    for (const raw of ["", "{", "null", "[]", "1", '"claim"']) await no(call("jr1", undefined, { raw }), 400, "bad_body");
    expect(await itemRow(q.item)).toMatchObject({ status: "open" });
  });
  it("refuses unknown actions, unknown fields and bad values", async () => {
    const q = await queued();
    await ok(act("jr1", "claim", { itemId: q.item }));
    for (const action of ["delete", "take_over", "toString", "__proto__", "", 5, null]) await no(call("jr1", { action, itemId: q.item }), 400, "bad_action");
    for (const extra of [{ status: "live" }, { jobId: "1" }, { badge: "x" }, { staffId: h.staff.jr2 }]) await no(call("jr1", { action: "claim", itemId: q.item, ...extra }), 400, "bad_body");
    await no(call("jr1", { action: "reject", itemId: q.item, reason: "duplicate", occupationCode: "2134" }), 400, "bad_body");
    for (const itemId of [5, null, "", "0", "01", "-1", "1.5", "1e3", "1 or 1=1", "12345678901234567890", ["1"]]) await no(call("jr1", { action: "claim", itemId }), 400, "bad_item_id");
    const a = { action: "approve", itemId: q.item };
    for (const code of [2134, null, "", "213", "21345", "21 34", "2134;", "٢١٣٤"]) await no(call("jr1", { ...a, occupationCode: code }), 400, "bad_occupation_code");
    for (const pay of [0, -5, 1.5, "50000", null, 1_000_001, Number.NaN]) await no(call("jr1", { ...a, occupationCode: "2134", salaryLow: pay }), 400, "bad_salary");
    await no(call("jr1", { ...a, occupationCode: "2134", contractConfirmed: "yes" }), 400, "bad_input");
    for (const reason of [undefined, "", "Bad", "has space", "1abc", "a;b", "a‮b", "a".repeat(64), 5, null]) await no(call("jr1", { action: "reject", itemId: q.item, ...(reason === undefined ? {} : { reason }) }), 400, "bad_reason");
    expect(await itemRow(q.item)).toMatchObject({ status: "claimed" });
    expect((await su.query("select count(*)::int n from audit_event where object_type = 'review_item' and object_id = $1 and action = 'fetched_job.take_over'", [q.item])).rows[0].n).toBe(0);
  });
});

describe("performance", () => {
  it("list, claim and approve stay inside their statement and time budgets", async () => {
    const items: Awaited<ReturnType<typeof queued>>[] = [];
    for (let i = 0; i < 30; i++) items.push(await queued());
    const [, listN] = await counted(() => call("jr1"));
    const [, claimN] = await counted(() => act("jr1", "claim", { itemId: items[0]!.item }));
    const [, approveN] = await counted(() => act("jr1", "approve", { itemId: items[0]!.item, occupationCode: "2134", contractConfirmed: true }));
    expect([listN, claimN, approveN]).toEqual([BUDGET.list, BUDGET.claim, BUDGET.approve]);
    expect(await median(() => call("jr1"))).toBeLessThan(BUDGET.listMs);
    expect(await median((i) => ok(act("jr1", "claim", { itemId: items[1 + i]!.item })))).toBeLessThan(BUDGET.claimMs);
    expect(await median((i) => ok(act("jr1", "approve", { itemId: items[1 + i]!.item, occupationCode: "2134", contractConfirmed: true })))).toBeLessThan(BUDGET.approveMs);
  });
});
