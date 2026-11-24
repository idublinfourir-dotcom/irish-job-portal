// B58 performance: the three statements of the staff search (as app_admin) and searchStaff itself, on 5,000 organisations, 100,000 jobs (a tenth of a year of
// fetches plus history, about 10 times Launch A) and 50,000 services cases. Pages are counted with EXPLAIN (ANALYZE, BUFFERS); time is the median of 9 warm calls.
// Fake data only. Measured 24 Nov 2026: organisations 81 pages 5.6 ms, jobs 3,946 pages 71 ms, a case 4 pages, the whole search 79 ms. Pages are about 1.5 times, time about 5 times that.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { fixtures } from "../fixtures";
import { SEARCH_CASES, SEARCH_JOBS, SEARCH_ORGANISATIONS, like, searchStaff } from "../../src/staff-search";
import { measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
export const ORG_PAGES = 130; // a scan of 5,000 organisations
export const JOB_PAGES = 6_000; // a scan of 100,000 jobs
export const CASE_PAGES = 10; // the primary key
export const SEARCH_MS = 400; // the whole search through the pool, administrator, text that matches nothing (the worst case: the scans read everything)
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  await su.query("insert into organisation(slug,display_name,kind,status,cro_number) select 'o'||g,'Fake Org '||g||' Ltd','employer','verified', case when g % 2 = 0 then (700000 + g)::text end from generate_series(1,5000) g");
  await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,county,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector)
     select (select min(id) from organisation) + g % 5000, 'employer', $1, 'Fake role number '||g||' for a fitter', 'Fake Org '||(g % 5000)||' Ltd', 'Cork', 'IT', 'critical_skills',
            (array['live','closed','closed','hidden_x'])[1 + g % 3], now() + interval '20 days', 'https://example.test', 30000 + g, 'x' from generate_series(1,100000) g`, [src]);
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) values ('p1','Fake','p1@example.test',true,now())");
  const text = await (fixtures(db) as unknown as { F: { text: (p: string) => Promise<string> } }).F.text("services_request");
  const consent = (await su.query("insert into consent_record(portal_user_id, consent_text_id) values ('p1',$1) returning id", [text])).rows[0].id;
  await su.query("insert into services_case(portal_user_id, consent_record_id, dedupe_key, status) select 'p1', $1, 'k'||g, 'received' from generate_series(1,50000) g", [consent]);
  await su.query("insert into staff_user(id,name,email,email_verified,status) values ('s1','Fake Staff','s1@example.test',true,'active')");
  await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ('s1','administrator',true)");
  await su.query("analyze");
});
afterAll(() => db.drop());

it("the organisation, job and case statements stay inside their page budgets, and a whole search inside its time budget", async () => {
  const a = await db.pool("app_admin").connect();
  try {
    const worst = "zzzz nothing matches this";
    const [org, job, cas] = await measurePages(a, [
      { text: SEARCH_ORGANISATIONS, values: [like(worst, "inside"), like(worst, "start")] },
      { text: SEARCH_JOBS, values: [like(worst, "inside"), null] },
      { text: SEARCH_CASES, values: ["25000"] },
    ]);
    const pool = db.pool("app_admin");
    for (let i = 0; i < 3; i++) await searchStaff(pool, "s1", worst);
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await searchStaff(pool, "s1", worst); ms.push(performance.now() - t); }
    const median = ms.sort((x, y) => x - y)[4]!;
    console.log(`staff search perf: organisations ${org!.pages} pages ${org!.ms} ms (${org!.scans}); jobs ${job!.pages} pages ${job!.ms} ms (${job!.scans}); case ${cas!.pages} pages ${cas!.ms} ms (${cas!.scans}); whole search median ${median.toFixed(1)} ms`);
    expect(org!.pages).toBeLessThanOrEqual(ORG_PAGES);
    expect(job!.pages).toBeLessThanOrEqual(JOB_PAGES);
    expect(cas!.pages).toBeLessThanOrEqual(CASE_PAGES);
    expect(median).toBeLessThan(SEARCH_MS);
    // the search finds what it should in this data
    expect((await searchStaff(pool, "s1", "Fake Org 4999 Ltd")).organisations!.items).toHaveLength(1);
  } finally {
    a.release();
  }
});
