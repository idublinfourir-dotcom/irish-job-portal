// Integration: the permit services schema (migration 0061, step 15 SV-0) on the real test database. Checks and guards through real inserts and
// updates as the app roles; the reader rule and the timeline through the real functions as app_candidate and app_portal. Fake people only; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, ROLES, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { median } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// Perf, measured 20 Nov 2026 on the test database (this file alone, 200 events on the case and 2000 on ten other cases): case_timeline 15 shared
// pages and 1.6 ms (median of 9), case_readable_by 9 pages and 0.55 ms. Page limits leave room for one more index level; time limits about 4 times
// the measure. The timeline query's plan must also name case_event_case_idx (a sequential scan would still read few pages at this size).
const BUDGET = { timelinePages: 25, timelineMs: 7, readablePages: 12, readableMs: 2.5 };

let db: TestDb, su: pg.Pool;
type Fx = {
  id: (p: string) => string;
  F: { cand: () => Promise<string>; portal: () => Promise<string>; staff: () => Promise<string>; org: () => Promise<string>; member: (org: string, user: string, o?: { role?: string }) => Promise<string>; text: (p: string) => Promise<string> };
};
let F: Fx["F"], id: Fx["id"];
let text: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F, id } = fixtures(db) as unknown as Fx);
  text = await F.text("services_request");
});
afterAll(async () => db.drop());

const q = (role: Parameters<TestDb["query"]>[0], sql: string, args: unknown[] = []) => db.query(role, sql, args);
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
/** The error text of a refused call, or "accepted". Takes a function so nothing runs before the catch is ready. */
const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return `${(e as { code?: string }).code ?? ""} ${(e as Error).message}`;
  }
  return "accepted";
};

async function candidateCase(org?: string) {
  const cand = await F.cand();
  const consent = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, text])).id;
  const c = (await one("insert into services_case(candidate_user_id, organisation_id, consent_record_id) values ($1, $2, $3) returning id::text id", [cand, org ?? null, consent])).id as string;
  return { cand, c };
}
async function portalCase() {
  const org = await F.org();
  const requester = await F.portal(), owner = await F.portal(), recruiter = await F.portal(), poster = await F.portal(), viewer = await F.portal();
  await F.member(org, requester, { role: "recruiter" });
  await F.member(org, owner, { role: "account_owner" });
  await F.member(org, recruiter, { role: "recruiter" });
  await F.member(org, poster, { role: "poster" });
  await F.member(org, viewer, { role: "viewer" });
  const consent = (await one("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [requester, text])).id;
  const c = (await one("insert into services_case(portal_user_id, organisation_id, consent_record_id, dedupe_key) values ($1, $2, $3, $4) returning id::text id", [requester, org, consent, id("k")])).id as string;
  return { org, requester, owner, recruiter, poster, viewer, c };
}
const setCase = (c: string, set: string, args: unknown[] = []) => () => q("app_admin", `update services_case set ${set} where id = $1`, [c, ...args]);
const event = (c: string, kind: string, status: string, detail: unknown = {}, staff: string | null = null) =>
  () => q("app_admin", "insert into case_event(case_id, kind, status, detail, staff_user_id) values ($1, $2, $3, $4, $5)", [c, kind, status, JSON.stringify(detail), staff]);

describe("services_case columns", () => {
  it("decision_outcome: granted or refused, only at decision or closed, and a closed case with an outcome was decided", async () => {
    const { c } = await candidateCase();
    expect(await refusal(setCase(c, "status = 'decision', decision_outcome = 'maybe'"))).toMatch(/check/);
    expect(await refusal(setCase(c, "decision_outcome = 'granted'"))).toMatch(/services_case_outcome_status/);
    expect(await refusal(setCase(c, "status = 'submitted', decision_outcome = 'refused'"))).toMatch(/services_case_outcome_status/);
    expect(await refusal(setCase(c, "status = 'decision', decided_at = now(), decision_outcome = 'granted'"))).toBe("accepted");
    expect(await refusal(setCase(c, "status = 'closed', closed_at = now(), close_reason = 'withdrawn'"))).toMatch(/services_case_outcome_closed/);
    expect(await refusal(setCase(c, "status = 'closed', closed_at = now(), close_reason = 'decided', decision_outcome = 'refused'"))).toBe("accepted");
    expect(await refusal(setCase(c, "decision_outcome = null, close_reason = 'withdrawn'"))).toBe("accepted"); // no outcome: any close reason
  });

  it("documents_needed: an array of codes, at most 30, no duplicates, empty by default", async () => {
    const { c } = await candidateCase();
    expect((await one("select documents_needed from services_case where id = $1", [c])).documents_needed).toEqual([]);
    const set = (v: unknown) => setCase(c, "documents_needed = $2", [v]);
    expect(await refusal(set(["passport", "offer_letter", "p45_2026", "a".repeat(40)]))).toBe("accepted");
    expect(await refusal(set(Array.from({ length: 30 }, (_, i) => `doc_${i}`)))).toBe("accepted");
    expect(await refusal(set([]))).toBe("accepted");
    for (const bad of [["Passport"], ["1passport"], ["_x"], ["a".repeat(41)], ["has space"], ["dash-code"], ["passport", "passport"], [null], [""], ["x\n"],
      Array.from({ length: 31 }, (_, i) => `doc_${i}`)])
      expect(await refusal(set(bad)), JSON.stringify(bad)).toMatch(/documents_needed|check/);
    expect(await refusal(setCase(c, "documents_needed = '{{a,b},{c,d}}'"))).toMatch(/check/);
    expect(await refusal(setCase(c, "documents_needed = null"))).toMatch(/null/);
  });
});

describe("referral_solicitor", () => {
  it("firm and contact are trimmed, sized and free of control characters; only app_admin writes; nobody deletes", async () => {
    const staff = await F.staff();
    const add = (firm: string, contact = "Fake contact, 1 Fake Street") => () => q("app_admin", "insert into referral_solicitor(firm, contact, created_by_staff_user_id) values ($1, $2, $3)", [firm, contact, staff]);
    expect(await refusal(add("Fake & Co Solicitors"))).toBe("accepted");
    expect(await refusal(add("F".repeat(200), "c".repeat(300)))).toBe("accepted");
    for (const [firm, contact] of [["", "c"], ["   ", "c"], [" Fake", "c"], ["Fake ", "c"], ["F".repeat(201), "c"], ["Fa\nke", "c"], ["Fa\u0007ke", "c"], ["Fake", ""], ["Fake", "c".repeat(301)], ["Fake", "a\tb"], ["Fake", "a\u001bb"]])
      expect(await refusal(add(firm!, contact)), JSON.stringify([firm, contact])).toMatch(/check/);
    expect(await refusal(() => q("app_admin", "insert into referral_solicitor(firm, contact) values ('Fake', 'c')"))).toMatch(/null/);
    const r = (await one("select id::text from referral_solicitor order by id limit 1")).id;
    expect(await refusal(() => q("app_admin", "update referral_solicitor set active = false where id = $1", [r]))).toBe("accepted");
    expect(await refusal(() => q("app_admin", "delete from referral_solicitor where id = $1", [r]))).toMatch(/permission denied/);
    for (const role of ["app_candidate", "app_portal", "app_fetcher"] as const)
      expect(await refusal(() => q(role, "select * from referral_solicitor"))).toMatch(/permission denied/);
  });

  it("services_case.referral_solicitor_id only on a case closed as referred_to_solicitor", async () => {
    const staff = await F.staff();
    const r = (await one("insert into referral_solicitor(firm, contact, created_by_staff_user_id) values ('Fake Firm', 'Fake contact', $1) returning id::text", [staff])).id;
    const { c } = await candidateCase();
    expect(await refusal(setCase(c, "referral_solicitor_id = $2", [r]))).toMatch(/services_case_referral_reason/);
    expect(await refusal(setCase(c, "status = 'closed', closed_at = now(), close_reason = 'no_reply', referral_solicitor_id = $2", [r]))).toMatch(/services_case_referral_reason/);
    expect(await refusal(setCase(c, "status = 'closed', closed_at = now(), close_reason = 'referred_to_solicitor', referral_solicitor_id = $2", [r]))).toBe("accepted");
    expect(await refusal(setCase(c, "referral_solicitor_id = 999999999"))).toMatch(/foreign key/);
  });
});

describe("case_event", () => {
  it("kind, status and detail are checked: an object of known keys, codes and ids only, at most 2 KB", async () => {
    const { c } = await candidateCase();
    const staff = await F.staff();
    const sol = (await one("insert into referral_solicitor(firm, contact, created_by_staff_user_id) values ('Fake Firm', 'Fake contact', $1) returning id", [staff])).id;
    for (const kind of ["received", "assigned", "status_changed", "documents_needed", "decision", "closed", "referred", "withdrawn"])
      expect(await refusal(event(c, kind, "received", {}, staff)), kind).toBe("accepted");
    expect(await refusal(event(c, "documents_needed", "documents_needed", { documentsNeeded: ["passport", "offer_letter"] }, staff))).toBe("accepted");
    expect(await refusal(event(c, "decision", "decision", { outcome: "refused" }, staff))).toBe("accepted");
    expect(await refusal(event(c, "referred", "closed", { referralSolicitorId: Number(sol) }, staff))).toBe("accepted");
    expect(await refusal(event(c, "assigned", "received", { assignedStaffUserId: staff }, staff))).toBe("accepted");
    expect(await refusal(event(c, "noted", "received"))).toMatch(/check/);
    expect(await refusal(event(c, "received", "open"))).toMatch(/check/);
    for (const bad of [[], "text", 1, null, { note: "free text" }, { outcome: "maybe" }, { outcome: ["granted"] }, { documentsNeeded: "passport" },
      { documentsNeeded: ["Passport"] }, { documentsNeeded: [1] }, { documentsNeeded: ["a", "a"] }, { documentsNeeded: Array.from({ length: 31 }, (_, i) => `d${i}`) },
      { referralSolicitorId: "1" }, { referralSolicitorId: 0 }, { referralSolicitorId: 1.5 }, { referralSolicitorId: -1 }, { assignedStaffUserId: "a b" },
      { assignedStaffUserId: 5 }, { outcome: "granted", extra: "x".repeat(3000) }])
      expect(await refusal(event(c, "status_changed", "received", bad)), JSON.stringify(bad)).toMatch(/check|null/);
    // 2 KB: 30 codes of 40 characters are about 1.3 KB and pass; the cap holds the column whatever later keys add
    expect(await refusal(event(c, "documents_needed", "documents_needed", { documentsNeeded: Array.from({ length: 30 }, (_, i) => `${"d".repeat(37)}${String(i).padStart(3, "0")}`) }))).toBe("accepted");
    // an app role cannot backdate an event
    await q("app_admin", "insert into case_event(case_id, kind, status, at) values ($1, 'received', 'received', '2000-01-01')", [c]);
    expect((await one("select min(at) > now() - interval '1 hour' recent from case_event where case_id = $1", [c])).recent).toBe(true);
    // gone with its case
    await su.query("delete from services_case where id = $1", [c]);
    expect((await one("select count(*)::int n from case_event where case_id = $1", [c])).n).toBe(0);
  });

  it("no app role updates or deletes an event; the requester roles never read the table", async () => {
    const { c, cand } = await candidateCase();
    await event(c, "received", "received")();
    for (const role of ["app_admin", "app_candidate", "app_portal", "app_fetcher", "app_backup"] as const) {
      expect(await refusal(() => q(role, "update case_event set kind = 'closed' where case_id = $1", [c])), role).toMatch(/permission denied/);
      expect(await refusal(() => q(role, "delete from case_event where case_id = $1", [c])), role).toMatch(/permission denied/);
    }
    for (const role of ["app_candidate", "app_portal", "app_fetcher"] as const)
      expect(await refusal(() => q(role, "select * from case_event")), role).toMatch(/permission denied/);
    expect(await refusal(() => q("app_candidate", "select staff_user_id from case_event where candidate_user_id = $1", [cand]))).toMatch(/permission denied/);
  });

  it("a requester writes only received or withdrawn, on a case it can read, naming itself, with no detail", async () => {
    const { c, cand } = await candidateCase();
    const other = await F.cand();
    const p = await portalCase();
    const cIns = (cols: string, vals: unknown[]) => () => q("app_candidate", `insert into case_event(${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    const pIns = (cols: string, vals: unknown[]) => () => q("app_portal", `insert into case_event(${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    const cols = "case_id, kind, status, candidate_user_id", pcols = "case_id, kind, status, portal_user_id";
    expect(await refusal(cIns(cols, [c, "received", "received", cand]))).toBe("accepted");
    expect(await refusal(cIns(cols, [c, "withdrawn", "closed", cand]))).toBe("accepted");
    for (const kind of ["assigned", "status_changed", "documents_needed", "decision", "closed", "referred"])
      expect(await refusal(cIns(cols, [c, kind, "closed", cand])), kind).toMatch(/only received or withdrawn/);
    expect(await refusal(cIns(cols, [c, "received", "decision", cand]))).toMatch(/received is at status received/);
    expect(await refusal(cIns(cols, [c, "withdrawn", "received", cand]))).toMatch(/received is at status received/);
    expect(await refusal(cIns(cols, [c, "received", "received", other]))).toMatch(/not a case of this login/); // another candidate
    expect(await refusal(cIns("case_id, kind, status", [c, "received", "received"]))).toMatch(/not a case of this login/); // nobody named
    expect(await refusal(cIns(cols, [p.c, "received", "received", cand]))).toMatch(/not a case of this login/); // a portal case
    expect(await refusal(cIns(cols, ["999999999", "received", "received", cand]))).toMatch(/not a case of this login/);
    expect(await refusal(cIns(`${cols}, detail`, [c, "received", "received", cand, "{}"]))).toMatch(/permission denied/);
    expect(await refusal(cIns(`${cols}, staff_user_id`, [c, "received", "received", cand, null]))).toMatch(/permission denied/);
    expect(await refusal(cIns(`${cols}, at`, [c, "received", "received", cand, "2000-01-01"]))).toMatch(/permission denied/);
    expect(await refusal(cIns("case_id, kind, status, portal_user_id", [p.c, "received", "received", p.requester]))).toMatch(/permission denied/);
    expect(await refusal(cIns(cols, ["1; drop table case_event", "received", "received", cand]))).toMatch(/invalid input syntax/);
    // portal: the requester and an owner or recruiter of the company; not a poster, a viewer, another company's owner or a candidate's id
    expect(await refusal(pIns(pcols, [p.c, "received", "received", p.requester]))).toBe("accepted");
    expect(await refusal(pIns(pcols, [p.c, "withdrawn", "closed", p.owner]))).toBe("accepted");
    expect(await refusal(pIns(pcols, [p.c, "withdrawn", "closed", p.recruiter]))).toBe("accepted");
    const q2 = await portalCase();
    for (const who of [p.poster, p.viewer, q2.owner]) expect(await refusal(pIns(pcols, [p.c, "withdrawn", "closed", who]))).toMatch(/not a case of this login/);
    expect(await refusal(pIns(pcols, [p.c, "decision", "decision", p.requester]))).toMatch(/only received or withdrawn/);
    expect(await refusal(pIns(pcols, [c, "received", "received", p.requester]))).toMatch(/not a case of this login/);
    expect(await refusal(pIns("case_id, kind, status, candidate_user_id", [c, "received", "received", cand]))).toMatch(/permission denied/);
    // what was written names its writer and nothing else
    expect((await su.query("select candidate_user_id, portal_user_id, staff_user_id, detail from case_event where case_id = $1 order by id", [c])).rows)
      .toEqual([{ candidate_user_id: cand, portal_user_id: null, staff_user_id: null, detail: {} }, { candidate_user_id: cand, portal_user_id: null, staff_user_id: null, detail: {} }]);
  });
});

describe("the reader rule and the timeline", () => {
  const readable = async (role: "app_candidate" | "app_portal", side: string, user: string | null, c: string | null) =>
    (await q(role, "select private.case_readable_by($1, $2, $3) r", [side, user, c])).rows[0].r;

  it("case_readable_by: the requester, an Owner and a Recruiter of the company; not a Poster, a Viewer, another company or another candidate", async () => {
    const p = await portalCase(), p2 = await portalCase();
    const { c, cand } = await candidateCase(p.org);
    const other = await F.cand();
    for (const role of ["app_candidate", "app_portal"] as const) {
      expect(await readable(role, "candidate", cand, c)).toBe(true);
      expect(await readable(role, "candidate", other, c)).toBe(false);
      expect(await readable(role, "portal", p.requester, p.c)).toBe(true);
      expect(await readable(role, "portal", p.owner, p.c)).toBe(true);
      expect(await readable(role, "portal", p.recruiter, p.c)).toBe(true);
      for (const who of [p.poster, p.viewer, p2.owner, p2.recruiter]) expect(await readable(role, "portal", who, p.c)).toBe(false);
      // a candidate's case that names the company is not the company's to read (20d:109)
      expect(await readable(role, "portal", p.owner, c)).toBe(false);
      expect(await readable(role, "portal", p.recruiter, c)).toBe(false);
      expect(await readable(role, "candidate", p.requester, p.c)).toBe(false); // wrong side
      expect(await readable(role, "portal", cand, c)).toBe(false);
      for (const side of ["", "admin", "Candidate", " candidate"]) expect(await readable(role, side, cand, c), side).toBe(false);
      expect(await refusal(() => readable(role, "candidate\u0000", cand, c))).toMatch(/0x00|invalid byte/);
      expect(await refusal(() => readable(role, "candidate", cand, "1 or 1=1"))).toMatch(/invalid input syntax/);
      expect(await readable(role, "candidate", null, c)).toBe(false);
      expect(await readable(role, "candidate", cand, null)).toBe(false);
      expect(await readable(role, "candidate", cand, "999999999")).toBe(false);
      expect(await readable(role, "candidate", "x".repeat(10000), c)).toBe(false);
    }
    // a member who left, or one awaiting approval, reads no more
    await su.query("update membership set status = 'removed', removed_at = now() where portal_user_id = $1", [p.owner]);
    expect(await readable("app_portal", "portal", p.owner, p.c)).toBe(false);
    for (const role of ["app_admin", "app_fetcher", "app_backup"] as const)
      expect(await refusal(() => q(role, "select private.case_readable_by('candidate', $1, $2)", [cand, c])), role).toMatch(/permission denied/);
  });

  it("case_timeline: the requester's view, in order; never staff_user_id, assignee or a note; empty for a stranger", async () => {
    const p = await portalCase();
    const staff = await F.staff();
    await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1, $2, 'INTERNALNOTE')", [p.c, staff]);
    await q("app_portal", "insert into case_event(case_id, kind, status, portal_user_id) values ($1, 'received', 'received', $2)", [p.c, p.requester]);
    await event(p.c, "assigned", "received", { assignedStaffUserId: staff }, staff)();
    await event(p.c, "documents_needed", "documents_needed", { documentsNeeded: ["passport"] }, staff)();
    await event(p.c, "decision", "decision", { outcome: "granted" }, staff)();
    const tl = async (side: string, user: string, c = p.c, role: "app_candidate" | "app_portal" = "app_portal") =>
      (await q(role, "select * from private.case_timeline($1, $2, $3)", [side, user, c])).rows;
    const rows = await tl("portal", p.owner);
    expect(rows.map((r) => [r.kind, r.status, r.detail])).toEqual([
      ["received", "received", {}], ["assigned", "received", {}], ["documents_needed", "documents_needed", { documentsNeeded: ["passport"] }], ["decision", "decision", { outcome: "granted" }]]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["at", "detail", "kind", "status"]);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${staff}|INTERNALNOTE|${p.requester}`));
    expect(await tl("portal", p.requester)).toHaveLength(4);
    expect(await tl("portal", p.recruiter, p.c, "app_candidate")).toHaveLength(4);
    for (const who of [p.poster, p.viewer, (await portalCase()).owner]) expect(await tl("portal", who)).toEqual([]);
    expect(await tl("candidate", p.requester)).toEqual([]);
    expect(await tl("portal", p.requester, "999999999")).toEqual([]);
    for (const role of ["app_admin", "app_fetcher"] as const)
      expect(await refusal(() => q(role, "select * from private.case_timeline('portal', $1, $2)", [p.owner, p.c])), role).toMatch(/permission denied/);
  });
});

describe("grants", () => {
  it("every role's rights on referral_solicitor and case_event, and on the two functions", async () => {
    const all = [...ROLES, "anon", "authenticated"];
    const rights = async (table: string) => Object.fromEntries((await su.query(
      `select r, array_remove(array[case when has_table_privilege(r, $1, 'select') then 'select' end, case when has_table_privilege(r, $1, 'insert') then 'insert' end,
              case when has_table_privilege(r, $1, 'update') then 'update' end, case when has_table_privilege(r, $1, 'delete') then 'delete' end,
              case when has_table_privilege(r, $1, 'truncate') then 'truncate' end], null) p from unnest($2::text[]) r`, [table, all])).rows.map((x) => [x.r, x.p]));
    expect(await rights("referral_solicitor")).toEqual({ portal_owner: ["select", "insert", "update", "delete", "truncate"], app_admin: ["select", "insert", "update"],
      app_candidate: [], app_portal: [], app_fetcher: [], app_backup: ["select"], anon: [], authenticated: [] });
    expect(await rights("case_event")).toEqual({ portal_owner: ["select", "insert", "update", "delete", "truncate"], app_admin: ["select", "insert"],
      app_candidate: [], app_portal: [], app_fetcher: [], app_backup: ["select"], anon: [], authenticated: [] });
    // the requester roles insert named columns only
    const cols = async (role: string) => (await su.query("select column_name::text c from information_schema.column_privileges where table_name = 'case_event' and grantee = $1 and privilege_type = 'INSERT' order by 1", [role])).rows.map((x) => x.c);
    expect(await cols("app_candidate")).toEqual(["candidate_user_id", "case_id", "kind", "status"]);
    expect(await cols("app_portal")).toEqual(["case_id", "kind", "portal_user_id", "status"]);
    for (const fn of ["private.case_readable_by(text, text, bigint)", "private.case_timeline(text, text, bigint)"]) {
      const can = (await su.query("select r from unnest($2::text[]) r where has_function_privilege(r, $1, 'execute') order by r", [fn, all])).rows.map((x) => x.r);
      expect(can, fn).toEqual(["app_candidate", "app_portal", "portal_owner"]);
    }
    const def = (await one("select bool_and(prosecdef) d, bool_and(provolatile = 's') s, bool_and(proconfig @> '{\"search_path=public, pg_temp\"}') p from pg_proc where proname in ('case_readable_by', 'case_timeline')"));
    expect(def).toEqual({ d: true, s: true, p: true });
  });
});

describe("perf", () => {
  it("case_timeline over 200 events and case_readable_by stay on the index, within budget", async () => {
    const p = await portalCase();
    const staff = await F.staff();
    await su.query("insert into case_event(case_id, kind, status, detail, staff_user_id) select $1, 'status_changed', 'submitted', '{\"documentsNeeded\":[\"passport\"]}', $2 from generate_series(1, 200)", [p.c, staff]);
    for (let i = 0; i < 10; i++) {
      const o = await portalCase();
      await su.query("insert into case_event(case_id, kind, status) select $1, 'status_changed', 'submitted' from generate_series(1, 200)", [o.c]);
    }
    await su.query("analyze case_event");
    const pages = async (sql: string, args: unknown[]) => {
      const c = await db.pool("app_portal").connect();
      try {
        await c.query(sql, args); // warm
        const plan = (await c.query(`explain (analyze, buffers, format json) ${sql}`, args)).rows[0]["QUERY PLAN"][0];
        return plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
      } finally {
        c.release();
      }
    };
    const T = "select * from private.case_timeline('portal', $1, $2)", R = "select private.case_readable_by('portal', $1, $2)";
    expect((await q("app_portal", T, [p.owner, p.c])).rows).toHaveLength(200);
    const tp = await pages(T, [p.owner, p.c]), rp = await pages(R, [p.owner, p.c]);
    const tms = await median(() => q("app_portal", T, [p.owner, p.c])), rms = await median(() => q("app_portal", R, [p.owner, p.c]));
    console.log(`case_timeline: ${tp} pages, ${tms.toFixed(2)} ms; case_readable_by: ${rp} pages, ${rms.toFixed(2)} ms`);
    expect(tp).toBeLessThanOrEqual(BUDGET.timelinePages);
    expect(rp).toBeLessThanOrEqual(BUDGET.readablePages);
    expect(tms).toBeLessThanOrEqual(BUDGET.timelineMs);
    expect(rms).toBeLessThanOrEqual(BUDGET.readableMs);
    // the timeline's own query uses the (case_id, at, id) index
    const plan = JSON.stringify((await su.query("explain (format json) select e.at, e.kind, e.status, e.detail from case_event e where e.case_id = $1 order by e.at, e.id", [p.c])).rows[0]);
    expect(plan).toMatch(/case_event_case_idx/);
  });
});
