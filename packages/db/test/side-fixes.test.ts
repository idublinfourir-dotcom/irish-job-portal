/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Findings F1 to F9 of the database review of the fetcher and the candidate site (migration 0005_side_fixes). Every action runs as the
// real role; fixtures are inserted as postgres. One "must not" and one "must" per rule. Fake data only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, rule } from "./db";
import { fixtures, in30 } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db, P, su, id, ins, F;
let org, board, portalSrc;
beforeAll(async () => {
  db = await createTestDb();
  ({ P, su, id, ins, F } = fixtures(db));
  org = await F.org();
  board = await ins("postgres", "job_source", { kind: "board", board: "fakeboard" });
  portalSrc = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
});
afterAll(() => db.drop());

// A fetched job (live unless told otherwise), closed by staff with the given reason when `closed` is set.
async function fetchedJob({ status = "live", closed = null } = {}) {
  const j = await su(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,own_page_url,closes_at,search_vector,badge)
     values($1,'fetched',$2,'t','e','it','critical_skills',$3,'u','infinity',to_tsvector('x'),'critical_skills_eligible') returning id`,
    [org, board, status],
  ).then((r) => r.rows[0].id);
  if (closed) await su("update job set status='closed', close_reason=$2, closed_at=now(), search_vector=null where id=$1", [j, closed]);
  return j;
}
const employerJob = async (status = "live") =>
  ins("postgres", "job", { organisation_id: org, source: "employer", job_source_id: portalSrc, title: "t", employer_name: "e", sector: "it", permit_type: "critical_skills", status, closes_at: in30(), own_page_url: "u", salary_low: 40000, search_vector: "'x':1" });
const text = (job, t = "fake advert") => su("insert into job_text(job_id,advert_text) values($1,$2) on conflict do nothing", [job, t]);

// ---- F1: the fetcher never reopens a job staff removed
describe("F1 closed jobs", () => {
  const reopen = (job, extra = "") => P.app_fetcher.query(`update job set status='live', close_reason=null, closed_at=null, search_vector=to_tsvector('x') ${extra} where id=$1`, [job]);
  it("must not: app_fetcher: move a closed job (close_reason removed) back to live", async () => {
    const j = await fetchedJob({ closed: "removed" });
    await rule({ refuse: () => reopen(j), expect: "reopens" });
  });
  it("must not: app_fetcher: move a removed job to live and blank close_reason in the same update", async () => {
    const j = await fetchedJob({ closed: "removed" });
    await rule({ refuse: () => P.app_fetcher.query("update job set status='live', close_reason=null, closed_at=null, search_vector=to_tsvector('x') where id=$1", [j]), expect: "reopens" });
  });
  it("must not: app_fetcher: move a removed job to in_review", async () => {
    const j = await fetchedJob({ closed: "removed" });
    await rule({ refuse: () => P.app_fetcher.query("update job set status='in_review' where id=$1", [j]), expect: "reopens" });
  });
  it("must not: app_fetcher: move a job closed for another staff reason back to live", async () => {
    const j = await fetchedJob({ closed: "under_review_expired" });
    await rule({ refuse: () => reopen(j), expect: "reopens" });
  });
  it("must not: app_fetcher: relabel a removed job's close reason while it stays closed (the way back to live in two steps)", async () => {
    const j = await fetchedJob({ closed: "removed" });
    await rule({ refuse: () => P.app_fetcher.query("update job set close_reason='closed' where id=$1", [j]), expect: "close reason" });
    await rule({ refuse: () => reopen(j), expect: "reopens" });
  });
  it("must: app_fetcher: reopen a job it closed as closed or expired", async () => {
    for (const reason of ["closed", "expired"]) {
      const j = await fetchedJob({ closed: reason });
      await rule({ ok: () => reopen(j) });
      expect((await su("select status from job where id=$1", [j])).rows[0].status).toBe("live");
    }
  });
  it("must: app_fetcher: close a live job as removed or closed", async () => {
    const j = await fetchedJob();
    await rule({ ok: () => P.app_fetcher.query("update job set status='closed', close_reason='closed', closed_at=now(), search_vector=null where id=$1", [j]) });
  });
});

// ---- F4: the fetcher never resets posted_at by going through draft
describe("F4 posted_at", () => {
  it("must not: app_fetcher: move a live job back to draft", async () => {
    const j = await fetchedJob();
    await rule({ refuse: () => P.app_fetcher.query("update job set status='draft' where id=$1", [j]), expect: "draft" });
  });
  it("must not: app_fetcher: change posted_at of a live job", async () => {
    const j = await fetchedJob();
    await rule({ refuse: () => P.app_fetcher.query("update job set posted_at = now() where id=$1", [j]), expect: "42501" });
  });
  it("must: app_fetcher: a live job keeps its posted_at through any allowed update", async () => {
    const j = await fetchedJob();
    await su("update job set posted_at = now() - interval '60 days' where id=$1", [j]);
    const before = (await su("select posted_at from job where id=$1", [j])).rows[0].posted_at;
    await P.app_fetcher.query("update job set title='t2', salary_low=1 where id=$1", [j]);
    expect((await su("select posted_at from job where id=$1", [j])).rows[0].posted_at).toEqual(before);
  });
});

// ---- F2: the fetcher inserts only scam flags, and only the columns a flag needs
describe("F2 review_item", () => {
  const flag = (cols, vals) => P.app_fetcher.query(`insert into review_item(${cols}) values(${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
  it("must not: app_fetcher: insert a review_item outside scam_flag", async () => {
    const j = await fetchedJob();
    await rule({ refuse: () => flag("queue,job_id,reason", ["fetched_job", j, "x"]), expect: "scam_flag" });
    const k = await fetchedJob();
    await rule({ refuse: () => flag("queue,job_id,reason", ["post_strike_job_review", k, "x"]), expect: "scam_flag" });
  });
  it("must not: app_fetcher: insert a review_item with a status or an outcome", async () => {
    const j = await fetchedJob();
    await rule({ refuse: () => flag("queue,job_id,status", ["scam_flag", j, "done"]), expect: "42501" });
    await rule({ refuse: () => flag("queue,job_id,outcome", ["scam_flag", j, "approved"]), expect: "42501" });
    await rule({ refuse: () => flag("queue,job_id,decided_at", ["scam_flag", j, new Date()]), expect: "42501" });
  });
  it("must not: app_fetcher: aim a review_item at an organisation", async () => {
    await rule({ refuse: () => flag("queue,organisation_id", ["account_review", org]), expect: "42501" });
  });
  it("must: app_fetcher: insert a plain scam flag on a job, born open", async () => {
    const j = await fetchedJob();
    await rule({ ok: () => flag("queue,job_id,reason,detail", ["scam_flag", j, "fee asked", JSON.stringify({ k: 1 })]) });
    const r = (await su("select status, outcome from review_item where queue='scam_flag' and job_id=$1", [j])).rows[0];
    expect(r).toEqual({ status: "open", outcome: null });
  });
  it("must: the job trigger still queues a fetched_job item for a fetched job inserted in_review", async () => {
    await P.app_fetcher.query(
      `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,own_page_url,closes_at,search_vector,badge)
       values($1,'fetched',$2,'t','e','it','critical_skills','in_review','u','infinity',to_tsvector('x'),'critical_skills_eligible')`,
      [org, board],
    );
    const n = (await su("select count(*)::int n from review_item i join job j on j.id=i.job_id where i.queue='fetched_job' and j.status='in_review' and j.source='fetched'")).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });
});

// ---- F3: advert text is written only by the side that owns the job
describe("F3 job_text", () => {
  const w = (role, kind, job) =>
    P[role].query(
      kind === "insert" ? "insert into job_text(job_id,advert_text) values($1,'new text')" : kind === "update" ? "update job_text set advert_text='changed' where job_id=$1" : "delete from job_text where job_id=$1",
      [job],
    );
  for (const kind of ["insert", "update", "delete"]) {
    it(`must not: app_fetcher: ${kind} the advert text of an employer job`, async () => {
      const j = await employerJob();
      if (kind !== "insert") await text(j);
      await rule({ refuse: () => w("app_fetcher", kind, j), expect: "job text guard" });
    });
    it(`must not: app_portal: ${kind} the advert text of a fetched job`, async () => {
      const j = await fetchedJob();
      if (kind !== "insert") await text(j);
      await rule({ refuse: () => w("app_portal", kind, j), expect: "job text guard" });
    });
  }
  it("must not: app_fetcher: point existing text at an employer job", async () => {
    const f = await fetchedJob(), e = await employerJob();
    await text(f);
    await rule({ refuse: () => P.app_fetcher.query("update job_text set job_id=$2 where job_id=$1", [f, e]), expect: "job text guard" });
  });
  it("must: each role writes the text it owns", async () => {
    const f = await fetchedJob(), e = await employerJob(), a = await employerJob();
    await rule({ ok: () => w("app_fetcher", "insert", f) });
    await rule({ ok: () => w("app_fetcher", "update", f) });
    await rule({ ok: () => w("app_fetcher", "delete", f) });
    await rule({ ok: () => w("app_portal", "insert", e) });
    await rule({ ok: () => w("app_portal", "update", e) });
    await rule({ ok: () => w("app_portal", "delete", e) });
    await text(a);
    await rule({ ok: () => w("app_admin", "update", a) });
    const f2 = await fetchedJob();
    await text(f2);
    await rule({ ok: () => w("app_admin", "update", f2) });
    await rule({ ok: () => w("app_admin", "delete", f2) });
  });
  it("must: the owner's retention function still removes the text of an abandoned draft", async () => {
    const e = await employerJob("draft");
    await su("update job set created_at = now() - interval '10 years' where id=$1", [e]);
    await text(e);
    await P.app_admin.query("select private.run_retention(1000)");
    expect((await su("select count(*)::int n from job_text where job_id=$1", [e])).rows[0].n).toBe(0);
  });
  it("must: deleting a job removes its text", async () => {
    const f = await fetchedJob();
    await text(f);
    await su("delete from job where id=$1", [f]);
    expect((await su("select count(*)::int n from job_text where job_id=$1", [f])).rows[0].n).toBe(0);
  });
});

// ---- F6: the tracker guard follows the old route
describe("F6 tracker_entry", () => {
  const row = async (route, stage) => {
    const c = await F.cand();
    const j = await employerJob();
    const t = await ins("postgres", "tracker_entry", { candidate_user_id: c, job_id: j, route, origin: route === "on_site" ? "on_site" : "mark_applied", stage });
    return { c, t };
  };
  it("must not: app_candidate: move an on-site tracker row to redirect and set a stage", async () => {
    const { c, t } = await row("on_site", "applied");
    await rule({ refuse: () => P.app_candidate.query("update tracker_entry set route='redirect', stage='offer' where id=$1 and candidate_user_id=$2", [t, c]), expect: "tracker guard" });
  });
  it("must not: app_candidate: change the route of an on-site row at all", async () => {
    const { t } = await row("on_site", "applied");
    await rule({ refuse: () => P.app_candidate.query("update tracker_entry set route='redirect', stage='applied' where id=$1", [t]), expect: "tracker guard" });
  });
  it("must not: app_candidate: set a stage other than withdrawn on an on-site row", async () => {
    const { t } = await row("on_site", "applied");
    await rule({ refuse: () => P.app_candidate.query("update tracker_entry set stage='offer' where id=$1", [t]), expect: "tracker guard" });
  });
  it("must not: app_candidate: move a redirect row to on-site", async () => {
    const { t } = await row("redirect", "applied");
    await rule({ refuse: () => P.app_candidate.query("update tracker_entry set route='on_site', stage='hired' where id=$1", [t]), expect: "tracker guard" });
  });
  it("must: app_candidate: withdraw an on-site row", async () => {
    const { t } = await row("on_site", "applied");
    await rule({ ok: () => P.app_candidate.query("update tracker_entry set stage='withdrawn' where id=$1", [t]) });
  });
  it("must: app_candidate: edit a redirect row freely", async () => {
    const { t } = await row("redirect", "applied");
    await rule({ ok: () => P.app_candidate.query("update tracker_entry set stage='interview' where id=$1", [t]) });
    await rule({ ok: () => P.app_candidate.query("update tracker_entry set stage='offer' where id=$1", [t]) });
  });
});

// ---- F7 and F8 need people, consent and cases
let ct;
beforeAll(async () => { ct = await F.text("services_request"); });
const consent = (who, kind = "candidate") => ins("postgres", "consent_record", { [`${kind}_user_id`]: who, consent_text_id: ct });
const caseOf = async (who, kind) => {
  const k = await consent(who, kind);
  return ins("postgres", "services_case", { [`${kind}_user_id`]: who, consent_record_id: k, ...(kind === "portal" ? { dedupe_key: id("dk") } : {}) });
};

describe("F7 same-person links", () => {
  const candDoc = (sc, c) => P.app_candidate.query("insert into candidate_case_document(services_case_id,storage_key,file_name,content_type,byte_size,candidate_user_id) values($1,'k','f.pdf','pdf',10,$2)", [sc, c]);
  const portDoc = (sc, p) => P.app_portal.query("insert into portal_case_document(services_case_id,storage_key,file_name,content_type,byte_size,portal_user_id) values($1,'k','f.pdf','pdf',10,$2)", [sc, p]);
  it("must not: app_candidate: attach a document to a portal services case", async () => {
    const c = await F.cand(), p = await F.portal();
    const sc = await caseOf(p, "portal");
    await rule({ refuse: () => candDoc(sc, c), expect: "case document guard" });
  });
  it("must not: app_candidate: attach a document to another candidate's case", async () => {
    const c1 = await F.cand(), c2 = await F.cand();
    const sc = await caseOf(c1, "candidate");
    await rule({ refuse: () => candDoc(sc, c2), expect: "case document guard" });
  });
  it("must not: app_portal: attach a document to a candidate's case", async () => {
    const c = await F.cand(), p = await F.portal();
    const sc = await caseOf(c, "candidate");
    await rule({ refuse: () => portDoc(sc, p), expect: "case document guard" });
  });
  it("must: each side attaches a document to its own case, and staff to any case", async () => {
    const c = await F.cand(), p = await F.portal(), s = await F.staff();
    const sc = await caseOf(c, "candidate"), sp = await caseOf(p, "portal");
    await rule({ ok: () => candDoc(sc, c) });
    await rule({ ok: () => portDoc(sp, p) });
    for (const x of [sc, sp]) await rule({ ok: () => P.app_admin.query("insert into case_document(services_case_id,storage_key,file_name,content_type,byte_size,staff_user_id) values($1,'k','f.pdf','pdf',10,$2)", [x, s]) });
  });
  it("must: erasing the person who owns a document still works", async () => {
    const c = await F.cand();
    const sc = await caseOf(c, "candidate");
    await candDoc(sc, c);
    await su("update services_case set status='closed', closed_at=now(), close_reason='withdrawn' where id=$1", [sc]);
    await rule({ ok: () => P.app_admin.query("select private.erase_candidate($1, true)", [c]) });
  });

  const candCase = (c, k, extra = "") => P.app_candidate.query(`insert into candidate_services_case(candidate_user_id,consent_record_id,permit_type${extra ? "," + extra.split("=")[0] : ""}) values($1,$2,'general'${extra ? "," + extra.split("=")[1] : ""})`, [c, k]);
  it("must not: app_candidate: open a case on a portal user's consent record", async () => {
    const c = await F.cand(), p = await F.portal();
    const k = await consent(p, "portal");
    await rule({ refuse: () => candCase(c, k), expect: "services case guard" });
  });
  it("must not: app_candidate: open a case on another candidate's consent record", async () => {
    const c1 = await F.cand(), c2 = await F.cand();
    const k = await consent(c2);
    await rule({ refuse: () => candCase(c1, k), expect: "services case guard" });
  });
  it("must not: app_candidate: name another person's consent as the employer contact consent", async () => {
    const c1 = await F.cand(), c2 = await F.cand();
    const own = await consent(c1), other = await consent(c2);
    await rule({ refuse: () => candCase(c1, own, `employer_contact_consent_record_id=${other}`), expect: "services case guard" });
  });
  it("must not: app_portal: open a case on a candidate's consent record", async () => {
    const p = await F.portal(), c = await F.cand();
    const k = await consent(c);
    await rule({ refuse: () => P.app_portal.query("insert into portal_services_case(portal_user_id,consent_record_id,dedupe_key) values($1,$2,$3)", [p, k, id("dk")]), expect: "services case guard" });
  });
  it("must not: app_admin: repoint a case at another person's consent record", async () => {
    const c1 = await F.cand(), c2 = await F.cand();
    const sc = await caseOf(c1, "candidate");
    const other = await consent(c2);
    await rule({ refuse: () => P.app_admin.query("update services_case set consent_record_id=$2 where id=$1", [sc, other]), expect: "services case guard" });
  });
  it("must: each side opens a case on its own consent records", async () => {
    const c = await F.cand(), p = await F.portal();
    const k = await consent(c), k2 = await consent(c), kp = await consent(p, "portal");
    await rule({ ok: () => candCase(c, k, `employer_contact_consent_record_id=${k2}`) });
    await rule({ ok: () => P.app_portal.query("insert into portal_services_case(portal_user_id,consent_record_id,dedupe_key) values($1,$2,$3)", [p, kp, id("dk")]) });
  });
});

describe("F8 consent proof", () => {
  const sides = [
    ["app_candidate", "candidate", () => F.cand()],
    ["app_portal", "portal", () => F.portal()],
  ];
  for (const [role, kind, mk] of sides) {
    const view = `${kind}_consent_record`;
    it(`must not: ${role}: choose given_at`, async () => {
      const u = await mk();
      await rule({ refuse: () => P[role].query(`insert into ${view}(${kind}_user_id,consent_text_id,given_at) values($1,$2,'2001-01-01')`, [u, ct]), expect: "42501" });
    });
    it(`must not: ${role}: clear withdrawn_at`, async () => {
      const u = await mk();
      const k = await consent(u, kind);
      await P[role].query(`update ${view} set withdrawn_at=now() where id=$1`, [k]);
      await rule({ refuse: () => P[role].query(`update ${view} set withdrawn_at=null where id=$1`, [k]), expect: "consent guard" });
    });
    it(`must not: ${role}: withdraw a second time or backdate a withdrawal`, async () => {
      const u = await mk();
      const k = await consent(u, kind);
      await rule({ refuse: () => P[role].query(`update ${view} set withdrawn_at='1999-01-01' where id=$1`, [k]), expect: "consent guard" });
      await rule({ refuse: () => P[role].query(`update ${view} set withdrawn_at=now() + interval '1 day' where id=$1`, [k]), expect: "consent guard" });
      await P[role].query(`update ${view} set withdrawn_at=now() where id=$1`, [k]);
      await rule({ refuse: () => P[role].query(`update ${view} set withdrawn_at=now() where id=$1`, [k]), expect: "consent guard" });
    });
    it(`must: ${role}: give consent stamped now, and withdraw it stamped now`, async () => {
      const u = await mk();
      const r = await P[role].query(`insert into ${view}(${kind}_user_id,consent_text_id) values($1,$2)`, [u, ct]);
      expect(r.rowCount).toBe(1);
      const k = (await su(`select id, given_at from consent_record where ${kind}_user_id=$1`, [u])).rows[0];
      expect(Math.abs(Date.now() - new Date(k.given_at).getTime())).toBeLessThan(60000);
      await rule({ ok: () => P[role].query(`update ${view} set withdrawn_at=now() where id=$1`, [k.id]) });
      const w = (await su("select withdrawn_at from consent_record where id=$1", [k.id])).rows[0].withdrawn_at;
      expect(Math.abs(Date.now() - new Date(w).getTime())).toBeLessThan(60000);
    });
  }
  it("must: the erase function still turns consent into bare proof", async () => {
    const c = await F.cand();
    const k = await consent(c);
    await su("update consent_record set withdrawn_at = now() where id=$1", [k]);
    await P.app_admin.query("select private.erase_candidate($1, true)", [c]);
    expect((await su("select subject_erased_at is not null e from consent_record where id=$1", [k])).rows[0].e).toBe(true);
  });
});

// ---- F9
describe("F9 last_active_at", () => {
  it("must not: app_candidate: set last_active_at in the future", async () => {
    const c = await F.cand();
    await rule({ refuse: () => P.app_candidate.query("update candidate_user set last_active_at='infinity' where id=$1", [c]), expect: "last_active_at" });
    await rule({ refuse: () => P.app_candidate.query("update candidate_user set last_active_at=now() + interval '1 day' where id=$1", [c]), expect: "last_active_at" });
  });
  it("must not: app_candidate: insert a user with last_active_at in the future", async () => {
    const i = id("c");
    await rule({ refuse: () => P.app_candidate.query("insert into candidate_user(id,name,email,email_verified,last_active_at) values($1,'F',$2,true,'infinity')", [i, `${i}@example.test`]), expect: "last_active_at" });
  });
  it("must: app_candidate: touch last_active_at with now(), insert without it", async () => {
    const c = await F.cand();
    await rule({ ok: () => P.app_candidate.query("update candidate_user set last_active_at=now() where id=$1", [c]) });
    const i = id("c");
    await rule({ ok: () => P.app_candidate.query("insert into candidate_user(id,name,email,email_verified) values($1,'F',$2,true)", [i, `${i}@example.test`]) });
  });
});

// ---- F5: documents a limit, no fix
describe("F5 role timeouts", () => {
  it("documents: a session of an app role can lift its own statement_timeout (the timeouts are defaults for honest code only)", async () => {
    const client = await db.pool("app_candidate").connect();
    try {
      expect((await client.query("show statement_timeout")).rows[0].statement_timeout).toBe("5s");
      await client.query("set statement_timeout = 0");
      expect((await client.query("show statement_timeout")).rows[0].statement_timeout).toBe("0");
    } finally {
      client.release(true); // destroy the connection so the changed setting is not reused
    }
  });
});

// ---- Performance: each new trigger does one primary-key lookup. EXPLAIN (ANALYZE, BUFFERS) of one insert, rolled back.
describe("performance of the new triggers", () => {
  async function explain(role, sql, args, trigger) {
    const c = await db.pool(role).connect();
    try {
      await c.query("begin");
      await c.query(sql, args); // warm the catalog caches first, so the pages counted are the statement's own
      await c.query("rollback");
      await c.query("begin");
      const plan = (await c.query(`explain (analyze, buffers, format json) ${sql}`, args)).rows[0]["QUERY PLAN"][0];
      if (process.env.SIDE_FIXES_PRINT) console.log(trigger, role, JSON.stringify({ pages: (plan.Plan["Shared Hit Blocks"] ?? 0) + (plan.Plan["Shared Read Blocks"] ?? 0), trigger: plan.Triggers.find((x) => x["Trigger Name"] === trigger) }));
      const t = plan["Triggers"].find((x) => x["Trigger Name"] === trigger);
      const root = plan["Plan"];
      const pages = (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
      return { calls: t["Calls"], ms: t["Time"], pages, total: plan["Execution Time"] };
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
  // Budgets are generous (a real regression is a scan, not one more page): one call, under 200 ms, and the whole warm statement under 60 pages (measured: 6 to 16).
  // Time: 200 ms, not 20, because a busy parallel `npm run check` can stall a statement (11 November 2026); pages are the real guard.
  const budget = (r) => { expect(r.calls).toBe(1); expect(r.ms).toBeLessThan(200); expect(r.pages).toBeLessThan(60); };
  it("job_text insert: one call, one lookup of job by primary key (adds about 5 pages)", async () => {
    const f = await fetchedJob();
    budget(await explain("app_fetcher", "insert into job_text(job_id,advert_text) values($1,'x')", [f], "job_text_guard"));
  });
  it("case_document insert: one call, one lookup of services_case by primary key (adds about 3 pages)", async () => {
    const c = await F.cand(), sc = await caseOf(c, "candidate");
    budget(await explain("app_candidate", "insert into candidate_case_document(services_case_id,storage_key,file_name,content_type,byte_size,candidate_user_id) values($1,'k','f','pdf',1,$2)", [sc, c], "case_document_guard"));
  });
  it("services_case insert: one call, one lookup of consent_record by primary key per consent named (adds about 4 pages)", async () => {
    const c = await F.cand(), k = await consent(c);
    budget(await explain("app_candidate", "insert into candidate_services_case(candidate_user_id,consent_record_id,permit_type) values($1,$2,'general')", [c, k], "services_case_guard"));
  });
  it("consent_record update: one call, no lookup (adds 0 pages)", async () => {
    const c = await F.cand(), k = await consent(c);
    budget(await explain("app_candidate", "update candidate_consent_record set withdrawn_at=now() where id=$1", [k], "consent_record_guard"));
  });
});
