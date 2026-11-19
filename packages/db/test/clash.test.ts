/* eslint-disable */
// @ts-nocheck
// Ported from schema-trial-2/07-clash.mjs, close to as written. One `it` per trial check, same names.
import { afterAll } from "vitest";
import { createTestDb, urlFor } from "./db";
import pg from "pg";
import { setup, in30, daysAgo } from "./trial-compat";
import { known } from "./clash-known";

const db = await createTestDb();
afterAll(() => db.drop());
const url = (role) => urlFor(db.name, role);
const { P, su, id, R, line, rule, ins, race, tx, F, blk } = setup(db, known);
// Every "Clash rules" line in the design at Launch A: one attempt that must be refused, one legitimate action that must succeed.
const sv = "'fake':1";
const src = await ins(P.postgres, "job_source", { kind: "portal", board: "portal" });
const s1 = await F.staff(), s2 = await F.staff(), s3 = await F.staff();
const org = await F.org(), org2 = await F.org(), pu = await F.portal(), pu2 = await F.portal();
const mem = await F.member(org, pu, { role: "account_owner", signer: true }), mem2 = await F.member(org2, pu2, { role: "account_owner", signer: true });
// 0019: a portal job write names an active poster of the job's company, so a job of `org` is posted by its owner unless the test says otherwise
const J = (o = {}) => ({ organisation_id: org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org", sector: "it", permit_type: "critical_skills", status: "draft", closes_at: in30(), own_page_url: "https://example.test/apply", ...((o.organisation_id ?? org) === org && !o.posted_by_staff_id && o.source !== "fetched" ? { posted_by_membership_id: mem } : {}), ...o });
const LJ = (o = {}) => J({ status: "live", salary_low: 40000, search_vector: sv, ...o });
const FJ = (o = {}) => J({ source: "fetched", closes_at: "infinity", ...o });
const job = (o, pool = "postgres") => ins(pool, "job", J(o));
const live = (o = {}, pool = "postgres") => ins(pool, "job", LJ(o));
const appr = (kind, table, target, o = {}) => F.approval(kind, table, target, { by: s1, confirmer: s2, ...o });
/* ported change: a ban shares its strike case's approval request (0002 approval_check), applied in the same transaction, so a ban fixture is the strike decided as ban plus the ban row, as postgres */
const banFor = async (organisation_id, cols) => { const sk = await ins("postgres", "strike", { organisation_id, case_kind: "instant_ban", reason_code: "fake_company" }), rq = await appr("ban", "strike", sk);
  await tx("postgres", async (c) => { await c.query("update strike set outcome='ban', stage='decided', approval_request_id=$2 where id=$1", [sk, rq]); const k = Object.keys({ ...cols, reason_code: 1, strike_id: 1, approval_request_id: 1 }); await c.query(`insert into ban(${k}) values(${k.map((_, i) => "$" + (i + 1))})`, k.map((x) => ({ ...cols, reason_code: "fake_company", strike_id: sk, approval_request_id: rq })[x])); }); return sk; };

// ===== job
await rule("job", "(posted_by_membership_id, organisation_id) must be a real member of that company", { refuse: async () => job({ posted_by_membership_id: mem2 }), ok: async () => job({ posted_by_membership_id: mem }) });
await rule("job", "at most one of the two posted-by columns", { refuse: async () => job({ posted_by_membership_id: mem, posted_by_staff_id: s1 }), ok: async () => job({ source: "admin_manual", posted_by_staff_id: s1 }) });
await rule("job", "own_page needs own_page_url (#24)", { refuse: async () => job({ own_page_url: null }), ok: async () => job({}) });
await rule("job", "live needs search_vector", { refuse: async () => job({ status: "live", salary_low: 40000 }), ok: async () => live() });
await rule("job", "fetched jobs: permit_type critical_skills", { refuse: async () => ins("postgres", "job", FJ({ permit_type: "general" })), ok: async () => ins("postgres", "job", FJ()) });
await rule("job", "fetched jobs: never sponsor_confirmed", { refuse: async () => ins("postgres", "job", FJ({ badge: "sponsor_confirmed" })), ok: async () => ins("postgres", "job", FJ({ badge: "critical_skills_eligible" })) });
await rule("job", "a live fetched job carries critical_skills_eligible", { refuse: async () => ins("postgres", "job", FJ({ status: "live", search_vector: sv })), ok: async () => ins("postgres", "job", FJ({ status: "live", search_vector: sv, badge: "critical_skills_eligible" })) });
await rule("job", "critical_skills_eligible only with permit_type critical_skills", { refuse: async () => job({ badge: "critical_skills_eligible", permit_type: "general" }), ok: async () => job({ badge: "critical_skills_eligible" }) });
await rule("job", "employer and agency jobs past draft need a salary or a pay_grade", { refuse: async () => job({ status: "in_review", search_vector: sv }), ok: async () => job({ status: "in_review", search_vector: sv, pay_grade: "Grade VI" }) });
await rule("job", "health_insurance_eur is 0 or more", { refuse: async () => job({ health_insurance_eur: -1 }), ok: async () => job({ health_insurance_eur: 0 }) });
await rule("job", "hidden needs hidden_reason", { refuse: async () => live({ status: "hidden" }), ok: async () => live({ status: "hidden", hidden_reason: "admin" }) });
await blk("{ const rj = await live(), rep = await ins(\"postgres\", \"report\", { tar", async () => {
{ const rj = await live(), rep = await ins("postgres", "report", { target_kind: "job", target_job_id: rj, reason: "other" });
  await rule("job", "hidden_reason = 'report' needs hidden_report_id", { refuse: async () => live({ status: "hidden", hidden_reason: "report" }), ok: async () => live({ status: "hidden", hidden_reason: "report", hidden_report_id: rep }) }); }
});
await rule("job", "hidden_reason and hidden_report_id are empty unless the job is hidden", { refuse: async () => live({ hidden_reason: "admin" }), ok: async () => live() });
await rule("job", "Launch B lock: CHECK (application_route = 'own_page')", { refuse: async () => job({ application_route: "on_site", own_page_url: null }), ok: async () => job({ application_route: "own_page" }) });
await rule("job", "screening_questions is empty unless the route is on_site", { refuse: async () => job({ screening_questions: JSON.stringify([{ id: 1, text: "Q", kind: "yes_no" }]) }), ok: async () => job({ screening_questions: "[]" }) });
await rule("job", "deferred check at commit: a live sponsor_confirmed job has a current sponsorship statement", {
  refuse: async () => tx("postgres", (c) => c.query("insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector,badge) values($1,'employer',$2,'t','e','it','critical_skills','live',now()+interval '20 days','u',40000,$3,'sponsor_confirmed')", [org, src, sv])),
  /* ported change: the statement goes in as app_portal, so the pair is built as app_portal: a draft job, its own_company statement, then live */
  ok: async () => { const ct = await F.text("sponsorship_statement"); await tx("app_portal", async (c) => { const j = (await c.query("insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,badge,posted_by_membership_id) values($1,'employer',$2,'t','e','it','critical_skills','draft',now()+interval '20 days','u',40000,'sponsor_confirmed',$3) returning id", [org, src, mem])).rows[0].id; await c.query("insert into sponsorship_statement(job_id,organisation_id,kind,consent_text_id,signer_membership_id,signer_name) values($1,$2,'own_company',$3,$4,'Fake Signer')", [j, org, ct, mem]); await c.query("update job set status='live', search_vector=$2 where id=$1", [j, sv]); }); }, expect: "deferred check" });
await blk("for (const st of [\"suspended\", \"banned\", \"closed\"]) { const o = await ", async () => {
for (const st of ["suspended", "banned", "closed"]) { const o = await F.org({ status: st });
  await rule("job", `a trigger refuses live while the organisation is ${st}`, { refuse: async () => live({ organisation_id: o }), ok: async () => job({ organisation_id: o }), expect: "suspended, banned or closed" }); }
});
// write guard, app_portal
await rule("job", "write guard: app_portal writes only employer or agency jobs", { refuse: async () => ins("app_portal", "job", FJ()), ok: async () => ins("app_portal", "job", J()), expect: "job guard" });
await blk("{ const j = await ins(\"app_portal\", \"job\", J()); await rule(\"job\", \"", async () => {
{ const j = await ins("app_portal", "job", J());
  await rule("job", "write guard: app_portal never changes organisation_id or source", { refuse: async () => P.app_portal.query("update job set organisation_id=$2 where id=$1", [j, org2]), ok: async () => P.app_portal.query("update job set title='Renamed' where id=$1", [j]), expect: "never change" });
  await rule("job", "write guard: app_portal sets badge only sponsor_confirmed or empty", { refuse: async () => P.app_portal.query("update job set badge='critical_skills_eligible' where id=$1", [j]), ok: async () => P.app_portal.query("update job set badge='sponsor_confirmed' where id=$1", [j]), expect: "job guard" });
  await rule("job", "write guard: app_portal sets closes_at at most 30 days ahead", { refuse: async () => P.app_portal.query("update job set closes_at=now()+interval '31 days' where id=$1", [j]), ok: async () => P.app_portal.query("update job set closes_at=now()+interval '29 days' where id=$1", [j]), expect: "30 days" }); }
});
await blk("{ const restricted = await F.org({ status: \"verified_restricted\" }); ", async () => {
{ const restricted = await F.org({ status: "verified_restricted" });
  /* ported change: the migrations tie "restricted" to a future restricted_until, set only by a strike 2; the fixture sets it with triggers off */
  await tx("postgres", async (c) => { await c.query("set local session_replication_role = replica"); await c.query("update organisation set restricted_until = now() + interval '30 days' where id=$1", [restricted]); });
  const rmem = await F.member(restricted, await F.portal(), { role: "poster" });
  const a = await ins("app_portal", "job", J({ salary_low: 40000 })), b = await ins("app_portal", "job", J({ organisation_id: restricted, salary_low: 40000, posted_by_membership_id: rmem })), b2 = await ins("app_portal", "job", J({ organisation_id: restricted, salary_low: 40000, posted_by_membership_id: rmem }));
  // the old check also expected a restricted organisation to be refused going live; the guard now changes it to in_review (0002, #44), so only the good half stays
  await rule("job", "write guard: app_portal draft to live (organisation not restricted)", { ok: async () => P.app_portal.query("update job set status='live', search_vector=$2 where id=$1", [a, sv]) });
  await rule("job", "write guard: app_portal draft to in_review (restricted organisation), and the trigger queues post_strike_job_review", { ok: async () => { await P.app_portal.query("update job set status='in_review', search_vector=$2 where id=$1", [b2, sv]); const q = (await su("select queue from review_item where job_id=$1", [b2])).rows.map((r) => r.queue); if (!q.includes("post_strike_job_review")) throw new Error(`queued: ${q}`); } });
  await rule("job", "write guard: app_portal live to closed", { ok: async () => P.app_portal.query("update job set status='closed', closed_at=now(), search_vector=null where id=$1", [a]) });
  const l = await live(); await rule("job", "write guard: app_portal never moves a job into hidden", { refuse: async () => P.app_portal.query("update job set status='hidden' where id=$1", [l]) });
  const h = await live({ status: "hidden", hidden_reason: "admin" }); await rule("job", "write guard: app_portal never moves a job out of hidden", { refuse: async () => P.app_portal.query("update job set status='live' where id=$1", [h]), expect: "job guard" });
  const r = await job({ status: "in_review", search_vector: sv, salary_low: 40000 }); await rule("job", "write guard: app_portal never moves a job out of in_review", { refuse: async () => P.app_portal.query("update job set status='live' where id=$1", [r]), expect: "job guard" });
  const u = await live({ status: "under_review" }), u2 = await live({ status: "under_review" });
  await rule("job", "write guard: under_review to live only in the same update as a salary change", { refuse: async () => P.app_portal.query("update job set status='live' where id=$1", [u]), ok: async () => P.app_portal.query("update job set status='live', salary_low=52000 where id=$1", [u2]), expect: "job guard" });
  const d = await job({}), ur = await live({ status: "under_review" });
  await P.app_portal.query("update job set status='closed', closed_at=now() where id=$1", [ur]).then(() => line("job", "an employer can close (withdraw) its own job while it is under_review", null, true, "allowed"), (e) => line("job", "an employer can close (withdraw) its own job while it is under_review: the guard lists only live to closed, so this legitimate action is refused", null, false, e.message)); }
});
// write guard, app_fetcher
await rule("job", "write guard: app_fetcher writes only fetched jobs", { refuse: async () => ins("app_fetcher", "job", (({ posted_by_membership_id: _, ...x }) => x)(J())), ok: async () => ins("app_fetcher", "job", FJ({ status: "live", search_vector: sv, badge: "critical_skills_eligible" })), expect: "job guard" });
await rule("job", "write guard: app_fetcher sets badge only critical_skills_eligible", { refuse: async () => ins("app_fetcher", "job", FJ({ badge: "sponsor_confirmed" })), ok: async () => ins("app_fetcher", "job", FJ({ badge: "critical_skills_eligible" })) });
await blk("{ const h = await ins(\"postgres\", \"job\", FJ({ status: \"hidden\", hidden", async () => {
{ const h = await ins("postgres", "job", FJ({ status: "hidden", hidden_reason: "admin", search_vector: sv, badge: "critical_skills_eligible" }));
  await rule("job", "write guard: app_fetcher never moves a job out of hidden", { refuse: async () => P.app_fetcher.query("update job set status='live' where id=$1", [h]), ok: async () => P.app_fetcher.query("update job set title='Refetched' where id=$1", [h]), expect: "hidden" });
  const q = await ins("app_fetcher", "job", FJ({ status: "in_review", search_vector: sv, badge: "critical_skills_eligible" }));
  const item = (await su("select count(*)::int n from review_item where job_id=$1 and queue='fetched_job' and status='open'", [q])).rows[0].n;
  line("job", "a queued fetched job entering in_review gets a fetched_job review_item with the owner's rights", null, item === 1, `${item} item, inserted as app_fetcher`);
  await P.app_fetcher.query("update job set status='live' where id=$1", [q]).then(() => line("job", "\"Admin decides in_review\": the fetcher cannot move its own queued job from in_review to live", false, null, "accepted: the fetcher guard as written blocks only moves out of hidden"), (e) => line("job", "\"Admin decides in_review\": the fetcher cannot move its own queued job from in_review to live", true, null, e.message)); }
});
await blk("{ const c = await F.cand(), mk = () => live(), [a, b, cc, d, e] = [awa", async () => {
{ const c = await F.cand(), mk = () => live(), [a, b, cc, d, e] = [await mk(), await mk(), await mk(), await mk(), await mk()], cons = await ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: await F.text("services_request") });
  await su("insert into saved_job(candidate_user_id,job_id) values($1,$2)", [c, a]); await su("insert into tracker_entry(candidate_user_id,job_id,route,origin,stage) values($1,$2,'redirect','mark_applied','applied')", [c, b]);
  await su("insert into services_case(candidate_user_id,job_id,consent_record_id) values($1,$2,$3)", [c, cc, cons]); await su("insert into report(target_kind,target_job_id,reason) values('job',$1,'other')", [d]);
  await su("insert into strike(organisation_id,case_kind,job_id,reason_code) values($1,'false_claim',$2,'false_sponsorship')", [org, e]);
  const free = await job({ status: "closed", closed_at: new Date(), salary_low: 40000 });
  for (const [label, j] of [["saved", a], ["tracker", b], ["services case", cc], ["report", d], ["strike", e]])
    await rule("job", `a job with ${label} rows cannot be deleted`, { refuse: async () => su("delete from job where id=$1", [j]), ...(label === "saved" ? { ok: async () => su("delete from job where id=$1", [free]) } : {}) }); }
});
await blk("{ const fa = await ins(\"postgres\", \"fetched_advert\", { job_source_id: ", async () => {
{ const fa = await ins("postgres", "fetched_advert", { job_source_id: src, external_id: id("x"), result: "passed" });
  await rule("job", "fetched_advert_id is unique when set", { ok: async () => ins("postgres", "job", FJ({ fetched_advert_id: fa })), refuse: async () => ins("postgres", "job", FJ({ fetched_advert_id: fa })) }); }
});
await blk("{ const cj = await live({ source: \"agency\", permit_employer_kind: \"cli", async () => {
{ const cj = await live({ source: "agency", permit_employer_kind: "client", permit_employer_name: "Client Ltd", permit_employer_check: "not_found" });
  const q = (await su("select count(*)::int n from review_item where job_id=$1 and queue='agency_client_check'", [cj])).rows[0].n;
  line("job", "a client job saved with permit_employer_check = not_found queues agency_client_check", null, q === 1, `${q} item`); }
});
await rule("job_source", "kind and board are unique together", { refuse: async () => ins("postgres", "job_source", { kind: "portal", board: "portal" }), ok: async () => ins("postgres", "job_source", { kind: "board", board: id("b") }) });
await rule("fetched_advert", "job_source_id and external_id are unique together", { refuse: async () => { const e = id("x"); await ins("postgres", "fetched_advert", { job_source_id: src, external_id: e, result: "rejected" }); await ins("postgres", "fetched_advert", { job_source_id: src, external_id: e, result: "rejected" }); }, ok: async () => ins("postgres", "fetched_advert", { job_source_id: src, external_id: id("x"), result: "rejected" }) });
await blk("{ const j = await live(); await rule(\"job_daily_stat\", \"job_id and day", async () => {
{ const j = await live(); await rule("job_daily_stat", "job_id and day are unique together", { ok: async () => ins("postgres", "job_daily_stat", { job_id: j, day: "2026-11-06" }), refuse: async () => ins("postgres", "job_daily_stat", { job_id: j, day: "2026-11-06" }) }); }
});

// ===== candidate tables
await blk("{ const e = `${id(\"e\")}@example.test`; await rule(\"candidate_user\", ", async () => {
{ const e = `${id("e")}@example.test`;
  await rule("candidate_user", "email unique within this pool (#97); the same email may sit in the portal pool", { ok: async () => { await su("insert into candidate_user(id,name,email,email_verified,created_at,updated_at) values($1,'a',$2,true,now(),now())", [id("c"), e]); await su("insert into portal_user(id,name,email,email_verified,created_at,updated_at) values($1,'a',$2,true,now(),now())", [id("p"), e]); }, refuse: async () => su("insert into candidate_user(id,name,email,email_verified,created_at,updated_at) values($1,'a',$2,true,now(),now())", [id("c"), e]) });
  // NOTE Google links only to the same verified email: not tested, needs Google sign-in
  }
});
await blk("{ const c = await F.cand(), c2 = await F.cand(), c3 = await F.cand(), ", async () => {
{ const c = await F.cand(), c2 = await F.cand(), c3 = await F.cand(), c4 = await F.cand(), c5 = await F.cand(), c6 = await F.cand();
  await rule("candidate_profile", "one profile per candidate", { ok: async () => ins("postgres", "candidate_profile", { candidate_user_id: c }), refuse: async () => ins("postgres", "candidate_profile", { candidate_user_id: c }) });
  await rule("candidate_profile", "stamp only when in Ireland", { refuse: async () => ins("postgres", "candidate_profile", { candidate_user_id: c2, current_stamp: "1G", location_kind: "abroad" }), ok: async () => ins("postgres", "candidate_profile", { candidate_user_id: c2, current_stamp: "1G", location_kind: "ireland" }) });
  await rule("candidate_profile", "award month only when has_relevant_degree is true", { refuse: async () => ins("postgres", "candidate_profile", { candidate_user_id: c3, degree_awarded_month: "2025-06-01", has_relevant_degree: false }), ok: async () => ins("postgres", "candidate_profile", { candidate_user_id: c3, degree_awarded_month: "2025-06-01", has_relevant_degree: true }) });
  await rule("candidate_profile", "award month with the degree answer left empty is refused (build 17)", { refuse: async () => ins("postgres", "candidate_profile", { candidate_user_id: c4, degree_awarded_month: "2025-06-01" }), ok: async () => ins("postgres", "candidate_profile", { candidate_user_id: c4 }) });
  await rule("candidate_profile", "award month always the first of a month", { refuse: async () => ins("postgres", "candidate_profile", { candidate_user_id: c5, degree_awarded_month: "2025-06-15", has_relevant_degree: true }), ok: async () => ins("postgres", "candidate_profile", { candidate_user_id: c5, degree_awarded_month: "2025-06-01", has_relevant_degree: true }) });
  await rule("candidate_profile", "Launch B lock: CHECK (visible_to_employers = false)", { refuse: async () => ins("postgres", "candidate_profile", { candidate_user_id: c6, visible_to_employers: true }), ok: async () => ins("postgres", "candidate_profile", { candidate_user_id: c6, visible_to_employers: false }) });
  const c7 = await F.cand();
  await rule("candidate_cv", "one current CV per candidate; a new upload replaces the old file", { ok: async () => { await ins("postgres", "candidate_cv", { candidate_user_id: c7, storage_key: "k", file_name: "f", content_type: "pdf", size_bytes: 10 }); await P.app_candidate.query("insert into candidate_cv(candidate_user_id,storage_key,file_name,content_type,size_bytes) values($1,'k2','f','pdf',10) on conflict (candidate_user_id) do update set storage_key=excluded.storage_key", [c7]); }, refuse: async () => ins("postgres", "candidate_cv", { candidate_user_id: c7, storage_key: "k3", file_name: "f", content_type: "pdf", size_bytes: 10 }) }); }
});
await blk("{ const c = await F.cand(), j = await live(), j2 = await live(); awa", async () => {
{ const c = await F.cand(), j = await live(), j2 = await live();
  await rule("saved_job", "unique on candidate and job", { ok: async () => ins("postgres", "saved_job", { candidate_user_id: c, job_id: j }), refuse: async () => ins("postgres", "saved_job", { candidate_user_id: c, job_id: j }) });
  const t = await race(10, () => P.app_candidate.query("insert into saved_job(candidate_user_id,job_id) values($1,$2) on conflict do nothing", [c, j2]));
  const rows = (await su("select count(*)::int n from saved_job where candidate_user_id=$1 and job_id=$2", [c, j2])).rows[0].n;
  line("saved_job", "CONCURRENT: 10 taps at once make 1 row, as app_candidate", rows === 1, t.bad.length === 0, `${rows} row, ${t.bad.length} errors`); }
});
await blk("{ const c = await F.cand(), [j, j2, j3, j4] = [await live(), await liv", async () => {
{ const c = await F.cand(), [j, j2, j3, j4] = [await live(), await live(), await live(), await live()];
  await rule("tracker_entry", "unique on candidate and job", { ok: async () => ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j, route: "redirect", origin: "mark_applied", stage: "interview" }), refuse: async () => ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j, route: "redirect", origin: "mark_applied", stage: "offer" }) });
  await rule("tracker_entry", "a check ties the allowed stages to the route", { refuse: async () => ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j2, route: "redirect", origin: "mark_applied", stage: "shortlisted" }), ok: async () => ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j2, route: "on_site", origin: "on_site", stage: "shortlisted" }) });
  await rule("tracker_entry", "on-site route refuses a redirect-only stage", { refuse: async () => ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j3, route: "on_site", origin: "on_site", stage: "interview" }) });
  await rule("tracker_entry", "trigger: app_candidate starts an on-site row only at applied", { refuse: async () => ins("app_candidate", "tracker_entry", { candidate_user_id: c, job_id: j4, route: "on_site", origin: "on_site", stage: "offer" }), ok: async () => ins("app_candidate", "tracker_entry", { candidate_user_id: c, job_id: j4, route: "on_site", origin: "on_site", stage: "applied" }), expect: "tracker guard" });
  await rule("tracker_entry", "trigger: on an on-site row app_candidate may set only withdrawn (cannot set its own stage)", { refuse: async () => P.app_candidate.query("update tracker_entry set stage='hired' where candidate_user_id=$1 and job_id=$2", [c, j4]), ok: async () => P.app_candidate.query("update tracker_entry set stage='withdrawn' where candidate_user_id=$1 and job_id=$2", [c, j4]), expect: "tracker guard" });
  // NOTE a click alone never makes a row (#49): code rule, nothing in the table can tell a click from a tap
  }
});
await blk("{ const c = await F.cand(), j = await live(); await rule(\"apply_clic", async () => {
{ const c = await F.cand(), j = await live();
  await rule("apply_click", "one open prompt per candidate and job (partial unique on pending and not_yet)", { ok: async () => ins("postgres", "apply_click", { candidate_user_id: c, job_id: j }), refuse: async () => ins("postgres", "apply_click", { candidate_user_id: c, job_id: j, status: "not_yet" }) });
  await rule("apply_click", "times_asked 2 at most", { refuse: async () => ins("postgres", "apply_click", { candidate_user_id: c, job_id: j, status: "yes", times_asked: 3 }), ok: async () => ins("postgres", "apply_click", { candidate_user_id: c, job_id: j, status: "yes", times_asked: 2 }) });
  const c2 = await F.cand(), j2 = await live();
  await rule("apply_click", "\"Yes\" writes tracker_entry in the same transaction, as app_candidate", { ok: async () => tx("app_candidate", async (cl) => { await cl.query("insert into apply_click(candidate_user_id,job_id,status,answered_at) values($1,$2,'yes',now())", [c2, j2]); await cl.query("insert into tracker_entry(candidate_user_id,job_id,route,origin,stage) values($1,$2,'redirect','did_you_apply_yes','applied')", [c2, j2]); }) });
  // NOTE code shows 3 pending prompts at most: code rule
  }
});
await blk("{ const c = await F.cand(), a = await ins(\"postgres\", \"alert\", { candi", async () => {
{ const c = await F.cand(), a = await ins("postgres", "alert", { candidate_user_id: c, frequency: "daily", unsubscribe_token: id("tok") });
  const t = await race(2, () => P.app_candidate.query("update alert set last_sent_at=now() where id=$1 and (last_sent_at is null or last_sent_at < now()-interval '1 day') returning id", [a]));
  line("alert", "CONCURRENT: two send runs, only one sends", t.values.filter((v) => v?.rowCount === 1).length === 1, t.bad.length === 0, `${t.values.filter((v) => v?.rowCount === 1).length} winner`);
  await rule("alert", "unsubscribe_token is unique", { refuse: async () => { const k = id("tok"); await ins("postgres", "alert", { candidate_user_id: c, frequency: "daily", unsubscribe_token: k }); await ins("postgres", "alert", { candidate_user_id: c, frequency: "daily", unsubscribe_token: k }); }, ok: async () => ins("postgres", "alert", { candidate_user_id: c, frequency: "weekly", unsubscribe_token: id("tok") }) });
  }
});

// ===== companies
await rule("portal_user", "unique email in this pool", { refuse: async () => { const e = `${id("e")}@example.test`; await F.portal({ email: e }); await F.portal({ email: e }); }, ok: async () => F.portal() });
await rule("organisation", "unique slug", { refuse: async () => { const k = id("slug"); await ins("postgres", "organisation", { slug: k, display_name: "a", kind: "employer" }); await ins("postgres", "organisation", { slug: k, display_name: "a", kind: "employer" }); }, ok: async () => F.org() });
await blk("{ const k = id(\"wrc\"), a = await F.org({ kind: \"agency\", wrc: k, statu", async () => {
{ const k = id("wrc"), a = await F.org({ kind: "agency", wrc: k, status: "pending_review" });
  await rule("organisation", "unique wrc_licence_number while not rejected or closed", { refuse: async () => F.org({ kind: "agency", wrc: k }), ok: async () => { await su("update organisation set status='rejected' where id=$1", [a]); await F.org({ kind: "agency", wrc: k }); } }); }
});
await blk("{ const k = id(\"cro\"), a = await F.org({ cro: k, status: \"pending_revi", async () => {
{ const k = id("cro"), a = await F.org({ cro: k, status: "pending_review" });
  await rule("organisation", "unique cro_number while not rejected or closed, so a rejected false sign-up does not hold a real number", { refuse: async () => F.org({ cro: k }), ok: async () => { await su("update organisation set status='rejected' where id=$1", [a]); await F.org({ cro: k }); } }); }
});
await blk("{ const k = id(\"cro\"), a = await F.org({ cro: k }), b = await F.org();", async () => {
{ const k = id("cro"), a = await F.org({ cro: k }), b = await F.org();
  await rule("organisation", "trigger: a CRO number another organisation holds in organisation_name is refused", { ok: async () => ins("postgres", "organisation_name", { organisation_id: a, name: "Old Name Ltd", normalised_name: id("old name"), kind: "legal", source: "cro", cro_number: k }), refuse: async () => ins("postgres", "organisation_name", { organisation_id: b, name: "Other Ltd", normalised_name: id("other"), kind: "legal", source: "cro", cro_number: k }), expect: "already belongs" });
  const k2 = id("cro"); await ins("postgres", "organisation_name", { organisation_id: b, name: "B Ltd", normalised_name: id("b"), kind: "legal", source: "cro", cro_number: k2 });
  await rule("organisation", "trigger: an organisation cannot take a CRO number another organisation holds in organisation_name", { refuse: async () => F.org({ cro: k2 }), ok: async () => su("update organisation set cro_number=$2 where id=$1", [b, k2]), expect: "already belongs" }); }
});
await rule("organisation", "wrc_licence_number is null unless kind = agency", { refuse: async () => F.org({ kind: "employer", wrc: id("wrc") }), ok: async () => F.org({ kind: "agency", wrc: id("wrc") }) });
await blk("{ const o = await F.org(), o2 = await F.org(); await rule(\"organisatio", async () => {
{ const o = await F.org(), o2 = await F.org(); await rule("organisation", "merged_into_id differs from id", { refuse: async () => su("update organisation set merged_into_id=id where id=$1", [o]), ok: async () => su("update organisation set merged_into_id=$2 where id=$1", [o, o2]) }); }
});
await blk("{ const claimed = await F.org(), cu = await F.portal(); await F.member", async () => {
{ const claimed = await F.org(), cu = await F.portal(); await F.member(claimed, cu, { role: "account_owner" }); const absorbed = await F.org({ status: "unclaimed" }), survivor = await F.org();
  await rule("organisation", "merging: merged_into_id only when the absorbed organisation has no active member", { refuse: async () => P.app_admin.query("update organisation set merged_into_id=$2 where id=$1", [claimed, survivor]), ok: async () => P.app_admin.query("update organisation set merged_into_id=$2 where id=$1", [absorbed, survivor]), expect: "active members" });
  const k = id("cro"), a2 = await F.org({ status: "unclaimed", cro: k }), sv2 = await F.org(), nm = await ins("postgres", "organisation_name", { organisation_id: a2, name: "Absorbed Ltd", normalised_name: id("absorbed"), kind: "legal", source: "cro", cro_number: k });
  await rule("organisation", "merging: the absorbed organisation's names move to the survivor in the same transaction (one with a CRO number)", { ok: async () => tx("app_admin", async (c) => { await c.query("update organisation set merged_into_id=$2 where id=$1", [a2, sv2]); await c.query("update organisation_name set organisation_id=$2 where organisation_id=$1", [a2, sv2]); }) }); }
});
await blk("{ const o = await F.org(), a = await appr(\"big_company_entry\", \"organi", async () => {
{ const o = await F.org(), a = await appr("big_company_entry", "organisation", o), o2 = await F.org(), a2 = await appr("big_company_entry", "organisation", o2);
  const pend = await F.approval("big_company_entry", "organisation", o2, { by: s1, status: "pending" });
  await rule("organisation", "is_big_company = true needs a confirmed, unused big_company_entry request for this organisation", { refuse: async () => P.app_admin.query("update organisation set is_big_company=true where id=$1", [await F.org()]), ok: async () => P.app_admin.query("update organisation set is_big_company=true where id=$1", [o]), expect: "two-person" });
  await rule("organisation", "is_big_company: a used request cannot be used again", { ok: async () => P.app_admin.query("update organisation set is_big_company=false where id=$1", [o]), refuse: async () => P.app_admin.query("update organisation set is_big_company=true where id=$1", [o]), expect: "two-person" }); }
});
// claim and register
await blk("{ const o = await F.org({ status: \"unclaimed\" }), d = `${id(\"dom\")}.te", async () => {
{ const o = await F.org({ status: "unclaimed" }), d = `${id("dom")}.test`; await ins("postgres", "organisation_domain", { organisation_id: o, domain: d, source: "seed" });
  const users = []; for (let i = 0; i < 5; i++) users.push(await F.portal({ email: `${id("u")}@${d}` }));
  const t = await race(5, (i) => P.app_portal.query("select private.claim_organisation($1,$2) r", [users[i], o]));
  const w = t.ok.length, st = (await su("select status from organisation where id=$1", [o])).rows[0].status, owners = (await su("select count(*)::int n from membership where organisation_id=$1 and role='account_owner'", [o])).rows[0].n;
  line("organisation", "CONCURRENT: 5 people claim one organisation through claim_organisation, one winner", w === 1 && owners === 1, t.bad.length === 4, `${w} winner, ${owners} owner, status ${st} (seeded domain, so verified), losers: ${t.errors[0]}`);
  const o2 = await F.org({ status: "unclaimed" }), unv = await F.portal({ verified: false }), v = await F.portal();
  await rule("organisation", "claim_organisation: the login's email must be verified", { refuse: async () => P.app_portal.query("select private.claim_organisation($1,$2)", [unv, o2]), ok: async () => { const r = (await P.app_portal.query("select private.claim_organisation($1,$2) r", [v, o2])).rows[0].r; const q = (await su("select count(*)::int n from review_item where organisation_id=$1 and queue='account_review'", [o2])).rows[0].n; if (r.status !== "pending_review" || q !== 1) throw new Error(JSON.stringify(r) + ` items ${q}`); }, expect: "not verified" });
  const bd = `${id("bad")}.test`, bu = await F.portal({ email: `x@${bd}` }), o3 = await F.org({ status: "unclaimed" });
  await ins("postgres", "organisation_domain", { organisation_id: o3, domain: bd, source: "seed" }); // ported change: a ban on a domain must name one of the case organisation's domains
  await banFor(o3, { email_domain: bd });
  await rule("organisation", "claim_organisation: a banned email domain is refused", { refuse: async () => P.app_portal.query("select private.claim_organisation($1,$2)", [bu, o3]), expect: "banned" });
  const bc = id("cro"), o4 = await F.org({ status: "unclaimed", cro: bc });
  await banFor(o4, { cro_number: bc });
  await rule("organisation", "claim_organisation: a banned company number is refused", { refuse: async () => P.app_portal.query("select private.claim_organisation($1,$2)", [await F.portal(), o4]), expect: "banned" });
  const shared = `${id("shared")}.test`, o5 = await F.org({ status: "unclaimed" }), o6 = await F.org({ status: "unclaimed" });
  await ins("postgres", "organisation_domain", { organisation_id: o5, domain: shared, source: "seed" }); await ins("postgres", "organisation_domain", { organisation_id: o6, domain: shared, source: "admin" });
  await rule("organisation", "claim_organisation: a domain on several organisations goes to review (pending_review), not verified", { ok: async () => { const r = (await P.app_portal.query("select private.claim_organisation($1,$2) r", [await F.portal({ email: `a@${shared}` }), o5])).rows[0].r; if (r.status !== "pending_review") throw new Error(r.status); } });
  const cro = id("cro"); await ins("postgres", "cro_company", { cro_number: cro, name: "First Time Ltd", normalised_name: "first time", status: "Normal", last_seen_on: "2026-11-08" });
  await rule("organisation", "register_organisation: first-time sponsor, CRO number looked up and written on organisation, always pending_review", { ok: async () => { const r = (await P.app_portal.query("select private.register_organisation($1,'employer','First Time Ltd',$2,null) r", [await F.portal(), cro])).rows[0].r; const o = (await su("select status, cro_number, signup_path from organisation where id=$1", [r.organisation_id])).rows[0]; if (!r.found_in_register || o.status !== "pending_review" || o.cro_number !== cro) throw new Error(JSON.stringify([r, o])); } });
  await rule("organisation", "register_organisation: a second organisation with the same CRO number is refused", { refuse: async () => P.app_portal.query("select private.register_organisation($1,'employer','Copy Ltd',$2,null)", [await F.portal(), cro]) });
  const lic = id("LIC").toUpperCase(); await ins("postgres", "wrc_licence", { licence_number: lic, agency_name: "Fake Agency" });
  await rule("organisation", "register_organisation: an agency, licence looked up in wrc_licence", { ok: async () => { const r = (await P.app_portal.query("select private.register_organisation($1,'agency','Fake Agency',null,$2) r", [await F.portal(), lic])).rows[0].r; if (!r.found_in_register) throw new Error(JSON.stringify(r)); } });
  await rule("organisation", "register_organisation: refuses a login whose email is not verified", { refuse: async () => P.app_portal.query("select private.register_organisation($1,'employer','X Ltd',$2,null)", [await F.portal({ verified: false }), id("cro")]), expect: "not verified" }); }
});
await blk("{ const nm = () => id(\"name\"), o = await F.org(), o2 = await F.org(); ", async () => {
{ const nm = () => id("name"), o = await F.org(), o2 = await F.org(); const n = (org_, n_, k, c) => ins("postgres", "organisation_name", { organisation_id: org_, name: n_, normalised_name: n_, kind: k, source: "admin", cro_number: c });
  const a = nm(); await rule("organisation_name", "unique normalised_name where kind = alias", { ok: async () => n(o, a, "alias", null), refuse: async () => n(o2, a, "alias", null) });
  const b = nm(); await rule("organisation_name", "unique normalised_name where kind = legal and cro_number is null", { ok: async () => n(o, b, "legal", null), refuse: async () => n(o2, b, "legal", null) });
  const cro = id("cro"), oldN = nm(), newN = nm();
  await rule("organisation_name", "unique (cro_number, normalised_name); a renamed company keeps its old name under the same number", { ok: async () => { await n(o, oldN, "legal", cro); await n(o, newN, "legal", cro); }, refuse: async () => n(o, oldN, "legal", cro) });
  await rule("organisation_name", "the CRO trigger: one company number cannot sit under two organisations", { refuse: async () => n(o2, nm(), "legal", cro), expect: "already belongs" });
  // NOTE a DETE name that cleans to an existing name links to that row: loader rule (on conflict), run in 08-load.sql, see the load log
  }
});
await blk("{ const o = await F.org(), o2 = await F.org(), d = `${id(\"d\")}.test`; ", async () => {
{ const o = await F.org(), o2 = await F.org(), d = `${id("d")}.test`;
  await rule("organisation_domain", "unique (organisation_id, domain)", { ok: async () => ins("postgres", "organisation_domain", { organisation_id: o, domain: d, source: "admin" }), refuse: async () => ins("postgres", "organisation_domain", { organisation_id: o, domain: d, source: "admin" }) });
  await rule("organisation_domain", "the domain alone is not unique (a domain on several organisations goes to review)", { ok: async () => ins("postgres", "organisation_domain", { organisation_id: o2, domain: d, source: "admin" }) }); }
});
await blk("{ const k = id(\"cro\"); await rule(\"cro_company\", \"unique cro_number\", ", async () => {
{ const k = id("cro"); await rule("cro_company", "unique cro_number", { ok: async () => ins("postgres", "cro_company", { cro_number: k, name: "A", normalised_name: "a", status: "Normal", last_seen_on: "2026-11-08" }), refuse: async () => ins("postgres", "cro_company", { cro_number: k, name: "A", normalised_name: "a", status: "Normal", last_seen_on: "2026-11-08" }) }); }
});
await blk("{ const n_ = id(\"dete\"); const d = (m) => ins(\"postgres\", \"dete_permit", async () => {
{ const n_ = id("dete"); const d = (m) => ins("postgres", "dete_permit_count", { dete_name: n_, year: 2026, month: m, permits: 5 });
  await rule("dete_permit_count", "unique (dete_name, year, month): re-import cannot double count", { ok: async () => d(1), refuse: async () => d(1) });
  await rule("dete_permit_count", "nulls not distinct: a whole-year figure cannot be imported twice", { ok: async () => d(null), refuse: async () => d(null) }); }
});
await blk("{ const k = id(\"lic\"); await rule(\"wrc_licence\", \"unique licence_numbe", async () => {
{ const k = id("lic"); await rule("wrc_licence", "unique licence_number", { ok: async () => ins("postgres", "wrc_licence", { licence_number: k }), refuse: async () => ins("postgres", "wrc_licence", { licence_number: k }) }); }
});
await blk("{ const o = await F.org(), a = await F.portal(), b = await F.portal(),", async () => {
{ const o = await F.org(), a = await F.portal(), b = await F.portal(), m1 = await F.member(o, a, { role: "account_owner" }), m2 = await F.member(o, b);
  await rule("membership", "one_owner_per_org; transfer demotes then promotes in one transaction, as app_admin (the portal has no write on membership; its transfer function comes with the employer login slice)", { refuse: async () => su("update membership set role='account_owner' where id=$1", [m2]), ok: async () => tx("app_admin", async (c) => { await c.query("update membership set role='recruiter' where id=$1", [m1]); await c.query("update membership set role='account_owner' where id=$1", [m2]); }) }); }
});
await blk("{ const a = await F.portal(), o = await F.org(), o2 = await F.org(), o", async () => {
{ const a = await F.portal(), o = await F.org(), o2 = await F.org(), o3 = await F.org(), m = await F.member(o, a);
  await rule("membership", "one_company_per_login (#130)", { refuse: async () => F.member(o2, a), ok: async () => { await su("update membership set status='removed', removed_at=now() where id=$1", [m]); await F.member(o2, a); } });
  await rule("membership", "an invite to a second company may wait while the first is active", { ok: async () => F.member(o3, null, { status: "invited", email: `${id("i")}@example.test` }) }); }
});
await blk("{ const a = await F.portal(), o = await F.org(); await F.member(o, a, ", async () => {
{ const a = await F.portal(), o = await F.org(); await F.member(o, a, { status: "invited", email: `${id("i")}@x.test` });
  await rule("membership", "unique (organisation_id, portal_user_id) where status is not removed", { refuse: async () => F.member(o, a, { status: "join_requested" }), ok: async () => F.member(await F.org(), a, { status: "join_requested" }) }); }
});
await blk("{ const o = await F.org(), e = `${id(\"i\")}@x.test`; await F.member(o, ", async () => {
{ const o = await F.org(), e = `${id("i")}@x.test`; await F.member(o, null, { status: "invited", email: e });
  await rule("membership", "unique (organisation_id, lower(invited_email)) where status = invited", { refuse: async () => F.member(o, null, { status: "invited", email: e.toUpperCase() }), ok: async () => F.member(o, null, { status: "invited", email: `${id("i")}@x.test` }) }); }
});
await blk("{ const o = await F.org(); await rule(\"membership\", \"portal_user_id or", async () => {
{ const o = await F.org(); await rule("membership", "portal_user_id or invited_email is present unless status = removed", { refuse: async () => F.member(o, null, { status: "active" }), ok: async () => F.member(o, null, { status: "removed" }) }); }
});
await blk("{ const a = await F.portal(), others = []; for (let i = 0; i < 5; i++)", async () => {
{ const a = await F.portal(), others = []; for (let i = 0; i < 5; i++) others.push(await F.org());
  const t = await race(5, (i) => P.app_admin.query("insert into membership(organisation_id,portal_user_id,role,status) values($1,$2,'viewer','active')", [others[i], a]));
  line("membership", "CONCURRENT: 5 invites accepted at once by one login, one wins (as app_admin)", t.ok.length === 1, t.ok.length >= 1, `${t.ok.length} succeeded, ${t.bad.length} refused by the unique index`); }
});
await blk("{ const o = await F.org(), inv = await F.member(o, null, { status: \"in", async () => {
{ const o = await F.org(), inv = await F.member(o, null, { status: "invited", email: `${id("i")}@x.test` });
  await rule("membership", "an invite email goes through email_outbox by membership_id alone", { ok: async () => ins("app_portal", "email_outbox", { template: "invite", membership_id: inv, dedupe_key: id("dk") }, null), refuse: async () => ins("app_portal", "email_outbox", { template: "invite", membership_id: inv, portal_user_id: pu, dedupe_key: id("dk") }, null) }); }
});
// sponsorship statements
await blk("{ const ct = await F.text(\"sponsorship_statement\"), j = await live(), ", async () => {
{ const ct = await F.text("sponsorship_statement"), j = await live(), j2 = await live({ organisation_id: org2 });
  const st = (o) => ins("app_portal", "sponsorship_statement", { consent_text_id: ct, kind: "own_company", ...o });
  await rule("sponsorship_statement", "one_current_statement", { ok: async () => st({ job_id: j, organisation_id: org, signer_membership_id: mem }), refuse: async () => st({ job_id: j, organisation_id: org, signer_membership_id: mem }) });
  await rule("sponsorship_statement", "renewal supersedes the old row and inserts the new one in one transaction, as app_portal", { ok: async () => tx("app_portal", async (c) => { await c.query("update sponsorship_statement set superseded_at=now() where job_id=$1 and superseded_at is null", [j]); await c.query("insert into sponsorship_statement(job_id,organisation_id,kind,consent_text_id,signer_membership_id) values($1,$2,'own_company',$3,$4)", [j, org, ct, mem]); }) });
  await rule("sponsorship_statement", "composite foreign key (signer_membership_id, organisation_id)", { refuse: async () => st({ job_id: j2, organisation_id: org2, signer_membership_id: mem }), ok: async () => st({ job_id: j2, organisation_id: org2, signer_membership_id: mem2 }) });
  const plain = await F.member(org, await F.portal(), { role: "recruiter", signer: false }), gone = await F.member(org, await F.portal(), { role: "recruiter", signer: true, status: "removed" }), signer = await F.member(org, await F.portal(), { role: "recruiter", signer: true });
  const j3 = await live(), j4 = await live(), j5 = await live();
  await rule("sponsorship_statement", "signer trigger: a member without the signer switch cannot sign", { refuse: async () => st({ job_id: j3, organisation_id: org, signer_membership_id: plain }), ok: async () => st({ job_id: j3, organisation_id: org, signer_membership_id: signer }), expect: "signer refused" });
  await rule("sponsorship_statement", "signer trigger: a removed member cannot sign; the account owner always can", { refuse: async () => st({ job_id: j4, organisation_id: org, signer_membership_id: gone }), ok: async () => st({ job_id: j4, organisation_id: org, signer_membership_id: mem }), expect: "signer refused" });
  await rule("sponsorship_statement", "on_behalf_of_client requires on_behalf_of_name and written_authority_on_file", { refuse: async () => st({ job_id: j5, organisation_id: org, signer_membership_id: mem, kind: "on_behalf_of_client", on_behalf_of_name: "Client Ltd" }), ok: async () => st({ job_id: j5, organisation_id: org, signer_membership_id: mem, kind: "on_behalf_of_client", on_behalf_of_name: "Client Ltd", written_authority_on_file: true }) });
  const j6 = await live(), j7 = await live();
  const pend = await F.approval("manual_post_sponsor_confirmed", "sponsorship_statement", j7, { by: s1, status: "pending" }), wrongJob = await appr("manual_post_sponsor_confirmed", "sponsorship_statement", j6);
  const adm = (ar) => ins("app_admin", "sponsorship_statement", { job_id: j7, organisation_id: org, consent_text_id: ct, kind: "admin_on_behalf", confirmation_file_key: "f", approval_request_id: ar });
  await rule("sponsorship_statement", "admin_on_behalf needs a confirmed manual_post_sponsor_confirmed request for this job: pending refused", { refuse: async () => adm(pend), expect: "two-person" });
  await rule("sponsorship_statement", "admin_on_behalf: a confirmed request for another job is refused", { refuse: async () => adm(wrongJob), expect: "two-person" });
  const j8 = await live(); await rule("sponsorship_statement", "the other kinds require signer_membership_id", { refuse: async () => st({ job_id: j8, organisation_id: org }), ok: async () => st({ job_id: j8, organisation_id: org, signer_membership_id: mem }) });
  const sid = (await su("select id from sponsorship_statement where job_id=$1", [j8])).rows[0].id;
  await rule("sponsorship_statement", "app roles never update a row except superseded_at (app_portal and app_admin)", { refuse: async () => { const errs = []; for (const r of ["app_portal", "app_admin"]) await P[r].query("update sponsorship_statement set signer_name='changed' where id=$1", [sid]).then(() => errs.push(r), () => {}); if (!errs.length) throw new Error("both refused"); }, ok: async () => P.app_admin.query("update sponsorship_statement set superseded_at=now() where id=$1", [sid]) }); }
});
// pay floors
await blk("{ const big = await F.org(), ab = await appr(\"big_company_entry\", \"org", async () => {
{ const big = await F.org(), ab = await appr("big_company_entry", "organisation", big); await su("update organisation set is_big_company=true where id=$1", [big]);
  const u = await F.portal(), m = await F.member(big, u, { role: "account_owner", signer: true }), ct = await F.text("pay_floor");
  const floor = (o) => ins("postgres", "pay_floor", { organisation_id: big, role_family: "2134", floor_eur: 60000, consent_text_id: ct, signer_membership_id: m, valid_until: new Date(Date.now() + 3e10), ...o });
  const f1 = await floor({});
  await rule("pay_floor", "one pending_check floor per (organisation_id, role_family)", { refuse: async () => floor({}) });
  const a1 = await appr("pay_floor", "pay_floor", f1);
  await rule("pay_floor", "one active floor plus one pending floor may exist, so a signer can re-sign before expiry", { ok: async () => { await P.app_admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [f1, a1]); await floor({}); } });
  const f2 = (await su("select id from pay_floor where organisation_id=$1 and status='pending_check'", [big])).rows[0].id, a2 = await appr("pay_floor", "pay_floor", f2);
  await rule("pay_floor", "accepting the new floor: activating it while the old is active is refused; old set replaced first in the same transaction works", { refuse: async () => P.app_admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [f2, a2]), ok: async () => tx("app_admin", async (c) => { await c.query("update pay_floor set status='replaced' where id=$1", [f1]); await c.query("update pay_floor set status='active', approval_request_id=$2, replaces_id=$3 where id=$1", [f2, a2, f1]); }) });
  const big2 = await F.org(); await appr("big_company_entry", "organisation", big2); await su("update organisation set is_big_company=true where id=$1", [big2]);
  await rule("pay_floor", "composite foreign key (signer_membership_id, organisation_id)", { refuse: async () => ins("postgres", "pay_floor", { organisation_id: big2, role_family: "9999", floor_eur: 1, consent_text_id: ct, signer_membership_id: m, valid_until: new Date(Date.now() + 1e9) }) });
  const plain = await F.member(big, await F.portal(), { signer: false });
  await rule("pay_floor", "signer trigger: a member without the signer switch cannot sign a floor", { refuse: async () => floor({ role_family: "2230", signer_membership_id: plain }), ok: async () => floor({ role_family: "2230" }), expect: "signer refused" });
  await rule("pay_floor", "floor_eur > 0", { refuse: async () => floor({ role_family: "1001", floor_eur: 0 }), ok: async () => floor({ role_family: "1001" }) });
  await rule("pay_floor", "valid_until > signed_at", { refuse: async () => floor({ role_family: "1002", valid_until: daysAgo(1) }), ok: async () => floor({ role_family: "1002" }) });
  await rule("pay_floor", "status = active requires approval_request_id", { refuse: async () => floor({ role_family: "1003", status: "active" }) });
  const f3 = await floor({ role_family: "1004" }), pend = await F.approval("pay_floor", "pay_floor", f3, { by: s1, status: "pending" }), refusedA = await F.approval("pay_floor", "pay_floor", f3, { by: s1, confirmer: s2, status: "refused" });
  const wrongKind = await appr("ban", "pay_floor", f3), wrongTarget = await appr("pay_floor", "pay_floor", f1), good = await appr("pay_floor", "pay_floor", f3);
  for (const [label, ar] of [["one person's pending request", pend], ["a refused request", refusedA], ["a confirmed request of the wrong kind", wrongKind], ["a confirmed request for another floor", wrongTarget]])
    await rule("pay_floor", `approval trigger: a floor cannot go active on ${label}`, { refuse: async () => P.app_admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [f3, ar]), expect: "two-person" });
  await rule("pay_floor", "approval trigger: a used request cannot make its own floor active again", { refuse: () => P.app_admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [f1, a1]), expect: "already used" });
  await rule("pay_floor", "approval trigger: a confirmed pay_floor request for this floor works", { ok: async () => P.app_admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [f3, good]) });
  const agency = await F.org({ kind: "agency" }); await appr("big_company_entry", "organisation", agency); await su("update organisation set is_big_company=true where id=$1", [agency]);
  const am = await F.member(agency, await F.portal(), { role: "account_owner" }), small = await F.org(), sm = await F.member(small, await F.portal(), { role: "account_owner" });
  await rule("pay_floor", "insert trigger refuses an agency, even on the big-company list (#100)", { refuse: async () => ins("postgres", "pay_floor", { organisation_id: agency, role_family: "9999", floor_eur: 1, consent_text_id: ct, signer_membership_id: am, valid_until: new Date(Date.now() + 1e9) }), expect: "big-company" });
  await rule("pay_floor", "insert trigger refuses an employer not on the big-company list, and queues pay_floor_check for a good one", { refuse: async () => ins("postgres", "pay_floor", { organisation_id: small, role_family: "9999", floor_eur: 1, consent_text_id: ct, signer_membership_id: sm, valid_until: new Date(Date.now() + 1e9) }), ok: async () => { const f = await ins("app_portal", "pay_floor", { organisation_id: big, role_family: "1005", floor_eur: 1, consent_text_id: ct, signer_membership_id: m, valid_until: new Date(Date.now() + 1e9) }); const q = (await su("select count(*)::int n from review_item where pay_floor_id=$1 and queue='pay_floor_check'", [f])).rows[0].n; if (q !== 1) throw new Error(`${q} items`); }, expect: "big-company" });
  const ff = await floor({ role_family: "1006" }); await su("update pay_floor set status='found_false' where id=$1", [ff]);
  const fw = await floor({ role_family: "1007" });
  await rule("pay_floor", "write guard: app_portal moves status only from pending_check or active to withdrawn (cannot reinstate found_false)", { refuse: async () => P.app_portal.query("update pay_floor set status='pending_check' where id=$1", [ff]), ok: async () => P.app_portal.query("update pay_floor set status='withdrawn' where id=$1", [fw]), expect: "pay floor guard" });
  await rule("pay_floor", "app_portal cannot set a found_false floor back to active either (the approval trigger refuses first)", { refuse: async () => P.app_portal.query("update pay_floor set status='active' where id=$1", [ff]) });
  const ended = (await su("select ended_at is not null e from pay_floor where id=$1", [fw])).rows[0].e;
  line("pay_floor", "ended_at is set when a floor stops being pending or active (it starts the portal_signer_name clock)", null, ended, ended ? "set by the guard trigger (my pick, the design names no writer)" : "not set");
  await rule("pay_floor", "old floors do not block removing the big-company flag later", { ok: async () => su("update organisation set is_big_company=false where id=$1", [big]) }); }
});
// ===== staff
await blk("{ const a = await F.staff(); const e = `${id(\"e\")}@example.test`; aw", async () => {
{ const a = await F.staff(); const e = `${id("e")}@example.test`;
  await rule("staff_user", "email unique within this pool", { refuse: async () => { await su("insert into staff_user(id,name,email,email_verified,created_at,updated_at) values($1,'a',$2,true,now(),now())", [id("s"), e]); await su("insert into staff_user(id,name,email,email_verified,created_at,updated_at) values($1,'a',$2,true,now(),now())", [id("s"), e]); }, ok: async () => F.staff() });
  const tok = id("tok"); await rule("staff_session", "session token unique", { ok: async () => su("insert into staff_session(id,expires_at,token,created_at,updated_at,user_id) values($1,now()+interval '1 hour',$2,now(),now(),$3)", [id("ss"), tok, a]), refuse: async () => su("insert into staff_session(id,expires_at,token,created_at,updated_at,user_id) values($1,now()+interval '1 hour',$2,now(),now(),$3)", [id("ss"), tok, a]) });
  }
});
await blk("{ const first = await F.staff(), second = await F.staff(), third = awa", async () => {
{ const first = await F.staff(), second = await F.staff(), third = await F.staff(), fourth = await F.staff();
  await rule("staff_role", "CHECK: administrator needs approval_request_id or seeded_by_owner", { refuse: async () => ins("app_admin", "staff_role", { staff_user_id: first, role: "administrator" }) });
  await rule("staff_role", "the first two administrators through seeded_by_owner, which only portal_owner can set", { refuse: async () => ins("app_admin", "staff_role", { staff_user_id: first, role: "administrator", seeded_by_owner: true }), ok: async () => { await ins("portal_owner", "staff_role", { staff_user_id: first, role: "administrator", seeded_by_owner: true }); await ins("portal_owner", "staff_role", { staff_user_id: second, role: "administrator", seeded_by_owner: true }); } });
  /* ported change: a request is proposed and confirmed by the acting staff member (set local app.staff_user_id), not by writing the columns */
  const asStaff = (who, sql, args = []) => tx("app_admin", async (c) => { await c.query("select set_config('app.staff_user_id',$1,true)", [who]); return c.query(sql, args); });
  const pr = await F.approval("grant_administrator", "staff_role", third, { by: first, status: "pending" });
  await rule("approval_request", "self-approval is refused, with no exception", { refuse: async () => asStaff(first, "update approval_request set status='confirmed' where id=$1", [pr]), ok: async () => asStaff(second, "update approval_request set status='confirmed' where id=$1", [pr]) });
  await rule("staff_role", "third administrator through a confirmed grant_administrator request", { ok: async () => ins("app_admin", "staff_role", { staff_user_id: third, role: "administrator", approval_request_id: pr }) });
  const own = await F.approval("grant_administrator", "staff_role", fourth, { by: fourth, status: "pending" });
  const wrongT = await appr("grant_administrator", "staff_role", third), wrongK = await appr("strike_2", "staff_role", fourth), refusedA = await F.approval("grant_administrator", "staff_role", fourth, { by: s1, confirmer: s2, status: "refused" });
  for (const [label, ar] of [["their own pending request", own], ["a confirmed request for someone else", wrongT], ["a confirmed request of the wrong kind", wrongK], ["a refused request", refusedA]])
    await rule("staff_role", `approval trigger: nobody becomes administrator from ${label}`, { refuse: async () => ins("app_admin", "staff_role", { staff_user_id: fourth, role: "administrator", approval_request_id: ar }), expect: "two-person" });
  await rule("staff_role", "approval trigger: a used request cannot grant the same role again after it was taken away", { refuse: async () => { await P.app_admin.query("delete from staff_role where staff_user_id=$1 and role='administrator'", [third]); await ins("app_admin", "staff_role", { staff_user_id: third, role: "administrator", approval_request_id: pr }); }, expect: "already used" }); }
});
// ===== services
await blk("{ const c = await F.cand(), cs = await ins(\"postgres\", \"consent_record", async () => {
{ const c = await F.cand(), cs = await ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: await F.text("services_request") }), j = await live();
  // the consent record must belong to the same person as the case (migration 0005, services_case_guard), so another candidate gets their own
  const sc = async (o) => ins("postgres", "services_case", { consent_record_id: o.candidate_user_id && o.candidate_user_id !== c ? await ins("postgres", "consent_record", { candidate_user_id: o.candidate_user_id, consent_text_id: await F.text("services_request") }) : cs, ...o });
  await rule("services_case", "exactly one requester, unless erased", { refuse: async () => sc({ candidate_user_id: c, portal_user_id: pu, job_id: j }), ok: async () => sc({ requester_erased_at: new Date(), job_id: j }) });
  await rule("services_case", "status closed needs closed_at and close_reason", { refuse: async () => sc({ candidate_user_id: await F.cand(), status: "closed", closed_at: new Date() }), ok: async () => sc({ candidate_user_id: await F.cand(), status: "closed", closed_at: new Date(), close_reason: "decided" }) });
  const t1 = await race(10, () => ins("app_candidate", "candidate_services_case", { candidate_user_id: c, job_id: j, consent_record_id: cs }, null));
  line("services_case", "CONCURRENT: ten taps on candidate and job make one case, through the candidate view", t1.ok.length === 1, null, `${t1.ok.length} of 10`);
  const t2 = await race(10, () => ins("app_candidate", "candidate_services_case", { candidate_user_id: c, consent_record_id: cs }, null));
  line("services_case", "CONCURRENT: ten taps with no job chosen make one case (nulls not distinct, build 17)", t2.ok.length === 1, null, `${t2.ok.length} of 10`);
  const pcs = await ins("postgres", "consent_record", { portal_user_id: pu, consent_text_id: await F.text("services_request") });
  const t3 = await race(10, () => ins("app_portal", "portal_services_case", { portal_user_id: pu, job_id: j, consent_record_id: pcs, dedupe_key: "one-form-load" }, null));
  line("services_case", "CONCURRENT: ten taps from a portal user make one case, through the portal view", t3.ok.length === 1, null, `${t3.ok.length} of 10`);
  await su("update services_case set status='closed', closed_at=now(), close_reason='decided' where candidate_user_id=$1 and job_id=$2", [c, j]);
  await rule("services_case", "a closed case does not stop a new one", { ok: async () => sc({ candidate_user_id: c, job_id: j }) });
  const cidC = await F.cand(), cid = await sc({ candidate_user_id: cidC, job_id: j }); // cidC owns the case: a document names the case's own candidate (migration 0005, case_document_guard)
  const t = await race(5, (i) => P.app_admin.query("update services_case set assigned_staff_user_id=$1 where id=$2 and assigned_staff_user_id is null returning id", [[s1, s2, s3, s1, s2][i], cid]));
  line("services_case", "CONCURRENT: 5 handlers claim one case, one wins", t.values.filter((v) => v?.rowCount === 1).length === 1, t.bad.length === 0, `${t.values.filter((v) => v?.rowCount === 1).length} winner`);
  const doc = (o) => ins("postgres", "case_document", { services_case_id: cid, storage_key: "k", ...o });
  await rule("case_document", "at most one of the three uploader columns", { refuse: async () => doc({ candidate_user_id: cidC, portal_user_id: pu }), ok: async () => doc({ candidate_user_id: cidC }) });
  await rule("case_document", "(storage_key is null) = (copy_deleted_at is not null)", { refuse: async () => doc({ copy_deleted_at: new Date() }), ok: async () => doc({ storage_key: null, copy_deleted_at: new Date() }) });
  const q = (o) => ins("postgres", "case_quote", { services_case_id: cid, amount_eur: 100, ...o });
  await rule("case_quote", "amount_eur > 0", { refuse: async () => q({ amount_eur: 0 }), ok: async () => q({ status: "draft" }) });
  await rule("case_quote", "partial unique (services_case_id) where status in (draft, sent)", { refuse: async () => q({ status: "sent" }), ok: async () => q({ status: "paid", invoice_number: id("INV") }) });
  const inv = id("INV"); await rule("case_quote", "unique invoice_number where not null", { ok: async () => q({ status: "paid", invoice_number: inv }), refuse: async () => q({ status: "paid", invoice_number: inv }) });
  await rule("case_note", "no clash rule: a handler can add a note", { ok: async () => ins("app_admin", "case_note", { services_case_id: cid, author_staff_user_id: s1, body: "note" }) }); }
});
// ===== content and contact
await blk("{ const slug = id(\"slug\"), cp = (o) => ins(\"app_admin\", \"content_page\"", async () => {
{ const slug = id("slug"), cp = (o) => ins("app_admin", "content_page", { kind: "guide", slug: id("s"), title: "t", body: "b", ...o });
  await rule("content_page", "unique (kind, slug)", { ok: async () => cp({ slug }), refuse: async () => cp({ slug }) });
  await rule("content_page", "a published guide or update needs source_url and checked_on", { refuse: async () => cp({ status: "published", published_at: new Date() }), ok: async () => cp({ status: "published", published_at: new Date(), source_url: "https://enterprise.gov.ie/", checked_on: "2026-11-01" }) });
  await rule("content_page", "published needs published_at", { refuse: async () => cp({ kind: "help", status: "published" }), ok: async () => cp({ kind: "help", status: "published", published_at: new Date() }) }); }
});
await blk("{ const c = await F.cand(), cm = (o) => ins(\"postgres\", \"contact_messa", async () => {
{ const c = await F.cand(), cm = (o) => ins("postgres", "contact_message", { surface: "candidate_site", from_email: "x@example.test", topic: "general", body: "hello", ...o });
  await rule("contact_message", "at most one of the two user columns; none means a visitor", { refuse: async () => cm({ candidate_user_id: c, portal_user_id: pu }), ok: async () => cm({}) });
  await rule("contact_message", "closed needs closed_at", { refuse: async () => cm({ status: "closed" }), ok: async () => cm({ status: "closed", closed_at: new Date() }) });
  const m = await cm({}); const t = await race(5, (i) => P.app_admin.query("update contact_message set claimed_by_staff_user_id=$1, claimed_at=now(), status='claimed' where id=$2 and claimed_by_staff_user_id is null returning id", [[s1, s2, s3, s1, s2][i], m]));
  line("contact_message", "CONCURRENT: 5 staff claim one message, one wins", t.values.filter((v) => v?.rowCount === 1).length === 1, t.bad.length === 0, `${t.values.filter((v) => v?.rowCount === 1).length} winner`);
  const dr = await ins("app_candidate", "contact_message", { surface: "candidate_site", candidate_user_id: c, from_email: "x@example.test", topic: "data_request", body: "Please delete my data" });
  const items = (await su("select count(*)::int n from review_item where contact_message_id=$1 or candidate_user_id=$2", [dr, c])).rows[0].n;
  // NOTE "A data_request message also gets a review_item": no trigger is named and the sender cannot write review_item; the item has to be made by the admin app later (read as code)
  }
});
// ===== trust and safety
await blk("{ const j = await live(), c = await F.cand(), rp = (o) => ins(\"postgre", async () => {
{ const j = await live(), c = await F.cand(), rp = (o) => ins("postgres", "report", { target_kind: "job", reason: "other", ...o });
  await rule("report", "exactly one target, or target_wiped_at", { refuse: async () => rp({ target_job_id: j, target_organisation_id: org }), ok: async () => rp({ target_job_id: j }) });
  await rule("report", "no target at all only once wiped", { refuse: async () => rp({}), ok: async () => rp({ target_wiped_at: new Date() }) });
  await rule("report", "the filled target column matches target_kind (build 17)", { refuse: async () => rp({ target_kind: "organisation", target_job_id: j }), ok: async () => rp({ target_kind: "organisation", target_organisation_id: org }) });
  await rule("report", "at most one reporter column; none means a visitor", { refuse: async () => rp({ target_job_id: j, reporter_candidate_user_id: c, reporter_portal_user_id: pu }), ok: async () => rp({ target_job_id: j }) });
  await rule("report", "a cleared or upheld report has both reporter columns empty (#99)", { refuse: async () => rp({ target_job_id: j, reporter_portal_user_id: pu, status: "cleared" }), ok: async () => rp({ target_job_id: j, status: "cleared" }) });
  const j2 = await live(); await rule("report", "one open report per candidate and job", { ok: async () => rp({ target_job_id: j2, reporter_candidate_user_id: c }), refuse: async () => rp({ target_job_id: j2, reporter_candidate_user_id: c }) });
  await su("update report set status='cleared', reporter_candidate_user_id=null where target_job_id=$1", [j2]);
  await rule("report", "a closed report does not stop a new one", { ok: async () => rp({ target_job_id: j2, reporter_candidate_user_id: c }) });
  const j3 = await live(); await rule("report", "one open report per portal user and job", { ok: async () => rp({ target_job_id: j3, reporter_portal_user_id: pu }), refuse: async () => rp({ target_job_id: j3, reporter_portal_user_id: pu }) }); }
});
await blk("{ const o = await F.org(), j = await live({ organisation_id: o }), r =", async () => {
{ const o = await F.org(), j = await live({ organisation_id: o }), r = await ins("postgres", "report", { target_kind: "job", target_job_id: j, reason: "other" });
  const sk = (x = {}) => ins("postgres", "strike", { organisation_id: o, case_kind: "false_claim", reason_code: "false_sponsorship", ...x });
  await rule("strike", "unique (report_id, organisation_id) where report_id is not null", { ok: async () => sk({ report_id: r }), refuse: async () => sk({ report_id: r }) });
  await rule("strike", "level is empty for instant_ban", { refuse: async () => sk({ case_kind: "instant_ban", reason_code: "fake_job", level: 1 }), ok: async () => sk({ case_kind: "instant_ban", reason_code: "fake_job" }) });
  await rule("strike", "level is set for outcome strike", { refuse: async () => sk({ outcome: "strike" }), ok: async () => sk({ outcome: "strike", level: 1 }) });
  await rule("strike", "outcome strike at level 2 or 3, and outcome ban, need approval_request_id", { refuse: async () => sk({ outcome: "strike", level: 2 }) });
  await rule("strike", "the appeal is decided by someone else", { refuse: async () => sk({ decided_by_staff_user_id: s1, appeal_decided_by_staff_user_id: s1 }), ok: async () => sk({ decided_by_staff_user_id: s1, appeal_decided_by_staff_user_id: s2 }) });
  const ap = await sk({ stage: "decided", outcome: "strike", level: 1, decided_at: new Date(), decided_by_staff_user_id: s1, appeal_due_at: new Date(Date.now() + 864e5 * 7) });
  /* the 7-day appeal window check is removed (S-C2); the appeal itself is now made by this fixture, as postgres (app_portal no longer writes appealed_at) */
  await su("update strike set appeal_text='Appeal', appealed_at=now() where id=$1", [ap]);
  await P.app_portal.query("update strike set appealed_at='2020-01-01' where id=$1", [ap]).then(async () => line("strike", "an employer cannot backdate replied_at or appealed_at (the portal writes those columns itself)", false, null, `accepted: appealed_at now reads ${(await su("select appealed_at from strike where id=$1", [ap])).rows[0].appealed_at.toISOString()}`), (e) => line("strike", "an employer cannot backdate replied_at or appealed_at", true, null, e.message));
  /* ported change: the trigger stamps appeal_decided_by and appeal_decided_at from the acting id (set local app.staff_user_id) when the stage moves to upheld */
  await tx("postgres", async (c) => { await c.query("select set_config('app.staff_user_id',$1,true)", [s2]); await c.query("update strike set stage='upheld' where id=$1", [ap]); });
  await P.app_portal.query("update strike set appeal_text='Rewritten after the decision' where id=$1", [ap]).then(() => line("strike", "\"only one appeal can exist\": the appeal text cannot be rewritten after the appeal is decided", false, null, "accepted: inside the window the employer can overwrite the appeal after staff decided it"), (e) => line("strike", "the appeal text cannot be rewritten after the appeal is decided", true, null, e.message)); }
});
await blk("{ const o = await F.org(), mk = async () => ins(\"postgres\", \"strike\", ", async () => {
{ const o = await F.org(), mk = async () => ins("postgres", "strike", { organisation_id: o, case_kind: "instant_ban", reason_code: "fake_job" });
  const ban = (x) => ins("app_admin", "ban", { reason_code: "fake_job", ...x });
  await rule("ban", "num_nonnulls(cro_number, email_domain) >= 1", { refuse: async () => { const b = await mk(); await ban({ strike_id: b, approval_request_id: await appr("ban", "ban", b) }); } });
  await rule("ban", "strike_id and approval_request_id are required", { refuse: async () => ban({ cro_number: id("c") }) });
  /* ported change: the ban to lift is built the way the migrations take one (the strike decided as ban plus the ban row, one shared request) */
  const dm = `${id("d")}.test`; await ins("postgres", "organisation_domain", { organisation_id: o, domain: dm, source: "seed" });
  const bid = (await su("select id from ban where strike_id=$1", [await banFor(o, { email_domain: dm })])).rows[0].id;
  await rule("ban", "delete trigger: lifting a ban needs a confirmed, unused ban_lift request for this ban", { refuse: async () => P.app_admin.query("delete from ban where id=$1", [bid]), ok: async () => { await appr("ban_lift", "ban", bid); await P.app_admin.query("delete from ban where id=$1", [bid]); }, expect: "two-person" });
  // one decision, two rows that each need an unused ban request
  /* ported change (#137 a): the domain exists before the case opens, since a ban covers only the domains the organisation had then */
  const dm3 = `${id("d")}.test`; await ins("postgres", "organisation_domain", { organisation_id: o, domain: dm3, source: "seed" });
  const b3 = await mk(), one = await appr("ban", "strike", b3);
  /* ported change: the strike decision and the ban row are written together by the acting staff member (set local app.staff_user_id), as the migrations take them */
  const both = () => tx("app_admin", async (c) => { await c.query("select set_config('app.staff_user_id',$1,true)", [s1]); await c.query("update strike set outcome='ban', stage='decided', approval_request_id=$2 where id=$1", [b3, one]); await ins(c, "ban", { reason_code: "fake_job", email_domain: dm3, strike_id: b3, approval_request_id: one }); });
  await both().then(() => line("ban", "one confirmed ban request covers both the strike outcome and the ban row", true, null, "accepted"), (e) => line("ban", "one confirmed ban request covers both the strike outcome ban and the ban row it leads to", false, null, `refused: ${e.message}. A ban decision needs two separate confirmed requests (one for strike, one for ban), or the design must say one request serves both`)); }
});
await blk("{ const j = await live(), o = await F.org(), ri = (x) => ins(\"postgres", async () => {
{ const j = await live(), o = await F.org(), ri = (x) => ins("postgres", "review_item", { queue: "scam_flag", ...x });
  await rule("review_item", "while open or claimed exactly one target column is set", { refuse: async () => ri({ job_id: j, organisation_id: o }), ok: async () => ri({ job_id: j }) });
  await rule("review_item", "an item that is not scheduled_check needs a target; scheduled_check has none", { refuse: async () => ri({}), ok: async () => ri({ queue: "scheduled_check" }) });
  const ct = await F.text("pay_floor");
  const targets = { job_id: await live(), organisation_id: await F.org(), organisation_name_id: await ins("postgres", "organisation_name", { name: id("n"), normalised_name: id("n"), kind: "alias", source: "job_site" }), candidate_user_id: await F.cand(), portal_user_id: await F.portal(), contact_message_id: await ins("postgres", "contact_message", { surface: "portal", from_email: "x@example.test", topic: "general", body: "b" }) };
  for (const [col, v] of Object.entries(targets)) { const q = col === "candidate_user_id" || col === "portal_user_id" ? "data_request" : "agency_client_check";
    await rule("review_item", `one open item per (queue, ${col})`, { ok: async () => ri({ queue: q, [col]: v }), refuse: async () => ri({ queue: q, [col]: v }) }); }
  await rule("review_item", "a done or dropped data_request item has its person columns empty", { refuse: async () => su("update review_item set status='done' where queue='data_request' and candidate_user_id=$1", [targets.candidate_user_id]), ok: async () => su("update review_item set status='done', candidate_user_id=null where queue='data_request' and candidate_user_id=$1", [targets.candidate_user_id]) });
  const j2 = await live(), it = await ri({ queue: "fetched_job", job_id: j2 });
  const t = await race(5, (i) => P.app_admin.query("update review_item set claimed_by_staff_user_id=$1, claimed_at=now(), status='claimed' where id=$2 and claimed_by_staff_user_id is null returning id", [[s1, s2, s3, s1, s2][i], it]));
  line("review_item", "CONCURRENT: 5 staff claim one item, one winner", t.values.filter((v) => v?.rowCount === 1).length === 1, t.bad.length === 0, `${t.values.filter((v) => v?.rowCount === 1).length} winner`);
  await su("update review_item set status='done' where id=$1", [it]);
  await rule("review_item", "a finished item does not stop a new one, and its target may empty once done", { ok: async () => { await ri({ queue: "fetched_job", job_id: j2 }); await su("update review_item set job_id=null where id=$1", [it]); } }); }
});
/* fixture change (0004, M3): a staff actor must be the acting staff id, so both steps act as s1 */
{ const asS1 = (row) => tx("app_admin", async (c) => { await c.query("select set_config('app.staff_user_id',$1,true)", [s1]); return ins(c, "audit_event", row, null); });
await rule("audit_event", "at most one of the four actor columns", { refuse: async () => asS1({ kind: "admin_action", action: "a", actor_staff_user_id: s1, actor_system: "fetcher" }), ok: async () => asS1({ kind: "admin_action", action: "a", actor_staff_user_id: s1 }) }); }
await rule("audit_event", "no app role can update or delete it", { refuse: async () => { const errs = []; for (const r of ["app_candidate", "app_portal", "app_admin", "app_fetcher"]) { await P[r].query("update audit_event set action='x'").then(() => errs.push(r), () => {}); await P[r].query("delete from audit_event").then(() => errs.push(r), () => {}); } if (!errs.length) throw new Error("all four refused both"); } });
await blk("{ const k = id(\"v\"); await rule(\"consent_text\", \"unique (purpose, vers", async () => {
{ const k = id("v"); await rule("consent_text", "unique (purpose, version)", { ok: async () => ins("app_admin", "consent_text", { purpose: "visibility", version: k, body: "x" }), refuse: async () => ins("app_admin", "consent_text", { purpose: "visibility", version: k, body: "x" }) });
  await rule("consent_text", "no app role may update or delete a published text", { refuse: async () => { const errs = []; for (const r of ["app_candidate", "app_portal", "app_admin", "app_fetcher"]) { await P[r].query("update consent_text set body='x'").then(() => errs.push(r), () => {}); await P[r].query("delete from consent_text").then(() => errs.push(r), () => {}); } if (!errs.length) throw new Error("all four refused"); } });
  const v2 = id("v"), good = await appr("terms_privacy_page", "consent_text", `signup_terms:${v2}`);
  await rule("consent_text", "a signup_terms or privacy_notice row needs a confirmed terms_privacy_page request", { refuse: async () => ins("app_admin", "consent_text", { purpose: "signup_terms", version: id("v"), body: "Terms" }), ok: async () => ins("app_admin", "consent_text", { purpose: "signup_terms", version: v2, body: "Terms", approval_request_id: good }), expect: "two-person" }); }
});
await blk("{ const c = await F.cand(), ct = await F.text(\"visibility\"); await r", async () => {
{ const c = await F.cand(), ct = await F.text("visibility");
  await rule("consent_record", "exactly one person, unless erased", { refuse: async () => ins("postgres", "consent_record", { candidate_user_id: c, portal_user_id: pu, consent_text_id: ct }), ok: async () => ins("postgres", "consent_record", { consent_text_id: ct, subject_erased_at: new Date() }) });
  const cr = await ins("app_candidate", "candidate_consent_record", { candidate_user_id: c, consent_text_id: ct });
  await rule("consent_record", "app roles update only withdrawn_at, through their view", { refuse: async () => P.app_candidate.query("update candidate_consent_record set details='{}' where id=$1", [cr]), ok: async () => P.app_candidate.query("update candidate_consent_record set withdrawn_at=now() where id=$1", [cr]) }); }
});
await blk("{ const c = await F.cand(); const np = (x) => ins(\"postgres\", \"notific", async () => {
{ const c = await F.cand(); const np = (x) => ins("postgres", "notification_preference", { category: "job_alerts", channel: "email", enabled: false, ...x });
  await rule("notification_preference", "exactly one of the three user columns", { refuse: async () => np({ candidate_user_id: c, portal_user_id: pu }), ok: async () => np({ candidate_user_id: c }) });
  await rule("notification_preference", "partial unique (person, category, channel) in each pool", { refuse: async () => np({ candidate_user_id: c }), ok: async () => np({ staff_user_id: s1 }) }); }
});
await blk("{ const c = await F.cand(), k = id(\"dk\"); const nt = (x) => ins(\"postg", async () => {
{ const c = await F.cand(), k = id("dk"); const nt = (x) => ins("postgres", "notification", { category: "a", template_key: "t", ...x });
  await rule("notification", "exactly one of candidate_user_id and portal_user_id", { refuse: async () => nt({ candidate_user_id: c, portal_user_id: pu }), ok: async () => nt({ candidate_user_id: c, dedupe_key: k }) });
  await rule("notification", "unique dedupe_key", { refuse: async () => nt({ candidate_user_id: c, dedupe_key: k }) });
  /* ported change: app_portal writes notices through the portal_notification view (it has no grant on the table) */
  const o = await F.org(), us = [await F.portal(), await F.portal(), await F.portal()]; for (const [i, u] of us.entries()) await F.member(o, u, { role: i ? "recruiter" : "account_owner" });
  const r = await P.app_portal.query("insert into portal_notification(portal_user_id, organisation_id, category, template_key, dedupe_key) select m.portal_user_id, m.organisation_id, 'company', 'strike-notice', 'strike-notice:' || m.id from membership m where m.organisation_id=$1 and m.status='active' on conflict (dedupe_key) do nothing", [o]);
  await P.app_portal.query("update portal_notification set read_at=now() where portal_user_id=$1 and template_key='strike-notice'", [us[0]]);
  const st = (await su("select count(*) filter (where read_at is not null)::int r, count(*)::int n from notification where organisation_id=$1", [o])).rows[0];
  line("notification", "a notice to all members is one row per active member, so each read_at is the member's own", st.n === 3 && st.r === 1, r.rowCount === 3, `${st.n} rows written by app_portal, ${st.r} read after one member read it`); }
});
await blk("{ const c = await F.cand(), k = id(\"dk\"); const eo = (x) => ins(\"postg", async () => {
{ const c = await F.cand(), k = id("dk"); const eo = (x) => ins("postgres", "email_outbox", { template: "t", ...x }, null);
  await rule("email_outbox", "exactly one of the five target columns", { refuse: async () => eo({ candidate_user_id: c, portal_user_id: pu }), ok: async () => eo({ contact_message_id: 1, dedupe_key: id("dk") }) });
  await rule("email_outbox", "unique dedupe_key: one action sends one email", { ok: async () => eo({ candidate_user_id: c, dedupe_key: k }), refuse: async () => eo({ candidate_user_id: c, dedupe_key: k }) });
  for (let i = 0; i < 12; i++) await eo({ candidate_user_id: c, dedupe_key: id("skl") });
  const claim = () => tx("app_admin", async (cl) => { const r = await cl.query("select id from email_outbox where status='pending' order by send_after limit 3 for update skip locked"); await new Promise((f) => setTimeout(f, 50)); await cl.query("update email_outbox set status='sending' where id = any($1)", [r.rows.map((x) => x.id)]); return r.rows.map((x) => x.id); });
  const t = await race(4, claim), ids = t.values.filter(Boolean).flat();
  line("email_outbox", "CONCURRENT: workers claim with FOR UPDATE SKIP LOCKED, nothing twice", new Set(ids).size === ids.length && ids.length > 3, t.bad.length === 0, `${ids.length} claimed, ${new Set(ids).size} distinct, as app_admin ${t.errors[0] ?? ""}`); }
});
await rule("feature_flag", "unique key; only portal_owner writes", { refuse: async () => P.app_admin.query("update feature_flag set enabled=true"), ok: async () => P.portal_owner.query("update feature_flag set note='ok' where key='messaging'") });
await rule("setting", "key is the primary key", { refuse: async () => su("insert into setting(key) values('fetch_run')"), ok: async () => su("insert into setting(key) values($1)", [id("k")]) });

