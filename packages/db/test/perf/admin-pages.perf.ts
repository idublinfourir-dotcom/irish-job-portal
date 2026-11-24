// Performance of the three staff pages (P14 overview, P15 account reviews, P16 fetched jobs) with a queue 50 times the frame's: 5,000 waiting account reviews and 5,000
// fetched jobs in review (the frame shows 9 and 34). The pages add no query of their own, so this proves what the reads cost together when a page runs them as a role would:
// the median of 9 warm renders through the real data layer and real sessions. Fake data only.
// Measured 24 November 2026: overview 50 ms, account reviews 13 ms, fetched jobs 24 ms (median of 9). The limits are about 8 times that, with a floor for a busy laptop.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { median, staffHarness } from "../staff-routes-harness";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/" }));
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

// The page modules are .tsx and this package has no jsx setting, so they are loaded by a path built at run time (vite still resolves and transforms them).
const pageModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ `${import.meta.dirname}/../../../../apps/admin/app/${name}`);

export const OVERVIEW_MS = 400;
export const ACCOUNTS_MS = 100;
export const FETCHED_MS = 200;
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>;

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  await h.makeStaff("both", ["account_reviewer", "fetched_job_reviewer", "administrator"]);
  const su = db.pool("postgres");
  await su.query(`insert into organisation(slug, display_name, kind, status, signup_path) select 'perf-o' || g, 'Fake Perf Org ' || g, 'employer', 'pending_review', 'first_time' from generate_series(1, 5000) g`);
  await su.query(`insert into review_item(queue, organisation_id, reason, detail, created_at) select 'account_review', o.id, 'new organisation', '{"found": true, "name_matches": true}', now() - (o.id % 400) * interval '1 hour' from organisation o where o.slug like 'perf-o%'`);
  const src = (await su.query("insert into job_source(kind, board) values ('careers_page', 'perf') returning id")).rows[0].id;
  await su.query(`insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason, quoted_evidence) select $1, 'x' || g, 'https://jobs.example.test/' || g, 'Fake Perf Job ' || g, 'Fake Perf Employer', 'queued',
    (array['7 contract unclear (admin queue)', '5 unsure occupation (admin queue)', '3 unsure Irish employer (admin queue)'])[1 + g % 3], 'reason', 'quoted evidence ' || g from generate_series(1, 5000) g`, [src]);
  const org = (await su.query("select id from organisation order by id limit 1")).rows[0].id;
  await su.query(`insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
    select $1, 'fetched', $2, f.id, f.title, f.employer_name, 'Cork', 'IT', '2134', 'critical_skills', 'in_review', 'infinity', to_tsvector('x'), 'https://jobs.example.test/a' from fetched_advert f where f.job_source_id = $2`, [org, src]);
  await su.query("insert into job_text(job_id, advert_text) select j.id, 'The salary is 60000 a year.' from job j where j.job_source_id = $1", [src]);
  await su.query("analyze");
});
afterAll(async () => {
  const { getPool } = await import("../../src");
  await getPool().end();
  await db.drop();
});

it("the three pages stay inside their clock budgets with 5,000 waiting items in each queue, and still show a page, not the whole queue", async () => {
  const overview = ((await pageModule("page")) as { default: () => Promise<React.ReactElement> }).default;
  const accounts = ((await pageModule("account-reviews/page")) as { default: (a: { searchParams: Promise<object> }) => Promise<React.ReactElement> }).default;
  const fetched = ((await pageModule("fetched-jobs/page")) as { default: typeof accounts }).default;
  state.headers = new Headers({ cookie: h.cookies.both! });
  const run = {
    overview: async () => renderToStaticMarkup(await overview()),
    accounts: async () => renderToStaticMarkup(await accounts({ searchParams: Promise.resolve({}) })),
    fetched: async () => renderToStaticMarkup(await fetched({ searchParams: Promise.resolve({ soc: "2134" }) })),
  };
  for (const f of Object.values(run)) await f();
  const ms = { overview: await median(run.overview), accounts: await median(run.accounts), fetched: await median(run.fetched) };
  console.log(`admin pages perf at 5,000 + 5,000 items: overview ${ms.overview.toFixed(1)} ms, account reviews ${ms.accounts.toFixed(1)} ms, fetched jobs ${ms.fetched.toFixed(1)} ms`);
  expect(ms.overview).toBeLessThan(OVERVIEW_MS);
  expect(ms.accounts).toBeLessThan(ACCOUNTS_MS);
  expect(ms.fetched).toBeLessThan(FETCHED_MS);
  const page = await run.accounts();
  expect((page.match(/aria-current="true"|href="\/account-reviews\?id=/g) ?? []).length).toBeLessThanOrEqual(21); // one page of 20 (and the selected row), never the queue
  expect(page).toMatch(/>5000</); // the waiting tab count reads the whole queue by its index
  const f = await run.fetched();
  expect((f.match(/href="\/fetched-jobs\?id=/g) ?? []).length).toBeLessThanOrEqual(21);
  expect(f).toMatch(/All <span[^>]*>5000</);
}, 600_000);
