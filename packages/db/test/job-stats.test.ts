// Integration: job stats (step 9, part 12b) on the real test database. The view counter runs as app_candidate (the job page's login); the employer read goes
// through the real /api/portal/job-stats handler as app_portal with real portal sessions. Jobs and stat rows are written as postgres. No network. Fake people only.
import { pressed } from "./confirm-link";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { COUNT_VIEW, countJobView, STATS_READ } from "../src/job-stats";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { assertPageBudget, measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// Measured on 12 November 2026. Write budget for a busy job: one statement per view; 300 views of one job at once (the whole hot-row queue, 4 connections) took 40 to 45 ms,
// the limit is 400 ms; one counted view touches 9 pages (limit 15), median 0.4 ms (limit 3); the 30-day read of 20 jobs (600 rows) touches 67 to 68 pages (limit 150),
// median 3.8 to 5.5 ms (limit 20), 4 statements (requirePortal 3, the read 1). The module's own gate is 1,000 pages. Raise these only on purpose.
const BUDGET = { viewStatements: 1, burst: 300, burstMs: 400, viewMs: 3, viewPages: 15, read: 4, readMs: 20, readPages: 150 };

const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, cand: pg.Pool;
let authPOST: Handler, statsGET: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number> };
let source: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  cand = db.pool("app_candidate");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: statsGET } = await import("../../../apps/portal/app/api/portal/job-stats/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
  mail = pressed(mail, "portal");
  source = (await su.query("insert into job_source(kind, board) values ('portal', 'portal') returning id::text")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let ipn = 0;
const freshIp = () => `10.7.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
type Reply = { status: number; json: Record<string, any> | null; text: string; cookie: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const authCall = async (path: string, body: unknown) => reply(await authPOST(new Request(`${BASE}/api/auth/portal/${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } })));
const click = async (link: string) => reply(await (await import("../../../apps/portal/app/api/auth/portal/[...all]/route")).GET(new Request(link, { headers: { "x-vercel-forwarded-for": freshIp() }, redirect: "manual" })));
const stats = async (cookie: string | undefined, query = "") => reply(await statsGET(new Request(`${BASE}/api/portal/job-stats${query}`, { headers: cookie ? { cookie } : {} })));
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: (i: number) => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(i); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

let n = 0;
async function login(): Promise<{ cookie: string; id: string }> {
  const p = { email: `fake.j${++n}@elsewhere.example.test`, password: `Fake-j${n}-password-1`, name: `Fake J${n}`, ...portalAnswers };
  expect((await authCall("sign-up/email", p)).status).toBe(200);
  await click(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link);
  const r = await authCall("sign-in/email", { email: p.email, password: p.password });
  expect(r.status, r.text).toBe(200);
  return { cookie: r.cookie, id: (await one("select id from portal_user where email=$1", [p.email])).id };
}
async function company() {
  const org = Number(await F.org({ status: "verified" }));
  const roles: Record<string, { cookie: string }> = {};
  for (const role of ["account_owner", "recruiter", "viewer"]) {
    const l = await login();
    await F.member(org, l.id, { role, signer: role === "account_owner" });
    roles[role] = l;
  }
  return { org, owner: roles.account_owner!, recruiter: roles.recruiter!, viewer: roles.viewer! };
}
async function job(org: number, o: { status?: string; title?: string; closes?: string } = {}): Promise<number> {
  const status = o.status ?? "live";
  const live = status === "live";
  const hidden = status === "hidden";
  return Number((await one(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, close_reason, closed_at, hidden_reason, salary_low, search_vector, closes_at, own_page_url)
     values ($1, 'employer', $2, $3, 'Fake Org', 'it', 'critical_skills', $4, $5, $6, $7, 40000, ${live ? "'fake:1'::tsvector" : "null"}, ${o.closes ?? "now() + interval '20 days'"}, 'https://example.test/apply') returning id`,
    [org, source, o.title ?? "Fake job", status, status === "closed" ? "closed" : null, status === "closed" ? new Date() : null, hidden ? "admin" : null])).id);
}
const day = (ago: number) => `((now() at time zone 'Europe/Dublin')::date - ${ago})`;
const put = (jobId: number, ago: number, views: number, clicks = 0) =>
  su.query(`insert into job_daily_stat(job_id, day, views, apply_clicks) values ($1, ${day(ago)}, $2, $3)`, [jobId, views, clicks]);
const rows = (jobId: number) => su.query("select day::text, views, apply_clicks from job_daily_stat where job_id = $1 order by day", [jobId]).then((r) => r.rows);
const today = async () => (await one("select (now() at time zone 'Europe/Dublin')::date::text d")).d as string;

describe("countJobView", () => {
  it("counts each view of a live job on one row for today, and leaves apply_clicks alone", async () => {
    const c = await company(), j = await job(c.org);
    for (let i = 0; i < 3; i++) expect(await countJobView(cand, j)).toBe(true);
    expect(await rows(j)).toEqual([{ day: await today(), views: 3, apply_clicks: 0 }]);
    await su.query("update job_daily_stat set apply_clicks = 5 where job_id = $1", [j]);
    expect(await countJobView(cand, String(j))).toBe(true);
    expect(await rows(j)).toEqual([{ day: await today(), views: 4, apply_clicks: 5 }]);
  });
  it("counts nothing for a job that is not live, has passed closes_at, or does not exist", async () => {
    const c = await company();
    const ids = [await job(c.org, { status: "draft" }), await job(c.org, { status: "in_review" }), await job(c.org, { status: "closed" }), await job(c.org, { status: "hidden" }), await job(c.org, { status: "under_review" })];
    const expired = await job(c.org, { closes: "now() + interval '1 hour'" });
    await su.query("update job set closes_at = now() - interval '1 minute' where id = $1", [expired]).catch(() => null);
    for (const j of [...ids, expired, 987654321]) expect(await countJobView(cand, j), String(j)).toBe(false);
    for (const j of [...ids, expired]) expect(await rows(j), String(j)).toEqual([]);
  });
  it("counts by the Dublin day whatever the session's time zone", async () => {
    const c = await company(), j = await job(c.org);
    const client = await cand.connect();
    try {
      await client.query("set time zone 'Pacific/Kiritimati'"); // UTC+14: its calendar day is often not Dublin's
      expect(await countJobView(client, j)).toBe(true);
      await client.query("set time zone 'Pacific/Pago_Pago'"); // UTC-11
      expect(await countJobView(client, j)).toBe(true);
    } finally { client.release(); }
    expect(await rows(j)).toEqual([{ day: await today(), views: 2, apply_clicks: 0 }]);
  });
  it("ignores bad ids without touching the database", async () => {
    for (const id of ["", "0", "-1", "1.5", "abc", "1; drop table job_daily_stat", "9223372036854775808"]) expect(await countJobView(cand, id), id).toBe(false);
    expect((await one("select count(*)::int n from job_daily_stat")).n).toBeGreaterThanOrEqual(0);
  });
  it("loses no view when many arrive at once on one busy job, and stays inside the write budget", async () => {
    const c = await company(), busy = await job(c.org), quiet = await job(c.org);
    const t = performance.now();
    const results = await Promise.all(Array.from({ length: BUDGET.burst }, (_, i) => countJobView(cand, i % 10 === 0 ? quiet : busy)));
    const ms = performance.now() - t;
    expect(results.every(Boolean)).toBe(true);
    expect([(await rows(busy))[0]!.views, (await rows(quiet))[0]!.views]).toEqual([BUDGET.burst * 0.9, BUDGET.burst * 0.1]);
    expect(ms).toBeLessThan(BUDGET.burstMs);
  });
  it("is one statement and a few pages per view", async () => {
    const c = await company(), j = await job(c.org);
    const [, statements] = await counted(() => countJobView(cand, j));
    expect(statements).toBe(BUDGET.viewStatements);
    expect(await median(() => countJobView(cand, j))).toBeLessThan(BUDGET.viewMs);
    const client = await su.connect();
    try {
      await client.query("begin"); // the explained insert really writes, so undo it
      assertPageBudget("one counted view", await measurePages(client, [{ text: COUNT_VIEW, values: [String(j)] }]), BUDGET.viewPages);
    } finally { await client.query("rollback"); client.release(); }
  });
  it("the page's login cannot read or change what it did not write: another table, or a job's other columns", async () => {
    await expect(cand.query("select * from pay_floor limit 1")).rejects.toThrow();
    await expect(cand.query("select hire_answer from job limit 1")).rejects.toThrow();
    await expect(cand.query("delete from job_daily_stat")).rejects.toThrow();
  });
});

describe("GET /api/portal/job-stats", () => {
  it("is 401 without a session and empty for a login with no company", async () => {
    expect((await stats(undefined)).status).toBe(401);
    expect((await stats(undefined, "?days=7")).status).toBe(401);
    const l = await login();
    const r = await stats(l.cookie);
    expect([r.status, r.json]).toEqual([200, { days: 30, stats: [] }]);
  });
  it("shows every active member the company's own views and clicks by day, newest first, with job, source and status", async () => {
    const c = await company(), a = await job(c.org, { title: "Chef" }), b = await job(c.org, { title: "Cook", status: "closed" });
    await put(a, 0, 10, 2); await put(a, 1, 7, 1); await put(b, 1, 3, 0);
    for (const who of [c.owner, c.recruiter, c.viewer]) {
      const r = await stats(who.cookie);
      expect(r.status).toBe(200);
      expect(r.json!.stats).toEqual([
        { jobId: String(a), title: "Chef", source: "employer", status: "live", day: await today(), views: 10, applyClicks: 2 },
        { jobId: String(a), title: "Chef", source: "employer", status: "live", day: (await one(`select ${day(1)}::text d`)).d, views: 7, applyClicks: 1 },
        { jobId: String(b), title: "Cook", source: "employer", status: "closed", day: (await one(`select ${day(1)}::text d`)).d, views: 3, applyClicks: 0 },
      ].sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : Number(x.jobId) - Number(y.jobId))));
    }
  });
  it("never shows another company's jobs, not even by asking for one of their job ids", async () => {
    const c = await company(), other = await company();
    const mine = await job(c.org), theirs = await job(other.org, { title: "Secret" });
    await put(mine, 0, 4); await put(theirs, 0, 99, 9);
    for (const who of [c.owner, c.viewer]) {
      const all = await stats(who.cookie);
      expect(all.json!.stats.map((s: { jobId: string }) => s.jobId)).toEqual([String(mine)]);
      expect(all.text).not.toContain("Secret");
      const asked = await stats(who.cookie, `?jobId=${theirs}`);
      expect([asked.status, asked.json!.stats]).toEqual([200, []]);
      expect((await stats(who.cookie, `?jobId=${mine}`)).json!.stats.length).toBe(1);
    }
    const o = await stats(other.owner.cookie);
    expect(o.json!.stats.map((s: { jobId: string }) => s.jobId)).toEqual([String(theirs)]);
  });
  it("reads only the window asked for: 30 days by default, 1 to 90", async () => {
    const c = await company(), j = await job(c.org);
    await put(j, 0, 1); await put(j, 6, 2); await put(j, 29, 3); await put(j, 30, 4); await put(j, 89, 5); await put(j, 90, 6);
    const days = async (q: string) => (await stats(c.owner.cookie, q)).json!.stats.map((s: { views: number }) => s.views);
    expect(await days("")).toEqual([1, 2, 3]);
    expect(await days("?days=1")).toEqual([1]);
    expect(await days("?days=7")).toEqual([1, 2]);
    expect(await days("?days=31")).toEqual([1, 2, 3, 4]);
    expect(await days("?days=90")).toEqual([1, 2, 3, 4, 5]);
  });
  it("refuses bad or unknown parameters", async () => {
    const c = await company();
    for (const q of ["?days=0", "?days=91", "?days=abc", "?days=-1", "?days=1.5", "?days=", "?days=1e1", "?days=%20", "?days=1&days=2x", "?jobId=abc", "?jobId=0", "?jobId=1;2", "?jobId=", "?organisationId=1", "?days=7&x=1", "?jobId=99999999999999999999"]) {
      const r = await stats(c.owner.cookie, q);
      expect([r.status, r.json], q).toEqual([400, { code: "BAD_REQUEST" }]);
    }
  });
  it("is cheap: 4 statements, under its time and page budgets, for 20 jobs over 30 days", async () => {
    const c = await company();
    for (let i = 0; i < 20; i++) {
      const j = await job(c.org, { title: `Perf ${i}` });
      await su.query(`insert into job_daily_stat(job_id, day, views, apply_clicks) select $1, ${day(0)} - g, g, 1 from generate_series(0, 29) g`, [j]);
    }
    const [r, statements] = await counted(() => stats(c.owner.cookie));
    expect(r.json!.stats.length).toBe(600);
    expect(statements).toBe(BUDGET.read);
    expect(await median(() => stats(c.owner.cookie))).toBeLessThan(BUDGET.readMs);
    const client = await su.connect();
    try { assertPageBudget("job stats read", await measurePages(client, [{ text: STATS_READ, values: [String(c.org), 29, null] }]), BUDGET.readPages); } finally { client.release(); }
  });
});
