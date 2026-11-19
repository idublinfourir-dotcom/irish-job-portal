// Integration: the held employer and agency job queues (step 15 Q1, #244) through the real /api/employer-jobs handler, real staff sessions and the real
// test database as app_admin. Jobs are written as app_portal, so the real job_guard and job_queue_review (migration 0028) decide the status and the
// items. Roles: scam_flag for trust_and_safety, the other two for account_reviewer, all three for an administrator. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { fixtures } from "./fixtures";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { WRC_LAPSE } from "../src/wrc-import";
import { BASE, counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements, requireStaff's 2 included: list and item 4 (roles, page); claim 7 (begin, roles, lock, claim, commit); approve 7 (begin, roles, lock,
// one write, commit); reject 8 (the item and its audit row, then the job). Medians over 9 warm calls through the route, three runs on 17 Nov 2026:
// list 3.7 to 5.8 ms, item 3.3 to 4.0, claim 3.2 to 4.5, approve 4.7 to 6.2, reject 4.7 to 5.3. Limits are about 4 times the slowest run.
const BUDGET = { list: 4, item: 4, claim: 7, approve: 7, reject: 8, listMs: 24, itemMs: 16, claimMs: 18, approveMs: 25, rejectMs: 22 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool, portal: pg.Pool;
let id: (prefix: string) => string;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number> };
let src: string;
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/employer-jobs", who, body, o);
const act = (who: string | null, action: string, extra: object = {}) => call(who, { action, ...extra });
const get = (who: string | null, query: string) => call(who, undefined, { query });
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);

beforeAll(async () => {
  db = await createTestDb();
  ({ id, F } = fixtures(db) as unknown as { id: typeof id; F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  portal = db.pool("app_portal");
  route = await import("../../../apps/admin/app/api/employer-jobs/route");
  src = (await su.query("select id::text from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  for (const r of ROLE_NAMES) await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("ts2", ["trust_and_safety"]);
  await h.makeStaff("ar2", ["account_reviewer"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["trust_and_safety", "account_reviewer", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  await su.query("insert into organisation_name(name, normalised_name, kind, source) values ('Fake Known Client Limited', 'fake known client limited', 'alias', 'dete')");
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

/** A company and one of its posters. */
async function company(o: { kind?: string; restricted?: boolean } = {}) {
  const org = await F.org({ kind: o.kind ?? "agency" });
  if (o.restricted) {
    // a strike 2 restriction set straight on the row (the organisation guard allows it only inside a strike 2 approval), as jobs-route.test.ts does
    const k = await su.connect();
    try {
      await k.query("begin");
      await k.query("set local session_replication_role = replica");
      await k.query("update organisation set restricted_until = now() + interval '60 days' where id = $1", [org]);
      await k.query("commit");
    } finally { k.release(); }
  }
  const mem = await F.member(org, await F.portal(), { role: "recruiter" });
  return { org, mem };
}
/** A job posted as app_portal, the way the portal route writes it: `status` is what the portal asks for (live, or in_review when the rules were unsure). */
async function post(c: { org: number; mem: number }, o: { client?: string | null; status?: string } = {}) {
  const client = o.client === undefined ? "Fake Payments Limited" : o.client;
  const r = (await portal.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, salary_low, status, closes_at, search_vector,
       own_page_url, permit_employer_kind, permit_employer_name, posted_by_membership_id)
     values ($1, 'agency', $2, 'Fake Platform Engineer', 'Fake Recruitment', 'Dublin', 'it', '2134', 'critical_skills', 60000, $3, now() + interval '29 days', to_tsvector('english', 'fake'),
       'https://example.test/apply', $4, $5, $6) returning id::text, status`,
    [c.org, src, o.status ?? "live", client ? "client" : "self", client, c.mem])).rows[0];
  await portal.query("insert into job_text(job_id, advert_text) values ($1, 'Fake advert text. The salary is 60,000 a year.')", [r.id]);
  return r as { id: string; status: string };
}
const items = async (job: string) =>
  (await su.query("select id::text, queue, status, outcome from review_item where job_id = $1 order by queue", [job])).rows as { id: string; queue: string; status: string; outcome: string | null }[];
const itemOf = async (job: string, queue: string) => (await items(job)).find((i) => i.queue === queue)!.id;
const jobRow = async (job: string) => (await su.query("select status, close_reason, posted_at is not null as posted from job where id = $1", [job])).rows[0];

describe("holding a job (migration 0028)", () => {
  it("a client not found in DETE: held on publish with only its agency_client_check item; a found client goes live with none", async () => {
    const c = await company();
    const held = await post(c);
    expect(held.status).toBe("in_review");
    expect(await items(held.id)).toEqual([{ id: expect.any(String), queue: "agency_client_check", status: "open", outcome: null }]);
    const found = await post(c, { client: "Fake Known Client Limited" });
    expect(found.status).toBe("live");
    expect(await items(found.id)).toEqual([]);
    const draft = await post(c, { status: "draft" });
    expect(await items(draft.id)).toEqual([]); // a draft queues nothing
    await portal.query("update job set status = 'live' where id = $1", [draft.id]); // publish
    expect((await jobRow(draft.id)).status).toBe("in_review");
    expect((await items(draft.id)).map((i) => i.queue)).toEqual(["agency_client_check"]);
  });
  it("a restricted company's job gets post_strike_job_review; an unsure-rules job gets scam_flag; a not-found client the rules also flagged gets both", async () => {
    const r = await post(await company({ restricted: true }), { client: null });
    expect(r.status).toBe("in_review");
    expect((await items(r.id)).map((i) => i.queue)).toEqual(["post_strike_job_review"]);
    const c = await company();
    const unsure = await post(c, { client: null, status: "in_review" });
    expect((await items(unsure.id)).map((i) => i.queue)).toEqual(["scam_flag"]);
    const both = await post(c, { status: "in_review" });
    expect((await items(both.id)).map((i) => i.queue)).toEqual(["agency_client_check", "scam_flag"]);
  });
  it("the 30-day close still closes a held job, and drops its open items", async () => {
    const held = await post(await company());
    await su.query("update job set closes_at = now() - interval '1 minute' where id = $1", [held.id]);
    await db.query("app_admin", "select private.expire_employer_jobs()");
    expect(await jobRow(held.id)).toMatchObject({ status: "closed", close_reason: "expired" });
    expect(await items(held.id)).toEqual([{ id: expect.any(String), queue: "agency_client_check", status: "dropped", outcome: "job_closed" }]);
  });
});

describe("approve and reject", () => {
  it("approve makes the job live with one audit row; only the claimer decides; a second approve is already decided", async () => {
    const held = await post(await company());
    const item = await itemOf(held.id, "agency_client_check");
    await ok(act("only_account_reviewer", "claim", { itemId: item }));
    await no(act("ar2", "claim", { itemId: item }), 409, "claimed_by_other");
    await no(act("ar2", "approve", { itemId: item }), 409, "not_claimer");
    await no(act("ar2", "reject", { itemId: item, reason: "fake_client" }), 409, "not_claimer");
    await no(act("ar2", "release", { itemId: item }), 409, "not_claimer");
    expect(await ok(act("only_account_reviewer", "approve", { itemId: item }))).toEqual({ ok: true, jobId: held.id, jobStatus: "live" });
    expect(await jobRow(held.id)).toMatchObject({ status: "live", posted: true });
    expect(await items(held.id)).toEqual([{ id: item, queue: "agency_client_check", status: "done", outcome: "approved" }]);
    await no(act("only_account_reviewer", "approve", { itemId: item }), 409, "already_decided");
    await no(act("only_account_reviewer", "reject", { itemId: item, reason: "fake_client" }), 409, "already_decided");
    await no(act("only_account_reviewer", "claim", { itemId: item }), 409, "already_decided");
    const a = (await su.query("select action, actor_staff_user_id a, changed_columns c, after from audit_event where object_type = 'job' and object_id = $1 order by id", [held.id])).rows;
    expect(a).toEqual([{ action: "agency_client_check.approve", a: h.staff.only_account_reviewer, c: ["status"], after: { status: "live" } }]);
  });
  it("approving one of two items keeps the job in review; the second makes it live (an administrator may decide both queues)", async () => {
    const j = await post(await company(), { status: "in_review" });
    const scam = await itemOf(j.id, "scam_flag"), client = await itemOf(j.id, "agency_client_check");
    await ok(act("only_trust_and_safety", "claim", { itemId: scam }));
    expect(await ok(act("only_trust_and_safety", "approve", { itemId: scam }))).toMatchObject({ jobStatus: "in_review" });
    expect((await jobRow(j.id)).status).toBe("in_review");
    await ok(act("only_administrator", "claim", { itemId: client }));
    expect(await ok(act("only_administrator", "approve", { itemId: client }))).toMatchObject({ jobStatus: "live" });
    expect((await jobRow(j.id)).status).toBe("live");
  });
  it("approving a post-strike job lifts nothing else: the company stays restricted and its next job is held again", async () => {
    const c = await company({ restricted: true });
    const j = await post(c, { client: null });
    const item = await itemOf(j.id, "post_strike_job_review");
    await ok(act("only_account_reviewer", "claim", { itemId: item }));
    await ok(act("only_account_reviewer", "approve", { itemId: item }));
    expect((await jobRow(j.id)).status).toBe("live");
    expect((await su.query("select restricted_until > now() r from organisation where id = $1", [c.org])).rows[0].r).toBe(true);
    expect((await post(c, { client: null })).status).toBe("in_review");
  });
  it("an approve the job's own guards refuse (the company no longer verified) is a 409 and changes nothing", async () => {
    const c = await company();
    const j = await post(c);
    const item = await itemOf(j.id, "agency_client_check");
    await ok(act("only_account_reviewer", "claim", { itemId: item }));
    await su.query("update organisation set status = 'pending_review' where id = $1", [c.org]);
    await no(act("only_account_reviewer", "approve", { itemId: item }), 409, "company_not_active");
    expect((await jobRow(j.id)).status).toBe("in_review");
    expect((await items(j.id))[0]).toMatchObject({ status: "claimed" });
  });
  it("reject closes the job as removed, drops its other items, audits once, and the job never comes back", async () => {
    const c = await company();
    const j = await post(c, { status: "in_review" });
    const scam = await itemOf(j.id, "scam_flag");
    await ok(act("only_trust_and_safety", "claim", { itemId: scam }));
    await ok(act("only_trust_and_safety", "reject", { itemId: scam, reason: "asks_for_money" }));
    expect(await jobRow(j.id)).toMatchObject({ status: "closed", close_reason: "removed" });
    expect(await items(j.id)).toEqual([
      { id: expect.any(String), queue: "agency_client_check", status: "dropped", outcome: "job_closed" },
      { id: scam, queue: "scam_flag", status: "done", outcome: "rejected" },
    ]);
    const a = (await su.query("select action, reason_code from audit_event where object_type = 'job' and object_id = $1", [j.id])).rows;
    expect(a).toEqual([{ action: "scam_flag.reject", reason_code: "asks_for_money" }]);
    await expect(portal.query("update job set status = 'live' where id = $1", [j.id])).rejects.toThrow(/may not move a job from closed to live/);
  });
  it("two staff claiming at once: one wins; a release lets the other claim", async () => {
    const j = await post(await company());
    const item = await itemOf(j.id, "agency_client_check");
    const rs = await Promise.all([act("only_account_reviewer", "claim", { itemId: item }), act("ar2", "claim", { itemId: item })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = rs[0]!.status === 200 ? "only_account_reviewer" : "ar2", other = winner === "ar2" ? "only_account_reviewer" : "ar2";
    await ok(act(winner, "release", { itemId: item }));
    await no(act(winner, "release", { itemId: item }), 409, "not_claimed");
    await no(act(other, "approve", { itemId: item }), 409, "not_claimed");
    await ok(act(other, "claim", { itemId: item }));
  });
});

describe("licence_lapse_job (P9, #278)", () => {
  // An agency whose licence was just lapsed by the WRC import's own statement (as app_admin), with one live job and one held job.
  let nl = 0;
  async function lapsed() {
    const wrc = `EA77${++nl}`;
    const org = await F.org({ kind: "agency", wrc });
    const mem = await F.member(org, await F.portal(), { role: "recruiter" });
    const live = await post({ org, mem }, { client: null });
    const held = await post({ org, mem });
    expect([live.status, held.status]).toEqual(["live", "in_review"]);
    expect((await db.pool("app_admin").query(WRC_LAPSE, [[wrc], "2026-11-19"])).rows[0]).toEqual({ paused: 1, jobs: 1 });
    return { org, live: live.id, held: held.id, item: await itemOf(live.id, "licence_lapse_job") };
  }
  it("only the live job gets an item; account_reviewer and an administrator list it, other roles cannot; approve keeps the job live and audits once", async () => {
    const a = await lapsed();
    expect((await items(a.held)).map((i) => i.queue)).toEqual(["agency_client_check"]);
    const page = await ok(get("only_account_reviewer", "?queue=licence_lapse_job"));
    expect(page.items.find((i: { id: string }) => i.id === a.item)).toMatchObject({ queue: "licence_lapse_job", jobStatus: "live", companyStatus: "needs_info", reason: "agency licence not found" });
    await ok(get("only_administrator", "?queue=licence_lapse_job"));
    for (const r of ROLE_NAMES.filter((x) => x !== "account_reviewer" && x !== "administrator")) {
      await no(get(`only_${r}`, "?queue=licence_lapse_job"), 403, "not_reviewer");
      await no(get(`only_${r}`, `?id=${a.item}`), 403, "not_reviewer");
      await no(act(`only_${r}`, "claim", { itemId: a.item }), 403, "not_reviewer");
    }
    await no(get(null, "?queue=licence_lapse_job"), 401, "no_session");
    await no(get("disabled", "?queue=licence_lapse_job"), 401, "not_active");
    await ok(act("only_account_reviewer", "claim", { itemId: a.item }));
    await no(act("ar2", "approve", { itemId: a.item }), 409, "not_claimer");
    expect(await ok(act("only_account_reviewer", "approve", { itemId: a.item }))).toEqual({ ok: true, jobId: a.live, jobStatus: "live" });
    expect((await jobRow(a.live)).status).toBe("live");
    await no(act("only_account_reviewer", "approve", { itemId: a.item }), 409, "already_decided");
    const au = (await su.query("select action, changed_columns c, before, after from audit_event where object_type = 'job' and object_id = $1", [a.live])).rows;
    expect(au).toEqual([{ action: "licence_lapse_job.approve", c: [], before: { status: "live" }, after: { status: "live" } }]);
  });
  it("reject closes the live job as removed; an agency closing its own job drops the item", async () => {
    const a = await lapsed();
    await ok(act("only_administrator", "claim", { itemId: a.item }));
    await ok(act("only_administrator", "reject", { itemId: a.item, reason: "licence_lapsed" }));
    expect(await jobRow(a.live)).toMatchObject({ status: "closed", close_reason: "removed" });
    expect((await items(a.live)).find((i) => i.id === a.item)).toMatchObject({ status: "done", outcome: "rejected" });
    const b = await lapsed();
    await portal.query("update job set status = 'closed', closed_at = now(), close_reason = 'closed' where id = $1", [b.live]);
    expect((await items(b.live)).find((i) => i.id === b.item)).toMatchObject({ status: "dropped", outcome: "job_closed" });
  });
});

describe("list and item", () => {
  it("lists one queue oldest first with a cursor and the job, company and client fields; one item carries the advert text", async () => {
    const c = await company();
    const mine: string[] = [];
    for (let i = 0; i < 23; i++) mine.push(await itemOf((await post(c)).id, "agency_client_check"));
    const seen: string[] = [];
    let after = "";
    for (;;) {
      const r = await ok(get("only_account_reviewer", `?queue=agency_client_check${after}`));
      expect(r.items.length).toBeLessThanOrEqual(20);
      for (const x of r.items) expect(x.queue).toBe("agency_client_check");
      seen.push(...r.items.map((x: { id: string }) => x.id));
      if (!r.next) break;
      after = `&after=${r.next}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((s) => mine.includes(s))).toEqual(mine);
    const one = (await ok(get("only_administrator", `?id=${mine[0]}`))).item;
    expect(one).toMatchObject({
      id: mine[0], queue: "agency_client_check", status: "open", reason: "client not found in DETE", jobStatus: "in_review", source: "agency", title: "Fake Platform Engineer",
      organisationId: String(c.org), company: "Fake Org", companyStatus: "verified", restricted: false, clientName: "Fake Payments Limited", clientCheck: "not_found",
      advertText: "Fake advert text. The salary is 60,000 a year.",
    });
  });
});

describe("security", () => {
  it("no session, a forged one and a disabled login are refused", async () => {
    await no(get(null, "?queue=scam_flag"), 401, "no_session");
    await no(get("disabled", "?queue=scam_flag"), 401, "not_active");
    await no(act("disabled", "claim", { itemId: "1" }), 401, "not_active");
    await no(call(null, undefined, { cookie: "better-auth.session_token=forged", query: "?queue=scam_flag" }), 401, "no_session");
  });
  it("each queue is read and decided only by its role or an administrator; every other role is refused and nothing changes", async () => {
    const j = await post(await company(), { status: "in_review" });
    const scam = await itemOf(j.id, "scam_flag"), client = await itemOf(j.id, "agency_client_check");
    const bodies = (item: string) => [{ action: "claim", itemId: item }, { action: "release", itemId: item }, { action: "approve", itemId: item }, { action: "reject", itemId: item, reason: "fake" }];
    const refusedOn = async (who: string, queue: string, item: string) => {
      await no(get(who, `?queue=${queue}`), 403, "not_reviewer");
      await no(get(who, `?id=${item}`), 403, "not_reviewer");
      for (const b of bodies(item)) await no(call(who, b), 403, "not_reviewer");
    };
    await refusedOn("only_account_reviewer", "scam_flag", scam); // an account reviewer on a scam flag
    await refusedOn("only_trust_and_safety", "agency_client_check", client); // and the reverse
    await refusedOn("only_trust_and_safety", "post_strike_job_review", client);
    for (const r of ["fetched_job_reviewer", "rules_data_editor", "services_case_handler", "content_editor"]) for (const [q, i] of [["scam_flag", scam], ["agency_client_check", client]] as const) await refusedOn(`only_${r}`, q, i);
    for (const [q, i] of [["scam_flag", scam], ["agency_client_check", client]] as const) await refusedOn("norole", q, i);
    expect((await items(j.id)).map((i) => i.status)).toEqual(["open", "open"]);
    expect((await su.query("select count(*)::int n from audit_event where object_id in ($1, $2, $3)", [j.id, scam, client])).rows[0].n).toBe(0);
    for (const who of ["only_trust_and_safety", "only_administrator"]) await ok(get(who, "?queue=scam_flag"));
    for (const who of ["only_account_reviewer", "only_administrator"]) for (const q of ["agency_client_check", "post_strike_job_review"]) await ok(get(who, `?queue=${q}`));
  });
  it("an item of another queue (a fetched job's, an account review's, a fetched job's scam flag) is not found here", async () => {
    const org = await F.org();
    const fsrc = (await su.query("insert into job_source(kind, board) values ('greenhouse', $1) returning id", [id("b")])).rows[0].id;
    const fj = (await su.query(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, search_vector, own_page_url)
       values ($1, 'fetched', $2, 'Fake', 'Fake', 'it', 'critical_skills', 'in_review', 'infinity', to_tsvector('fake'), 'https://example.test/a') returning id::text`, [org, fsrc])).rows[0].id;
    const fetched = await itemOf(fj, "fetched_job");
    const fscam = (await su.query("insert into review_item(queue, job_id, reason) values ('scam_flag', $1, 'fake') returning id::text", [fj])).rows[0].id;
    const account = (await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'fake') returning id::text", [org])).rows[0].id;
    for (const item of [fetched, fscam, account]) {
      await no(get("only_administrator", `?id=${item}`), 404, "not_found");
      await no(act("only_administrator", "claim", { itemId: item }), 404, "not_found");
      await no(act("only_administrator", "approve", { itemId: item }), 404, "not_found");
    }
    expect((await ok(get("only_administrator", "?queue=scam_flag"))).items.map((x: { id: string }) => x.id)).not.toContain(fscam);
    expect((await su.query("select status from review_item where id = any($1::bigint[])", [[fetched, fscam, account]])).rows.map((r) => r.status)).toEqual(["open", "open", "open"]);
  });
  it("hostile input: bad ids, an unknown or missing queue, bad cursors, a huge reason, unknown fields, a wrong origin, an oversized body", async () => {
    const j = await post(await company());
    const item = await itemOf(j.id, "agency_client_check");
    for (const q of ["", "?queue=", "?queue=fetched_job", "?queue=account_review", "?queue=SCAM_FLAG", "?queue=scam_flag'--", "?queue=__proto__"]) await no(get("only_administrator", q), 400, "bad_queue");
    await no(get("only_administrator", "?queue=scam_flag&queue=scam_flag"), 400, "bad_query");
    await no(get("only_administrator", "?queue=scam_flag&x=1"), 400, "bad_query");
    for (const c of ["x", "!!!", "a".repeat(300), Buffer.from(JSON.stringify({ t: "now", i: "1" })).toString("base64url")]) await no(get("only_administrator", `?queue=scam_flag&after=${c}`), 400, "bad_cursor");
    for (const bad of ["999999999", "0", "-1", "1 or 1=1", "1e3", "99999999999999999999", "１２"]) await no(get("only_administrator", `?id=${bad}`), 404, "not_found");
    for (const itemId of [5, null, "", "0", "01", "-1", "1.5", "1 or 1=1", "12345678901234567890", ["1"]]) await no(call("only_administrator", { action: "claim", itemId }), 400, "bad_item_id");
    for (const action of ["delete", "take_over", "toString", "__proto__", "", 5, null]) await no(call("only_administrator", { action, itemId: item }), 400, "bad_action");
    for (const extra of [{ status: "live" }, { jobId: j.id }, { queue: "scam_flag" }, { staffId: h.staff.ar2 }]) await no(call("only_administrator", { action: "claim", itemId: item, ...extra }), 400, "bad_body");
    await ok(act("only_administrator", "claim", { itemId: item }));
    for (const reason of [undefined, "", "Bad", "has space", "1abc", "a;b", "a".repeat(64), "a".repeat(250), 5, null]) await no(call("only_administrator", { action: "reject", itemId: item, ...(reason === undefined ? {} : { reason }) }), 400, "bad_reason");
    await no(call("only_administrator", { action: "claim", itemId: item }, { origin: null }), 403, "bad_origin");
    await no(call("only_administrator", { action: "claim", itemId: item }, { origin: "https://evil.example.test" }), 403, "bad_origin");
    await no(call("only_administrator", { action: "claim", itemId: item }, { length: "100000" }), 400, "bad_body");
    await no(call("only_administrator", undefined, { raw: "x".repeat(400) }), 400, "bad_body");
    for (const raw of ["", "{", "null", "[]", "1", '"claim"']) await no(call("only_administrator", undefined, { raw }), 400, "bad_body");
    expect((await jobRow(j.id)).status).toBe("in_review");
    expect((await items(j.id))[0]).toMatchObject({ status: "claimed" });
  });
  it("app_portal cannot set its held job live, cannot write review items, cannot mark its client found, and cannot edit an in-review job live", async () => {
    const c = await company();
    const j = await post(c);
    await expect(portal.query("update job set status = 'live' where id = $1", [j.id])).rejects.toThrow(/may not move a job from in_review to live/);
    await expect(portal.query("update job set permit_employer_check = 'found', status = 'live' where id = $1", [j.id])).rejects.toThrow(/may not move a job from in_review to live/);
    await expect(portal.query("update job set title = 'Fake edited', status = 'live', posted_by_membership_id = $2 where id = $1", [j.id, c.mem])).rejects.toThrow(/may not move/);
    await expect(portal.query("update review_item set status = 'done', outcome = 'approved' where job_id = $1", [j.id])).rejects.toThrow(/permission denied/);
    await expect(portal.query("insert into review_item(queue, job_id, reason) values ('agency_client_check', $1, 'x')", [j.id])).rejects.toThrow(/permission denied/);
    await expect(portal.query("delete from review_item where job_id = $1", [j.id])).rejects.toThrow(/permission denied/);
    // a draft whose client is written 'found' by hand: job_defaults computes it again, so the publish is still held
    const d = await post(c, { status: "draft" });
    await portal.query("update job set permit_employer_check = 'found', status = 'live' where id = $1", [d.id]);
    expect((await su.query("select status, permit_employer_check from job where id = $1", [d.id])).rows[0]).toEqual({ status: "in_review", permit_employer_check: "not_found" });
    expect((await jobRow(j.id)).status).toBe("in_review");
  });
});

describe("performance", () => {
  it("list, item, claim, approve and reject stay inside their statement and time budgets", async () => {
    const c = await company();
    const held: string[] = [];
    for (let i = 0; i < 40; i++) held.push(await itemOf((await post(c)).id, "agency_client_check"));
    const who = "only_account_reviewer";
    const [, listN] = await counted(() => get(who, "?queue=agency_client_check"));
    const [, itemN] = await counted(() => get(who, `?id=${held[0]}`));
    const [, claimN] = await counted(() => act(who, "claim", { itemId: held[0] }));
    const [, approveN] = await counted(() => act(who, "approve", { itemId: held[0] }));
    await ok(act(who, "claim", { itemId: held[1] }));
    const [, rejectN] = await counted(() => act(who, "reject", { itemId: held[1], reason: "fake_client" }));
    expect([listN, itemN, claimN, approveN, rejectN]).toEqual([BUDGET.list, BUDGET.item, BUDGET.claim, BUDGET.approve, BUDGET.reject]);
    const ms: Record<string, number> = {
      list: await median(() => ok(get(who, "?queue=agency_client_check"))),
      item: await median((i) => ok(get(who, `?id=${held[2 + i]}`))),
      claim: await median((i) => ok(act(who, "claim", { itemId: held[2 + i] }))),
      approve: await median((i) => ok(act(who, "approve", { itemId: held[2 + i] }))),
    };
    for (let i = 0; i < 9; i++) await ok(act(who, "claim", { itemId: held[11 + i] }));
    Object.assign(ms, { reject: await median((i) => ok(act(who, "reject", { itemId: held[11 + i], reason: "fake_client" }))) });
    console.log("employer-jobs medians (ms)", JSON.stringify(ms));
    expect(ms.list).toBeLessThan(BUDGET.listMs);
    expect(ms.item).toBeLessThan(BUDGET.itemMs);
    expect(ms.claim).toBeLessThan(BUDGET.claimMs);
    expect(ms.approve).toBeLessThan(BUDGET.approveMs);
    expect(ms.reject).toBeLessThan(BUDGET.rejectMs);
  });
});

// Gap 4 (P8): the staff read of an agency job's written authority, GET /api/employer-jobs/authority. memoryStore() is the file store; no network.
// Statements, requireStaff's 2 included: list 4 (roles, the list); open 7 (begin, roles, the copy, the audit row, commit). Medians over 9 warm calls,
// 18 Nov 2026: list 2.9 ms, open 2.9 ms; limits about 4 times that with a floor.
describe("the written authority, for the staff who check agency jobs (gap 4)", () => {
  const AUTH_BUDGET = { list: 4, open: 7, listMs: 15, openMs: 20 };
  let authRoute: Route, store: MemoryStore;
  const raw = async (who: string | null, query: string) => authRoute.GET(new Request(`${BASE}/api/employer-jobs/authority${query}`, { headers: who ? { cookie: h.cookies[who]! } : {} }));
  const json = async (who: string | null, query: string) => { const r = await raw(who, query); return { status: r.status, json: await r.json() }; };
  const audits = async (doc: string) => (await su.query("select kind, actor_staff_user_id, role_in_force, action, object_type, after from audit_event where object_type = 'job_authority_document' and object_id = $1 order by id", [doc])).rows;
  async function withCopies(n = 2) {
    const c = await company();
    const j = await post(c);
    const docs: string[] = [];
    for (let i = 0; i < n; i++) {
      const key = `authority/fake-staff-${j.id}-${i}`;
      store.objects.set(key, { bytes: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" });
      docs.push((await su.query("insert into job_authority_document(job_id, organisation_id, uploaded_by_membership_id, storage_key, file_name, content_type, byte_size) values ($1, $2, $3, $4, $5, 'pdf', 4) returning id::text",
        [j.id, c.org, c.mem, key, `authority ${i}.pdf`])).rows[0].id);
    }
    return { c, job: j.id, docs };
  }
  beforeAll(async () => {
    authRoute = await import("../../../apps/admin/app/api/employer-jobs/authority/route");
    store = memoryStore();
    setFileStore(store);
  });

  it("an account reviewer or an administrator lists the copies and opens one through a 60-second link, each open one audit row", async () => {
    const { job, docs } = await withCopies();
    for (const who of ["only_account_reviewer", "only_administrator"]) {
      const l = await json(who, `?jobId=${job}`);
      expect(l.status).toBe(200);
      expect(l.json.documents.map((d: { id: string }) => d.id)).toEqual(docs);
      expect(l.json.documents[0]).toEqual({ id: docs[0], fileName: "authority 0.pdf", contentType: "pdf", sizeBytes: 4, uploadedAt: expect.any(String), copyDeleted: false });
      expect(replyProblems(loadSpec("admin"), "GET", "/api/employer-jobs/authority", 200, l.json)).toEqual([]);
    }
    const r = await raw("only_account_reviewer", `?jobId=${job}&docId=${docs[1]}`);
    expect([r.status, r.headers.get("cache-control"), r.headers.get("referrer-policy")]).toEqual([302, "no-store", "no-referrer"]);
    const u = new URL(r.headers.get("location")!);
    expect([u.pathname, u.searchParams.get("expires")]).toEqual([`/authority/fake-staff-${job}-1`, "60"]);
    await raw("only_administrator", `?jobId=${job}&docId=${docs[1]}`);
    expect(await audits(docs[1]!)).toEqual([
      { kind: "data_access", actor_staff_user_id: h.staff.only_account_reviewer, role_in_force: "account_reviewer", action: "job_authority.open", object_type: "job_authority_document", after: { jobId: job } },
      { kind: "data_access", actor_staff_user_id: h.staff.only_administrator, role_in_force: "administrator", action: "job_authority.open", object_type: "job_authority_document", after: { jobId: job } },
    ]);
    expect(await audits(docs[0]!)).toEqual([]); // listing writes none
  });

  it("security: every other role, no role, a disabled login and no session are refused with no audit row; hostile and wrong ids are 404 or 400", async () => {
    const { c, job, docs } = await withCopies(1);
    for (const r of ROLE_NAMES.filter((x) => x !== "account_reviewer" && x !== "administrator")) {
      expect([(await json(`only_${r}`, `?jobId=${job}`)).status, (await json(`only_${r}`, `?jobId=${job}`)).json.error], r).toEqual([403, "not_reviewer"]);
      expect((await raw(`only_${r}`, `?jobId=${job}&docId=${docs[0]}`)).status, r).toBe(403);
    }
    expect((await json("norole", `?jobId=${job}`)).json.error).toBe("not_reviewer");
    expect(await json("disabled", `?jobId=${job}&docId=${docs[0]}`)).toEqual({ status: 401, json: { error: "not_active" } });
    expect((await json(null, `?jobId=${job}&docId=${docs[0]}`)).status).toBe(401);
    expect(await audits(docs[0]!)).toEqual([]); // no refused call wrote a row
    const who = "only_account_reviewer";
    for (const q of ["", `?docId=${docs[0]}`, `?jobId=${job}&jobId=${job}`, `?jobId=${job}&x=1`]) expect((await json(who, q)).json.error, q).toBe("bad_query");
    for (const id of ["0", "x", "-1", "9223372036854775808", "1;drop table job", "'%00", "1".repeat(5000)]) {
      expect((await json(who, `?jobId=${encodeURIComponent(id)}`)).status, id).toBe(404);
      expect((await json(who, `?jobId=${job}&docId=${encodeURIComponent(id)}`)).status, id).toBe(404);
    }
    const other = await withCopies(1);
    expect((await json(who, `?jobId=${job}&docId=${other.docs[0]}`)).status).toBe(404); // a copy of another job
    const own = await post(c, { client: null }); // the agency's own job names no client
    expect((await json(who, `?jobId=${own.id}`)).status).toBe(404);
    await su.query("update job_authority_document set storage_key = null, file_name = null, copy_deleted_at = now() where id = $1", [docs[0]]);
    expect((await json(who, `?jobId=${job}`)).json.documents[0]).toMatchObject({ copyDeleted: true, fileName: null });
    expect((await json(who, `?jobId=${job}&docId=${docs[0]}`)).status).toBe(404); // a deleted copy has no link
    expect(await audits(docs[0]!)).toEqual([]);
    // storage off: 503 and no audit row (the link is made before the row is written)
    const two = await withCopies(1);
    setFileStore(undefined);
    const keep = Object.fromEntries(["FILES_S3_KEY_ID", "FILES_S3_SECRET", "FILES_S3_BUCKET", "FILES_S3_REGION"].map((k) => [k, process.env[k]]));
    for (const k of Object.keys(keep)) delete process.env[k];
    try {
      expect(await json(who, `?jobId=${two.job}&docId=${two.docs[0]}`)).toEqual({ status: 503, json: { error: "files_unavailable" } });
    } finally { Object.assign(process.env, Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined))); setFileStore(store); }
    expect(await audits(two.docs[0]!)).toEqual([]);
    // the admin login only reads the copies: no write on the table
    await expect(db.pool("app_admin").query("update job_authority_document set file_name = 'x' where id = $1", [two.docs[0]])).rejects.toThrow(/permission denied/);
  });

  it("performance: statements and time", async () => {
    const { job, docs } = await withCopies(20);
    const who = "only_account_reviewer";
    const [, listN] = await counted(() => raw(who, `?jobId=${job}`));
    const [, openN] = await counted(() => raw(who, `?jobId=${job}&docId=${docs[0]}`));
    expect([listN, openN]).toEqual([AUTH_BUDGET.list, AUTH_BUDGET.open]);
    const listMs = await median(() => raw(who, `?jobId=${job}`)), openMs = await median((i) => raw(who, `?jobId=${job}&docId=${docs[i]}`));
    console.log(`authority staff read: list ${listMs.toFixed(1)} ms, open ${openMs.toFixed(1)} ms`);
    expect(listMs).toBeLessThan(AUTH_BUDGET.listMs);
    expect(openMs).toBeLessThan(AUTH_BUDGET.openMs);
  });
});
