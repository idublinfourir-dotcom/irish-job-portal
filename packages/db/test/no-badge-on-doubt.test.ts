// Integration: migration 0077 (AUTO1, decisions #298 and #299), run again on seeded rows of the real test database. It closes, once, the jobs the fetcher queued before it stopped asking
// staff, and leaves every other job alone. Fake adverts and companies only, no network.
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type Role, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const SQL = readFileSync(new URL("../migrations/0077_no_badge_on_doubt.sql", import.meta.url), "utf8");
const BODY = SQL.replace(/^(set|reset) role.*$/gm, ""); // the statement alone: the test's anon and authenticated pools log in as postgres, so "set role" works for them
const PERF_MS = 5_000; // 3,000 waiting jobs, ten times live; measured 25 Nov 2026: see the printed line

let db: TestDb, org: number, src: string, staff: string;
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>, id: (p: string) => string;
type Seed = { stage?: string; model?: string | null; quote?: string | null; gone?: boolean; result?: string; item?: "open" | "claimed" | "done"; status?: string };
/** A fetched job the fetcher queued (the trigger makes its review item), with its text and a hash. */
async function waiting(o: Seed = {}) {
  const advert = (await su(
    "insert into fetched_advert(job_source_id, external_id, title, employer_name, result, stage, matcher_model, quoted_evidence, content_hash, gone_at) values ($1, $2, 'Fake Engineer', 'Fake Co', $3, $4, $5, $6, repeat('a', 64), $7) returning id",
    [src, id("ext"), o.result ?? "queued", o.stage ?? "5 unsure occupation (admin queue)", o.model === undefined ? "rules" : o.model, o.quote ?? null, o.gone ? new Date() : null])).rows[0].id as string;
  const job = (await su(
    `insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, status, closes_at, search_vector, own_page_url)
     values ($1, 'fetched', $2, $3, 'Fake Engineer', 'Fake Co', 'IT', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', 'Fake Engineer'), 'https://jobs.example.test/a') returning id::text`,
    [org, src, advert])).rows[0].id as string;
  await su("insert into job_text(job_id, advert_text) values ($1, 'Fake text.')", [job]);
  if (o.item === "claimed") await su("update review_item set status = 'claimed', claimed_by_staff_user_id = $2, claimed_at = now() where job_id = $1", [job, staff]);
  if (o.item === "done") await su("update review_item set status = 'done', decided_by_staff_user_id = $2, decided_at = now(), outcome = 'approved' where job_id = $1", [job, staff]);
  if (o.status) await su("update job set status = $2, badge = case when $2 = 'live' then 'critical_skills_eligible' end, hidden_reason = case when $2 = 'hidden' then 'admin' end where id = $1", [job, o.status]);
  return job;
}
const look = async (job: string) =>
  (await su("select j.status, j.close_reason, j.search_vector is not null as vector, j.closed_at is not null as closed_at, (select count(*)::int from job_text t where t.job_id = j.id) as texts, r.status as item, r.outcome, " +
    "a.result, a.content_hash is not null as hash from job j join fetched_advert a on a.id = j.fetched_advert_id left join review_item r on r.job_id = j.id where j.id = $1", [job])).rows[0];
const CLOSED = { status: "closed", close_reason: "recheck_failed", vector: false, closed_at: true, texts: 0, item: "dropped", outcome: "no_badge_on_doubt", result: "rejected" };
const run = () => su(SQL);

beforeAll(async () => {
  db = await createTestDb();
  const f = fixtures(db) as unknown as { id: typeof id; su: typeof su; F: { org(): Promise<number>; staff(): Promise<string> } };
  ({ id, su } = f);
  org = await f.F.org();
  staff = await f.F.staff();
  src = (await su("insert into job_source(kind, board) values ('fake', 'doubt') returning id")).rows[0].id;
});
afterAll(() => db.drop());

describe("0077: the jobs the fetcher queued before #298", () => {
  it.each<[string, Seed, boolean]>([
    ["the rules were unsure", {}, true],
    ["another doubt stage", { stage: "7 contract unclear (admin queue)" }, true],
    ["scam wording", { stage: "0 scam wording (admin queue)" }, true],
    ["the advert is gone", { gone: true }, true],
    ["a public pay pass: no hash, so the next fetch reads it again and decides (#299)", { stage: "8 no salary, not a big company", model: "m", quote: "words" }, false],
    ["a public pay pass below the minimum", { stage: "8 salary below €40,904", model: "m", quote: "words" }, false],
    ["a public pay pass whose advert is gone: the hash stays", { stage: "8 no salary, not a big company", model: "m", gone: true }, true],
    ["the model disagreed, with its quote", { model: "m", quote: "words" }, true],
    ["the model took the badge with no quote (none named, or no usable reply): no hash, so it is read and asked again", { model: "m" }, false],
    ["no quote, but the advert is gone: the hash stays", { model: "m", gone: true }, true],
    ["no model named at all", { model: null }, true],
  ])("%s: closed with no text, the item dropped, the advert rejected", async (_name, seed, hash) => {
    const job = await waiting(seed);
    await run();
    expect(await look(job)).toEqual({ ...CLOSED, hash });
  });
  it.each<[string, Seed, object]>([
    ["an item a staff member claimed", { item: "claimed" }, { status: "in_review", texts: 1, item: "claimed", result: "queued" }],
    ["an item staff decided", { item: "done" }, { status: "in_review", texts: 1, item: "done", result: "queued" }],
    ["a job staff put back in review (its advert passed)", { result: "passed", stage: "PASS (salary stated)" }, { status: "in_review", texts: 1, item: "open", result: "passed" }],
    ["a live job", { status: "live" }, { status: "live", texts: 1, vector: true, result: "queued" }],
    ["a hidden job", { status: "hidden" }, { status: "hidden", texts: 1, result: "queued" }],
  ])("%s is not touched", async (_name, seed, expected) => {
    const job = await waiting(seed);
    const before = await look(job);
    expect(before).toMatchObject(expected);
    await run();
    expect(await look(job)).toEqual(before);
  });
  it("an employer's own job in review keeps its item and its text", async () => {
    const employer = (await su("insert into organisation(slug, display_name, kind, status) values ($1, 'Fake Employer', 'employer', 'verified') returning id", [id("org")])).rows[0].id;
    const job = (await su(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, own_page_url)
       values ($1, 'employer', $2, 'Fake Cook', 'Fake Employer', 'IT', 'critical_skills', 50000, 'in_review', now() + interval '20 days', 'https://jobs.example.test/e') returning id::text`, [employer, src])).rows[0].id;
    await su("insert into job_text(job_id, advert_text) values ($1, 'Fake text.')", [job]);
    await run();
    expect((await su("select j.status, r.queue, r.status as item, (select count(*)::int from job_text t where t.job_id = j.id) as texts from job j join review_item r on r.job_id = j.id where j.id = $1", [job])).rows)
      .toEqual([{ status: "in_review", queue: "scam_flag", item: "open", texts: 1 }]);
  });
  it("a second run changes nothing", async () => {
    const job = await waiting();
    await run();
    const at = async () => (await su("select j.closed_at, r.decided_at from job j join review_item r on r.job_id = j.id where j.id = $1", [job])).rows[0];
    const first = await at();
    await run();
    expect(await at()).toEqual(first);
  });
});

describe("security", () => {
  it("a job it closed never shows on the public closed-job page (0075), gone or not: it was never public", async () => {
    const jobs = [await waiting(), await waiting({ gone: true })];
    await run();
    for (const j of jobs) expect((await db.pool("app_candidate").query("select * from private.candidate_closed_job($1::bigint)", [j])).rows).toEqual([]);
  });
  it.each<Role>(["app_candidate", "app_portal", "app_fetcher", "app_backup", "anon", "authenticated"])("%s cannot run it", async (role) => {
    const job = await waiting();
    await expect(db.pool(role).query(BODY)).rejects.toThrow(/permission denied/);
    expect(await look(job)).toMatchObject({ status: "in_review", item: "open", texts: 1 });
  });
  it("the fetcher still cannot move a waiting job anywhere itself", async () => {
    const job = await waiting();
    for (const to of ["closed", "live"]) await expect(db.pool("app_fetcher").query("update job set status = $2, badge = case when $2 = 'live' then 'critical_skills_eligible' end where id = $1", [job, to])).rejects.toThrow(/never moves a job out of in_review/);
  });
});

it("performance: 3,000 waiting jobs in one go", async () => {
  await su(`with a as (insert into fetched_advert(job_source_id, external_id, title, employer_name, result, stage, matcher_model, content_hash) select $1, 'perf-' || g, 'T', 'E', 'queued', '5 unsure occupation (admin queue)', 'rules', repeat('b', 64) from generate_series(1, 3000) g returning id),
    j as (insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url) select $2, 'fetched', $1, a.id, 'T', 'E', 'IT', 'critical_skills', 'in_review', 'infinity', 'https://jobs.example.test/p' from a returning id)
    insert into job_text(job_id, advert_text) select id, repeat('Fake words. ', 400) from j`, [src, org]);
  const t = performance.now();
  await run();
  const ms = performance.now() - t;
  console.log(`0077 on 3,000 waiting jobs: ${Math.round(ms)} ms`);
  expect((await su("select count(*)::int n from job j join fetched_advert a on a.id = j.fetched_advert_id where a.external_id like 'perf-%' and j.status = 'closed'")).rows[0].n).toBe(3000);
  expect(ms).toBeLessThan(PERF_MS);
});
