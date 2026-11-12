// Slice 8.5 item 1: "report a job" from the portal, end to end on the test database. Real sign-up and sign-in through the
// real auth route (connected as app_portal), then the real /api/portal/report handler with a Request. Fake people only.
// Measured on 12 November 2026 (warm, three runs): a report is 5 statements (session 2, membership 1, rate count 1, the insert 1); the median of
// 9 calls was 5 to 7 ms. Budget: 5 statements, median 40 ms (about 4 times the slowest median). Raise these only on purpose.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

const BUDGET = { statements: 5, medianMs: 40 };
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, app: pg.Pool;
let AUTH: Handler, REPORT: Handler;
let F: { org(o?: object): Promise<string> };
let live: string, org: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  app = db.pool("app_portal");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: REPORT } = await import("../../../apps/portal/app/api/portal/report/route"));
  org = await F.org();
  live = await job("live");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
async function job(status: string, closes = "now()+interval '20 days'"): Promise<string> {
  const src = (await su.query("insert into job_source(kind,board) values ('portal',$1) returning id", [uid("b")])).rows[0].id;
  const hidden = status === "hidden" ? ", hidden_reason" : "";
  const hiddenV = status === "hidden" ? ", 'admin'" : "";
  return (await su.query(`insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,salary_high,pay_grade${hidden})
    values ($1,'admin_manual',$2,'Cook','Fake Org','it','critical_skills',$3,${closes},'https://example.test/a',to_tsvector('english','cook'),30000,40000,'g1'${hiddenV}) returning id`, [org, src, status])).rows[0].id as string;
}
async function login(blocked = false) {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const ip = `198.51.100.${(n % 200) + 10}`;
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip };
  const up = await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }));
  expect(up.status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from portal_user where email=$1", [email])).rows[0].id as string;
  if (blocked) await su.query("update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='x' where id=$1", [id]);
  return { cookie, id };
}
async function report(body: unknown, o: { cookie?: string; origin?: string | null; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await REPORT(new Request(`${BASE}/api/portal/report`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers }));
  const text = await res.text();
  return { status: res.status, text, code: (JSON.parse(text) as { code?: string }).code };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const rows = async (id: string) => (await su.query("select * from report where reporter_portal_user_id=$1", [id])).rows;

describe("report a job (portal)", () => {
  it("files a report with the snapshot and the reporter id, and answers only ok", async () => {
    const p = await login();
    const r = await report({ jobId: live, reason: "asks_for_money", evidence: "They asked for a fee.\nTwice." }, p);
    expect([r.status, r.text]).toEqual([200, '{"ok":true}']);
    const [row] = await rows(p.id);
    expect(row).toMatchObject({ target_kind: "job", target_job_id: live, reason: "asks_for_money", status: "open", evidence_text: "They asked for a fee.\nTwice.", reporter_candidate_user_id: null });
    expect(row.target_snapshot).toMatchObject({ title: "Cook", employer_name: "Fake Org", badge: null, salary_low: 30000, salary_high: 40000, pay_grade: "g1" });
  });
  it("a second open report of the same job by the same login is ALREADY_REPORTED; another login may report it", async () => {
    const p = await login();
    expect((await report({ jobId: live, reason: "other" }, p)).status).toBe(200);
    expect(await report({ jobId: live, reason: "job_closed" }, p)).toMatchObject({ status: 409, code: "ALREADY_REPORTED" });
    expect((await report({ jobId: live, reason: "other" }, await login())).status).toBe(200);
  });
  it("a closed, hidden, expired or unknown job is JOB_NOT_FOUND", async () => {
    const p = await login();
    for (const j of [await job("closed"), await job("hidden"), await job("draft"), await job("live", "now()-interval '1 day'"), "999999999"])
      expect(await report({ jobId: j, reason: "other" }, p), j).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    expect(await rows(p.id)).toEqual([]);
  });
  it("the rate limit trips after 10 reports in an hour", async () => {
    const p = await login();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await report({ jobId: await job("live"), reason: "other" }, p)).status);
    expect(codes).toEqual([...Array(10).fill(200), 429, 429]);
    expect((await rows(p.id)).length).toBe(10);
  });
  it("refuses no session, a foreign or missing Origin, a bad or oversized body", async () => {
    const p = await login();
    const good = { jobId: live, reason: "wrong_details" };
    expect(await report(good, {})).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect(await report(good, { cookie: "better-auth.session_token=junk" })).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect(await report(good, { ...p, origin: "https://evil.example" })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect(await report(good, { ...p, origin: null })).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect(await report({ ...good, evidence: "x".repeat(5000) }, p)).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    expect(await report(good, { ...p, headers: { "content-length": "999999" } })).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    for (const raw of ["not json", "[]", "null", JSON.stringify({ ...good, status: "upheld" }), JSON.stringify({ ...good, jobId: 5 }), JSON.stringify({ ...good, reason: "x" })])
      expect(await report(null, { ...p, raw }), raw).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await rows(p.id)).toEqual([]);
  });
  it("a blocked or deleted portal login is refused, and a login with no company may report", async () => {
    const s = await login(true);
    expect(await report({ jobId: live, reason: "other" }, s)).toMatchObject({ status: 403, code: "REFUSED" });
    const d = await login();
    await su.query("update portal_user set deleted_at=now() where id=$1", [d.id]);
    expect((await report({ jobId: live, reason: "other" }, d)).status).toBe(403);
    expect([...(await rows(s.id)), ...(await rows(d.id))]).toEqual([]);
  });
});

describe("security: what the portal role can do to report", () => {
  it("cannot read report columns other than id", async () => {
    for (const col of ["reporter_portal_user_id", "reason", "evidence_text", "status", "target_snapshot"])
      await expect(app.query(`select ${col} from report`), col).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("select id from report")).resolves.toBeDefined();
  });
  it("cannot insert a decided report or a hidden status", async () => {
    const p = (await su.query("select id from portal_user limit 1")).rows[0].id;
    const base = "insert into report(target_kind, target_job_id, reporter_portal_user_id, reason, %COL%) values ('job', $1, $2, 'other', %VAL%)";
    const staff = (await su.query("insert into staff_user(id,name,email,email_verified) values($1,'S',$2,true) returning id", [uid("s"), `${uid("s")}@example.test`])).rows[0].id;
    for (const [col, val, arg] of [["status", "'job_hidden'", []], ["decided_by_staff_user_id", "$3", [staff]], ["reporter_wiped_at", "now()", []]] as const)
      await expect(app.query(base.replace("%COL%", col).replace("%VAL%", val), [live, p, ...arg]), col).rejects.toMatchObject({ code: "42501" });
  });
  it("cannot read who reported through a strike", async () => {
    await expect(app.query("select report_id from strike")).rejects.toMatchObject({ code: "42501" });
  });
  it("cannot update or delete a report", async () => {
    await expect(app.query("update report set reason='other'")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("delete from report")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("performance: one report call", () => {
  it("stays inside the statement count and the time budget", async () => {
    const p = await login(), times: number[] = [];
    let statements = 0;
    for (let i = 0; i < 9; i++) {
      const j = await job("live");
      const t = performance.now();
      const [r, c] = await counted(() => report({ jobId: j, reason: "other", evidence: "x" }, p));
      times.push(performance.now() - t);
      expect(r.status).toBe(200);
      statements = Math.max(statements, c);
    }
    const median = [...times].sort((a, b) => a - b)[4]!;
    console.log(`report-portal: ${statements} statements, median ${median.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
