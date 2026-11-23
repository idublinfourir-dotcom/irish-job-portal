// Small wave 2, agent A: the gate pages call (gatedRead, src/public-read.ts), the new public routes (GET /api/updates, GET /api/checker, and R5 GET /api/legal for the combine) and
// the S13 sitemap read (src/sitemap.ts), end to end on the test database as app_candidate through the real route handlers and the real candidate
// login route. The gate and the route must give the same answer for the same input. Hostile input is tried. Fake data only; no network.
// Budget (measured 19 November 2026, see the printed line): a visitor's updates page is 3 statements (2 rate counts, the feed), a visitor's checker
// answer 2 (2 rate counts; the rules are cached per instance), a candidate's 1 more each (session 2, rate count 1). Raise them only on purpose.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import type { ReportLogin } from "../src/report";

const BUDGET = { updates: 3, checker: 2, medianMs: 15 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Src = typeof import("../src");
let db: TestDb, su: pg.Pool, src: Src, login: (h: Headers) => Promise<ReportLogin>;
let AUTH: Handler, JOBS: Handler, JOB: Handler, COMPANY: Handler, HELP: Handler, UPDATES: Handler, CHECKER: Handler, LEGAL: Handler;
let orgSlug: string, liveId: string;
const status: Record<string, string> = {}; // job id by status, for the sitemap

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: JOBS } = await import("../../../apps/candidate/app/api/jobs/route"));
  ({ GET: JOB } = await import("../../../apps/candidate/app/api/job/route"));
  ({ GET: COMPANY } = await import("../../../apps/candidate/app/api/company/route"));
  ({ GET: HELP } = await import("../../../apps/candidate/app/api/help/route"));
  ({ GET: UPDATES } = await import("../../../apps/candidate/app/api/updates/route"));
  ({ GET: CHECKER } = await import("../../../apps/candidate/app/api/checker/route"));
  ({ GET: LEGAL } = await import("../../../apps/candidate/app/api/legal/route"));
  src = await import("../src");
  ({ signedInCandidate: login } = await import("../../../apps/candidate/lib/candidate"));
  await su.query(`insert into content_page(kind, slug, title, body, status, published_at, source_url, checked_on)
    select 'update', 'upd-' || g, 'Fake update ' || g, 'Fake text', case when g % 5 = 0 then 'withdrawn' else 'published' end, now() - (g || ' hours')::interval, 'https://enterprise.gov.ie/', '2026-11-01'
    from generate_series(1, 30) g;
    insert into content_page(kind, slug, title, body, status, published_at) values ('help', 'not-sure', 'Fake help', 'Fake', 'published', now()), ('update', 'draft-upd', 'Draft', 'Draft', 'draft', null)`);
  const orgs = (await su.query(`insert into organisation(slug, display_name, kind, status) values ('fake-live-org', 'Fake Org', 'employer', 'verified'), ('fake-unclaimed', 'Fake U', 'employer', 'unclaimed'),
    ('fake-rejected', 'Fake R', 'employer', 'rejected'), ('fake-closed', 'Fake C', 'employer', 'closed'), ('fake-merged', 'Fake M', 'employer', 'verified') returning id, slug`)).rows;
  await su.query("update organisation set merged_into_id = $1 where slug = 'fake-merged'", [orgs[0].id]);
  orgSlug = orgs[0].slug;
  const jsrc = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  const add = async (title: string) => (await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector)
     values ($1, 'admin_manual', $2, $3, 'Fake Employer', 'it', '2136', 'critical_skills', 'critical_skills_eligible', false, 'live', now() + interval '20 days', 'https://example.test/a', to_tsvector('english','fake')) returning id::text`,
    [orgs[0].id, jsrc, title])).rows[0].id as string;
  for (let i = 0; i < 8; i++) liveId = await add(`Fake Live ${i}`);
  status.live = liveId;
  for (const s of ["draft", "in_review", "under_review", "hidden", "closed"]) {
    status[s] = await add(`Fake ${s}`);
    await su.query("update job set status = $2, close_reason = case when $2 = 'closed' then 'closed' end, closed_at = case when $2 = 'closed' then now() end, hidden_reason = case when $2 = 'hidden' then 'admin' end where id = $1", [status[s], s]);
  }
  status.expired = await add("Fake expired");
  await su.query("update job set closes_at = now() - interval '1 day' where id = $1", [status.expired]);
});
afterAll(async () => {
  await src.getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${n}`;
async function candidate() {
  const email = `fake.dal${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
type Got = { status: number; body: Record<string, unknown>; retry: string | null };
const headersOf = (o: { cookie?: string; ip?: string }) => new Headers({ ...(o.cookie ? { cookie: o.cookie } : {}), "x-vercel-forwarded-for": o.ip ?? freshIp() });
async function get(route: Handler, path: string, o: { cookie?: string; ip?: string } = {}): Promise<Got> {
  const res = await route(new Request(`${BASE}${path}`, { headers: headersOf(o) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, retry: res.headers.get("retry-after") };
}
/** What a page sees for the same input, as the route would send it. */
async function gate(work: Parameters<Src["gatedRead"]>[3], path: string, o: { cookie?: string; ip?: string } = {}): Promise<Got> {
  const r = await src.gatedRead(headersOf(o), new URL(`${BASE}${path}`).searchParams, login, work);
  // the route sends the same data as JSON, so dates compare as their JSON text
  return r.ok ? { status: 200, body: JSON.parse(JSON.stringify(r.data)) as Record<string, unknown>, retry: null } : { status: r.status, body: { code: r.code }, retry: "retryAfter" in r ? String(r.retryAfter) : null };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const CHECK = "/api/checker?occupationCode=2231&annualPay=70000&relevantDegree=true";

describe("the gate a page calls gives the route's answer", () => {
  it("for the visitor cap, signed-in paging, 404, 400 and 401, on every kind of public read", async () => {
    const cookie = await candidate();
    const first = (await get(JOBS, "/api/jobs?sort=newest", { cookie })).body;
    const cases: [Handler, Parameters<Src["gatedRead"]>[3], string, { cookie?: string }][] = [
      [JOBS, src.jobsRead, "/api/jobs?sort=newest", {}], [JOBS, src.jobsRead, "/api/jobs?sort=newest", { cookie }],
      [JOBS, src.jobsRead, `/api/jobs?sort=newest&after=${first.next ?? "x"}`, { cookie }], [JOBS, src.jobsRead, "/api/jobs?after=x", {}],
      [JOBS, src.jobsRead, "/api/jobs?sort=best", {}], [JOB, src.jobRead, `/api/job?id=${liveId}`, {}], [JOB, src.jobRead, `/api/job?id=${status.hidden}`, {}],
      [COMPANY, src.companyRead, `/api/company?slug=${orgSlug}`, {}], [COMPANY, src.companyRead, "/api/company?slug=fake-rejected", { cookie }],
      [HELP, src.helpRead, "/api/help?slug=not-sure", {}], [UPDATES, src.updatesRead, "/api/updates", {}], [UPDATES, src.updatesRead, "/api/updates?after=junk!", {}],
      [CHECKER, src.checkerRead, CHECK, {}], [CHECKER, src.checkerRead, `${CHECK}&x=1`, { cookie }],
      // R5 legal (privacy_notice has no version in this database: 404; another site's purpose or none: 400)
      [LEGAL, src.legalRead, "/api/legal?purpose=signup_terms", {}], [LEGAL, src.legalRead, "/api/legal?purpose=signup_terms", { cookie }],
      [LEGAL, src.legalRead, "/api/legal?purpose=privacy_notice", {}], [LEGAL, src.legalRead, "/api/legal?purpose=portal_signup_terms", {}],
      [LEGAL, src.legalRead, "/api/legal", { cookie }], [LEGAL, src.legalRead, "/api/legal?purpose=signup_terms'%20or%201=1--", {}],
    ];
    const seen = new Set<number>();
    for (const [route, work, path, o] of cases) {
      const a = await get(route, path, o), b = await gate(work, path, o);
      expect(b, path).toEqual(a);
      seen.add(a.status);
    }
    expect([...seen].sort()).toEqual([200, 400, 401, 404]);
    const v = await gate(src.jobsRead, "/api/jobs");
    expect([(v.body.jobs as unknown[]).length, v.body.signInForMore, v.body.next]).toEqual([6, true, null]); // the cap holds for a page too
  });
  it("for the rate limit, with the same retry", async () => {
    const [a, b] = ["192.0.2.60", "192.0.2.61"];
    for (const ip of [a, b]) {
      await get(JOBS, "/api/jobs", { ip });
      await su.query("update candidate_rate_limit set count = 60 where key = $1", [`read:ip:${ip}:60000`]);
    }
    const r = await get(JOBS, "/api/jobs", { ip: a }), g = await gate(src.jobsRead, "/api/jobs", { ip: b });
    expect([r.status, r.body, g.status, g.body]).toEqual([429, { code: "TOO_MANY_REQUESTS" }, 429, { code: "TOO_MANY_REQUESTS" }]);
    expect(Math.abs(Number(r.retry) - Number(g.retry))).toBeLessThanOrEqual(1);
    expect(Number(g.retry)).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/updates", () => {
  it("pages every published update, newest first, for a visitor and a candidate alike; never a draft or withdrawn one", async () => {
    const cookie = await candidate();
    for (const o of [{}, { cookie }]) {
      const one = await get(UPDATES, "/api/updates", o);
      const p1 = one.body as { updates: { slug: string }[]; next: string };
      expect([one.status, p1.updates.length, typeof p1.next]).toEqual([200, 20, "string"]);
      const p2 = (await get(UPDATES, `/api/updates?after=${p1.next}`, o)).body as { updates: { slug: string }[]; next: string | null };
      const slugs = [...p1.updates, ...p2.updates].map((u) => u.slug);
      expect(slugs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1).filter((g) => g % 5 !== 0).map((g) => `upd-${g}`));
      expect(p2.next).toBeNull();
    }
  });
  it("a bad or forged cursor is 400, never 500; other keys are ignored", async () => {
    const forge = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const c of ["", "junk!", "a".repeat(201), forge({ t: "x", i: "1" }), forge({ t: "2026-11-01 00:00:00+00", i: "1 or 1=1" }), forge({ t: "2026-11-01 00:00:00+00" }), "%00", "e30"])
      expect((await get(UPDATES, `/api/updates?after=${encodeURIComponent(c)}`)).status, c).toBe(400);
    expect((await get(UPDATES, "/api/updates?limit=1000&kind=draft")).body.updates).toHaveLength(20);
  });
});

describe("GET /api/checker", () => {
  type Answer = { qualifies: boolean; reason: string; registration: { status: string; body: { id: string } } | null };
  const ans = (g: Got) => g.body as unknown as Answer;
  it("answers from the rules in force, with the registration the code and title need, the same for every session", async () => {
    const cookie = await candidate();
    for (const o of [{}, { cookie }, { cookie: "portal.session_token=forged" }, { cookie: "staff.session_token=forged" }]) {
      const g = await get(CHECKER, CHECK, o);
      expect([g.status, ans(g).qualifies, ans(g).reason, ans(g).registration?.status, ans(g).registration?.body.id], JSON.stringify(o)).toEqual([200, true, "listed_degree", "required", "nmbi"]);
    }
    const cases: [string, boolean, string, string | null][] = [
      ["occupationCode=0000&annualPay=90000&relevantDegree=true", false, "unknown_code", null],
      ["occupationCode=2136&annualPay=10000&relevantDegree=true", false, "below_minimum", null],
      ["occupationCode=2136&annualPay=70000&relevantDegree=true&contractMonths=6", false, "contract_too_short", null],
      ["occupationCode=2217&annualPay=70000&relevantDegree=true", true, "listed_degree", "may_need"],
      ["occupationCode=2217&annualPay=70000&relevantDegree=true&title=Senior%20Radiographer", true, "listed_degree", "required"],
      ["occupationCode=2217&annualPay=70000&relevantDegree=true&title=x'%3B%20drop%20table%20job%3B%20--", true, "listed_degree", "may_need"],
    ];
    for (const [query, qualifies, reason, reg] of cases) {
      const g = await get(CHECKER, `/api/checker?${query}`);
      expect([g.status, ans(g).qualifies, ans(g).reason, ans(g).registration?.status ?? null], query).toEqual([200, qualifies, reason, reg]);
    }
  });
  it("hostile input is 400, never 500, and nothing is stored", async () => {
    const before = (await su.query("select (select count(*) from content_page) + (select count(*) from job) as n")).rows[0].n;
    for (const q of ["", "occupationCode=2231", `${CHECK.split("?")[1]}&occupationCode=2136`, `${CHECK.split("?")[1]}&constructor=1`, "occupationCode=2231&annualPay=Infinity&relevantDegree=true",
      "occupationCode=2231&annualPay=70000&relevantDegree=1", `${CHECK.split("?")[1]}&weeklyHours=0`, `${CHECK.split("?")[1]}&weeklyHours=61`, `${CHECK.split("?")[1]}&title=${"x".repeat(5000)}`,
      `${CHECK.split("?")[1]}&title=%1B%5B31m`, `${CHECK.split("?")[1]}&degreeAwardMonth=2026-1`, "occupationCode[]=2231&annualPay=1&relevantDegree=true"]) {
      const g = await get(CHECKER, `/api/checker?${q}`);
      expect([g.status, g.body], q.slice(0, 60)).toEqual([400, { code: "BAD_REQUEST" }]);
    }
    expect((await su.query("select (select count(*) from content_page) + (select count(*) from job) as n")).rows[0].n).toBe(before);
  });
});

describe("the new routes against the rate limit, the spec and the budget", () => {
  it("both answer 429 with Retry-After once the address is over its minute", async () => {
    const ip = "192.0.2.70";
    await get(UPDATES, "/api/updates", { ip });
    await su.query("update candidate_rate_limit set count = 60 where key = $1", [`read:ip:${ip}:60000`]);
    for (const [route, path] of [[UPDATES, "/api/updates"], [CHECKER, CHECK]] as const) {
      const g = await get(route, path, { ip });
      expect([g.status, g.body], path).toEqual([429, { code: "TOO_MANY_REQUESTS" }]);
      expect(Number(g.retry)).toBeGreaterThanOrEqual(1);
    }
  });
  it("the replies match docs/openapi/candidate.yaml", async () => {
    const spec = loadSpec("candidate");
    const next = (await get(UPDATES, "/api/updates")).body.next;
    for (const [route, doc, path] of [
      [UPDATES, "/api/updates", "/api/updates"], [UPDATES, "/api/updates", `/api/updates?after=${next}`], [UPDATES, "/api/updates", "/api/updates?after=junk!"],
      [CHECKER, "/api/checker", CHECK], [CHECKER, "/api/checker", "/api/checker?occupationCode=2217&annualPay=70000&relevantDegree=false&weeklyHours=20&contractMonths=36"],
      [CHECKER, "/api/checker", "/api/checker?occupationCode=x"],
    ] as const) {
      const g = await get(route, path);
      expect(replyProblems(spec, "GET", doc, g.status, g.body), `${g.status} ${path}`).toEqual([]);
    }
  });
  it("statement budget and a visitor's median time", async () => {
    await get(CHECKER, CHECK); // the rules are loaded once per instance
    const [, updates] = await counted(() => get(UPDATES, "/api/updates"));
    const [, checker] = await counted(() => get(CHECKER, CHECK));
    const times: number[] = [];
    for (let i = 0; i < 21; i++) { const t = performance.now(); await get(i % 2 ? UPDATES : CHECKER, i % 2 ? "/api/updates" : CHECK); times.push(performance.now() - t); }
    const median = times.sort((a, b) => a - b)[10]!;
    console.log(`dal reads: updates ${updates} statements, checker ${checker} statements, median ${median.toFixed(2)} ms`);
    expect([updates, checker]).toEqual([BUDGET.updates, BUDGET.checker]);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});

describe("the sitemap read (S13)", () => {
  it("lists every live job and no job of any other status, nor an expired one", async () => {
    const pool = src.getPool();
    expect(await src.sitemapIds(pool)).toEqual(["jobs-0", "companies-0", "occupations-0"]);
    const jobs = (await src.sitemapPart(pool, "jobs-0"))!;
    const live = (await su.query("select id::text from job where status = 'live' and closes_at > now() order by id")).rows.map((r) => r.id);
    expect(jobs.map((j) => j.key)).toEqual(live);
    expect(live).toHaveLength(8);
    for (const s of ["draft", "in_review", "under_review", "hidden", "closed", "expired"]) expect(jobs.map((j) => j.key), s).not.toContain(status[s]);
    expect(jobs.every((j) => j.kind === "job" && !Number.isNaN(Date.parse(j.lastModified!)))).toBe(true);
    // #288: the address is made from the title and county as well as the id
    const named = (await su.query("select id::text, title, county from job where status = 'live' and closes_at > now() order by id")).rows;
    expect(jobs.map((j) => [j.key, j.title, j.county])).toEqual(named.map((r) => [r.id, r.title, r.county]));
  });
  it("lists the companies with a page (not rejected, closed or merged) and the occupations on the lists", async () => {
    const pool = src.getPool();
    expect((await src.sitemapPart(pool, "companies-0"))!.map((c) => c.key).sort()).toEqual(["fake-live-org", "fake-unclaimed"]);
    for (const slug of ["fake-live-org", "fake-unclaimed"]) expect((await get(COMPANY, `/api/company?slug=${slug}`)).status).toBe(200);
    for (const slug of ["fake-rejected", "fake-closed"]) expect((await get(COMPANY, `/api/company?slug=${slug}`)).status).toBe(404);
    const codes = (await src.sitemapPart(pool, "occupations-0"))!.map((o) => o.key);
    expect(codes.length).toBeGreaterThan(100);
    expect(codes).toEqual([...new Set((await src.getRules(pool)).occupationLists.map((e) => e.code))].sort());
    expect(await src.sitemapPart(pool, "jobs-1")).toEqual([]);
    expect(await src.sitemapPart(pool, "nope-0")).toBeNull();
  });
  it("costs 1 statement for the ids (the rules are cached) and 1 for a part", async () => {
    const pool = src.getPool();
    await src.sitemapIds(pool);
    const [, ids] = await counted(() => src.sitemapIds(pool));
    const [, part] = await counted(() => src.sitemapPart(pool, "jobs-0"));
    expect([ids, part]).toEqual([1, 1]);
  });
});
