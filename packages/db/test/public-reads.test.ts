// S3 and S5 (#46): the candidate site's public reads (GET /api/jobs, /api/job, /api/company, /api/occupation, src/public-read.ts) end to end on the
// test database as app_candidate, through the real route handlers and the real candidate login route. A visitor gets 6 jobs of any list and no
// cursor; a candidate pages as before; every read is rate limited per address (visitor) or per login (candidate). Hostile sessions, cursors, page
// sizes and address headers are tried. Fake data only; no network (vitest.setup.ts refuses it).
// Budget (measured 18 November 2026, see the printed line): a visitor's list is 3 statements (2 rate counts, the list), a candidate's is 4 (session 2,
// rate count 1, the list). Statements and the median time of a visitor's list are budgeted; raise them only on purpose.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

const BUDGET = { visitor: 3, candidate: 4, medianMs: 15 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, JOBS: Handler, JOB: Handler, COMPANY: Handler, OCCUPATION: Handler;
let slug: string, jobIds: string[];
const TOTAL = 27; // more than a candidate's page (20), so both page

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: JOBS } = await import("../../../apps/candidate/app/api/jobs/route"));
  ({ GET: JOB } = await import("../../../apps/candidate/app/api/job/route"));
  ({ GET: COMPANY } = await import("../../../apps/candidate/app/api/company/route"));
  ({ GET: OCCUPATION } = await import("../../../apps/candidate/app/api/occupation/route"));
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-visitor-org', 'Fake Org', 'employer', 'verified') returning id, slug")).rows[0];
  slug = org.slug;
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  jobIds = [];
  for (let i = 0; i < TOTAL; i++) {
    const r = (await su.query(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector)
       values ($1, 'admin_manual', $2, $3, 'Fake Employer', 'it', '1122', 'critical_skills', 'critical_skills_eligible', false, 'live', now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook')) returning id::text`,
      [org.id, src, `Fake Cook ${i}`])).rows[0].id as string;
    await su.query("update job set posted_at = timestamptz '2026-10-01 10:00:00+00' + $2::int * interval '1 second' where id = $1", [r, i]);
    jobIds.push(r);
  }
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${n}`; // one address per call unless a test fixes one
async function login(o: { suspended?: boolean } = {}) {
  const email = `fake.reader${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  if (o.suspended) await su.query("update candidate_user set suspended_at=now() where id=$1", [id]);
  return { cookie, id };
}
type Got = { status: number; body: Record<string, unknown>; retry: string | null };
async function get(route: Handler, path: string, o: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<Got> {
  const headers: Record<string, string> = { ...(o.cookie ? { cookie: o.cookie } : {}), "x-vercel-forwarded-for": o.ip ?? freshIp(), ...o.headers };
  const res = await route(new Request(`${BASE}${path}`, { headers }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, retry: res.headers.get("retry-after") };
}
type List = { jobs: { id: string }[]; next: string | null; previous: string | null; count: { n: number; more: boolean } | null; signInForMore: boolean };
const list = (g: Got) => g.body as unknown as List;
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const newestFirst = () => [...jobIds].reverse();

describe("a visitor (S3)", () => {
  it("gets the first 6 of the job list, the capped total and the more flag, and no cursor", async () => {
    for (const path of ["/api/jobs", "/api/jobs?sort=newest", "/api/jobs?sort=salary", "/api/jobs?q=cook&occupationCode=1122"]) {
      const g = await get(JOBS, path);
      expect(g.status, path).toBe(200);
      expect(list(g).jobs, path).toHaveLength(6);
      expect([list(g).next, list(g).previous, list(g).signInForMore, list(g).count], path).toEqual([null, null, true, { n: TOTAL, more: false }]);
    }
    expect(list(await get(JOBS, "/api/jobs?sort=newest")).jobs.map((j) => j.id)).toEqual(newestFirst().slice(0, 6));
  });
  it("a list with 6 or fewer jobs says nothing more is behind sign-in", async () => {
    const g = list(await get(JOBS, "/api/jobs?county=Kerry"));
    expect([g.jobs.length, g.signInForMore, g.count]).toEqual([0, false, { n: 0, more: false }]);
  });
  it("gets 6 jobs of a company page and of an occupation page, with the flag", async () => {
    for (const [route, path] of [[COMPANY, `/api/company?slug=${slug}`], [OCCUPATION, "/api/occupation?code=1122"]] as const) {
      const g = await get(route, path);
      expect(g.status, path).toBe(200);
      const jobs = g.body.jobs as List;
      expect([jobs.jobs.length, jobs.next, jobs.signInForMore], path).toEqual([6, null, true]);
    }
  });
  it("cannot page past them: any cursor, a candidate's real cursor, a page number or a page size", async () => {
    const c = await login();
    const real = list(await get(JOBS, "/api/jobs?sort=newest", { cookie: c.cookie })).next!;
    for (const path of [`/api/jobs?sort=newest&after=${real}`, `/api/jobs?sort=newest&before=${real}`, "/api/jobs?after=", "/api/jobs?after=garbage!", `/api/company?slug=${slug}&after=${real}`, `/api/occupation?code=1122&after=${real}`]) {
      const route = path.startsWith("/api/company") ? COMPANY : path.startsWith("/api/occupation") ? OCCUPATION : JOBS;
      const g = await get(route, path);
      expect([g.status, g.body], path).toEqual([401, { code: "SIGN_IN_FOR_MORE" }]);
    }
    for (const path of ["/api/jobs?page=2", "/api/jobs?offset=6", "/api/jobs?limit=1000000", "/api/jobs?pageSize=500&size=500", "/api/jobs?limit=-1"]) {
      const g = list(await get(JOBS, path));
      expect([g.jobs.length, g.jobs[0]!.id], path).toEqual([6, list(await get(JOBS, "/api/jobs")).jobs[0]!.id]);
    }
  });
  it("one job by id stays open; an unknown or hostile id is 404", async () => {
    const g = await get(JOB, `/api/job?id=${jobIds[0]}`);
    expect([g.status, g.body.id, typeof g.body.advertText]).toEqual([200, jobIds[0], "object"]);
    for (const id of ["999999999", "", "1;drop table job", "-1", "1e3"]) expect((await get(JOB, `/api/job?id=${encodeURIComponent(id)}`)).status, id).toBe(404);
  });
  it("bad filters and sorts are 400, never 500", async () => {
    for (const path of ["/api/jobs?sort=best", "/api/jobs?county=Narnia", "/api/jobs?q=a%00b", `/api/jobs?q=${"a".repeat(201)}`, "/api/jobs?county=Cork&county=Kerry"])
      expect((await get(JOBS, path)).status, path).toBe(400);
  });
  it("is every session that is not a live candidate's: forged, expired, suspended, another site's cookie name", async () => {
    const live = await login();
    const token = live.cookie.split("=").slice(1).join("=");
    const expired = await login();
    await su.query("update candidate_session set expires_at = now() - interval '1 hour' where user_id = $1", [expired.id]);
    const suspended = await login({ suspended: true });
    for (const cookie of [
      "candidate.session_token=forged.value", `candidate.session_token=${token}x`, `candidate.session_token=${token.split(".")[0]}.AAAA`,
      expired.cookie, suspended.cookie, `portal.session_token=${token}`, `staff.session_token=${token}`, `session_token=${token}`,
    ]) {
      const g = list(await get(JOBS, "/api/jobs", { cookie }));
      expect([g.jobs.length, g.signInForMore], cookie).toEqual([6, true]);
    }
    expect(list(await get(JOBS, "/api/jobs", { cookie: live.cookie })).jobs).toHaveLength(20); // the same token, under the right name
  });
});

describe("a signed-in candidate (S3)", () => {
  it("gets the full page and pages forward and back through every job", async () => {
    const { cookie } = await login();
    const first = list(await get(JOBS, "/api/jobs?sort=newest", { cookie }));
    expect([first.jobs.length, first.signInForMore, first.count]).toEqual([20, false, { n: TOTAL, more: false }]);
    const second = list(await get(JOBS, `/api/jobs?sort=newest&after=${first.next}`, { cookie }));
    expect([...first.jobs, ...second.jobs].map((j) => j.id)).toEqual(newestFirst());
    expect(second.next).toBeNull();
    expect(list(await get(JOBS, `/api/jobs?sort=newest&before=${second.previous}`, { cookie })).jobs.map((j) => j.id)).toEqual(first.jobs.map((j) => j.id));
    const co = await get(COMPANY, `/api/company?slug=${slug}`, { cookie });
    const cj = co.body.jobs as List;
    expect([cj.jobs.length, cj.signInForMore]).toEqual([20, false]);
    expect(((await get(COMPANY, `/api/company?slug=${slug}&after=${cj.next}`, { cookie })).body.jobs as List).jobs).toHaveLength(TOTAL - 20);
    const oc = (await get(OCCUPATION, "/api/occupation?code=1122", { cookie })).body.jobs as List;
    expect(((await get(OCCUPATION, `/api/occupation?code=1122&after=${oc.next}`, { cookie })).body.jobs as List).jobs).toHaveLength(TOTAL - 20);
  });
  it("a tampered cursor is 400", async () => {
    const { cookie } = await login();
    const next = list(await get(JOBS, "/api/jobs?sort=newest", { cookie })).next!;
    const raw = JSON.parse(Buffer.from(next, "base64url").toString());
    const forge = (o: object) => Buffer.from(JSON.stringify({ ...raw, ...o })).toString("base64url");
    for (const c of [forge({ i: "0" }), forge({ k: ["x"] }), forge({ s: "salary" }), forge({ f: "AAAAAAAAAAAAAAAA" }), forge({ i: "1 or 1=1" }), `${next}x`, "a".repeat(400)])
      expect((await get(JOBS, `/api/jobs?sort=newest&after=${c}`, { cookie })).status, c).toBe(400);
  });
  it("statement budget: a visitor's list is 3 statements, a candidate's 4; a visitor's median time is in budget", async () => {
    const { cookie } = await login();
    const [, visitor] = await counted(() => get(JOBS, "/api/jobs"));
    const [, cand] = await counted(() => get(JOBS, "/api/jobs", { cookie }));
    const times: number[] = [];
    for (let i = 0; i < 21; i++) { const t = performance.now(); await get(JOBS, "/api/jobs"); times.push(performance.now() - t); }
    const median = times.sort((a, b) => a - b)[10]!;
    console.log(`public read: visitor ${visitor} statements, candidate ${cand} statements, visitor list median ${median.toFixed(2)} ms`);
    expect(visitor).toBe(BUDGET.visitor);
    expect(cand).toBe(BUDGET.candidate);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});

describe("the read limit (S5)", () => {
  const key = (ip: string, w: number) => `read:ip:${ip}:${w}`;
  it("answers 429 with Retry-After after 60 reads a minute from one address, on every public route, and the next window lets it through", async () => {
    const ip = "192.0.2.10";
    for (let i = 0; i < 60; i++) expect((await get(i % 2 ? JOB : JOBS, i % 2 ? `/api/job?id=${jobIds[0]}` : "/api/jobs", { ip })).status).toBe(200);
    for (const [route, path] of [[JOBS, "/api/jobs"], [JOB, `/api/job?id=${jobIds[0]}`], [COMPANY, `/api/company?slug=${slug}`], [OCCUPATION, "/api/occupation?code=1122"]] as const) {
      const g = await get(route, path, { ip });
      expect([g.status, g.body], path).toEqual([429, { code: "TOO_MANY_REQUESTS" }]);
      expect(Number(g.retry)).toBeGreaterThanOrEqual(1);
      expect(Number(g.retry)).toBeLessThanOrEqual(60);
    }
    expect((await get(JOBS, "/api/jobs", { ip: "192.0.2.11" })).status).toBe(200); // another address is not held
    await su.query("update candidate_rate_limit set last_request = 0 where key = $1", [key(ip, 60_000)]); // the minute is over
    expect((await get(JOBS, "/api/jobs", { ip })).status).toBe(200);
  });
  it("answers 429 after 600 reads an hour, with Retry-After up to the hour's end", async () => {
    const ip = "192.0.2.20";
    expect((await get(JOBS, "/api/jobs", { ip })).status).toBe(200);
    await su.query("update candidate_rate_limit set count = 600 where key = $1", [key(ip, 3_600_000)]);
    const g = await get(JOBS, "/api/jobs", { ip });
    expect(g.status).toBe(429);
    expect(Number(g.retry)).toBeGreaterThan(3000);
    expect(Number(g.retry)).toBeLessThanOrEqual(3600);
  });
  it("cannot be reset by an untrusted address header; only the first x-vercel-forwarded-for entry counts", async () => {
    const ip = "192.0.2.30";
    await get(JOBS, "/api/jobs", { ip });
    await su.query("update candidate_rate_limit set count = 60 where key = $1", [key(ip, 60_000)]);
    for (const headers of [{ "x-forwarded-for": "10.9.9.9" }, { "x-real-ip": "10.9.9.8" }, { forwarded: "for=10.9.9.7" }, { "cf-connecting-ip": "10.9.9.6" }, { "true-client-ip": "10.9.9.5" }] as Record<string, string>[])
      expect((await get(JOBS, "/api/jobs", { ip, headers })).status, JSON.stringify(headers)).toBe(429);
    expect((await get(JOBS, "/api/jobs", { ip: `${ip}, 10.9.9.4` })).status).toBe(429);
    expect((await get(JOBS, "/api/jobs", { ip: ` ${ip} ` })).status).toBe(429);
    const rows = (await su.query("select key from candidate_rate_limit where key like 'read:ip:10.9.9.%'")).rows;
    expect(rows).toEqual([]);
  });
  it("a request with no address header is counted under one shared key, not free", async () => {
    await su.query("delete from candidate_rate_limit where key like 'read:ip:none:%'");
    await JOBS(new Request(`${BASE}/api/jobs`));
    expect((await su.query("select count from candidate_rate_limit where key = 'read:ip:none:60000'")).rows).toEqual([{ count: 1 }]);
  });
  it("a candidate is counted per login, 300 a minute, whatever the address; a forged cookie is counted as a visitor", async () => {
    const a = await login(), b = await login();
    const ip = "192.0.2.40";
    await get(JOBS, "/api/jobs", { ip });
    await su.query("update candidate_rate_limit set count = 60 where key = $1", [key(ip, 60_000)]);
    expect((await get(JOBS, "/api/jobs", { ip, cookie: a.cookie })).status).toBe(200); // the visitor limit of the address does not hold a login
    expect((await get(JOBS, "/api/jobs", { ip, cookie: "candidate.session_token=forged.value" })).status).toBe(429);
    await su.query("update candidate_rate_limit set count = 300 where key = $1", [`read:candidate:${a.id}:60000`]);
    const g = await get(JOBS, "/api/jobs", { cookie: a.cookie, ip: freshIp() });
    expect([g.status, g.body]).toEqual([429, { code: "TOO_MANY_REQUESTS" }]);
    expect(Number(g.retry)).toBeLessThanOrEqual(60);
    expect((await get(JOBS, "/api/jobs", { cookie: b.cookie, ip: freshIp() })).status).toBe(200);
  });
});
