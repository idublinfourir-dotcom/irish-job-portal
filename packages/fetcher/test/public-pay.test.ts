// Integration: an HSE advert shows by itself on its pay scale (decision #299), the real rules chain and the real planAdvert on the real test database as app_fetcher.
// The model is a fake; adverts, companies and boards are made up (the HSE only by its name, which is what the rule reads). No network.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HSE_ENTRY } from "@portal/rules";
import { createTestDb, type Role, type TestDb } from "../../db/test/db";
import { getJob } from "../../db/src/search";
import { CLOSE_PUBLIC_PAY, closePublicPay, isDue, runBoards, type BoardTask, type Deps } from "../src";
import { advert, badgeAd, counting, deps, fakeModel, MODEL, NOW, plan, says, task } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const MIGRATION = readFileSync(new URL("../../db/migrations/0077_no_badge_on_doubt.sql", import.meta.url), "utf8");
const PERF_MS = 5_000; // closing 2,000 live jobs; live has fewer than 10 of these

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
const fetcher = () => db.pool("app_fetcher");
const PAY = new Map<string, 1 | 2>([[HSE_ENTRY, 1], ["beaumont hospital", 2]]);
const run = (boards: BoardTask[], over: Partial<Deps> = {}, candidates: ReadonlyMap<string, 1 | 2> = PAY) => {
  const d = deps(fetcher(), boards, { checkBatch: fakeModel().checkBatch, ...over });
  return runBoards({ ...d, chain: { ...d.chain, publicPayCandidates: candidates } });
};
let n = 0;
const board = () => `p${++n}`;
const hse = (id: string, over: Parameters<typeof advert>[1] = {}) =>
  advert(id, { employer: "HSE Dublin and North East", title: "Staff Nurse", location: "Cavan, Ireland", description: "Join our ward. Permanent full time.", ...over });
const look = async (id: string) =>
  (await su(`select f.result, f.stage, f.matcher_model as model, f.content_hash is not null as hash, j.id::text as job, j.status, j.close_reason, j.badge, j.pass_route, j.search_vector is not null as vector,
      (select count(*)::int from job_text t where t.job_id = j.id) as texts, (select array_agg(r.status) from review_item r where r.job_id = j.id) as items
    from fetched_advert f left join job j on j.fetched_advert_id = f.id where f.external_id = $1`, [id]))[0];

beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

describe("an HSE advert", () => {
  it.each([["no pay stated", "Join our ward. Permanent full time."], ["pay under the minimum (#67: whatever is stated)", "Join our ward. The salary is €32,540 a year. Permanent full time."]])(
    "%s: live with the badge on the pay scale route, nobody asked, and the candidate site reads it", async (_n, description) => {
      const b = board(), a = hse(`${b}-1`, { description });
      const [r] = await run([task("fake", b, [a])]);
      expect(r).toMatchObject({ ok: true, passed: 1, queued: 0, rejected: 0, unsaved: [] });
      const got = await look(a.id);
      expect(got).toMatchObject({ result: "passed", model: MODEL, status: "live", badge: "critical_skills_eligible", pass_route: "public_pay", vector: true, texts: 1, items: null });
      expect(await getJob(db.pool("app_candidate"), got.job)).toMatchObject({ passRoute: "public_pay", badge: "critical_skills_eligible" });
    });
  it("the model does not back it, or scam wording, or a Section 38 name: refused, no job, no text, nobody asked", async () => {
    const b = board();
    const list = [hse(`${b}-no`), hse(`${b}-scam`, { description: "Join our ward. Permanent full time. You must pay a registration fee before you start." }), hse(`${b}-s38`, { employer: "Beaumont Hospital" })];
    const m = fakeModel((_n, a) => a.map(() => says(false)));
    const [r] = await run([task("fake", b, list)], { checkBatch: m.checkBatch });
    expect(r).toMatchObject({ passed: 0, queued: 0, rejected: 3, unsaved: [] });
    for (const a of list) expect(await look(a.id)).toMatchObject({ result: "rejected", job: null, texts: 0, items: null });
    expect(m.sizes).toEqual([2]); // a Section 38 name is no badge, so the model is not asked about it
  });
  it("the HSE switch off (#261): the same advert is any employer's, so no stated pay is no badge", async () => {
    const b = board(), a = hse(`${b}-1`);
    await run([task("fake", b, [a])], {}, new Map([["beaumont hospital", 2]]));
    expect(await look(a.id)).toMatchObject({ result: "rejected", stage: "8 no salary, not a big company", job: null });
  });
  it("security: a company whose name only holds the word never gets the route, on any board", async () => {
    const b = board();
    const list = ["Acme HSE Contractors", "HSE Recruitment Ltd", "HSE Dublin Limited", "HSE Safety Consultants Cork", "Dublin HSE", "HSE Solutions"].map((employer, i) => hse(`${b}-${i}`, { employer }));
    const [r] = await run([task("jobsireland", b, list)], { checkBatch: async () => { throw new Error("no badge, so no request"); } });
    expect(r).toMatchObject({ passed: 0, rejected: list.length, unsaved: [] });
    expect(Number((await su("select count(*) from job j join fetched_advert f on f.id = j.fetched_advert_id where f.external_id like $1", [`fake:b:${b}-%`]))[0].count)).toBe(0);
  });
});

describe("the jobs queued before (0077), then the next fetch", () => {
  it("a waiting HSE job closes, is read again at once although its board's reread day is another one, and goes live", async () => {
    const b = board();
    const a = Array.from({ length: 50 }, (_, i) => hse(`${b}-${i}`)).find((x) => !isDue(x.id, 7, NOW))!;
    await runBoards(deps(fetcher(), [task("fake", b, [a])], { checkBatch: fakeModel().checkBatch }), (x) => plan(x, "queued"));
    await su("update fetched_advert set stage = '8 no salary, not a big company' where external_id = $1", [a.id]);
    expect(await look(a.id)).toMatchObject({ status: "in_review", items: ["open"], hash: true });
    await su(MIGRATION);
    expect(await look(a.id)).toMatchObject({ result: "rejected", status: "closed", close_reason: "recheck_failed", texts: 0, items: ["dropped"], hash: false });
    const t = { ...task("fake", b, [a]), rereadDays: 7 };
    const [r] = await run([t]);
    expect(r).toMatchObject({ ok: true, changed: 1, unsaved: [] });
    expect(await look(a.id)).toMatchObject({ result: "passed", status: "live", close_reason: null, badge: "critical_skills_eligible", pass_route: "public_pay", vector: true, texts: 1, items: ["dropped"], hash: true });
  });
  it("a doubtful one stays closed: its hash is kept, so the next fetch does not read it again", async () => {
    const b = board(), a = Array.from({ length: 50 }, (_, i) => hse(`${b}-${i}`)).find((x) => !isDue(x.id, 7, NOW))!;
    await runBoards(deps(fetcher(), [task("fake", b, [a])], { checkBatch: fakeModel().checkBatch }), (x) => plan(x, "queued"));
    await su("update fetched_advert set stage = '7 contract unclear (admin queue)' where external_id = $1", [a.id]);
    await su(MIGRATION);
    const t = { ...task("fake", b, [a]), rereadDays: 7 };
    await run([t]);
    expect([...t.calls[0]!]).toEqual([a.id]);
    expect(await look(a.id)).toMatchObject({ status: "closed", items: ["dropped"] });
  });
});

describe("the switch is off: closePublicPay", () => {
  it("closes every live fetched job on the route, with its text, and nothing else; a second run closes none; the next read refuses the advert", async () => {
    const b = board(), a = hse(`${b}-1`), pay = badgeAd(`${b}-2`);
    await run([task("fake", b, [a, pay])]);
    const org = (await su("select organisation_id from job where id = $1", [(await look(a.id)).job]))[0].organisation_id;
    const other = async (status: string) => (await su(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, pass_route, status, hidden_reason, closes_at, own_page_url)
       values ($1, 'fetched', (select id from job_source where board = $2), 'Nurse', 'HSE Cork', 'health', 'critical_skills', 'public_pay', $3, case when $3 = 'hidden' then 'admin' end, 'infinity', 'https://jobs.example.test/h') returning id::text`,
      [org, b, status]))[0].id as string;
    const held = [await other("in_review"), await other("hidden")];
    const employer = (await su("insert into organisation(slug, display_name, kind, status) values ($1, 'Fake Employer', 'employer', 'verified') returning id", [`o-${b}`]))[0].id;
    const own = (await su(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, pass_route, pay_grade, badge, status, search_vector, closes_at, own_page_url)
       values ($1, 'employer', (select id from job_source where board = $2), 'Nurse', 'Fake Employer', 'health', 'critical_skills', 'public_pay', 'G', 'critical_skills_eligible', 'live', to_tsvector('english', 'Nurse'), now() + interval '20 days', 'https://jobs.example.test/o') returning id::text`, [employer, b]))[0].id as string;
    const { db: counted, sql } = counting(fetcher());
    expect(await closePublicPay(counted)).toBeGreaterThan(0);
    expect(sql).toHaveLength(1);
    expect(await look(a.id)).toMatchObject({ status: "closed", close_reason: "recheck_failed", vector: false, texts: 0, hash: false });
    expect(await look(pay.id)).toMatchObject({ status: "live", texts: 1, hash: true });
    expect((await su("select id::text, status from job where id = any($1::bigint[]) order by id", [[...held, own]])).map((x) => x.status)).toEqual(["in_review", "hidden", "live"]);
    expect(await closePublicPay(fetcher())).toBe(0);
    await run([{ ...task("fake", b, [a, pay]), rereadDays: 7 }], {}, new Map([["beaumont hospital", 2]]));
    expect(await look(a.id)).toMatchObject({ result: "rejected", status: "closed", hash: true });
  });
  it.each<Role>(["app_candidate", "app_portal", "app_backup"])("security: %s cannot run it", async (role) => {
    const b = board(), a = hse(`${b}-1`);
    await run([task("fake", b, [a])]);
    await expect(db.pool(role).query(CLOSE_PUBLIC_PAY)).rejects.toThrow(/permission denied/);
    expect((await look(a.id)).status).toBe("live");
    await closePublicPay(fetcher());
  });
  it("performance: 2,000 live jobs in one statement", async () => {
    const b = board(), a = hse(`${b}-1`);
    await run([task("fake", b, [a])]);
    await su(`with f as (insert into fetched_advert(job_source_id, external_id, title, employer_name, result, stage, content_hash) select (select id from job_source where board = $1), 'perf-' || g, 'T', 'HSE Cork', 'passed', '8 x', repeat('b', 64) from generate_series(1, 2000) g returning id),
      j as (insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, pass_route, badge, status, search_vector, closes_at, own_page_url)
        select (select organisation_id from job where id = $2), 'fetched', (select id from job_source where board = $1), f.id, 'T', 'HSE Cork', 'health', 'critical_skills', 'public_pay', 'critical_skills_eligible', 'live', to_tsvector('english', 'Nurse'), 'infinity', 'https://jobs.example.test/p' from f returning id)
      insert into job_text(job_id, advert_text) select id, repeat('Fake words. ', 400) from j`, [b, (await look(a.id)).job]);
    const t = performance.now();
    expect(await closePublicPay(fetcher())).toBe(2001);
    const ms = performance.now() - t;
    console.log(`closePublicPay on 2,001 live jobs: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(PERF_MS);
  });
});
