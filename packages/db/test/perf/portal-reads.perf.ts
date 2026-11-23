// Performance (B47, B49): the verification read, the one-job read and the jobs list (with its new fields), on 50,000 CRO rows, 20,000 company names,
// 48,000 jobs of 100 companies, one heavy company of 2,000 jobs, and one login with 3,000 notices of which the "ask for more" question is the oldest.
// Pages are counted with EXPLAIN (ANALYZE, BUFFERS), warm pass then measured pass. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ONE_JOB } from "../../../../apps/portal/lib/jobs";
import { createTestDb, type TestDb } from "../db";
import { measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 23 Nov 2026: verification 69 pages (the oldest of 3,000 notices found by the newest-first index), one job 24, the list of 200 jobs 40, each under 7 ms.
// Budgets are about 3 times the pages, the time a floor for a busy laptop.
export const VERIFICATION_PAGES = 200; // the company row, the CRO row by its unique index, the names by organisation_name_org_idx, the open review item by its unique index, and the newest notice of the login
export const ONE_JOB_PAGES = 75; // the job by its key, its text, its current statement by one_current_statement
export const LIST_PAGES = 120; // the 200 newest of the heavy company's jobs and the review_item lookups of each
export const MS = 40;
let db: TestDb, owner: string, jobId: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  await su.query("insert into organisation(slug,display_name,kind,status,cro_number) select 'c'||g,'Fake Client '||g,'employer','verified', (700000+g)::text from generate_series(1,100) g");
  await su.query(`insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) select (700000 + g)::text, 'FAKE CRO ' || g, 'fake cro ' || g, 'Normal', current_date from generate_series(1, 50000) g`);
  await su.query(`insert into organisation_name(organisation_id, name, normalised_name, kind, source) select o.id, o.display_name, lower(o.display_name), 'legal', 'dete' from organisation o`);
  await su.query(`insert into organisation_name(name, normalised_name, kind, source) select 'filler ' || md5(g::text), 'filler ' || md5(g::text), 'legal', 'dete' from generate_series(1, 20000) g`);
  const heavy = (await su.query("select id from organisation where slug = 'c1'")).rows[0].id;
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) values ('pu1','Fake','pu1@example.test',true,now())");
  await su.query("insert into membership(organisation_id,portal_user_id,role,status,is_signer) values ($1,'pu1','account_owner','active',true)", [heavy]);
  await su.query("insert into review_item(queue, organisation_id, reason) select 'account_review', id, 'claim' from organisation");
  await su.query(`insert into notification(portal_user_id, category, template_key, params, created_at) values ('pu1', 'account', 'account_needs_info', '{"question":"Which director?"}', now() - interval '400 days')`);
  await su.query(`insert into notification(portal_user_id, category, template_key, params, created_at) select 'pu1', 'jobs', 'job_expiry_reminder', '{}', now() - make_interval(mins => g) from generate_series(1, 3000) g`);
  owner = "pu1";
  await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector)
     select (select min(id) from organisation where slug like 'c%') + (g % 100), 'employer', $1, 'Fake role '||g, 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 30000, 'x'
       from generate_series(1,48000) g`, [src]);
  await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector,posted_at)
     select $2, 'employer', $1, 'Fake heavy role '||g, 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 30000, 'x', now() - make_interval(mins => g)
       from generate_series(1,2000) g`, [src, heavy]);
  await su.query("insert into job_text(job_id, advert_text) select id, 'Fake advert text for the heavy company' from job where organisation_id = $1", [heavy]);
  await su.query("update organisation set status = 'needs_info' where id = $1", [heavy]);
  await su.query("analyze job; analyze job_text; analyze organisation; analyze organisation_name; analyze cro_company; analyze notification; analyze review_item");
  jobId = (await su.query("select id from job where organisation_id = $1 order by id limit 1", [heavy])).rows[0].id;
});
afterAll(() => db.drop());

it("the verification read, the one-job read and the jobs list stay inside their page and time budgets", async () => {
  const c = await db.pool("app_portal").connect();
  try {
    const org = (await c.query("select private.verification_status($1) r", [owner])).rows[0].r;
    expect(org).toMatchObject({ status: "needs_info", croFound: true, deteMatch: true, question: "Which director?" });
    const [v, j, l] = await measurePages(c, [
      { text: "select private.verification_status($1)", values: [owner] },
      { text: ONE_JOB, values: [jobId, (await c.query("select organisation_id from membership where portal_user_id = $1", [owner])).rows[0].organisation_id] },
      { text: "select private.portal_jobs($1)", values: [owner] },
    ]);
    console.log("verification pages", v!.pages, v!.ms, "one job pages", j!.pages, j!.scans, j!.ms, "list pages", l!.pages, l!.ms);
    expect(v!.pages).toBeLessThanOrEqual(VERIFICATION_PAGES);
    expect(j!.pages).toBeLessThanOrEqual(ONE_JOB_PAGES);
    expect(l!.pages).toBeLessThanOrEqual(LIST_PAGES);
    for (const p of [v!, j!, l!]) expect(p.ms).toBeLessThan(MS);
  } finally {
    c.release();
  }
});
