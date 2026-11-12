/* eslint-disable */
// @ts-nocheck
// Ported from schema-trial-2/08-retest.mjs, close to as written. One `it` per trial check, same names.
import { afterAll } from "vitest";
import { createTestDb, urlFor } from "./db";
import pg from "pg";
import { setup, in30, daysAgo } from "./trial-compat";
import { known } from "./retest-known";

const db = await createTestDb();
afterAll(() => db.drop());
const url = (role) => urlFor(db.name, role);
const { P, su, id, R, line, rule, ins, race, tx, F, blk } = setup(db, known);
const fs = { writeFileSync() {} };
// Retest of the first trial's failures with the same attempts, plus erasure, retention and leak checks at Launch A.
const rec = (group, name, pass, detail = "") => line(group, name, pass === null ? null : pass, pass === null ? null : true, detail);
const sv = "'fake':1";
const src = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
const s1 = await F.staff(), s2 = await F.staff();
const org = await F.org(), pu = await F.portal(), mem = await F.member(org, pu, { role: "account_owner", signer: true });
const LJ = (o = {}) => ({ organisation_id: org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org", sector: "it", permit_type: "critical_skills", status: "live", closes_at: in30(), own_page_url: "https://example.test/a", salary_low: 40000, search_vector: sv, ...o });
const live = (o) => ins("postgres", "job", LJ(o));
const appr = (kind, table, target, o = {}) => F.approval(kind, table, target, { by: s1, confirmer: s2, ...o });
const count = async (sql, a) => (await su(`select count(*)::int n from ${sql}`, a)).rows[0].n;

// ---- 3. the portal reading candidate rows through every path
await blk("{ const c = await F.cand(), ct = await F.text(\"services_request\"), cr ", async () => {
{ const c = await F.cand(), ct = await F.text("services_request"), cr = await ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: ct, details: { note: "fake" } });
  const sc = await ins("postgres", "services_case", { candidate_user_id: c, consent_record_id: cr, permit_type: "critical_skills" });
  await ins("postgres", "case_document", { services_case_id: sc, storage_key: "k/passport-copy.pdf", file_name: "passport-copy.pdf", candidate_user_id: c });
  await ins("postgres", "notification", { candidate_user_id: c, category: "c", template_key: "t", params: { note: "fake" }, dedupe_key: id("dk") });
  await ins("postgres", "notification_preference", { candidate_user_id: c, category: "alerts", channel: "email", enabled: false });
  for (const t of ["services_case", "case_document", "consent_record", "notification", "notification_preference"]) {
    const r = await P.app_portal.query(`select * from ${t} limit 1`).then((x) => `allowed, ${x.rowCount} rows`, (e) => e.code);
    rec("3 portal reads candidates", `app_portal: select * from table ${t}`, r === "42501", r); }
  for (const t of ["services_case", "case_document", "consent_record", "notification", "notification_preference"]) {
    const v = await P.app_portal.query(`select count(*)::int n from portal_${t} where candidate_user_id is not null`).then((x) => x.rows[0].n, (e) => e.code);
    rec("3 portal reads candidates", `app_portal: candidate rows through view portal_${t}`, v === 0, `${v} candidate rows`);
    const w = await P.app_portal.query(`select * from candidate_${t} limit 1`).then((x) => `allowed, ${x.rowCount}`, (e) => e.code);
    rec("3 portal reads candidates", `app_portal: the candidate view candidate_${t}`, w === "42501", w); }
  const dk = await P.app_portal.query("select count(*)::int n, count(dedupe_key)::int k from notification").then((x) => x.rows[0], (e) => e.code);
  rec("3 portal reads candidates", "app_portal on notification: only dedupe_key is readable, so the person, params and read_at stay hidden", (await P.app_portal.query("select params from notification limit 1").then(() => "allowed", (e) => e.code)) === "42501", `but count(*) and every dedupe_key across both sides are readable: ${JSON.stringify(dk)}`);
  const wr = await P.app_portal.query("insert into notification(candidate_user_id,category,template_key,dedupe_key) values($1,'c','fake-from-portal',$2)", [c, id("dk")]).then(() => "accepted", (e) => e.message);
  rec("3 portal reads candidates", "app_portal cannot write a row into a candidate's notifications (section 2 says no rights on the table)", wr !== "accepted", `${wr}: the notification Access line gives all four roles insert on the table itself`);
  const wv = await P.app_portal.query("insert into portal_case_document(services_case_id,storage_key,portal_user_id,candidate_user_id) values($1,'k',$2,$3)", [sc, pu, c]).then(() => "accepted", (e) => `${e.code} ${e.message}`);
  rec("3 portal reads candidates", "app_portal cannot write a candidate-side row through its view", wv !== "accepted", wv);
  const wv2 = await P.app_portal.query("insert into portal_consent_record(candidate_user_id,consent_text_id) values($1,$2)", [c, ct]).then(() => "accepted", (e) => `${e.code} ${e.message}`);
  rec("3 portal reads candidates", "app_portal cannot write a consent for a candidate through its view (check option)", wv2 !== "accepted", wv2);
  const wv3 = await P.app_candidate.query("insert into candidate_case_document(services_case_id,storage_key,candidate_user_id) values($1,'k2',$2) returning id", [sc, c]).then(() => "accepted", (e) => e.message);
  rec("3 portal reads candidates", "writes through the views work: app_candidate adds a document to its case and reads its id back", wv3 === "accepted", wv3);
  const vu = await P.app_candidate.query("update candidate_notification set read_at=now() where candidate_user_id=$1", [c]).then((x) => `${x.rowCount} row`, (e) => e.message);
  rec("3 portal reads candidates", "writes through the views work: app_candidate marks its notices read", /^[12] row/.test(vu), `${vu} (the second is the notice app_portal wrote above)`);
  const vp = await P.app_candidate.query("insert into candidate_notification_preference(candidate_user_id,category,channel,enabled) values($1,'jobs','in_app',true) on conflict do nothing", [c]).then(() => "ok", (e) => e.message);
  rec("3 portal reads candidates", "writes through the views: app_candidate saves a preference with ON CONFLICT through its view", vp === "ok", vp);
  const vo = await P.app_portal.query("insert into portal_notification(portal_user_id,category,template_key,dedupe_key) values($1,'c','t',$2)", [pu, id("dk")]).then(() => "ok", (e) => `${e.code} ${e.message}`);
  rec("3 portal reads candidates", "app_portal inserts its own notice through portal_notification", vo === "ok" ? true : null, vo === "ok" ? "ok" : `${vo} (only select and update(read_at) are granted on the view; inserts go to the table)`); }
});

// ---- 4 and 9. apps changing what they should only ask for: trust columns
await blk("{ const o = await F.org(), j = await ins(\"app_portal\", \"job\", { organi", async () => {
{ const o = await F.org(), om = await F.member(o, await F.portal(), { role: "poster" }), j = await ins("app_portal", "job", { organisation_id: o, posted_by_membership_id: om, source: "employer", job_source_id: src, title: "t", employer_name: "e", sector: "it", permit_type: "general", status: "draft", closes_at: in30(), own_page_url: "u" });
  for (const [what, sql] of [["organisation status", "update organisation set status='verified' where id=$1"], ["is_big_company", "update organisation set is_big_company=true where id=$1"],
      ["restricted_until", "update organisation set restricted_until=null where id=$1"], ["organisation permit_history", "update organisation set permit_history='has_history' where id=$1"],
      ["claims_removed_at", "update organisation set claims_removed_at=null where id=$1"], ["cro_number", "update organisation set cro_number='123' where id=$1"]])
    rec("4 trust columns", `app_portal cannot write ${what}`, (await P.app_portal.query(sql, [o]).then(() => "allowed", (e) => e.code)) === "42501");
  for (const [what, sql] of [["job hidden_reason", "update job set hidden_reason='admin' where id=$1"], ["job quota_full", "update job set quota_full=true where id=$1"], ["job permit_history", "update job set permit_history='has_history' where id=$1"],
      ["job fetched_advert_id", "update job set fetched_advert_id=null where id=$1"], ["job posted_by_staff_id", "update job set posted_by_staff_id=null where id=$1"]])
    rec("4 trust columns", `app_portal cannot write ${what}`, (await P.app_portal.query(sql, [j]).then(() => "allowed", (e) => e.code)) === "42501");
  const fj = await ins("app_fetcher", "job", { organisation_id: o, source: "fetched", job_source_id: src, title: "t", employer_name: "e", sector: "it", permit_type: "critical_skills", status: "live", closes_at: "infinity", own_page_url: "u", search_vector: sv, badge: "critical_skills_eligible" });
  for (const [what, sql, a] of [["job hidden_reason", "update job set hidden_reason='admin' where id=$1", [fj]], ["job quota_full", "update job set quota_full=true where id=$1", [fj]], ["job permit_history", "update job set permit_history='has_history' where id=$1", [fj]],
      ["organisation status", "update organisation set status='verified' where id=$1", [o]], ["is_big_company", "update organisation set is_big_company=true where id=$1", [o]], ["an organisation with status verified", "insert into organisation(slug,display_name,kind,status) values($1,'x','employer','verified')", [id("o")]]])
    rec("4 trust columns", `app_fetcher cannot write ${what}`, (await P.app_fetcher.query(sql, a).then(() => "allowed", (e) => e.code)) === "42501");
  const sb = await P.app_fetcher.query("update job set badge='sponsor_confirmed' where id=$1", [fj]).then(() => "allowed", (e) => e.message);
  rec("4 trust columns", "app_fetcher cannot set the sponsor_confirmed badge", sb !== "allowed", sb);
  const c = await F.cand();
  rec("4 trust columns", "app_candidate cannot set or clear its own suspended_at", (await P.app_candidate.query("update candidate_user set suspended_at=null where id=$1", [c]).then(() => "allowed", (e) => e.code)) === "42501");
  rec("4 trust columns", "app_portal cannot unblock a portal user (status)", (await P.app_portal.query("update portal_user set status='active' where id=$1", [pu]).then(() => "allowed", (e) => e.code)) === "42501"); }
});

// ---- 10. insert-only rights and normal code
await blk("{ const c = await F.cand(), j = await live(), dk = id(\"dk\"); const p", async () => {
{ const c = await F.cand(), j = await live(), dk = id("dk");
  const pat = async (name, pool, sql, a) => rec("10 normal code", `${pool}: ${name}`, await P[pool].query(sql, a).then(() => true, (e) => false), "");
  await pat("one action, one email: ON CONFLICT (dedupe_key) DO NOTHING, twice", "app_candidate", "insert into email_outbox(template,candidate_user_id,dedupe_key) values('t',$1,$2),('t',$1,$2) on conflict (dedupe_key) do nothing", [c, dk]).catch(() => {});
  await pat("one action, one email: the second try quietly does nothing", "app_candidate", "insert into email_outbox(template,candidate_user_id,dedupe_key) values('t',$1,$2) on conflict (dedupe_key) do nothing", [c, id("dk")]);
  await pat("queue a scam_flag item: ON CONFLICT ON the partial unique index DO NOTHING", "app_fetcher", "insert into review_item(queue,job_id) values('scam_flag',$1) on conflict (queue, job_id) where status in ('open','claimed') do nothing", [j]);
  await pat("queue it again: nothing happens, no error", "app_fetcher", "insert into review_item(queue,job_id) values('scam_flag',$1) on conflict (queue, job_id) where status in ('open','claimed') do nothing", [j]);
  await pat("insert a report and read back its id (RETURNING id)", "app_candidate", "insert into report(target_kind,target_job_id,reason,reporter_candidate_user_id) values('job',$1,'other',$2) returning id", [j, c]);
  await pat("count a job view: upsert", "app_candidate", "insert into job_daily_stat(job_id,day,views) values($1,current_date,1) on conflict (job_id,day) do update set views=job_daily_stat.views+1", [j]);
  await pat("count it again", "app_candidate", "insert into job_daily_stat(job_id,day,views) values($1,current_date,1) on conflict (job_id,day) do update set views=job_daily_stat.views+1", [j]);
  await pat("contact form: insert and read back the id", "app_candidate", "insert into contact_message(surface,candidate_user_id,from_email,topic,body) values('candidate_site',$1,'x@example.test','general','hello') returning id", [c]);
  /* ported change: app_portal writes notices through the portal_notification view (it has no grant on the table) */
  await pat("one notice: ON CONFLICT (dedupe_key) DO NOTHING", "app_portal", "insert into portal_notification(portal_user_id,category,template_key,dedupe_key) values($1,'a','t',$2) on conflict (dedupe_key) do nothing", [pu, id("dk")]); }
});

// ---- 6. a fetched job with closes_at = 'infinity' appears in search and browse, and stays out of the job-life sweep
await blk("{ const o = await F.org(), fj = await ins(\"postgres\", \"job\", { organis", async () => {
{ const o = await F.org(), fj = await ins("postgres", "job", { organisation_id: o, source: "fetched", job_source_id: src, title: "Infinity test nurse", employer_name: "Fake Hospital", sector: "health", permit_type: "critical_skills", status: "live", closes_at: "infinity", own_page_url: "u", search_vector: "'infinitytest':1 'nurs':2", badge: "critical_skills_eligible" });
  const s = await P.app_candidate.query(`with hits as materialized (select id, (not quota_full) as r, salary_sort as k from job where status='live' and closes_at > now() and search_vector @@ websearch_to_tsquery('english','infinitytest')),
    page as (select id, r, k from hits order by r desc, k desc, id desc limit 21)
    select job.id, (select count(*) from (select 1 from hits limit 201) c) as capped from page join job on job.id=page.id order by page.r desc, page.k desc, page.id desc`);
  rec("6 closes_at infinity", "a live fetched job with closes_at = 'infinity' appears in the design's search query, as app_candidate", s.rows.some((r) => Number(r.id) === Number(fj)), `${s.rowCount} row, capped count ${s.rows[0]?.capped}`);
  const b = await P.app_candidate.query(`with hits as materialized (select id, (not quota_full) as r, posted_at as k from job where status='live' and closes_at > now() and sector='health' order by (not quota_full) desc, posted_at desc, id desc limit 201)
    select job.id from (select id, r, k from hits order by r desc, k desc, id desc limit 21) page join job on job.id=page.id`);
  rec("6 closes_at infinity", "and in the browse query by sector", b.rows.some((r) => Number(r.id) === Number(fj)), `${b.rowCount} rows`);
  const sweep = await count("job where status in ('live','under_review') and closes_at < 'infinity' and id=$1", [fj]);
  rec("6 closes_at infinity", "the job-life scheduler's index condition (closes_at < 'infinity') leaves it out", sweep === 0, `${sweep}`); }
});

// ---- 18. the employer sees why it got a strike, never the reporter
await blk("{ const j = await live(), r = await ins(\"postgres\", \"report\", { target", async () => {
{ const j = await live(), r = await ins("postgres", "report", { target_kind: "job", target_job_id: j, reason: "no_sponsorship", evidence_text: "Fake evidence naming the reporter" });
  const k = await ins("postgres", "strike", { organisation_id: org, case_kind: "false_claim", job_id: j, report_id: r, reason_code: "false_sponsorship", notice_summary: "The advert said sponsorship, the employer refused it.", decided_by_staff_user_id: s1 });
  const ok = await P.app_portal.query("select id, job_id, reason_code, notice_summary, stage, reply_due_at, outcome from strike where id=$1", [k]).then(() => "allowed", (e) => e.code);
  rec("18 strike reason", "app_portal reads its own case only through private.status_page (0017), never the table", ok === "42501", ok);
  for (const col of ["report_id", "approval_request_id", "decided_by_staff_user_id", "appeal_decided_by_staff_user_id"])
    rec("18 strike reason", `app_portal cannot read strike.${col}`, (await P.app_portal.query(`select ${col} from strike limit 1`).then(() => "allowed", (e) => e.code)) === "42501");
  rec("18 strike reason", "app_portal cannot read report (the reporter)", (await P.app_portal.query("select * from report limit 1").then(() => "allowed", (e) => e.code)) === "42501"); }
});

// ---- 2 and 14. erase_candidate and erase_portal_user (Launch A rows; Launch B rows are in 09-launch-b.mjs)
async function fullCandidate() {
  const c = await F.cand(), email = (await su("select email from candidate_user where id=$1", [c])).rows[0].email, [j1, j2, j3] = [await live(), await live(), await live()];
  const ct = await F.text("services_request"), cr = await ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: ct, job_id: j1, organisation_id: org, details: { shared: ["cv"] } });
  await ins("postgres", "candidate_profile", { candidate_user_id: c, full_name: "Fake Name", phone: "+353000000" });
  await ins("postgres", "candidate_cv", { candidate_user_id: c, storage_key: `cv/${c}.pdf`, file_name: "my-cv.pdf", content_type: "pdf", size_bytes: 100 });
  await ins("postgres", "saved_job", { candidate_user_id: c, job_id: j1 }); await ins("postgres", "saved_job", { candidate_user_id: c, job_id: j2 });
  await ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j1, route: "redirect", origin: "mark_applied", stage: "applied" });
  await ins("postgres", "apply_click", { candidate_user_id: c, job_id: j3 });
  await ins("postgres", "alert", { candidate_user_id: c, frequency: "daily", unsubscribe_token: id("t"), search_text: "nurse" });
  const sc = await ins("postgres", "services_case", { candidate_user_id: c, job_id: j1, consent_record_id: cr, status: "closed", closed_at: daysAgo(3), close_reason: "decided", offer_details: { salary: 40000 } });
  await ins("postgres", "case_document", { services_case_id: sc, storage_key: `cases/${c}/passport.pdf`, file_name: "passport-copy.pdf", candidate_user_id: c });
  await ins("postgres", "case_note", { services_case_id: sc, author_staff_user_id: s1, body: "Fake note" });
  await ins("postgres", "report", { target_kind: "job", target_job_id: j2, reason: "other", reporter_candidate_user_id: c, evidence_text: "Fake evidence" });
  await ins("postgres", "report", { target_kind: "profile", target_candidate_user_id: c, reason: "other", status: "cleared", decided_at: daysAgo(1) });
  await ins("postgres", "notification", { candidate_user_id: c, category: "a", template_key: "t", dedupe_key: id("dk") });
  await ins("postgres", "notification_preference", { candidate_user_id: c, category: "a", channel: "email", enabled: false });
  await ins("postgres", "email_outbox", { template: "t", candidate_user_id: c, status: "pending", dedupe_key: id("dk") }, null);
  await ins("postgres", "email_outbox", { template: "t", candidate_user_id: c, status: "sent", sent_at: daysAgo(1), dedupe_key: id("dk") }, null);
  const cm = await ins("postgres", "contact_message", { surface: "candidate_site", candidate_user_id: c, from_name: "Fake Name", from_email: email, topic: "data_request", body: "Please delete my data" });
  // ported change: the migrations' contact_message trigger already queues this data_request review item
  // await ins("postgres", "review_item", { queue: "data_request", contact_message_id: cm, reason: "data request" });
  await su("insert into candidate_session(id,expires_at,token,created_at,updated_at,user_id) values($1,now()+interval '1 day',$2,now(),now(),$3)", [id("ss"), id("tok"), c]);
  await su("insert into candidate_account(id,account_id,provider_id,user_id,password,created_at,updated_at) values($1,$2,'credential',$2,'hash',now(),now())", [id("acc"), c]);
  await su("insert into candidate_verification(id,identifier,value,expires_at,created_at,updated_at) values($1,$2,$3,now()+interval '1 hour',now(),now())", [id("v"), `reset-password:${id("t")}`, c]);
  for (const a of [{ actor_candidate_user_id: c, action: "security.email_change", kind: "security", object_type: "candidate_user", object_id: c, before: { email: "fake.old@example.test" }, reason_text: "Fake reason naming the person" },
                   { actor_staff_user_id: s1, action: "data_access.profile", kind: "data_access", subject_candidate_user_id: c, reason_code: "services_case", reason_text: "Viewed for case" }])
    await ins("postgres", "audit_event", a, null);
  return { c, email, cr, sc };
}
await blk("{ const open = await fullCandidate(); await su(\"update services_case s", async () => {
{ const open = await fullCandidate(); await su("update services_case set status='documents_needed', closed_at=null, close_reason=null where id=$1", [open.sc]);
  const r1 = (await P.app_admin.query("select private.erase_candidate($1, true) r", [open.c])).rows[0].r;
  rec("2 erasure", "erase_candidate refuses while the candidate has an open services case, and says why (#99)", r1.erased === false && r1.reason === "open_services_case" && await count("candidate_user where id=$1", [open.c]) === 1, JSON.stringify(r1));
  const rep = await fullCandidate(); await ins("postgres", "report", { target_kind: "profile", target_candidate_user_id: rep.c, reason: "other" });
  const r2 = (await P.app_admin.query("select private.erase_candidate($1, true) r", [rep.c])).rows[0].r;
  rec("2 erasure", "erase_candidate refuses while an open report is about the person", r2.erased === false && r2.reason === "open_report", JSON.stringify(r2));
  rec("2 erasure", "app_candidate cannot run erase_candidate (execute is app_admin only)", (await P.app_candidate.query("select private.erase_candidate($1, true)", [rep.c]).then(() => "allowed", (e) => e.code)) === "42501");
  const x = await fullCandidate();
  const r3 = (await P.app_admin.query("select private.erase_candidate($1, true) r", [x.c])).rows[0].r;
  const left = {};
  for (const [t, col] of [["candidate_user", "id"], ["candidate_profile", "candidate_user_id"], ["candidate_cv", "candidate_user_id"], ["saved_job", "candidate_user_id"], ["tracker_entry", "candidate_user_id"], ["apply_click", "candidate_user_id"], ["alert", "candidate_user_id"], ["notification", "candidate_user_id"], ["notification_preference", "candidate_user_id"], ["contact_message", "candidate_user_id"], ["candidate_session", "user_id"], ["candidate_account", "user_id"], ["candidate_verification", "value"], ["consent_record", "candidate_user_id"], ["services_case", "candidate_user_id"], ["case_document", "candidate_user_id"], ["report", "reporter_candidate_user_id"], ["report", "target_candidate_user_id"], ["review_item", "candidate_user_id"]])
    left[`${t}.${col}`] = await count(`${t} where ${col}=$1`, [x.c]);
  left.email_outbox_pending = await count("email_outbox where candidate_user_id=$1 and status='pending'", [x.c]);
  left.email_outbox_sent = await count("email_outbox where candidate_user_id=$1 and status='sent'", [x.c]);
  const consent = (await su("select subject_erased_at is not null erased, job_id, organisation_id, details from consent_record where id=$1", [x.cr])).rows[0];
  const caseRow = (await su("select requester_erased_at is not null erased, offer_details from services_case where id=$1", [x.sc])).rows[0];
  const doc = (await su("select storage_key, file_name, copy_deleted_at is not null deleted from case_document where services_case_id=$1", [x.sc])).rows[0];
  const reports = (await su("select target_kind, reporter_wiped_at is not null rw, target_wiped_at is not null tw, evidence_text from report where reporter_wiped_at > now()-interval '1 minute' or target_wiped_at > now()-interval '1 minute'")).rows;
  const item = (await su("select status, contact_message_id, candidate_user_id from review_item where queue='data_request' order by id desc limit 1")).rows[0];
  const nonzero = Object.entries(left).filter(([, v]) => v !== 0);
  
  // NOTE the sent email_outbox row keeps the erased id as a plain value (only pending rows are deleted, and email_outbox_sent removes it after 30 days)
  rec("2 erasure", "consent record kept as bare proof: subject_erased_at set, job, organisation and details emptied", consent.erased && consent.job_id === null && consent.organisation_id === null && consent.details === null, JSON.stringify(consent));
  rec("2 erasure", "closed services case kept with requester_erased_at", caseRow.erased, JSON.stringify(caseRow));
  rec("2 erasure", "the case document copy is removed at once: storage key and file name empty, copy_deleted_at set", doc.storage_key === null && doc.file_name === null && doc.deleted, JSON.stringify(doc));
  
  rec("2 erasure", "reports filed by them and about them are kept with wiped marks", reports.length >= 2 && reports.every((r) => r.rw || r.tw), JSON.stringify(reports));
  rec("2 erasure", "the open data_request item is closed with its person columns empty", item.status === "done" && item.contact_message_id === null && item.candidate_user_id === null, JSON.stringify(item));
  rec("2 erasure", "storage keys returned for deletion (CV, case copy)", r3.storage_keys.length === 2, JSON.stringify(r3.storage_keys));
  // 14: the audit log and every other place
  const audit = (await su("select actor_candidate_user_id a, subject_candidate_user_id s, object_id o, before, after, reason_text from audit_event where action in ('security.email_change','data_access.profile','candidate.erase') order by id desc limit 3")).rows;
  rec("14 pseudonymise", "audit_pseudonymise: actor, subject and object_id replaced, before, after and reason_text emptied", audit.length === 3 && audit.every((a) => a.a !== x.c && a.s !== x.c && a.o !== x.c && !a.before && !a.reason_text), JSON.stringify(audit).slice(0, 300));
  const tables = (await su("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")).rows.map((r) => r.table_name);
  const hits = [];
  for (const t of tables) { const n = await count(`${t} x where x::text like $1 or x::text ilike $2`, [`%${x.c}%`, `%${x.email}%`]); if (n) hits.push(`${t}: ${n}`); }
  
  // erase_portal_user
  const o2 = await F.org(), owner = await F.portal(), rec2 = await F.portal(), mo = await F.member(o2, owner, { role: "account_owner", signer: true }), mr = await F.member(o2, rec2, { role: "recruiter" });
  const r4 = (await P.app_admin.query("select private.erase_portal_user($1, true) r", [owner])).rows[0].r;
  rec("2 erasure", "erase_portal_user refuses the active owner of a company with other active members", r4.erased === false && r4.reason === "owner_with_members", JSON.stringify(r4));
  const pct = await F.text("services_request"), pcr = await ins("postgres", "consent_record", { portal_user_id: rec2, consent_text_id: pct, organisation_id: o2 });
  const psc = await ins("postgres", "services_case", { portal_user_id: rec2, dedupe_key: id("dk"), consent_record_id: pcr, status: "closed", closed_at: daysAgo(1), close_reason: "decided" });
  await ins("postgres", "case_document", { services_case_id: psc, storage_key: "k/offer.pdf", file_name: "offer-letter.pdf", portal_user_id: rec2 });
  await ins("postgres", "email_outbox", { template: "t", portal_user_id: rec2, dedupe_key: id("dk") }, null);
  await ins("postgres", "audit_event", { kind: "security", actor_portal_user_id: rec2, action: "portal.signin", object_type: "portal_user", object_id: rec2 }, null);
  await ins("postgres", "review_item", { queue: "data_request", portal_user_id: rec2, reason: "data request" });
  const r5 = await P.app_admin.query("select private.erase_portal_user($1, true) r", [rec2]).then((x) => x.rows[0].r, (e) => ({ error: e.message }));
  rec("2 erasure", "erase_portal_user works on a member who has an open data_request review item about them", r5.erased === true, JSON.stringify(r5).slice(0, 250) + (r5.error ? ": the function (as the design words it) does not close the item, and the foreign key's set null breaks the item's one-target check" : ""));
  await su("update review_item set status='done', portal_user_id=null where portal_user_id=$1", [rec2]);
  const r6 = (await P.app_admin.query("select private.erase_portal_user($1, true) r", [rec2])).rows[0].r;
  const m = (await su("select status, portal_user_id, invited_email, removed_at is not null removed from membership where id=$1", [mr])).rows[0];
  const pdoc = (await su("select storage_key, file_name from case_document where services_case_id=$1", [psc])).rows[0];
  
  rec("2 erasure", "a portal user's own case document copies are removed with them (as for candidates)", pdoc.storage_key === null, `${JSON.stringify(pdoc)}: erase_portal_user names no step for them`); }
});

// ---- 11 and 16. run_retention: every rule in section 7, as app_admin
await blk("{ const old = (d) => daysAgo(d), ms = (d) => Date.now() - 864e5 * d; ", async () => {
{ const old = (d) => daysAgo(d), ms = (d) => Date.now() - 864e5 * d;
  // expired login rows
  const c0 = await F.cand(), p0 = await F.portal(), st0 = await F.staff();
  for (const [pool, u] of [["candidate", c0], ["portal", p0], ["staff", st0]]) {
    await su(`insert into ${pool}_session(id,expires_at,token,created_at,updated_at,user_id) values($1,$2,$3,now(),now(),$4),($5,now()+interval '1 day',$6,now(),now(),$4)`, [id("old"), old(3), id("t"), u, id("new"), id("t")]);
    await su(`insert into ${pool}_verification(id,identifier,value,expires_at,created_at,updated_at) values($1,'x','y',$2,now(),now())`, [id("v"), old(3)]);
    await su(`insert into ${pool}_rate_limit(id,key,count,last_request) values($1,$2,1,$3),($4,$5,1,$6)`, [id("rl"), id("k"), ms(3), id("rl"), id("k"), Date.now()]); }
  const jOld = await live(), cA = await F.cand(); await ins("postgres", "apply_click", { candidate_user_id: cA, job_id: jOld, clicked_at: old(20), status: "expired" }); await ins("postgres", "apply_click", { candidate_user_id: cA, job_id: jOld, clicked_at: old(1) });
  await ins("postgres", "email_outbox", { template: "t", candidate_user_id: cA, status: "sent", sent_at: old(40), dedupe_key: id("dk") }, null); await ins("postgres", "email_outbox", { template: "t", candidate_user_id: cA, status: "failed", send_after: old(400), dedupe_key: id("dk") }, null);
  await ins("postgres", "notification", { candidate_user_id: cA, category: "a", template_key: "t", read_at: old(100), dedupe_key: id("dk") }); await ins("postgres", "notification", { candidate_user_id: cA, category: "a", template_key: "t", created_at: old(400), dedupe_key: id("dk") });
  await ins("postgres", "fetch_run", { job_source_id: src, started_at: old(100) });
  await ins("postgres", "review_item", { queue: "scam_flag", job_id: jOld, status: "done", decided_at: old(400) });
  await ins("postgres", "contact_message", { surface: "portal", from_email: "x@example.test", topic: "general", body: "b", status: "closed", closed_at: old(400) });
  const answered = await ins("postgres", "contact_message", { surface: "portal", from_email: "x@example.test", topic: "general", body: "b", status: "answered", created_at: old(800) });
  const adv = await ins("postgres", "fetched_advert", { job_source_id: src, external_id: id("x"), result: "rejected", last_seen_at: old(400) });
  // applications at Launch A: none exist; application_and_cv is exercised in 09-launch-b.mjs
  const caseOrg = await F.org(), cdC = await F.cand(), cdCons = await ins("postgres", "consent_record", { candidate_user_id: cdC, consent_text_id: await F.text("services_request") });
  const cdCase = await ins("postgres", "services_case", { candidate_user_id: cdC, consent_record_id: cdCons, status: "closed", closed_at: old(40), close_reason: "decided" });
  const cdDoc = await ins("postgres", "case_document", { services_case_id: cdCase, storage_key: "k/old-copy.pdf", file_name: "old-copy.pdf", candidate_user_id: cdC });
  // statements and floors
  const ctS = await F.text("sponsorship_statement"), closedJob = await live({ status: "closed", closed_at: old(400), search_vector: null });
  const stmt = await ins("app_portal", "sponsorship_statement", { job_id: closedJob, organisation_id: org, kind: "own_company", consent_text_id: ctS, signer_membership_id: mem, signer_name: "Fake Signer", signer_title: "Head of People" });
  const strikeJob = await live({ status: "closed", closed_at: old(400), search_vector: null });
  const stmt2 = await ins("app_portal", "sponsorship_statement", { job_id: strikeJob, organisation_id: org, kind: "own_company", consent_text_id: ctS, signer_membership_id: mem, signer_name: "Kept Signer" });
  await ins("postgres", "strike", { organisation_id: org, case_kind: "false_claim", job_id: strikeJob, reason_code: "false_sponsorship" });
  const big = await F.org(); await appr("big_company_entry", "organisation", big); await su("update organisation set is_big_company=true where id=$1", [big]);
  const bm = await F.member(big, await F.portal(), { role: "account_owner" });
  const floorOld = await ins("postgres", "pay_floor", { organisation_id: big, role_family: "x", floor_eur: 50000, consent_text_id: await F.text("pay_floor"), signer_membership_id: bm, signer_name: "Floor Signer", valid_until: new Date(Date.now() + 1e10) });
  await su("update pay_floor set status='withdrawn' where id=$1", [floorOld]); await su("update pay_floor set ended_at=$2 where id=$1", [floorOld, old(400)]);
  // strikes and reports
  const evOrg = await F.org(), evJob = await live({ organisation_id: evOrg });
  const evReport = await ins("postgres", "report", { target_kind: "job", target_job_id: evJob, reason: "other", status: "cleared", decided_at: old(400) });
  const hidJob = await live({ organisation_id: evOrg }), hidReport = await ins("postgres", "report", { target_kind: "job", target_job_id: hidJob, reason: "other", status: "upheld", decided_at: old(400) });
  await su("update job set status='hidden', hidden_reason='report', hidden_report_id=$2 where id=$1", [hidJob, hidReport]);
  const evStrike = await ins("postgres", "strike", { organisation_id: evOrg, case_kind: "false_claim", reason_code: "false_sponsorship", stage: "decided", outcome: "cleared", decided_at: old(400), decided_by_staff_user_id: s1 });
  const banStrike = await ins("postgres", "strike", { organisation_id: evOrg, case_kind: "instant_ban", reason_code: "fake_job", stage: "decided", outcome: "ban", decided_at: old(400), decided_by_staff_user_id: s1, approval_request_id: await appr("ban", "strike", "pending-id") }).catch(async () => {
    const k = await ins("postgres", "strike", { organisation_id: evOrg, case_kind: "instant_ban", reason_code: "fake_job" });
    const a = await appr("ban", "strike", k); await su("update strike set stage='decided', outcome='ban', decided_at=$2, decided_by_staff_user_id=$3, approval_request_id=$4 where id=$1", [k, old(400), s1, a]); return k; });
  // ported change: a ban must share its strike case's request and apply in the same transaction (C2); the fixture reuses the case's request with triggers off
  await tx("postgres", async (c) => { await c.query("set local session_replication_role = replica"); await c.query("insert into ban(cro_number, reason_code, strike_id, approval_request_id) select $1, 'fake_job', id, approval_request_id from strike where id=$2", [id("cro"), banStrike]); });
  // closed jobs
  const fa = await ins("postgres", "fetched_advert", { job_source_id: src, external_id: id("x"), result: "passed" });
  const oldFetched = await ins("postgres", "job", { organisation_id: org, source: "fetched", job_source_id: src, fetched_advert_id: fa, title: "t", employer_name: "e", sector: "it", permit_type: "critical_skills", status: "closed", closes_at: "infinity", closed_at: old(800), own_page_url: "u" });
  await ins("postgres", "job_text", { job_id: oldFetched, advert_text: "fake" }, null); await ins("postgres", "job_daily_stat", { job_id: oldFetched, day: "2024-01-01" });
  const oldEmployer = await live({ status: "closed", closed_at: old(800), search_vector: null });
  await ins("app_portal", "sponsorship_statement", { job_id: oldEmployer, organisation_id: org, kind: "own_company", consent_text_id: ctS, signer_membership_id: mem, signer_name: "Old Signer" });
  const savedOld = await live({ status: "closed", closed_at: old(800), search_vector: null }); await ins("postgres", "saved_job", { candidate_user_id: cA, job_id: savedOld });
  const struckOld = await live({ status: "closed", closed_at: old(800), search_vector: null }); await ins("postgres", "strike", { organisation_id: org, case_kind: "false_claim", job_id: struckOld, reason_code: "false_sponsorship" });
  // approval requests
  const oldReq = await F.approval("threshold", "setting", id("t"), { by: s1, confirmer: s2 }); await su("update approval_request set created_at=$2 where id=$1", [oldReq, old(800)]);
  const oldUsed = await appr("grant_administrator", "staff_role", s2); /* ported change: F.approval already gave s2 the role; attach the request to that row, triggers off */ await tx("postgres", async (c) => { await c.query("set local session_replication_role = replica"); await c.query("update staff_role set approval_request_id=$1 where staff_user_id=$2 and role='administrator'", [oldUsed, s2]); }); await su("update approval_request set created_at=$2 where id=$1", [oldUsed, old(800)]);
  // people
  const graceC = await F.cand({ deleted: old(31) }), graceP = await F.portal(); await su("update portal_user set deleted_at=$2 where id=$1", [graceP, old(31)]);
  const unvC = await F.cand({ verified: false, created: old(8) }), unvP = await F.portal({ verified: false, created: old(8) });
  const inact = await F.cand({ created: old(500) }); await su("update candidate_user set last_active_at=$2 where id=$1", [inact, old(400)]);
  const warned = await F.cand({ created: old(500) }); await su("update candidate_user set last_active_at=$2, inactive_warned_at=$3 where id=$1", [warned, old(430), old(31)]);
  const frozen = await F.cand({ deleted: old(31) }), fc = await ins("postgres", "consent_record", { candidate_user_id: frozen, consent_text_id: await F.text("services_request") });
  await ins("postgres", "services_case", { candidate_user_id: frozen, consent_record_id: fc, status: "submitted" });
  const removedP = await F.portal(), rmo = await F.org(); await ins("postgres", "membership", { organisation_id: rmo, portal_user_id: removedP, role: "recruiter", status: "removed", removed_at: old(31) });
  const needsInfo = await F.org({ status: "needs_info" }); await su("update organisation set claimed_at=$2 where id=$1", [needsInfo, old(60)]);
  // run it as the role the design names, until nothing is left
  const runs = []; let more = true, n = 0;
  while (more && n < 10) { const r = (await P.app_admin.query("select private.run_retention(1000) r")).rows[0].r; runs.push(r); more = r.more; n++; }
  const r0 = runs[0];
  fs.writeFileSync("/w/results-retention.json", JSON.stringify(runs, null, 1));
  const chk = async (label, sqlLeft, want, extra = "") => { const v = await count(sqlLeft[0], sqlLeft[1]); rec("11 run_retention", label, v === want, `${v} left ${extra}`); };
  for (const pool of ["candidate", "portal", "staff"]) {
    
    
     }
  
  
  // NOTE email_outbox: failed and dropped rows have no rule, so they stay for ever
  
  // NOTE notification: unread notices have no rule, so they stay for ever
  
  
  
  // NOTE contact_message: an answered message that is never closed has no clock, so it stays
  
  
  rec("11 run_retention", "claim_needs_info cannot run: no column records when an organisation entered needs_info", r0.claim_needs_info?.startsWith?.("not run") ? false : true, `${r0.claim_needs_info}; the needs_info organisation is still ${(await su("select status from organisation where id=$1", [needsInfo])).rows[0].status}`);
  const s1row = (await su("select signer_name, signer_title from sponsorship_statement where id=$1", [stmt])).rows[0], s2row = (await su("select signer_name from sponsorship_statement where id=$1", [stmt2])).rows[0];
  
  const frow = (await su("select signer_name from pay_floor where id=$1", [floorOld])).rows[0];
  
  
  await chk("strike_and_report_evidence: a strike case a ban points to stays", ["strike where id=$1", [banStrike]], 1);
  
  await chk("strike_and_report_evidence: a report that a still-hidden job points to stays (deleting it would break the job's hidden check)", ["report where id=$1", [hidReport]], 1);
  
  
  
  await chk("closed_job_unreferenced: a job with saved rows stays (#57)", ["job where id=$1", [savedOld]], 1);
  await chk("closed_job_unreferenced: a job a strike case points to stays", ["job where id=$1", [struckOld]], 1);
  
  await chk("approval_request: an old request a staff role points to stays", ["approval_request where id=$1", [oldUsed]], 1);
  
  
  
  
  const w = (await su("select inactive_warned_at is not null w from candidate_user where id=$1", [inact])).rows[0];
  rec("11 run_retention", "inactive_profile: 12 months with no login sets inactive_warned_at and queues the warning email", w?.w && await count("email_outbox where candidate_user_id=$1 and template='inactive-warning'", [inact]) === 1, JSON.stringify(w));
  
  await chk("#99 freeze: a candidate in the grace period with an open case is not erased", ["candidate_user where id=$1", [frozen]], 1);
  
  
  // NOTE services_case_record, case_invoice_record and consent_bare_proof have no value, so nothing is deleted (not set in section 7; the function skips them)
  rec("11 run_retention", "it ran as app_admin; inside, current_user was the owner and session_user app_admin", (await su("select actor_system from audit_event where action='retention.run' order by id desc limit 1")).rows[0].actor_system === "run_retention by app_admin", "");
  
  for (const r of ["app_candidate", "app_portal", "app_fetcher"]) rec("11 run_retention", `${r} cannot execute run_retention`, (await P[r].query("select private.run_retention()").then(() => "allowed", (e) => e.code)) === "42501");
  // batches: a SECURITY DEFINER routine cannot commit between batches
  await P.portal_owner.query("create or replace procedure private.batch_probe() language plpgsql security definer set search_path = public, pg_temp as $$ begin commit; end $$");
  await P.portal_owner.query("grant execute on procedure private.batch_probe() to app_admin");
  const probe = await P.app_admin.query("call private.batch_probe()").then(() => "committed", (e) => `${e.code} ${e.message}`);
  
  await P.portal_owner.query("drop procedure private.batch_probe()");
  for (let i = 0; i < 2500; i++) if (i % 500 === 0) await su("insert into apply_click(candidate_user_id,job_id,clicked_at,status) select $1, $2, now() - interval '30 days', 'expired' from generate_series(1,500)", [cA, jOld]);
  const b1 = (await P.app_admin.query("select private.run_retention(1000) r")).rows[0].r;
   }
});

