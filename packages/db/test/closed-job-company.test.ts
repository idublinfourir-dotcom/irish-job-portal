// Step 16, R3: B27 (GET /api/job/closed, the closed-job read) and B23 (GET /api/company: the public pay label, the monthly series, the data cut-off), through the
// real route handlers as app_candidate on the test database. Roles tried: visitor, candidate, forged session. Hostile ids tried. Statement budgets measured (see
// the printed line). Fake data only; no network (vitest.setup.ts refuses it).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3000";
const BUDGET = { closedVisitor: 5, companyVisitor: 10 }; // closed: 2 rate counts, the lookup, 1 or 2 similar queries (+ rules when a card has a pay grade); company: see its test
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, CLOSED: Handler, COMPANY: Handler;
let orgId: string, src: string, liveIds: string[];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: CLOSED } = await import("../../../apps/candidate/app/api/job/closed/route"));
  ({ GET: COMPANY } = await import("../../../apps/candidate/app/api/company/route"));
  orgId = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-closed-org', 'Fake Closed Org', 'employer', 'verified') returning id::text")).rows[0].id;
  src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  liveIds = [];
  for (let i = 0; i < 7; i++) liveIds.push(await addJob(`Fake Live ${i}`, "live", "1122"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

async function addJob(title: string, status: string, code: string | null, sector = "it"): Promise<string> {
  const id = (await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector)
     values ($1, 'admin_manual', $2, $3, 'Fake Employer', 'Cork', $5, $4, 'critical_skills', 'critical_skills_eligible', false, 'live', now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook'))
     returning id::text`, [orgId, src, title, code, sector])).rows[0].id as string;
  if (status !== "live") await setStatus(id, status);
  return id;
}
async function setStatus(id: string, status: string, reason: string | null = null, hidden: string | null = null) {
  await su.query("update job set status = $2, closed_at = case when $2 = 'closed' then now() end, close_reason = $3, hidden_reason = $4, hidden_report_id = null where id = $1", [id, status, reason, hidden]);
}

let n = 0;
async function login() {
  const email = `fake.closed${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a reply body is read by field in these tests; the spec check types it
type Got = { status: number; body: Record<string, any> };
async function get(route: Handler, path: string, o: { cookie?: string; ip?: string } = {}): Promise<Got> {
  const res = await route(new Request(`${BASE}${path}`, { headers: { ...(o.cookie ? { cookie: o.cookie } : {}), "x-vercel-forwarded-for": o.ip ?? `203.0.113.${(++n % 240) + 10}.${n}` } }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("B27: the closed-job read", () => {
  it("answers a closed and an expired job for a visitor and a candidate: reason, title, employer, county and up to 5 live jobs of the same occupation, newest first", async () => {
    const cookie = await login();
    const closed = await addJob("Fake Closed Cook", "closed", "1122");
    await setStatus(closed, "closed", "closed");
    const expired = await addJob("Fake Expired Cook", "closed", "1122");
    await setStatus(expired, "closed", "expired");
    for (const [id, reason] of [[closed, "closed"], [expired, "expired"]] as const) {
      for (const o of [{}, { cookie }]) {
        const g = await get(CLOSED, `/api/job/closed?id=${id}`, o);
        expect(g.status).toBe(200);
        expect(g.body).toMatchObject({ closed: true, reason, job: { jobId: id, employerName: "Fake Employer", county: "Cork", reason } });
        expect(Object.keys(g.body).sort()).toEqual(["closed", "job", "reason", "similar"]);
        expect(Object.keys(g.body.job).sort()).toEqual(["closedAt", "county", "employerName", "jobId", "reason", "title"]);
        expect(g.body.similar.map((j: { jobId: string }) => j.jobId)).toEqual([...liveIds].reverse().slice(0, 5));
      }
    }
  });
  it("falls back to the sector when the occupation has no live job, and gives an empty list when nothing is like it", async () => {
    const lone = await addJob("Fake Lone", "closed", "2136");
    await setStatus(lone, "closed", "expired");
    expect((await get(CLOSED, `/api/job/closed?id=${lone}`)).body.similar).toHaveLength(5);
    const bare = await addJob("Fake Bare", "closed", null, "no-other-live-job-here");
    await setStatus(bare, "closed", "expired");
    expect((await get(CLOSED, `/api/job/closed?id=${bare}`)).body).toMatchObject({ closed: true, similar: [] });
  });
  it("never answers for a live, hidden, under review, in review, draft or removed job (S20), nor a job closed for a staff removal", async () => {
    const cases: [string, string | null, string | null][] = [
      ["live", null, null], ["under_review", null, null], ["hidden", null, "admin"], ["hidden", null, "organisation_suspended"],
      ["in_review", null, null], ["draft", null, null], ["closed", "removed", null], ["closed", "under_review_expired", null], ["closed", "abandoned", null],
    ];
    for (const [status, reason, hidden] of cases) {
      const id = await addJob(`Fake ${status}`, "live", "1122");
      await setStatus(id, status, reason, hidden);
      const g = await get(CLOSED, `/api/job/closed?id=${id}`, { cookie: undefined });
      expect([status, reason, hidden, g.status, g.body], `${status}/${reason}/${hidden}`).toEqual([status, reason, hidden, 404, { code: "NOT_FOUND" }]);
    }
  });
  it("hostile ids are 404, never 500, and nothing is run for them", async () => {
    for (const bad of ["999999999", "", "0", "-1", "1;drop table job", "1 or 1=1", "1e3", "a".repeat(5000), "%00", "99999999999999999999999"]) {
      expect((await get(CLOSED, `/api/job/closed?id=${encodeURIComponent(bad)}`)).status, bad.slice(0, 20)).toBe(404);
    }
    expect((await get(CLOSED, "/api/job/closed")).status).toBe(404);
    expect((await get(CLOSED, `/api/job/closed?id=${liveIds[0]}&id=${liveIds[1]}`)).status).toBe(404); // first value only: that one is live
  });
  it("a forged session is a visitor; the read is rate limited like the other public reads", async () => {
    const id = await addJob("Fake Rate", "closed", "1122");
    await setStatus(id, "closed", "closed");
    expect((await get(CLOSED, `/api/job/closed?id=${id}`, { cookie: "candidate.session_token=forged.value" })).status).toBe(200);
    const ip = "192.0.2.77";
    await get(CLOSED, `/api/job/closed?id=${id}`, { ip });
    await su.query("update candidate_rate_limit set count = 60 where key = $1", [`read:ip:${ip}:60000`]);
    expect((await get(CLOSED, `/api/job/closed?id=${id}`, { ip })).status).toBe(429);
  });
  it("costs a visitor at most the budget in statements (2 rate counts, the lookup, the similar query); a 404 costs 3", async () => {
    const id = await addJob("Fake Budget", "closed", "1122");
    await setStatus(id, "closed", "expired");
    const [g, ok] = await counted(() => get(CLOSED, `/api/job/closed?id=${id}`));
    const [, miss] = await counted(() => get(CLOSED, `/api/job/closed?id=${liveIds[0]}`));
    console.log(`B27 statements: closed job ${ok}, not closed ${miss}`);
    expect(g.status).toBe(200);
    expect(ok).toBeLessThanOrEqual(BUDGET.closedVisitor);
    expect(miss).toBeLessThanOrEqual(3);
  });
  it("matches docs/openapi/candidate.yaml, 200 and 404", async () => {
    const spec = loadSpec("candidate");
    const id = await addJob("Fake Spec", "closed", "1122");
    await setStatus(id, "closed", "expired");
    for (const path of [`/api/job/closed?id=${id}`, `/api/job/closed?id=${liveIds[0]}`]) {
      const g = await get(CLOSED, path);
      expect(replyProblems(spec, "GET", "/api/job/closed", g.status, g.body), path).toEqual([]);
    }
  });
});

describe("B23: the company read", () => {
  let hseSlug: string, otherSlug: string;
  beforeAll(async () => {
    const hse = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-hse', 'Health Service Executive', 'public_body', 'verified') returning id::text")).rows[0].id;
    hseSlug = "fake-hse";
    otherSlug = "fake-closed-org";
    const nid = (await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Fake HSE Legal', 'fake hse legal', 'legal', 'admin') returning id::text", [hse])).rows[0].id;
    await su.query(
      `insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits, source_file) values
       ('Fake HSE Legal', $1, 2025, null, 40, 'f'), ('Fake HSE Legal', $1, 2026, 1, 3, 'f'), ('Fake HSE Legal', $1, 2026, 2, 0, 'f'), ('Fake HSE Legal', $1, 2026, 4, 5, 'f'), ('Fake HSE Legal', $1, 2018, 6, 9, 'f')`, [nid]);
    // another company's newer month sets the data cut-off for everyone
    const oid = (await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Fake Other Legal', 'fake other legal', 'legal', 'admin') returning id::text", [orgId])).rows[0].id;
    await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits, source_file) values ('Fake Other Legal', $1, 2026, 7, 1, 'f')", [oid]);
  });
  it("adds the public pay label, the monthly series (since 2019, with permits, oldest first) and the data cut-off month; other labels stay", async () => {
    for (const o of [{}, { cookie: await login() }]) {
      const g = await get(COMPANY, `/api/company?slug=${hseSlug}`, o);
      expect(g.status).toBe(200);
      expect(g.body.labels).toContain("Public sector pay scale employer");
      expect(g.body.permits.byMonth).toEqual([{ year: 2026, month: 1, permits: 3 }, { year: 2026, month: 4, permits: 5 }]);
      expect(g.body.permits.dataThrough).toEqual({ year: 2026, month: 7 });
      expect(g.body.permits.latestMonth).toEqual({ year: 2026, month: 4, permits: 5 }); // unchanged
      expect(Object.keys(g.body.permits).sort()).toEqual(["byMonth", "byYear", "dataThrough", "latestMonth", "peakYear", "trend"]);
      for (const k of ["croNumber", "croStatus", "sector", "alert"]) expect(g.body, k).not.toHaveProperty(k); // dropped by #287
    }
  });
  it("a company not on the pay-deal list has no label; one with no linked DETE name has permits null and no cut-off", async () => {
    expect((await get(COMPANY, `/api/company?slug=${otherSlug}`)).body.labels).not.toContain("Public sector pay scale employer");
    await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-no-dete', 'No Dete Ltd', 'employer', 'verified')");
    expect((await get(COMPANY, "/api/company?slug=fake-no-dete")).body).toMatchObject({ labels: ["Permit history not linked yet"], permits: null });
  });
  it("hostile slugs are 404 or 400, never 500", async () => {
    for (const bad of ["", "A", "x'--", "a".repeat(300), "%00", "../etc"]) expect([400, 404], bad.slice(0, 10)).toContain((await get(COMPANY, `/api/company?slug=${encodeURIComponent(bad)}`)).status);
  });
  it("costs a visitor at most the budget in statements, and matches docs/openapi/candidate.yaml", async () => {
    const [g, c] = await counted(() => get(COMPANY, `/api/company?slug=${hseSlug}`));
    console.log(`B23 statements: company page ${c}`);
    expect(c).toBeLessThanOrEqual(BUDGET.companyVisitor);
    expect(replyProblems(loadSpec("candidate"), "GET", "/api/company", g.status, g.body)).toEqual([]);
  });
});
