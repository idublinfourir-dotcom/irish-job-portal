/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 15 Q2: administrators act on a data request (queue data_request) through the real /api/data-requests handler: GET the open items and the
// pending erasures, POST export, close, erase_propose, erase_confirm and erase_refuse. Real staff sessions, the real test database as app_admin,
// private.data_request_account and private.data_request_erase (0050); stored files go from the fake file store. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportData } from "../src/candidate";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { portalExport } from "../src/self-service";
import { DATA_REQUESTS } from "../src/staff-tools";
import { createTestDb, type TestDb } from "./db";
import { fixtures, in30 } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { costOf } from "./perf/pages";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

// Statements through the route (requireStaff is 2): list = role check and two reads (5); export of a candidate = begin, role check, match,
// data, extras, audit, commit (9); a portal export one fewer (8); propose = begin, role check, match, insert, audit, commit (8); confirm = begin,
// role check, lock, confirm, erase, commit (8); close = begin, role check, close, commit (6). Medians measured 19 Nov 2026 (four runs, other agents
// running): export 4.5 to 6.9 ms, propose 2.9 to 3.7 ms, confirm 4.2 to 5.7 ms; limits about 3 times the highest. Among 2,000 other candidates, 2,000 portal logins and 2,000 other messages (planning + execution
// + serialisation, as app_admin): the list 46 pages, the match 54 pages (each email by its unique index); limits about 3 times.
const BUDGET = { list: 5, exportCandidate: 9, exportPortal: 8, propose: 8, confirm: 8, close: 6, exportMs: 20, proposeMs: 12, confirmMs: 20, listPages: 150, matchPages: 160 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool, store: MemoryStore;
let F: any, ins: any, src: string, org: string;
const spec = loadSpec("admin");
const PATH = "/api/data-requests";
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, PATH, who, body, o);
const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const one = async (sql: string, args: unknown[] = []) => (await rows(sql, args))[0];
const emailOf = async (table: "candidate_user" | "portal_user", id: string) => (await one(`select email from ${table} where id = $1`, [id])).email as string;
/** A data request message and its review item (the 0002 trigger makes it). `by` is a signed-in sender, or null for a visitor. */
async function request(email: string, by: { candidate?: string; portal?: string } = {}): Promise<{ item: string; msg: string }> {
  const msg = await ins("postgres", "contact_message", { surface: by.portal ? "portal" : "candidate_site", candidate_user_id: by.candidate ?? null,
    portal_user_id: by.portal ?? null, from_name: "Fake Sender", from_email: email, topic: "data_request", body: "Please act on my data" });
  return { item: (await one("select id::text from review_item where contact_message_id = $1", [msg])).id, msg };
}
const exportOf = async (itemId: string, who = "ad1") => {
  const r = await call(who, { action: "export", itemId });
  expect(replyProblems(spec, "POST", PATH, r.status, r.json)).toEqual([]);
  return r;
};
const propose = async (itemId: string, who = "ad1") => (await h.ok(call(who, { action: "erase_propose", itemId }))).requestId as string;
const confirm = (requestId: string, who = "ad2") => call(who, { action: "erase_confirm", requestId });
const status = async (id: string) => one("select status, applied_at is not null as used from approval_request where id = $1", [id]);
const item = async (id: string) => one("select status, outcome, candidate_user_id c, portal_user_id p, decided_by_staff_user_id by from review_item where id = $1", [id]);
const exists = async (table: string, id: string) => (await su.query(`select 1 from ${table} where id = $1`, [id])).rowCount === 1;
const job = () => ins("postgres", "job", { organisation_id: org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org", sector: "it",
  permit_type: "critical_skills", status: "live", closes_at: in30(), salary_low: 40000, search_vector: "'fake':1", application_route: "own_page", own_page_url: "https://example.test/job" });

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  ({ F, ins } = fixtures(db) as any);
  route = (await import("../../../apps/admin/app/api/data-requests/route")) as unknown as Route;
  store = memoryStore();
  setFileStore(store);
  src = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
  org = await F.org();
  await h.makeStaff("ad1", ["administrator"]);
  await h.makeStaff("ad2", ["administrator"]);
  for (const r of ROLE_NAMES) if (r !== "administrator") await h.makeStaff(`only_${r}`, [r]);
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("the list", () => {
  it("shows the open items, oldest first, with the requester's email, and no closed one", async () => {
    const c = await F.cand();
    const a = await request("Visitor.Fake@Example.Test"), b = await request(await emailOf("candidate_user", c), { candidate: c });
    const r = await call("ad1");
    expect(replyProblems(spec, "GET", PATH, r.status, r.json)).toEqual([]);
    const mine = r.json.items.filter((x: any) => [a.item, b.item].includes(x.itemId));
    expect(mine).toEqual([
      { itemId: a.item, status: "open", createdAt: expect.any(String), surface: "candidate_site", email: "Visitor.Fake@Example.Test", signedIn: false },
      { itemId: b.item, status: "open", createdAt: expect.any(String), surface: "candidate_site", email: await emailOf("candidate_user", c), signedIn: true },
    ]);
    await h.ok(call("ad1", { action: "close", itemId: a.item }));
    expect((await h.ok(call("ad1"))).items.map((x: any) => x.itemId)).not.toContain(a.item);
  });
});

describe("export: the requester's own self-export, to the staff member only", () => {
  it("a candidate, matched by email whatever its case: the same sections as the self-export, one audit row, nothing emailed", async () => {
    const c = await F.cand();
    await su.query("insert into saved_job(candidate_user_id, job_id) values ($1,$2)", [c, await job()]);
    await su.query("insert into candidate_profile(candidate_user_id, full_name) values ($1,'Fake Person')", [c]);
    const { item: it1 } = await request((await emailOf("candidate_user", c)).toUpperCase());
    const outboxBefore = (await one("select count(*)::int n from email_outbox")).n;
    const r = await exportOf(it1);
    expect([r.status, r.json.kind, r.json.userId]).toEqual([200, "candidate", c]);
    const own = await exportData(db.pool("app_candidate"), c);
    expect(Object.keys(r.json.data).sort()).toEqual(Object.keys(own).sort());
    expect([r.json.data.account.email, r.json.data.profile.fullName, r.json.data.savedJobs.length]).toEqual([await emailOf("candidate_user", c), "Fake Person", 1]);
    expect((await one("select count(*)::int n from email_outbox")).n).toBe(outboxBefore);
    expect(await rows("select kind, actor_staff_user_id a, object_type t, object_id o, subject_candidate_user_id s, after from audit_event where action = 'data_request.export' and object_id = $1", [c]))
      .toEqual([{ kind: "data_access", a: h.staff.ad1, t: "candidate_user", o: c, s: c, after: { item_id: it1 } }]);
    // the person's own export now says staff accessed the data
    expect((await exportData(db.pool("app_candidate"), c)).whoAccessedOrReceivedYourData).toContainEqual({ by: "Portal staff", action: "data_request.export", at: expect.any(String) });
    expect(await item(it1)).toMatchObject({ status: "open" }); // an export does not close the item
  });
  it("a portal login: the same data as its own self-export", async () => {
    const p = await F.portal();
    await F.member(org, p, { role: "recruiter" });
    await su.query("insert into portal_session(id, token, user_id, expires_at, updated_at) values ($1, $2, $3, now() + interval '1 day', now())", [`s-${p}`, `tok-${p}`, p]);
    const { item: it1 } = await request(await emailOf("portal_user", p));
    const r = await exportOf(it1);
    expect([r.status, r.json.kind, r.json.userId]).toEqual([200, "portal", p]);
    const own = await portalExport(db.pool("app_portal"), `tok-${p}`);
    const strip = (x: any) => ({ ...x, exportedAt: null, yourActions: null });
    expect(strip(r.json.data)).toEqual(strip(JSON.parse(JSON.stringify(own))));
    expect(r.json.data.memberships).toHaveLength(1);
    expect(await rows("select object_type t, subject_candidate_user_id s from audit_event where action = 'data_request.export' and object_id = $1", [p])).toEqual([{ t: "portal_user", s: null }]);
  });
  it("refused: no account, a candidate and a portal login sharing the address, a signed-in sender naming another login, a closed item", async () => {
    await h.no(call("ad1", { action: "export", itemId: (await request("nobody.fake@example.test")).item }), 409, "no_account");
    const c = await F.cand(), mail = await emailOf("candidate_user", c);
    await F.portal({ email: mail });
    await h.no(call("ad1", { action: "export", itemId: (await request(mail)).item }), 409, "several_accounts");
    const c2 = await F.cand(), c3 = await F.cand();
    await h.no(call("ad1", { action: "export", itemId: (await request(await emailOf("candidate_user", c3), { candidate: c2 })).item }), 409, "sender_not_account");
    const closed = (await request(await emailOf("candidate_user", c2))).item;
    await h.ok(call("ad1", { action: "close", itemId: closed }));
    await h.no(call("ad1", { action: "export", itemId: closed }), 404, "not_found");
    // another queue's item is not a data request
    const other = (await one("insert into review_item(queue, job_id) values ('fetched_job', $1) returning id::text", [await job()])).id;
    await h.no(call("ad1", { action: "export", itemId: other }), 404, "not_found");
    expect((await one("select count(*)::int n from audit_event where action = 'data_request.export' and object_id = any($1)", [[c, c2, c3]])).n).toBe(0);
  });
});

describe("close", () => {
  it("closes an open item once, with an audit row", async () => {
    const { item: i1 } = await request("close.fake@example.test");
    expect(await h.ok(call("ad1", { action: "close", itemId: i1 }))).toEqual({ ok: true });
    expect(await item(i1)).toEqual({ status: "done", outcome: "answered", c: null, p: null, by: h.staff.ad1 });
    await h.no(call("ad1", { action: "close", itemId: i1 }), 404, "not_found");
    expect(await rows("select actor_staff_user_id a from audit_event where action = 'data_request.close' and object_id = $1", [i1])).toEqual([{ a: h.staff.ad1 }]);
  });
});

describe("erase: two administrators", () => {
  it("a visitor's request for a candidate: the account and its files go, the request message is emptied, the item closes, one audit row", async () => {
    const c = await F.cand();
    await su.query("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ($1,'cv/erase-me','cv.pdf','pdf',1000)", [c]);
    await store.put("cv/erase-me", new Uint8Array([1]), "application/pdf");
    const { item: i1, msg } = await request(await emailOf("candidate_user", c));
    const p = await call("ad1", { action: "erase_propose", itemId: i1 });
    expect(replyProblems(spec, "POST", PATH, p.status, p.json)).toEqual([]);
    expect(p.json).toEqual({ ok: true, kind: "candidate", userId: c, requestId: expect.any(String) });
    expect((await h.ok(call("ad2"))).pending).toContainEqual({ requestId: p.json.requestId, itemId: i1, kind: "candidate", userId: c, proposedBy: h.staff.ad1, createdAt: expect.any(String) });
    const r = await confirm(p.json.requestId);
    expect(replyProblems(spec, "POST", PATH, r.status, r.json)).toEqual([]);
    expect(r.json).toEqual({ ok: true, kind: "candidate", userId: c, filesRemoved: 1 });
    expect([await exists("candidate_user", c), store.objects.has("cv/erase-me")]).toEqual([false, false]);
    expect(await status(p.json.requestId)).toEqual({ status: "confirmed", used: true });
    expect(await item(i1)).toEqual({ status: "done", outcome: "erased", c: null, p: null, by: h.staff.ad2 });
    expect(await one("select from_name, from_email, body from contact_message where id = $1", [msg])).toEqual({ from_name: null, from_email: null, body: null });
    expect(await rows("select actor_staff_user_id a, second_staff_user_id s, after from audit_event where action = 'data_request.erase' and object_id = $1", [i1]))
      .toEqual([{ a: h.staff.ad2, s: h.staff.ad1, after: { kind: "candidate", request_id: p.json.requestId } }]);
    expect((await one("select count(*)::int n from audit_event where action = 'candidate.erase' and object_id like 'erased-%'")).n).toBeGreaterThan(0);
  });
  it("a signed-in portal login's own request: erased, its item closed", async () => {
    const pu = await F.portal();
    const { item: i1 } = await request(await emailOf("portal_user", pu), { portal: pu });
    expect(await h.ok(confirm(await propose(i1)))).toEqual({ ok: true, kind: "portal", userId: pu, filesRemoved: 0 });
    expect([await exists("portal_user", pu), (await item(i1)).status]).toEqual([false, "done"]);
  });
  it("refused at confirm, everything left as it was and the request pending: open case, open report, owner with members, item closed, match changed", async () => {
    const consent = async (c: string) => ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: await F.text("services_request") });
    const c1 = await F.cand();
    const { item: i1 } = await request(await emailOf("candidate_user", c1));
    const sc = await ins("postgres", "services_case", { candidate_user_id: c1, consent_record_id: await consent(c1) });
    const r1 = await propose(i1);
    await h.no(confirm(r1), 409, "open_services_case");
    expect([await status(r1), await exists("candidate_user", c1), (await item(i1)).status]).toEqual([{ status: "pending", used: false }, true, "open"]);
    await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'decided' where id = $1", [sc]);
    await h.ok(confirm(r1)); // closed: it goes through

    const c2 = await F.cand();
    const { item: i2 } = await request(await emailOf("candidate_user", c2));
    await su.query("insert into report(target_kind, target_candidate_user_id, reason) values ('profile',$1,'other')", [c2]);
    const r2 = await propose(i2);
    await h.no(confirm(r2), 409, "open_report");
    expect([await status(r2), await exists("candidate_user", c2)]).toEqual([{ status: "pending", used: false }, true]);

    const owner = await F.portal(), org2 = await F.org();
    await F.member(org2, owner, { role: "account_owner", signer: true }); await F.member(org2, await F.portal());
    const r3 = await propose((await request(await emailOf("portal_user", owner))).item);
    await h.no(confirm(r3), 409, "owner_with_members");
    expect(await exists("portal_user", owner)).toBe(true);

    const c4 = await F.cand();
    const { item: i4 } = await request(await emailOf("candidate_user", c4));
    const r4 = await propose(i4);
    await h.ok(call("ad1", { action: "close", itemId: i4 }));
    await h.no(confirm(r4), 409, "not_open");

    const c5 = await F.cand();
    const { item: i5 } = await request(await emailOf("candidate_user", c5));
    const r5 = await propose(i5);
    await F.portal({ email: await emailOf("candidate_user", c5) });
    await h.no(confirm(r5), 409, "several_accounts");
    expect([await status(r5), await exists("candidate_user", c5)]).toEqual([{ status: "pending", used: false }, true]);
  });
  it("the proposer cannot confirm; one pending erase per item; withdraw by the proposer, refuse by another; an ended request cannot be confirmed", async () => {
    const c = await F.cand();
    const { item: i1 } = await request(await emailOf("candidate_user", c));
    const req = await propose(i1);
    await h.no(confirm(req, "ad1"), 409, "same_person");
    await h.no(call("ad2", { action: "erase_propose", itemId: i1 }), 409, "decision_pending");
    await h.ok(call("ad1", { action: "erase_refuse", requestId: req }));
    expect(await status(req)).toEqual({ status: "withdrawn", used: false });
    await h.no(confirm(req), 409, "request_not_pending");
    const req2 = await propose(i1);
    await h.ok(call("ad2", { action: "erase_refuse", requestId: req2 }));
    expect(await status(req2)).toEqual({ status: "refused", used: false });
    expect(await exists("candidate_user", c)).toBe(true);
    expect(await rows("select action, actor_staff_user_id a, second_staff_user_id s from audit_event where action like 'data_request_erase.%' and object_id = $1 order by id", [i1])).toEqual([
      { action: "data_request_erase.propose", a: h.staff.ad1, s: null }, { action: "data_request_erase.withdraw", a: h.staff.ad1, s: null },
      { action: "data_request_erase.propose", a: h.staff.ad1, s: null }, { action: "data_request_erase.refuse", a: h.staff.ad2, s: h.staff.ad1 },
    ]);
  });
  it("the database itself: no erase without a confirmed request, the other app roles cannot call it, a request works once", async () => {
    const c = await F.cand();
    const req = await propose((await request(await emailOf("candidate_user", c))).item);
    const admin = db.pool("app_admin");
    await expect(admin.query("select private.data_request_erase($1::bigint)", [req])).rejects.toThrow(/two-person rule: request \d+ is pending/);
    for (const r of ["app_candidate", "app_portal", "app_fetcher"] as const) {
      await expect(db.pool(r).query("select private.data_request_erase($1::bigint)", [req])).rejects.toThrow(/permission denied/);
      await expect(db.pool(r).query("select private.data_request_account(1)")).rejects.toThrow(/permission denied/);
      await expect(db.pool(r).query("select private.portal_user_data('x')")).rejects.toThrow(/permission denied/);
    }
    await h.ok(confirm(req));
    const c2 = await admin.connect();
    try {
      await c2.query("begin");
      await c2.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad2]);
      await expect(c2.query("select private.data_request_erase($1::bigint)", [req])).rejects.toThrow(/was already used/);
    } finally { await c2.query("rollback"); c2.release(); }
  });
});

describe("security: roles, sessions, origin", () => {
  it("every other staff role is refused on the list and each action; signed out and a forged cookie are refused; a foreign origin is refused", async () => {
    const c = await F.cand();
    const { item: i1 } = await request(await emailOf("candidate_user", c));
    const req = await propose(i1);
    for (const r of ROLE_NAMES) if (r !== "administrator") {
      const who = `only_${r}`;
      await h.no(call(who), 403, "not_administrator");
      for (const body of [{ action: "export", itemId: i1 }, { action: "close", itemId: i1 }, { action: "erase_propose", itemId: i1 },
        { action: "erase_confirm", requestId: req }, { action: "erase_refuse", requestId: req }]) await h.no(call(who, body), 403, "not_administrator");
    }
    await h.no(call(null), 401, "no_session");
    await h.no(call(null, { action: "export", itemId: i1 }), 401, "no_session");
    await h.no(call(null, { action: "export", itemId: i1 }, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(call("ad2", { action: "erase_confirm", requestId: req }, { origin: "https://evil.example" }), 403, "bad_origin");
    await h.no(call("ad2", { action: "export", itemId: i1 }, { origin: null }), 403, "bad_origin");
    expect([await status(req), await exists("candidate_user", c), (await item(i1)).status]).toEqual([{ status: "pending", used: false }, true, "open"]);
    expect((await one("select count(*)::int n from audit_event where action = 'data_request.export' and object_id = $1", [c])).n).toBe(0);
  });
  it("hostile input: bad ids, wrong types, extra fields, unknown actions, long bodies, query keys", async () => {
    const bad: [unknown, number, string][] = [
      [{ action: "export", itemId: "1; drop table job" }, 400, "bad_item_id"],
      [{ action: "export", itemId: 7 }, 400, "bad_item_id"],
      [{ action: "export", itemId: "9".repeat(30) }, 400, "bad_item_id"],
      [{ action: "export" }, 400, "bad_item_id"],
      [{ action: "export", itemId: "99999999" }, 404, "not_found"],
      [{ action: "close", itemId: "99999999" }, 404, "not_found"],
      [{ action: "erase_propose", itemId: "99999999" }, 404, "not_found"],
      [{ action: "erase_confirm", requestId: "x' or '1'='1" }, 400, "bad_request_id"],
      [{ action: "erase_confirm", requestId: "99999999" }, 404, "not_found"],
      [{ action: "erase_refuse", requestId: ["1"] }, 400, "bad_request_id"],
      [{ action: "export", itemId: "1", email: "x@example.test" }, 400, "bad_body"],
      [{ action: "erase_everything", itemId: "1" }, 400, "bad_action"],
      [["export"], 400, "bad_body"],
    ];
    for (const [body, st, error] of bad) await h.no(call("ad1", body), st, error);
    await h.no(call("ad1", undefined, { raw: "{not json" }), 400, "bad_body");
    await h.no(call("ad1", undefined, { raw: JSON.stringify({ action: "export", itemId: "1", pad: "x".repeat(300) }) }), 400, "bad_body");
    await h.no(call("ad1", { action: "export", itemId: "1" }, { length: "100000" }), 400, "bad_body");
    await h.no(call("ad1", undefined, { query: "?id=1" }), 400, "bad_query");
    // a request of another kind is not an erase request
    const c = await su.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad1]);
      const other = (await c.query("insert into approval_request(kind, target_table, target_id) values ('setting','setting','dr-x') returning id::text")).rows[0].id;
      await c.query("commit");
      await h.no(confirm(other), 404, "not_found");
    } finally { c.release(); }
  });
});

describe("performance", () => {
  it("statements and median times inside budget", async () => {
    const cands: string[] = [], items: string[] = [];
    for (let i = 0; i < 11; i++) { const c = await F.cand(); cands.push(c); items.push((await request(await emailOf("candidate_user", c))).item); }
    const pu = await F.portal(), pItem = (await request(await emailOf("portal_user", pu))).item;
    const [, l] = await counted(() => h.ok(call("ad1")));
    const [, e] = await counted(() => h.ok(call("ad1", { action: "export", itemId: items[0] })));
    const [, ep] = await counted(() => h.ok(call("ad1", { action: "export", itemId: pItem })));
    const [req0, p] = await counted(() => propose(items[0]!));
    const [, cf] = await counted(() => h.ok(confirm(req0)));
    const [, cl] = await counted(() => h.ok(call("ad1", { action: "close", itemId: pItem })));
    expect([l, e, ep, p, cf, cl]).toEqual([BUDGET.list, BUDGET.exportCandidate, BUDGET.exportPortal, BUDGET.propose, BUDGET.confirm, BUDGET.close]);
    const em = await median((i) => h.ok(call("ad1", { action: "export", itemId: items[i + 1] })));
    const reqs: string[] = [];
    const pm = await median(async (i) => reqs.push(await propose(items[i + 1]!)));
    const cm = await median((i) => h.ok(confirm(reqs[i]!)));
    console.log(`data requests route: ${l} statements (list), ${e} (export), ${p} (propose), ${cf} (confirm); median ${em.toFixed(1)} ms export, ${pm.toFixed(1)} ms propose, ${cm.toFixed(1)} ms confirm`);
    expect(em).toBeLessThanOrEqual(BUDGET.exportMs);
    expect(pm).toBeLessThanOrEqual(BUDGET.proposeMs);
    expect(cm).toBeLessThanOrEqual(BUDGET.confirmMs);
  });
  it("pages of the list and the match among 2,000 other people and 2,000 other messages", async () => {
    await su.query("insert into candidate_user(id, name, email, email_verified, created_at, updated_at) select 'dr-bulk-' || g, 'Fake', 'dr-bulk-' || g || '@example.test', true, now(), now() from generate_series(1, 2000) g");
    await su.query("insert into portal_user(id, name, email, email_verified, created_at, updated_at) select 'dr-pbulk-' || g, 'Fake', 'dr-pbulk-' || g || '@example.test', true, now(), now() from generate_series(1, 2000) g");
    await su.query("insert into contact_message(surface, from_name, from_email, topic, body) select 'candidate_site', 'Fake', 'dr-other-' || g || '@example.test', 'general', 'Fake' from generate_series(1, 2000) g");
    await su.query("analyze");
    const target = (await request("dr-bulk-1000@example.test")).item;
    const c = await db.pool("app_admin").connect();
    const measure = async (sql: string, args: unknown[] = []) => {
      await c.query(`explain (analyze, buffers, serialize, format json) ${sql}`, args); // warm
      return costOf(sql, (await c.query(`explain (analyze, buffers, serialize, format json) ${sql}`, args)).rows[0]["QUERY PLAN"]);
    };
    try {
      const list = await measure(DATA_REQUESTS), match = await measure("select private.data_request_account($1::bigint)", [target]);
      for (const t of ["candidate_user", "portal_user"]) expect((await measure(`select id from ${t} where email = lower($1)`, ["x@example.test"])).scans).toBe(`${t}_email_key`);
      console.log(`data requests: list ${list.pages} pages (${list.scans}), match ${match.pages} pages`);
      expect(list.pages).toBeLessThanOrEqual(BUDGET.listPages);
      expect(match.pages).toBeLessThanOrEqual(BUDGET.matchPages);
    } finally { c.release(); }
  });
});
