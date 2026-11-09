/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Ported from schema-trial-2/10-launch-b.mjs: Launch B's clash rules, concurrency, the candidate's own stage, and the full erasure.
// This file's own database copy gets packages/db/launch-b/0001_launch_b.sql applied first, as the trial did with 09-launch-b.sql.
// One `it` per trial check, trial names kept. Each block's fixtures are made in the block's beforeAll, or inside the `it` when
// the trial made them between two checks.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, race, rule } from "./db";
import { daysAgo, fixtures, in30 } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db, P, su, id, ins, F;
let src, s1, s2, org, org2, pu, pu2, mem, mem2, appText, visText, accText;
const count = async (sql, a) => (await su(`select count(*)::int n from ${sql}`, a)).rows[0].n;
const sv = "'fake':1";
// Trial 3 made run_retention do one rule per call, so these tests call it until it reports no rule and add up what it returned.
// (The trial-2 script read one call's result as the whole run.) Own helper, see HANDOVER-4b-tests-1.
async function drain() {
  const all = { done: {}, skipped: [], storage_keys: [] };
  for (let i = 0; i < 80; i++) {
    const r = (await P.app_admin.query("select private.run_retention(1000) r")).rows[0].r;
    if (r.rule === null) break;
    all.done[r.rule] = (all.done[r.rule] ?? 0) + r.done; all.skipped.push(...r.skipped); all.storage_keys.push(...r.storage_keys);
  }
  return all;
}
const J = (o = {}) => ({ organisation_id: org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org", sector: "it", permit_type: "critical_skills", status: "live", closes_at: in30(), salary_low: 40000, search_vector: sv, application_route: "on_site", ...o });
const job = (o) => ins("postgres", "job", J(o));
const consent = (c, t = appText) => ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: t });
const visible = async (o = {}) => { const c = await F.cand(o); await ins("postgres", "candidate_profile", { candidate_user_id: c, visible_to_employers: true, visible_fields: ["occupation_code", "years_experience"], occupation_code: "2231", years_experience: 5, full_name: "Secret Name", phone: "+353999" }); return c; };
const apply = (pool, c, j, o, cr) => ins(pool, "application", { candidate_user_id: c, job_id: j, organisation_id: o, consent_record_id: cr });

beforeAll(async () => {
  db = await createTestDb();
  ({ P, su, id, ins, F } = fixtures(db));
  // Launch B starts here, in this copy only.
  await db.query("portal_owner", fs.readFileSync(new URL("../launch-b/0001_launch_b.sql", import.meta.url), "utf8"));
  src = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
  s1 = await F.staff(); s2 = await F.staff();
  org = await F.org(); org2 = await F.org(); pu = await F.portal(); pu2 = await F.portal();
  mem = await F.member(org, pu, { role: "account_owner", signer: true }); mem2 = await F.member(org2, pu2, { role: "account_owner", signer: true });
  appText = await F.text("application"); visText = await F.text("visibility"); accText = await F.text("contact_accept");
});
afterAll(() => db.drop());

it("job: fetched jobs cannot use on_site (the Launch B lock no longer hides this rule)", () =>
  rule({ refuse: () => job({ source: "fetched", closes_at: "infinity", badge: "critical_skills_eligible" }), ok: () => job({ source: "fetched", closes_at: "infinity", badge: "critical_skills_eligible", application_route: "own_page", own_page_url: "u" }) }));

// ===== application
describe("application", () => {
  let c, j, cr, c4, a;
  beforeAll(async () => { c = await F.cand(); j = await job(); cr = await consent(c); });
  it("application: unique on candidate and job", () =>
    rule({ ok: () => apply("app_candidate", c, j, org, cr), refuse: () => apply("app_candidate", c, j, org, cr) }));
  it("application: joint foreign key (job_id, organisation_id): job and organisation never disagree", async () => {
    const c2 = await F.cand(), cr2 = await consent(c2);
    await rule({ refuse: () => apply("app_candidate", c2, j, org2, cr2), ok: () => apply("app_candidate", c2, j, org, cr2) });
  });
  for (const [label, o] of [["closed", { status: "closed", closed_at: new Date(), search_vector: null }], ["hidden", { status: "hidden", hidden_reason: "admin" }], ["expired", { closes_at: daysAgo(1) }], ["not on-site", { application_route: "own_page", own_page_url: "u" }], ["fetched (own_page)", { source: "fetched", closes_at: "infinity", badge: "critical_skills_eligible", application_route: "own_page", own_page_url: "u" }]])
    it(`application: trigger refuses a job that is ${label}`, async () => {
      const c3 = await F.cand(), cr3 = await consent(c3), jj = await job(o);
      await rule({ refuse: () => apply("app_candidate", c3, jj, org, cr3), expect: "application refused" });
    });
  it("application: CONCURRENT: 10 taps on apply make 1 application, as app_candidate", async () => {
    c4 = await F.cand(); const cr4 = await consent(c4), j4 = await job();
    const t = await race(10, () => P.app_candidate.query("insert into application(candidate_user_id,job_id,organisation_id,consent_record_id) values($1,$2,$3,$4) on conflict (candidate_user_id, job_id) do nothing", [c4, j4, org, cr4]));
    expect(await count("application where candidate_user_id=$1", [c4])).toBe(1);
    expect(t.bad.length, `${t.bad.length} errors ${t.errors[0] ?? ""}`).toBe(0);
    a = (await su("select id from application where candidate_user_id=$1", [c4])).rows[0].id;
    await ins("app_candidate", "tracker_entry", { candidate_user_id: c4, job_id: j4, route: "on_site", origin: "on_site", stage: "applied", application_id: a }, null);
  });
  it("application: a candidate cannot set its own application stage; it can only withdraw (first trial failure 4)", () =>
    rule({ refuse: () => P.app_candidate.query("update application set status='hired' where id=$1", [a]), expect: "only withdraw" }));
  it("tracker_entry: a candidate cannot set its own on-site tracker stage", () =>
    rule({ refuse: () => P.app_candidate.query("update tracker_entry set stage='offer' where application_id=$1", [a]), expect: "tracker guard" }));
  it("application: app_portal reads its applications without candidate_user_id and consent_record_id", () =>
    rule({ refuse: () => P.app_portal.query("select candidate_user_id from application where id=$1", [a]), ok: () => P.app_portal.query("select id, status, cover_note from application where id=$1", [a]) }));
  it("application: app_portal has no plain update on application or tracker_entry", async () => {
    const plainUpdate = await P.app_portal.query("update application set status='viewed' where id=$1", [a]).then(() => "allowed", (e) => e.code);
    expect(plainUpdate).toBe("42501");
  });
  it("application: move_application: a member of another company is refused; the owner moves application and tracker together", async () => {
    const other = await F.member(org2, await F.portal(), { role: "recruiter" });
    await rule({ refuse: () => P.app_portal.query("select private.move_application($1,'shortlisted',$2)", [a, other]), ok: async () => { await P.app_portal.query("select private.move_application($1,'shortlisted',$2)", [a, mem]); const r = (await su("select a.status, t.stage from application a join tracker_entry t on t.application_id=a.id where a.id=$1", [a])).rows[0]; if (r.status !== "shortlisted" || r.stage !== "shortlisted") throw new Error(JSON.stringify(r)); }, expect: "move refused" });
  });
  it("application: the candidate can withdraw; then the employer cannot move it", () =>
    rule({ ok: () => P.app_candidate.query("update application set status='withdrawn', withdrawn_at=now() where id=$1", [a]), refuse: () => P.app_portal.query("select private.move_application($1,'offer',$2)", [a, mem]), expect: "withdrawn" }));
});

// ===== contact_request, as app_portal
describe("contact_request", () => {
  const send = (pool, o, m, cc) => ins(pool, "contact_request", { organisation_id: o, membership_id: m, candidate_user_id: cc });
  let c;
  beforeAll(async () => { await su("update setting set value=null where key='contact_request_reask'"); c = await visible(); });
  it("contact_request: one open request per organisation and candidate (re-ask wait switched off for this line)", () =>
    rule({ ok: () => send("app_portal", org, mem, c), refuse: () => send("app_portal", org, mem, c) }));
  it("contact_request: joint foreign key (membership_id, organisation_id): a member of one company cannot send as another (build 17)", async () => {
    await su("update setting set value=90 where key='contact_request_reask'");
    await rule({ refuse: async () => send("app_portal", org2, mem, await visible()), ok: async () => send("app_portal", org2, mem2, await visible()) });
  });
  it("contact_request: the trigger (owner's rights) refuses a candidate who is not visible; the portal cannot read candidate_profile itself", async () => {
    const hidden = await F.cand(); await ins("postgres", "candidate_profile", { candidate_user_id: hidden, visible_to_employers: false });
    await rule({ refuse: () => send("app_portal", org, mem, hidden), ok: async () => send("app_portal", org, mem, await visible()), expect: "not visible" });
  });
  it("contact_request: the trigger refuses a suspended candidate", () =>
    rule({ refuse: async () => send("app_portal", org, mem, await visible({ suspended: new Date() })), expect: "suspended" }));
  it("contact_request: the trigger refuses a candidate who asked to delete the account", () =>
    rule({ refuse: async () => send("app_portal", org, mem, await visible({ deleted: new Date() })), expect: "deleted" }));
  it("contact_request: the trigger refuses a candidate who has hidden this organisation (#101, #129)", async () => {
    const h = await visible(); await ins("postgres", "candidate_hidden_organisation", { candidate_user_id: h, organisation_id: org });
    await rule({ refuse: () => send("app_portal", org, mem, h), ok: () => send("app_portal", org2, mem2, h), expect: "hidden" });
  });
  it("contact_request: re-ask: a new request inside contact_request_reask (90 days) is refused, after it works", async () => {
    const d = await visible(); const first = await send("app_portal", org, mem, d);
    await su("update contact_request set status='declined', answered_at=now() where id=$1", [first]);
    await rule({ refuse: () => send("app_portal", org, mem, d), ok: async () => { await su("update contact_request set sent_at=now()-interval '91 days' where id=$1", [first]); await send("app_portal", org, mem, d); }, expect: "within the last" });
  });
  it("contact_request: consent_record_id is required once accepted", async () => {
    const cc = await visible(), cr = await consent(cc, accText), creq = await send("app_portal", org, mem, cc);
    await rule({ refuse: () => P.app_candidate.query("update contact_request set status='accepted', answered_at=now() where id=$1", [creq]), ok: () => P.app_candidate.query("update contact_request set status='accepted', answered_at=now(), consent_record_id=$2, released_details=$3 where id=$1", [creq, cr, JSON.stringify({ email: "fake@example.test" })]) });
  });
  it("contact_request: CONCURRENT: the daily limit (20) holds when 25 requests from one organisation arrive at once", async () => {
    // 25 at once from one organisation, under the per-organisation lock
    const o3 = await F.org(), m3 = await F.member(o3, await F.portal(), { role: "account_owner" }), people = []; for (let i = 0; i < 25; i++) people.push(await visible());
    const t = await race(25, (i) => send("app_portal", o3, m3, people[i]));
    expect(t.ok.length, `${t.ok.length} accepted, ${t.bad.length} refused: ${t.errors[0]}`).toBe(20);
  });
});

// ===== message
describe("message", () => {
  let c, a, open, acc, rm, keep;
  const msg = (pool, o) => ins(pool, "message", { body: "hello", ...o });
  beforeAll(async () => {
    c = await F.cand(); const j = await job(), cr = await consent(c); a = await apply("postgres", c, j, org, cr);
    const vc = await visible(); open = await ins("postgres", "contact_request", { organisation_id: org, membership_id: mem, candidate_user_id: vc });
    const vc2 = await visible(); acc = await ins("postgres", "contact_request", { organisation_id: org, membership_id: mem, candidate_user_id: vc2, status: "accepted", consent_record_id: await consent(vc2, accText) });
  });
  it("message: exactly one parent", () =>
    rule({ refuse: () => msg("postgres", { application_id: a, contact_request_id: acc, sender_membership_id: mem }), ok: () => msg("app_candidate", { application_id: a, sender_candidate_user_id: c }) }));
  it("message: exactly one sender", () =>
    rule({ refuse: () => msg("postgres", { application_id: a, sender_candidate_user_id: c, sender_membership_id: mem }), ok: () => msg("app_portal", { application_id: a, sender_membership_id: mem }) }));
  it("message: a trigger refuses a contact request that is not accepted", () =>
    rule({ refuse: () => msg("app_portal", { contact_request_id: open, sender_membership_id: mem }), ok: () => msg("app_portal", { contact_request_id: acc, sender_membership_id: mem }), expect: "not accepted" }));
  it("message: a trigger before delete marks a report on the message as target wiped, so the delete works and the report stays", async () => {
    const m = await msg("postgres", { application_id: a, sender_membership_id: mem }), rp = await ins("postgres", "report", { target_kind: "message", target_message_id: m, reason: "other", target_snapshot: { body: "hello" } });
    await rule({ ok: async () => { await su("delete from message where id=$1", [m]); const r = (await su("select target_wiped_at is not null w, target_snapshot from report where id=$1", [rp])).rows[0]; if (!r.w) throw new Error("not wiped"); } });
  });
  it("message: a removed member's messages stay with the team", async () => {
    rm = await F.member(org, await F.portal(), { role: "recruiter" }); keep = await msg("postgres", { application_id: a, sender_membership_id: rm });
    await su("update membership set status='removed', removed_at=now() where id=$1", [rm]);
    expect(await count("message where id=$1", [keep])).toBe(1);
  });
  it("candidate_hidden_organisation: unique on candidate and organisation", () =>
    rule({ ok: () => ins("app_candidate", "candidate_hidden_organisation", { candidate_user_id: c, organisation_id: org }), refuse: () => ins("app_candidate", "candidate_hidden_organisation", { candidate_user_id: c, organisation_id: org }) }));
});

// ===== candidate search
describe("candidate search", () => {
  let shown, hid, sus;
  beforeAll(async () => { shown = await visible(); hid = await visible(); sus = await visible({ suspended: new Date() }); await ins("postgres", "candidate_hidden_organisation", { candidate_user_id: hid, organisation_id: org }); });
  it("candidate search: search_visible_candidates shows visible candidates, never one who hid the company or is suspended, and only chosen fields", async () => {
    const r = (await P.app_portal.query("select * from private.search_visible_candidates($1, '{}'::jsonb, null)", [org])).rows;
    const ids = r.map((x) => x.candidate_user_id), leak = JSON.stringify(r).includes("Secret Name") || JSON.stringify(r).includes("+353999");
    expect(ids.includes(shown) && !ids.includes(hid) && !ids.includes(sus) && !leak, `${r.length} rows; sample fields ${JSON.stringify(r[0]?.fields)}`).toBe(true);
  });
  it("candidate search: app_portal has no grant on candidate_hidden_organisation (review 21)", async () => {
    expect(await P.app_portal.query("select * from candidate_hidden_organisation limit 1").then(() => "allowed", (e) => e.code)).toBe("42501");
  });
  it("candidate search: after the licence the candidate can switch visibility on", async () => {
    const c = await F.cand(); await ins("app_candidate", "candidate_profile", { candidate_user_id: c });
    expect(await P.app_candidate.query("update candidate_profile set visible_to_employers=true, visible_fields='{occupation_code}' where candidate_user_id=$1", [c]).then(() => "ok", (e) => e.message)).toBe("ok");
  });
});

// ===== full erasure with Launch B rows
describe("2 erasure", () => {
  let c, email, a, r;
  beforeAll(async () => {
    c = await visible(); email = (await su("select email from candidate_user where id=$1", [c])).rows[0].email;
    const j = await job(), cr = await consent(c);
    a = await ins("postgres", "application", { candidate_user_id: c, job_id: j, organisation_id: org, consent_record_id: cr, cover_note: "Fake cover note", answers: { q1: "yes" }, profile_summary: { years: 5 }, cv_storage_key: `applications/${c}/cv.pdf`, cv_file_name: "cv.pdf" });
    await ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j, route: "on_site", origin: "on_site", stage: "applied", application_id: a }, null);
    const mc = await ins("postgres", "message", { application_id: a, sender_candidate_user_id: c, body: "Fake message from the candidate" });
    const me = await ins("postgres", "message", { application_id: a, sender_membership_id: mem, body: "Fake message from the employer" });
    const rpm = await ins("postgres", "report", { target_kind: "message", target_message_id: me, reason: "other", status: "cleared", decided_at: new Date(), target_snapshot: { body: "x" } });
    const crq = await ins("postgres", "contact_request", { organisation_id: org2, membership_id: mem2, candidate_user_id: c, status: "accepted", consent_record_id: await consent(c, accText), released_details: { email, phone: "+353999" } });
    const cm = await ins("postgres", "message", { contact_request_id: crq, sender_candidate_user_id: c, body: "Fake reply" }), em = await ins("postgres", "message", { contact_request_id: crq, sender_membership_id: mem2, body: "Fake employer note" });
    await ins("postgres", "candidate_hidden_organisation", { candidate_user_id: c, organisation_id: org });
    // the check names the keys the trial built its state object from; kept in this closure for the first check below
    ids = { mc, me, rpm, crq, cm, em };
    r = (await P.app_admin.query("select private.erase_candidate($1, true) r", [c])).rows[0].r;
  });
  let ids;
  it("2 erasure: Launch B: erase_candidate deletes applications (and their messages), the candidate's messages under contact requests, empties released details", async () => {
    // trial 3 empties the application row instead of deleting it, so the first count looks for what is left in it
    const state = { erased: r.erased, applications: await count("application where id=$1 and (candidate_user_id is not null or cover_note is not null or cv_storage_key is not null)", [a]) , candidate_messages: await count("message where id in ($1,$2)", [ids.mc, ids.cm]), employer_message_on_application: await count("message where id=$1", [ids.me]),
      employer_message_on_contact_request: await count("message where id=$1", [ids.em]), report_on_message: (await su("select target_wiped_at is not null w from report where id=$1", [ids.rpm])).rows[0].w,
      contact_request: (await su("select candidate_user_id, released_details from contact_request where id=$1", [ids.crq])).rows[0], tracker: await count("tracker_entry where candidate_user_id=$1", [c]),
      hidden: await count("candidate_hidden_organisation where candidate_user_id=$1", [c]), keys: r.storage_keys };
    expect(r.erased && state.applications === 0 && state.candidate_messages === 0 && state.contact_request.candidate_user_id === null && state.contact_request.released_details === null && state.report_on_message, JSON.stringify(state)).toBeTruthy();
  });
  it("2 erasure: the application's CV copy key is returned for deletion too", () => {
    expect(r.storage_keys.includes(`applications/${c}/cv.pdf`), JSON.stringify(r.storage_keys)).toBe(true);
  });
  it("2 erasure: Launch B: a scan of every table finds the erased person nowhere", async () => {
    const hits = []; for (const t of (await su("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")).rows.map((x) => x.table_name)) { const n = await count(`${t} x where x::text like $1 or x::text ilike $2`, [`%${c}%`, `%${email}%`]); if (n) hits.push(`${t}: ${n}`); }
    expect(hits.join(", ") || "nowhere").toBe("nowhere");
  });
});

// ===== application_and_cv retention with the #99 freeze
describe("11 run_retention", () => {
  let a1, a2, r, oc;
  beforeAll(async () => {
    const c = await F.cand(), c2 = await F.cand(), j = await job(), cr = await consent(c), cr2 = await consent(c2);
    a1 = await ins("postgres", "application", { candidate_user_id: c, job_id: j, organisation_id: org, consent_record_id: cr, cv_storage_key: "applications/old/cv.pdf" });
    a2 = await ins("postgres", "application", { candidate_user_id: c2, job_id: j, organisation_id: org, consent_record_id: cr2, cv_storage_key: "applications/frozen/cv.pdf" });
    await ins("postgres", "services_case", { candidate_user_id: c2, consent_record_id: await consent(c2), status: "submitted" });
    await su("update job set status='closed', closed_at=now()-interval '13 months', search_vector=null where id=$1", [j]);
    r = await drain();
  });
  it("11 run_retention: application_and_cv: applications 12 months after the job closed are deleted and their CV keys returned", async () => {
    // trial 3: the row is emptied (candidate, consent, text, CV key) and goes 36 months after the job closes, not at 12 months
    expect(await count("application where id=$1 and (candidate_user_id is not null or cover_note is not null or cv_storage_key is not null)", [a1]) === 0 && r.storage_keys.includes("applications/old/cv.pdf"), `deleted ${r.done.application_and_cv}`).toBe(true);
  });
  it("11 run_retention: application_and_cv: an application of a candidate with an open case is kept and listed (#99)", async () => {
    expect(await count("application where id=$1", [a2]) === 1 && JSON.stringify(r.skipped).includes(String(a2)), JSON.stringify(r.skipped).slice(0, 160)).toBe(true);
  });
  it("11 run_retention: contact_request_expiry: a request unanswered for 14 days is expired", async () => {
    const old = await visible(); oc = await ins("postgres", "contact_request", { organisation_id: org, membership_id: mem, candidate_user_id: old });
    await su("update contact_request set sent_at=now()-interval '15 days' where id=$1", [oc]);
    await drain();
    expect((await su("select status from contact_request where id=$1", [oc])).rows[0].status).toBe("expired");
  });
  it("11 run_retention: contact_request_record: an answered or expired request 12 months on is deleted", async () => {
    await su("update contact_request set answered_at=now()-interval '13 months' where id=$1", [oc]);
    await drain();
    expect(await count("contact_request where id=$1", [oc])).toBe(0);
  });
});
