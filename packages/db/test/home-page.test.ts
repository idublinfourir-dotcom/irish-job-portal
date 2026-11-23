// Step 16 P6: the home page's server code on the test database as app_candidate: its reads (apps/candidate/app/_home/load.ts through lib/data.ts), the
// page function and generateMetadata, with the real candidate login. Only Next's request context is stood in (next/headers, server-only); no network. Fake data only.
// Budget (measured 23 November 2026, printed line): one home load for a visitor is BUDGET.statements statements warm and under BUDGET.medianMs ms.
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VISITOR_JOBS } from "../src/public-read";
import { COUNTIES as DB_COUNTIES } from "../src/search";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));

const BUDGET = { statements: 15, medianMs: 30 }; // measured: 15 statements (5 reads x 2 rate counts + their work), median 2.9 ms
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool, AUTH: (r: Request) => Promise<Response>, H: typeof import("../../../apps/candidate/app/_home/load"), P: typeof import("../../../apps/candidate/app/page");
let C: typeof import("../../../apps/candidate/app/_home/counties");

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  H = await import("../../../apps/candidate/app/_home/load");
  P = await import("../../../apps/candidate/app/page");
  C = await import("../../../apps/candidate/app/_home/counties");
  await su.query(`insert into content_page(kind, slug, title, body, status, published_at, source_url, checked_on) values
    ('guide', 'fake-guide', 'Fake guide', 'Guide body', 'published', now(), 'https://enterprise.gov.ie/', '2026-11-01'),
    ('guide', 'draft-guide', 'Draft guide', 'x', 'draft', null, null, null),
    ('update', 'fake-update', 'Fake update', 'Update body', 'published', now(), 'https://enterprise.gov.ie/', '2026-11-02')`);
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-home-org', 'Fake Org', 'employer', 'verified') returning id")).rows[0];
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  const insert = async (sector: string, status: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await su.query(
        `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector)
         values ($1, 'admin_manual', $2, $3, 'Fake Employer', $4, '1122', 'critical_skills', 'critical_skills_eligible', false, $5, now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook'))`,
        [org.id, src, `Fake Cook ${sector} ${i}`, sector, status]);
    }
  };
  await insert("IT", "live", 5);
  await insert("health", "live", 4);
  await insert("care", "draft", 2); // a draft is not counted or shown
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${n}`;
const as = <T>(cookie: string | undefined, fn: () => Promise<T>, ip = freshIp()): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip });
  return fn();
};
async function login() {
  const email = `fake.home${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Home", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const page = async (sector?: string | string[]) => renderToStaticMarkup(await P.default({ searchParams: Promise.resolve({ sector }) }));
const articles = (h: string) => (h.match(/<h3 class="text-xl"><a [^>]*href="\/jobs\//g) ?? []).length; // job cards (not the guide and update cards)

describe("home page reads", () => {
  it("a visitor gets the live jobs capped at 6 with the sign-in flag and count, the sectors with live counts, the minimums, guides and updates", async () => {
    const d = await as(undefined, () => H.loadHome());
    expect(d.jobs.ok && d.jobs.data.jobs.length).toBe(VISITOR_JOBS);
    expect(d.jobs.ok && d.jobs.data.signInForMore).toBe(true);
    expect(d.jobs.ok && d.jobs.data.count?.n).toBe(9);
    expect(d.sectors.ok && d.sectors.data.find((s) => s.sector === "IT")?.jobs).toBe(5);
    expect(d.sectors.ok && d.sectors.data.find((s) => s.sector === "care")?.jobs).toBe(0);
    expect(d.minimums.ok && d.minimums.data.rulesCheckedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.guides.ok && d.guides.data.map((g) => g.slug)).toEqual(["fake-guide"]); // the draft is not served
    expect(d.updates.ok && d.updates.data.map((u) => u.slug)).toEqual(["fake-update"]);
    expect(d.tab).toBeNull();
  });
  it("a sector tab shows only that sector", async () => {
    const d = await as(undefined, () => H.loadHome("health"));
    expect(d.tab).toBe("health");
    expect(d.jobs.ok && d.jobs.data.jobs.every((j) => j.title.includes("health"))).toBe(true);
    expect(d.jobs.ok && d.jobs.data.count?.n).toBe(4);
  });
  it("a signed-in candidate also gets at most 6 on the home page, and no sign-in flag", async () => {
    const cookie = await login();
    const d = await as(cookie, () => H.loadHome());
    expect(d.jobs.ok && d.jobs.data.jobs.length).toBe(6);
    expect(d.jobs.ok && d.jobs.data.signInForMore).toBe(false);
    const forged = cookie.replace(/=[^;]+/g, "=forged"); // a forged session is a visitor
    const f = await as(forged, () => H.loadHome());
    expect(f.jobs.ok && f.jobs.data.signInForMore).toBe(true);
    expect(f.jobs.ok && f.jobs.data.jobs.length).toBe(6);
  });
});

describe("home page, hostile params", () => {
  it.each([["Narnia"], ["x'; drop table job; --"], ["a".repeat(5000)], [["IT", "health"]], ["%00"], [""], ["IT\nhealth"]])("%j gives the page with all jobs", async (v) => {
    const h = await as(undefined, () => page(v as string));
    expect(h).toContain("<h1");
    expect(articles(h)).toBe(6);
    expect(h).not.toMatch(/aria-selected="true"[^>]*href="\/\?sector=/); // the "All" tab is the active one
  });
});

describe("home page output", () => {
  it("renders the page function: one H1, at most 6 job cards, a sign-in box, and no field a visitor must not see", async () => {
    const h = await as(undefined, () => page("IT"));
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(articles(h)).toBe(5); // the five IT jobs
    expect(h).toContain("Fake Cook IT");
    expect(h).not.toContain("Fake Cook health");
    expect(h).not.toContain("Fake Cook care");
    expect(h).not.toMatch(/weeklyHours|searchVector|closeReason|claimsRemoved|own_page_url|example\.test/);
    expect(h).toContain("/guides/fake-guide");
    expect(h).not.toContain("draft-guide");
    const all = await as(undefined, () => page());
    expect(all).toContain("data-sign-in-for-more");
    expect(all).toContain("There are 9 live jobs");
  });
  it("sets its metadata", () => {
    const m = P.generateMetadata();
    expect(m.description!.length).toBeGreaterThanOrEqual(120);
    expect(m.description!.length).toBeLessThanOrEqual(160);
    expect(String(m.title).replace(/ \| .*$/, "").length).toBeLessThanOrEqual(60);
  });
  it("the county list of the search form is the job list's own", () => expect([...C.COUNTIES]).toEqual([...DB_COUNTIES]));
  it("shows a wait notice, not an error page, when the read limit is reached", async () => {
    const ip = freshIp();
    let h = "";
    for (let i = 0; i < 14; i++) h = await as(undefined, () => page(), ip);
    expect(h).toContain("Please try again in");
    expect(h).toContain("<h1");
  });
});

describe("home page performance", () => {
  it("a visitor's load stays inside the statement and time budget", async () => {
    await as(undefined, () => H.loadHome()); // warm
    const ip = freshIp();
    const [, statements] = await counted(() => as(undefined, () => H.loadHome(), ip));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await as(undefined, () => H.loadHome());
      times.push(performance.now() - t);
    }
    const median = times.sort((a, b) => a - b)[2]!;
    console.log(`home page load: ${statements} statements, median ${median.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
