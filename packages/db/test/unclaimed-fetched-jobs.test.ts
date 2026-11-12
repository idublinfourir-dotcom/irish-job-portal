// Migration 0010: a company going back to unclaimed closes only its own draft and in_review posts (source employer or agency).
// Fetched jobs waiting in the admin queue (in_review) and staff-made jobs stay as they are, with their review items. The two paths
// back to unclaimed are an admin decision (a rejected false claim on a real sponsor) and the claim_needs_info retention rule.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb, su: pg.Pool, admin: pg.Pool, portal: pg.Pool, fetcher: pg.Pool;
let srcE: number, srcF: number;
let F: { org(o?: object): Promise<number>; portal(o?: object): Promise<string> };
let n = 0;

const job = async (as: pg.Pool, org: number, source: string, status: string, advert: number | null = null) =>
  (await as.query<{ id: number }>(
    `insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, closes_at, own_page_url, salary_low, status)
     values ($1, $2, $3, $4, 'Nurse', 'Real Sponsor', 'health', 'critical_skills', now() + interval '20 days', $5, 40000, $6) returning id`,
    [org, source, source === "fetched" ? srcF : srcE, advert, `https://ads.test/${++n}`, status])).rows[0]!.id;
const advert = async () =>
  (await fetcher.query<{ id: number }>("insert into fetched_advert(job_source_id, external_id, result) values ($1, $2, 'queued') returning id", [srcF, `e${++n}`])).rows[0]!.id;
const fetchedJob = async (org: number, status: string) => job(fetcher, org, "fetched", status, await advert());
const state = async (id: number) => (await su.query("select status, close_reason from job where id = $1", [id])).rows[0];
const openItems = async (org: number) =>
  Number((await su.query("select count(*) from review_item r join job j on j.id = r.job_id where j.organisation_id = $1 and r.queue = 'fetched_job' and r.status = 'open'", [org])).rows[0].count);

// A real sponsor with what a fetch leaves behind (two in_review fetched jobs, each with its open admin queue item), one staff-made draft,
// then a false claim and the claimant's own draft and in_review posts. (Live jobs are never touched by the cleanup: two-person.test.ts.)
async function claimedSponsor() {
  const org = await F.org({ status: "unclaimed" });
  const queued = [await fetchedJob(org, "in_review"), await fetchedJob(org, "in_review")];
  const staffMade = await job(su, org, "admin_manual", "draft");
  const claimant = await F.portal();
  await portal.query("select private.claim_organisation($1, $2)", [claimant, org]);
  const own = [await job(su, org, "employer", "draft"), await job(su, org, "employer", "in_review")];
  return { org, queued, staffMade, own };
}

async function expectKept(s: Awaited<ReturnType<typeof claimedSponsor>>) {
  for (const q of s.queued) expect(await state(q)).toEqual({ status: "in_review", close_reason: null });
  expect(await openItems(s.org)).toBe(2);
  expect(await state(s.staffMade)).toEqual({ status: "draft", close_reason: null });
  for (const o of s.own) expect(await state(o)).toEqual({ status: "closed", close_reason: "removed" });
}

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  portal = db.pool("app_portal");
  fetcher = db.pool("app_fetcher");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  srcE = (await su.query("insert into job_source(kind, board) values ('employer', 'portal') returning id")).rows[0].id;
  srcF = (await su.query("insert into job_source(kind, board) values ('fetched', 'irishjobs') returning id")).rows[0].id;
});
afterAll(async () => db?.drop());

describe("back to unclaimed keeps fetched and staff-made jobs (0010)", () => {
  it("staff moving a falsely claimed sponsor back to unclaimed close only the claimant's own draft and in_review posts", async () => {
    const s = await claimedSponsor();
    expect((await su.query("select status from organisation where id = $1", [s.org])).rows[0].status).toBe("pending_review");
    await admin.query("update organisation set status = 'unclaimed' where id = $1", [s.org]);
    await expectKept(s);
    // the rest of the cleanup is unchanged: no members left, claim columns empty
    expect(Number((await su.query("select count(*) from membership where organisation_id = $1 and status <> 'removed'", [s.org])).rows[0].count)).toBe(0);
    expect((await su.query("select claimed_at, verified_at, signup_path from organisation where id = $1", [s.org])).rows[0]).toEqual({ claimed_at: null, verified_at: null, signup_path: null });
  });

  it("the claim_needs_info retention rule does the same", async () => {
    const s = await claimedSponsor();
    await admin.query("update organisation set status = 'needs_info' where id = $1", [s.org]);
    // age the needs_info status past the rule's limit (the guard sets status_changed_at, so it is switched off for this one update)
    await su.query("alter table organisation disable trigger organisation_guard");
    await su.query("update organisation set status_changed_at = now() - interval '400 days' where id = $1", [s.org]);
    await su.query("alter table organisation enable trigger organisation_guard");
    for (let i = 0; i < 20; i++) {
      const r = (await admin.query("select private.run_retention(1000) as r")).rows[0].r;
      if (r.rule === "claim_needs_info" || r.rule === null) break;
    }
    expect((await su.query("select status from organisation where id = $1", [s.org])).rows[0].status).toBe("unclaimed");
    await expectKept(s);
  });

  it("must not: the portal login cannot make a job that looks fetched, so its own posts cannot dodge the cleanup", async () => {
    const org = await F.org({ status: "pending_review" });
    await expect(job(portal, org, "fetched", "draft")).rejects.toThrow();
    await expect(job(portal, org, "admin_manual", "draft")).rejects.toThrow();
  });

  it("budget: moving a sponsor with 40 fetched jobs in review back to unclaimed takes under 30 ms", async () => {
    const org = await F.org({ status: "pending_review" });
    for (let i = 0; i < 40; i++) await fetchedJob(org, "in_review");
    await job(su, org, "employer", "draft");
    const t = performance.now();
    await admin.query("update organisation set status = 'unclaimed' where id = $1", [org]);
    const ms = performance.now() - t; // about 5 ms measured alone (12 November 2026)
    expect(Number((await su.query("select count(*) from job where organisation_id = $1 and status = 'in_review'", [org])).rows[0].count)).toBe(40);
    expect(ms).toBeLessThan(30);
  });
});
