// Integration: companies (step 13 part 13c) on the real test database, as app_admin and app_portal, through the functions of migration 0022 and the modules
// merges.ts, manual-posting.ts and owner-reassign.ts. Companies, members and staff are written as postgres (every CHECK, foreign key and trigger still fires).
// No network. Fake people only. The route handlers are tested in companies-routes.test.ts.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelOwnerReassign, closeManualPost, encodeIdCursor, completeOwnerReassign, createManualPost, listManualPosts, listOwnerReassigns, mergeCompanies, previewCompanies, QueueRefused,
  requestOwnerReassign,
} from "../src";
import { getCompanyPage } from "../src/public-pages";
import { MANUAL_LIST_AFTER, MANUAL_LIST_FIRST } from "../src/manual-posting";
import { MERGE_PREVIEW } from "../src/merges";
import { OWNER_LIST_FIRST } from "../src/owner-reassign";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { assertPageBudget, measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb, su: pg.Pool, admin: pg.Pool, portal: pg.Pool, candidate: pg.Pool;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number>; staff(): Promise<string> };
beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres"); admin = db.pool("app_admin"); portal = db.pool("app_portal"); candidate = db.pool("app_candidate");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
});
afterAll(() => db.drop());

const ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"];
const staff: Record<string, string> = {};
async function staffWith(role: string | null): Promise<string> {
  const id = await F.staff();
  if (role) await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, $2, true)", [id, role]);
  return id;
}
beforeAll(async () => {
  for (const r of ROLES) staff[r] = await staffWith(r);
  staff.none = await staffWith(null);
  staff.disabled = await staffWith("account_reviewer");
  await su.query("update staff_user set status = 'disabled' where id = $1", [staff.disabled]);
});
const one = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows[0];
const refused = async (p: Promise<unknown>, why: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e, `wanted ${why}`).toBeInstanceOf(QueueRefused);
  expect((e as QueueRefused).why).toBe(why);
};
let n = 0;
const org = (o: { status?: string; kind?: string; cro?: string } = {}) => F.org({ status: o.status ?? "unclaimed", kind: o.kind, cro: o.cro, wrc: o.kind === "agency" ? `EA${++n}${Date.now() % 1e6}` : null, name: `Fake Co ${++n}` });
const slugOf = async (id: number) => (await one("select slug from organisation where id = $1", [id])).slug as string;
let nameN = 0;
const name = (o: number, extra: { cro?: string | null; kind?: string } = {}) => su.query(
  "insert into organisation_name(organisation_id, name, normalised_name, kind, source, cro_number) values ($1, $2, $2, $3, 'admin', $4) returning id",
  [o, `fake name ${++nameN}-${Date.now()}`, extra.kind ?? "alias", extra.cro ?? null]).then((r) => Number(r.rows[0].id));
let jobSrc: number | undefined;
async function job(o: number, x: { poster?: number | null; status?: string; source?: string } = {}): Promise<number> {
  jobSrc ??= Number((await one("insert into job_source(kind, board) values ('test', 'test') on conflict (kind, board) do update set board = 'test' returning id")).id);
  return Number((await one(
    "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector, posted_by_membership_id) " +
    "values ($1, $2, $3, 'Fake job', 'Fake', 'it', 'critical_skills', $4, now() + interval '20 days', 'https://x.example.ie/1', 50000, to_tsvector('x'), $5) returning id",
    [o, x.source ?? "employer", jobSrc, x.status ?? "draft", x.poster ?? null])).id);
}

describe("merge (D1)", () => {
  it("an account reviewer merges: names, jobs and DETE links move, merged_into_id is set, one audit row holds the ids", async () => {
    const a = await org(), s = await org({ status: "verified" });
    const n1 = await name(a), n2 = await name(a, { kind: "legal", cro: "9100001" }), ns = await name(s);
    const j1 = await job(a), j2 = await job(a, { status: "closed" });
    await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits) values ('fake dete', $1, 2024, 5, 3)", [n1]);
    const r = await mergeCompanies(admin, staff.account_reviewer!, String(a), String(s));
    expect(r).toEqual({ absorbed: String(a), survivor: String(s), names: 2, jobs: 2 });
    expect((await one("select merged_into_id from organisation where id = $1", [a])).merged_into_id).toBe(String(s));
    expect((await su.query("select id from organisation_name where organisation_id = $1 order by id", [s])).rows.map((x) => Number(x.id))).toEqual([n1, n2, ns]);
    expect((await one("select count(*)::int c from organisation_name where organisation_id = $1", [a])).c).toBe(0);
    expect((await su.query("select organisation_id from job where id in ($1, $2)", [j1, j2])).rows.map((x) => x.organisation_id)).toEqual([String(s), String(s)]);
    // the DETE link followed its name row, and the survivor now has the permit history it brings
    expect((await one("select organisation_name_id from dete_permit_count where dete_name = 'fake dete'")).organisation_name_id).toBe(String(n1));
    const sv = await one("select permit_history from organisation where id = $1", [s]);
    expect(sv.permit_history).toBe("has_history");
    expect((await one("select permit_history from job where id = $1", [j1])).permit_history).toBe("has_history");
    const audit = await su.query("select * from audit_event where action = 'organisation.merge' and object_id = $1", [String(a)]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({ kind: "admin_action", actor_staff_user_id: staff.account_reviewer, source: "panel" });
    expect(audit.rows[0].after).toMatchObject({ merged_into_id: Number(s), name_ids: [n1, n2], job_ids: [j1, j2] });
  });
  it("a fetched-job reviewer alone can merge; every other role, no role and a disabled login are refused", async () => {
    const a = await org(), s = await org();
    for (const who of [...ROLES.filter((r) => r !== "account_reviewer" && r !== "fetched_job_reviewer"), "none"])
      await refused(mergeCompanies(admin, staff[who]!, String(a), String(s)), "not_company_staff");
    await refused(mergeCompanies(admin, staff.disabled!, String(a), String(s)), "not_active_staff");
    await refused(mergeCompanies(admin, "no-such-staff", String(a), String(s)), "not_active_staff");
    expect((await one("select merged_into_id from organisation where id = $1", [a])).merged_into_id).toBeNull();
    await mergeCompanies(admin, staff.fetched_job_reviewer!, String(a), String(s));
  });
  it("is refused for a company merged already, into itself, into a merged company, of another kind, or not mergeable", async () => {
    const a = await org(), b = await org(), c = await org();
    await mergeCompanies(admin, staff.account_reviewer!, String(a), String(b));
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(a), String(c)), "already_merged");
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(c), String(a)), "target_merged");
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(c), String(c)), "same_company");
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(c), "99999999"), "not_found");
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(c), String(await org({ kind: "agency" }))), "kind_mismatch");
    for (const status of ["rejected", "closed", "banned", "suspended"]) {
      await refused(mergeCompanies(admin, staff.account_reviewer!, String(await org({ status })), String(b)), "not_mergeable");
      await refused(mergeCompanies(admin, staff.account_reviewer!, String(c), String(await org({ status }))), "not_mergeable");
    }
    for (const bad of ["", "0", "1;drop", "-1", "1".repeat(30)]) await refused(mergeCompanies(admin, staff.account_reviewer!, bad, String(b)), "bad_input");
  });
  it("is refused while the absorbed company has an active member, also one who joined just now; the 0002 trigger still stands", async () => {
    const a = await org({ status: "verified" }), s = await org();
    await F.member(a, await F.portal(), { role: "account_owner", signer: true });
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(a), String(s)), "active_members");
    await expect(admin.query("update organisation set merged_into_id = $2 where id = $1", [a, s])).rejects.toThrow(/active members/);
    // a claim through the real function, then a merge
    const u = await F.portal(), c = await org();
    await portal.query("select private.claim_organisation($1, $2)", [u, c]);
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(c), String(s)), "active_members");
  });
  it("the absorbed company's CRO-numbered name moves (merged_into_id first), and a removed member's job keeps its row with the poster emptied and recorded", async () => {
    const a = await org({ status: "verified" }), s = await org({ status: "verified" });
    await name(a, { kind: "legal", cro: "9100002" });
    const m = await F.member(a, await F.portal(), { role: "poster" });
    const j = await job(a, { poster: m });
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [m]);
    await mergeCompanies(admin, staff.account_reviewer!, String(a), String(s));
    const row = await one("select organisation_id, posted_by_membership_id from job where id = $1", [j]);
    expect(row).toEqual({ organisation_id: String(s), posted_by_membership_id: null });
    const audit = await one("select after from audit_event where action = 'organisation.merge' and object_id = $1", [String(a)]);
    expect(audit.after.job_posted_by_membership).toEqual({ [j]: Number(m) });
  });
  it("is refused for a company with applications, and nothing moved", async () => {
    const a = await org(), s = await org();
    const j = await job(a);
    // no application can exist before Launch B (its trigger wants an on-site job, which a CHECK forbids), so the row is written with the triggers off
    const c = await su.connect();
    try { await c.query("begin"); await c.query("set local session_replication_role = replica"); await c.query("insert into application(job_id, organisation_id) values ($1, $2)", [j, a]); await c.query("commit"); } finally { c.release(); }
    await refused(mergeCompanies(admin, staff.account_reviewer!, String(a), String(s)), "has_applications");
    expect((await one("select organisation_id from job where id = $1", [j])).organisation_id).toBe(String(a));
  });
  it("a merged-away company's slug answers with the survivor's slug", async () => {
    const a = await org(), s = await org({ status: "verified" }), c = await org({ status: "verified" });
    await mergeCompanies(admin, staff.account_reviewer!, String(a), String(s));
    expect(await getCompanyPage(candidate, await slugOf(a))).toEqual({ merged: await slugOf(s) });
    await mergeCompanies(admin, staff.account_reviewer!, String(s), String(c)); // a second hop: the old slug still lands on a page that redirects on
    expect(await getCompanyPage(candidate, await slugOf(s))).toEqual({ merged: await slugOf(c) });
  });
  it("a merged-away company can no longer be claimed or registered (the open bug), the survivor still can", async () => {
    const a = await org({ cro: "9100003" }), s = await org();
    await mergeCompanies(admin, staff.account_reviewer!, String(a), String(s));
    const u = await F.portal();
    await expect(portal.query("select private.claim_organisation($1, $2)", [u, a])).rejects.toThrow(/claim refused: MERGED/);
    await expect(portal.query("select private.register_organisation($1, 'employer', 'Fake Again Ltd', '9100003', null)", [u])).rejects.toThrow(/sign-up refused: MERGED/);
    const ag = await org({ kind: "agency" });
    const wrc = (await one("select wrc_licence_number w from organisation where id = $1", [ag])).w as string;
    await mergeCompanies(admin, staff.account_reviewer!, String(ag), String(await org({ kind: "agency" })));
    await expect(portal.query("select private.register_organisation($1, 'agency', 'Fake Agency Ltd', null, $2)", [u, wrc])).rejects.toThrow(/sign-up refused: MERGED/);
    // nothing was created by the refused calls, and the other claims and sign-ups still work
    expect((await one("select count(*)::int c from membership where portal_user_id = $1", [u])).c).toBe(0);
    expect((await portal.query("select private.claim_organisation($1, $2) r", [u, s])).rows[0].r.membership_id).toBeTruthy();
    const u2 = await F.portal();
    expect((await portal.query("select private.register_organisation($1, 'employer', 'Fake Fresh Ltd', '9100004', null) r", [u2])).rows[0].r.status).toBe("pending_review");
  });
  it("the preview shows names, kind, status and counts to the five viewing roles only", async () => {
    const a = await org({ status: "verified" }), s = await org();
    await job(a); await name(a);
    const seen = await previewCompanies(admin, staff.rules_data_editor!, [String(a), String(s)]);
    expect(seen.map((x) => [x.id, x.jobs, x.names, x.active_members])).toEqual([[String(a), 1, 1, 0], [String(s), 0, 0, 0]]);
    for (const r of ["account_reviewer", "fetched_job_reviewer", "trust_and_safety", "administrator"]) expect(await previewCompanies(admin, staff[r]!, [String(a)])).toHaveLength(1);
    for (const r of ["services_case_handler", "content_editor", "none"]) await refused(previewCompanies(admin, staff[r]!, [String(a)]), "not_company_viewer");
    await refused(previewCompanies(admin, staff.account_reviewer!, ["1", "2", "3"]), "bad_input");
  });
});

// ===== manual posting
const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const post = (o: number, x: object = {}) => ({
  organisationId: String(o), title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractMonths: null, salaryLow: 50000, salaryHigh: 60000,
  weeklyHours: 39, closesOn: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10), applyUrl: "https://careers.example.ie/jobs/1", ...x,
});
describe("manual posting (#232)", () => {
  it("a post that passes is live as Critical Skills eligible, recorded with the staff id and never Sponsor confirmed", async () => {
    const o = await org({ status: "verified" });
    const r = await createManualPost(admin, staff.account_reviewer!, post(o));
    expect(r).toMatchObject({ status: "live", passRoute: "stated_pay", reason: null });
    const j = await one("select * from job where id = $1", [r.jobId]);
    expect(j).toMatchObject({
      source: "admin_manual", status: "live", badge: "critical_skills_eligible", pass_route: "stated_pay", permit_type: "critical_skills", organisation_id: String(o), posted_by_staff_id: staff.account_reviewer,
      posted_by_membership_id: null, employer_name: (await one("select display_name from organisation where id = $1", [o])).display_name, weekly_hours: 39, contract_type: "permanent",
      salary_low: 50000, salary_high: 60000, county: "Dublin", occupation_code: "2136", own_page_url: "https://careers.example.ie/jobs/1",
    });
    expect(j.search_vector).toContain("payment");
    expect((await one("select advert_text from job_text where job_id = $1", [r.jobId])).advert_text).toBe(desc);
    expect((await one("select closes_at > now() + interval '19 days' and closes_at < now() + interval '21 days' ok from job where id = $1", [r.jobId])).ok).toBe(true);
    const audit = await one("select * from audit_event where action = 'job.manual_post' and object_id = $1", [r.jobId]);
    expect(audit).toMatchObject({ actor_staff_user_id: staff.account_reviewer, kind: "admin_action", reason_code: null });
    // the public side can read it as a live job
    expect((await candidate.query("select id from job where id = $1 and status = 'live' and closes_at > now()", [r.jobId])).rowCount).toBe(1);
    expect((await one("select count(*)::int c from sponsorship_statement where job_id = $1", [r.jobId])).c).toBe(0);
  });
  it("works for an agency and an unclaimed company, with a fixed term of 24 months or more and hours over 39", async () => {
    for (const o of [await org({ kind: "agency", status: "verified" }), await org({ status: "unclaimed" }), await org({ status: "pending_review" })])
      expect((await createManualPost(admin, staff.account_reviewer!, post(o, { contractMonths: 24, salaryLow: 40904, salaryHigh: null }))).status).toBe("live");
    const o = await org({ status: "verified" });
    expect((await createManualPost(admin, staff.account_reviewer!, post(o, { salaryLow: 41954, salaryHigh: null, weeklyHours: 40 }))).status).toBe("live");
    expect((await createManualPost(admin, staff.account_reviewer!, post(o, { salaryLow: 41953, salaryHigh: null, weeklyHours: 40 }))).reason?.code).toBe("pay_below_minimum");
  });
  it("a post that fails the checks stays a draft with the reason, and is not visible to candidates", async () => {
    const o = await org({ status: "verified" });
    const cases: [object, string][] = [
      [{ salaryLow: 40000, salaryHigh: null }, "pay_below_minimum"], [{ occupationCode: "4112" }, "occupation_ineligible"], [{ occupationCode: "3545" }, "pay_below_minimum"], // off the list and not Ineligible: the non-list minimum (#225, #150)
      [{ contractMonths: 12 }, "contract_too_short"], [{ description: desc + " We cannot offer visa sponsorship." }, "rules_failed"], [{ salaryLow: null, salaryHigh: null, payGrade: "Grade VI" }, "pay_required"],
      [{ description: desc + " Candidates must pay a registration fee before the interview." }, "needs_review"], // scam wording: not listed, and a staff post has no review queue
    ];
    for (const [x, code] of cases) {
      const r = await createManualPost(admin, staff.account_reviewer!, post(o, x));
      expect([r.status, r.reason?.code, r.passRoute], JSON.stringify(x)).toEqual(["draft", code, null]);
      const j = await one("select status, badge, pass_route, source, posted_by_staff_id from job where id = $1", [r.jobId]);
      expect(j).toEqual({ status: "draft", badge: null, pass_route: null, source: "admin_manual", posted_by_staff_id: staff.account_reviewer });
      expect((await one("select reason_code from audit_event where action = 'job.manual_post' and object_id = $1", [r.jobId])).reason_code).toBe(code);
      expect((await candidate.query("select id from job where id = $1 and status = 'live'", [r.jobId])).rowCount).toBe(0);
    }
  });
  it("refuses a four-digit code that is not SOC 2010, with nothing written", async () => {
    const o = await org({ status: "verified" });
    const before = (await one("select count(*)::int c from job where source = 'admin_manual'")).c;
    for (const occupationCode of ["9999", "0000", "1110"]) await refused(createManualPost(admin, staff.account_reviewer!, post(o, { occupationCode })), "bad_occupation_code");
    expect((await one("select count(*)::int c from job where source = 'admin_manual'")).c).toBe(before);
  });
  it("every other role, no role and a disabled login are refused, and nothing is written", async () => {
    const o = await org({ status: "verified" });
    const before = (await one("select count(*)::int c from job where source = 'admin_manual'")).c;
    for (const who of [...ROLES.filter((r) => r !== "account_reviewer"), "none"]) await refused(createManualPost(admin, staff[who]!, post(o)), "not_account_reviewer");
    await refused(createManualPost(admin, staff.disabled!, post(o)), "not_active_staff");
    expect((await one("select count(*)::int c from job where source = 'admin_manual'")).c).toBe(before);
  });
  it("refuses an unknown company, a public body, a merged, rejected, closed, banned or suspended company, and a bad closing date", async () => {
    const mk = (x: object) => createManualPost(admin, staff.account_reviewer!, x);
    await refused(mk(post(99999999)), "company_not_found");
    await refused(mk(post(await org({ kind: "public_body" }))), "company_not_postable");
    for (const status of ["rejected", "closed", "banned", "suspended"]) await refused(mk(post(await org({ status }))), "company_not_postable");
    const a = await org(), s = await org();
    await mergeCompanies(admin, staff.account_reviewer!, String(a), String(s));
    await refused(mk(post(a)), "company_not_postable");
    const o = await org({ status: "verified" });
    const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
    for (const closesOn of [day(-2), day(-30), day(100)]) await refused(mk(post(o, { closesOn })), "bad_closing_date");
    expect((await mk(post(o, { closesOn: day(80) }))).status).toBe("live");
  });
  it("hostile input is refused field by field: unknown fields (a badge among them), control and format characters, bad URLs, types and ranges", async () => {
    const o = await org({ status: "verified" });
    const mk = (x: unknown) => createManualPost(admin, staff.account_reviewer!, x);
    await refused(mk({ ...post(o), badge: "sponsor_confirmed" }), "bad_body");
    await refused(mk({ ...post(o), status: "live" }), "bad_body");
    await refused(mk({ ...post(o), postedByStaffId: staff.administrator }), "bad_body");
    await refused(mk([]), "bad_body");
    await refused(mk(null), "bad_body");
    const cases: [object, string][] = [
      [{ organisationId: "1; drop table job" }, "bad_organisation_id"], [{ title: "Eng‮ineer" }, "bad_title"], [{ title: "x" }, "bad_title"], [{ title: "Eng​ineer" }, "bad_title"],
      [{ description: "short" }, "bad_description"], [{ description: desc + "\u0000" }, "bad_description"], [{ description: desc + "‮" }, "bad_description"],
      [{ county: "Atlantis" }, "bad_county"], [{ occupationCode: "21360" }, "bad_occupation_code"], [{ occupationCode: "0123" }, "bad_occupation_code"], [{ contractMonths: 0 }, "bad_contract_months"],
      [{ contractMonths: "24" }, "bad_contract_months"], [{ salaryLow: -5 }, "bad_salary"], [{ salaryLow: 1.5 }, "bad_salary"], [{ salaryLow: 2_000_000 }, "bad_salary"], [{ salaryLow: 60000, salaryHigh: 50000 }, "bad_salary"],
      [{ salaryLow: null, salaryHigh: 60000 }, "bad_salary"], [{ salaryLow: null, salaryHigh: null }, "bad_salary"], [{ weeklyHours: 0 }, "bad_weekly_hours"], [{ weeklyHours: 61 }, "bad_weekly_hours"],
      [{ weeklyHours: undefined }, "bad_weekly_hours"], [{ closesOn: "2026-02-31" }, "bad_closes_on"], [{ closesOn: "tomorrow" }, "bad_closes_on"],
      [{ applyUrl: "http://careers.example.ie/1" }, "bad_apply_url"], [{ applyUrl: "javascript:alert(1)//aaaa" }, "bad_apply_url"], [{ applyUrl: "https://user:pw@careers.example.ie/1" }, "bad_apply_url"],
      [{ payGrade: "Grade\nVI" }, "bad_pay_grade"], [{ healthInsuranceEur: -1 }, "bad_health_insurance"],
    ];
    for (const [x, code] of cases) await refused(mk({ ...post(o), ...x }), code);
    // line breaks and tabs are fine in the description, and SQL in text is only text
    expect((await mk({ ...post(o), description: desc + "\n\n\tLine two. '); drop table job; --" })).status).toBe("live");
  });
  it("the poster check of job_guard still refuses a portal post without a valid member, and lets the staff post through", async () => {
    const o = await org({ status: "verified" });
    const u = await F.portal();
    const viewer = await F.member(o, u, { role: "viewer" });
    const src = Number((await one("select id from job_source where kind = 'portal' and board = 'employer'")).id);
    const sql = "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, posted_by_membership_id) values ($1, 'employer', $2, 't', 'e', 'it', 'critical_skills', 'draft', now() + interval '5 days', 'https://x.example.ie/1', $3)";
    await expect(portal.query(sql, [o, src, viewer])).rejects.toThrow(/job guard: the portal writes a job only for/);
    await expect(portal.query(sql, [o, src, null])).rejects.toThrow(/job guard: the portal writes a job only for/);
    expect((await createManualPost(admin, staff.account_reviewer!, post(o))).status).toBe("live");
    // and a portal login cannot write the staff column or an admin_manual job at all
    await expect(portal.query("update job set posted_by_staff_id = $2 where organisation_id = $1", [o, staff.account_reviewer])).rejects.toThrow(/permission denied/);
    await expect(portal.query("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url) values ($1, 'admin_manual', $2, 't', 'e', 'it', 'critical_skills', 'draft', now() + interval '5 days', 'https://x.example.ie/1')", [o, src])).rejects.toThrow();
  });
  it("staff close their own posts only; another staff member's post, an employer's job and a closed post are refused", async () => {
    const o = await org({ status: "verified" });
    const mine = (await createManualPost(admin, staff.account_reviewer!, post(o))).jobId;
    const other = await staffWith("account_reviewer");
    await refused(closeManualPost(admin, other, mine), "not_poster");
    for (const who of ["administrator", "trust_and_safety", "content_editor", "none"]) await refused(closeManualPost(admin, staff[who]!, mine), "not_account_reviewer");
    await refused(closeManualPost(admin, staff.disabled!, mine), "not_active_staff");
    await refused(closeManualPost(admin, staff.account_reviewer!, String(await job(o))), "not_found"); // an employer job
    await refused(closeManualPost(admin, staff.account_reviewer!, "424242"), "not_found");
    await refused(closeManualPost(admin, staff.account_reviewer!, "x"), "bad_input");
    expect((await one("select status from job where id = $1", [mine])).status).toBe("live");
    await closeManualPost(admin, staff.account_reviewer!, mine);
    expect(await one("select status, close_reason, closed_at is not null c from job where id = $1", [mine])).toEqual({ status: "closed", close_reason: "closed", c: true });
    expect((await one("select count(*)::int c from audit_event where action = 'job.manual_close' and object_id = $1", [mine])).c).toBe(1);
    await refused(closeManualPost(admin, staff.account_reviewer!, mine), "bad_state");
    // a draft can be closed too
    const d = (await createManualPost(admin, staff.account_reviewer!, post(o, { salaryLow: 100, salaryHigh: null }))).jobId;
    await closeManualPost(admin, staff.account_reviewer!, d);
  });
  it("the list is for the three matrix roles, newest first, with the reason of a draft, and pages by id", async () => {
    const o = await org({ status: "verified" });
    for (let i = 0; i < 22; i++) await createManualPost(admin, staff.account_reviewer!, post(o, i === 21 ? { salaryLow: 100, salaryHigh: null } : {}));
    for (const r of ["account_reviewer", "trust_and_safety", "administrator"]) expect((await listManualPosts(admin, staff[r]!)).items.length).toBeGreaterThan(0);
    for (const r of ["fetched_job_reviewer", "rules_data_editor", "services_case_handler", "content_editor", "none"]) await refused(listManualPosts(admin, staff[r]!), "not_manual_viewer");
    await refused(listManualPosts(admin, staff.disabled!), "not_active_staff");
    const first = await listManualPosts(admin, staff.administrator!);
    expect(first.items).toHaveLength(20);
    expect(first.items[0]).toMatchObject({ status: "draft", reason: "pay_below_minimum", posted_by_staff_id: staff.account_reviewer });
    expect(first.next).toBe(encodeIdCursor("manual_jobs", first.items[19]!.id)); // the opaque { i } token, not the plain id
    const second = await listManualPosts(admin, staff.administrator!, { after: first.next! });
    expect(Number(second.items[0]!.id)).toBeLessThan(Number(first.items[19]!.id));
    expect(second.items.map((x) => x.id)).not.toContain(first.items[19]!.id);
    // hostile tokens: the plain id the old form took, a forged junk token, a changed id, another list's { t, i } token
    for (const bad of [first.items[19]!.id, "abc", encodeIdCursor("manual_jobs", "0"), encodeIdCursor("manual_jobs", "007"), encodeIdCursor("cases", first.items[19]!.id), Buffer.from(JSON.stringify({ t: "2026-11-18 09:30:00+00", i: "5" })).toString("base64url")])
      await refused(listManualPosts(admin, staff.administrator!, { after: bad }), "bad_cursor");
  });
});

// ===== an owner who cannot be reached
async function team() {
  const o = await org({ status: "verified" });
  const [uo, un, uv] = [await F.portal(), await F.portal(), await F.portal()];
  const owner = Number(await F.member(o, uo, { role: "account_owner", signer: true }));
  const next = Number(await F.member(o, un, { role: "recruiter", signer: false }));
  const viewer = Number(await F.member(o, uv, { role: "viewer" }));
  return { o, uo, un, owner, next, viewer };
}
const askReassign = (who: string, m: number, c = { domainChecked: true, croChecked: true }) => requestOwnerReassign(admin, staff[who]!, String(m), c);
/** The clock: moves the request's two times back, so its 7 days end `minutes` from now (negative: ended that long ago). */
const setWaitEnds = (id: string, minutes: number) => su.query(
  "update owner_reassign set requested_at = requested_at - (completes_after - now() - make_interval(mins => $2::int)), completes_after = now() + make_interval(mins => $2::int) where id = $1", [id, minutes]);
describe("an owner who cannot be reached (D6)", () => {
  it("records the request, queues one notice to the old owner and writes one audit row", async () => {
    const t = await team();
    const r = await askReassign("account_reviewer", t.next);
    const row = await one("select * from owner_reassign where id = $1", [r.requestId]);
    expect(row).toMatchObject({
      organisation_id: String(t.o), new_owner_membership_id: String(t.next), old_owner_membership_id: String(t.owner), domain_checked: true, cro_checked: true,
      requested_by_staff_user_id: staff.account_reviewer, status: "open", decided_at: null,
    });
    expect((await one("select completes_after - requested_at = interval '7 days' ok from owner_reassign where id = $1", [r.requestId])).ok).toBe(true);
    const mail = await su.query("select template, portal_user_id, params, status from email_outbox where dedupe_key = $1", ["owner_reassign:" + r.requestId]);
    expect(mail.rows).toEqual([{ template: "owner_reassign_notice", portal_user_id: t.uo, params: { organisationId: Number(t.o), requestId: Number(r.requestId), completesAfter: expect.any(String) }, status: "pending" }]);
    expect((await one("select count(*)::int c from audit_event where action = 'owner_reassign.request' and object_id = $1", [String(t.o)])).c).toBe(1);
    // nobody changed yet
    expect((await one("select role from membership where id = $1", [t.owner])).role).toBe("account_owner");
  });
  it("needs the two ticks, an account reviewer, a different member, a live company and one open request at a time", async () => {
    const t = await team();
    for (const c of [{ domainChecked: false, croChecked: true }, { domainChecked: true, croChecked: false }, { domainChecked: false, croChecked: false }])
      await refused(askReassign("account_reviewer", t.next, c), "not_checked");
    for (const who of [...ROLES.filter((r) => r !== "account_reviewer"), "none"]) await refused(askReassign(who, t.next), "not_account_reviewer");
    await refused(askReassign("disabled", t.next), "not_active_staff");
    await refused(askReassign("account_reviewer", t.owner), "already_owner");
    await refused(askReassign("account_reviewer", 99999999), "member_not_found");
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [t.viewer]);
    await refused(askReassign("account_reviewer", t.viewer), "member_not_found");
    expect((await one("select count(*)::int c from owner_reassign where organisation_id = $1", [t.o])).c).toBe(0);
    await askReassign("account_reviewer", t.next);
    await refused(askReassign("account_reviewer", t.next), "request_open");
    const t2 = await team();
    await su.query("update organisation set status = 'suspended' where id = $1", [t2.o]);
    await refused(askReassign("account_reviewer", t2.next), "company_not_open");
    const t3 = await team();
    await su.query("update portal_user set status = 'blocked' where id = $1", [t3.un]);
    await refused(askReassign("account_reviewer", t3.next), "user_not_active");
    await expect(requestOwnerReassign(admin, staff.account_reviewer!, "x", { domainChecked: true, croChecked: true })).rejects.toBeInstanceOf(QueueRefused);
  });
  it("the 7-day wait is enforced with a fixed clock: refused until the day, then the old owner is a recruiter with the signer switch kept", async () => {
    const t = await team();
    const r = await askReassign("account_reviewer", t.next);
    await refused(completeOwnerReassign(admin, staff.account_reviewer!, r.requestId), "too_early");
    await setWaitEnds(r.requestId, 1); // one minute to go
    await refused(completeOwnerReassign(admin, staff.account_reviewer!, r.requestId), "too_early");
    await setWaitEnds(r.requestId, -1); // ended one minute ago
    for (const who of [...ROLES.filter((x) => x !== "account_reviewer"), "none"]) await refused(completeOwnerReassign(admin, staff[who]!, r.requestId), "not_account_reviewer");
    await refused(completeOwnerReassign(admin, staff.disabled!, r.requestId), "not_active_staff");
    const other = await staffWith("account_reviewer"); // any account reviewer completes it, not only the one who asked
    expect(await completeOwnerReassign(admin, other, r.requestId)).toEqual({ requestId: r.requestId, organisationId: String(t.o), ownerMembershipId: String(t.next) });
    expect((await su.query("select id, role, is_signer, status from membership where organisation_id = $1 order by id", [t.o])).rows).toEqual([
      { id: String(t.owner), role: "recruiter", is_signer: true, status: "active" }, { id: String(t.next), role: "account_owner", is_signer: false, status: "active" },
      { id: String(t.viewer), role: "viewer", is_signer: false, status: "active" }]);
    expect(await one("select status, decided_by_staff_user_id d from owner_reassign where id = $1", [r.requestId])).toEqual({ status: "done", d: other });
    await refused(completeOwnerReassign(admin, other, r.requestId), "not_open");
    await refused(cancelOwnerReassign(admin, other, r.requestId), "not_open");
    expect((await one("select count(*)::int c from audit_event where action = 'owner_reassign.complete' and object_id = $1", [String(t.o)])).c).toBe(1);
    // a new request is possible again
    await askReassign("account_reviewer", t.owner);
  });
  it("any account reviewer cancels within the 7 days, nobody else does, and a cancelled request cannot be completed", async () => {
    const t = await team();
    const r = await askReassign("account_reviewer", t.next);
    for (const who of [...ROLES.filter((x) => x !== "account_reviewer"), "none"]) await refused(cancelOwnerReassign(admin, staff[who]!, r.requestId), "not_account_reviewer");
    await refused(cancelOwnerReassign(admin, staff.disabled!, r.requestId), "not_active_staff");
    await refused(cancelOwnerReassign(admin, staff.account_reviewer!, "424242"), "not_found");
    const other = await staffWith("account_reviewer");
    await cancelOwnerReassign(admin, other, r.requestId);
    await setWaitEnds(r.requestId, -5);
    await refused(completeOwnerReassign(admin, staff.account_reviewer!, r.requestId), "not_open");
    expect((await one("select role from membership where id = $1", [t.owner])).role).toBe("account_owner");
    expect((await one("select count(*)::int c from audit_event where action = 'owner_reassign.cancel' and object_id = $1", [String(t.o)])).c).toBe(1);
    await askReassign("account_reviewer", t.next); // the cancel freed the company's one open slot
  });
  it("completion is refused when the situation changed: owner changed, member gone, login blocked, company stopped", async () => {
    const run = async (change: (t: Awaited<ReturnType<typeof team>>) => Promise<unknown>, why: string) => {
      const t = await team();
      const r = await askReassign("account_reviewer", t.next);
      await setWaitEnds(r.requestId, -1);
      await change(t);
      await refused(completeOwnerReassign(admin, staff.account_reviewer!, r.requestId), why);
      expect((await one("select status from owner_reassign where id = $1", [r.requestId])).status).toBe("open");
    };
    await run((t) => su.query("update membership set role = 'recruiter' where id = $1", [t.owner]).then(() => su.query("update membership set role = 'account_owner' where id = $1", [t.viewer])), "owner_changed");
    await run((t) => su.query("update membership set status = 'removed', removed_at = now() where id = $1", [t.next]), "member_gone");
    await run((t) => su.query("update portal_user set status = 'blocked' where id = $1", [t.un]), "user_not_active");
    await run((t) => su.query("update organisation set status = 'closed' where id = $1", [t.o]), "company_not_open");
  });
  it("another company's members are never touched, and a request names only its own company's members", async () => {
    const a = await team(), b = await team();
    const r = await askReassign("account_reviewer", a.next);
    await setWaitEnds(r.requestId, -1);
    await completeOwnerReassign(admin, staff.account_reviewer!, r.requestId);
    expect((await su.query("select role from membership where organisation_id = $1 order by id", [b.o])).rows.map((x) => x.role)).toEqual(["account_owner", "recruiter", "viewer"]);
    // the table has no way to name a member of another company: the request row always carries the member's own company
    const row = await one("select organisation_id, (select organisation_id from membership where id = new_owner_membership_id) nm, (select organisation_id from membership where id = old_owner_membership_id) om from owner_reassign where id = $1", [r.requestId]);
    expect([row.nm, row.om]).toEqual([row.organisation_id, row.organisation_id]);
  });
  it("only the three functions write the table and the memberships: app_admin and app_portal have no direct write", async () => {
    const t = await team();
    await expect(admin.query("insert into owner_reassign(organisation_id, new_owner_membership_id, old_owner_membership_id, domain_checked, cro_checked, requested_by_staff_user_id, completes_after) values ($1, $2, $3, true, true, $4, now() + interval '7 days')", [t.o, t.next, t.owner, staff.account_reviewer])).rejects.toThrow(/permission denied/);
    await expect(admin.query("update owner_reassign set status = 'done'")).rejects.toThrow(/permission denied/);
    await expect(portal.query("select * from owner_reassign")).rejects.toThrow(/permission denied/);
    await expect(candidate.query("select * from owner_reassign")).rejects.toThrow(/permission denied/);
    await expect(portal.query("select private.owner_reassign_request($1, $2, true, true)", [staff.account_reviewer, t.next])).rejects.toThrow(/permission denied/);
    await expect(portal.query("select private.merge_organisations($1, 1, 2)", [staff.account_reviewer])).rejects.toThrow(/permission denied/);
    // the table's own rules
    const ins = (down: string, nu: string) => su.query(
      `insert into owner_reassign(organisation_id, new_owner_membership_id, old_owner_membership_id, domain_checked, cro_checked, requested_by_staff_user_id, completes_after) values ($1, $2, $3, ${down}, $4, now() + interval '${nu}')`,
      [t.o, t.next, t.owner, staff.account_reviewer]);
    await expect(ins("false, true", "7 days")).rejects.toThrow(/violates check constraint/);
    await expect(ins("true, true", "6 days")).rejects.toThrow(/violates check constraint/);
    await expect(su.query("insert into owner_reassign(organisation_id, new_owner_membership_id, old_owner_membership_id, domain_checked, cro_checked, requested_by_staff_user_id, completes_after) values ($1, $2, $2, true, true, $3, now() + interval '7 days')", [t.o, t.next, staff.account_reviewer])).rejects.toThrow(/violates check constraint/);
  });
  it("the list shows open requests to account reviewers only, with the date the wait ends", async () => {
    const t = await team();
    const r = await askReassign("account_reviewer", t.next);
    const l = await listOwnerReassigns(admin, staff.account_reviewer!);
    const mine = l.items.find((x) => x.id === r.requestId)!;
    expect(mine).toMatchObject({ organisation_id: String(t.o), can_complete: false, requested_by_staff_user_id: staff.account_reviewer });
    await setWaitEnds(r.requestId, -1);
    expect((await listOwnerReassigns(admin, staff.account_reviewer!)).items.find((x) => x.id === r.requestId)!.can_complete).toBe(true);
    for (const who of [...ROLES.filter((x) => x !== "account_reviewer"), "none"]) await refused(listOwnerReassigns(admin, staff[who]!), "not_account_reviewer");
    await refused(listOwnerReassigns(admin, staff.disabled!), "not_active_staff");
    await cancelOwnerReassign(admin, staff.account_reviewer!, r.requestId);
    expect((await listOwnerReassigns(admin, staff.account_reviewer!)).items.find((x) => x.id === r.requestId)).toBeUndefined();
  });
});

// ===== performance: pages read by each new query, and the time of the merge
describe("performance", () => {
  it("the new list and preview queries stay inside a page budget, and a merge of a large company stays inside a time budget", async () => {
    // a job table with thousands of other rows, so a list that walked the table would show; and a company with 150 names and 400 jobs to merge
    const o = await org({ status: "verified" });
    const src = Number((await one("select id from job_source limit 1")).id);
    await su.query(
      "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector) " +
      "select $1, 'employer', $2, 'Filler ' || g, 'Filler', 'it', 'critical_skills', 'closed', now() + interval '20 days', 'https://x.example.ie/1', 50000, to_tsvector('x') from generate_series(1, 4000) g", [o, src]);
    for (let i = 0; i < 25; i++) await createManualPost(admin, staff.account_reviewer!, post(o));
    const t = await team();
    await askReassign("account_reviewer", t.next);
    const client = await admin.connect();
    try {
      const costs = await measurePages(client, [MANUAL_LIST_FIRST, { text: MANUAL_LIST_AFTER, values: ["999999999"] }, OWNER_LIST_FIRST, { text: MERGE_PREVIEW, values: [[String(o), String(t.o)]] }]);
      // Measured 13 November 2026 with 4,025 jobs in one company and 25 manual posts: 52, 52, 15 and 182 pages (about 3 times each for the limits).
      // The manual list reads the partial index job_manual_idx, not the job table; the preview counts one company's jobs by job_organisation_idx, so it grows with that company.
      const [list, after, owners, preview] = costs as [typeof costs[0], typeof costs[0], typeof costs[0], typeof costs[0]];
      assertPageBudget("manual list, first page", [list], 150);
      assertPageBudget("manual list, a later page", [after], 150);
      assertPageBudget("owner requests, first page", [owners], 60);
      assertPageBudget("merge preview of a company with 4,025 jobs", [preview], 450);
      expect(costs[0]!.scans).toContain("job_manual_idx");
    } finally {
      client.release();
    }
    const big = await org({ status: "verified" }), s = await org({ status: "verified" });
    await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) select $1, 'bulk ' || g || $2, 'bulk ' || g || $2, 'alias', 'admin' from generate_series(1, 150) g", [big, String(Date.now())]);
    await su.query(
      "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector) " +
      "select $1, 'employer', $2, 'Big ' || g, 'Big', 'it', 'critical_skills', 'closed', now() + interval '20 days', 'https://x.example.ie/1', 50000, to_tsvector('x') from generate_series(1, 400) g", [big, src]);
    const t0 = performance.now();
    const r = await mergeCompanies(admin, staff.account_reviewer!, String(big), String(s));
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ names: 150, jobs: 400 });
    // measured 33 ms on 13 November 2026; the limit leaves room for a busy laptop
    expect(ms, "merge of 150 names and 400 jobs").toBeLessThan(400);
    // one app statement for the whole merge: the work is inside the function
    const [x, y] = [String(await org()), String(await org())];
    const q = pg.Client.prototype.query; let calls = 0;
    pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { calls++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
    try { await mergeCompanies(admin, staff.account_reviewer!, x, y); } finally { pg.Client.prototype.query = q; }
    expect(calls).toBe(1);
  });
});
