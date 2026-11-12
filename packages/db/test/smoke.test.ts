/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Ported from schema-trial-3/20-smoke.mjs, close to as it was: one `it` per step, in the trial's order, sharing ids between steps.
// A step passes when it runs without error. "refusal" steps pass when the database refuses with the stated reason.
// Launch B is applied in the middle, from packages/db/launch-b/0001_launch_b.sql, as the trial did.
import fs from "node:fs";
import { afterAll, beforeAll, it, vi } from "vitest";
import { createTestDb, tx as txPool } from "./db";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db, su, ow;
beforeAll(async () => { db = await createTestDb(); su = db.pool("postgres"); ow = db.pool("portal_owner"); });
afterAll(() => db.drop());

// run statements as a role in one transaction; staff = the acting staff id (set local app.staff_user_id)
const tx = (role, fn, staff) => txPool(db.pool(role), async (c) => {
  if (staff) await c.query("select set_config('app.staff_user_id', $1, true)", [staff]);
  return fn((sql, params = []) => c.query(sql, params));
});
const q = (role, sql, params = [], staff) => tx(role, (x) => x(sql, params), staff);
const S = (table, what, role, fn) => it(`${table}: ${what} [${role}]`, async () => { await fn(); });
// a refusal the design states: passes only if the database refuses and the message matches
const N = (table, what, role, re, fn) => it(`${table}: refusal: ${what} [${role}]`, async () => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error("accepted, should have been refused");
  if (!re.test(err.message)) throw new Error(`refused, but not as expected (${re}): ${err.message}`);
});
const one = async (role, sql, params, staff) => (await q(role, sql, params, staff)).rows[0];
const days = (n) => `now() + interval '${n} days'`;

// ---------- fixtures that only the superuser or the owner can make (the person who runs the migration)
//({ connectionString: `postgres://postgres@127.0.0.1:5432/${DB}` }); await su.connect();

// Fixture repairs (two, as RESULTS-C2.md says): appeal_due_at 7 days not 10 (fix 4 caps it), and the ban's CRO 777 given to its organisation (fix 1).
// ===== login tables
S("staff_user", "insert three staff logins (admin creates them)", "app_admin", async () => {
  for (const [id, n] of [["s1", "Staff One"], ["s2", "Staff Two"], ["s3", "Staff Three"]]) await q("app_admin", "insert into staff_user(id, name, email, email_verified) values ($1,$2,$3,true)", [id, n, id + "@staff.test"]);
});
S("staff_user", "update", "app_admin", () => q("app_admin", "update staff_user set name = 'Staff 1' where id = 's1'"));
S("staff_role", "owner seeds the first two administrators (seeded_by_owner)", "portal_owner", async () => {
  await ow.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ('s1','administrator',true),('s2','administrator',true),('s2','trust_and_safety',true)");
});
S("candidate_user", "insert (optional columns NULL)", "app_candidate", async () => {
  for (const id of ["c1", "c2", "c3"]) await q("app_candidate", "insert into candidate_user(id, name, email, email_verified) values ($1,$2,$3,true)", [id, id, id + "@cand.test"]);
  const r = await one("app_candidate", "select last_active_at is not null as ok from candidate_user where id = 'c1'");
  if (!r.ok) throw new Error("last_active_at did not default to now()");
});
S("candidate_user", "update last_active_at", "app_candidate", () => q("app_candidate", "update candidate_user set last_active_at = now() where id = 'c1'"));
S("candidate_user", "trigger: a sign-in after the warning clears inactive_warned_at", "portal_owner", async () => {
  await ow.query("update candidate_user set inactive_warned_at = now() where id = 'c3'");
  await q("app_candidate", "update candidate_user set last_active_at = now() + interval '1 second' where id = 'c3'");
  const r = await ow.query("select inactive_warned_at from candidate_user where id = 'c3'");
  if (r.rows[0].inactive_warned_at !== null) throw new Error("inactive_warned_at still set after last_active_at changed");
});
S("portal_user", "insert (optional columns NULL)", "app_portal", async () => {
  for (const id of ["p1", "p2", "p3"]) await q("app_portal", "insert into portal_user(id, name, email, email_verified) values ($1,$2,$3,true)", [id, id, id + "@corp.test"]);
});
S("portal_user", "update last_active_at", "app_portal", () => q("app_portal", "update portal_user set last_active_at = now() where id = 'p1'"));
for (const [pool, role] of [["candidate", "app_candidate"], ["portal", "app_portal"], ["staff", "app_admin"]]) {
  const uid = { candidate: "c1", portal: "p1", staff: "s1" }[pool];
  await S(`${pool}_account`, "insert and update", role, async () => {
    await q(role, `insert into ${pool}_account(id, account_id, provider_id, user_id, created_at, updated_at) values ('a-${pool}', 'g-123', 'google', $1, now(), now())`, [uid]);
    await q(role, `update ${pool}_account set updated_at = now() where id = 'a-${pool}'`);
  });
  await N(`${pool}_account`, "a second account with the same (provider_id, account_id) (unique added in 2.2)", role, /unique|duplicate/i, () =>
    q(role, `insert into ${pool}_account(id, account_id, provider_id, user_id, created_at, updated_at) values ('a2-${pool}', 'g-123', 'google', $1, now(), now())`, [uid]));
  await S(`${pool}_session`, "insert and update (expires_at index)", role, async () => {
    await q(role, `insert into ${pool}_session(id, expires_at, token, created_at, updated_at, user_id) values ('ss-${pool}', now() + interval '1 day', 'tok-${pool}', now(), now(), $1)`, [uid]);
    await q(role, `update ${pool}_session set expires_at = now() + interval '2 days' where id = 'ss-${pool}'`);
  });
  await S(`${pool}_rate_limit`, "insert and update (last_request index)", role, async () => {
    await q(role, `insert into ${pool}_rate_limit(id, key, count, last_request) values ('rl-${pool}', 'ip-1', 1, 1000)`);
    await q(role, `update ${pool}_rate_limit set count = 2 where id = 'rl-${pool}'`);
  });
  await S(`${pool}_verification`, "insert and update (expires_at index)", role, async () => {
    await q(role, `insert into ${pool}_verification(id, identifier, value, expires_at, created_at, updated_at) values ('v-${pool}', 'x@y.test', 'tok', now() + interval '1 day', now(), now())`);
    await q(role, `update ${pool}_verification set updated_at = now() where id = 'v-${pool}'`);
  });
}

// ===== approval_request and staff_role
let reqA;
S("approval_request", "insert as staff s1 (acting id set); row is pending and the proposer is stamped", "app_admin", async () => {
  const r = await one("app_admin", "insert into approval_request(kind, target_table, target_id, change, reason) values ('threshold','setting','alert_x','{\"value\":5}','smoke') returning id, status, proposed_by_staff_user_id, confirmed_by_staff_user_id", [], "s1");
  if (r.status !== "pending" || r.proposed_by_staff_user_id !== "s1" || r.confirmed_by_staff_user_id !== null) throw new Error("not stamped: " + JSON.stringify(r));
  reqA = r.id;
});
N("approval_request", "insert with no acting staff id", "app_admin", /no acting staff/, () => q("app_admin", "insert into approval_request(kind, target_table, target_id) values ('threshold','setting','z')"));
N("approval_request", "the proposer confirms their own request", "app_admin", /check|confirmed_by/i, () => q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [reqA], "s1"));
S("approval_request", "update: s2 confirms (confirmer and time stamped)", "app_admin", async () => {
  const r = await one("app_admin", "update approval_request set status = 'confirmed' where id = $1 returning confirmed_by_staff_user_id c, decided_at", [reqA], "s2");
  if (r.c !== "s2" || !r.decided_at) throw new Error("not stamped " + JSON.stringify(r));
});
N("approval_request", "a confirmed request moves again (status changes only from pending)", "app_admin", /only from pending/, () => q("app_admin", "update approval_request set status = 'refused' where id = $1", [reqA], "s2"));
N("approval_request", "app_admin writes applied_at (column grant)", "app_admin", /permission denied/, () => q("app_admin", "update approval_request set applied_at = now() where id = $1", [reqA], "s2"));
let reqRole;
S("staff_role", "grant_role: s1 proposes, s2 confirms, a content_editor row is inserted for s3", "app_admin", async () => {
  const r = await one("app_admin", "insert into approval_request(kind, target_table, target_id, change) values ('grant_role','staff_role','s3','{\"role\":\"content_editor\"}') returning id", [], "s1");
  reqRole = r.id;
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [reqRole], "s2");
  await q("app_admin", "insert into staff_role(staff_user_id, role, granted_by_staff_user_id, approval_request_id) values ('s3','content_editor','s1',$1)", [reqRole]);
});
N("staff_role", "a role row with no request and not seeded", "app_admin", /check|two-person/i, () => q("app_admin", "insert into staff_role(staff_user_id, role) values ('s3','trust_and_safety')"));
N("staff_role", "grant_role request that names another role", "app_admin", /does not name|no confirmed/, async () => {
  const r = await one("app_admin", "insert into approval_request(kind, target_table, target_id, change) values ('grant_role','staff_role','s3','{\"role\":\"content_editor\"}') returning id", [], "s1");
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [r.id], "s2");
  await q("app_admin", "insert into staff_role(staff_user_id, role, approval_request_id) values ('s3','trust_and_safety',$1)", [r.id]);
});
S("staff_role", "update: none by design (app_admin has select, insert, delete only)", "app_admin", async () => "no update grant, checked in 04-grants");

// ===== setting, flags
// fixture change (0004, M2): s1 proposes, s2 confirms; updated_at is stamped by the trigger now, and left out of app_admin's grant
S("setting", "update staff_entry_grace", "app_admin", async () => {
  const r = await one("app_admin", "insert into approval_request(kind, target_table, target_id, change) values ('setting','setting','staff_entry_grace','{\"value\":7}') returning id", [], "s1");
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [r.id], "s2");
  await q("app_admin", "update setting set value = 7 where key = 'staff_entry_grace'", [], "s1");
});
S("setting", "alert_digest_max_jobs row is gone", "app_admin", async () => { const r = await one("app_admin", "select count(*)::int n from setting where key = 'alert_digest_max_jobs'"); if (r.n) throw new Error("still there"); });

// ===== organisations
let org1, org2, org3;
S("organisation", "insert as the fetcher (slug, display_name, kind; rest NULL)", "app_fetcher", async () => {
  org1 = (await one("app_fetcher", "insert into organisation(slug, display_name, kind) values ('acme','Acme Ltd','employer') returning id")).id;
  org2 = (await one("app_fetcher", "insert into organisation(slug, display_name, kind) values ('beta','Beta Ltd','employer') returning id")).id;
  org3 = (await one("app_fetcher", "insert into organisation(slug, display_name, kind) values ('gamma','Gamma Ltd','employer') returning id")).id;
  const r = await one("app_admin", "select status, status_changed_at is not null as stamped from organisation where id = $1", [org1]);
  if (!r.stamped) throw new Error("status_changed_at not stamped on insert");
});
S("organisation", "update status unclaimed to verified (status_changed_at moves)", "app_admin", async () => {
  const before = await one("app_admin", "select status_changed_at s from organisation where id = $1", [org1]);
  await q("app_admin", "select pg_sleep(0.01)");
  for (const o of [org1, org2, org3]) await q("app_admin", "update organisation set status = 'verified', claimed_at = now(), verified_at = now(), signup_path = 'first_time' where id = $1", [o]);
  const after = await one("app_admin", "select status_changed_at s from organisation where id = $1", [org1]);
  if (!(after.s > before.s)) throw new Error("status_changed_at did not move");
});
S("organisation", "update display_name as the portal", "app_portal", () => q("app_portal", "update organisation set display_name = 'Acme Limited' where id = $1", [org1]));
S("organisation_name", "insert as the fetcher; update as admin", "app_fetcher", async () => {
  await q("app_fetcher", "insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1,'Acme Ltd','acme ltd','legal','dete')", [org1]);
  await q("app_admin", "update organisation_name set confirmed_at = now() where organisation_id = $1", [org1]);
});
S("organisation_domain", "insert and update", "app_admin", async () => {
  await q("app_admin", "insert into organisation_domain(organisation_id, domain, source) values ($1,'acme.test','admin')", [org1]);
  await q("app_admin", "update organisation_domain set source = 'seed' where organisation_id = $1", [org1]);
});
S("cro_company", "insert and update (trigram index in extensions)", "app_fetcher", async () => {
  await q("app_fetcher", "insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) values ('100','Acme Ltd','acme ltd','Normal', current_date)");
  await q("app_fetcher", "update cro_company set status = 'Struck off' where cro_number = '100'");
});
S("cro_company", "trigram search by the admin role (extensions schema usage)", "app_admin", async () => {
  await q("app_admin", "select count(*) from cro_company where normalised_name operator(extensions.%) 'acme'");
});
S("membership", "insert owner as the admin (optional columns NULL), update", "app_admin", async () => {
  await q("app_admin", "insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values ($1,'p1','account_owner','active',true, now())", [org1]);
  await q("app_admin", "insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values ($1,'p2','recruiter','active',true, now())", [org1]);
  await q("app_admin", "insert into membership(organisation_id, portal_user_id, role, status, joined_at) values ($1,'p3','viewer','active', now())", [org1]);
  await q("app_admin", "update membership set joined_at = now() where portal_user_id = 'p1'");
});
N("membership", "a viewer with the signer switch (new CHECK)", "app_admin", /check/i, () => q("app_admin", "update membership set is_signer = true where portal_user_id = 'p3'"));
S("membership", "invite with a token hash; a second row with the same hash is refused", "app_admin", async () => {
  await q("app_admin", "insert into membership(organisation_id, invited_email, role, status, invite_token_hash) values ($1,'new@corp.test','poster','invited','h1')", [org1]);
  try { await q("app_admin", "insert into membership(organisation_id, invited_email, role, status, invite_token_hash) values ($1,'new2@corp.test','poster','invited','h1')", [org1]); throw new Error("accepted"); }
  catch (e) { if (!/unique|duplicate/i.test(e.message)) throw e; }
});
const mem = async (u) => (await one("app_admin", "select id from membership where portal_user_id = $1", [u])).id;

// ===== consent
let ctApp, ctSpon, ctFloor;
S("consent_text", "insert as admin", "app_admin", async () => {
  ctApp = (await one("app_admin", "insert into consent_text(purpose, version, body) values ('application','v1','x') returning id")).id;
  ctSpon = (await one("app_admin", "insert into consent_text(purpose, version, body) values ('sponsorship_statement','v1','x') returning id")).id;
  ctFloor = (await one("app_admin", "insert into consent_text(purpose, version, body) values ('pay_floor','v1','x') returning id")).id;
});
let crec;
S("consent_record", "insert through candidate_consent_record, update withdrawn_at", "app_candidate", async () => {
  crec = (await one("app_candidate", "insert into candidate_consent_record(candidate_user_id, consent_text_id) values ('c1',$1) returning id", [ctApp])).id;
  await q("app_candidate", "update candidate_consent_record set withdrawn_at = now() where id = $1", [crec]);
});

// ===== jobs
let src, srcF, jobE, jobF, jobR;
S("job_source", "insert and update", "app_fetcher", async () => {
  src = (await one("app_fetcher", "insert into job_source(kind, board) values ('employer','portal') returning id")).id;
  srcF = (await one("app_fetcher", "insert into job_source(kind, board) values ('fetched','irishjobs') returning id")).id;
  await q("app_fetcher", "update job_source set last_ok_at = now() where id = $1", [src]);
});
let adv;
S("fetched_advert", "insert and update as the fetcher; admin rejects a queued advert (update result)", "app_fetcher", async () => {
  adv = (await one("app_fetcher", "insert into fetched_advert(job_source_id, external_id, result) values ($1,'e1','queued') returning id", [srcF])).id;
  await q("app_fetcher", "update fetched_advert set last_seen_at = now() where id = $1", [adv]);
  await q("app_admin", "update fetched_advert set result = 'rejected' where id = $1", [adv]);
});
S("fetch_run", "insert and update", "app_fetcher", async () => {
  await q("app_fetcher", "insert into fetch_run(job_source_id) values ($1)", [srcF]);
  await q("app_fetcher", "update fetch_run set finished_at = now() where job_source_id = $1", [srcF]);
});
S("job", "insert a draft as the portal (created_at defaults; optional columns NULL)", "app_portal", async () => {
  jobE = (await one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, salary_low, status)
     values ($1,'employer',$2,'Chef','Acme','hospitality','general', ${days(20)}, 'https://acme.test/jobs/1', 40000, 'draft') returning id`, [org1, src])).id;
  const r = await one("app_admin", "select created_at is not null c, permit_history from job where id = $1", [jobE]);
  if (!r.c) throw new Error("created_at null");
});
S("job", "update draft to live as the portal (guard sets posted_at; org is verified)", "app_portal", async () => {
  await q("app_portal", "update job set status = 'live', search_vector = to_tsvector('english','chef') where id = $1", [jobE]);
});
S("job", "trigger job_defaults: permit_history copied from the organisation on insert", "app_admin", async () => {
  await q("app_admin", "update organisation set permit_history = 'has_history' where id = $1", [org2]);
  const j = await one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, pay_grade)
     values ($1,'employer',$2,'Cook','Beta','hospitality','general', ${days(10)}, 'https://b.test/1', 'draft', 'G1') returning id`, [org2, src]);
  const a = await one("app_admin", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, pay_grade, permit_history)
     values ($1,'admin_manual',$2,'Cook2','Beta','hospitality','general', ${days(10)}, 'https://b.test/2', 'draft', 'G1', 'not_linked') returning id`, [org2, src]);
  const r = await q("app_admin", "select permit_history from job where id in ($1,$2)", [j.id, a.id]);
  if (r.rows.some((x) => x.permit_history !== "has_history")) throw new Error("permit_history = " + JSON.stringify(r.rows));
  jobR = j.id;
});
S("organisation", "trigger organisation_permit_history: the change reaches the organisation's open jobs", "app_admin", async () => {
  await q("app_admin", "update organisation set permit_history = 'first_time' where id = $1", [org2]);
  const r = await one("app_admin", "select permit_history from job where id = $1", [jobR]);
  if (r.permit_history !== "first_time") throw new Error("job permit_history = " + r.permit_history);
});
N("job", "portal sets pass_route big_company", "app_portal", /pass_route/, () => q("app_portal", "update job set pass_route = 'big_company' where id = $1", [jobE]));
N("job", "portal moves live to hidden", "app_portal", /may not move/, () => q("app_portal", "update job set status = 'hidden' where id = $1", [jobE]));
S("job", "portal withdraws its own draft (draft to closed, new rule)", "app_portal", async () => {
  await q("app_portal", "update job set status = 'closed', closed_at = now(), close_reason = 'abandoned' where id = $1", [jobR]);
});
N("job", "close_reason outside the list", "app_portal", /check/i, () => q("app_portal", "update job set close_reason = 'because' where id = $1", [jobR]));
N("job", "source changes after insert", "app_admin", /source never changes/, () => q("app_admin", "update job set source = 'agency' where id = $1", [jobE]));
S("job", "update live to closed as portal, then reopen is not needed", "app_portal", async () => {
  const j = await one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, salary_low, search_vector)
     values ($1,'employer',$2,'Waiter','Acme','hospitality','general', ${days(5)}, 'https://acme.test/2', 'live', 30000, to_tsvector('english','waiter')) returning id, posted_at`, [org1, src]);
  await q("app_portal", "update job set status = 'closed', closed_at = now(), close_reason = 'closed' where id = $1", [j.id]);
});
S("job", "fetched job by the fetcher: insert in_review (queue), update title", "app_fetcher", async () => {
  jobF = (await one("app_fetcher", `insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status)
     values ($1,'fetched',$2,$3,'Nurse','Acme','health','critical_skills', 'infinity', 'https://ads.test/1', 'in_review') returning id`, [org1, srcF, adv])).id;
  await q("app_fetcher", "update job set title = 'Staff nurse' where id = $1", [jobF]);
  const r = await one("app_admin", "select count(*)::int n from review_item where queue = 'fetched_job' and job_id = $1", [jobF]);
  if (r.n !== 1) throw new Error("no fetched_job review item");
});
N("job", "fetcher moves its own queued job out of in_review (new rule)", "app_fetcher", /never moves a job out of/, () => q("app_fetcher", "update job set status = 'live', search_vector = to_tsvector('x'), badge = 'critical_skills_eligible' where id = $1", [jobF]));
S("job", "update quota_full as admin; fetcher cannot (no grant)", "app_admin", async () => {
  await q("app_admin", "update job set quota_full = true where id = $1", [jobE]);
  try { await q("app_fetcher", "update job set quota_full = false where id = $1", [jobE]); throw new Error("accepted"); } catch (e) { if (!/permission denied/.test(e.message)) throw e; }
});
S("job", "trigger job_defaults: a client job is looked up in organisation_name (found / not_found, value sent is ignored); not_found queues agency_client_check", "app_portal", async () => {
  const ins = (name) => one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, permit_employer_kind, permit_employer_name, permit_employer_check)
     values ($1,'employer',$2,'Dev','Acme','it','general', ${days(5)}, 'https://acme.test/3', 'draft', 'client', $3, 'found') returning id, permit_employer_check`, [org1, src, name]);
  const a = await ins("ACME  Ltd."); const b = await ins("Nobody Plc");
  const ra = await one("app_admin", "select permit_employer_check c, permit_employer_name_id is not null linked from job where id = $1", [a.id]);
  const rb = await one("app_admin", "select permit_employer_check c from job where id = $1", [b.id]);
  const rq = await one("app_admin", "select count(*)::int n from review_item where queue = 'agency_client_check' and job_id = $1", [b.id]);
  if (ra.c !== "found" || !ra.linked || rb.c !== "not_found" || rq.n !== 1) throw new Error(JSON.stringify({ ra, rb, rq }));
});
S("job_text", "insert and update as the portal", "app_portal", async () => {
  await q("app_portal", "insert into job_text(job_id, advert_text) values ($1,'text')", [jobE]);
  await q("app_portal", "update job_text set advert_text = 'more' where job_id = $1", [jobE]);
});
S("job_daily_stat", "insert and update as the candidate side", "app_candidate", async () => {
  await q("app_candidate", "insert into job_daily_stat(job_id, day) values ($1, current_date)", [jobE]);
  await q("app_candidate", "update job_daily_stat set views = views + 1 where job_id = $1", [jobE]);
});

// ===== sponsorship statement and pay floor
S("sponsorship_statement", "insert as portal (kind check and signer check fire), update superseded_at", "app_portal", async () => {
  const sg = await mem("p1");
  const st = await one("app_portal", "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, signer_membership_id) values ($1,$2,'own_company',$3,$4) returning id", [jobE, org1, ctSpon, sg]);
  await q("app_portal", "update sponsorship_statement set superseded_at = now() where id = $1", [st.id]);
});
N("sponsorship_statement", "a viewer signs (signer check, #103)", "app_portal", /signer refused/, async () => {
  const sg = await mem("p3");
  await q("app_portal", "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, signer_membership_id) values ($1,$2,'own_company',$3,$4)", [jobE, org1, ctSpon, sg]);
});
N("sponsorship_statement", "admin_on_behalf by the portal (statement kind trigger)", "app_portal", /statement refused/, async () => {
  const rq = (await one("app_admin", "insert into approval_request(kind, target_table, target_id) values ('manual_post_sponsor_confirmed','sponsorship_statement',$1) returning id", [String(jobE)], "s1")).id;
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [rq], "s2");
  await q("app_portal", "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, confirmation_file_key, approval_request_id) values ($1,$2,'admin_on_behalf',$3,'k',$4)", [jobE, org1, ctSpon, rq]);
});
let floorId;
S("pay_floor", "big-company entry approved; floor inserted by the portal (queue), withdrawn (ended_at set by the guard)", "app_portal", async () => {
  const r = await one("app_admin", "insert into approval_request(kind, target_table, target_id) values ('big_company_entry','organisation',$1) returning id", [String(org1)], "s1");
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [r.id], "s2");
  await q("app_admin", "update organisation set is_big_company = true where id = $1", [org1]);
  const sg = await mem("p1");
  floorId = (await one("app_portal", `insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, valid_until) values ($1,'chef',35000,$2,$3, ${days(300)}) returning id`, [org1, ctFloor, sg])).id;
  await q("app_portal", "update pay_floor set status = 'withdrawn' where id = $1", [floorId]);
  const f = await one("app_admin", "select ended_at is not null e from pay_floor where id = $1", [floorId]);
  const rq = await one("app_admin", "select count(*)::int n from review_item where queue = 'pay_floor_check' and pay_floor_id = $1", [floorId]);
  if (!f.e || rq.n !== 1) throw new Error("ended_at or queue missing");
});

// ===== candidate side
S("candidate_profile", "insert and update (optional columns NULL)", "app_candidate", async () => {
  await q("app_candidate", "insert into candidate_profile(candidate_user_id) values ('c1')");
  await q("app_candidate", "update candidate_profile set full_name = 'C One' where candidate_user_id = 'c1'");
});
S("candidate_cv", "insert and update", "app_candidate", async () => {
  await q("app_candidate", "insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ('c1','k1','cv.pdf','pdf',1000)");
  await q("app_candidate", "update candidate_cv set file_name = 'cv2.pdf' where candidate_user_id = 'c1'");
});
S("saved_job", "insert (no update grant)", "app_candidate", () => q("app_candidate", "insert into saved_job(candidate_user_id, job_id) values ('c1',$1)", [jobE]));
S("tracker_entry", "insert (redirect route) and update stage", "app_candidate", async () => {
  await q("app_candidate", "insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ('c1',$1,'redirect','mark_applied','applied')", [jobE]);
  await q("app_candidate", "update tracker_entry set stage = 'interview' where candidate_user_id = 'c1'");
});
S("apply_click", "insert and update (clicked_at index)", "app_candidate", async () => {
  await q("app_candidate", "insert into apply_click(candidate_user_id, job_id) values ('c1',$1)", [jobE]);
  await q("app_candidate", "update apply_click set status = 'yes', answered_at = now() where candidate_user_id = 'c1'");
});
S("alert", "insert and update (optional columns NULL)", "app_candidate", async () => {
  await q("app_candidate", "insert into alert(candidate_user_id, frequency, unsubscribe_token) values ('c1','daily','tok1')");
  await q("app_candidate", "update alert set last_sent_at = now() where candidate_user_id = 'c1'");
});
S("candidate_notification", "app_candidate writes its own notification through the view; reads and marks read", "app_candidate", async () => {
  await q("app_candidate", "insert into candidate_notification(candidate_user_id, category, template_key) values ('c1','x','t')");
  await q("app_candidate", "update candidate_notification set read_at = now() where candidate_user_id = 'c1'");
});
S("notification", "app_fetcher inserts into the table; app_candidate has no rights on the table", "app_fetcher", async () => {
  await q("app_fetcher", "insert into notification(portal_user_id, category, template_key, dedupe_key) values ('p1','x','t','d1')");
  try { await q("app_candidate", "insert into notification(candidate_user_id, category, template_key) values ('c1','x','t')"); throw new Error("accepted"); }
  catch (e) { if (!/permission denied/.test(e.message)) throw e; }
});
S("notification", "portal view insert and update read_at", "app_portal", async () => {
  await q("app_portal", "insert into portal_notification(portal_user_id, category, template_key) values ('p1','x','t2')");
  await q("app_portal", "update portal_notification set read_at = now() where portal_user_id = 'p1'");
});
S("email_outbox", "insert as admin and update status (person indexes, retention indexes)", "app_admin", async () => {
  await q("app_admin", "insert into email_outbox(template, candidate_user_id, dedupe_key) values ('welcome','c2','e1')");
  await q("app_admin", "update email_outbox set status = 'sent', sent_at = now() where dedupe_key = 'app_admin:e1'"); // fixture change (0004, M4): app_admin's key is stored as role:key
});

// ===== services cases
let caseC, caseP;
S("services_case", "candidate view insert (optional columns NULL), admin update", "app_candidate", async () => {
  const cr = (await one("app_candidate", "insert into candidate_consent_record(candidate_user_id, consent_text_id) values ('c2',$1) returning id", [ctApp])).id;
  caseC = (await one("app_candidate", "insert into candidate_services_case(candidate_user_id, consent_record_id) values ('c2',$1) returning id", [cr])).id;
  await q("app_admin", "update services_case set status = 'documents_needed', assigned_staff_user_id = 's1' where id = $1", [caseC]);
});
S("services_case", "portal view insert needs dedupe_key; the same key twice is one case", "app_portal", async () => {
  const cr = (await one("app_portal", "insert into portal_consent_record(portal_user_id, consent_text_id) values ('p2',$1) returning id", [ctApp])).id;
  caseP = (await one("app_portal", "insert into portal_services_case(portal_user_id, consent_record_id, dedupe_key) values ('p2',$1,'form-1') returning id", [cr])).id;
  try { await q("app_portal", "insert into portal_services_case(portal_user_id, consent_record_id, dedupe_key) values ('p2',$1,'form-1')", [cr]); throw new Error("second case accepted"); }
  catch (e) { if (!/unique|duplicate/i.test(e.message)) throw e; }
});
N("services_case", "a portal case with no dedupe_key", "app_portal", /check|null value/i, async () => {
  const cr = (await one("app_portal", "insert into portal_consent_record(portal_user_id, consent_text_id) values ('p2',$1) returning id", [ctApp])).id;
  await q("app_portal", "insert into portal_services_case(portal_user_id, consent_record_id) values ('p2',$1)", [cr]);
});
S("case_document", "admin inserts a staff upload (new grant) and updates copy_deleted_at", "app_admin", async () => {
  const d = await one("app_admin", "insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, staff_user_id) values ($1,'sk','f.pdf','pdf',10,'s1') returning id", [caseC]);
  await q("app_admin", "update case_document set storage_key = null, file_name = null, copy_deleted_at = now() where id = $1", [d.id]);
});
S("case_note", "insert and update", "app_admin", async () => {
  await q("app_admin", "insert into case_note(services_case_id, author_staff_user_id, body) values ($1,'s1','n')", [caseC]);
  await q("app_admin", "update case_note set body = 'n2' where services_case_id = $1", [caseC]);
});
S("case_quote", "insert and update", "app_admin", async () => {
  await q("app_admin", "insert into case_quote(services_case_id, amount_eur) values ($1, 100)", [caseP]);
  await q("app_admin", "update case_quote set status = 'sent', sent_at = now() where services_case_id = $1", [caseP]);
});

// ===== contact_message, report, review_item
S("contact_message", "candidate inserts a data_request message (from_name and from_email NULL); trigger queues the review item", "app_candidate", async () => {
  const m = await one("app_candidate", "insert into contact_message(surface, candidate_user_id, topic, body) values ('candidate_site','c2','data_request','please delete my data') returning id");
  const r = await one("app_admin", "select count(*)::int n from review_item where queue = 'data_request' and contact_message_id = $1", [m.id]);
  if (r.n !== 1) throw new Error("no data_request review_item");
  await q("app_admin", "update contact_message set status = 'claimed', claimed_by_staff_user_id = 's1', claimed_at = now() where id = $1", [m.id]);
});
S("contact_message", "a visitor's message (no person, no name, email set); portal side insert", "app_portal", async () => {
  await q("app_portal", "insert into contact_message(surface, portal_user_id, topic, body) values ('portal','p2','general','hello')");
});
N("contact_message", "a message with no body and a person still set (new CHECK)", "app_admin", /check/i, () => q("app_admin", "update contact_message set body = null where portal_user_id = 'p2'"));
let rep1;
S("report", "insert as the candidate (target job); admin update", "app_candidate", async () => {
  await q("app_candidate", "insert into report(target_kind, target_job_id, reporter_candidate_user_id, reason) values ('job',$1,'c1','other')", [jobE]);
  rep1 = (await one("app_admin", "select id from report where target_job_id = $1", [jobE])).id;
});
S("review_item", "admin insert and update (retention index)", "app_admin", async () => {
  const r = await one("app_admin", "insert into review_item(queue, organisation_id) values ('account_review',$1) returning id", [org3]);
  await q("app_admin", "update review_item set status = 'done', decided_by_staff_user_id = 's1', decided_at = now() where id = $1", [r.id]);
});
S("audit_event", "insert as every app role; admin reads", "app_candidate", async () => {
  for (const r of ["app_candidate", "app_portal", "app_admin", "app_fetcher"]) await q(r, "insert into audit_event(kind, action) values ('security','smoke')");
  await q("app_admin", "select count(*) from audit_event where object_id = 'x' and object_type = 'y'");
});

// ===== report upheld closes the jobs it hid; strike 1 closes its case's job
S("report", "trigger report_upheld: a job hidden by the report is closed (removed) when upheld", "app_admin", async () => {
  const j = await one("app_admin", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, salary_low, search_vector)
     values ($1,'admin_manual',$2,'Hidden','Acme','x','general', ${days(5)}, 'https://acme.test/9', 'live', 1, to_tsvector('x')) returning id`, [org1, src]);
  await q("app_admin", "update report set status = 'job_hidden' where id = $1", [rep1]);
  await q("app_admin", "update job set status = 'hidden', hidden_reason = 'report', hidden_report_id = $2 where id = $1", [j.id, rep1]);
  await q("app_admin", "update report set status = 'upheld', decided_by_staff_user_id = 's1', decided_at = now(), reporter_candidate_user_id = null where id = $1", [rep1]);
  const r = await one("app_admin", "select status, close_reason, hidden_reason from job where id = $1", [j.id]);
  if (r.status !== "closed" || r.close_reason !== "removed" || r.hidden_reason !== null) throw new Error(JSON.stringify(r));
});

// ===== strike, ban
let st1, stR, stE, st2, stB, banId;
S("strike", "insert a decided strike 1 as admin (staff id and time stamped by the trigger); trigger strike_closes_jobs closes its job", "app_admin", async () => {
  const j = await one("app_admin", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, salary_low, search_vector)
     values ($1,'admin_manual',$2,'S1','Acme','x','general', ${days(5)}, 'https://acme.test/s1', 'live', 1, to_tsvector('x')) returning id`, [org1, src]);
  st1 = (await one("app_admin", "insert into strike(organisation_id, case_kind, job_id, reason_code, level, outcome, stage, reply_due_at, appeal_due_at) values ($1,'false_claim',$2,'false_sponsorship',1,'strike','decided', now() - interval '1 day', now() + interval '6 days') returning id, decided_by_staff_user_id d, decided_at", [org1, j.id], "s1"));
  if (st1.d !== "s1" || !st1.decided_at) throw new Error("not stamped " + JSON.stringify(st1));
  const r = await one("app_admin", "select status, close_reason from job where id = $1", [j.id]);
  if (r.status !== "closed" || r.close_reason !== "removed") throw new Error("job not closed " + JSON.stringify(r));
});
N("strike", "a strike write as app_admin with no acting staff id", "app_admin", /no acting staff/, () => q("app_admin", "update strike set notice_summary = 'x' where id = $1", [st1.id]));
S("strike", "case open: reply window, portal writes employer_reply (replied_at stamped); app_portal cannot write the staff columns", "app_admin", async () => {
  stR = (await one("app_admin", "insert into strike(organisation_id, case_kind, reason_code, stage, reply_due_at, appeal_due_at) values ($1,'false_claim','false_sponsorship','reply_window', now() + interval '3 days', now() + interval '7 days') returning id", [org1], "s1")).id;
  const r = await one("portal_owner", "update strike set employer_reply = 'we deny' where id = $1 returning replied_at", [stR]); // 0017: the portal replies through status_write, which runs as portal_owner
  const e = await one("app_admin", "select reply_entered_by_staff_user_id e from strike where id = $1", [stR]);
  if (!r.replied_at || e.e !== null) throw new Error(JSON.stringify({ r, e }));
  try { await q("app_portal", "update strike set decided_by_staff_user_id = 's1' where id = $1", [stR]); throw new Error("accepted"); } catch (e) { if (!/permission denied/.test(e.message)) throw e; }
});
S("strike", "staff enter an emailed reply late within staff_entry_grace (received date set, entered_by stamped)", "app_admin", async () => {
  stE = (await one("app_admin", "insert into strike(organisation_id, case_kind, reason_code, stage, reply_due_at, appeal_due_at) values ($1,'false_claim','false_sponsorship','reply_window', now() - interval '2 days', now() + interval '7 days') returning id", [org1], "s1")).id;
  const r = await one("app_admin", "update strike set employer_reply = 'by post', reply_received_at = now() - interval '3 days' where id = $1 returning reply_entered_by_staff_user_id e, replied_at", [stE], "s2");
  if (r.e !== "s2") throw new Error(JSON.stringify(r));
});
N("strike", "staff enter a reply with no received date", "app_admin", /reply window/, () => q("app_admin", "update strike set employer_reply = 'again' where id = $1", [stR], "s2"));
N("strike", "portal replies after the due date (0017: never directly; status_write checks the window)", "app_portal", /permission denied/, () => q("app_portal", "update strike set employer_reply = 'late' where id = $1", [stE]));
S("strike", "strike 2 with approval: request, outcome set, organisation restricted_until set, status verified_restricted; badge removed from its jobs", "app_admin", async () => {
  st2 = (await one("app_admin", "insert into strike(organisation_id, case_kind, reason_code, stage, appeal_due_at) values ($1,'false_claim','false_sponsorship','decided', now() + interval '7 days') returning id", [org1], "s1")).id;
  const req = (await one("app_admin", "insert into approval_request(kind, target_table, target_id) values ('strike_2','strike',$1) returning id", [String(st2)], "s1")).id;
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [req], "s2");
  await tx("app_admin", async (x) => {
    await x("update strike set outcome = 'strike', level = 2, approval_request_id = $2 where id = $1", [st2, req]);
    await x("update organisation set restricted_until = now() + interval '90 days' where id = $1", [org1]);
    await x("update organisation set status = 'verified_restricted' where id = $1", [org1]);
  }, "s1");
  const r = await one("app_admin", "select status, restricted_until > now() as r from organisation where id = $1", [org1]);
  if (r.status !== "verified_restricted" || !r.r) throw new Error(JSON.stringify(r));
});
N("organisation", "restricted_until moved by hand (never changes once set)", "app_admin", /never changes once set|only in the transaction/, () => q("app_admin", "update organisation set restricted_until = now() + interval '1 day' where id = $1", [org1]));
N("organisation", "restricted_until set on another organisation by one person", "app_admin", /only in the transaction/, () => q("app_admin", "update organisation set restricted_until = now() + interval '90 days' where id = $1", [org2]));
N("organisation", "status banned with no ban row", "app_admin", /banned only while a ban row/, () => q("app_admin", "update organisation set status = 'banned' where id = $1", [org2]));
S("job", "restricted organisation: portal draft to live becomes in_review; scam/post_strike item queued; sponsor_confirmed refused", "app_portal", async () => {
  const j = await one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, salary_low)
     values ($1,'employer',$2,'R','Acme','x','general', ${days(5)}, 'https://acme.test/r', 'draft', 1) returning id`, [org1, src]);
  const r = await one("app_portal", "update job set status = 'live', search_vector = to_tsvector('x') where id = $1 returning status", [j.id]);
  const rq = await one("app_admin", "select queue from review_item where job_id = $1", [j.id]);
  if (r.status !== "in_review" || rq.queue !== "post_strike_job_review") throw new Error(JSON.stringify({ r, rq }));
  try { await q("app_portal", "update job set badge = 'sponsor_confirmed' where id = $1", [j.id]); throw new Error("accepted"); } catch (e) { if (!/restricted/.test(e.message)) throw e; }
});
S("strike", "appeal by the portal, overturned by s3-less admin s2 (not decider, not enterer); trigger strike_overturned clears restricted_until", "app_admin", async () => {
  await q("portal_owner", "update strike set appeal_text = 'unfair' where id = $1", [st2]);
  await q("app_admin", "update strike set stage = 'overturned' where id = $1", [st2], "s2");
  const r = await one("app_admin", "select restricted_until, appeal_decided_by_staff_user_id a from strike s join organisation o on o.id = s.organisation_id where s.id = $1", [st2]);
  if (r.restricted_until !== null || r.a !== "s2") throw new Error(JSON.stringify(r));
  await q("app_admin", "update organisation set status = 'verified' where id = $1", [org1]);
});
N("strike", "stage moves out of overturned", "app_admin", /never moves out/, () => q("app_admin", "update strike set stage = 'decided' where id = $1", [st2], "s2"));
S("ban", "instant ban: request, strike outcome ban, ban row inserted in the same transaction; trigger ban_closes_jobs; organisation to banned", "app_admin", async () => {
  await q("app_admin", "update organisation set cro_number = '777' where id = $1", [org2]);
  stB = (await one("app_admin", "insert into strike(organisation_id, case_kind, reason_code, stage, appeal_due_at) values ($1,'instant_ban','fake_company','decided', now() + interval '7 days') returning id", [org2], "s1")).id;
  const req = (await one("app_admin", "insert into approval_request(kind, target_table, target_id) values ('ban','strike',$1) returning id", [String(stB)], "s1")).id;
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [req], "s2");
  banId = await tx("app_admin", async (x) => {
    await x("update strike set outcome = 'ban', approval_request_id = $2 where id = $1", [stB, req]);
    const b = (await x("insert into ban(cro_number, reason_code, strike_id, approval_request_id) values ('777','fake_company',$1,$2) returning id", [stB, req])).rows[0].id;
    await x("update organisation set status = 'banned' where id = $1", [org2]);
    return b;
  }, "s1");
});
N("ban", "update a ban row (no role updates a ban)", "app_admin", /permission denied|no role updates/, () => q("app_admin", "update ban set cro_number = '778' where id = $1", [banId], "s1"));
N("ban", "insert a ban without the case's applied request", "app_admin", /ban refused|approval/, async () => {
  const r2 = (await one("app_admin", "insert into approval_request(kind, target_table, target_id) values ('ban','strike','999') returning id", [], "s1")).id;
  await q("app_admin", "insert into ban(cro_number, reason_code, strike_id, approval_request_id) values ('779','fake_company',$1,$2)", [stB, r2], "s1");
});
S("ban", "lift: confirmed ban_lift, delete the ban; ban_lifted_at stamped on the case by the trigger", "app_admin", async () => {
  const req = (await one("app_admin", "insert into approval_request(kind, target_table, target_id) values ('ban_lift','ban',$1) returning id", [String(banId)], "s1")).id;
  await q("app_admin", "update approval_request set status = 'confirmed' where id = $1", [req], "s2");
  await q("app_admin", "delete from ban where id = $1", [banId], "s1");
  const r = await one("app_admin", "select ban_lifted_at is not null l from strike where id = $1", [stB]);
  if (!r.l) throw new Error("ban_lifted_at not stamped");
  await q("app_admin", "update organisation set status = 'verified' where id = $1", [org2]);
});
const orgWithDraft = async (slug, portalId, salary) => {
  const o = (await one("app_fetcher", "insert into organisation(slug, display_name, kind) values ($1,$1,'employer') returning id", [slug])).id;
  await q("app_admin", "update organisation set status = 'verified', claimed_at = now(), verified_at = now(), signup_path = 'first_time' where id = $1", [o]);
  await q("app_portal", "insert into portal_user(id, name, email, email_verified) values ($1,$1,$2,true)", [portalId, portalId + "@corp.test"]);
  await q("app_admin", "insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values ($1,$2,'account_owner','active',true, now())", [o, portalId]);
  await q("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status ${salary ? ", salary_low" : ""})
     values ($1,'employer',$2,'Draft','x','x','general', ${days(5)}, 'https://x.test/d', 'draft' ${salary ? ", 1" : ""})`, [o, src]);
  return o;
};
S("organisation", "return to unclaimed removes memberships, empties claim columns, closes draft jobs (trigger; the draft has a salary)", "app_admin", async () => {
  const o = await orgWithDraft("unclaim-ok", "p4", true);
  await q("app_admin", "update organisation set status = 'unclaimed' where id = $1", [o]);
  const r = await one("app_admin", "select (select count(*) from membership where organisation_id = $1 and status <> 'removed')::int m, claimed_at, signup_path, (select status from job where organisation_id = $1) j from organisation where id = $1", [o]);
  if (r.m !== 0 || r.claimed_at !== null || r.signup_path !== null || r.j !== "closed") throw new Error(JSON.stringify(r));
});
S("organisation", "FINDING check: return to unclaimed when the organisation holds an employer draft with no salary and no pay grade", "app_admin", async () => {
  const o = await orgWithDraft("unclaim-nosalary", "p5", false);
  await q("app_admin", "update organisation set status = 'unclaimed' where id = $1", [o]);
});
S("job", "FINDING check: the portal withdraws its own draft that has no salary and no pay grade (draft to closed, Build 9)", "app_portal", async () => {
  const j = await one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status)
     values ($1,'employer',$2,'NoPay','x','x','general', ${days(5)}, 'https://x.test/n', 'draft') returning id`, [org2, src]);
  await q("app_portal", "update job set status = 'closed', closed_at = now(), close_reason = 'closed' where id = $1", [j.id]);
});
S("organisation", "(trial setup line) org3 to needs_info, a refusal is ignored", "app_admin", () => q("app_admin", "update organisation set status = 'needs_info' where id = $1", [org3]).catch(() => {}));
S("organisation", "CRO trigger: a merged organisation does not hold its number; merge needs no active members", "app_admin", async () => {
  await q("app_admin", "update organisation set cro_number = '555' where id = $1", [org2]);
  await q("app_admin", "update organisation set cro_number = '555' where id = $1", [org3]).then(() => { throw new Error("two organisations hold 555"); }, (e) => { if (!/already belongs/.test(e.message)) throw e; });
  await q("app_admin", "update organisation set merged_into_id = $2 where id = $1", [org3, org2]);
  await q("app_admin", "update organisation set cro_number = '556' where id = $1", [org3]);
});
S("organisation", "the survivor takes the absorbed organisation's CRO number (merged side is skipped by the unique index and the trigger)", "app_admin", () => q("app_admin", "update organisation set cro_number = '556' where id = $1", [org2]));

// ===== role settings and table settings (section 2.2, section 7)
S("roles", "per-role timeouts are set (alter role ... set) and statement_timeout fires for app_candidate at 5 s", "app_candidate", async () => {
  const r = await su.query("select rolname, rolconfig from pg_roles where rolname like 'app\\_%' order by 1");
  const want = { app_admin: "60s", app_candidate: "5s", app_fetcher: "30s", app_portal: "5s" };
  for (const x of r.rows) if (!x.rolconfig?.includes(`statement_timeout=${want[x.rolname]}`)) throw new Error(x.rolname + " " + JSON.stringify(x.rolconfig));
  try { await q("app_candidate", "select pg_sleep(6)"); throw new Error("did not time out"); } catch (e) { if (e.code !== "57014") throw e; }
});
S("table settings", "autovacuum settings on job, email_outbox, notification and the six session and rate-limit tables", "portal_owner", async () => {
  const r = await su.query("select relname, reloptions from pg_class where relnamespace = 'public'::regnamespace and reloptions is not null order by 1");
  const names = r.rows.map((x) => x.relname);
  const need = ["job", "email_outbox", "notification", "candidate_session", "portal_session", "staff_session", "candidate_rate_limit", "portal_rate_limit", "staff_rate_limit"];
  const miss = need.filter((n) => !names.includes(n)); if (miss.length) throw new Error("missing " + miss);
  const j = r.rows.find((x) => x.relname === "job").reloptions.join(","); if (!/threshold=500/.test(j)) throw new Error(j);
});

// ===== functions and sign-up
S("claim_organisation / register_organisation", "claim an unclaimed organisation; register a new one (slug from the name, organisation_id returned)", "app_portal", async () => {
  const claimable = (await one("app_fetcher", "insert into organisation(slug, display_name, kind) values ('claimable','Claimable','employer') returning id")).id;
  await q("app_admin", "insert into organisation_domain(organisation_id, domain, source) values ($1,'claim.test','seed')", [claimable]);
  await q("app_portal", "insert into portal_user(id, name, email, email_verified) values ('p6','p6','p6@claim.test',true)");
  const c = await one("app_portal", "select private.claim_organisation('p6', $1) as r", [claimable]);
  if (String(c.r.organisation_id) !== String(claimable) || c.r.status !== "verified") throw new Error("claim " + JSON.stringify(c.r));
  for (const id of ["p7", "p8"]) await q("app_portal", "insert into portal_user(id, name, email, email_verified) values ($1,$1,$2,true)", [id, id + "@new.test"]);
  const a = await one("app_portal", "select private.register_organisation('p7','employer','Sunny Side Ltd', '9000', null) as r");
  const b = await one("app_portal", "select private.register_organisation('p8','employer','Sunny Side Ltd', '9001', null) as r");
  const s = await q("app_admin", "select slug from organisation where id in ($1,$2) order by id", [a.r.organisation_id, b.r.organisation_id]);
  if (s.rows[0].slug !== "sunny-side-ltd" || s.rows[1].slug !== "sunny-side-ltd-2") throw new Error(JSON.stringify(s.rows));
});

// erase and retention need a person with everything
S("erase_candidate(id, on_request)", "on request: applications emptied, contact message emptied with body and key, outbox stand-in, consent bare proof, returns keys", "app_admin", async () => {
  await ow.query("insert into candidate_user(id, name, email, email_verified) values ('c9','C Nine','c9@cand.test',true)");
  await ow.query("insert into email_outbox(template, candidate_user_id, status, params, sent_at, dedupe_key) values ('welcome','c9','sent','{\"n\":1}', now(), 'e9')");
  await ow.query("insert into contact_message(surface, candidate_user_id, topic, body, from_name, from_email, status, closed_at) values ('candidate_site','c9','general','hi','C Nine','c9@cand.test','closed', now())");
  await ow.query("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ('c9','k9','cv.pdf','pdf',1)");
  const ct = (await ow.query("insert into consent_record(candidate_user_id, consent_text_id) values ('c9',$1) returning id", [ctApp])).rows[0].id;
  const r = await one("app_admin", "select private.erase_candidate('c9', true) as r");
  if (!r.r.erased) throw new Error(JSON.stringify(r.r));
  const o = await ow.query("select candidate_user_id, params from email_outbox where dedupe_key = 'e9'");
  const m = await ow.query("select body, from_name, from_email, candidate_user_id from contact_message where body is null or from_name is null");
  const cc = await ow.query("select subject_erased_at is not null e from consent_record where id = $1", [ct]);
  if (!o.rows[0].candidate_user_id.startsWith("erased-") || o.rows[0].params !== null) throw new Error("outbox " + JSON.stringify(o.rows));
  if (m.rowCount < 1 || !cc.rows[0].e) throw new Error("contact message or consent " + JSON.stringify({ m: m.rows, cc: cc.rows }));
  return { storage_keys: r.r.storage_keys };
});
S("erase_candidate(id, on_request)", "retention form (false) keeps the message body", "app_admin", async () => {
  await ow.query("insert into candidate_user(id, name, email, email_verified) values ('c8','C Eight','c8@cand.test',true)");
  await ow.query("insert into contact_message(surface, candidate_user_id, topic, body, from_name, from_email) values ('candidate_site','c8','general','keep me','C Eight','c8@cand.test')");
  const r = await one("app_admin", "select private.erase_candidate('c8', false) as r");
  const m = await ow.query("select body, from_name, candidate_user_id from contact_message where body = 'keep me'");
  if (!r.r.erased || m.rowCount !== 1 || m.rows[0].from_name !== null || m.rows[0].candidate_user_id !== null) throw new Error(JSON.stringify({ r: r.r, m: m.rows }));
});
S("erase_candidate(id, on_request)", "refuses and returns the reason while a services case is open", "app_admin", async () => {
  const r = await one("app_admin", "select private.erase_candidate('c2', true) as r");
  if (r.r.erased || r.r.reason !== "open_services_case") throw new Error(JSON.stringify(r.r));
});
S("erase_portal_user(id, on_request)", "erase p3 (no case): memberships removed, returns erased", "app_admin", async () => {
  const r = await one("app_admin", "select private.erase_portal_user('p3', true) as r");
  if (!r.r.erased) throw new Error(JSON.stringify(r.r));
});
S("audit_purge()", "call once as the owner (pg_cron's role)", "portal_owner", async () => { await ow.query("select private.audit_purge()"); });

// ===== run_retention: every rule's SQL is run (due query with every row due, and the act statement on an empty batch), then real batches
S("retention_rules()", "every due query, refuse clause and act statement parses and runs (value -1000, empty batch)", "portal_owner", async () => {
  const rules = (await ow.query("select * from private.retention_rules() order by ord")).rows;
  const bad = [];
  for (const r of rules) {
    try {
      await ow.query("begin");
      const lit = (s) => s.replaceAll("$1", "(-1000)").replaceAll("$2", "'{}'::text[]");
      await ow.query(`select count(*) from (${lit(r.due)}${r.refuse ? " and (" + r.refuse + ")" : ""}) x`);
      if (r.kind === "sql") await ow.query(lit(r.act));
      await ow.query("rollback");
    } catch (e) { await ow.query("rollback"); bad.push(`${r.ord} ${r.key}${r.target ? ":" + r.target : ""}: ${e.message}`); }
  }
  if (bad.length) throw new Error(bad.join(" | "));
  return `${rules.length} rules ok`;
});
S("run_retention()", "one batch per call: deleted_account_grace erases a due candidate, returns rule, done, left", "app_admin", async () => {
  await ow.query("insert into candidate_user(id, name, email, email_verified, deleted_at) values ('d1','D1','d1@x.test',true, now() - interval '40 days'),('d2','D2','d2@x.test',true, now() - interval '40 days'),('d3','D3','d3@x.test',true, now() - interval '40 days')");
  const first = (await one("app_admin", "select private.run_retention(2) as r")).r;
  const second = (await one("app_admin", "select private.run_retention(2) as r")).r;
  if (first.rule !== "deleted_account_grace" || first.done !== 2 || first.left !== 1 || second.done !== 1 || second.left !== 0) throw new Error(JSON.stringify({ first, second }));
  return { first, second };
});
S("run_retention()", "application_and_cv, application_record: rule empties, keeps the row; later deletes it", "app_admin", async () => { return "tested after Launch B below"; });
S("run_retention()", "claim_needs_info returns a stale needs_info organisation to unclaimed (status_changed_at clock)", "app_admin", async () => {
  await ow.query("update organisation set status = 'needs_info', signup_path = 'dete_claim' where id = $1", [org3]); // a claim (a registration would become rejected, migration 0011)
  await ow.query("alter table organisation disable trigger organisation_guard");
  await ow.query("update organisation set status_changed_at = now() - interval '40 days' where id = $1", [org3]);
  await ow.query("alter table organisation enable trigger organisation_guard");
  let r; for (let i = 0; i < 12; i++) { r = (await one("app_admin", "select private.run_retention(1000) as r")).r; if (r.rule === "claim_needs_info" || r.rule === null) break; }
  const o = await ow.query("select status from organisation where id = $1", [org3]);
  if (o.rows[0].status !== "unclaimed") throw new Error(JSON.stringify({ r, status: o.rows[0].status }));
});
S("run_retention()", "drains to rule = null; the audit row is written", "app_admin", async () => {
  let r, n = 0; do { r = (await one("app_admin", "select private.run_retention(1000) as r")).r; n++; } while (r.rule !== null && n < 60);
  if (r.rule !== null) throw new Error("did not drain: " + JSON.stringify(r));
  return `${n} calls`;
});
S("run_retention()", "FINDING check: draft_job closes an employer draft with no salary and no pay grade, 12 months old", "app_admin", async () => {
  const j = await one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status)
     values ($1,'employer',$2,'OldDraft','x','x','general', ${days(5)}, 'https://x.test/o', 'draft') returning id`, [org2, src]);
  await ow.query("update job set created_at = now() - interval '13 months' where id = $1", [j.id]);
  let r, n = 0; try { do { r = (await one("app_admin", "select private.run_retention(1000) as r")).r; n++; } while (r.rule !== null && n < 60); }
  finally { await ow.query("delete from job where id = $1", [j.id]); }
});

// ===== Launch B: apply the migration, then its tables and functions
S("Launch B migration", "09-launch-b.sql runs as the owner", "portal_owner", async () => {
  const sql = fs.readFileSync(new URL("../launch-b/0001_launch_b.sql", import.meta.url), "utf8");
  await ow.query(sql);
});
let appId, jobOn, crq;
S("job", "on-site job, live", "app_admin", async () => {
  await q("app_admin", "update organisation set status = 'verified', claimed_at = now(), verified_at = now(), signup_path = 'first_time' where id = $1", [org1]);
  await q("app_admin", "insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values ($1,'p1','account_owner','active',true, now())", [org1]).catch(() => {});
  jobOn = (await one("app_portal", `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, application_route, status, salary_low, search_vector)
     values ($1,'employer',$2,'On-site','Acme','x','general', ${days(5)}, 'on_site', 'live', 1, to_tsvector('x')) returning id`, [org1, src])).id;
});
S("application", "insert as candidate (optional columns NULL), update withdraw", "app_candidate", async () => {
  const cr = (await one("app_candidate", "insert into candidate_consent_record(candidate_user_id, consent_text_id) values ('c1',$1) returning id", [ctApp])).id;
  appId = (await one("app_candidate", "insert into application(job_id, organisation_id, candidate_user_id, consent_record_id) values ($1,$2,'c1',$3) returning id", [jobOn, org1, cr])).id;
  await q("app_candidate", "insert into tracker_entry(candidate_user_id, job_id, route, origin, stage, application_id) values ('c1',$1,'on_site','on_site','applied',$2)", [jobOn, appId]);
});
S("move_application()", "recruiter moves the application; the candidate gets a notification written by the function", "app_portal", async () => {
  await q("app_portal", "select private.move_application($1,'viewed',$2)", [appId, await mem("p1")]);
  const n = (await ow.query("select count(*)::int n from notification where template_key = 'application_moved'")).rows[0];
  if (n.n < 1) throw new Error("no notification");
});
S("contact_request", "insert as the portal after the candidate becomes visible; notify trigger writes the candidate's notification", "app_portal", async () => {
  await q("app_candidate", "update candidate_profile set full_name = full_name where candidate_user_id = 'c1'");
  await q("app_candidate", "update candidate_profile set visible_to_employers = true, visible_fields = array['occupation_code'] where candidate_user_id = 'c1'");
  crq = (await one("app_portal", "insert into contact_request(organisation_id, membership_id, candidate_user_id) values ($1,$2,'c1') returning id", [org1, await mem("p1")])).id;
  const n = (await ow.query("select count(*)::int n from notification where template_key = 'contact_request_received'")).rows[0];
  if (n.n !== 1) throw new Error("no contact notification");
  await q("app_candidate", "update contact_request set status = 'accepted', answered_at = now(), consent_record_id = $2 where id = $1", [crq, (await one("app_candidate", "insert into candidate_consent_record(candidate_user_id, consent_text_id) values ('c1',$1) returning id", [ctApp])).id]);
});
S("message", "insert as candidate on the accepted request and as portal on the application", "app_candidate", async () => {
  await q("app_candidate", "insert into message(contact_request_id, sender_candidate_user_id, body) values ($1,'c1','hello')", [crq]);
  await q("app_portal", "insert into message(application_id, sender_membership_id, body) values ($1,$2,'reply')", [appId, await mem("p1")]);
});
S("candidate_hidden_organisation", "insert", "app_candidate", () => q("app_candidate", "insert into candidate_hidden_organisation(candidate_user_id, organisation_id) values ('c1',$1)", [org2]));
S("search_visible_candidates()", "call as the portal", "app_portal", () => q("app_portal", "select * from private.search_visible_candidates($1, '{}'::jsonb, null)", [org1]));
S("run_retention()", "application_and_cv: empties details, candidate id, consent link, tracker link, deletes the messages; returns CV keys", "app_admin", async () => {
  await ow.query("update job set status = 'closed', closed_at = now() - interval '13 months' where id = $1", [jobOn]);
  const r = (await one("app_admin", "select private.run_retention(1000) as r")).r;
  const a = await ow.query("select candidate_user_id, consent_record_id, cover_note from application where id = $1", [appId]);
  const t = await ow.query("select application_id from tracker_entry where application_id = $1", [appId]);
  const m = await ow.query("select count(*)::int n from message where application_id = $1", [appId]);
  if (r.rule !== "application_and_cv" || a.rows[0].candidate_user_id !== null || a.rows[0].consent_record_id !== null || t.rowCount !== 0 || m.rows[0].n !== 0) throw new Error(JSON.stringify({ r, a: a.rows, t: t.rowCount, m: m.rows }));
});
S("run_retention()", "application_record: the emptied row goes 36 months after the job closes", "app_admin", async () => {
  await ow.query("update job set closed_at = now() - interval '40 months' where id = $1", [jobOn]);
  let r, n = 0; do { r = (await one("app_admin", "select private.run_retention(1000) as r")).r; n++; } while (r.rule !== "application_record" && r.rule !== null && n < 60);
  const a = await ow.query("select count(*)::int n from application where id = $1", [appId]);
  if (r.rule !== "application_record" || a.rows[0].n !== 0) throw new Error(JSON.stringify(r));
});


