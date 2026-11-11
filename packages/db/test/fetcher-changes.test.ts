/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Migration 0006_fetcher_changes: fetched_advert.content_hash, the short-text check on fetched_advert, the close reason 'recheck_failed'
// and the one change to job_guard (the fetcher may reopen a job it closed as recheck_failed). Every action runs as the real role;
// fixtures are inserted as postgres. One "must not" and one "must" per rule. Fake data only.
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

const HASH = "a".repeat(64);
const advert = (fields = {}) => ins("postgres", "fetched_advert", { job_source_id: board, external_id: id("x"), result: "passed", ...fields });
// A fetched job (live unless told otherwise), closed with the given reason when `closed` is set.
async function fetchedJob({ status = "live", closed = null } = {}) {
  const j = await su(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,own_page_url,closes_at,search_vector,badge)
     values($1,'fetched',$2,'t','e','it','critical_skills',$3,'u','infinity',to_tsvector('x'),'critical_skills_eligible') returning id`,
    [org, board, status],
  ).then((r) => r.rows[0].id);
  if (closed) await su("update job set status='closed', close_reason=$2, closed_at=now(), search_vector=null where id=$1", [j, closed]);
  return j;
}
const employerJob = (status = "live") =>
  ins("postgres", "job", { organisation_id: org, source: "employer", job_source_id: portalSrc, title: "t", employer_name: "e", sector: "it", permit_type: "critical_skills", status, closes_at: in30(), own_page_url: "u", salary_low: 40000, search_vector: "'x':1" });
const reopen = (job) => P.app_fetcher.query("update job set status='live', close_reason=null, closed_at=null, search_vector=to_tsvector('x') where id=$1", [job]);

// ---- fetched_advert.content_hash
describe("content_hash", () => {
  it("must: app_fetcher: write a hash on insert and change it on update", async () => {
    await rule({ ok: () => P.app_fetcher.query("insert into fetched_advert(job_source_id,external_id,result,content_hash) values($1,$2,'passed',$3)", [board, id("x"), HASH]) });
    const a = await advert();
    await rule({ ok: () => P.app_fetcher.query("update fetched_advert set content_hash=$2 where id=$1", [a, "0123456789abcdef".repeat(4)]) });
    expect((await su("select content_hash from fetched_advert where id=$1", [a])).rows[0].content_hash).toBe("0123456789abcdef".repeat(4));
  });
  it("must: app_fetcher: leave the hash empty (null means assess once more)", async () => {
    await rule({ ok: () => P.app_fetcher.query("insert into fetched_advert(job_source_id,external_id,result) values($1,$2,'queued')", [board, id("x")]) });
  });
  it("must not: any role: store a value that is not 64 lowercase hex characters", async () => {
    const a = await advert();
    for (const bad of ["abc", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "Senior engineer, Dublin. Apply now for this role at Fake Ltd and more words"]) {
      await rule({ refuse: () => P.app_fetcher.query("update fetched_advert set content_hash=$2 where id=$1", [a, bad]), expect: "content_hash_check" });
    }
    await rule({ refuse: () => P.postgres.query("update fetched_advert set content_hash='x' where id=$1", [a]), expect: "content_hash_check" });
    await rule({ refuse: () => P.app_fetcher.query("insert into fetched_advert(job_source_id,external_id,result,content_hash) values($1,$2,'passed','nothex')", [board, id("x")]), expect: "content_hash_check" });
  });
  it("must: app_admin: read the hash", async () => {
    const a = await advert({ content_hash: HASH });
    await rule({ ok: () => P.app_admin.query("select content_hash from fetched_advert where id=$1", [a]) });
    expect((await P.app_admin.query("select content_hash from fetched_advert where id=$1", [a])).rows[0].content_hash).toBe(HASH);
  });
  it("must not: app_admin: update the hash (only result)", async () => {
    const a = await advert();
    await rule({ refuse: () => P.app_admin.query("update fetched_advert set content_hash=$2 where id=$1", [a, HASH]), expect: "permission denied" });
  });
  it("must not: app_candidate and app_portal: read the hash", async () => {
    for (const role of ["app_candidate", "app_portal"]) {
      await rule({ refuse: () => P[role].query("select content_hash from fetched_advert limit 1"), expect: "permission denied" });
    }
  });
});

// ---- the short-text check (#122): a rejected advert keeps short evidence, never the advert
describe("short text on fetched_advert", () => {
  const cols = { stage: 200, reason: 500, quoted_evidence: 500 };
  for (const [col, max] of Object.entries(cols)) {
    it(`must not: app_fetcher: store ${max + 1} characters in ${col}`, async () => {
      const a = await advert();
      await rule({ refuse: () => P.app_fetcher.query(`update fetched_advert set ${col}=$2 where id=$1`, [a, "x".repeat(max + 1)]), expect: "fetched_advert_short_text" });
      await rule({ refuse: () => P.app_fetcher.query(`insert into fetched_advert(job_source_id,external_id,result,${col}) values($1,$2,'rejected',$3)`, [board, id("x"), "x".repeat(max + 1)]), expect: "fetched_advert_short_text" });
    });
    it(`must: app_fetcher: store exactly ${max} characters in ${col}, and null`, async () => {
      const a = await advert();
      await rule({ ok: () => P.app_fetcher.query(`update fetched_advert set ${col}=$2 where id=$1`, [a, "x".repeat(max)]) });
      await rule({ ok: () => P.app_fetcher.query(`update fetched_advert set ${col}=null where id=$1`, [a]) });
    });
  }
});

// ---- close reason recheck_failed, fetched jobs only
describe("recheck_failed", () => {
  it("must: app_fetcher: close a live fetched job as recheck_failed", async () => {
    const j = await fetchedJob();
    await rule({ ok: () => P.app_fetcher.query("update job set status='closed', close_reason='recheck_failed', search_vector=null where id=$1", [j]) });
    const r = (await su("select status, close_reason, closed_at from job where id=$1", [j])).rows[0];
    expect(r.close_reason).toBe("recheck_failed");
    expect(r.closed_at).not.toBeNull(); // job_closed_at stamps it
  });
  it("must: app_fetcher: reopen a job closed as recheck_failed, to live", async () => {
    const j = await fetchedJob({ closed: "recheck_failed" });
    await rule({ ok: () => reopen(j) });
    expect((await su("select status, close_reason from job where id=$1", [j])).rows[0]).toEqual({ status: "live", close_reason: null });
  });
  it("must not: app_fetcher: move a job closed as recheck_failed to in_review or draft", async () => {
    const j = await fetchedJob({ closed: "recheck_failed" });
    await rule({ refuse: () => P.app_fetcher.query("update job set status='in_review' where id=$1", [j]), expect: "reopens" });
    await rule({ refuse: () => P.app_fetcher.query("update job set status='draft' where id=$1", [j]), expect: "reopens" });
  });
  it("must not: app_fetcher: reopen a removed or under_review_expired job (F1 stays)", async () => {
    for (const reason of ["removed", "under_review_expired"]) {
      const j = await fetchedJob({ closed: reason });
      await rule({ refuse: () => reopen(j), expect: "reopens" });
    }
  });
  it("must not: app_fetcher: relabel a removed job as recheck_failed", async () => {
    const j = await fetchedJob({ closed: "removed" });
    await rule({ refuse: () => P.app_fetcher.query("update job set close_reason='recheck_failed' where id=$1", [j]), expect: "close reason" });
    await rule({ refuse: () => P.app_fetcher.query("update job set status='live', close_reason='recheck_failed' where id=$1", [j]), expect: "reopens" });
  });
  it("must not: app_portal and app_admin: set recheck_failed on an employer job", async () => {
    const live = await employerJob();
    await rule({ refuse: () => P.app_portal.query("update job set status='closed', close_reason='recheck_failed', closed_at=now(), search_vector=null where id=$1", [live]), expect: "job_recheck_failed_fetched" });
    await rule({ refuse: () => P.app_admin.query("update job set status='closed', close_reason='recheck_failed', closed_at=now(), search_vector=null where id=$1", [live]), expect: "job_recheck_failed_fetched" });
  });
  it("must not: app_fetcher: use a close reason outside the list", async () => {
    const j = await fetchedJob();
    await rule({ refuse: () => P.app_fetcher.query("update job set status='closed', close_reason='because', closed_at=now(), search_vector=null where id=$1", [j]), expect: "job_close_reason_check" });
  });
  it("must: app_admin: close a fetched job as recheck_failed (the constraint is about source, not role)", async () => {
    const j = await fetchedJob();
    await rule({ ok: () => P.app_admin.query("update job set status='closed', close_reason='recheck_failed', closed_at=now(), search_vector=null where id=$1", [j]) });
  });
});

// ---- Performance: the reopen update runs job_guard once (one organisation lookup by primary key). EXPLAIN (ANALYZE, BUFFERS), rolled back.
describe("performance of the reopen update", () => {
  it("reopen of a recheck_failed job: job_guard called once, under 200 ms, under 60 pages", async () => {
    const j = await fetchedJob({ closed: "recheck_failed" });
    const c = await db.pool("app_fetcher").connect();
    const sql = "update job set status='live', close_reason=null, closed_at=null, search_vector=to_tsvector('x') where id=$1";
    try {
      await c.query("begin");
      await c.query(sql, [j]); // warm the catalog caches first, so the pages counted are the statement's own
      await c.query("rollback");
      await c.query("begin");
      const plan = (await c.query(`explain (analyze, buffers, format json) ${sql}`, [j])).rows[0]["QUERY PLAN"][0];
      const t = plan["Triggers"].find((x) => x["Trigger Name"] === "job_guard");
      const pages = (plan["Plan"]["Shared Hit Blocks"] ?? 0) + (plan["Plan"]["Shared Read Blocks"] ?? 0);
      if (process.env.FETCHER_CHANGES_PRINT) console.log("reopen", JSON.stringify({ pages, trigger: t, total: plan["Execution Time"] }));
      expect(t["Calls"]).toBe(1);
      // About 0.1 ms alone; 20 ms failed once inside a busy parallel `npm run check` (11 November 2026). Pages are the real guard.
      expect(t["Time"]).toBeLessThan(200);
      expect(pages).toBeLessThan(60);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
