// Integration: the stale-board close (W1c follow-up) on the real test database as app_fetcher. Boards are fake tasks run on chosen days;
// staff holds are set as the owner would. No network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/db";
import { closeStale, runBoards } from "../src";
import { advert, deps, fakeModel, NOW, plan, task } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ads = (board: string, ...ids: string[]) => ids.map((i) => advert(`${board}-${i}`, { board }));
async function fetchOn(when: Date, board: string, list: ReturnType<typeof ads>) {
  const [r] = await runBoards(deps(db.pool("app_fetcher"), [task("fake", board, list)], { now: () => when, checkBatch: fakeModel().checkBatch }), (x) => plan(x, "passed"));
  return r!;
}
const job = async (board: string, id: string) =>
  (await su("select j.id, j.status, j.close_reason, j.closed_at, j.search_vector is not null as vector, f.gone_at, (select count(*)::int from job_text t where t.job_id = j.id) as texts " +
    "from fetched_advert f join job j on j.fetched_advert_id = f.id where f.external_id = $1", [`fake:b:${board}-${id}`]))[0];

beforeAll(async () => {
  db = await createTestDb();
  expect(await fetchOn(ago(8), "s8", ads("s8", "a1", "a2", "held", "removed"))).toMatchObject({ ok: true, passed: 4 });
  expect(await fetchOn(ago(7), "s7", ads("s7", "a1"))).toMatchObject({ ok: true, passed: 1 });
  expect(await fetchOn(ago(6), "s6", ads("s6", "a1"))).toMatchObject({ ok: true, passed: 1 });
  expect(await fetchOn(ago(1), "never", ads("never", "a1"))).toMatchObject({ ok: true, passed: 1 });
  // staff hold one job in review and closed another; a board that never had a good fetch, first seen 10 days ago
  await su("update job set status = 'in_review' where id = $1", [(await job("s8", "held")).id]);
  await su("update job set status = 'closed', close_reason = 'removed', closed_at = $2 where id = $1", [(await job("s8", "removed")).id, ago(5)]);
  await su("update job_source set last_ok_at = null where board = 'never'");
  await su("update fetched_advert set first_seen_at = $1 where external_id = 'fake:b:never-a1'", [ago(10)]);
});
afterAll(() => db.drop());

describe("stale-board close", () => {
  it("closes the live jobs of a board last good 8 days ago (and of one never good, first seen 10 days ago); 7 and 6 days ago stay; staff-held jobs untouched", async () => {
    expect(await closeStale(db.pool("app_fetcher"), NOW)).toBe(3);
    for (const id of ["a1", "a2"]) expect(await job("s8", id)).toMatchObject({ status: "closed", close_reason: "source_stale", closed_at: NOW, vector: false, gone_at: NOW, texts: 0 });
    expect(await job("never", "a1")).toMatchObject({ status: "closed", close_reason: "source_stale" });
    expect(await job("s7", "a1")).toMatchObject({ status: "live", close_reason: null, texts: 1, gone_at: null });
    expect(await job("s6", "a1")).toMatchObject({ status: "live", texts: 1 });
    expect(await job("s8", "held")).toMatchObject({ status: "in_review", close_reason: null, texts: 1, gone_at: null });
    expect(await job("s8", "removed")).toMatchObject({ status: "closed", close_reason: "removed", closed_at: ago(5) });
    expect(await closeStale(db.pool("app_fetcher"), NOW)).toBe(0); // nothing left to close
  });

  it("a later good fetch that lists the job reopens it with its text; a job it does not list stays closed", async () => {
    const r = await fetchOn(NOW, "s8", ads("s8", "a1", "held"));
    expect(r).toMatchObject({ ok: true, changed: 1 });
    expect(await job("s8", "a1")).toMatchObject({ status: "live", close_reason: null, vector: true, gone_at: null, texts: 1 });
    expect(await job("s8", "a2")).toMatchObject({ status: "closed", close_reason: "source_stale" });
    expect(await job("s8", "held")).toMatchObject({ status: "in_review" });
    expect(await closeStale(db.pool("app_fetcher"), NOW)).toBe(0); // the board worked today
  });

  it("only fetched jobs can carry the reason, and only the fetcher's login runs the close", async () => {
    const [{ id: org }] = await su("insert into organisation(slug, display_name, kind) values ('stale-fake', 'Stale Fake Ltd', 'employer') returning id");
    const [{ id: src }] = await su("select id from job_source where kind = 'admin'");
    await expect(su("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, close_reason, closed_at, closes_at, own_page_url) values ($1, 'admin_manual', $2, 't', 'e', 'it', 'critical_skills', 'closed', 'source_stale', now(), now(), 'https://example.test/x')", [org, src]))
      .rejects.toThrow(/job_source_stale_fetched/);
    for (const role of ["app_candidate", "app_portal", "app_admin"] as const) await expect(closeStale(db.pool(role), NOW), role).rejects.toThrow(/permission denied/);
  });
});
