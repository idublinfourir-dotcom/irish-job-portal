// G5 (gate 4 of #79, #301): the same number on every page. One database with jobs of every state, where a visitor can see 131 of them, and every place that
// prints or returns a number of live jobs: home, search (no filter, sector, keyword, county), the company and occupation pages (pages rendered as Next calls
// them, through lib/data.ts as app_candidate), the sitemap, the staff figures and the pay-deal list (as app_admin). What is expected is worked out from the
// rows this file made, never from a query of ours. Only Next's request context is stood in; no network. Fake data only.
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PAY_DEAL_COUNTS } from "../src/rules-admin";
import { listJobs, sectorCounts } from "../src/search";
import { sitemapIds, sitemapPart } from "../src/sitemap";
import { SAMPLE_MAKE, TARGET_COUNTS } from "../src/staff-tools";
import { createTestDb, urlFor, type TestDb } from "./db";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

type Element = Parameters<typeof renderToStaticMarkup>[0];
type PageFn = (p: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string>> }) => Promise<Element>;
let db: TestDb, su: pg.Pool, candidate: pg.Pool, admin: pg.Pool;
const pages: Record<string, PageFn> = {};
let occupationPath: (slug: string) => string, occupationSlug: (code: string) => string | null;

type Row = { org: "A" | "B"; sector: string; code: string; status: string; ends: string; n: number; quotaFull?: boolean; county?: string | null };
// `ends`: an SQL time. A visitor sees a job that is live and has not passed its end; nothing else.
const ROWS: Row[] = [
  { org: "A", sector: "IT", code: "2136", status: "live", ends: "now() + interval '20 days'", n: 123, county: "Cork" },
  { org: "B", sector: "health", code: "2231", status: "live", ends: "'infinity'", n: 6, county: "Dublin" },
  { org: "B", sector: "health", code: "2231", status: "live", ends: "now() + interval '1 hour'", n: 1, county: null },
  { org: "A", sector: "finance", code: "2421", status: "live", ends: "now() + interval '5 days'", n: 1, quotaFull: true, county: "Cork" },
  { org: "A", sector: "IT", code: "2136", status: "live", ends: "now() - interval '1 second'", n: 4, county: "Cork" }, // ended, the daily run has not closed it
  { org: "B", sector: "health", code: "2231", status: "live", ends: "now() - interval '20 hours'", n: 3, county: "Dublin" },
  ...["draft", "in_review", "under_review", "hidden", "closed"].map((status): Row => ({ org: "A", sector: "IT", code: "2136", status, ends: "now() + interval '9 days'", n: 2, county: "Cork" })),
];
const visible = ROWS.filter((r) => r.status === "live" && !r.ends.includes("-"));
const total = (f: (r: Row) => boolean = () => true) => visible.filter(f).reduce((n, r) => n + r.n, 0);
const NAME = { A: "Fake Counted Hospital", B: "Fake Other Employer" }, SLUG = { A: "fake-counted", B: "fake-other" };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres"); candidate = db.pool("app_candidate"); admin = db.pool("app_admin");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'counts-board') returning id")).rows[0].id;
  const org: Record<string, string> = {};
  for (const k of ["A", "B"] as const) org[k] = (await su.query("insert into organisation(slug, display_name, kind, status) values ($1, $2, 'employer', 'verified') returning id::text", [SLUG[k], NAME[k]])).rows[0].id;
  const c = await su.connect();
  try {
    await c.query("set session_replication_role = replica"); // the fixture's odd states (a live job past its end) are what time makes, not what a trigger lets in
    for (const r of ROWS)
      await c.query(
        `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, quota_full, status, close_reason, hidden_reason, under_review_reason, closes_at, posted_at, own_page_url, search_vector)
         select $1, 'admin_manual', $2, 'Fake Counted Role ' || g, $3, $4, $5, $6, 'critical_skills', 'critical_skills_eligible', $7, $8, $9, $10, $12, ${r.ends}, now() - g * interval '1 minute', 'https://example.test/a',
                case when $8 in ('live', 'under_review') then to_tsvector('english', 'zebra counted role') end from generate_series(1, $11::int) g`,
        [org[r.org], src, NAME[r.org], r.county ?? null, r.sector, r.code, r.quotaFull ?? false, r.status, r.status === "closed" ? "closed" : null, r.status === "hidden" ? "admin" : null, r.n, r.status === "under_review" ? "pay_check" : null]);
  } finally { c.release(true); }
  // the paths sit in variables so this package (no JSX) does not type-check the pages themselves; the app does
  const files: Record<string, string> = {
    home: "../../../apps/candidate/app/page", search: "../../../apps/candidate/app/jobs/page",
    company: "../../../apps/candidate/app/companies/[slug]/page", occupation: "../../../apps/candidate/app/occupations/[slug]/page",
  };
  for (const [k, f] of Object.entries(files)) pages[k] = (await import(f)).default as PageFn;
  ({ occupationPath } = await import("../../../apps/candidate/lib/paths"));
  ({ occupationSlug } = await import("../../../apps/candidate/lib/occupations"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
beforeEach(() => { state.headers = new Headers({ "x-vercel-forwarded-for": `203.0.113.${(++n % 240) + 10}` }); }); // a new visitor each time, far from the read limit
const open = async (page: string, searchParams: Record<string, string> = {}, slug = "") => renderToStaticMarkup(await pages[page]!({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) }));
const words = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

it("the fixture holds what a visitor may see and as much that they may not", () => {
  expect([total(), total((r) => r.sector === "IT"), total((r) => r.sector === "health"), total((r) => r.org === "A")]).toEqual([131, 123, 7, 124]);
  expect(ROWS.reduce((k, r) => k + r.n, 0) - total()).toBe(17);
});

describe("the numbers behind the pages", () => {
  it("the list, the sector counts and the sitemap agree with the rows, as app_candidate", async () => {
    expect((await listJobs(candidate, { sort: "newest" } as never)).count).toEqual({ n: 131, more: false });
    const sectors = await sectorCounts(candidate);
    expect(Object.fromEntries(sectors.filter((s) => s.jobs > 0).map((s) => [s.sector, s.jobs]))).toEqual({ IT: 123, health: 7, finance: 1 });
    const parts = await Promise.all((await sitemapIds(candidate)).map((id) => sitemapPart(candidate, id)));
    expect(parts.flat().filter((e) => e!.kind === "job")).toHaveLength(131);
  });
  it("staff see the visitors' number, not the jobs that ended and wait for the daily run, as app_admin", async () => {
    expect((await admin.query(TARGET_COUNTS)).rows[0].live_jobs).toBe(131);
    const deals = (await admin.query(PAY_DEAL_COUNTS, [[NAME.A.toLowerCase(), NAME.B.toLowerCase()]])).rows;
    expect(Object.fromEntries(deals.map((d) => [d.entry, Number(d.live_jobs)]))).toEqual({ [NAME.A.toLowerCase()]: 124, [NAME.B.toLowerCase()]: 7 });
  });
  it("the monthly hand check is drawn from the jobs a visitor sees", async () => {
    await admin.query(SAMPLE_MAKE);
    const ids = (await su.query("select detail->'jobIds' as ids from review_item where reason = 'hand_check_100'")).rows[0].ids as string[];
    expect(ids).toHaveLength(100);
    expect((await su.query("select count(*)::int as n from job where id = any($1::bigint[]) and (status <> 'live' or closes_at <= now())", [ids])).rows[0].n).toBe(0);
  });
});

describe("the numbers a visitor reads (#301)", () => {
  it("home: the total and the sector tiles", async () => {
    const t = words(await open("home"));
    expect(t).toContain("There are 130+ live jobs.");
    expect(t).toMatch(/of Irish permits 120\+ live jobs/); // the IT tile
    expect(t).toMatch(/7 live jobs/);
    expect(t).not.toMatch(/\b(131|123|124|148) (live )?jobs?\b/);
    expect(words(await open("home", { sector: "IT" }))).toContain("There are 120+ live jobs.");
  });
  it("search: the heading, the sign-in box and the sector list, for no filter, a sector, a keyword and a county", async () => {
    const want: [Record<string, string>, string, number][] = [[{}, "130+ jobs", 130], [{ sector: "IT" }, "120+ jobs", 120], [{ sector: "health" }, "7 jobs", 7], [{ q: "zebra" }, "130+ jobs", 130], [{ county: "Cork" }, "120+ jobs", 124], [{ occupationCode: "2136" }, "120+ jobs", 123], [{ sector: "care" }, "0 jobs", 0]];
    for (const [q, text] of want) expect(words(await open("search", q)), JSON.stringify(q)).toContain(text);
    const t = words(await open("search"));
    for (const x of ["You can see 6 of 130+.", "IT (120+)", "Health (7)", "Finance (1)", "Care (0)"]) expect(t, x).toContain(x);
    expect(t).not.toMatch(/200\+/);
  });
  it("the company page and the occupation page say what the search they point at says", async () => {
    expect(words(await open("company", {}, SLUG.A))).toContain("120+ live jobs");
    expect(words(await open("company", {}, SLUG.B))).toContain("7 live jobs");
    for (const [code, text] of [["2136", "120+ jobs"], ["2231", "7 jobs"]] as const) {
      const slug = occupationSlug(code)!;
      expect(occupationPath(slug)).toBe(`/occupations/${slug}`);
      expect(words(await open("occupation", {}, slug)), code).toContain(`See ${text}`);
      expect(words(await open("search", { occupationCode: code })), code).toContain(text);
    }
  });
  it("more than 200: the old cap is gone on every page (253 of one company, code and sector read 250+ everywhere)", async () => {
    await su.query("update job set closes_at = now() + interval '20 days' where status = 'live' and closes_at < now()");
    const c = await su.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query("insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, posted_at, own_page_url, search_vector) select organisation_id, source, job_source_id, title || ' more', employer_name, county, sector, occupation_code, permit_type, badge, quota_full, 'live', closes_at, posted_at, own_page_url, search_vector from job where sector = 'IT' and status = 'live' order by id limit 126");
    } finally { c.release(true); }
    expect((await su.query("select count(*)::int as n from job where sector = 'IT' and status = 'live'")).rows[0].n).toBe(253);
    const slug = occupationSlug("2136")!;
    const seen = {
      tile: words(await open("home")), home: words(await open("home", { sector: "IT" })), sector: words(await open("search", { sector: "IT" })),
      code: words(await open("search", { occupationCode: "2136" })), company: words(await open("company", {}, SLUG.A)), occupation: words(await open("occupation", {}, slug)),
    };
    expect(seen.tile).toMatch(/of Irish permits 250\+ live jobs/);
    expect(seen.home).toContain("There are 250+ live jobs.");
    expect(seen.sector).toContain("250+ jobs"); expect(seen.sector).toContain("You can see 6 of 250+."); expect(seen.sector).toContain("IT (250+)");
    expect(seen.code).toContain("250+ jobs"); expect(seen.company).toContain("250+ live jobs"); expect(seen.occupation).toContain("See 250+ jobs");
    for (const [k, t] of Object.entries(seen)) expect(t, k).not.toMatch(/200\+|\b253\b/);
  });
  it("hostile input cannot change a number: a bad filter is refused with no count, a bad slug has no page, and no job row changes", async () => {
    const rows = async () => (await su.query("select status, count(*)::int as n from job group by status order by status")).rows;
    const before = await rows();
    for (const bad of ["'; drop table job; --", "2136' or '1'='1", "../../etc", "x".repeat(400)]) {
      for (const q of [{ sector: bad }, { occupationCode: bad }] as Record<string, string>[]) {
        const t = words(await open("search", q));
        expect(t, JSON.stringify(q)).toContain("We could not use that search");
        expect(t, JSON.stringify(q)).not.toMatch(/\d\+? (live )?jobs|(Health|IT|Finance|Care|Other) \(\d/);
      }
      for (const k of ["occupation", "company"]) await expect(open(k, {}, bad), `${k} ${bad.slice(0, 20)}`).rejects.toMatchObject({ digest: expect.stringMatching(/;404$/) });
    }
    expect(await rows()).toEqual(before);
  });
});
