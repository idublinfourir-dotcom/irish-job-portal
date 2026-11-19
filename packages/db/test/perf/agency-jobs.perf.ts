// Performance (P11): the "Jobs posted for you by agencies" list query and the "I don't recognise this" function, on 50,000 jobs of which 2,000
// are agency jobs naming 100 client companies, one heavy client named by 1,000 of them under two names. Pages are counted with EXPLAIN (ANALYZE,
// BUFFERS), warm pass then measured pass; the function runs in a transaction that is rolled back. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AGENCY_JOBS } from "../../../../apps/portal/lib/agency-jobs";
import { createTestDb, type TestDb } from "../db";
import { measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 19 Nov 2026: the list 30 pages (both pages) and 0.1 to 0.3 ms; the press 22 pages and 0.6 ms. Budgets 3 times the pages, the time a floor for a busy laptop.
// Before the per-name lateral the same list read 3,059 pages (all 1,000 jobs of the heavy client, then a sort).
export const LIST_PAGES = 90; // at most 21 rows per name through job_client_name_idx, the two names of the heavy client
export const PRESS_PAGES = 70; // the locked job, the report insert with its alert, the hide and the two notices
export const LIST_MS = 20;
let db: TestDb, heavy: string, owner: string, jobId: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  await su.query("insert into organisation(slug,display_name,kind,status) select 'c'||g,'Fake Client '||g,'employer','verified' from generate_series(1,100) g");
  await su.query("insert into organisation(slug,display_name,kind,status,wrc_licence_number) select 'a'||g,'Fake Agency '||g,'agency','verified','EA'||g from generate_series(1,10) g");
  await su.query("insert into organisation_name(organisation_id,name,normalised_name,kind,source) select id, display_name, lower(display_name), 'legal', 'admin' from organisation where slug like 'c%'");
  heavy = (await su.query("select id from organisation where slug = 'c1'")).rows[0].id;
  await su.query("insert into organisation_name(organisation_id,name,normalised_name,kind,source) values ($1,'Fake Client One Trading','fake client one trading','alias','admin')", [heavy]);
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) values ('pu1','Fake','pu1@example.test',true,now()), ('pa1','Fake','pa1@example.test',true,now())");
  await su.query("insert into membership(organisation_id,portal_user_id,role,status) values ($1,'pu1','account_owner','active')", [heavy]);
  await su.query("insert into membership(organisation_id,portal_user_id,role,status) select id,'pa1','account_owner','active' from organisation where slug = 'a1'");
  owner = "pu1";
  await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector)
     select (select min(id) from organisation where slug like 'c%') + (g % 100), 'employer', $1, 'Fake role '||g, 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 30000, 'x'
       from generate_series(1,48000) g`, [src]);
  // 2,000 agency jobs: 1,000 for the heavy client (half under each name), 1,000 across the other clients; a fifth under review
  await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector,permit_employer_kind,permit_employer_name,posted_at)
     select (select min(id) from organisation where slug like 'a%') + (g % 10), 'agency', $1, 'Fake agency role '||g, 'Fake Agency', 'IT', 'critical_skills',
       case when g % 5 = 0 then 'under_review' else 'live' end, now() + interval '20 days', 'https://example.test', 30000, 'x', 'client',
       case when g <= 500 then 'Fake Client 1' when g <= 1000 then 'Fake Client One Trading' else 'Fake Client ' || (2 + g % 99) end, now() - make_interval(mins => g)
       from generate_series(1,2000) g`, [src]);
  await su.query("analyze job; analyze organisation_name; analyze report");
  jobId = (await su.query("select id from job where permit_employer_name = 'Fake Client 1' and status = 'live' limit 1")).rows[0].id;
});
afterAll(() => db.drop());

it("the list query and the press stay inside their page and time budgets", async () => {
  const c = await db.pool("app_portal").connect();
  try {
    const first = await c.query(AGENCY_JOBS, [heavy, null, null]);
    expect(first.rows.length).toBe(21);
    const last = first.rows[19];
    const [p1, p2] = await measurePages(c, [{ text: AGENCY_JOBS, values: [heavy, null, null] }, { text: AGENCY_JOBS, values: [heavy, last.posted_text, last.id] }]);
    console.log("list pages", p1!.pages, p1!.scans, p1!.ms, "page 2", p2!.pages, p2!.ms);
    for (const p of [p1!, p2!]) {
      expect(p.pages).toBeLessThanOrEqual(LIST_PAGES);
      expect(p.scans).toContain("job_client_name_idx");
      expect(p.ms).toBeLessThan(LIST_MS);
    }
    await c.query("begin");
    const [press] = await measurePages(c, [{ text: "select private.client_not_recognised($1, $2)", values: [owner, jobId] }]);
    await c.query("rollback");
    console.log("press pages", press!.pages, press!.ms);
    expect(press!.pages).toBeLessThanOrEqual(PRESS_PAGES);
  } finally {
    c.release();
  }
});
