// Tests for 22 database rules that the mutation run (A7, 10 November 2026) found nobody would miss: 2 triggers, 4 unique rules,
// 10 CHECK rules that carry a rule of the business and 6 limits. Each test builds a row that is valid in every other way, changes
// the one thing, and (for a CHECK or unique rule) asserts the rule's own name in the error. Made-up data only.
// Where a trigger refuses first and no real role can reach the CHECK, the test is named "CHECK alone, triggers off": it runs as
// postgres with session_replication_role = replica (triggers and foreign key checks off on this image, CHECK rules still on).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, rule, tx, type Role, type TestDb } from "./db";
import { fixtures } from "./fixtures";

let db: TestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;
beforeAll(async () => { db = await createTestDb(); F = fixtures(db).F; });
afterAll(() => db.drop());

const uid = (p: string) => `${p}_${randomBytes(5).toString("hex")}`;
let roleFamilies = 0; // a pay floor family is a four-digit code (0023)
const su = (sql: string, args?: unknown[]) => db.query("postgres", sql, args);
const days = (n: number) => new Date(Date.now() + 864e5 * n);
type Q = (sql: string, args?: unknown[]) => Promise<pg.QueryResult>;
const json = (v: unknown) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
// Insert one row through a query function and return its id.
const put = async (q: Q, table: string, row: Record<string, unknown>) => {
  const k = Object.keys(row);
  const r = await q(`insert into ${table}(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")}) returning id`, k.map((x) => json(row[x])));
  return r.rows[0].id as string;
};
const insert = (role: Role, table: string, row: Record<string, unknown>) => put((s, a) => db.query(role, s, a), table, row);
// One transaction as postgres with triggers and foreign key checks off. CHECK rules and unique rules still fire.
const alone = <T>(fn: (q: Q) => Promise<T>) =>
  tx(db.pool("postgres"), async (c) => { await c.query("set local session_replication_role = replica"); return fn((s, a) => c.query(s, a)); });
const asRole = <T>(role: Role, staff: string, fn: (q: Q) => Promise<T>) =>
  tx(db.pool(role), async (c) => { await c.query("select set_config('app.staff_user_id', $1, true)", [staff]); return fn((s, a) => c.query(s, a)); });

// ---- shared fixtures
const sv = "'fake':1";
let source: string;
beforeAll(async () => { source = await insert("postgres", "job_source", { kind: "portal", board: "portal" }); });
const jobRow = (org: string, o: Record<string, unknown> = {}) => ({
  organisation_id: org, source: "employer", job_source_id: source, title: "Fake job", employer_name: "Fake Org", sector: "it",
  permit_type: "critical_skills", status: "draft", closes_at: days(29), own_page_url: "https://example.test/apply", ...o,
});
const liveRow = (org: string, o: Record<string, unknown> = {}) => jobRow(org, { status: "live", salary_low: 40000, search_vector: sv, ...o });
const candidate = () => F.cand() as Promise<string>;

async function staffWith(...roles: string[]) {
  const i = uid("s");
  await su("insert into staff_user(id,name,email,email_verified,status) values($1,'Staff',$2,true,'active')", [i, `${i}@example.test`]);
  for (const r of roles) await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [i, r]);
  return i;
}
let A: string, B: string, T: string;
beforeAll(async () => { A = await staffWith("administrator"); B = await staffWith("administrator"); T = await staffWith("trust_and_safety"); });

// =====================================================================================================================
// Triggers

test("[ban] entering a ban closes every open job of the organisation as removed", async () => {
  const cro = String(700000 + Math.floor(Math.random() * 99999));
  const org = await F.org({ cro });
  const other = await F.org();
  const liveJob = await insert("postgres", "job", liveRow(org));
  const draftJob = await insert("postgres", "job", jobRow(org));
  const doneJob = await insert("postgres", "job", jobRow(org, { status: "closed", closed_at: new Date(), close_reason: "expired" }));
  const otherJob = await insert("postgres", "job", liveRow(other));
  // a strike decided at level 3 and its ban share one approval request, applied in one transaction
  const strike = (await asRole("app_admin", A, (q) => q("insert into strike(organisation_id,case_kind,reason_code,stage,appeal_due_at) values($1,'false_claim','false_sponsorship','decided',now()+interval '6 days') returning id", [org]))).rows[0].id as string;
  const request = (await asRole("app_admin", A, (q) => q("insert into approval_request(kind,target_table,target_id) values('strike_3','strike',$1) returning id", [strike]))).rows[0].id as string;
  await asRole("app_admin", T, (q) => q("update approval_request set status='confirmed' where id=$1", [request]));
  const status = async (id: string) => (await su("select status, close_reason from job where id=$1", [id])).rows[0];
  expect(await status(liveJob)).toMatchObject({ status: "live" });
  await asRole("app_admin", A, async (q) => {
    await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [strike, request]);
    await q("insert into ban(cro_number, reason_code, strike_id, approval_request_id) values ($1,'strike_3',$2,$3)", [cro, strike, request]);
  });
  expect(await status(liveJob)).toEqual({ status: "closed", close_reason: "removed" });
  expect(await status(draftJob)).toEqual({ status: "closed", close_reason: "removed" });
  expect(await status(doneJob)).toEqual({ status: "closed", close_reason: "expired" }); // already closed: left as it was
  expect(await status(otherJob)).toMatchObject({ status: "live" }); // another organisation: untouched
});

// A live job that shows sponsor_confirmed, with one current statement, committed.
async function sponsoredJob() {
  const org = await F.org();
  const user = await F.portal();
  const member = await F.member(org, user, { role: "account_owner", signer: true });
  const text = await F.text("sponsorship_statement");
  const statement = (q: Q, job: string) =>
    put(q, "sponsorship_statement", { job_id: job, organisation_id: org, kind: "own_company", consent_text_id: text, signer_membership_id: member, signer_name: "Fake Signer" });
  const job = await tx(db.pool("app_portal"), async (c) => {
    const q: Q = (s, a) => c.query(s, a);
    const id = await put(q, "job", jobRow(org, { salary_low: 40000, badge: "sponsor_confirmed", posted_by_membership_id: member }));
    await statement(q, id);
    await c.query("update job set status='live', search_vector=$2 where id=$1", [id, sv]);
    return id;
  });
  return { job, statement };
}

test("[sponsorship_statement] deferred check at commit: a live sponsor_confirmed job cannot lose its current statement by a change", async () => {
  const { job } = await sponsoredJob();
  await rule({
    refuse: () => tx(db.pool("postgres"), (c) => c.query("update sponsorship_statement set superseded_at = now() where job_id = $1", [job])),
    expect: "deferred check",
  });
});
test("[sponsorship_statement] deferred check at commit: a live sponsor_confirmed job cannot lose its current statement by a delete", async () => {
  const { job } = await sponsoredJob();
  await rule({
    refuse: () => tx(db.pool("postgres"), (c) => c.query("delete from sponsorship_statement where job_id = $1", [job])),
    expect: "deferred check",
  });
});
test("[sponsorship_statement] a replacement statement in the same transaction passes the commit check", async () => {
  const { job, statement } = await sponsoredJob();
  await rule({
    ok: () => tx(db.pool("app_portal"), async (c) => {
      await c.query("update sponsorship_statement set superseded_at = now() where job_id = $1", [job]);
      await statement((s, a) => c.query(s, a), job);
    }),
  });
  expect((await su("select count(*)::int as n from sponsorship_statement where job_id = $1 and superseded_at is null", [job])).rows[0].n).toBe(1);
});

// =====================================================================================================================
// Unique rules

// Two transactions at once, so the trigger that checks the number cannot see the other row yet and only the unique rule is left.
async function croPair(second: Record<string, unknown>) {
  const cro = String(600000 + Math.floor(Math.random() * 99999));
  const row = (o: Record<string, unknown>) => ({ slug: uid("org"), display_name: "Fake Org", kind: "employer", status: "verified", cro_number: cro, ...o });
  const c1 = await db.pool("postgres").connect(), c2 = await db.pool("postgres").connect();
  try {
    await c1.query("begin");
    await put((s, a) => c1.query(s, a), "organisation", row({}));
    await c2.query("begin");
    const pid = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    const second2 = { done: false };
    const pending = put((s, a) => c2.query(s, a), "organisation", row(second)).then(() => undefined, (e: unknown) => e).finally(() => { second2.done = true; });
    // Commit the first only once the second insert is seen waiting on its lock (the unique rule is in its way) or has finished
    // (nothing in its way). A fixed sleep could commit too early on a slow machine, and then the trigger would refuse instead.
    for (let i = 0; i < 500 && !second2.done; i++) {
      if ((await su("select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid])).rowCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await c1.query("commit");
    const error = await pending;
    if (error) throw error;
    await c2.query("commit");
  } finally {
    await c1.query("rollback").catch(() => {});
    await c2.query("rollback").catch(() => {});
    c1.release(); c2.release();
  }
}
test("[organisation] unique cro_number: two inserts at once for the same number, only one lands", async () => {
  await rule({ refuse: () => croPair({}), expect: "organisation_cro_unique" });
});
test("[organisation] unique cro_number: a rejected organisation does not hold the number", async () => {
  await rule({ ok: () => croPair({ status: "rejected" }) });
});
test("[organisation] unique cro_number: a closed organisation does not hold the number", async () => {
  await rule({ ok: () => croPair({ status: "closed" }) });
});
test("[organisation] unique cro_number: an organisation merged into another does not hold the number", async () => {
  const target = await F.org();
  await rule({ ok: () => croPair({ merged_into_id: target }) });
});

test("[review_item] one open or claimed item per (queue, pay_floor_id)", async () => {
  const big = await F.org();
  const request = (await asRole("app_admin", A, (q) => q("insert into approval_request(kind,target_table,target_id) values('big_company_entry','organisation',$1) returning id", [big]))).rows[0].id;
  await asRole("app_admin", B, (q) => q("update approval_request set status='confirmed' where id=$1", [request]));
  await su("update organisation set is_big_company=true where id=$1", [big]);
  const user = await F.portal();
  const member = await F.member(big, user, { role: "account_owner", signer: true });
  const floor = await insert("postgres", "pay_floor", { organisation_id: big, role_family: "3434", floor_eur: 40000, consent_text_id: await F.text("pay_floor"), signer_membership_id: member, signer_name: "Fake Signer", valid_until: days(300) });
  // the pay floor insert has queued its own open item for this queue
  const item = () => insert("postgres", "review_item", { queue: "pay_floor_check", pay_floor_id: floor, reason: "again" });
  await rule({ refuse: item, expect: "review_item_floor_unique" });
  await su("update review_item set status='done', decided_by_staff_user_id=$2, decided_at=now() where pay_floor_id=$1", [floor, A]);
  await rule({ ok: item }); // the old one is decided, so a new open one is fine
  await rule({ refuse: item, expect: "review_item_floor_unique" });
});

test("[notification_preference] unique (portal_user_id, category, channel)", async () => {
  const user = await F.portal(), other = await F.portal();
  const pref = (o: Record<string, unknown>) => insert("postgres", "notification_preference", { category: "alerts", channel: "email", enabled: false, ...o });
  await rule({ ok: () => pref({ portal_user_id: user }) });
  await rule({ ok: () => pref({ portal_user_id: other }) }); // another person
  await rule({ ok: () => pref({ portal_user_id: user, channel: "in_app" }) }); // another channel
  await rule({ refuse: () => pref({ portal_user_id: user }), expect: "notification_pref_portal" });
});
test("[notification_preference] unique (staff_user_id, category, channel)", async () => {
  const staff = await F.staff(), other = await F.staff();
  const pref = (o: Record<string, unknown>) => insert("postgres", "notification_preference", { category: "alerts", channel: "email", enabled: false, ...o });
  await rule({ ok: () => pref({ staff_user_id: staff }) });
  await rule({ ok: () => pref({ staff_user_id: other }) });
  await rule({ ok: () => pref({ staff_user_id: staff, channel: "in_app" }) });
  await rule({ refuse: () => pref({ staff_user_id: staff }), expect: "notification_pref_staff" });
});

// =====================================================================================================================
// CHECK rules that carry a rule of the business

async function applicationBase() {
  const org = await F.org();
  const job = await insert("postgres", "job", liveRow(org));
  const who = await candidate();
  const consent = await insert("postgres", "consent_record", { candidate_user_id: who, consent_text_id: await F.text("application") });
  return { org, job, who, consent, row: (o: Record<string, unknown>) => ({ job_id: job, organisation_id: org, ...o }) };
}

// At Launch A the job route is locked to own_page and a trigger refuses every application, and app_candidate holds no right on
// the table. So no real role reaches these two CHECK rules and they are tested alone, triggers off.
const addApplication = (o: Record<string, unknown>) => alone((q) => put(q, "application", o));
test("[application] an application with no candidate keeps no cover note, answers, profile summary or CV (CHECK alone, triggers off)", async () => {
  const { row } = await applicationBase();
  await rule({ ok: () => addApplication(row({})) }); // candidate gone, nothing kept
  for (const kept of [{ cover_note: "Fake note" }, { answers: { q1: "yes" } }, { profile_summary: { years: 5 } }, { cv_storage_key: "applications/x/cv.pdf" }, { cv_file_name: "cv.pdf" }])
    await rule({ refuse: () => addApplication(row(kept)), expect: "application_check" });
});
test("[application] an application that names a candidate may keep its cover note (CHECK alone, triggers off)", async () => {
  const { row, who, consent } = await applicationBase();
  await rule({ ok: () => addApplication(row({ candidate_user_id: who, consent_record_id: consent, cover_note: "Fake note" })) });
});
test("[application] an application that names a candidate needs a consent record (CHECK alone, triggers off)", async () => {
  const { row, who, consent } = await applicationBase();
  await rule({ refuse: () => addApplication(row({ candidate_user_id: who })), expect: "application_check1" });
  await rule({ ok: () => addApplication(row({ candidate_user_id: who, consent_record_id: consent })) });
});

test("[approval_request] a confirmed request names who confirmed it (CHECK alone, triggers off)", async () => {
  const row = (o: Record<string, unknown>) => ({ kind: "setting", target_table: "setting", target_id: uid("k"), proposed_by_staff_user_id: A, ...o });
  await rule({
    refuse: () => alone((q) => put(q, "approval_request", row({ status: "confirmed" }))),
    expect: "approval_request_check1",
  });
  await rule({ ok: () => alone((q) => put(q, "approval_request", row({ status: "confirmed", confirmed_by_staff_user_id: B, decided_at: new Date() }))) });
  await rule({ ok: () => alone((q) => put(q, "approval_request", row({ status: "pending" }))) }); // pending names nobody
});

test("[pay_floor] an active pay floor carries an approval request (CHECK alone, triggers off)", async () => {
  const org = await F.org();
  const member = await F.member(org, await F.portal(), { role: "account_owner", signer: true });
  const text = await F.text("pay_floor");
  const request = await alone((q) => put(q, "approval_request", { kind: "pay_floor", target_table: "pay_floor", target_id: "0", proposed_by_staff_user_id: A, status: "confirmed", confirmed_by_staff_user_id: B, decided_at: new Date() }));
  const row = (o: Record<string, unknown>) => ({ organisation_id: org, role_family: String(1000 + ++roleFamilies), floor_eur: 40000, consent_text_id: text, signer_membership_id: member, signer_name: "Fake Signer", valid_until: days(300), ...o });
  await rule({ refuse: () => alone((q) => put(q, "pay_floor", row({ status: "active" }))), expect: "pay_floor_check1" });
  await rule({ ok: () => alone((q) => put(q, "pay_floor", row({ status: "active", approval_request_id: request }))) });
  await rule({ ok: () => alone((q) => put(q, "pay_floor", row({ status: "pending_check" }))) }); // not active yet, needs none
});

test("[strike] a level 2 or 3 strike, or a ban outcome, carries an approval request (CHECK alone, triggers off)", async () => {
  const org = await F.org();
  const request = await alone((q) => put(q, "approval_request", { kind: "strike_3", target_table: "strike", target_id: "0", proposed_by_staff_user_id: A, status: "confirmed", confirmed_by_staff_user_id: B, decided_at: new Date() }));
  const row = (o: Record<string, unknown>) => ({ organisation_id: org, case_kind: "false_claim", reason_code: "false_sponsorship", stage: "decided", ...o });
  const add = (o: Record<string, unknown>) => alone((q) => put(q, "strike", row(o)));
  for (const bad of [{ outcome: "strike", level: 2 }, { outcome: "strike", level: 3 }, { outcome: "ban" }])
    await rule({ refuse: () => add(bad), expect: "strike_check2" });
  for (const good of [{ outcome: "strike", level: 2 }, { outcome: "strike", level: 3 }, { outcome: "ban" }])
    await rule({ ok: () => add({ ...good, approval_request_id: request }) });
  await rule({ ok: () => add({ outcome: "strike", level: 1 }) }); // level 1 needs none
});

test("[ban] a ban names a company number or an email domain (CHECK alone, triggers off)", async () => {
  const org = await F.org();
  const request = await alone((q) => put(q, "approval_request", { kind: "ban", target_table: "strike", target_id: "0", proposed_by_staff_user_id: A, status: "confirmed", confirmed_by_staff_user_id: B, decided_at: new Date() }));
  const add = (o: Record<string, unknown>) => alone(async (q) => {
    const strike = await put(q, "strike", { organisation_id: org, case_kind: "instant_ban", reason_code: "fake_company", stage: "decided", outcome: "ban", approval_request_id: request });
    return put(q, "ban", { reason_code: "fake_company", strike_id: strike, approval_request_id: request, ...o });
  });
  await rule({ refuse: () => add({}), expect: "ban_check" });
  await rule({ ok: () => add({ cro_number: String(500000 + Math.floor(Math.random() * 99999)) }) });
  await rule({ ok: () => add({ email_domain: `${uid("d")}.ie` }) });
});

test("[consent_text] only sign-up terms and the privacy notice can be tied to an approval request (CHECK alone, triggers off)", async () => {
  const request = await alone((q) => put(q, "approval_request", { kind: "terms_privacy_page", target_table: "consent_text", target_id: "0", proposed_by_staff_user_id: A, status: "confirmed", confirmed_by_staff_user_id: B, decided_at: new Date() }));
  const add = (purpose: string, approval = request as string | null) => alone((q) => put(q, "consent_text", { purpose, version: uid("v"), body: "Fake wording", approval_request_id: approval }));
  await rule({ refuse: () => add("application"), expect: "consent_text_check" });
  await rule({ ok: () => add("signup_terms") });
  await rule({ ok: () => add("portal_signup_terms") });
  await rule({ ok: () => add("privacy_notice") });
  await rule({ ok: () => add("application", null) }); // no request, no limit
});

test("[job] a job hidden under a report id has the hidden reason report", async () => {
  const org = await F.org();
  const target = await insert("postgres", "job", liveRow(org));
  const report = await insert("postgres", "report", { target_kind: "job", target_job_id: target, reason: "other" });
  const hidden = (reason: string) => insert("postgres", "job", liveRow(org, { status: "hidden", hidden_reason: reason, hidden_report_id: report }));
  await rule({ refuse: () => hidden("admin"), expect: "job_check8" });
  await rule({ ok: () => hidden("report") });
});

test("[services_case] a case has exactly one requester unless the requester was erased", async () => {
  const who = await candidate(), user = await F.portal();
  const text = await F.text("services_request");
  const consent = (o: Record<string, unknown>) => insert("postgres", "consent_record", { consent_text_id: text, ...o });
  const row = async (o: Record<string, unknown>) => ({ consent_record_id: await consent({ candidate_user_id: who }), dedupe_key: uid("dk"), ...o });
  await rule({ ok: async () => insert("postgres", "services_case", await row({ candidate_user_id: who })) });
  await rule({ refuse: async () => insert("postgres", "services_case", await row({ candidate_user_id: who, portal_user_id: user })), expect: "services_case_check" });
  await rule({ refuse: async () => insert("postgres", "services_case", await row({})), expect: "services_case_check" });
  await rule({ ok: async () => insert("postgres", "services_case", await row({ requester_erased_at: new Date() })) });
});

test("[organisation_domain] a domain is stored in lower case", async () => {
  const org = await F.org();
  const add = (domain: string) => insert("postgres", "organisation_domain", { organisation_id: org, domain, source: "seed" });
  await rule({ ok: () => add(`${uid("d")}.ie`) });
  await rule({ refuse: () => add(`${uid("D")}.IE`), expect: "organisation_domain_domain_check" });
});

// =====================================================================================================================
// CHECK rules that are a limit: a value at the edge is accepted, one past it is refused. Each case builds a row that is valid in
// every other way and changes only the limited value.
const launchB = {} as { db: TestDb; F: typeof F; source: string };
beforeAll(async () => {
  launchB.db = await createTestDb();
  launchB.F = fixtures(launchB.db).F;
  await launchB.db.query("portal_owner", readFileSync(new URL("../launch-b/0001_launch_b.sql", import.meta.url), "utf8"));
  launchB.source = await put((s, a) => launchB.db.query("postgres", s, a), "job_source", { kind: "portal", board: "portal" });
});
afterAll(() => launchB.db.drop());
const approvedStrikeRequest = () =>
  alone((q) => put(q, "approval_request", { kind: "strike_3", target_table: "strike", target_id: "0", proposed_by_staff_user_id: A, status: "confirmed", confirmed_by_staff_user_id: B, decided_at: new Date() }));
type Limit = { name: string; rule: string; add: (value: unknown) => Promise<unknown>; ok: unknown[]; bad: unknown[] };
const limits: Limit[] = [
  { name: "candidate_cv.size_bytes is 1 to 10485760", rule: "candidate_cv_size_bytes_check", ok: [1, 10485760], bad: [0, 10485761],
    add: async (v) => insert("postgres", "candidate_cv", { candidate_user_id: await candidate(), storage_key: uid("k"), file_name: "cv.pdf", content_type: "pdf", size_bytes: v }) },
  { name: "candidate_profile.years_experience is 0 to 60", rule: "candidate_profile_years_experience_check", ok: [0, 60], bad: [-1, 61],
    add: async (v) => put((s, a) => su(s, a), "candidate_profile", { candidate_user_id: await candidate(), years_experience: v }) },
  { name: "dete_permit_count.month is 1 to 12", rule: "dete_permit_count_month_check", ok: [1, 12], bad: [0, 13],
    add: async (v) => insert("postgres", "dete_permit_count", { dete_name: uid("dete"), year: 2026, month: v, permits: 5 }) },
  // At Launch A the job route is locked to own_page and screening questions need on_site (job_check10), so no real role reaches the
  // limit. This case runs on its own database copy with the Launch B migration applied first, as launch-b.test.ts does.
  { name: "job.screening_questions holds at most 5 questions (database with the Launch B migration)", rule: "job_screening_questions_check", ok: [5, 0], bad: [6],
    add: async (n) => {
      const org = await launchB.F.org();
      const row = liveRow(org, { job_source_id: launchB.source, application_route: "on_site", own_page_url: null, screening_questions: Array.from({ length: n as number }, (_, i) => ({ q: `Fake question ${i}` })) });
      return put((s, a) => launchB.db.query("postgres", s, a), "job", row);
    } },
  { name: "message.body is 1 to 5000 characters", rule: "message_body_check", ok: [1, 5000], bad: [0, 5001],
    // triggers off: the thread is a made-up application id, so only the length is under test
    add: async (n) => alone((q) => put(q, "message", { application_id: 900000000 + Math.floor(Math.random() * 99999999), sender_candidate_user_id: "fake-sender", body: "x".repeat(n as number) })) },
  { name: "strike.level is 1 to 3", rule: "strike_level_check", ok: [1, 3], bad: [0, 4],
    // triggers off; level 2 or 3 needs an approval request (strike_check2), so every case carries one and only the level changes
    add: async (v) => {
      const approval = await approvedStrikeRequest(), org = await F.org();
      return alone((q) => put(q, "strike", { organisation_id: org, case_kind: "false_claim", reason_code: "false_sponsorship", stage: "decided", outcome: "strike", level: v, approval_request_id: approval }));
    } },
];
test.each(limits)("[limits] $name", async ({ rule: name, add, ok, bad }) => {
  for (const v of ok) await rule({ ok: () => add(v) });
  for (const v of bad) await rule({ refuse: () => add(v), expect: name });
});
