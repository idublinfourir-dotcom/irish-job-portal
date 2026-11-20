// Integration: the staff services board (step 15 SV-B2: M3, M5, M9) through the admin app's real route handlers on the real test database as
// app_admin, with real staff sessions (staff-routes-harness.ts). Fixture cases are made through 0061's schema with its `received` event; the
// requester's timeline read goes through the real 0061 wrappers as app_candidate and app_portal. The outbox runs with a fake sender. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";
import { BOARD_AFTER, BOARD_FIRST, caseTimeline, REFERRAL_FIRM_SHOWN } from "../src/services-board";
import { STAFF_COUNTS, staffCounts } from "../src/staff-counts";

// Perf, measured 20 Nov 2026 on the test database with 10,000 open cases (this file alone; printed below): the list 5 pages (first page) and
// 4 (after a cursor); the staff counts statement 156 pages (the two case counts walk the open cases: fine while cases are few, a counter if not);
// one open 8 statements (1 session, begin, role check, the case, the audit row, the notes, commit) in 3.2 ms; each action 9 statements (a note 8:
// no event) in 3.5 to 4.3 ms; the timeline 0.94 ms. Statement counts are exact; time about 4 times the measure; pages one index level over.
const BUDGET = { listPages: 8, openStatements: 8, openMs: 15, actionStatements: 9, actionMs: 20, timelineMs: 5, countsPages: 250 };
vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

let db: TestDb, su: pg.Pool, h: Awaited<ReturnType<typeof staffHarness>>;
let CASES: Route, SOL: Route;
type Fx = { id: (p: string) => string; F: { cand: () => Promise<string>; portal: () => Promise<string>; org: () => Promise<string>; member: (o: string, u: string, x?: { role?: string }) => Promise<string>; text: (p: string) => Promise<string> } };
let F: Fx["F"], uid: Fx["id"], text: string;
const OTHER_ROLES = ROLE_NAMES.filter((r) => r !== "services_case_handler" && r !== "administrator");

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F, id: uid } = fixtures(db) as unknown as Fx);
  text = await F.text("services_request");
  h = await staffHarness(db);
  await oneOfEachRole(h);
  for (const [n, r] of [["h1", ["services_case_handler"]], ["h2", ["services_case_handler"]], ["ad", ["administrator"]], ["norole", []]] as const) await h.makeStaff(n, [...r]);
  CASES = await import("../../../apps/admin/app/api/services/cases/route");
  SOL = await import("../../../apps/admin/app/api/services/solicitors/route");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
/** A candidate case (optionally with this email) and its received event, as SV-A's request route writes them. */
async function candidateCase(o: { email?: string; hr?: boolean } = {}) {
  const cand = await F.cand();
  if (o.email) await su.query("update candidate_user set email = $2 where id = $1", [cand, o.email]);
  const consent = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, text])).id;
  const c = (await one("insert into services_case(candidate_user_id, consent_record_id, employer_contact_consent_record_id, payer, offer_details) values ($1, $2, $3, 'employer', $4) returning id::text id",
    [cand, consent, o.hr ? consent : null, JSON.stringify({ role: "Fake role" })])).id as string;
  await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'received', 'received', $2)", [c, cand]);
  return { cand, c };
}
async function portalCase() {
  const org = await F.org(), requester = await F.portal(), owner = await F.portal();
  await F.member(org, requester, { role: "recruiter" });
  await F.member(org, owner, { role: "account_owner" });
  const consent = (await one("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [requester, text])).id;
  const c = (await one("insert into services_case(portal_user_id, organisation_id, consent_record_id, dedupe_key, payer) values ($1, $2, $3, $4, 'agency') returning id::text id", [requester, org, consent, uid("k")])).id as string;
  await su.query("insert into case_event(case_id, kind, status, portal_user_id) values ($1, 'received', 'received', $2)", [c, requester]);
  return { org, requester, owner, c };
}
const P = "/api/services/cases";
const act = (who: string | null, body: Record<string, unknown>, o = {}) => h.call(CASES, P, who, body, o);
const open = (who: string | null, c: string) => h.call(CASES, P, who, undefined, { query: `?id=${c}` });
const events = (c: string) => rows("select kind, status, detail, staff_user_id from case_event where case_id = $1 order by id", [c]);

describe("the board list and one case", () => {
  it("lists open cases by status with the payer line and the HR-contact flag, no requester name or contact; pages with a cursor", async () => {
    const a = await candidateCase({ hr: true }), b = await portalCase();
    const r = await h.ok(h.call(CASES, P, "h1", undefined, { query: "?status=received" }));
    const mine = r.items.filter((x: { id: string }) => [a.c, b.c].includes(x.id));
    expect(mine).toEqual([
      { id: a.c, status: "received", createdAt: expect.any(String), permitType: null, payer: "employer", hrContactConsent: true, assignedStaffUserId: null, side: "candidate" },
      { id: b.c, status: "received", createdAt: expect.any(String), permitType: null, payer: "agency", hrContactConsent: false, assignedStaffUserId: null, side: "portal" },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/example\.test|Fake/);
    expect((await h.ok(h.call(CASES, P, "ad", undefined, { query: "?status=received" }))).items.length).toBe(r.items.length); // the administrator sees the list
    await h.no(h.call(CASES, P, "h1", undefined, { query: "?status=closed" }), 400, "bad_status");
    await h.no(h.call(CASES, P, "h1", undefined, { query: "?status=x'or'1" }), 400, "bad_status");
    await h.no(h.call(CASES, P, "h1", undefined, { query: "?after=bad!" }), 400, "bad_cursor");
    await h.no(h.call(CASES, P, "h1", undefined, { query: "?who=1" }), 400, "bad_query");
    await h.no(h.call(CASES, P, "h1", undefined, { query: `?id=${a.c}&status=received` }), 400, "bad_query");
  });

  it("one case: a handler sees all of it, an administrator no notes, copies or contact; every open is logged with reason services_case", async () => {
    const a = await candidateCase();
    const full = (await h.ok(open("h1", a.c))).item;
    expect(full).toMatchObject({ id: a.c, status: "received", payer: "employer", offerDetails: { role: "Fake role" }, requesterName: "Fake Candidate", requesterEmail: expect.stringMatching(/@example\.test$/),
      copies: 0, notes: [], documentsNeeded: [], side: "candidate", requesterErased: false });
    expect(full).not.toHaveProperty("candidateUserId");
    const lite = (await h.ok(open("ad", a.c))).item;
    for (const k of ["requesterName", "requesterEmail", "copies", "notes", "candidateUserId"]) expect(lite).not.toHaveProperty(k);
    expect(lite).toMatchObject({ id: a.c, payer: "employer" });
    expect(await rows("select actor_staff_user_id s, role_in_force r, action, reason_code, related_case, subject_candidate_user_id subj from audit_event where kind = 'data_access' and object_type = 'services_case' and object_id = $1 order by id", [a.c]))
      .toEqual([{ s: h.staff.h1, r: "services_case_handler", action: "services_case.read", reason_code: "services_case", related_case: a.c, subj: a.cand },
        { s: h.staff.ad, r: "administrator", action: "services_case.read", reason_code: "services_case", related_case: a.c, subj: a.cand }]);
    await h.no(open("h1", "999999999"), 404, "not_found");
    await h.no(open("h1", "abc"), 404, "not_found");
    await h.no(open("h1", "1".repeat(30)), 404, "not_found");
  });

  it("a closed case shows no requester contact (20c:143); an erased requester none either", async () => {
    const a = await candidateCase();
    await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'no_reply' where id = $1", [a.c]);
    expect((await h.ok(open("h1", a.c))).item).toMatchObject({ requesterName: null, requesterEmail: null });
    const b = await candidateCase();
    await su.query("update services_case set requester_erased_at = now() where id = $1", [b.c]);
    expect((await h.ok(open("h1", b.c))).item).toMatchObject({ requesterName: null, requesterEmail: null, requesterErased: true });
  });

  it("refused: every other staff role, a login with no role, signed out; a handler on their own case (email equal), with nothing logged", async () => {
    const a = await candidateCase();
    for (const r of OTHER_ROLES) {
      await h.no(h.call(CASES, P, `only_${r}`, undefined, { query: "?status=received" }), 403, "not_case_staff");
      await h.no(open(`only_${r}`, a.c), 403, "not_case_staff");
    }
    await h.no(open("norole", a.c), 403, "not_case_staff");
    await h.no(open(null, a.c), 401, "no_session");
    const own = await candidateCase({ email: "H1@example.test" }); // the case of h1's own email, any case
    await h.no(open("h1", own.c), 403, "own_case");
    expect(await rows("select 1 from audit_event where object_type = 'services_case' and object_id = $1", [own.c])).toEqual([]);
  });
});

describe("the actions", () => {
  it("assign: a handler takes an unassigned case; another handler cannot take it; an administrator reassigns; the target must be a handler, not the requester", async () => {
    const a = await candidateCase();
    await h.no(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.ad }), 409, "bad_assignee");
    await h.ok(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    await h.no(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }), 409, "no_change");
    await h.no(act("h2", { action: "assign", caseId: a.c, staffUserId: h.staff.h2 }), 403, "not_assigned");
    await h.ok(act("ad", { action: "assign", caseId: a.c, staffUserId: h.staff.h2 }));
    expect(await events(a.c)).toEqual([
      { kind: "received", status: "received", detail: {}, staff_user_id: null },
      { kind: "assigned", status: "received", detail: { assignedStaffUserId: h.staff.h1 }, staff_user_id: h.staff.h1 },
      { kind: "assigned", status: "received", detail: { assignedStaffUserId: h.staff.h2 }, staff_user_id: h.staff.ad },
    ]);
    expect(await rows("select role_in_force r, after from audit_event where kind = 'admin_action' and object_id = $1 and action = 'services_case.assign' order by id", [a.c]))
      .toEqual([{ r: "services_case_handler", after: { assignedStaffUserId: h.staff.h1, before: null } }, { r: "administrator", after: { assignedStaffUserId: h.staff.h2, before: h.staff.h1 } }]);
    // h1 as requester of another case: cannot be its assignee, and cannot assign it
    const own = await candidateCase({ email: "h1@example.test" });
    await h.no(act("h2", { action: "assign", caseId: own.c, staffUserId: h.staff.h1 }), 409, "bad_assignee");
    await h.no(act("h1", { action: "assign", caseId: own.c, staffUserId: h.staff.h2 }), 403, "own_case");
    await h.no(act("h1", { action: "assign", caseId: a.c, staffUserId: "x".repeat(65) }), 400, "bad_staff_id");
    await h.no(act("h1", { action: "assign", caseId: "999999999", staffUserId: h.staff.h1 }), 404, "not_found");
  });

  it("status, documents, decision and close: allowed moves only, codes from the list, the outcome at decision only; one event and one audit row each", async () => {
    const a = await candidateCase();
    await h.ok(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    await h.no(act("h1", { action: "status", caseId: a.c, status: "decision" }), 409, "bad_move");
    await h.no(act("h1", { action: "status", caseId: a.c, status: "closed" }), 409, "bad_move");
    await h.no(act("h1", { action: "status", caseId: a.c, status: "received" }), 409, "bad_move");
    await h.no(act("h1", { action: "status", caseId: a.c, status: "Received" }), 400, "bad_status");
    await h.ok(act("h1", { action: "status", caseId: a.c, status: "documents_needed" }));
    await h.no(act("h1", { action: "documents", caseId: a.c, codes: ["passport"] }), 400, "bad_codes");
    await h.no(act("h1", { action: "documents", caseId: a.c, codes: ["cv", "cv"] }), 400, "bad_codes");
    await h.no(act("h1", { action: "documents", caseId: a.c, codes: "cv" }), 400, "bad_codes");
    await h.no(act("h1", { action: "documents", caseId: a.c, codes: [{ code: "cv" }] }), 400, "bad_codes");
    await h.ok(act("h1", { action: "documents", caseId: a.c, codes: ["passport_copy", "cv"] }));
    await h.no(act("h1", { action: "documents", caseId: a.c, codes: ["cv", "passport_copy"] }), 409, "no_change");
    await h.no(act("h1", { action: "decision", caseId: a.c, outcome: "granted" }), 409, "not_at_decision");
    await h.ok(act("h1", { action: "status", caseId: a.c, status: "waiting_for_employer" }));
    await h.ok(act("h1", { action: "status", caseId: a.c, status: "submitted" }));
    await h.ok(act("h1", { action: "status", caseId: a.c, status: "decision" }));
    await h.no(act("h1", { action: "documents", caseId: a.c, codes: ["cv"] }), 409, "bad_move");
    await h.no(act("h1", { action: "decision", caseId: a.c, outcome: "maybe" }), 400, "bad_outcome");
    await h.no(act("h1", { action: "close", caseId: a.c, reason: "decided" }), 409, "not_decided");
    await h.ok(act("h1", { action: "decision", caseId: a.c, outcome: "granted" }));
    await h.no(act("h1", { action: "close", caseId: a.c, reason: "no_reply" }), 409, "outcome_recorded");
    await h.no(act("h1", { action: "close", caseId: a.c, reason: "withdrawn" }), 400, "bad_reason");
    await h.no(act("h1", { action: "close", caseId: a.c, reason: "referred_to_solicitor" }), 400, "bad_reason");
    await h.ok(act("h1", { action: "close", caseId: a.c, reason: "decided" }));
    await h.no(act("h1", { action: "status", caseId: a.c, status: "submitted" }), 409, "case_closed");
    await h.no(act("ad", { action: "assign", caseId: a.c, staffUserId: h.staff.h2 }), 409, "case_closed");
    expect((await events(a.c)).map((e) => [e.kind, e.status, e.detail])).toEqual([
      ["received", "received", {}], ["assigned", "received", { assignedStaffUserId: h.staff.h1 }], ["status_changed", "documents_needed", {}],
      ["documents_needed", "documents_needed", { documentsNeeded: ["passport_copy", "cv"] }], ["status_changed", "waiting_for_employer", {}], ["status_changed", "submitted", {}],
      ["status_changed", "decision", {}], ["decision", "decision", { outcome: "granted" }], ["closed", "closed", {}],
    ]);
    expect(await one("select status, close_reason, decision_outcome, documents_needed, decided_at is not null d, closed_at is not null c from services_case where id = $1", [a.c]))
      .toEqual({ status: "closed", close_reason: "decided", decision_outcome: "granted", documents_needed: ["passport_copy", "cv"], d: true, c: true });
    expect((await rows("select action from audit_event where kind = 'admin_action' and object_id = $1 order by id", [a.c])).map((r) => r.action)).toEqual([
      "services_case.assign", "services_case.status", "services_case.documents", "services_case.status", "services_case.status", "services_case.status", "services_case.decision", "services_case.close"]);
  });

  it("every case action is refused to an unassigned handler, an administrator (handler only), every other role and signed out; a handler on their own case", async () => {
    const a = await candidateCase();
    await h.ok(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    const bodies = [{ action: "status", caseId: a.c, status: "submitted" }, { action: "documents", caseId: a.c, codes: ["cv"] }, { action: "decision", caseId: a.c, outcome: "granted" },
      { action: "close", caseId: a.c, reason: "no_reply" }, { action: "refer", caseId: a.c }, { action: "note", caseId: a.c, body: "Fake note" }];
    for (const b of bodies) {
      await h.no(act("h2", b), 403, "not_assigned");
      await h.no(act("ad", b), 403, "not_case_handler");
      for (const r of OTHER_ROLES) await h.no(act(`only_${r}`, b), 403, "not_case_staff");
      await h.no(act("norole", b), 403, "not_case_staff");
      await h.no(act(null, b), 401, "no_session");
      await h.no(act("h1", b, { origin: "https://evil.example" }), 403, "bad_origin");
      await h.no(act("h1", b, { origin: null }), 403, "bad_origin");
    }
    for (const r of OTHER_ROLES) await h.no(act(`only_${r}`, { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }), 403, "not_case_staff");
    expect((await events(a.c)).map((e) => e.kind)).toEqual(["received", "assigned"]);
    // own case: assigned to h1 by an administrator through SQL (the route refuses it), still refused on every action
    const own = await candidateCase({ email: "h1@Example.TEST" });
    await su.query("update services_case set assigned_staff_user_id = $2 where id = $1", [own.c, h.staff.h1]);
    for (const b of bodies) await h.no(act("h1", { ...b, caseId: own.c }), 403, "own_case");
  });

  it("hostile bodies: unknown fields and actions, wrong types, oversized, control characters in a note", async () => {
    const a = await candidateCase();
    await h.ok(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    await h.no(act("h1", { action: "status", caseId: a.c, status: "submitted", extra: 1 }), 400, "bad_body");
    await h.no(act("h1", { action: "delete", caseId: a.c }), 400, "bad_action");
    await h.no(act("h1", { action: "status", caseId: 5, status: "submitted" }), 400, "bad_case_id");
    await h.no(act("h1", { action: "status", caseId: "-1", status: "submitted" }), 400, "bad_case_id");
    await h.no(act("h1", { action: "status", caseId: a.c, status: ["submitted"] }), 400, "bad_status");
    await h.no(act("h1", { action: "status", caseId: a.c, status: "submitted" }, { length: "999999" }), 400, "bad_body");
    await h.no(h.call(CASES, P, "h1", undefined, { raw: "{not json" }), 400, "bad_body");
    await h.no(act("h1", { action: "note", caseId: a.c, body: "x".repeat(2001) }), 400, "bad_text");
    await h.no(act("h1", { action: "note", caseId: a.c, body: "bad\u0000note" }), 400, "bad_text");
    await h.no(act("h1", { action: "note", caseId: a.c, body: "bidi‮note" }), 400, "bad_text");
    await h.no(act("h1", { action: "note", caseId: a.c, body: "   " }), 400, "bad_text");
    await h.no(act("h1", { action: "documents", caseId: a.c, codes: Array.from({ length: 31 }, (_, i) => `c${i}`) }), 400, "bad_codes");
    await h.no(act("h1", { action: "refer", caseId: a.c, solicitorId: "x" }), 400, "bad_solicitor_id");
    await h.ok(act("h1", { action: "note", caseId: a.c, body: "Line one\nline two\twith a tab" }));
    const notes = (await h.ok(open("h1", a.c))).item.notes;
    expect(notes).toEqual([{ id: expect.any(String), authorStaffUserId: h.staff.h1, body: "Line one\nline two\twith a tab", createdAt: expect.any(String) }]);
    expect(await one("select after from audit_event where action = 'services_case.note' and object_id = $1", [a.c])).toEqual({ after: { noteId: notes[0].id } });
    expect((await events(a.c)).map((e) => e.kind)).toEqual(["received", "assigned"]); // a note writes no event
  });
});

describe("referral (M9) and the solicitor list", () => {
  it("administrators add, edit and deactivate; handlers read; every other role, signed out and hostile text refused; nothing is deleted", async () => {
    const S = "/api/services/solicitors";
    const add = await h.ok(h.call(SOL, S, "ad", { action: "add", firm: "Fake Solicitors LLP", contact: "fake.firm@example.test" }));
    await h.no(h.call(SOL, S, "h1", { action: "add", firm: "Other", contact: "x" }), 403, "not_administrator");
    for (const r of OTHER_ROLES) {
      await h.no(h.call(SOL, S, `only_${r}`), 403, "not_case_staff");
      await h.no(h.call(SOL, S, `only_${r}`, { action: "add", firm: "Other", contact: "x" }), 403, "not_case_staff");
    }
    await h.no(h.call(SOL, S, null), 401, "no_session");
    for (const firm of [" padded", "bad\u0007firm", "x".repeat(201), ""]) await h.no(h.call(SOL, S, "ad", { action: "add", firm, contact: "x" }), 400, "bad_firm");
    await h.no(h.call(SOL, S, "ad", { action: "add", firm: "F", contact: "line\nbreak" }), 400, "bad_contact");
    await h.no(h.call(SOL, S, "ad", { action: "edit", solicitorId: add.id }), 400, "nothing_to_change");
    await h.no(h.call(SOL, S, "ad", { action: "remove", solicitorId: add.id }), 400, "bad_action");
    await h.ok(h.call(SOL, S, "ad", { action: "edit", solicitorId: add.id, contact: "new.contact@example.test" }));
    await h.no(h.call(SOL, S, "ad", { action: "edit", solicitorId: add.id, contact: "new.contact@example.test" }), 409, "no_change");
    expect((await h.ok(h.call(SOL, S, "h1"))).items).toContainEqual({ id: add.id, firm: "Fake Solicitors LLP", contact: "new.contact@example.test", active: true, createdAt: expect.any(String) });
    await h.ok(h.call(SOL, S, "ad", { action: "deactivate", solicitorId: add.id }));
    await h.no(h.call(SOL, S, "ad", { action: "deactivate", solicitorId: add.id }), 409, "no_change");
    await h.no(h.call(SOL, S, "ad", { action: "deactivate", solicitorId: "999999999" }), 404, "not_found");
    expect((await rows("select action, after from audit_event where object_type = 'referral_solicitor' and object_id = $1 order by id", [add.id]))).toEqual([
      { action: "referral_solicitor.add", after: { active: true } }, { action: "referral_solicitor.edit", after: { changed: ["contact"], active: true } },
      { action: "referral_solicitor.deactivate", after: { changed: ["active"], active: false } }]);
    expect((await h.ok(h.call(SOL, S, "h2"))).items.find((x: { id: string }) => x.id === add.id).active).toBe(false);
  });

  it("refer closes as referred_to_solicitor with an active firm or none, even after a refused decision; an inactive firm is refused", async () => {
    const firm = await h.ok(h.call(SOL, "/api/services/solicitors", "ad", { action: "add", firm: "Fake Referral Firm", contact: "ref@example.test" }));
    const gone = await h.ok(h.call(SOL, "/api/services/solicitors", "ad", { action: "add", firm: "Gone Firm", contact: "gone@example.test" }));
    await h.ok(h.call(SOL, "/api/services/solicitors", "ad", { action: "deactivate", solicitorId: gone.id }));
    const a = await candidateCase(), b = await candidateCase();
    for (const c of [a.c, b.c]) await h.ok(act("h1", { action: "assign", caseId: c, staffUserId: h.staff.h1 }));
    await su.query("update services_case set status = 'decision', decided_at = now(), decision_outcome = 'refused' where id = $1", [a.c]);
    await h.no(act("h1", { action: "refer", caseId: a.c, solicitorId: gone.id }), 409, "bad_solicitor");
    await h.no(act("h1", { action: "refer", caseId: a.c, solicitorId: "999999999" }), 409, "bad_solicitor");
    await h.ok(act("h1", { action: "refer", caseId: a.c, solicitorId: firm.id }));
    await h.ok(act("h1", { action: "refer", caseId: b.c }));
    expect(await one("select status, close_reason, referral_solicitor_id::text s, decision_outcome from services_case where id = $1", [a.c]))
      .toEqual({ status: "closed", close_reason: "referred_to_solicitor", s: firm.id, decision_outcome: "refused" });
    expect((await events(a.c)).at(-1)).toEqual({ kind: "referred", status: "closed", detail: { referralSolicitorId: Number(firm.id) }, staff_user_id: h.staff.h1 });
    expect((await events(b.c)).at(-1)).toEqual({ kind: "referred", status: "closed", detail: {}, staff_user_id: h.staff.h1 });
    // the timeline: the firm's name only when the switch is on (off by default)
    expect(REFERRAL_FIRM_SHOWN).toBe(false);
    const off = await caseTimeline(db.pool("app_candidate"), "candidate", a.cand, a.c);
    expect(off!.events.at(-1)).toEqual({ at: expect.any(String), kind: "referred", status: "closed", referral: { code: "referred_to_solicitor" } });
    expect(JSON.stringify(off)).not.toMatch(/Fake Referral Firm|referralSolicitorId|ref@example/);
    const on = await caseTimeline(db.pool("app_candidate"), "candidate", a.cand, a.c, true);
    expect(on!.events.at(-1)).toMatchObject({ referral: { code: "referred_to_solicitor", firm: "Fake Referral Firm" } });
    expect(JSON.stringify(on)).not.toMatch(/ref@example|referralSolicitorId/);
    expect((await caseTimeline(db.pool("app_candidate"), "candidate", b.cand, b.c, true))!.events.at(-1)).toMatchObject({ referral: { code: "referred_to_solicitor" } });
    // another candidate reads nothing, firm or not; the other side's wrapper is not the candidate login's
    expect(await caseTimeline(db.pool("app_candidate"), "candidate", b.cand, a.c, true)).toBeNull();
    await expect(caseTimeline(db.pool("app_candidate"), "portal", a.cand, a.c, true)).rejects.toThrow(/permission denied/);
    await expect(db.pool("app_candidate").query("select private.portal_case_referral_firm($1, $2)", [a.cand, a.c])).rejects.toThrow(/permission denied/);
    await expect(db.pool("app_portal").query("select private.candidate_case_referral_firm($1, $2)", [a.cand, a.c])).rejects.toThrow(/permission denied/);
    for (const r of ["app_admin", "app_fetcher"] as const) await expect(db.pool(r).query("select private.case_referral_firm('candidate', $1, $2)", [a.cand, a.c])).rejects.toThrow(/permission denied/);
  });
});

describe("notices (M5) and what the requester sees", () => {
  it("one in-app notice per event to the requester; an email only for documents_needed, decision, closed and referred; none for an erased requester", async () => {
    const a = await candidateCase();
    await h.ok(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    await h.ok(act("h1", { action: "status", caseId: a.c, status: "documents_needed" }));
    await h.ok(act("h1", { action: "documents", caseId: a.c, codes: ["payslip"] }));
    await h.ok(act("h1", { action: "status", caseId: a.c, status: "submitted" }));
    await h.ok(act("h1", { action: "status", caseId: a.c, status: "decision" }));
    await h.ok(act("h1", { action: "decision", caseId: a.c, outcome: "refused" }));
    await h.ok(act("h1", { action: "note", caseId: a.c, body: "Secret staff note text" }));
    await h.ok(act("h1", { action: "close", caseId: a.c, reason: "decided" }));
    const n = await rows("select candidate_user_id u, portal_user_id p, category, template_key, params from notification where params->>'caseId' = $1 order by id", [a.c]);
    expect(n.map((x) => x.params.kind)).toEqual(["received", "assigned", "status_changed", "documents_needed", "status_changed", "status_changed", "decision", "closed"]);
    expect(n.every((x) => x.u === a.cand && x.p === null && x.category === "services_case" && x.template_key === "case_update")).toBe(true);
    const e = await rows("select template, candidate_user_id u, params from email_outbox where params->>'caseId' = $1 order by id", [a.c]);
    expect(e).toEqual([0, 1, 2].map(() => ({ template: "case_update", u: a.cand, params: { caseId: a.c } })));
    // erased: the action still works, nothing is sent
    const b = await candidateCase();
    await su.query("update services_case set requester_erased_at = now() where id = $1", [b.c]);
    await h.ok(act("h1", { action: "assign", caseId: b.c, staffUserId: h.staff.h1 }));
    await h.ok(act("h1", { action: "close", caseId: b.c, reason: "no_reply" }));
    const before = (await rows("select 1 from notification where params->>'caseId' = $1", [b.c])).length;
    expect(before).toBe(1); // only the received event, written before the erasure
    expect(await rows("select 1 from email_outbox where params->>'caseId' = $1", [b.c])).toEqual([]);
  });

  it("a portal case notifies its requester only, not the company's Owner; the Owner still reads the timeline", async () => {
    const p = await portalCase();
    await h.ok(act("h2", { action: "assign", caseId: p.c, staffUserId: h.staff.h2 }));
    await h.ok(act("h2", { action: "refer", caseId: p.c }));
    expect(await rows("select portal_user_id u from notification where params->>'caseId' = $1 order by id", [p.c])).toEqual([{ u: p.requester }, { u: p.requester }, { u: p.requester }]);
    expect(await rows("select portal_user_id u from email_outbox where params->>'caseId' = $1", [p.c])).toEqual([{ u: p.requester }]);
    const t = await caseTimeline(db.pool("app_portal"), "portal", p.owner, p.c);
    expect(t!.events.map((x) => x.kind)).toEqual(["received", "assigned", "referred"]);
  });

  it("the requester's timeline and email carry no staff id, staff name or note; the email has no case detail", async () => {
    const a = await candidateCase();
    await h.ok(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    await h.ok(act("h1", { action: "documents", caseId: a.c, codes: ["degree", "other"] }));
    await h.ok(act("h1", { action: "note", caseId: a.c, body: "Secret staff note text" }));
    const t = await caseTimeline(db.pool("app_candidate"), "candidate", a.cand, a.c);
    expect(t!.events[2]).toEqual({ at: expect.any(String), kind: "documents_needed", status: "received",
      documentsNeeded: [{ code: "degree", label: "Degree or qualification" }, { code: "other", label: "Other document" }] });
    const s = JSON.stringify(t);
    for (const bad of [h.staff.h1!, h.staff.ad!, "Fake h1", "Secret staff note", "assignedStaffUserId", "staff"]) expect(s).not.toContain(bad);
    const { sendPending } = await import("../src/outbox-cli.ts");
    const sent: { to: string; subject: string; text: string; html: string }[] = [];
    await sendPending(db.pool("app_admin"), async (to, subject, text, html) => void sent.push({ to, subject, text, html }), 200, () => {}, "https://www.example.test", "https://employers.example.test");
    const email = (await one("select email from candidate_user where id = $1", [a.cand])).email as string;
    const mine = sent.filter((x) => x.to === email);
    expect(mine.map((x) => x.subject)).toEqual(["Your case has an update"]);
    for (const bad of [a.c, "degree", "Degree", h.staff.h1!, "Fake h1", "Secret", "documents_needed"]) {
      expect(mine[0]!.text).not.toContain(bad);
      expect(mine[0]!.html).not.toContain(bad);
    }
    expect(mine[0]!.text).toContain("https://www.example.test/");
  });

  it("the staff counts: open cases unassigned and assigned to me, for handlers only", async () => {
    const c = await su.connect();
    try {
      const base = await staffCounts(c, h.staff.h2!, ["services_case_handler"]);
      const a = await candidateCase();
      const after1 = await staffCounts(c, h.staff.h2!, ["services_case_handler"]);
      expect([after1.casesUnassigned! - base.casesUnassigned!, after1.casesMine! - base.casesMine!]).toEqual([1, 0]);
      await h.ok(act("h2", { action: "assign", caseId: a.c, staffUserId: h.staff.h2 }));
      const after2 = await staffCounts(c, h.staff.h2!, ["services_case_handler"]);
      expect([after2.casesUnassigned! - base.casesUnassigned!, after2.casesMine! - base.casesMine!]).toEqual([0, 1]);
      expect(await staffCounts(c, h.staff.ad!, ["administrator"])).toMatchObject({ casesUnassigned: null, casesMine: null });
    } finally {
      c.release();
    }
  });
});

describe("OpenAPI (#248)", () => {
  it("every reply of both routes matches docs/openapi/admin.yaml", async () => {
    const spec = loadSpec("admin");
    const a = await candidateCase();
    const fits = async (method: "GET" | "POST", path: string, r: Promise<{ status: number; json: unknown }>) => {
      const x = await r;
      expect(replyProblems(spec, method, path, x.status, x.json), `${method} ${path} ${x.status}`).toEqual([]);
    };
    await fits("GET", P, h.call(CASES, P, "h1", undefined, { query: "?status=received" }));
    await fits("GET", P, open("h1", a.c));
    await fits("GET", P, open("ad", a.c));
    await fits("GET", P, open("h1", "999999999"));
    await fits("GET", P, h.call(CASES, P, "only_content_editor", undefined, { query: "?status=received" }));
    await fits("POST", P, act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    await fits("POST", P, act("h1", { action: "note", caseId: a.c, body: "Fake" }));
    await fits("GET", P, open("h1", a.c));
    await fits("POST", P, act("h1", { action: "status", caseId: a.c, status: "decision" }));
    await fits("POST", P, act("h2", { action: "status", caseId: a.c, status: "submitted" }));
    await fits("POST", P, act("h1", { action: "documents", caseId: a.c, codes: ["nope"] }));
    const S = "/api/services/solicitors";
    await fits("GET", S, h.call(SOL, S, "h1"));
    await fits("POST", S, h.call(SOL, S, "ad", { action: "add", firm: "Spec Firm", contact: "spec@example.test" }));
    await fits("POST", S, h.call(SOL, S, "h1", { action: "add", firm: "Spec Firm", contact: "spec@example.test" }));
    await fits("POST", S, h.call(SOL, S, "ad", { action: "deactivate", solicitorId: "999999999" }));
  });
});

describe("perf", () => {
  it("the board list over 10,000 open cases stays on the index; one open, each action and the timeline within budget", async () => {
    const pu = await F.portal();
    const consent = (await one("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [pu, text])).id;
    await su.query(`insert into services_case(portal_user_id, consent_record_id, dedupe_key, status, created_at, decided_at)
      select $1, $2, 'perf-' || g, (array['received','documents_needed','waiting_for_employer','submitted','decision'])[1 + g % 5], now() - g * interval '1 minute',
             case when g % 5 = 4 then now() end from generate_series(1, 10000) g`, [pu, consent]);
    await su.query("analyze services_case");
    const pages = async (sql: string, args: unknown[]) => {
      const c = await db.pool("app_admin").connect();
      try {
        await c.query(sql, args);
        const plan = (await c.query(`explain (analyze, buffers, format json) ${sql}`, args)).rows[0]["QUERY PLAN"][0];
        return { pages: plan.Plan["Shared Hit Blocks"] + (plan.Plan["Shared Read Blocks"] ?? 0), plan: JSON.stringify(plan) };
      } finally {
        c.release();
      }
    };
    const first = await pages(BOARD_FIRST, ["submitted"]);
    const page1 = await h.ok(h.call(CASES, P, "h1", undefined, { query: "?status=submitted" }));
    const last = page1.items.at(-1);
    const after = await pages(BOARD_AFTER, ["submitted", last.createdAt, last.id]);
    expect(first.plan).toContain("services_case_board_idx");
    expect(after.plan).toContain("services_case_board_idx");
    const counts = await pages(STAFF_COUNTS, [[], [], false, false, false, false, h.staff.h1, true]);
    const a = await candidateCase();
    await h.ok(act("h1", { action: "assign", caseId: a.c, staffUserId: h.staff.h1 }));
    const [, openN] = await counted(() => h.ok(open("h1", a.c)));
    const openMs = await median(() => h.ok(open("h1", a.c)));
    // each action, counted once, then the median of 9 notes (a note is the action with no event; status pairs flip back and forth)
    const per: Record<string, number> = {};
    for (const [k, b] of [["status", { action: "status", caseId: a.c, status: "documents_needed" }], ["documents", { action: "documents", caseId: a.c, codes: ["cv"] }],
      ["note", { action: "note", caseId: a.c, body: "Fake note" }], ["status2", { action: "status", caseId: a.c, status: "waiting_for_employer" }]] as const) per[k] = (await counted(() => h.ok(act("h1", b))))[1];
    const actMs = await median((i) => h.ok(act("h1", { action: "status", caseId: a.c, status: i % 2 ? "waiting_for_employer" : "documents_needed" })));
    const assignMs = await median((i) => h.ok(act("ad", { action: "assign", caseId: a.c, staffUserId: i % 2 ? h.staff.h1 : h.staff.h2 })));
    const tlMs = await median(() => caseTimeline(db.pool("app_candidate"), "candidate", a.cand, a.c));
    console.log(`board list ${first.pages} / ${after.pages} pages; counts ${counts.pages} pages; open ${openN} statements ${openMs.toFixed(1)} ms; actions ${JSON.stringify(per)} statements, status ${actMs.toFixed(1)} ms, assign ${assignMs.toFixed(1)} ms; timeline ${tlMs.toFixed(2)} ms`);
    expect(first.pages).toBeLessThanOrEqual(BUDGET.listPages);
    expect(after.pages).toBeLessThanOrEqual(BUDGET.listPages);
    expect(counts.pages).toBeLessThanOrEqual(BUDGET.countsPages);
    expect(openN).toBeLessThanOrEqual(BUDGET.openStatements);
    expect(openMs).toBeLessThanOrEqual(BUDGET.openMs);
    for (const v of Object.values(per)) expect(v).toBeLessThanOrEqual(BUDGET.actionStatements);
    expect(actMs).toBeLessThanOrEqual(BUDGET.actionMs);
    expect(assignMs).toBeLessThanOrEqual(BUDGET.actionMs);
    expect(tlMs).toBeLessThanOrEqual(BUDGET.timelineMs);
  });
});
