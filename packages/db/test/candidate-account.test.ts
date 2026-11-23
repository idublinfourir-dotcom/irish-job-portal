// Step 9 part 10: the signed-in candidate routes, end to end on the test database. Real sign-up and sign-in through the real auth route,
// then the real route handlers of apps/candidate (profile, saved jobs, tracker, "Did you apply?", one closed job, notification settings, delete
// account) with Requests. Fake people only; no outside service (the candidate login uses its fake mail sender).
// Measured on 12 November 2026 (warm, 9 calls each, see the console lines): statements per call and median ms are in BUDGET with room of about 3 to 4 times.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { measurePages } from "./perf/pages";
import { similarSql } from "../src/candidate";

// A statement count includes the 2 session statements and the rate-limit statement; a transaction adds begin and commit.
const BUDGET = {
  profilePut: { statements: 8, medianMs: 40 },
  save: { statements: 5, medianMs: 40 },
  click: { statements: 9, medianMs: 40 },
  answer: { statements: 8, medianMs: 40 },
  closedRead: { statements: 6, medianMs: 40 },
  prompts: { statements: 4, medianMs: 40 },
};
const PAGE_BUDGET = 300; // 8 kB pages for the similar-jobs queries together on 3,000 live jobs in one sector (measured 110); without an occupation index a rare occupation reads its sector
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>;
let db: TestDb, su: pg.Pool, app: pg.Pool;
let AUTH: Handler;
const R = {} as Record<"profile" | "saved" | "click" | "prompts" | "tracker" | "job" | "notifications" | "account", Route>;
let F: { org(o?: object): Promise<string> };
let org: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  app = db.pool("app_candidate");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  const api = "../../../apps/candidate/app/api/candidate";
  R.profile = await import(`${api}/profile/route`);
  R.saved = await import(`${api}/saved/route`);
  R.click = await import(`${api}/apply-click/route`);
  R.prompts = await import(`${api}/did-you-apply/route`);
  R.tracker = await import(`${api}/tracker/route`);
  R.job = await import(`${api}/job/route`);
  R.notifications = await import(`${api}/notifications/route`);
  R.account = await import(`${api}/account/route`);
  org = await F.org();
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
type JobOpts = { closes?: string; sector?: string; occ?: string | null; reason?: string; route?: string; quota?: boolean };
async function job(status: string, o: JobOpts = {}): Promise<string> {
  const src = (await su.query("insert into job_source(kind,board) values ('portal',$1) returning id", [uid("b")])).rows[0].id;
  const extra = status === "hidden" ? ", hidden_reason" : status === "closed" && o.reason ? ", close_reason" : "";
  const extraV = status === "hidden" ? ", 'admin'" : status === "closed" && o.reason ? `, '${o.reason}'` : "";
  return (await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,occupation_code,permit_type,status,closes_at,own_page_url,search_vector,salary_low,salary_high,pay_grade,quota_full,application_route${extra})
     values ($1,'admin_manual',$2,$3,'Fake Org',$4,$5,'critical_skills',$6,${o.closes ?? "now()+interval '20 days'"},'https://example.test/apply',to_tsvector('english','cook'),30000,40000,'g1',$7,$8${extraV}) returning id::text`,
    [org, src, `Cook ${uid("t")}`, o.sector ?? "it", o.occ ?? null, status, o.quota ?? false, o.route ?? "own_page"])).rows[0].id as string;
}
async function login(suspended = false) {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const ip = `198.51.100.${(n % 200) + 10}`;
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip };
  const up = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }));
  expect(up.status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  if (suspended) await su.query("update candidate_user set suspended_at=now() where id=$1", [id]);
  return { cookie, id, email, password, h };
}
type P = Awaited<ReturnType<typeof login>>;
type Opts = { cookie?: string; origin?: string | null; raw?: string; headers?: Record<string, string>; query?: string };
async function call(route: Route, method: keyof Route, body: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  const init: RequestInit = { method, headers };
  if (method !== "GET") init.body = o.raw ?? JSON.stringify(body);
  const res = await route[method]!(new Request(`${BASE}/api/candidate/x${o.query ?? ""}`, init));
  const text = await res.text();
  const json = JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, json, code: json.code as string | undefined };
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const profile = { fullName: "Fake Person", occupationCode: "2111", yearsExperience: 4, locationKind: "ireland", currentStamp: "1G" };

describe("profile", () => {
  it("is empty at first, PUT stores it, GET returns it, and it is never visible to employers", async () => {
    const p = await login();
    expect((await call(R.profile, "GET", null, p)).json).toEqual({ profile: null });
    const put = await call(R.profile, "PUT", { ...profile, hasRelevantDegree: true, degreeAwardedMonth: "2026-05-01" }, p);
    expect([put.status, put.json]).toEqual([200, { ok: true, deletionOffered: false, alertsPaused: 0 }]);
    const got = (await call(R.profile, "GET", null, p)).json.profile;
    expect(got).toMatchObject({ fullName: "Fake Person", occupationCode: "2111", yearsExperience: 4, degreeAwardedMonth: "2026-05-01", currentStamp: "1G", phone: null });
    expect(got.degreeBox).toBe(new Date() < new Date("2027-04-30T23:00:00Z") ? "last_12_months" : "relevant"); // S19: May 2026 is recent until 1 May 2027 in Dublin
    expect((await one("select visible_to_employers, visible_fields from candidate_profile where candidate_user_id=$1", [p.id]))[0]).toEqual({ visible_to_employers: false, visible_fields: null });
  });
  it("PUT replaces the whole profile, and touches only this login's row", async () => {
    const a = await login(), b = await login();
    await call(R.profile, "PUT", profile, a);
    await call(R.profile, "PUT", { ...profile, fullName: "Other Person" }, b);
    await call(R.profile, "PUT", { fullName: "Only Name" }, a);
    expect((await call(R.profile, "GET", null, a)).json.profile).toMatchObject({ fullName: "Only Name", occupationCode: null, currentStamp: null });
    expect((await call(R.profile, "GET", null, b)).json.profile).toMatchObject({ fullName: "Other Person", currentStamp: "1G" });
    expect(await one("select count(*)::int c from candidate_profile where candidate_user_id = any($1)", [[a.id, b.id]])).toEqual([{ c: 2 }]);
  });
  it("PUT accepts any SOC 2010 code, not only the badge lists, and refuses a four-digit code outside it", async () => {
    const a = await login();
    expect((await call(R.profile, "PUT", { ...profile, occupationCode: "3111" }, a)).status).toBe(200); // on neither badge list
    expect((await call(R.profile, "GET", null, a)).json.profile).toMatchObject({ occupationCode: "3111" });
    for (const occupationCode of ["9999", "0000", "1110"]) expect(await call(R.profile, "PUT", { ...profile, occupationCode }, a), occupationCode).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect((await call(R.profile, "GET", null, a)).json.profile).toMatchObject({ occupationCode: "3111" }); // nothing replaced
  });
  it("a body that names another candidate or visibility is refused and nothing is stored", async () => {
    const a = await login(), b = await login();
    for (const extra of [{ candidateUserId: b.id }, { candidate_user_id: b.id }, { visibleToEmployers: true }, { visible_to_employers: true }, { id: 1 }])
      expect(await call(R.profile, "PUT", { ...profile, ...extra }, a), JSON.stringify(extra)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await one("select count(*)::int c from candidate_profile where candidate_user_id = any($1)", [[a.id, b.id]])).toEqual([{ c: 0 }]);
  });
  it("an occupation not on the lists, a stamp outside Ireland and a degree date without a degree are refused", async () => {
    const a = await login();
    for (const bad of [{ occupationCode: "9999" }, { locationKind: "abroad" }, { degreeAwardedMonth: "2026-05-01" }, { degreeAwardedMonth: "2026-05-02", hasRelevantDegree: true }, { currentStamp: "9" }])
      expect((await call(R.profile, "PUT", { ...profile, ...bad }, a)).status, JSON.stringify(bad)).toBe(400);
  });
  it("Stamp 4 pauses every active alert of this candidate in the same transaction, offers deletion, and leaves other candidates' alerts alone", async () => {
    const a = await login(), b = await login();
    const alert = (u: string, status: string) => su.query("insert into alert(candidate_user_id, frequency, status, unsubscribe_token) values ($1,'daily',$3,$2)", [u, uid("tok"), status]);
    await alert(a.id, "active"); await alert(a.id, "active"); await alert(a.id, "unsubscribed"); await alert(b.id, "active");
    const r = await call(R.profile, "PUT", { ...profile, currentStamp: "4" }, a);
    expect(r.json).toEqual({ ok: true, deletionOffered: true, alertsPaused: 2 });
    expect(await one("select status, pause_reason, count(*)::int c from alert where candidate_user_id=$1 group by 1,2 order by 1", [a.id])).toEqual([
      { status: "paused", pause_reason: "stamp_4", c: 2 }, { status: "unsubscribed", pause_reason: null, c: 1 }]);
    expect(await one("select status, pause_reason from alert where candidate_user_id=$1", [b.id])).toEqual([{ status: "active", pause_reason: null }]);
    expect((await call(R.profile, "PUT", { ...profile, currentStamp: "4EUFAM" }, b)).json.deletionOffered).toBe(true);
  });
  it("a failed profile write leaves the alerts active (one transaction)", async () => {
    const a = await login();
    await su.query("insert into alert(candidate_user_id, frequency, unsubscribe_token) values ($1,'daily',$2)", [a.id, uid("tok")]);
    // a database error after the profile row: the update of alert raises, so the profile insert rolls back too
    await su.query("create or replace function public.fail_alert() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$");
    await su.query("create trigger fail_alert before update on alert for each row execute function public.fail_alert()");
    try {
      expect(await call(R.profile, "PUT", { ...profile, currentStamp: "4" }, a)).toMatchObject({ status: 403, code: "REFUSED" });
      expect(await one("select count(*)::int c from candidate_profile where candidate_user_id=$1", [a.id])).toEqual([{ c: 0 }]);
    } finally {
      await su.query("drop trigger fail_alert on alert");
    }
  });
});

describe("saved jobs", () => {
  it("saves, lists newest first, marks a closed job, and unsaves; saving twice is fine", async () => {
    const p = await login();
    const j1 = await job("live"), j2 = await job("live"), j3 = await job("live");
    for (const j of [j1, j2, j3]) expect((await call(R.saved, "POST", { jobId: j }, p)).json).toEqual({ ok: true });
    expect((await call(R.saved, "POST", { jobId: j1 }, p)).status).toBe(200);
    await su.query("update job set status='closed', closed_at=now(), close_reason='closed' where id=$1", [j2]);
    await su.query("update job set closes_at = now() - interval '1 day' where id=$1", [j3]);
    const list = (await call(R.saved, "GET", null, p)).json.saved as { jobId: string; live: boolean; salaryLow?: number; title: string }[];
    expect(list.map((x) => [x.jobId, x.live])).toEqual([[j3, false], [j2, false], [j1, true]]);
    expect(list[0]).not.toHaveProperty("salaryLow"); // a closed job shows only title and employer
    expect(list[2]).toMatchObject({ salaryLow: 30000, employerName: "Fake Org" });
    expect((await call(R.saved, "DELETE", { jobId: j1 }, p)).json).toEqual({ ok: true, removed: 1 });
    expect((await call(R.saved, "DELETE", { jobId: j1 }, p)).json).toEqual({ ok: true, removed: 0 });
    expect(((await call(R.saved, "GET", null, p)).json.saved as unknown[]).length).toBe(2);
  });
  it("never shows or removes another candidate's saved job", async () => {
    const a = await login(), b = await login();
    const j = await job("live");
    await call(R.saved, "POST", { jobId: j }, a);
    expect((await call(R.saved, "GET", null, b)).json).toEqual({ saved: [] });
    expect((await call(R.saved, "DELETE", { jobId: j }, b)).json.removed).toBe(0);
    expect(await one("select count(*)::int c from saved_job where candidate_user_id=$1", [a.id])).toEqual([{ c: 1 }]);
    expect(await one("select count(*)::int c from saved_job where candidate_user_id=$1", [b.id])).toEqual([{ c: 0 }]);
  });
  it("refuses a job that was never live, or does not exist; a closed one that was live is allowed", async () => {
    const p = await login();
    for (const j of [await job("draft"), await job("in_review"), await job("closed", { reason: "abandoned" }), "999999999"])
      expect(await call(R.saved, "POST", { jobId: j }, p), j).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    for (const j of [await job("closed", { reason: "closed" }), await job("closed", { reason: "expired" }), await job("hidden"), await job("under_review")])
      expect((await call(R.saved, "POST", { jobId: j }, p)).status, j).toBe(200);
    expect(await one("select count(*)::int c from saved_job where candidate_user_id=$1", [p.id])).toEqual([{ c: 4 }]);
  });
  it("holds at most 200 per candidate, enforced in the database, also when saves arrive at once", async () => {
    const p = await login(), q = await login();
    const src = (await su.query("insert into job_source(kind,board) values ('portal',$1) returning id", [uid("b")])).rows[0].id;
    const ids = (await su.query(
      `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,pay_grade)
       select $1,'admin_manual',$2,'Bulk '||g,'Fake Org','it','critical_skills','live',now()+interval '20 days','https://example.test/a',to_tsvector('english','cook'),30000,'g1' from generate_series(1,203) g returning id::text`, [org, src])).rows.map((r) => r.id as string);
    await su.query("insert into saved_job(candidate_user_id, job_id) select $1, unnest($2::bigint[])", [p.id, ids.slice(0, 198)]);
    const results = await Promise.all(ids.slice(198, 203).map((j) => call(R.saved, "POST", { jobId: j }, p)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.code === "SAVED_LIMIT")).toBe(true);
    expect(await one("select count(*)::int c from saved_job where candidate_user_id=$1", [p.id])).toEqual([{ c: 200 }]);
    expect((await call(R.saved, "POST", { jobId: ids[0] }, p)).status).toBe(200); // already saved: not an error at the cap
    expect((await call(R.saved, "GET", null, p)).json.saved).toHaveLength(200);
    await call(R.saved, "DELETE", { jobId: ids[0] }, p);
    const refused = ids[198 + results.findIndex((r) => r.status === 409)]!;
    expect((await call(R.saved, "POST", { jobId: refused }, p)).status).toBe(200); // room again
    // another candidate is not held by this one's cap
    expect((await call(R.saved, "POST", { jobId: ids[0] }, q)).status).toBe(200);
  });
});

describe("the tracker and Did you apply?", () => {
  it("a click records one open row, counts today's apply click, and answers the employer's page", async () => {
    const p = await login(), j = await job("live");
    const r = await call(R.click, "POST", { jobId: j }, p);
    expect([r.status, r.json]).toEqual([200, { ok: true, url: "https://example.test/apply" }]);
    expect(await one("select status, times_asked from apply_click where candidate_user_id=$1 and job_id=$2", [p.id, j])).toEqual([{ status: "pending", times_asked: 0 }]);
    expect(await one("select apply_clicks from job_daily_stat where job_id=$1 and day=current_date", [j])).toEqual([{ apply_clicks: 1 }]);
    await call(R.click, "POST", { jobId: j }, p); // a second click: still one open row, counted again
    await call(R.click, "POST", { jobId: j }, await login());
    expect((await one("select count(*)::int c from apply_click where job_id=$1", [j]))[0].c).toBe(2);
    expect(await one("select apply_clicks from job_daily_stat where job_id=$1 and day=current_date", [j])).toEqual([{ apply_clicks: 3 }]);
  });
  it("a click on a job that is closed, hidden, expired or never live is JOB_NOT_FOUND and counts nothing", async () => {
    const p = await login();
    const jobs = [await job("closed", { reason: "closed" }), await job("hidden"), await job("live", { closes: "now()-interval '1 day'" }), await job("in_review"), "999999999"];
    for (const j of jobs) expect(await call(R.click, "POST", { jobId: j }, p), j).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    expect((await one("select count(*)::int c from apply_click where candidate_user_id=$1", [p.id]))[0].c).toBe(0);
    expect((await one("select count(*)::int c from job_daily_stat where job_id=any($1::bigint[])", [jobs.filter((x) => x !== "999999999")]))[0].c).toBe(0);
  });
  it("the prompt read shows only this login's open clicks, asked under twice, within 14 days, and changes nothing", async () => {
    const a = await login(), b = await login();
    const [j1, j2, j3, j4] = [await job("live"), await job("live"), await job("live"), await job("live")];
    for (const j of [j1, j2, j3, j4]) await call(R.click, "POST", { jobId: j }, a);
    await call(R.click, "POST", { jobId: j1 }, b);
    await su.query("update apply_click set clicked_at = now() - interval '15 days' where candidate_user_id=$1 and job_id=$2", [a.id, j2]);
    await su.query("update apply_click set times_asked = 2 where candidate_user_id=$1 and job_id=$2", [a.id, j3]);
    const read = async (who: P) => ((await call(R.prompts, "GET", null, who)).json.prompts as { jobId: string; title: string }[]).map((x) => x.jobId);
    expect(await read(a)).toEqual([j4, j1]);
    expect(await read(a)).toEqual([j4, j1]); // a reload costs no ask
    expect(await read(b)).toEqual([j1]);
    expect((await one("select sum(times_asked)::int s from apply_click where candidate_user_id=$1", [a.id]))[0].s).toBe(2);
  });
  it("Yes writes the tracker row with origin did_you_apply_yes in the same transaction; the prompt is gone", async () => {
    const p = await login(), j = await job("live");
    await call(R.click, "POST", { jobId: j }, p);
    const clickId = ((await call(R.prompts, "GET", null, p)).json.prompts as { clickId: string }[])[0]!.clickId;
    expect((await call(R.prompts, "POST", { clickId, answer: "yes" }, p)).json).toEqual({ ok: true });
    expect(await one("select route, origin, stage from tracker_entry where candidate_user_id=$1 and job_id=$2", [p.id, j])).toEqual([{ route: "redirect", origin: "did_you_apply_yes", stage: "applied" }]);
    expect(await one("select status, times_asked from apply_click where id=$1", [clickId])).toEqual([{ status: "yes", times_asked: 1 }]);
    expect((await call(R.prompts, "GET", null, p)).json.prompts).toEqual([]);
    expect((await call(R.prompts, "POST", { clickId, answer: "yes" }, p)).code).toBe("CLICK_NOT_FOUND"); // answered once
  });
  it("Not yet asks once more, the second Not yet ends the asking, No writes no tracker row", async () => {
    const p = await login(), j = await job("live"), k = await job("live");
    await call(R.click, "POST", { jobId: j }, p);
    const id = async () => ((await call(R.prompts, "GET", null, p)).json.prompts as { clickId: string; jobId: string }[]).find((x) => x.jobId === j)?.clickId;
    const c1 = (await id())!;
    await call(R.prompts, "POST", { clickId: c1, answer: "not_yet" }, p);
    expect(await one("select status, times_asked from apply_click where id=$1", [c1])).toEqual([{ status: "not_yet", times_asked: 1 }]);
    expect(await id()).toBe(c1); // asked again
    await call(R.prompts, "POST", { clickId: c1, answer: "not_yet" }, p);
    expect(await one("select status, times_asked from apply_click where id=$1", [c1])).toEqual([{ status: "expired", times_asked: 2 }]);
    expect(await id()).toBeUndefined();
    await call(R.click, "POST", { jobId: k }, p);
    const c2 = ((await call(R.prompts, "GET", null, p)).json.prompts as { clickId: string }[])[0]!.clickId;
    await call(R.prompts, "POST", { clickId: c2, answer: "no" }, p);
    expect((await one("select count(*)::int c from tracker_entry where candidate_user_id=$1", [p.id]))[0].c).toBe(0);
    await call(R.click, "POST", { jobId: j }, p); // a new click after an expired row starts the asks again
    expect(await id()).toBeDefined();
  });
  it("another candidate cannot answer my click", async () => {
    const a = await login(), b = await login(), j = await job("live");
    await call(R.click, "POST", { jobId: j }, a);
    const clickId = ((await call(R.prompts, "GET", null, a)).json.prompts as { clickId: string }[])[0]!.clickId;
    expect(await call(R.prompts, "POST", { clickId, answer: "yes" }, b)).toMatchObject({ status: 404, code: "CLICK_NOT_FOUND" });
    expect(await one("select status from apply_click where id=$1", [clickId])).toEqual([{ status: "pending" }]);
    expect((await one("select count(*)::int c from tracker_entry where job_id=$1", [j]))[0].c).toBe(0);
  });
  it("a failure while writing the tracker row rolls the answer back", async () => {
    const p = await login(), j = await job("live");
    await call(R.click, "POST", { jobId: j }, p);
    const clickId = ((await call(R.prompts, "GET", null, p)).json.prompts as { clickId: string }[])[0]!.clickId;
    await su.query("update job set status='closed', close_reason='abandoned' where id=$1", [j]); // the tracker trigger now refuses this job
    expect(await call(R.prompts, "POST", { clickId, answer: "yes" }, p)).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    expect(await one("select status, times_asked from apply_click where id=$1", [clickId])).toEqual([{ status: "pending", times_asked: 0 }]);
  });
  it("Mark applied creates one redirect row, is repeatable, and closes the open prompt", async () => {
    const p = await login(), j = await job("live");
    await call(R.click, "POST", { jobId: j }, p);
    expect((await call(R.tracker, "POST", { jobId: j }, p)).json).toEqual({ ok: true, created: true });
    expect((await call(R.tracker, "POST", { jobId: j }, p)).json).toEqual({ ok: true, created: false });
    expect(await one("select route, origin, stage from tracker_entry where candidate_user_id=$1", [p.id])).toEqual([{ route: "redirect", origin: "mark_applied", stage: "applied" }]);
    expect((await call(R.prompts, "GET", null, p)).json.prompts).toEqual([]);
    for (const bad of [await job("in_review"), await job("closed", { reason: "abandoned" }), "999999999"])
      expect(await call(R.tracker, "POST", { jobId: bad }, p), bad).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
  });
  it("a stage change goes through the stages the database allows, and only on my own row", async () => {
    const a = await login(), b = await login(), j = await job("live");
    await call(R.tracker, "POST", { jobId: j }, a);
    expect((await call(R.tracker, "PUT", { jobId: j, stage: "interview" }, a)).json).toEqual({ ok: true, offerHint: false });
    expect((await call(R.tracker, "PUT", { jobId: j, stage: "offer" }, a)).json).toEqual({ ok: true, offerHint: true });
    expect(await call(R.tracker, "PUT", { jobId: j, stage: "hired" }, a)).toMatchObject({ status: 400, code: "BAD_REQUEST" }); // hired is an on-site stage
    expect(await call(R.tracker, "PUT", { jobId: j, stage: "interview" }, b)).toMatchObject({ status: 404, code: "NOT_TRACKED" });
    expect(await one("select stage from tracker_entry where candidate_user_id=$1", [a.id])).toEqual([{ stage: "offer" }]);
    // an on-site row (set by the employer's side) may only be withdrawn by the candidate
    const k = await job("live");
    await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1,$2,'on_site','on_site','shortlisted')", [a.id, k]);
    expect(await call(R.tracker, "PUT", { jobId: k, stage: "offer" }, a)).toMatchObject({ status: 403, code: "REFUSED" });
    expect((await call(R.tracker, "PUT", { jobId: k, stage: "withdrawn" }, a)).status).toBe(200);
  });
});

describe("one saved or tracked job, closed or not", () => {
  it("a closed job comes with up to 5 live jobs of the same occupation, newest first, full-quota last", async () => {
    const p = await login();
    const closed = await job("closed", { reason: "closed", occ: "2111" });
    const same: string[] = [];
    for (let i = 0; i < 6; i++) same.push(await job("live", { occ: "2111" }));
    const quota = await job("live", { occ: "2111", quota: true });
    await job("live", { occ: "2112" }); await job("live", { occ: "2111", sector: "health" }); await job("closed", { reason: "closed", occ: "2111" });
    await job("live", { occ: "2111", closes: "now()-interval '1 day'" });
    await call(R.saved, "POST", { jobId: closed }, p);
    const r = await call(R.job, "GET", null, { ...p, query: `?id=${closed}` });
    expect(r.status).toBe(200);
    expect(r.json.job).toMatchObject({ jobId: closed, live: false, saved: true, stage: null });
    expect(r.json.job).not.toHaveProperty("ownPageUrl");
    expect((r.json.similar as { jobId: string }[]).map((x) => x.jobId)).toEqual([same[5], same[4], same[3], same[2], same[1]]);
    expect(quota).not.toBe(r.json.similar[0].jobId);
  });
  it("with no live job of the same occupation it falls back to the same sector, and a tracked job counts too", async () => {
    const p = await login();
    const closed = await job("closed", { reason: "expired", occ: "2111", sector: "finance" });
    const s1 = await job("live", { occ: "2112", sector: "finance" }), s2 = await job("live", { occ: null, sector: "finance" });
    await job("live", { occ: "2112", sector: "it" });
    await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1,$2,'redirect','mark_applied','applied')", [p.id, closed]);
    const r = await call(R.job, "GET", null, { ...p, query: `?id=${closed}` });
    expect((r.json.similar as { jobId: string }[]).map((x) => x.jobId)).toEqual([s2, s1]);
    expect(r.json.job).toMatchObject({ saved: false, stage: "applied" });
    const none = await job("closed", { reason: "closed", occ: null, sector: "nowhere" });
    await call(R.saved, "POST", { jobId: none }, p);
    expect((await call(R.job, "GET", null, { ...p, query: `?id=${none}` })).json.similar).toEqual([]);
  });
  it("a live saved job comes back whole, with no similar list; a hidden one shows only the closed card", async () => {
    const p = await login(), live = await job("live", { occ: "2111" }), hidden = await job("hidden", { occ: "2111" });
    await call(R.saved, "POST", { jobId: live }, p); await call(R.saved, "POST", { jobId: hidden }, p);
    const l = await call(R.job, "GET", null, { ...p, query: `?id=${live}` });
    expect(l.json.job).toMatchObject({ live: true, ownPageUrl: "https://example.test/apply", salaryLow: 30000 });
    expect(l.json).not.toHaveProperty("similar");
    const h = await call(R.job, "GET", null, { ...p, query: `?id=${hidden}` });
    expect(h.json.job).toMatchObject({ live: false }); expect(h.json.job).not.toHaveProperty("salaryLow"); expect(h.json.job).not.toHaveProperty("ownPageUrl");
  });
  it("a job that is not mine, or any job when I have not saved or tracked it, is JOB_NOT_FOUND; a bad id is BAD_REQUEST", async () => {
    const a = await login(), b = await login(), j = await job("live"), c = await job("closed", { reason: "closed" });
    await call(R.saved, "POST", { jobId: c }, a);
    for (const id of [j, c]) expect(await call(R.job, "GET", null, { ...b, query: `?id=${id}` }), id).toMatchObject({ status: 404, code: "JOB_NOT_FOUND" });
    expect((await call(R.job, "GET", null, { ...a, query: `?id=${j}` })).status).toBe(404);
    for (const q of ["", "?id=", "?id=abc", "?id=1;drop", "?id=-5", "?id=99999999999999999999"]) expect((await call(R.job, "GET", null, { ...a, query: q })).code, q).toBe("BAD_REQUEST");
  });
});

describe("S19: the degree box pre-fill on the profile read", () => {
  it("relevant for an old degree, none without one, never stored", async () => {
    const a = await login(), b = await login();
    await call(R.profile, "PUT", { ...profile, hasRelevantDegree: true, degreeAwardedMonth: "2019-09-01" }, a);
    await call(R.profile, "PUT", { ...profile, hasRelevantDegree: false }, b);
    expect((await call(R.profile, "GET", null, a)).json.profile.degreeBox).toBe("relevant");
    expect((await call(R.profile, "GET", null, b)).json.profile.degreeBox).toBe("none");
    expect(await call(R.profile, "PUT", { ...profile, degreeBox: "relevant" }, a)).toMatchObject({ status: 400, code: "BAD_REQUEST" }); // derived, not writable
  });
});

describe("S20: why a saved or tracked job is not shown", () => {
  async function hiddenByReport(): Promise<string> {
    const j = await job("live");
    const r = (await su.query("insert into report(target_kind, target_job_id, reason, evidence_text) values ('job', $1, 'other', 'SECRET EVIDENCE') returning id", [j])).rows[0].id;
    await su.query("update job set status = 'hidden', hidden_reason = 'report', hidden_report_id = $2, search_vector = null where id = $1", [j, r]);
    return j;
  }
  it("each card says live (null), under review, hidden after a report, or no longer available; nothing of the report", async () => {
    const p = await login();
    const live = await job("live"), review = await job("live"), reported = await hiddenByReport(), staff = await job("hidden");
    const closed = await job("closed", { reason: "closed" }), expired = await job("live", { closes: "now() - interval '1 day'" });
    const orgHidden = await job("live");
    await su.query("update job set status = 'hidden', hidden_reason = 'organisation_suspended' where id = $1", [orgHidden]);
    const want: Record<string, string | null> = { [live]: null, [review]: "under_review", [reported]: "hidden_after_report", [staff]: "no_longer_available",
      [closed]: "no_longer_available", [expired]: "no_longer_available", [orgHidden]: "no_longer_available" };
    for (const j of Object.keys(want)) await call(R.saved, "POST", { jobId: j }, p);
    await su.query("update job set status = 'under_review' where id = $1", [review]); // saved while live, then the employer's review started
    const list = (await call(R.saved, "GET", null, p)).json.saved as { jobId: string; reason: string | null }[];
    expect(Object.fromEntries(list.map((x) => [x.jobId, x.reason]))).toEqual(want);
    for (const [j, reason] of Object.entries(want)) {
      const r = await call(R.job, "GET", null, { ...p, query: `?id=${j}` });
      expect(r.json.job.reason, j).toBe(reason);
    }
    const all = JSON.stringify(list) + JSON.stringify((await call(R.job, "GET", null, { ...p, query: `?id=${reported}` })).json);
    for (const leak of ["SECRET EVIDENCE", "hiddenReportId", "hidden_report_id", "hiddenReason", "organisation_suspended", '"admin"']) expect(all).not.toContain(leak);
  });
  it("a tracked (applied) job that was hidden after a report says so too", async () => {
    const p = await login(), j = await hiddenByReport();
    await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1,$2,'redirect','mark_applied','applied')", [p.id, j]);
    expect((await call(R.job, "GET", null, { ...p, query: `?id=${j}` })).json.job).toMatchObject({ live: false, reason: "hidden_after_report", stage: "applied" });
  });
  it("app_candidate reads the hidden reason code only, never the report id", async () => {
    await app.query("select hidden_reason from job limit 1");
    await expect(app.query("select hidden_report_id from job limit 1")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("notification settings", () => {
  it("start all on, switch one off, keep the account category on", async () => {
    const a = await login(), b = await login();
    expect((await call(R.notifications, "GET", null, a)).json).toEqual({ settings: { job_alerts: true, account: true } });
    expect((await call(R.notifications, "PUT", { job_alerts: false }, a)).json).toEqual({ settings: { job_alerts: false, account: true } });
    expect((await call(R.notifications, "PUT", { job_alerts: true, account: true }, a)).json.settings).toEqual({ job_alerts: true, account: true });
    expect((await call(R.notifications, "GET", null, b)).json.settings).toEqual({ job_alerts: true, account: true });
    // #260: the dropped switch is refused by the route and by the database
    expect(await call(R.notifications, "PUT", { apply_reminders: false }, a)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await call(R.notifications, "PUT", { job_alerts: false, apply_reminders: true }, a)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    await expect(su.query("insert into notification_preference(candidate_user_id, category, channel, enabled) values ($1, 'apply_reminders', 'email', false)", [a.id])).rejects.toMatchObject({ code: "23514" });
    expect(await call(R.notifications, "PUT", { account: false }, a)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await call(R.notifications, "PUT", { marketing: true }, a)).toMatchObject({ status: 400 });
    expect(await one("select category, channel, enabled from notification_preference where candidate_user_id=$1 order by category", [a.id])).toEqual([
      { category: "account", channel: "email", enabled: true }, { category: "job_alerts", channel: "email", enabled: true }]);
  });
  it("the database refuses a free-text category or the account category off, for a candidate only", async () => {
    const a = await login();
    const ins = (c: string, e: boolean) => su.query("insert into notification_preference(candidate_user_id, category, channel, enabled) values ($1,$2,'email',$3)", [a.id, c, e]);
    await expect(ins("marketing", true)).rejects.toMatchObject({ code: "23514" });
    await expect(ins("account", false)).rejects.toMatchObject({ code: "23514" });
    await expect(app.query("insert into candidate_notification_preference(candidate_user_id, category, channel, enabled) values ($1,'account','in_app',false)", [a.id])).rejects.toMatchObject({ code: "23514" });
    await ins("account", true);
    await expect(su.query("update notification_preference set enabled=false where candidate_user_id=$1", [a.id])).rejects.toMatchObject({ code: "23514" });
    const staff = (await su.query("insert into staff_user(id,name,email,email_verified) values($1,'S',$2,true) returning id", [uid("s"), `${uid("s")}@example.test`])).rows[0].id;
    await su.query("insert into notification_preference(staff_user_id, category, channel, enabled) values ($1,'anything','email',false)", [staff]); // other sides keep free text
  });
});

describe("delete account", () => {
  it("is final at once: deleted_at set, every session gone, one confirmation email queued with the address, nothing else touched", async () => {
    const a = await login(), b = await login(), j = await job("live");
    await call(R.saved, "POST", { jobId: j }, a); await call(R.saved, "POST", { jobId: j }, b);
    const second = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: a.h, body: JSON.stringify({ email: a.email, password: a.password }) }));
    const cookie2 = second.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await one("select count(*)::int c from candidate_session where user_id=$1", [a.id]))[0].c).toBe(2);
    expect(await call(R.account, "DELETE", {}, a)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await call(R.account, "DELETE", { confirm: true, id: b.id }, a)).toMatchObject({ status: 400 });
    expect((await one("select deleted_at from candidate_user where id=$1", [a.id]))[0].deleted_at).toBeNull();
    expect((await call(R.account, "DELETE", { confirm: true }, a)).json).toEqual({ ok: true });
    expect((await one("select deleted_at is not null d from candidate_user where id=$1", [a.id]))[0].d).toBe(true);
    expect((await one("select count(*)::int c from candidate_session where user_id=$1", [a.id]))[0].c).toBe(0);
    for (const cookie of [a.cookie, cookie2]) expect(await call(R.profile, "GET", null, { cookie })).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: a.h, body: JSON.stringify({ email: a.email, password: a.password }) }))).status).not.toBe(200);
    expect(await one("select template, status, params, candidate_user_id from email_outbox where candidate_user_id=$1", [a.id])).toEqual([
      { template: "account_deleted", status: "pending", params: { email: a.email }, candidate_user_id: a.id }]);
    // the other candidate: still signed in, rows intact
    expect((await call(R.saved, "GET", null, b)).json.saved).toHaveLength(1);
    expect((await one("select deleted_at from candidate_user where id=$1", [b.id]))[0].deleted_at).toBeNull();
    expect((await one("select count(*)::int c from email_outbox where candidate_user_id=$1", [b.id]))[0].c).toBe(0);
  });
});

describe("security: every route", () => {
  const every: [string, Route, keyof Route, unknown, string][] = [
    ["profile GET", () => R.profile, "GET", null, ""], ["profile PUT", () => R.profile, "PUT", profile, ""],
    ["saved GET", () => R.saved, "GET", null, ""], ["saved POST", () => R.saved, "POST", { jobId: "1" }, ""], ["saved DELETE", () => R.saved, "DELETE", { jobId: "1" }, ""],
    ["click POST", () => R.click, "POST", { jobId: "1" }, ""], ["prompts GET", () => R.prompts, "GET", null, ""], ["answer POST", () => R.prompts, "POST", { clickId: "1", answer: "yes" }, ""],
    ["tracker POST", () => R.tracker, "POST", { jobId: "1" }, ""], ["tracker PUT", () => R.tracker, "PUT", { jobId: "1", stage: "offer" }, ""],
    ["job GET", () => R.job, "GET", null, "?id=1"], ["notifications GET", () => R.notifications, "GET", null, ""], ["notifications PUT", () => R.notifications, "PUT", { job_alerts: false }, ""],
    ["account DELETE", () => R.account, "DELETE", { confirm: true }, ""],
  ].map(([name, route, method, body, query]) => [name as string, (route as () => Route)(), method as keyof Route, body, query as string]);
  const routes = () => every.map(([name, , method, body, query]) => ({ name, method, body, query, route: R[({ profile: "profile", saved: "saved", click: "click", prompts: "prompts", answer: "prompts", tracker: "tracker", job: "job", notifications: "notifications", account: "account" } as Record<string, keyof typeof R>)[name.split(" ")[0]!]!] }));

  it("no session, a junk cookie, a suspended and a deleted candidate are all refused on every route", async () => {
    const s = await login(true), d = await login();
    await su.query("update candidate_user set deleted_at=now() where id=$1", [d.id]);
    for (const r of routes()) {
      expect(await call(r.route, r.method, r.body, { query: r.query }), `${r.name} none`).toMatchObject({ status: 401, code: "NO_SESSION" });
      expect((await call(r.route, r.method, r.body, { cookie: "better-auth.session_token=junk", query: r.query })).status, `${r.name} junk`).toBe(401);
      expect((await call(r.route, r.method, r.body, { ...s, query: r.query })).status, `${r.name} suspended`).toBe(403);
      expect((await call(r.route, r.method, r.body, { ...d, query: r.query })).status, `${r.name} deleted`).toBeOneOf([401, 403]);
    }
    expect(await one("select count(*)::int c from candidate_profile where candidate_user_id = any($1)", [[s.id, d.id]])).toEqual([{ c: 0 }]);
  });
  it("every write refuses a foreign or missing Origin, an oversized body, bad JSON, unknown fields and control characters, and writes nothing", async () => {
    const p = await login(), j = await job("live");
    const writes = routes().filter((r) => r.method !== "GET" && r.name !== "account DELETE").map((r) => ({ ...r, body: JSON.parse(JSON.stringify(r.body).replace('"1"', `"${j}"`)) }));
    for (const r of writes) {
      expect((await call(r.route, r.method, r.body, { ...p, origin: "https://evil.example" })).code, `${r.name} origin`).toBe("BAD_ORIGIN");
      expect((await call(r.route, r.method, r.body, { ...p, origin: null })).code, `${r.name} no origin`).toBe("BAD_ORIGIN");
      expect((await call(r.route, r.method, r.body, { ...p, raw: JSON.stringify({ ...r.body, pad: "x".repeat(3000) }) })).code, `${r.name} big`).toBe("BODY_TOO_LARGE");
      expect((await call(r.route, r.method, r.body, { ...p, headers: { "content-length": "999999" } })).code, `${r.name} length`).toBe("BODY_TOO_LARGE");
      for (const raw of ["not json", "[]", "null", "5", JSON.stringify({ ...r.body, userId: "other", candidate_user_id: "other" }), JSON.stringify({ ...r.body, __proto__: { x: 1 } }).replace('{"', '{"__proto__":{"x":1},"')])
        expect((await call(r.route, r.method, r.body, { ...p, raw })).code, `${r.name} ${raw}`).toBe("BAD_REQUEST");
    }
    const bad = await call(R.profile, "PUT", { fullName: "a\u0000b" }, p);
    expect([bad.status, (await call(R.profile, "PUT", { fullName: "a‮b" }, p)).status]).toEqual([400, 400]);
    expect((await one("select count(*)::int c from candidate_profile where candidate_user_id=$1", [p.id]))[0].c).toBe(0);
    expect((await one("select count(*)::int c from saved_job where candidate_user_id=$1", [p.id]))[0].c).toBe(0);
    expect((await one("select count(*)::int c from tracker_entry where candidate_user_id=$1", [p.id]))[0].c).toBe(0);
  });
  it("a body or query that carries SQL is only data", async () => {
    const p = await login();
    const evil = "1'; delete from saved_job; --";
    expect((await call(R.saved, "POST", { jobId: evil }, p)).status).toBe(400);
    expect((await call(R.job, "GET", null, { ...p, query: `?id=${encodeURIComponent(evil)}` })).status).toBe(400);
    expect((await call(R.profile, "PUT", { fullName: "Robert'); drop table candidate_profile;--" }, p)).status).toBe(200);
    expect((await call(R.profile, "GET", null, p)).json.profile.fullName).toBe("Robert'); drop table candidate_profile;--");
  });
  it("writes trip the rate limit at 60 in ten minutes, per login", async () => {
    const p = await login(), q = await login();
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await call(R.notifications, "PUT", { job_alerts: i % 2 === 0 }, p)).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
    expect((await call(R.notifications, "PUT", { job_alerts: false }, q)).status).toBe(200); // another login has its own count
    expect((await call(R.notifications, "GET", null, p)).status).toBe(200); // reads are not limited
  });
});

describe("security: what the candidate role itself can do", () => {
  it("cannot move a tracker row or a click onto a job that never went live, or save more than 200 around the route", async () => {
    const p = await login(), live = await job("live"), draft = await job("draft");
    await call(R.tracker, "POST", { jobId: live }, p);
    await call(R.click, "POST", { jobId: live }, p);
    await expect(app.query("update tracker_entry set job_id=$2 where candidate_user_id=$1", [p.id, draft])).rejects.toMatchObject({ code: "P0001" });
    await expect(app.query("update apply_click set job_id=$2 where candidate_user_id=$1", [p.id, draft])).rejects.toMatchObject({ code: "P0001" });
    await expect(app.query("insert into saved_job(candidate_user_id, job_id) values ($1,$2)", [p.id, draft])).rejects.toMatchObject({ code: "P0001" });
  });
  it("cannot read close_reason, set visibility, or read another side's rows", async () => {
    await expect(app.query("select close_reason from job limit 1")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("update candidate_profile set visible_to_employers=true")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("select * from portal_user limit 1")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("performance: the hot calls", () => {
  async function measure(name: keyof typeof BUDGET, make: () => Promise<() => Promise<{ status: number }>>) {
    const times: number[] = []; let statements = 0;
    for (let i = 0; i < 9; i++) {
      const go = await make();
      const t = performance.now();
      const [r, c] = await counted(go);
      times.push(performance.now() - t);
      expect(r.status).toBe(200);
      statements = Math.max(statements, c);
    }
    const median = [...times].sort((a, b) => a - b)[4]!;
    console.log(`candidate-account ${name}: ${statements} statements, median ${median.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET[name].statements);
    expect(median).toBeLessThan(BUDGET[name].medianMs);
  }
  it("profile PUT, save, click, answer, prompts and the closed-job read stay inside their budgets", async () => {
    const p = await login();
    await measure("profilePut", async () => () => call(R.profile, "PUT", { ...profile, currentStamp: "4" }, p));
    await measure("save", async () => { const j = await job("live"); return () => call(R.saved, "POST", { jobId: j }, p); });
    await measure("click", async () => { const j = await job("live"); return () => call(R.click, "POST", { jobId: j }, p); });
    await measure("answer", async () => {
      const j = await job("live");
      await call(R.click, "POST", { jobId: j }, p);
      const clickId = ((await call(R.prompts, "GET", null, p)).json.prompts as { clickId: string; jobId: string }[]).find((x) => x.jobId === j)!.clickId;
      return () => call(R.prompts, "POST", { clickId, answer: "yes" }, p);
    });
    await measure("prompts", async () => () => call(R.prompts, "GET", null, p));
    // the closed-job read in a busy sector: 3,000 live jobs of one sector, none of the closed job's occupation
    const src = (await su.query("insert into job_source(kind,board) values ('portal',$1) returning id", [uid("b")])).rows[0].id;
    await su.query(
      `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,occupation_code,permit_type,status,closes_at,own_page_url,search_vector,salary_low,pay_grade,posted_at)
       select $1,'admin_manual',$2,'Busy '||g,'Fake Org','busy','2112','critical_skills','live',now()+interval '20 days','https://example.test/a',to_tsvector('english','cook'),30000,'g1',now()-g*interval '1 minute' from generate_series(1,3000) g`, [org, src]);
    await su.query("analyze job");
    // pages the two similar-jobs queries touch (planning + execution + serialisation), worst case: no live job of the occupation, so both run
    const client = await su.connect();
    try {
      const costs = await measurePages(client, [{ text: similarSql(true), values: ["busy", "1", "2111"] }, { text: similarSql(false), values: ["busy", "1"] }]);
      console.log(`candidate-account similar: ${costs.map((c) => `${c.pages} pages ${c.ms} ms ${c.scans}`).join(" | ")}`);
      expect(costs.reduce((a, c) => a + c.pages, 0)).toBeLessThanOrEqual(PAGE_BUDGET);
    } finally { client.release(); }
    await measure("closedRead", async () => {
      const j = await job("closed", { reason: "closed", occ: "2111", sector: "busy" });
      await call(R.saved, "POST", { jobId: j }, p);
      return () => call(R.job, "GET", null, { ...p, query: `?id=${j}` });
    });
  });
});
