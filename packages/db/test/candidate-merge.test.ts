/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 15 C6: an administrator merges two candidate accounts of one person through the real /api/accounts handler (merge_propose, merge_confirm,
// merge_refuse, GET the pending list), real staff sessions and the real test database as app_admin; private.candidate_merge (0048) moves the rows,
// erases the dropped account and its stored files go from the fake file store. Launch B is switched on in this copy only, so applications and contact
// requests exist. No network. Fake people only.
import fs from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportData } from "../src/candidate";
import { caseTimeline } from "../src/services-board";
import { TRACKER_SQL } from "../src/services-request";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { createTestDb, type TestDb } from "./db";
import { fixtures, in30 } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { costOf } from "./perf/pages";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

// Statements through the route (requireStaff is 2): propose = begin, role check, two account reads, insert, audit, commit (9); confirm = begin, role
// check, lock, confirm, merge, commit (8); the list = role check and read (4). Medians measured 18 Nov 2026 (three runs): propose 3.2 to 3.7 ms, a small
// merge 7.5 to 8.7 ms; limits about 4 times that. One merge of a dropped account with 150 saved jobs, 150 tracker rows, 100 applications with messages
// and 10 alerts among 2,000 other people (planning + execution, as app_admin): measured 12,248 to 12,399 pages and 15 to 21 ms; the candidate-keyed
// tables are read by index (the sequential scans left are on tables of a few rows). Limits about 2.5 and 5 times that.
const BUDGET = { propose: 9, confirm: 8, list: 4, proposeMs: 15, confirmMs: 35, pages: 30_000, bigMs: 100 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool, store: MemoryStore;
let F: any, ins: any;
let src: string, org: string, org2: string, org3: string, org4: string, mem: string, mem2: string, appText: string, accText: string;
const spec = loadSpec("admin");
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/accounts", who, body, o);
const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const one = async (sql: string, args: unknown[] = []) => (await rows(sql, args))[0];
const job = () => ins("postgres", "job", { organisation_id: org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org", sector: "it",
  permit_type: "critical_skills", status: "live", closes_at: in30(), salary_low: 40000, search_vector: "'fake':1", application_route: "on_site" });
const consent = (c: string, t = appText) => ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: t });
const apply = async (c: string, j: string, key: string) =>
  ins("postgres", "application", { candidate_user_id: c, job_id: j, organisation_id: org, consent_record_id: await consent(c), cv_storage_key: key, cv_file_name: "cv.pdf" });
const save = (c: string, j: string) => su.query("insert into saved_job(candidate_user_id, job_id) values ($1,$2)", [c, j]);
const track = (c: string, j: string, stage: string) => su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1,$2,'redirect','mark_applied',$3)", [c, j, stage]);
const alerts = async (c: string, n: number) => { for (let i = 0; i < n; i++) await su.query("insert into alert(candidate_user_id, frequency, unsubscribe_token) values ($1,'daily',$2)", [c, `tok-${c}-${i}`]); };
const profile = (c: string, name: string) => su.query("insert into candidate_profile(candidate_user_id, full_name, visible_to_employers, visible_fields) values ($1,$2,true,'{full_name}')", [c, name]);
const cv = async (c: string, key: string) => {
  await su.query("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ($1,$2,'cv.pdf','pdf',1000)", [c, key]);
  await store.put(key, new Uint8Array([1]), "application/pdf");
};
const propose = async (keep: string, drop: string, who = "ad1") => (await h.ok(call(who, { action: "merge_propose", keep, drop }))).requestId as string;
const confirm = (requestId: string, who = "ad2") => call(who, { action: "merge_confirm", requestId });
const status = async (id: string) => (await one("select status, applied_at is not null as used from approval_request where id = $1", [id]));
/** A pending request of another kind, proposed by ad1 (approval_request_guard needs an acting staff member). */
const otherRequest = async (target: string) => {
  const c = await su.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad1]);
    const id = (await c.query("insert into approval_request(kind, target_table, target_id) values ('setting','setting',$1) returning id::text", [target])).rows[0].id as string;
    await c.query("commit");
    return id;
  } finally { c.release(); }
};
const exists = async (c: string) => (await su.query("select 1 from candidate_user where id = $1", [c])).rowCount === 1;

beforeAll(async () => {
  db = await createTestDb();
  await db.query("portal_owner", fs.readFileSync(new URL("../launch-b/0001_launch_b.sql", import.meta.url), "utf8"));
  h = await staffHarness(db);
  su = h.su;
  ({ F, ins } = fixtures(db) as any);
  route = (await import("../../../apps/admin/app/api/accounts/route")) as unknown as Route;
  store = memoryStore();
  setFileStore(store);
  src = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
  [org, org2, org3, org4] = [await F.org(), await F.org(), await F.org(), await F.org()];
  mem = await F.member(org, await F.portal(), { role: "account_owner", signer: true });
  mem2 = await F.member(org2, await F.portal(), { role: "account_owner", signer: true });
  appText = await F.text("application");
  accText = await F.text("contact_accept");
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

describe("a full merge: every clash, the kept account's rows win", () => {
  let K: string, D: string, j: any, req: string, reply: any, appK4: string, appD5: string, crD5: string, sentK: string, crqD: string;
  beforeAll(async () => {
    K = await F.cand(); D = await F.cand();
    j = []; for (let i = 0; i < 6; i++) j.push(await job());
    await profile(K, "Kept Name"); await profile(D, "Dropped Name");
    await cv(K, "cv/kept"); await cv(D, "cv/dropped");
    await save(K, j[0]); await save(D, j[0]); await save(D, j[1]);
    await alerts(K, 9); await alerts(D, 3);
    await track(K, j[0], "interview"); await track(D, j[0], "applied"); await track(D, j[2], "offer");
    await su.query("insert into candidate_hidden_organisation(candidate_user_id, organisation_id) values ($1,$3),($2,$3),($2,$4)", [K, D, org3, org4]);
    for (const k of ["app/k4", "app/d4", "app/d5"]) await store.put(k, new Uint8Array([2]), "application/pdf");
    appK4 = await apply(K, j[3], "app/k4"); await apply(D, j[3], "app/d4"); appD5 = await apply(D, j[4], "app/d5");
    crD5 = (await one("select consent_record_id::text c from application where id = $1", [appD5])).c;
    await su.query("insert into message(application_id, sender_candidate_user_id, body) values ($1,$2,'Fake hello')", [appD5, D]);
    // contact requests: both have an open one from org (the kept one stays), and D accepted one from org2 with a message in it
    sentK = await ins("postgres", "contact_request", { organisation_id: org, membership_id: mem, candidate_user_id: K });
    await ins("postgres", "contact_request", { organisation_id: org, membership_id: mem, candidate_user_id: D });
    crqD = await ins("postgres", "contact_request", { organisation_id: org2, membership_id: mem2, candidate_user_id: D, status: "accepted", consent_record_id: await consent(D, accText) });
    await su.query("insert into message(contact_request_id, sender_candidate_user_id, body) values ($1,$2,'Fake reply')", [crqD, D]);
    req = await propose(K, D);
    const r = await confirm(req);
    expect(replyProblems(spec, "POST", "/api/accounts", r.status, r.json)).toEqual([]);
    reply = r.json;
  });
  it("replies with what moved and the files removed; the request is used once", async () => {
    expect(reply).toEqual({ ok: true, keep: K, drop: D, filesRemoved: 2,
      moved: { savedJobs: 1, alerts: 1, tracker: 1, hiddenOrganisations: 1, profile: 0, cv: 0, applications: 1, contactRequests: 1, servicesCases: 0, servicesCaseIds: [] } });
    expect(await status(req)).toEqual({ status: "confirmed", used: true });
    expect(await exists(D)).toBe(false);
  });
  it("each clash keeps the kept account's row", async () => {
    expect(await rows("select job_id::text j from saved_job where candidate_user_id = $1 order by id", [K])).toEqual([{ j: j[0] }, { j: j[1] }]);
    expect(await rows("select job_id::text j, stage from tracker_entry where candidate_user_id = $1 order by job_id", [K])).toEqual([{ j: j[0], stage: "interview" }, { j: j[2], stage: "offer" }]);
    expect((await one("select count(*)::int n from alert where candidate_user_id = $1", [K])).n).toBe(10); // the cap of 10
    expect((await rows("select organisation_id::text o from candidate_hidden_organisation where candidate_user_id = $1 order by organisation_id", [K])).map((r) => r.o)).toEqual([org3, org4]);
    expect(await one("select full_name from candidate_profile where candidate_user_id = $1", [K])).toEqual({ full_name: "Kept Name" });
    expect(await one("select storage_key from candidate_cv where candidate_user_id = $1", [K])).toEqual({ storage_key: "cv/kept" });
    expect(await rows("select id::text, job_id::text j, cv_storage_key k from application where candidate_user_id = $1 order by job_id", [K]))
      .toEqual([{ id: appK4, j: j[3], k: "app/k4" }, { id: appD5, j: j[4], k: "app/d5" }]);
    expect((await one("select count(*)::int n from application where job_id = $1 and candidate_user_id is null and cv_storage_key is null", [j[3]])).n).toBe(1); // D's clashing one, emptied
    expect(await one("select candidate_user_id c, subject_erased_at from consent_record where id = $1", [crD5])).toEqual({ c: K, subject_erased_at: null });
    expect(await rows("select body from message where sender_candidate_user_id = $1 order by id", [K])).toEqual([{ body: "Fake hello" }, { body: "Fake reply" }]);
    expect(await rows("select id::text, organisation_id::text o, status from contact_request where candidate_user_id = $1 order by id", [K]))
      .toEqual([{ id: sentK, o: org, status: "sent" }, { id: crqD, o: org2, status: "accepted" }]);
  });
  it("the dropped account's own files are removed, the moved application's CV and the kept files stay", () => {
    expect([...store.objects.keys()].sort()).toEqual(["app/d5", "app/k4", "cv/kept"]);
  });
  it("the kept account is told (one notice, one email) and one audit row names both ids and both staff", async () => {
    expect(await rows("select template_key, params from notification where candidate_user_id = $1 and template_key = 'account_merged'", [K])).toEqual([{ template_key: "account_merged", params: {} }]);
    expect(await rows("select template, params, status from email_outbox where candidate_user_id = $1 and template = 'account_merged'", [K])).toEqual([{ template: "account_merged", params: null, status: "pending" }]);
    const a = await rows("select actor_staff_user_id a, second_staff_user_id s, object_id o, subject_candidate_user_id sub, after from audit_event where action = 'candidate_merge.confirm'");
    expect(a).toEqual([{ a: h.staff.ad2, s: h.staff.ad1, o: K, sub: K, after: { dropped: D, request_id: req, moved: reply.moved } }]);
    expect((await one("select count(*)::int n from audit_event where action = 'candidate.erase'")).n).toBe(1);
  });
  it("the kept account's export lists the moved rows", async () => {
    const x = await exportData(db.pool("app_candidate"), K);
    expect(x.savedJobs.map((s: any) => s.jobId).sort()).toEqual([j[0], j[1]].sort());
    expect(x.tracker.map((t: any) => [t.jobId, t.stage]).sort()).toEqual([[j[0], "interview"], [j[2], "offer"]]);
    expect(x.alerts).toHaveLength(10);
    expect(x.consents.map((c: any) => c.purpose).sort()).toEqual(["application", "application", "contact_accept"]);
    expect(x.notifications.map((n: any) => n.templateKey)).toContain("account_merged");
    expect(x.profile.fullName).toBe("Kept Name");
  });
});

describe("the kept account has no profile or CV: the dropped one's move, and its stored CV stays", () => {
  it("moves both, removes no file", async () => {
    const K = await F.cand(), D = await F.cand();
    await profile(D, "Only Name"); await cv(D, "cv/only");
    const r = await h.ok(confirm(await propose(K, D)));
    expect([r.moved.profile, r.moved.cv, r.filesRemoved]).toEqual([1, 1, 0]);
    expect(await one("select storage_key from candidate_cv where candidate_user_id = $1", [K])).toEqual({ storage_key: "cv/only" });
    expect(store.objects.has("cv/only")).toBe(true);
  });
  it("a stored file that cannot be removed is logged as a count (never the key) for the orphan sweep; the merge stands", async () => {
    const K = await F.cand(), D = await F.cand();
    await profile(K, "Has One"); await cv(K, "cv/k-has"); await cv(D, "cv/d-stuck");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = await propose(K, D);
    store.failNext();
    expect((await h.ok(confirm(req))).filesRemoved).toBe(0);
    expect(err.mock.calls).toEqual([["candidate merge: 1 stored files not removed, the weekly orphan sweep removes them"]]);
    err.mockRestore();
    expect([await exists(D), store.objects.has("cv/d-stuck")]).toEqual([false, true]);
  });
  it("a dropped account already deleted (waiting for its grace period) merges too; a deleted kept account is refused", async () => {
    const K = await F.cand(), D = await F.cand({ deleted: new Date() });
    await save(D, await job());
    expect((await h.ok(confirm(await propose(K, D)))).moved.savedJobs).toBe(1);
    const gone = await F.cand({ deleted: new Date() });
    await h.no(call("ad1", { action: "merge_propose", keep: gone, drop: await F.cand() }), 409, "kept_account_deleted");
  });
});

describe("the dropped account's closed services cases move to the kept account (G4)", () => {
  it("the case, its consent records, the person's own copy and events move before the erase; the kept account's tracker and timeline show it", async () => {
    const K = await F.cand(), D = await F.cand(), staff = (await one("select id from staff_user where id = $1", [h.staff.ad1])).id;
    const k1 = await consent(D, await F.text("services_request")), k2 = await consent(D, await F.text("employer_contact"));
    const c = await ins("postgres", "services_case", { candidate_user_id: D, consent_record_id: k1, employer_contact_consent_record_id: k2, status: "closed", closed_at: new Date(),
      close_reason: "no_reply" });
    await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'received', 'received', $2)", [c, D]);
    await su.query("insert into case_event(case_id, kind, status, staff_user_id) values ($1, 'closed', 'closed', $2)", [c, staff]);
    await store.put("case/d-copy", new Uint8Array([3]), "image/png");
    await su.query("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) values ($1, 'case/d-copy', 'mine.png', 'png', 1, $2)", [c, D]);
    const req = await propose(K, D);
    const r = await h.ok(confirm(req));
    expect(r.moved).toMatchObject({ servicesCases: 1, servicesCaseIds: [c] });
    expect(r.filesRemoved).toBe(0);
    expect(await exists(D)).toBe(false);
    expect(store.objects.has("case/d-copy")).toBe(true);
    expect(await one("select candidate_user_id, requester_erased_at from services_case where id = $1", [c])).toEqual({ candidate_user_id: K, requester_erased_at: null });
    expect((await rows("select candidate_user_id from consent_record where id = any($1)", [[k1, k2]])).map((x) => x.candidate_user_id)).toEqual([K, K]);
    expect(await one("select candidate_user_id, storage_key from case_document where services_case_id = $1", [c])).toEqual({ candidate_user_id: K, storage_key: "case/d-copy" });
    expect(await rows("select candidate_user_id, staff_user_id from case_event where case_id = $1 order by id", [c])).toEqual([{ candidate_user_id: K, staff_user_id: null }, { candidate_user_id: null, staff_user_id: staff }]);
    // the kept account reads it through the candidate login's own reader and timeline (the routes' functions)
    const cand = db.pool("app_candidate");
    expect((await cand.query(TRACKER_SQL.candidate.one, [K, c])).rows[0]).toMatchObject({ id: c, status: "closed", documentCount: 1 });
    expect((await caseTimeline(cand, "candidate", K, c))!.events.map((e) => e.kind)).toEqual(["received", "closed"]);
    expect((await exportData(cand, K)).servicesCases.map((x: any) => x.id)).toEqual([c]);
    // the audit row lists the moved case ids
    expect((await one("select after from audit_event where action = 'candidate_merge.confirm' and after->>'request_id' = $1", [req])).after.moved).toMatchObject({ servicesCases: 1, servicesCaseIds: [c] });
  });
});

describe("refusals at confirm leave everything as it was and the request pending", () => {
  const caseOf = async (c: string, closed = false) => ins("postgres", "services_case", {
    candidate_user_id: c, consent_record_id: await consent(c), ...(closed ? { status: "closed", closed_at: new Date(), close_reason: "decided" } : {}) });
  it("an open services case on either account", async () => {
    for (const side of ["drop", "keep"] as const) {
      const K = await F.cand(), D = await F.cand(), jj = await job();
      await save(D, jj);
      const sc = await caseOf(side === "drop" ? D : K);
      const req = await propose(K, D);
      await h.no(confirm(req), 409, "open_services_case");
      expect([await status(req), await exists(D), (await one("select count(*)::int n from saved_job where candidate_user_id = $1", [D])).n]).toEqual([{ status: "pending", used: false }, true, 1]);
      await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'decided' where id = $1", [sc]);
      await h.ok(confirm(req)); // closed: it goes through, and the closed case stays as a record
      expect(await exists(D)).toBe(false);
    }
  });
  it("an open report on either account, as its target or as its reporter", async () => {
    const jj = await job();
    for (const [col, side] of [["target_candidate_user_id", "drop"], ["target_candidate_user_id", "keep"], ["reporter_candidate_user_id", "drop"], ["reporter_candidate_user_id", "keep"]] as const) {
      const K = await F.cand(), D = await F.cand(), who = side === "drop" ? D : K;
      await su.query(col === "target_candidate_user_id" ? "insert into report(target_kind, target_candidate_user_id, reason) values ('profile',$1,'other')"
        : "insert into report(target_kind, target_job_id, reporter_candidate_user_id, reason) values ('job',$2,$1,'other')", col === "target_candidate_user_id" ? [who] : [who, jj]);
      const req = await propose(K, D);
      await h.no(confirm(req), 409, "open_report");
      expect([await status(req), await exists(D)]).toEqual([{ status: "pending", used: false }, true]);
    }
  });
  it("an account gone since the proposal", async () => {
    const K = await F.cand(), D = await F.cand(), req = await propose(K, D);
    await su.query("delete from candidate_user where id = $1", [K]);
    await h.no(confirm(req), 404, "not_found");
    expect(await status(req)).toEqual({ status: "pending", used: false });
  });
});

describe("the two-person rule", () => {
  it("the proposer cannot confirm; withdraw by the proposer, refuse by another administrator; an ended request cannot be confirmed", async () => {
    const K = await F.cand(), D = await F.cand();
    const req = await propose(K, D);
    await h.no(confirm(req, "ad1"), 409, "same_person");
    await h.no(call("ad2", { action: "merge_propose", keep: K, drop: D }), 409, "decision_pending");
    expect((await h.ok(call("ad2"))).pending).toContainEqual({ requestId: req, keep: K, drop: D, proposedBy: h.staff.ad1, createdAt: expect.any(String) });
    const r = await call("ad2");
    expect(replyProblems(spec, "GET", "/api/accounts", r.status, r.json)).toEqual([]);
    await h.ok(call("ad1", { action: "merge_refuse", requestId: req }));
    expect(await status(req)).toEqual({ status: "withdrawn", used: false });
    await h.no(confirm(req), 409, "request_not_pending");
    const req2 = await propose(K, D);
    await h.ok(call("ad2", { action: "merge_refuse", requestId: req2 }));
    expect(await status(req2)).toEqual({ status: "refused", used: false });
    expect(await exists(D)).toBe(true);
    expect((await rows("select action, actor_staff_user_id a, second_staff_user_id s from audit_event where action like 'candidate_merge.%' and (object_id = $1 or object_id = $2) order by id", [K, D])))
      .toEqual([
        { action: "candidate_merge.propose", a: h.staff.ad1, s: null }, { action: "candidate_merge.withdraw", a: h.staff.ad1, s: null },
        { action: "candidate_merge.propose", a: h.staff.ad1, s: null }, { action: "candidate_merge.refuse", a: h.staff.ad2, s: h.staff.ad1 },
      ]);
  });
  it("every other staff role is refused on each action and the list", async () => {
    const K = await F.cand(), D = await F.cand(), req = await propose(K, D);
    for (const r of ROLE_NAMES) if (r !== "administrator") {
      const who = `only_${r}`;
      await h.no(call(who), 403, "not_administrator");
      await h.no(call(who, { action: "merge_propose", keep: K, drop: await F.cand() }), 403, "not_administrator");
      await h.no(confirm(req, who), 403, "not_administrator");
      await h.no(call(who, { action: "merge_refuse", requestId: req }), 403, "not_administrator");
    }
    await h.no(call(null), 401, "no_session");
    await h.no(call(null, { action: "merge_confirm", requestId: req }), 401, "no_session");
    await h.no(call(null, { action: "merge_confirm", requestId: req }, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(call("ad2", { action: "merge_confirm", requestId: req }, { origin: "https://evil.example" }), 403, "bad_origin");
    expect([await status(req), await exists(D)]).toEqual([{ status: "pending", used: false }, true]);
  });
  it("the database itself: no merge without a confirmed request, the proposer and a non-administrator cannot confirm, a request works once", async () => {
    const K = await F.cand(), D = await F.cand(), req = await propose(K, D);
    const admin = db.pool("app_admin");
    await expect(admin.query("select private.candidate_merge($1::bigint)", [req])).rejects.toThrow(/two-person rule: request \d+ is pending/);
    const as = async (staff: string, sql: string) => {
      const c = await admin.connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.staff_user_id', $1, true)", [staff]);
        return await c.query(sql, [req]);
      } finally { await c.query("rollback"); c.release(); }
    };
    await expect(as(h.staff.ad1!, "update approval_request set status = 'confirmed' where id = $1")).rejects.toThrow(/approval_request_check/);
    await expect(as(h.staff.only_trust_and_safety!, "update approval_request set status = 'confirmed' where id = $1")).rejects.toThrow(/confirmer does not hold the role/);
    await expect(db.pool("app_candidate").query("select private.candidate_merge($1::bigint)", [req])).rejects.toThrow(/permission denied/);
    await expect(db.pool("app_portal").query("select private.candidate_merge($1::bigint)", [req])).rejects.toThrow(/permission denied/);
    await h.ok(confirm(req));
    await expect(as(h.staff.ad2!, "select private.candidate_merge($1::bigint)")).rejects.toThrow(/was already used/);
    const setting = await otherRequest("x");
    await expect(admin.query("select private.candidate_merge($1::bigint)", [setting])).rejects.toThrow(/merge refused: not_found/);
  });
});

describe("hostile input", () => {
  it("bad ids, the same account twice, unknown accounts, wrong types and fields", async () => {
    const K = await F.cand();
    const bad: [unknown, number, string][] = [
      [{ action: "merge_propose", keep: K, drop: K }, 400, "same_account"],
      [{ action: "merge_propose", keep: K, drop: "a".repeat(65) }, 400, "bad_user_id"],
      [{ action: "merge_propose", keep: "x' or '1'='1", drop: K }, 400, "bad_user_id"],
      [{ action: "merge_propose", keep: 5, drop: K }, 400, "bad_user_id"],
      [{ action: "merge_propose", keep: K }, 400, "bad_user_id"],
      [{ action: "merge_propose", keep: K, drop: "nobody-here" }, 404, "not_found"],
      [{ action: "merge_propose", keep: await F.portal(), drop: K }, 404, "not_found"],
      [{ action: "merge_propose", keep: K, drop: "x", reason: "dup" }, 400, "bad_body"],
      [{ action: "merge_confirm", requestId: "1; drop table job" }, 400, "bad_request_id"],
      [{ action: "merge_confirm", requestId: 7 }, 400, "bad_request_id"],
      [{ action: "merge_confirm", requestId: "99999999" }, 404, "not_found"],
      [{ action: "merge_refuse", requestId: "99999999" }, 404, "not_found"],
      [{ action: "merge_everything", requestId: "1" }, 400, "bad_action"],
    ];
    for (const [body, st, error] of bad) await h.no(call("ad1", body), st, error);
    // a request of another kind is not a merge request
    const setting = await otherRequest("y");
    await h.no(confirm(setting), 404, "not_found");
    await h.no(call("ad1", undefined, { query: "?x=1" }), 400, "bad_query");
    await h.no(call("ad1", { action: "merge_propose", keep: K, drop: "y" }, { length: "100000" }), 400, "bad_body");
  });
});

describe("performance", () => {
  it("statements and median times of propose and confirm inside budget", async () => {
    const pairs: string[][] = [];
    for (let i = 0; i < 10; i++) { const K = await F.cand(), D = await F.cand(); await save(D, await job()); pairs.push([K, D]); }
    const [, p] = await counted(() => propose(pairs[0]![0]!, pairs[0]![1]!));
    const req = (await one("select id::text from approval_request where kind = 'candidate_merge' and target_id = $1 and status = 'pending'", [pairs[0]![1]])).id;
    const [, c] = await counted(() => h.ok(confirm(req)));
    const [, l] = await counted(() => h.ok(call("ad1")));
    expect([p, c, l]).toEqual([BUDGET.propose, BUDGET.confirm, BUDGET.list]);
    const reqs: string[] = [];
    const pm = await median(async (i) => reqs.push(await propose(pairs[i + 1]![0]!, pairs[i + 1]![1]!)));
    const cm = await median((i) => h.ok(confirm(reqs[i]!)));
    console.log(`candidate merge route: ${p} statements (propose), ${c} (confirm), ${l} (list); median ${pm.toFixed(1)} ms propose, ${cm.toFixed(1)} ms confirm`);
    expect(pm).toBeLessThanOrEqual(BUDGET.proposeMs);
    expect(cm).toBeLessThanOrEqual(BUDGET.confirmMs);
  });
  it("pages of one big merge among 2,000 other people inside budget", async () => {
    await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, salary_low, search_vector, application_route)
      select $1, 'employer', $2, 'Bulk job', 'Fake Org', 'it', 'critical_skills', 'live', now() + interval '29 days', 40000, '''fake'':1', 'on_site' from generate_series(1, 200)`, [org, src]);
    const jobs = (await rows("select id from job where title = 'Bulk job' order by id")).map((r) => r.id);
    await su.query("insert into candidate_user(id, name, email, email_verified, created_at, updated_at) select 'bulk-' || g, 'Fake', 'bulk-' || g || '@example.test', true, now(), now() from generate_series(1, 2000) g");
    await su.query("insert into saved_job(candidate_user_id, job_id) select 'bulk-' || g, j from generate_series(1, 2000) g, unnest($1::bigint[]) with ordinality u(j, n) where n <= 5", [jobs]);
    await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) select 'bulk-' || g, j, 'redirect', 'mark_applied', 'applied' from generate_series(1, 2000) g, unnest($1::bigint[]) with ordinality u(j, n) where n <= 3", [jobs]);
    await su.query("insert into alert(candidate_user_id, frequency, unsubscribe_token) select 'bulk-' || g, 'daily', 'bulk-tok-' || g from generate_series(1, 2000) g");
    await su.query("insert into consent_record(candidate_user_id, consent_text_id) select 'bulk-' || g, $1 from generate_series(1, 2000) g", [appText]);
    await su.query("insert into application(candidate_user_id, job_id, organisation_id, consent_record_id) select c.candidate_user_id, $1, $2, c.id from consent_record c where c.candidate_user_id like 'bulk-%'", [jobs[0], org]);
    const K = await F.cand(), D = await F.cand();
    await su.query("insert into saved_job(candidate_user_id, job_id) select $1, j from unnest($2::bigint[]) with ordinality u(j, n) where n <= 50", [K, jobs]);
    await su.query("insert into saved_job(candidate_user_id, job_id) select $1, j from unnest($2::bigint[]) with ordinality u(j, n) where n <= 150", [D, jobs]);
    await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) select $1, j, 'redirect', 'mark_applied', 'applied' from unnest($2::bigint[]) with ordinality u(j, n) where n <= 150", [D, jobs]);
    await alerts(D, 10);
    for (let i = 1; i <= 100; i++) {
      const a = await ins("postgres", "application", { candidate_user_id: D, job_id: jobs[i], organisation_id: org, consent_record_id: await consent(D), cv_storage_key: `bulk/${i}` });
      await su.query("insert into message(application_id, sender_candidate_user_id, body) values ($1,$2,'Fake')", [a, D]);
    }
    await su.query("analyze");
    const req = await propose(K, D);
    const c = await db.pool("app_admin").connect();
    const measure = async () => {
      await c.query("begin");
      try {
        await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad2]);
        await c.query("update approval_request set status = 'confirmed' where id = $1", [req]);
        const plan = (await c.query("explain (analyze, buffers, format json) select private.candidate_merge($1::bigint)", [req])).rows[0]["QUERY PLAN"];
        return costOf("candidate_merge", plan);
      } finally { await c.query("rollback"); }
    };
    try {
      await measure(); // warm
      const cost = await measure();
      console.log(`candidate merge, big: ${cost.pages} pages, ${cost.ms} ms`);
      expect(cost.pages).toBeLessThanOrEqual(BUDGET.pages);
      expect(cost.ms).toBeLessThanOrEqual(BUDGET.bigMs);
    } finally { c.release(); }
    expect((await h.ok(confirm(req))).moved).toMatchObject({ savedJobs: 100, tracker: 150, alerts: 10, applications: 100 });
  });
});
