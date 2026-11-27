// Performance (B25): the pages read by the companies directory's one statement (src/companies-directory.ts) as app_candidate, on 5,000 companies
// (the top-500 sponsor grouping and growth past it), 10,000 names, 30,000 DETE rows and 10,000 live jobs: the first page, a page deep in the list,
// and a search. Counted with EXPLAIN (ANALYZE, BUFFERS) inside a rolled-back transaction, warm pass then measured pass. Fake data only.
import type { ClientBase } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { costOf } from "./pages";
import { DIRECTORY_PAGE, DIRECTORY_QUERY, listCompanies } from "../../src/companies-directory";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Budgets: about 1.5 times the pages measured on 27 Nov 2026 (printed below); raise them only on purpose.
export const FIRST_PAGES = 750; // measured 497 (a seq scan of organisation: ponytail, an index on (display_name, id) when the list nears 50,000)
export const DEEP_PAGES = 750; // measured 497
export const SEARCH_PAGES = 950; // measured 620
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  await su.query("insert into organisation(slug, display_name, kind, status, county) select 'o'||g, 'Fake Org '||md5(g::text), 'employer', 'verified', 'Cork' from generate_series(1, 5000) g");
  await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) select o.id, k||o.display_name, lower(k||o.display_name), case k when '' then 'legal' else 'alias' end, 'admin' from organisation o, unnest(array['', 'trading ']) k");
  await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits) select 'D'||n.id||'-'||y, n.id, y, null, 3 from organisation_name n, generate_series(2017, 2019) y");
  await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector)
    select (select min(id) from organisation) + g % 5000, 'employer', $1, 'Fake role '||g, 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 30000 + g, 'x' from generate_series(1, 10000) g`, [src]);
  await su.query("update organisation set status = 'rejected' where id % 50 = 0");
  await su.query("analyze");
});
afterAll(() => db.drop());

async function pagesOf(c: ClientBase, values: unknown[]) {
  const plans: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    await c.query("begin");
    plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${DIRECTORY_QUERY}`, values)).rows[0]["QUERY PLAN"]);
    await c.query("rollback");
  }
  return costOf(DIRECTORY_QUERY, plans[1]);
}

it("the first page, a page deep in the list and a search stay inside their page budgets", async () => {
  const pool = db.pool("app_candidate"), c = await pool.connect();
  try {
    let after: string | undefined;
    for (let i = 0; i < 100; i++) after = (await listCompanies(pool, { after })).next ?? undefined; // page 101 of about 245
    const [name, id] = JSON.parse(Buffer.from(after!, "base64url").toString()) as [string, string];
    const first = await pagesOf(c, [null, null, null, DIRECTORY_PAGE + 1]);
    const deep = await pagesOf(c, [null, name, id, DIRECTORY_PAGE + 1]);
    const search = await pagesOf(c, ["fake org a1", null, null, DIRECTORY_PAGE + 1]);
    console.log(`B25 directory pages: first ${first.pages} (${first.scans}), deep ${deep.pages}, search ${search.pages} (${search.scans})`);
    expect(first.pages).toBeLessThanOrEqual(FIRST_PAGES);
    expect(deep.pages).toBeLessThanOrEqual(DEEP_PAGES);
    expect(search.pages).toBeLessThanOrEqual(SEARCH_PAGES);
    expect((await listCompanies(pool, { q: "fake org a1" })).companies.length).toBeGreaterThan(0);
  } finally {
    c.release();
  }
});
