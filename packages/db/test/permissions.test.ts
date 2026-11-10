/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Ported from schema-trial-2/11-permissions.mjs: what each role must not do and must be able to do, on all tables, views and
// private functions. One `it` per trial check, same names (prefixed with the trial's group, "must" or "must not").
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import { createTestDb, TEMPLATE, tx as txPool, urlFor } from "./db";
import { fixtures, in30 } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// The lists of tables, views and functions come from the template database, read once while the tests are being listed.
const cat = new pg.Client({ connectionString: urlFor(TEMPLATE) });
await cat.connect();
const tables = (await cat.query("select tablename from pg_tables where schemaname='public' order by 1")).rows.map((x) => x.tablename);
const views = (await cat.query("select viewname from pg_views where schemaname='public' order by 1")).rows.map((x) => x.viewname);
const fns = (await cat.query("select p.oid::regprocedure::text f, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.prorettype <> 'trigger'::regtype order by 1")).rows;
await cat.end();

let db, P, su, id, ins, F;
let src, org, pu, mem, s1, cand, ct, cons, job;
beforeAll(async () => {
  db = await createTestDb();
  ({ P, su, id, ins, F } = fixtures(db));
  src = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
  org = await F.org(); pu = await F.portal(); mem = await F.member(org, pu, { role: "account_owner", signer: true }); s1 = await F.staff(); await F.staff();
  cand = await F.cand(); ct = await F.text("services_request"); cons = await ins("postgres", "consent_record", { candidate_user_id: cand, consent_text_id: ct });
  job = await ins("postgres", "job", { organisation_id: org, source: "employer", job_source_id: src, title: "t", employer_name: "e", sector: "it", permit_type: "critical_skills", status: "live", closes_at: in30(), own_page_url: "u", salary_low: 40000, search_vector: "'x':1" });
  await ins("postgres", "job_text", { job_id: job, advert_text: "fake advert" }, null);
});
afterAll(() => db.drop());
const roles = ["app_candidate", "app_portal", "app_admin", "app_fetcher"];
const P_ = (role) => db.pool(role);
const denied = (role, name, sql, a) => it(`must not: ${role}: ${name}`, async () => {
  const r = await P_(role).query(sql, a ? a() : undefined).then((r) => `was allowed, ${r.rowCount ?? 0} rows`, (e) => e);
  expect(typeof r === "string" ? r : r.code, typeof r === "string" ? r : `${r.code} ${r.message}`).toBe("42501");
});
const allowed = (role, name, sql, a) => it(`must: ${role}: ${name}`, async () => { await P_(role).query(sql, a ? a() : undefined); });

// ---- must not
for (const t of ["candidate_user","candidate_account","candidate_session","candidate_verification","candidate_rate_limit","candidate_profile","candidate_cv","saved_job","tracker_entry","apply_click","alert"]) denied("app_portal", `read ${t}`, `select * from ${t} limit 1`);
for (const t of ["staff_user","staff_account","staff_session","staff_verification","staff_rate_limit","staff_role","approval_request","audit_event","report","case_note","review_item","email_outbox","setting","organisation_domain","ban","contact_message","consent_record","services_case","case_document","notification","notification_preference","content_page","fetched_advert","fetch_run"]) denied("app_portal", `read ${t}`, `select * from ${t} limit 1`);
for (const v of views.filter((v) => v.startsWith("candidate_"))) denied("app_portal", `read view ${v}`, `select * from ${v} limit 1`);
for (const t of ["staff_user","staff_account","staff_session","staff_verification","staff_rate_limit","staff_role","approval_request","audit_event","membership","portal_user","portal_account","portal_session","portal_verification","portal_rate_limit","report","strike","ban","case_note","case_quote","review_item","email_outbox","organisation_domain","sponsorship_statement","pay_floor","fetched_advert","fetch_run","cro_company","wrc_licence","setting","content_page","services_case","case_document","consent_record","notification","notification_preference","contact_message"]) denied("app_candidate", `read ${t}`, `select * from ${t} limit 1`);
for (const v of views.filter((v) => v.startsWith("portal_"))) denied("app_candidate", `read view ${v}`, `select * from ${v} limit 1`);
for (const c of ["is_big_company","cro_number","member_limit","restricted_until","signup_path","verified_at"]) denied("app_candidate", `read organisation.${c}`, `select ${c} from organisation limit 1`);
for (const c of ["hire_answer","close_reason","posted_by_membership_id","posted_by_staff_id","hidden_reason","hidden_report_id","fetched_advert_id","pay_floor_id","permit_employer_name_id","screening_questions"]) denied("app_candidate", `read job.${c}`, `select ${c} from job limit 1`);
for (const c of ["fetched_advert_id","quota_full","permit_history","posted_by_staff_id","hidden_reason","hidden_report_id"]) denied("app_portal", `read or write job.${c}`, `update job set ${c}=${c} where false`);
denied("app_candidate", "write a job", "update job set title='x' where id=$1", () => [job]);
denied("app_candidate", "write advert text", "update job_text set advert_text='x' where job_id=$1", () => [job]);
denied("app_candidate", "set its own visibility before the licence", "update candidate_profile set visible_to_employers=true where false");
denied("app_candidate", "set inactive_warned_at", "update candidate_user set inactive_warned_at=null where false");
denied("app_candidate", "delete a candidate_user row (erasure is a function)", "delete from candidate_user where false");
denied("app_candidate", "write job_daily_stat other columns: delete", "delete from job_daily_stat where false");
for (const t of ["candidate_user","candidate_account","candidate_profile","candidate_cv","portal_user","portal_account","staff_user","staff_account","membership","consent_record","services_case","case_document","notification","email_outbox","saved_job","tracker_entry","alert","report","strike","ban","audit_event","approval_request","contact_message","setting","case_quote","sponsorship_statement","organisation_domain"]) denied("app_fetcher", `read ${t}`, `select * from ${t} limit 1`);
denied("app_fetcher", "read signer names on pay floors", "select signer_name from pay_floor limit 1");
denied("app_fetcher", "delete fetched adverts (retention is a function)", "delete from fetched_advert where false");
for (const t of ["candidate_account","portal_account","candidate_verification","portal_verification","candidate_rate_limit","portal_rate_limit"]) denied("app_admin", `read ${t} (password hashes and tokens)`, `select * from ${t} limit 1`);
for (const t of ["candidate_session","portal_session"]) denied("app_admin", `read ${t}.token`, `select token from ${t} limit 1`);
denied("app_admin", "change a candidate's email", "update candidate_user set email='x@example.test' where id=$1", () => [cand]);
denied("app_admin", "delete a candidate_user row directly", "delete from candidate_user where false");
denied("app_admin", "set seeded_by_owner", "insert into staff_role(staff_user_id, role, seeded_by_owner) values($1,'content_editor',true)", () => [s1]);
denied("app_admin", "update or delete a staff role in place (only insert and delete)", "update staff_role set role='administrator' where false");
denied("app_admin", "update consent_record (bare proof is a function)", "update consent_record set details=null where false");
denied("app_admin", "delete approval_request (retention is a function)", "delete from approval_request where false");
denied("app_admin", "update signer_name on statements", "update sponsorship_statement set signer_name='x' where false");
// Trial-3 grant change (04-grants.sql in schema-trial-3): app_admin may update fetched_advert.result, so the trial-2 check "must not" is now a "must" (see the must list). See HANDOVER-4b-tests-1.

// Trial-3 grant change: app_admin may insert case_document (staff upload copies), so this moved to the must list as a column-privilege check.
for (const r of roles) {
  denied(r, "update audit_event", "update audit_event set action='x'"); denied(r, "delete audit_event", "delete from audit_event"); denied(r, "truncate audit_event", "truncate audit_event");
  denied(r, "write feature_flag", "update feature_flag set enabled=true"); denied(r, "create a table", "create table hack(id int)"); denied(r, "create a function in private", "create function private.hack() returns int language sql as 'select 1'");
  denied(r, "update or delete a consent text", "update consent_text set body='x'");
  for (const t of ["application","contact_request","message","candidate_hidden_organisation"]) { denied(r, `read Launch B ${t}`, `select * from ${t} limit 1`); denied(r, `delete Launch B ${t}`, `delete from ${t}`); } }
denied("app_candidate", "insert a Launch B application", "insert into application(candidate_user_id,job_id,organisation_id,consent_record_id) values($1,$2,$3,$4)", () => [cand, job, org, cons]);
denied("app_portal", "insert a Launch B contact_request", "insert into contact_request(organisation_id,membership_id,candidate_user_id) values($1,$2,$3)", () => [org, mem, cand]);
// execute: exactly as section 2.1
const want = { erase_candidate: ["app_admin"], erase_portal_user: ["app_admin"], run_retention: ["app_admin"], claim_organisation: ["app_portal"], register_organisation: ["app_portal"], audit_pseudonymise: [], audit_purge: [], move_application: [], search_visible_candidates: [], use_approval: [] };
for (const f of fns) for (const r of [...roles, "anon", "authenticated", "service_role"]) {
  const exp = (want[f.proname] || []).includes(r);
  it(`${exp ? "must" : "must not"}: ${r}: execute ${f.f}`, async () => {
    const has = (await su("select has_function_privilege($1, $2, 'execute') h", [r, f.f])).rows[0].h;
    expect(has, `has ${has}, design ${exp}`).toBe(exp);
  });
}
for (const r of ["app_candidate", "app_fetcher"]) denied(r, "call a private function (no usage on schema private)", "select private.audit_purge()");
denied("app_admin", "run audit_purge", "select private.audit_purge()");
denied("app_admin", "run audit_pseudonymise", "select private.audit_pseudonymise('x')");
denied("app_portal", "run move_application before the licence", "select private.move_application(1,'viewed',1)");
// anon, authenticated and service_role: every table, view and function
it(`must not: anon, authenticated and service_role reach none of ${tables.length} tables, ${views.length} views and ${fns.length} private functions`, async () => {
  const open = [];
  for (const role of ["anon", "authenticated", "service_role"]) { const cl = await P.postgres.connect(); try { await cl.query(`set role ${role}`);
    for (const t of [...tables, ...views]) { await cl.query(`select * from ${t} limit 1`).then(() => open.push(`${role}:${t}`), () => {}); await cl.query(`insert into ${t} default values`).then(() => open.push(`${role}:insert ${t}`), () => {}); }
    for (const f of fns) await cl.query(`select private.${f.proname}()`).then(() => open.push(`${role}:call ${f.f}`), () => {});
    for (const f of fns) if ((await su("select has_function_privilege($1, $2::regprocedure, 'execute') h", [role, f.f])).rows[0].h) open.push(`${role}:${f.f}`);
    if ((await cl.query("select has_schema_privilege(current_user, 'private', 'usage') u")).rows[0].u) open.push(`${role}:usage private`);
  } finally { await cl.query("reset role"); cl.release(); } }
  expect(open.join(", ") || "nothing").toBe("nothing");
});
it("must not: anon can execute no function in public (pg_trgm's functions, owned by the superuser, keep PUBLIC execute)", async () => {
  const ext = (await su("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute')")).rows[0].n;
  expect(ext, `${ext} functions in public executable by anon`).toBe(0);
});

// ---- must do, from the Access lines
const must = [
  ["app_candidate", "read public job columns", "select id,title,employer_name,county,salary_low,salary_high,pass_route,pay_grade,badge,quota_full,posted_at,job_source_id from job limit 1"],
  ["app_candidate", "filter on search_vector", "select id from job where search_vector @@ 'x'::tsquery limit 1"],
  ["app_candidate", "read advert text", "select advert_text from job_text limit 1"],
  ["app_candidate", "read job sources", "select id,last_ok_at from job_source limit 1"],
  ["app_candidate", "read public organisation columns", "select id,slug,display_name,website,logo_url,short_description,county,nace_code,kind,status,permit_history,claimed_at,claims_removed_at,wrc_licence_number,merged_into_id from organisation limit 1"],
  ["app_candidate", "read organisation names and DETE counts", "select n.name, d.permits from organisation_name n left join dete_permit_count d on d.organisation_name_id=n.id limit 1"],
  ["app_candidate", "read consent texts", "select body from consent_text limit 1"],
  ["app_candidate", "read published content", "select title from published_content_page limit 1"],
  ["app_candidate", "save a job", "insert into saved_job(candidate_user_id,job_id) values($1,$2) on conflict do nothing", () => [cand, job]],
  ["app_candidate", "write a profile by column list", "insert into candidate_profile(candidate_user_id,full_name,occupation_code) values($1,'Fake','2231') on conflict (candidate_user_id) do update set full_name=excluded.full_name", () => [cand]],
  ["app_candidate", "write an alert", "insert into alert(candidate_user_id,frequency,unsubscribe_token) values($1,'daily',$2)", () => [cand, id("t")]],
  ["app_candidate", "file a report", "insert into report(target_kind,target_job_id,reason,reporter_candidate_user_id) values('job',$1,'other',$2) returning id", () => [job, cand]],
  ["app_candidate", "give consent through its view", "insert into candidate_consent_record(candidate_user_id,consent_text_id) values($1,$2) returning id", () => [cand, ct]],
  ["app_candidate", "request services through its view", "insert into candidate_services_case(candidate_user_id,consent_record_id,permit_type) values($1,$2,'critical_skills') returning id", () => [cand, cons]],
  ["app_candidate", "read its cases through its view", "select id,status from candidate_services_case where candidate_user_id=$1", () => [cand]],
  ["app_candidate", "write the audit log", "insert into audit_event(kind,action,actor_candidate_user_id) values('security','signin_failed',$1)", () => [cand]],
  ["app_candidate", "queue an email", "insert into email_outbox(template,candidate_user_id,dedupe_key) values('t',$1,$2) on conflict (dedupe_key) do nothing", () => [cand, id("dk")]],
  // Trial-3 grant change: only app_admin and app_fetcher insert into notification; the candidate writes its own side through the view.
  ["app_candidate", "write a notice for itself", "insert into candidate_notification(candidate_user_id,category,template_key,dedupe_key) values($1,'a','t',$2) on conflict (dedupe_key) do nothing", () => [cand, id("dk")]],
  ["app_candidate", "send a contact form message", "insert into contact_message(surface,candidate_user_id,from_email,topic,body) values('candidate_site',$1,'x@example.test','general','hi') returning id", () => [cand]],
  ["app_candidate", "count a view", "insert into job_daily_stat(job_id,day,views) values($1,current_date,1) on conflict (job_id,day) do update set views=job_daily_stat.views+1", () => [job]],
  ["app_candidate", "read feature flags", "select key, enabled from feature_flag"],
  ["app_candidate", "set deleted_at and last_active_at on itself", "update candidate_user set deleted_at=null, last_active_at=now() where id=$1", () => [cand]],
  ["app_portal", "post a job", "insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,posted_by_membership_id) values($1,'employer',$2,'t','e','it','general','draft',now()+interval '20 days','u',$3) returning id", () => [org, src, mem]],
  ["app_portal", "write advert text", "insert into job_text(job_id,advert_text) values($1,'text') on conflict (job_id) do update set advert_text=excluded.advert_text", () => [job]],
  ["app_portal", "read its jobs' stats", "select views from job_daily_stat limit 1"],
  ["app_portal", "manage its team", "update membership set is_signer=true where id=$1", () => [mem]],
  ["app_portal", "edit its company profile", "update organisation set website='https://example.test' where id=$1", () => [org]],
  ["app_portal", "read names, the CRO register and the WRC register for sign-up", "select (select count(*) from organisation_name where normalised_name operator(extensions.%) 'fake'), (select count(*) from cro_company), (select count(*) from wrc_licence)"],
  ["app_portal", "claim or register through the functions", "select has_function_privilege('private.claim_organisation(text,bigint)','execute') and has_function_privilege('private.register_organisation(text,text,text,text,text)','execute')"],
  ["app_portal", "read its strikes without the reporter", "select id, reason_code, notice_summary, stage from strike limit 1"],
  ["app_portal", "read quotes without the staff id", "select id, amount_eur, status from case_quote limit 1"],
  ["app_portal", "sign a sponsorship statement", "select 1 from sponsorship_statement limit 1"],
  ["app_portal", "file a report", "insert into report(target_kind,target_job_id,reason,reporter_portal_user_id) values('job',$1,'other',$2) returning id", () => [job, pu]],
  ["app_portal", "read its notices through its view", "select id from portal_notification limit 1"],
  ["app_portal", "give consent through its view", "insert into portal_consent_record(portal_user_id,consent_text_id) values($1,$2) returning id", () => [pu, ct]],
  ["app_portal", "read published content", "select title from published_content_page limit 1"],
  ["app_fetcher", "write fetched adverts", "insert into fetched_advert(job_source_id,external_id,result) values($1,$2,'rejected')", () => [src, id("x")]],
  ["app_fetcher", "add an unclaimed organisation", "insert into organisation(slug,display_name,kind,county) values($1,'New','employer','Dublin')", () => [id("o")]],
  ["app_fetcher", "add an organisation name", "insert into organisation_name(name,normalised_name,kind,source) values($1,$1,'alias','job_site')", () => [id("n")]],
  ["app_fetcher", "write a fetched job, linked to its advert at insert", "insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,own_page_url,closes_at,search_vector,badge) values($1,'fetched',$2,'t','e','it','critical_skills','live','u','infinity','''x'':1','critical_skills_eligible')", () => [org, src]],
  ["app_fetcher", "log a run and update last_ok_at", "with r as (insert into fetch_run(job_source_id) values($1) returning id) update job_source set last_ok_at=now() where id=$1", () => [src]],
  ["app_fetcher", "refresh the CRO register", "insert into cro_company(cro_number,name,normalised_name,status,last_seen_on) values($1,'X','x','Normal',current_date) on conflict (cro_number) do update set last_seen_on=excluded.last_seen_on", () => [id("cro")]],
  ["app_fetcher", "read the floor columns it needs", "select id, organisation_id, role_family, floor_eur, valid_until, status from pay_floor limit 1"],
  ["app_admin", "set suspended_at and end sessions", "with u as (update candidate_user set suspended_at=null where id=$1 returning id) delete from candidate_session where user_id in (select id from u)", () => [cand]],
  ["app_admin", "block a portal user and end sessions", "with u as (update portal_user set status='active' where id=$1 returning id) delete from portal_session where user_id in (select id from u)", () => [pu]],
  ["app_admin", "read staff logins", "select * from staff_account limit 1"],
  ["app_admin", "read the audit log", "select * from audit_event limit 1"],
  ["app_admin", "read consent records", "select * from consent_record limit 1"],
  ["app_admin", "work the case board", "select * from services_case where status <> 'closed' order by status, created_at, id limit 21"],
  ["app_admin", "update fetched_advert result (rejecting a queued advert; was a must-not in trial 2)", "update fetched_advert set result='rejected' where false"],
  ["app_admin", "insert a case_document (staff uploads; was a must-not in trial 2)", "select has_column_privilege('app_admin','case_document','storage_key','insert') and has_column_privilege('app_admin','case_document','staff_user_id','insert') as ok"],
  ["app_admin", "insert a content page", "insert into content_page(kind,slug,title,body) values('help',$1,'t','b')", () => [id("s")]],
  ["app_admin", "run erase_candidate, erase_portal_user and run_retention", "select has_function_privilege('private.erase_candidate(text,boolean)','execute') and has_function_privilege('private.erase_portal_user(text,boolean)','execute') and has_function_privilege('private.run_retention(integer)','execute')"],
  ["app_admin", "delete a rejected queued job and its text", "delete from job where false"],
];
for (const [r, n, sql, a] of must) allowed(r, n, sql, a);
// fixture change (0004, M2): a setting value change needs an acting staff id and a confirmed setting request for that value
it("must: app_admin: change a retention setting", async () => {
  const a = await F.staff(), b = await F.staff();
  await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values($1,'administrator',true),($2,'administrator',true)", [a, b]);
  const as = (who, sql, args) => txPool(db.pool("app_admin"), async (c) => { await c.query("select set_config('app.staff_user_id', $1, true)", [who]); return c.query(sql, args); });
  const r = (await as(a, "insert into approval_request(kind,target_table,target_id,change) values('setting','setting','apply_click','{\"value\":14}') returning id")).rows[0].id;
  await as(b, "update approval_request set status='confirmed' where id=$1", [r]);
  await as(a, "update setting set value=14 where key='apply_click'");
});
// Trial-3 grant change: the proposer is stamped by the trigger from the acting staff id, not written by the caller.
it("must: app_admin: propose an approval", async () => {
  await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values($1,'administrator',true)", [s1]); // the acting person must hold a role
  await txPool(db.pool("app_admin"), async (c) => {
    await c.query("select set_config('app.staff_user_id', $1, true)", [s1]);
    await c.query("insert into approval_request(kind,target_table,target_id) values('threshold','setting',$1)", [id("t")]);
  });
});
// ---- by design: own-row limits are code only (#124). The trial listed these as notes, not pass or fail; they only have to run.
const reach = (role, name, sql, a) => it(`code only, by design: ${role}: ${name}`, async () => { await P[role].query(sql, a ? a() : undefined).catch((e) => e.code); });
reach("app_candidate", "read every candidate's email", "select count(*)::int n from candidate_user");
reach("app_portal", "overwrite another company's job", "update job set title=title where organisation_id <> $1 returning id", () => [org]);
reach("app_portal", "read every company's membership list", "select count(*)::int n from membership");
reach("app_admin", "read every profile with no logged reason", "select count(*)::int n from candidate_profile");

