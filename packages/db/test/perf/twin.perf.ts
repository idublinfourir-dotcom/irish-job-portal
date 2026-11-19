// Performance: the twin lookups of migration 0057 (the fetched twin of an employer's own job) on 50,000 jobs: 45,000 live fetched jobs of 500
// companies and 5,000 live employer jobs. The two statements are the ones the triggers run (job_twin_fetched: is there a live employer twin;
// job_twin_owner: the live fetched twins to hide), with one company's values. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 19 Nov 2026: 8 and 7 pages (0.02 ms each) by job_twin_idx. The budget leaves room for a busier company.
export const TWIN_LOOKUP_PAGES = 50;
const T = (c: string) => `trim(regexp_replace(lower(${c}), '[^a-z0-9]+', ' ', 'g'))`;
const EMPLOYER_TWIN =
  `select 1 from job e where e.organisation_id = $1 and e.status = 'live' and e.source in ('employer','admin_manual') and ${T("e.title")} = ${T("$2::text")} ` +
  "and (e.county is null or $3::text is null or e.county = $3::text) limit 1";
const FETCHED_TWINS =
  `select f.id from job f where f.organisation_id = $1 and f.source = 'fetched' and f.status = 'live' and ${T("f.title")} = ${T("$2::text")} ` +
  "and (f.county is null or $3::text is null or f.county = $3::text)";
let db: TestDb;
let org: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into organisation(slug, display_name, kind, status) select 'twin-perf-' || g, 'Twin Perf ' || g, 'employer', 'verified' from generate_series(1, 500) g");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  // the employer jobs first, then the fetched ones with other titles (no twins), so the fill does not hide anything
  await su.query(
    "insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url) " +
      "select o.id, 'employer', $1, 'Employer Role ' || g, o.display_name, 'Dublin', 'IT', 'critical_skills', 60000, 'live', now() + interval '29 days', to_tsvector('english', 'x'), 'https://example.test/a' " +
      "from organisation o, generate_series(1, 10) g where o.slug like 'twin-perf-%'", [src]);
  await su.query("insert into job_source(kind, board) values ('board', 'twin-perf')");
  await su.query("insert into fetched_advert(job_source_id, external_id, result) select (select id from job_source where board = 'twin-perf'), 'tp:' || g, 'passed' from generate_series(1, 45000) g");
  // the fetched fill skips the triggers (fake rows, not what is measured; a 45,000-row insert through them took minutes)
  await su.query(
    "set session_replication_role = replica; insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, permit_type, badge, status, closes_at, search_vector, own_page_url) " +
      "select (select id from organisation where slug = 'twin-perf-' || (1 + f.id % 500)), 'fetched', f.job_source_id, f.id, 'Fetched Role ' || (f.id % 90), 'x', 'Dublin', 'IT', 'critical_skills', " +
      "'critical_skills_eligible', 'live', 'infinity', to_tsvector('english', 'x'), 'https://jobs.example.test/' || f.id from fetched_advert f where f.external_id like 'tp:%'; set session_replication_role = default");
  await su.query("analyze organisation, job");
  org = (await su.query("select id::text from organisation where slug = 'twin-perf-7'")).rows[0].id;
});
afterAll(() => db.drop());

it("both twin lookups use job_twin_idx and stay within their page budget", async () => {
  const c = await db.pool("postgres").connect();
  try {
    expect(Number((await c.query("select count(*) from job")).rows[0].count)).toBeGreaterThanOrEqual(50_000);
    const costs = await measurePages(c, [
      { text: EMPLOYER_TWIN, values: [org, "Employer Role 3", "Dublin"] },
      { text: FETCHED_TWINS, values: [org, "Fetched Role 3", "Dublin"] },
    ]);
    console.log("twin lookups", costs.map((x) => [x.pages, x.scans, x.ms]));
    for (const x of costs) {
      expect(x.scans).toContain("job_twin_idx");
      assertPageBudget("twin lookup", [x], TWIN_LOOKUP_PAGES);
    }
  } finally {
    c.release();
  }
});
