// Integration (N5): the portal notices for team removal, owner transfer, pay floor decisions, a job hidden by a report and the report outcome, on the real
// test database through the real functions (the team functions as app_portal, the staff ones as app_admin). Each event writes exactly its notices and
// outbox rows, to the right people, or nothing when the event fails. Companies, members, jobs and reports are written as postgres. Nothing is sent; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeOwnerReassign, requestOwnerReassign } from "../src/owner-reassign";
import { confirmFloor, proposeFloor, rejectFloor } from "../src/pay-floors";
import { clearReport, hideReportedJob, upholdReport } from "../src/trust-safety";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { makeBig } from "./pay-floors-helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb, su: pg.Pool, admin: pg.Pool, portal: pg.Pool;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; cand(): Promise<string>; member(org: number, user: string | null, o?: object): Promise<number>; staff(): Promise<string>; text(p?: string): Promise<number> };
const staff: Record<string, string> = {};
let source: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  portal = db.pool("app_portal");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  for (const role of ["account_reviewer", "rules_data_editor", "administrator", "trust_and_safety"]) {
    staff[role] = await F.staff();
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, $2, true)", [staff[role], role]);
  }
  source = (await su.query("select id::text from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  // A failure the tests switch on: the outbox refuses a row whose template is in fail_templates, so the event and its notice must both roll back.
  await su.query(`create table fail_templates(t text primary key);
    create function fail_outbox() returns trigger language plpgsql security definer set search_path = public as $$ begin
      if exists (select 1 from fail_templates where t = new.template) then raise exception 'fake outbox failure'; end if; return new; end $$;
    create trigger fail_outbox before insert on email_outbox for each row execute function fail_outbox();`);
});
afterAll(async () => {
  await db.drop();
});

const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
/** Every notice and outbox row of one portal user (all templates), oldest first. */
const notes = async (u: string) => (await su.query("select template_key t, category, organisation_id::text org, params from notification where portal_user_id = $1 order by id", [u])).rows;
const mails = async (u: string) => (await su.query("select template t, params, status from email_outbox where portal_user_id = $1 order by id", [u])).rows;
const candMails = async (u: string) => (await su.query("select template t, params, status from email_outbox where candidate_user_id = $1 order by id", [u])).rows;
// `run` is called only after the failure switch is on: a promise passed in would already be running and could reach its email insert first.
const failing = async <T>(template: string, run: () => Promise<T>) => {
  await su.query("insert into fail_templates values ($1)", [template]);
  try {
    await expect(run()).rejects.toThrow(/fake outbox failure/);
  } finally {
    await su.query("delete from fail_templates");
  }
};

/** A verified company: an owner who signs, a recruiter who signs, a viewer; and a second company that must hear nothing. */
async function company() {
  const org = Number(await F.org({ status: "verified" }));
  const [uo, ur, uv] = [await F.portal(), await F.portal(), await F.portal()];
  const owner = Number(await F.member(org, uo, { role: "account_owner", signer: true }));
  const rec = Number(await F.member(org, ur, { role: "recruiter", signer: true }));
  const viewer = Number(await F.member(org, uv, { role: "viewer" }));
  return { org, uo, ur, uv, owner, rec, viewer };
}
const fn = (sql: string, args: unknown[]) => portal.query(sql, args).then((r) => r.rows[0].r);

describe("team removal and owner transfer (0036)", () => {
  it("removing an active member tells that member only; withdrawing an invite and leaving tell nobody", async () => {
    const t = await company(), other = await company();
    await fn("select private.team_remove($1, $2) r", [t.uo, t.rec]);
    const p = { organisationId: t.org };
    expect(await notes(t.ur)).toEqual([{ t: "team_removed", category: "account", org: String(t.org), params: p }]);
    expect(await mails(t.ur)).toEqual([{ t: "team_removed", params: p, status: "pending" }]);
    for (const u of [t.uo, t.uv, other.uo, other.ur]) expect([u, await notes(u), await mails(u)]).toEqual([u, [], []]);
    const invite = Number(await F.member(t.org, null, { status: "invited", email: "fake-invite@example.test" }));
    await fn("select private.team_remove($1, $2) r", [t.uo, invite]);
    await fn("select private.team_leave($1) r", [t.uv]); // a self-leave: no removal notice
    expect(await notes(t.uv)).toEqual([]);
    expect(await mails(t.uv)).toEqual([]);
    expect((await one("select count(*)::int n from email_outbox where template = 'team_removed'")).n).toBe(1);
  });
  it("only the owner removes, only a member of the owner's own company, and a failed email undoes the removal and the notice", async () => {
    const t = await company(), other = await company();
    await expect(fn("select private.team_remove($1, $2) r", [t.ur, t.viewer])).rejects.toThrow(/NOT_OWNER/);
    await expect(fn("select private.team_remove($1, $2) r", [t.uv, t.rec])).rejects.toThrow(/NOT_OWNER/);
    await expect(fn("select private.team_remove($1, $2) r", [t.uo, other.rec])).rejects.toThrow(/MEMBER_NOT_FOUND/);
    await failing("team_removed", () => fn("select private.team_remove($1, $2) r", [t.uo, t.rec]));
    expect((await one("select status from membership where id = $1", [t.rec])).status).toBe("active");
    for (const u of [t.ur, t.uv, other.ur]) expect(await notes(u)).toEqual([]);
  });
  it("a hand-over by the owner tells the new owner; a failed email undoes it", async () => {
    const t = await company();
    await failing("owner_transferred", () => fn("select private.team_transfer($1, $2) r", [t.uo, t.rec]));
    expect((await one("select role from membership where id = $1", [t.owner])).role).toBe("account_owner");
    expect(await notes(t.ur)).toEqual([]);
    await fn("select private.team_transfer($1, $2) r", [t.uo, t.rec]);
    expect(await notes(t.ur)).toEqual([{ t: "owner_transferred", category: "account", org: String(t.org), params: { organisationId: t.org } }]);
    expect(await mails(t.ur)).toEqual([{ t: "owner_transferred", params: { organisationId: t.org }, status: "pending" }]);
    expect(await notes(t.uo)).toEqual([]); // the old owner made the change
    expect(await notes(t.uv)).toEqual([]);
  });
  it("a staff owner reassign tells the new owner and the old owner once it completes, on top of the old owner's advance email", async () => {
    const t = await company();
    const r = await requestOwnerReassign(admin, staff.account_reviewer!, String(t.rec), { domainChecked: true, croChecked: true });
    expect(await notes(t.uo)).toEqual([]);
    expect((await mails(t.uo)).map((m) => m.t)).toEqual(["owner_reassign_notice"]);
    await su.query("update owner_reassign set requested_at = requested_at - interval '8 days', completes_after = now() - interval '1 day' where id = $1", [r.requestId]);
    await failing("owner_reassign_done", () => completeOwnerReassign(admin, staff.account_reviewer!, r.requestId));
    expect(await one("select status from owner_reassign where id = $1", [r.requestId])).toEqual({ status: "open" });
    expect(await notes(t.ur)).toEqual([]);
    await completeOwnerReassign(admin, staff.account_reviewer!, r.requestId);
    const p = { organisationId: t.org, requestId: Number(r.requestId) };
    expect(await notes(t.ur)).toEqual([{ t: "owner_transferred", category: "account", org: String(t.org), params: p }]);
    expect(await notes(t.uo)).toEqual([{ t: "owner_reassign_done", category: "account", org: String(t.org), params: p }]);
    expect((await mails(t.uo)).map((m) => m.t)).toEqual(["owner_reassign_notice", "owner_reassign_done"]);
    expect((await mails(t.ur)).map((m) => m.t)).toEqual(["owner_transferred"]);
    expect(await notes(t.uv)).toEqual([]);
  });
});

describe("pay floor decisions", () => {
  async function floor(t: Awaited<ReturnType<typeof company>>, family = "2134") {
    const text = await F.text("pay_floor");
    return String((await one(
      "insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, signer_name, valid_until) values ($1, $2, 50000, $3, $4, 'Fake Signer', now() + interval '12 months') returning id",
      [t.org, family, text, t.rec])).id);
  }
  it("confirm tells the owner and the member who signed; reject adds only the reason code; another company and the viewer hear nothing", async () => {
    const t = await company(), other = await company();
    await makeBig(su, F.staff, t.org);
    const a = await floor(t);
    await proposeFloor(admin, staff.rules_data_editor!, a);
    await confirmFloor(admin, staff.administrator!, a);
    const ap = { organisationId: String(t.org), floorId: a };
    for (const u of [t.uo, t.ur]) {
      expect(await notes(u)).toEqual([{ t: "pay_floor_approved", category: "account", org: String(t.org), params: ap }]);
      expect(await mails(u)).toEqual([{ t: "pay_floor_approved", params: ap, status: "pending" }]);
    }
    const b = await floor(t, "2135");
    await rejectFloor(admin, staff.rules_data_editor!, b, "advert_shows_lower_pay");
    expect((await notes(t.uo)).at(-1)).toEqual({ t: "pay_floor_rejected", category: "account", org: String(t.org), params: { ...ap, floorId: b, reason: "advert_shows_lower_pay" } });
    expect((await mails(t.ur)).map((m) => m.t)).toEqual(["pay_floor_approved", "pay_floor_rejected"]);
    for (const u of [t.uv, other.uo, other.ur]) expect(await notes(u)).toEqual([]);
  });
  it("the owner who signed gets one notice, a signer who has left gets none, and a failed email leaves the floor pending with no notice", async () => {
    const t = await company();
    await makeBig(su, F.staff, t.org);
    const own = String((await one(
      "insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, valid_until) values ($1, '2136', 50000, $2, $3, now() + interval '12 months') returning id",
      [t.org, await F.text("pay_floor"), t.owner])).id);
    await rejectFloor(admin, staff.administrator!, own, "no_evidence");
    expect((await notes(t.uo)).map((n) => n.t)).toEqual(["pay_floor_rejected"]);
    expect(await notes(t.ur)).toEqual([]);
    const gone = await floor(t);
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [t.rec]);
    await failing("pay_floor_rejected", () => rejectFloor(admin, staff.administrator!, gone, "no_evidence"));
    expect((await one("select status from pay_floor where id = $1", [gone])).status).toBe("pending_check");
    expect((await notes(t.uo)).length).toBe(1);
    await rejectFloor(admin, staff.administrator!, gone, "no_evidence");
    expect((await notes(t.uo)).length).toBe(2);
    expect(await notes(t.ur)).toEqual([]);
  });
  it("a person without the floor roles decides nothing and nobody is told", async () => {
    const t = await company();
    await makeBig(su, F.staff, t.org);
    const a = await floor(t);
    await expect(rejectFloor(admin, staff.trust_and_safety!, a, "no_evidence")).rejects.toThrow();
    await expect(rejectFloor(admin, staff.account_reviewer!, a, "no_evidence")).rejects.toThrow();
    await expect(rejectFloor(admin, staff.administrator!, a, "A staff note with spaces")).rejects.toThrow(); // a reason code only, never free text
    expect(await notes(t.uo)).toEqual([]);
  });
});

describe("a job hidden by a report, and the outcome to the reporter", () => {
  async function job(t: Awaited<ReturnType<typeof company>>, poster: number) {
    return String((await one(
      "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, own_page_url, search_vector, posted_by_membership_id) " +
      "values ($1, 'employer', $2, 'Fake Cook', 'Fake Org', 'it', 'critical_skills', 40000, 'live', now() + interval '20 days', 'https://example.test/a', 'fake', $3) returning id", [t.org, source, poster])).id);
  }
  const EVIDENCE = "Fake evidence naming the reporter Fake Reporter";
  async function report(jobId: string, side: "candidate" | "portal") {
    const who = side === "candidate" ? await F.cand() : await F.portal();
    const col = side === "candidate" ? "reporter_candidate_user_id" : "reporter_portal_user_id";
    const id = String((await one(`insert into report(target_kind, target_job_id, ${col}, reason, evidence_text) values ('job', $1, $2, 'asks_for_money', $3) returning id`, [jobId, who, EVIDENCE])).id);
    return { id, who };
  }

  it("hiding tells the owner and the poster with ids only, never the reporter; clearing tells a candidate reporter by email only", async () => {
    const t = await company(), other = await company();
    const j = await job(t, t.rec);
    const r = await report(j, "candidate");
    await hideReportedJob(admin, staff.trust_and_safety!, r.id);
    const p = { organisationId: String(t.org), jobId: j };
    for (const u of [t.uo, t.ur]) {
      expect(await notes(u)).toEqual([{ t: "job_hidden", category: "account", org: String(t.org), params: p }]);
      expect(await mails(u)).toEqual([{ t: "job_hidden", params: p, status: "pending" }]);
    }
    for (const u of [t.uv, other.uo]) expect(await notes(u)).toEqual([]);
    expect(await candMails(r.who)).toEqual([]); // hiding tells the reporter nothing yet
    await clearReport(admin, staff.trust_and_safety!, r.id);
    expect(await candMails(r.who)).toEqual([{ t: "report_outcome", params: { reportId: r.id, outcome: "cleared" }, status: "pending" }]);
    expect((await one("select count(*)::int n from notification where candidate_user_id = $1", [r.who])).n).toBe(0); // no candidate notice reader yet (N8)
    // the reporter never reaches the company: no notice or email to any member names the reporter, the report or the evidence
    const leak = await one(
      "select count(*)::int n from (select params::text p from notification where portal_user_id = any($1) union all select params::text from email_outbox where portal_user_id = any($1)) x " +
      "where p like '%' || $2 || '%' or p like '%Fake Reporter%' or p like '%reportId%'", [[t.uo, t.ur, t.uv], r.who]);
    expect(leak.n).toBe(0);
  });
  it("upholding tells a portal reporter by notice and email, without the staff notice summary, and only the reporter", async () => {
    const t = await company(), reporterCo = await company();
    const j = await job(t, t.owner);
    const r = await report(j, "portal");
    await su.query("insert into membership(organisation_id, portal_user_id, role, status) values ($1, $2, 'recruiter', 'active')", [reporterCo.org, r.who]);
    await hideReportedJob(admin, staff.trust_and_safety!, r.id);
    expect((await notes(t.uo)).map((n) => n.t)).toEqual(["job_hidden"]); // owner and poster are one person: one notice
    await upholdReport(admin, staff.trust_and_safety!, r.id, { caseKind: "instant_ban", reasonCode: "asks_for_money", noticeSummary: "Fake staff summary text" });
    const p = { reportId: r.id, outcome: "upheld" };
    expect(await notes(r.who)).toEqual([{ t: "report_outcome", category: "account", org: null, params: p }]);
    expect(await mails(r.who)).toEqual([{ t: "report_outcome", params: p, status: "pending" }]);
    for (const u of [reporterCo.uo, reporterCo.ur, t.ur, t.uv]) expect(await notes(u)).toEqual([]);
    expect((await one("select count(*)::int n from notification where params::text like '%Fake staff summary%'")).n).toBe(0);
    expect((await one("select count(*)::int n from email_outbox where params::text like '%Fake staff summary%'")).n).toBe(0);
  });
  it("a failed email undoes the hide or the decision with its notice; another role cannot hide", async () => {
    const t = await company();
    const j = await job(t, t.rec);
    const r = await report(j, "portal");
    await expect(hideReportedJob(admin, staff.account_reviewer!, r.id)).rejects.toThrow();
    await failing("job_hidden", () => hideReportedJob(admin, staff.trust_and_safety!, r.id));
    expect(await one("select status from job where id = $1", [j])).toEqual({ status: "live" });
    expect(await notes(t.uo)).toEqual([]);
    await failing("report_outcome", () => clearReport(admin, staff.trust_and_safety!, r.id));
    expect(await one("select status, reporter_portal_user_id u from report where id = $1", [r.id])).toEqual({ status: "open", u: r.who });
    expect(await notes(r.who)).toEqual([]);
    await clearReport(admin, staff.trust_and_safety!, r.id);
    expect((await notes(r.who)).map((n) => n.t)).toEqual(["report_outcome"]);
  });
});

describe("every N5 notice goes to an active member of the company it names", () => {
  it("no stray recipient across the whole run", async () => {
    const strays = await one(
      "select count(*)::int n from notification n where n.template_key in ('team_removed','owner_transferred','owner_reassign_done','pay_floor_approved','pay_floor_rejected','job_hidden') " +
      "and not exists (select 1 from membership m where m.portal_user_id = n.portal_user_id and m.organisation_id = (n.params->>'organisationId')::bigint and m.organisation_id = n.organisation_id)");
    expect(strays.n).toBe(0);
  });
});
