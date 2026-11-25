// Step 9 part 12a, end to end on the test database through the real /api/portal/jobs handlers, connected as app_portal, with real portal
// sessions (sign-up, confirm and sign-in through the real auth route). No test calls the real network. Fake people and companies only.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approveAccount, claimReview } from "../src/account-review";
import { CLOSE_UNDER_REVIEW } from "../src/job-expiry-cli";
import { WRC_LAPSE } from "../src/wrc-import";
import { savePostingTexts } from "../src/posting-texts-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

// Statements counted on every pg.Client.query call, measured on 12 November 2026: a live post 9 (requirePortal 3, rate count 1, begin, the
// company, the job, its text, commit), with a statement 12 (the text, supersede, the statement); the list 4 (requirePortal 3, the function).
// A renewal 8 (18 November 2026, P14: requirePortal 3, rate count 1, begin, the locked job with its text, the update, commit; the rules are cached), median 3 ms.
// An edit 10 (requirePortal 3, rate count 1, begin, the locked job with its advert text, the company, the update, the text, commit), the same with the
// 0045 fix check (18 November 2026).
// Times, median of 9 calls, measured warm: post 5 to 8 ms, list of 60 jobs 3 to 5 ms. Budgets are about 4 times that, with a floor for a busy laptop.
// Post, signed, renew and edit are each one more since B66 (25 November 2026): the rules are read fresh, never from the cache, because the answer is saved.
const BUDGET = { post: 10, signed: 13, list: 4, renew: 9, edit: 11, postMs: 40, listMs: 25, renewMs: 40 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, listGET: Handler, postPOST: Handler, editPOST: Handler, renewPOST: Handler, closePOST: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: listGET, POST: postPOST } = await import("../../../apps/portal/app/api/portal/jobs/route"));
  ({ POST: editPOST } = await import("../../../apps/portal/app/api/portal/jobs/edit/route"));
  ({ POST: renewPOST } = await import("../../../apps/portal/app/api/portal/jobs/renew/route"));
  ({ POST: closePOST } = await import("../../../apps/portal/app/api/portal/jobs/close/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit where key like 'jobs:%'"); });

let ipn = 0;
const freshIp = () => `10.9.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
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
async function call(h: Handler, path: string, cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return reply(await h(new Request(`${BASE}/api/portal/jobs${path}`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers })));
}
const post = (cookie: string | undefined, body: unknown, o = {}) => call(postPOST, "", cookie, body, o);
const edit = (cookie: string | undefined, body: unknown) => call(editPOST, "/edit", cookie, body);
const renew = (cookie: string | undefined, body: unknown) => call(renewPOST, "/renew", cookie, body);
const close = (cookie: string | undefined, body: unknown) => call(closePOST, "/close", cookie, body);
const list = async (cookie?: string) => reply(await listGET(new Request(`${BASE}/api/portal/jobs`, { headers: cookie ? { cookie } : {} })));
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const job = (id: number) => one("select j.*, t.advert_text from job j left join job_text t on t.job_id = j.id where j.id = $1", [id]);
const statements = (id: number) => su.query("select kind, signer_membership_id, signer_name, on_behalf_of_name, written_authority_on_file, superseded_at from sponsorship_statement where job_id = $1 order by id", [id]).then((r) => r.rows);
const jobCount = async (org: string) => Number((await one("select count(*) n from job where organisation_id = $1", [org])).n);

let n = 0;
type Login = { email: string; cookie: string; id: string };
async function login(): Promise<Login> {
  const p = { email: `fake.j${++n}@elsewhere.example.test`, password: `Fake-j${n}-password-1`, name: `Fake J${n}`, ...portalAnswers };
  expect((await authCall("sign-up/email", p)).status).toBe(200);
  await click(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link);
  const r = await authCall("sign-in/email", { email: p.email, password: p.password });
  expect(r.status, r.text).toBe(200);
  return { email: p.email, cookie: r.cookie, id: (await one("select id from portal_user where email=$1", [p.email])).id };
}
type Member = Login & { mem: string };
type Company = { org: string; owner: Member; recruiter: Member; poster: Member; viewer: Member };
async function company(o: { status?: string; kind?: string; name?: string } = {}): Promise<Company> {
  const org = String(await F.org({ status: o.status ?? "verified", kind: o.kind, name: o.name ?? "Fake Payments Limited", wrc: o.kind === "agency" ? `EA${++n}` : null }));
  const m = async (role: string, signer: boolean) => { const l = await login(); return { ...l, mem: String(await F.member(org, l.id, { role, signer })) }; };
  return { org, owner: await m("account_owner", true), recruiter: await m("recruiter", true), poster: await m("poster", false), viewer: await m("viewer", false) };
}
const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const good = { status: "live", title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractType: "permanent",
  salaryLow: 50000, salaryHigh: 60000, ownPageUrl: "https://careers.example.ie/jobs/1" };
const signed = { signerName: "Fake Signer", signerTitle: "HR Director" };
let texts = false;
const seedTexts = async () => { if (texts) return; const c = await db.pool("app_admin").connect(); try { await savePostingTexts(c); texts = true; } finally { c.release(); } };

describe("POST /api/portal/jobs", () => {
  it("posts a live job with the rules' route, its text, its search vector and 30 days", async () => {
    const c = await company();
    const r = await post(c.owner.cookie, good);
    expect([r.status, r.json]).toMatchObject([200, { status: "live", badge: null, passRoute: "stated_pay" }]);
    const j = await job(r.json!.jobId);
    expect(j).toMatchObject({ organisation_id: String(c.org), source: "employer", title: "Software Engineer", employer_name: "Fake Payments Limited", county: "Dublin",
      sector: "IT", occupation_code: "2136", permit_type: "critical_skills", weekly_hours: 39, posted_by_membership_id: String(c.owner.mem), advert_text: desc,
      application_route: "own_page", own_page_url: good.ownPageUrl, permit_employer_kind: "self" });
    expect(j.search_vector).toMatch(/payment/);
    const days = (new Date(j.closes_at).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    // no statement text saved yet (this test runs first): no badge, and nothing written
    const t = await post(c.owner.cookie, { ...good, statement: signed });
    expect([t.status, t.json]).toEqual([409, { code: "NO_STATEMENT_TEXT" }]);
    expect(await jobCount(c.org)).toBe(1);
  });
  it("a poster and a recruiter post too; a viewer, a login with no company, a removed member and a blocked login are refused", async () => {
    const c = await company();
    for (const m of [c.poster, c.recruiter]) expect((await post(m.cookie, good)).status).toBe(200);
    const before = await jobCount(c.org);
    expect((await post(c.viewer.cookie, good)).json).toEqual({ code: "NOT_A_POSTER" });
    const lone = await login();
    expect((await post(lone.cookie, good)).json).toEqual({ code: "NOT_A_MEMBER" });
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [c.poster.mem]);
    expect((await post(c.poster.cookie, good)).json).toEqual({ code: "NOT_A_MEMBER" });
    await db.query("app_admin", "update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='fake' where id=$1", [c.recruiter.id]);
    const b = await post(c.recruiter.cookie, good);
    expect([b.status, b.json]).toEqual([403, { code: "REFUSED" }]);
    expect((await post(undefined, good)).status).toBe(401);
    expect(await jobCount(c.org)).toBe(before);
  });
  it("refuses what the rules refuse, with nothing written", async () => {
    const c = await company();
    const cases: [object, string][] = [
      [{ salaryLow: 40000, salaryHigh: null }, "PAY_BELOW_MINIMUM"], [{ salaryLow: 41953, salaryHigh: null, weeklyHours: 40 }, "PAY_BELOW_MINIMUM"],
      [{ occupationCode: "4112" }, "OCCUPATION_INELIGIBLE"], [{ occupationCode: "3545" }, "PAY_BELOW_MINIMUM"],
      [{ contractType: "fixed_term", contractMonths: 12 }, "CONTRACT_TOO_SHORT"], [{ description: desc + " We cannot offer visa sponsorship." }, "RULES_FAILED"],
      [{ salaryLow: null, salaryHigh: null, payGrade: "Grade VI" }, "PAY_REQUIRED"],
    ];
    for (const [o, code] of cases) {
      const r = await post(c.owner.cookie, { ...good, ...o });
      expect([r.status, r.json?.code], JSON.stringify(o)).toEqual([422, code]);
    }
    expect(await jobCount(c.org)).toBe(0);
    for (const o of [{ salaryLow: 41954, salaryHigh: null, weeklyHours: 40 }, { salaryLow: 40904, salaryHigh: null }, { occupationCode: "3545", salaryLow: 68911, salaryHigh: null }])
      expect((await post(c.owner.cookie, { ...good, ...o })).status, JSON.stringify(o)).toBe(200);
    const h = await post(c.owner.cookie, { ...good, salaryLow: 41954, salaryHigh: null, weeklyHours: 40 });
    expect((await job(h.json!.jobId)).weekly_hours).toBe(40);
  });
  it("refuses a four-digit code that is not SOC 2010, with nothing written", async () => {
    const c = await company();
    for (const occupationCode of ["9999", "0000", "1110", "2136; drop table job", 2136]) {
      const r = await post(c.owner.cookie, { ...good, occupationCode });
      expect([r.status, r.json?.code], String(occupationCode)).toEqual([400, "BAD_REQUEST"]);
    }
    expect(await jobCount(c.org)).toBe(0);
    expect((await post(c.owner.cookie, { ...good, occupationCode: "3545", salaryLow: 68911, salaryHigh: null })).status).toBe(200); // a SOC code on neither list still posts
  });
  it("scam wording and an unverified or restricted company: review, not live (#44)", async () => {
    const c = await company();
    const s = await post(c.owner.cookie, { ...good, description: desc + " Candidates must pay a registration fee before the interview." });
    expect(s.json!.status).toBe("in_review");
    expect(await one("select queue from review_item where job_id = $1", [s.json!.jobId])).toEqual({ queue: "scam_flag" });
    const pending = await company({ status: "pending_review" });
    expect((await post(pending.owner.cookie, good)).json).toEqual({ code: "COMPANY_NOT_ACTIVE" });
    expect((await post(pending.owner.cookie, { ...good, status: "draft" })).json).toMatchObject({ status: "draft", passRoute: null });
    const r = await company();
    const k = await su.connect();
    try {
      await k.query("begin");
      await k.query("set local session_replication_role = replica");
      await k.query("update organisation set restricted_until = now() + interval '30 days' where id=$1", [r.org]);
      await k.query("commit");
    } finally { k.release(); }
    expect((await post(r.owner.cookie, good)).json).toMatchObject({ status: "in_review" });
    await seedTexts();
    expect((await post(r.owner.cookie, { ...good, statement: signed })).json).toEqual({ code: "BADGE_RESTRICTED" });
  });
  it("the badge only with a signed statement: the signer switch decides", async () => {
    await seedTexts();
    const c = await company();
    const ok = await post(c.recruiter.cookie, { ...good, statement: signed });
    expect(ok.json).toMatchObject({ status: "live", badge: "sponsor_confirmed" });
    expect(await statements(ok.json!.jobId)).toEqual([{ kind: "own_company", signer_membership_id: String(c.recruiter.mem), signer_name: "Fake Signer", on_behalf_of_name: null, written_authority_on_file: false, superseded_at: null }]);
    const before = await jobCount(c.org);
    expect((await post(c.poster.cookie, { ...good, statement: signed })).json).toEqual({ code: "NOT_A_SIGNER" }); // a poster without the switch
    expect(await jobCount(c.org)).toBe(before); // the job went with the refused statement
  });
  it("P9 (#278): an agency the WRC import paused cannot publish; its live job stays live and listed without register content; staff clearing it lets it publish", async () => {
    const a = await company({ kind: "agency", name: "Fake Lapsed Recruitment Limited" });
    const live = await post(a.owner.cookie, good);
    expect(live.json!.status).toBe("live");
    const wrc = (await one("select wrc_licence_number w from organisation where id = $1", [a.org])).w;
    expect((await db.pool("app_admin").query(WRC_LAPSE, [[wrc], "2026-11-19"])).rows[0]).toEqual({ paused: 1, jobs: 1 });
    const before = await jobCount(a.org);
    expect([(await post(a.owner.cookie, good)).status, (await post(a.recruiter.cookie, good)).json]).toEqual([403, { code: "COMPANY_NOT_ACTIVE" }]);
    expect(await jobCount(a.org)).toBe(before);
    const mine = await list(a.owner.cookie);
    expect(mine.json!.jobs.find((x: { id: string }) => x.id === live.json!.jobId)).toMatchObject({ status: "live" });
    expect(mine.text).not.toMatch(/licence|wrc|register/i);
    const staff = String((await one("insert into staff_user(id,name,email,email_verified,created_at,updated_at) values ('s-p9-jobs','Fake Staff','s-p9@example.test',true,now(),now()) returning id")).id);
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'account_reviewer', true)", [staff]);
    const item = (await one("select id::text from review_item where queue = 'account_review' and organisation_id = $1 and status = 'open'", [a.org])).id;
    await claimReview(db.pool("app_admin"), staff, item);
    await approveAccount(db.pool("app_admin"), staff, item);
    expect((await post(a.owner.cookie, good)).json!.status).toBe("live");
  });
  it("an agency posts for a client with written authority; an employer cannot name a client", async () => {
    await seedTexts();
    const a = await company({ kind: "agency", name: "Fake Recruitment Limited" });
    const no = await post(a.owner.cookie, { ...good, clientName: "Fake Payments Limited", statement: signed });
    expect([no.status, no.json]).toEqual([400, { code: "WRITTEN_AUTHORITY_REQUIRED" }]);
    const r = await post(a.owner.cookie, { ...good, clientName: "Fake Payments Limited", statement: { ...signed, writtenAuthority: true } });
    // 0028 (#244 a): the client is not in the DETE names, so the job is held for staff with one agency_client_check item, never live first
    expect(r.json).toMatchObject({ status: "in_review", badge: "sponsor_confirmed" });
    expect(await job(r.json!.jobId)).toMatchObject({ source: "agency", permit_employer_kind: "client", permit_employer_name: "Fake Payments Limited", permit_employer_check: "not_found" });
    expect((await su.query("select queue from review_item where job_id = $1", [r.json!.jobId])).rows).toEqual([{ queue: "agency_client_check" }]);
    expect((await list(a.owner.cookie)).json!.jobs.find((x: { id: number }) => x.id === r.json!.jobId)).toMatchObject({ status: "in_review", reason: "staff_check", clientCheck: true });
    // a client found in the DETE names goes live with no item; editing that live job to name a client that is not found is refused, the job unchanged
    await su.query("insert into organisation_name(name, normalised_name, kind, source) values ('Fake Known Client Limited', 'fake known client limited', 'alias', 'dete')");
    const auth = { ...signed, writtenAuthority: true };
    const found = await post(a.owner.cookie, { ...good, clientName: "Fake Known Client Limited", statement: auth });
    expect(found.json).toMatchObject({ status: "live" });
    expect((await su.query("select count(*)::int n from review_item where job_id = $1", [found.json!.jobId])).rows[0].n).toBe(0);
    const moved = await edit(a.owner.cookie, { ...good, jobId: found.json!.jobId, clientName: "Fake Payments Limited", statement: auth });
    expect([moved.status, moved.json]).toEqual([409, { code: "NEEDS_REVIEW" }]);
    expect(await job(found.json!.jobId)).toMatchObject({ status: "live", permit_employer_name: "Fake Known Client Limited", permit_employer_check: "found" });
    expect((await statements(r.json!.jobId))[0]).toMatchObject({ kind: "on_behalf_of_client", on_behalf_of_name: "Fake Payments Limited", written_authority_on_file: true });
    const e = await company();
    expect((await post(e.owner.cookie, { ...good, clientName: "Someone Else" })).json).toEqual({ code: "CLIENT_ONLY_FOR_AGENCIES" });
  });
  it("stores SQL-looking text verbatim", async () => {
    const c = await company(), t = "Engineer'); drop table job; --";
    const r = await post(c.owner.cookie, { ...good, title: t });
    expect((await job(r.json!.jobId)).title).toBe(t);
  });
});

describe("edit, renew, close", () => {
  it("a draft is saved with no checks and goes live through the rules", async () => {
    const c = await company();
    const d = await post(c.owner.cookie, { ...good, status: "draft", salaryLow: 30000, salaryHigh: null });
    expect(d.json).toMatchObject({ status: "draft", passRoute: null });
    const bad = await edit(c.owner.cookie, { ...good, salaryLow: 30000, salaryHigh: null, jobId: d.json!.jobId });
    expect([bad.status, bad.json]).toEqual([422, { code: "PAY_BELOW_MINIMUM" }]);
    expect((await job(d.json!.jobId)).status).toBe("draft");
    const ok = await edit(c.owner.cookie, { ...good, jobId: d.json!.jobId });
    expect(ok.json).toMatchObject({ status: "live", passRoute: "stated_pay" });
  });
  it("#226: pay, title or occupation needs a fresh statement on a badged job; other edits do not", async () => {
    await seedTexts();
    const c = await company();
    const id = (await post(c.owner.cookie, { ...good, statement: signed })).json!.jobId;
    const other = await edit(c.poster.cookie, { ...good, jobId: id, description: desc + " Hybrid working.", county: "Cork" });
    expect(other.json).toMatchObject({ status: "live", badge: "sponsor_confirmed" });
    expect(await job(id)).toMatchObject({ county: "Cork", posted_by_membership_id: String(c.poster.mem) });
    expect(await statements(id)).toHaveLength(1);
    for (const o of [{ salaryLow: 55000 }, { title: "Senior Software Engineer" }, { occupationCode: "2135" }, { weeklyHours: 40 }]) {
      const r = await edit(c.owner.cookie, { ...good, county: "Cork", jobId: id, ...o });
      expect([r.status, r.json], JSON.stringify(o)).toEqual([422, { code: "STATEMENT_REQUIRED" }]); // the same status as the rule refusal
    }
    const low = await edit(c.owner.cookie, { ...good, jobId: id, salaryLow: 30000, salaryHigh: null, statement: signed });
    expect(low.json).toEqual({ code: "PAY_BELOW_MINIMUM" });
    const re = await edit(c.owner.cookie, { ...good, jobId: id, salaryLow: 55000, statement: signed });
    expect(re.json).toMatchObject({ status: "live", badge: "sponsor_confirmed" });
    const s = await statements(id);
    expect(s).toHaveLength(2);
    expect(s[0].superseded_at).not.toBeNull();
    expect(s[1].superseded_at).toBeNull();
    expect((await job(id)).salary_low).toBe(55000);
  });
  it("#93: a job under review goes live again when an edit raises the pay past the minimum; any other edit leaves it under review", async () => {
    const c = await company();
    const id = (await post(c.owner.cookie, good)).json!.jobId;
    await su.query("update job set status = 'under_review' where id = $1", [id]); // what the rules run does on the day the minimums rise
    const title = await edit(c.owner.cookie, { ...good, jobId: id, title: "Senior Software Engineer" });
    expect([title.status, title.json?.status]).toEqual([200, "under_review"]);
    expect((await edit(c.owner.cookie, { ...good, jobId: id, salaryLow: 30000, salaryHigh: null })).json).toEqual({ code: "PAY_BELOW_MINIMUM" });
    const raised = await edit(c.owner.cookie, { ...good, jobId: id, title: "Senior Software Engineer", salaryLow: 55000 });
    expect([raised.status, raised.json?.status]).toEqual([200, "live"]);
    expect(await job(id)).toMatchObject({ status: "live", under_review_since: null, salary_low: 55000 });
  });
  it("another company's job is not found; closed and hidden jobs are not edited", async () => {
    const c = await company(), other = await company();
    const id = (await post(c.owner.cookie, good)).json!.jobId;
    for (const r of [await edit(other.owner.cookie, { ...good, jobId: id, title: "Taken" }), await renew(other.owner.cookie, { jobId: id }), await close(other.owner.cookie, { jobId: id, hireAnswer: "no" })])
      expect([r.status, r.json]).toEqual([404, { code: "JOB_NOT_FOUND" }]);
    expect(await job(id)).toMatchObject({ title: "Software Engineer", status: "live" });
    expect((await edit(c.viewer.cookie, { ...good, jobId: id })).json).toEqual({ code: "NOT_A_POSTER" });
    expect((await close(c.viewer.cookie, { jobId: id, hireAnswer: "no" })).json).toEqual({ code: "NOT_A_POSTER" });
    const fetchedSrc = (await one("insert into job_source(kind, board) values ('board', 'jobs-route') returning id")).id;
    const fetched = (await one(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, badge, search_vector)
      values ($1, 'fetched', $2, 't', 'e', 'IT', 'critical_skills', 'live', 'infinity', 'https://x.example', 'critical_skills_eligible', 'x') returning id`, [c.org, fetchedSrc])).id;
    expect((await edit(c.owner.cookie, { ...good, jobId: String(fetched) })).json).toEqual({ code: "JOB_NOT_FOUND" }); // a fetched job of the company is not its post
    await su.query("update job set status = 'hidden', hidden_reason = 'admin' where id = $1", [id]);
    expect((await edit(c.owner.cookie, { ...good, jobId: id })).json).toEqual({ code: "BAD_STATE" });
  });
  it("renews a live job for 30 days from now, closes with the hire answer, and a closed job stays closed", async () => {
    const c = await company();
    const id = (await post(c.owner.cookie, good)).json!.jobId;
    await su.query("update job set closes_at = now() + interval '2 days' where id = $1", [id]);
    const r = await renew(c.poster.cookie, { jobId: id });
    expect(r.status).toBe(200);
    expect((new Date((await job(id)).closes_at).getTime() - Date.now()) / 864e5).toBeGreaterThan(29.9);
    expect((await renew(c.poster.cookie, { jobId: id, hireAnswer: "no" })).status).toBe(200);
    expect(await job(id)).toMatchObject({ hire_answer: "no", hire_answered_by_membership_id: String(c.poster.mem) });
    expect((await close(c.owner.cookie, { jobId: id })).status).toBe(400); // the hire question is asked on closing (#49)
    const cl = await close(c.owner.cookie, { jobId: id, hireAnswer: "yes" });
    expect([cl.status, cl.json]).toEqual([200, { jobId: id, status: "closed" }]);
    expect(await job(id)).toMatchObject({ status: "closed", close_reason: "closed", hire_answer: "yes", hire_answered_by_membership_id: String(c.owner.mem) });
    expect((await close(c.owner.cookie, { jobId: id, hireAnswer: "yes" })).json).toEqual({ code: "JOB_NOT_FOUND" });
    expect((await renew(c.owner.cookie, { jobId: id })).json).toEqual({ code: "JOB_NOT_FOUND" });
    expect((await edit(c.owner.cookie, { ...good, jobId: id })).json).toEqual({ code: "BAD_STATE" });
  });
});

describe("B52: a draft close skips the hire question", () => {
  it("a draft closes with no answer (200), keeps no hire columns, and a given answer is ignored; a closed draft stays closed", async () => {
    const c = await company();
    const a = (await post(c.owner.cookie, { ...good, status: "draft" })).json!.jobId, b = (await post(c.owner.cookie, { ...good, status: "draft" })).json!.jobId;
    const r = await close(c.owner.cookie, { jobId: a });
    expect([r.status, r.json]).toEqual([200, { jobId: a, status: "closed" }]);
    expect(replyProblems(loadSpec("portal"), "POST", "/api/portal/jobs/close", r.status, r.json)).toEqual([]);
    expect(await job(a)).toMatchObject({ status: "closed", close_reason: "closed", hire_answer: null, hire_answered_at: null, hire_answered_by_membership_id: null });
    expect((await close(c.poster.cookie, { jobId: b, hireAnswer: "yes" })).status).toBe(200);
    expect(await job(b)).toMatchObject({ status: "closed", hire_answer: null, hire_answered_at: null, hire_answered_by_membership_id: null });
    expect((await close(c.owner.cookie, { jobId: a })).status).toBe(400); // no answer and no open job: nothing to say about whose job it is
    expect((await renew(c.owner.cookie, { jobId: a })).json).toEqual({ code: "JOB_NOT_FOUND" });
  });
  it("every other open state still needs the answer (400) and keeps the job open; a third value is refused", async () => {
    const c = await company();
    const live = (await post(c.owner.cookie, good)).json!.jobId;
    const held = (await post(c.owner.cookie, { ...good, title: "Fake Held" })).json!.jobId;
    await su.query("update job set status = 'in_review' where id = $1", [held]);
    const under = (await post(c.owner.cookie, { ...good, title: "Fake Under" })).json!.jobId;
    await su.query("update job set status = 'under_review', under_review_reason = 'pay_check' where id = $1", [under]);
    for (const id of [live, held, under]) {
      expect((await close(c.owner.cookie, { jobId: id })).json, String(id)).toEqual({ code: "BAD_REQUEST" });
      expect((await close(c.owner.cookie, { jobId: id, hireAnswer: null })).status).toBe(400);
      for (const hireAnswer of ["through_us", "elsewhere", "maybe", "", true, 1]) expect((await close(c.owner.cookie, { jobId: id, hireAnswer })).status, String(hireAnswer)).toBe(400);
      expect((await job(id)).status).not.toBe("closed");
    }
    expect((await close(c.owner.cookie, { jobId: live, hireAnswer: "no" })).status).toBe(200);
    expect(await job(live)).toMatchObject({ hire_answer: "no", hire_answered_by_membership_id: String(c.owner.mem) });
  });
  it("another company's draft, a viewer, no session and a bad id are refused as before; a draft close with no answer reveals nothing", async () => {
    const c = await company(), other = await company();
    const d = (await post(c.owner.cookie, { ...good, status: "draft" })).json!.jobId;
    expect((await close(other.owner.cookie, { jobId: d })).json).toEqual({ code: "BAD_REQUEST" }); // the same answer as for a missing id
    expect((await close(other.owner.cookie, { jobId: "999999999" })).json).toEqual({ code: "BAD_REQUEST" });
    expect((await close(other.owner.cookie, { jobId: d, hireAnswer: "no" })).json).toEqual({ code: "JOB_NOT_FOUND" });
    expect((await close(c.viewer.cookie, { jobId: d })).json).toEqual({ code: "NOT_A_POSTER" });
    expect((await close(undefined, { jobId: d })).status).toBe(401);
    for (const jobId of [0, "0", "07", "1.5", "-1", "x", "9".repeat(30), null, undefined]) expect((await close(c.owner.cookie, { jobId })).status, String(jobId)).toBe(400);
    expect((await job(d)).status).toBe("draft");
  });
});

describe("renewal re-runs the rules (P14, #254)", () => {
  it("a job that no longer passes goes to Under review instead of being renewed, and the reply says why; a pay edit brings it back", async () => {
    await seedTexts();
    const c = await company();
    const id = (await post(c.owner.cookie, { ...good, statement: signed })).json!.jobId;
    // what a rise in the minimums does to a stored job: its pay is now below the line
    await su.query("update job set salary_low = 30000, salary_high = null, closes_at = now() + interval '2 days' where id = $1", [id]);
    const before = await job(id);
    const r = await renew(c.poster.cookie, { jobId: id, hireAnswer: "no" });
    expect([r.status, r.json]).toEqual([200, { jobId: id, status: "under_review", closesAt: new Date(before.closes_at).toISOString(), code: "PAY_BELOW_MINIMUM" }]);
    expect(await job(id)).toMatchObject({ status: "under_review", closes_at: before.closes_at, hire_answer: "no", posted_by_membership_id: String(c.poster.mem) });
    expect((await job(id)).under_review_since).not.toBeNull();
    expect((await list(c.owner.cookie)).json!.jobs.find((j: { id: string }) => j.id === id)).toMatchObject({ status: "under_review", reason: "renewal_check", reviewCode: "PAY_BELOW_MINIMUM" });
    expect((await job(id)).under_review_reason).toBe("PAY_BELOW_MINIMUM");
    expect((await renew(c.owner.cookie, { jobId: id })).json).toEqual({ code: "JOB_NOT_FOUND" }); // only a live job renews
    const raised = await edit(c.owner.cookie, { ...good, jobId: id, statement: signed });
    expect([raised.status, raised.json?.status]).toEqual([200, "live"]);
    const again = await renew(c.owner.cookie, { jobId: id });
    expect([again.status, again.json?.status]).toEqual([200, "live"]);
  });
  it("the under review reason is stored with each move and shown: the rules run's pay check, a renewal's rule code, a staff check; leaving clears it (gap 2)", async () => {
    await seedTexts();
    const c = await company();
    const shown = async (id: string) => { const j = (await list(c.viewer.cookie)).json!.jobs.find((x: { id: string }) => x.id === id); return [j.status, j.reason, j.reviewCode]; };
    const pay = (await post(c.owner.cookie, good)).json!.jobId, scam = (await post(c.owner.cookie, good)).json!.jobId;
    // the daily rules run's move (rules-run-cli.ts UNDER_REVIEW names 'pay_check'; rules-versions.test.ts runs it); a move naming no reason is a pay check too
    await su.query("update job set status = 'under_review' where id = $1", [pay]);
    expect(await shown(pay)).toEqual(["under_review", "pay_check", null]);
    await su.query("update job_text set advert_text = advert_text || ' Candidates must pay a registration fee before the interview.' where job_id = $1", [scam]);
    expect((await renew(c.owner.cookie, { jobId: scam })).json?.code).toBe("NEEDS_REVIEW");
    expect(await shown(scam)).toEqual(["under_review", "renewal_check", "NEEDS_REVIEW"]);
    const l = await list(c.viewer.cookie);
    expect(replyProblems(loadSpec("portal"), "GET", "/api/portal/jobs", l.status, l.json)).toEqual([]);
    const held = (await post(c.owner.cookie, { ...good, description: `${desc} Candidates must pay a registration fee before the interview.` })).json!;
    expect(held.status).toBe("in_review");
    expect(await shown(held.jobId)).toEqual(["in_review", "staff_check", null]);
    expect(await shown((await post(c.owner.cookie, good)).json!.jobId)).toEqual(["live", null, null]);
    // the reason stays while the job stays under review, whoever writes; a close (the employer's or the 30-day one) clears it
    const portal = db.pool("app_portal");
    await portal.query("update job set under_review_reason = 'pay_check', posted_by_membership_id = $2 where id = $1", [scam, c.owner.mem]);
    expect((await job(scam)).under_review_reason).toBe("NEEDS_REVIEW");
    const live = (await post(c.owner.cookie, good)).json!.jobId;
    await portal.query("update job set under_review_reason = 'PAY_REQUIRED', posted_by_membership_id = $2 where id = $1", [live, c.owner.mem]);
    expect((await job(live)).under_review_reason).toBeNull(); // a live job carries no reason
    await expect(su.query("update job set status = 'under_review', under_review_reason = 'not a code' where id = $1", [live])).rejects.toThrow(/under_review_reason_check/);
    expect((await close(c.owner.cookie, { jobId: scam, hireAnswer: "no" })).status).toBe(200);
    expect(await job(scam)).toMatchObject({ status: "closed", under_review_reason: null });
    await su.query("update job set under_review_since = now() - interval '31 days' where id = $1", [pay]);
    await db.query("app_admin", CLOSE_UNDER_REVIEW); // the real 30-day close
    expect(await job(pay)).toMatchObject({ status: "closed", close_reason: "under_review_expired", under_review_reason: null });
  });
  it("advert text that now needs a staff check goes to Under review too; a passing job keeps its badge and its statement", async () => {
    await seedTexts();
    const c = await company();
    const id = (await post(c.owner.cookie, { ...good, statement: signed })).json!.jobId;
    const ok = await renew(c.owner.cookie, { jobId: id });
    expect([ok.status, ok.json?.status]).toEqual([200, "live"]);
    expect(await job(id)).toMatchObject({ status: "live", badge: "sponsor_confirmed" });
    expect(await statements(id)).toHaveLength(1);
    await su.query("update job_text set advert_text = advert_text || ' Candidates must pay a registration fee before the interview.' where job_id = $1", [id]);
    const r = await renew(c.owner.cookie, { jobId: id });
    expect([r.status, r.json?.status, r.json?.code]).toEqual([200, "under_review", "NEEDS_REVIEW"]);
  });
  it("security: another company, a viewer and a signed-out call move nothing; app_portal may not move a job back from under review without a pay change", async () => {
    const c = await company(), other = await company();
    const id = (await post(c.owner.cookie, good)).json!.jobId;
    await su.query("update job set salary_low = 30000, salary_high = null where id = $1", [id]);
    expect((await renew(other.owner.cookie, { jobId: id })).json).toEqual({ code: "JOB_NOT_FOUND" });
    expect((await renew(c.viewer.cookie, { jobId: id })).json).toEqual({ code: "NOT_A_POSTER" });
    expect((await renew(undefined, { jobId: id })).status).toBe(401);
    for (const b of [{ jobId: id, exceptionConfirmed: "yes" }, { jobId: id, status: "live" }, { jobId: id, closesAt: "2030-01-01" }])
      expect((await renew(c.owner.cookie, b)).status, JSON.stringify(b)).toBe(400);
    expect((await job(id)).status).toBe("live");
    expect((await renew(c.owner.cookie, { jobId: id })).json?.status).toBe("under_review");
    const portal = db.pool("app_portal");
    await expect(portal.query("update job set status = 'live', posted_by_membership_id = $2 where id = $1", [id, c.owner.mem])).rejects.toThrow(/may not move a job from under_review to live/);
  });
});

describe("back live after a renewal's non-pay rule is fixed (gap 1 follow-up, 0045 job_guard)", () => {
  const scamText = `${desc} Candidates must pay a registration fee before the interview.`;
  // the advert text and its search vector, as an edit writes them together
  const SCAM = "with t as (update job_text set advert_text = advert_text || ' Candidates must pay a registration fee before the interview.' where job_id = $1 returning advert_text) " +
    "update job set search_vector = to_tsvector('english', title || ' ' || employer_name || ' ' || (select advert_text from t)) where id = $1";
  const shown = async (c: Company, id: string) => { const j = (await list(c.viewer.cookie)).json!.jobs.find((x: { id: string }) => x.id === id); return [j.status, j.reason, j.reviewCode]; };
  /** A live job, made to fail the renewal by a stored field, renewed into Under review with that rule. */
  async function moved(c: Company, set: string, code: string) {
    const id = (await post(c.owner.cookie, good)).json!.jobId;
    await su.query(set, [id]);
    const r = await renew(c.owner.cookie, { jobId: id });
    expect([r.json?.status, r.json?.code]).toEqual(["under_review", code]);
    return id as string;
  }
  it("a code, a title or an advert fix through the edit route that passes the rules sets the job live and clears the reason", async () => {
    await seedTexts();
    const c = await company();
    const code = await moved(c, "update job set occupation_code = '4112' where id = $1", "OCCUPATION_INELIGIBLE");
    const r = await edit(c.owner.cookie, { ...good, jobId: code });
    expect([r.status, r.json?.status]).toEqual([200, "live"]);
    expect(await job(Number(code))).toMatchObject({ status: "live", under_review_reason: null, under_review_since: null, occupation_code: "2136" });
    expect(await shown(c, code)).toEqual(["live", null, null]);
    const title = await moved(c, "update job set title = 'Software Engineer Intern' where id = $1", "RULES_FAILED");
    expect((await edit(c.owner.cookie, { ...good, jobId: title })).json?.status).toBe("live");
    const scam = await moved(c, SCAM, "NEEDS_REVIEW");
    expect((await edit(c.owner.cookie, { ...good, jobId: scam })).json?.status).toBe("live"); // the advert text only: no pay, title or code change
    expect((await job(Number(scam))).advert_text).toBe(desc);
  });
  it("an edit that still fails leaves it under review with the failing code; an edit that changes nothing the rules read cannot flip it", async () => {
    await seedTexts();
    const c = await company();
    const code = await moved(c, "update job set occupation_code = '4112' where id = $1", "OCCUPATION_INELIGIBLE");
    const same0 = await edit(c.owner.cookie, { ...good, jobId: code, occupationCode: "4112" }); // nothing the rules read changed: saved, not moved
    expect([same0.status, same0.json?.status]).toEqual([200, "under_review"]);
    const still = await edit(c.owner.cookie, { ...good, jobId: code, occupationCode: "4112", title: "Senior Software Engineer" });
    expect([still.status, still.json?.code]).toEqual([422, "OCCUPATION_INELIGIBLE"]);
    const other = await edit(c.owner.cookie, { ...good, jobId: code, occupationCode: "4113" }); // another Ineligible code
    expect([other.status, other.json?.code]).toEqual([422, "OCCUPATION_INELIGIBLE"]);
    expect(await shown(c, code)).toEqual(["under_review", "renewal_check", "OCCUPATION_INELIGIBLE"]);
    const scam = await moved(c, SCAM, "NEEDS_REVIEW");
    const kept = await edit(c.owner.cookie, { ...good, jobId: scam, description: scamText, county: "Cork" }); // a county edit with the wording kept: still needs a staff check
    expect([kept.status, kept.json?.status]).toEqual([200, "under_review"]);
    expect(await shown(c, scam)).toEqual(["under_review", "renewal_check", "NEEDS_REVIEW"]);
    const same = await edit(c.owner.cookie, { ...good, jobId: scam, description: scamText, county: "Cork" }); // nothing changed
    expect([same.status, same.json?.status]).toEqual([200, "under_review"]);
    // the database: the portal cannot set it live without changing a field the rules read, nor with a field that is not one
    const portal = db.pool("app_portal");
    await expect(portal.query("update job set status = 'live', posted_by_membership_id = $2 where id = $1", [scam, c.owner.mem])).rejects.toThrow(/may not move a job from under_review to live/);
    await expect(portal.query("update job set status = 'live', own_page_url = 'https://example.test/other', posted_by_membership_id = $2 where id = $1", [scam, c.owner.mem])).rejects.toThrow(/may not move/);
    expect((await job(Number(scam))).status).toBe("under_review");
  });
  it("a pay_check job still needs a passing pay edit (#93); another company and a viewer are refused", async () => {
    await seedTexts();
    const c = await company(), other = await company();
    const id = (await post(c.owner.cookie, good)).json!.jobId;
    await su.query("update job set status = 'under_review', under_review_reason = 'pay_check', salary_low = 30000, salary_high = null where id = $1", [id]);
    const titleOnly = await edit(c.owner.cookie, { ...good, jobId: id, salaryLow: 30000, salaryHigh: null, title: "Senior Software Engineer" });
    expect([titleOnly.status, titleOnly.json?.code]).toEqual([422, "PAY_BELOW_MINIMUM"]);
    const advertOnly = await edit(c.owner.cookie, { ...good, jobId: id, salaryLow: 30000, salaryHigh: null, description: `${desc} Hybrid working.` });
    expect([advertOnly.status, advertOnly.json?.status]).toEqual([200, "under_review"]); // no pay change: the rules do not run and it stays
    await expect(db.pool("app_portal").query("update job set status = 'live', title = 'Fake retitled', posted_by_membership_id = $2 where id = $1", [id, c.owner.mem])).rejects.toThrow(/may not move/);
    const scam = await moved(c, "update job set occupation_code = '4112' where id = $1", "OCCUPATION_INELIGIBLE");
    expect((await edit(other.owner.cookie, { ...good, jobId: scam })).json).toEqual({ code: "JOB_NOT_FOUND" });
    expect((await edit(c.viewer.cookie, { ...good, jobId: scam })).json).toEqual({ code: "NOT_A_POSTER" });
    expect((await job(Number(scam))).status).toBe("under_review");
    expect((await edit(c.owner.cookie, { ...good, jobId: id })).json?.status).toBe("live"); // the pay edit
    expect((await job(Number(id))).under_review_reason).toBeNull();
  });
  it("budget: the edit route's statements are unchanged by the fix check (the advert text is read inside the job lock)", async () => {
    await seedTexts();
    const c = await company();
    const scam = await moved(c, SCAM, "NEEDS_REVIEW");
    const [fixed, nFix] = await counted(() => edit(c.owner.cookie, { ...good, jobId: scam }));
    expect(fixed.json?.status).toBe("live");
    const plain = (await post(c.owner.cookie, good)).json!.jobId;
    const [, nPlain] = await counted(() => edit(c.owner.cookie, { ...good, jobId: plain, salaryLow: 51000 }));
    console.log(`edit budget: ${nPlain} statements (a fix ${nFix})`);
    expect(nPlain).toBeLessThanOrEqual(BUDGET.edit);
    expect(nFix).toBeLessThanOrEqual(BUDGET.edit);
  });
});

describe("GET /api/portal/jobs", () => {
  it("is 401 without a session, 404 NO_COMPANY with no company, and shows only the company's own jobs to every member", async () => {
    expect((await list()).status).toBe(401);
    const none = await list((await login()).cookie);
    expect([none.status, none.json]).toEqual([404, { code: "NO_COMPANY" }]);
    const c = await company(), other = await company();
    const mine = (await post(c.owner.cookie, good)).json!.jobId, theirs = (await post(other.owner.cookie, good)).json!.jobId;
    const scam = (await post(c.owner.cookie, { ...good, description: desc + " Candidates must pay a registration fee before the interview." })).json!.jobId;
    for (const m of [c.owner, c.viewer]) {
      const jobs = (await list(m.cookie)).json!.jobs as { id: string; status: string; reason: string | null; postedAt: string; closesAt: string }[];
      expect(typeof mine).toBe("string");
      for (const j of jobs) { expect(j.postedAt).toMatch(/Z$/); expect(j.closesAt).toMatch(/Z$/); } // ISO 8601 in UTC, never +00:00
      expect(jobs.map((j) => j.id)).toEqual([scam, mine]);
      expect(jobs.find((j) => j.id === scam)).toMatchObject({ status: "in_review", reason: "staff_check" });
      expect(jobs.map((j) => j.id)).not.toContain(theirs);
    }
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [c.viewer.mem]);
    expect((await list(c.viewer.cookie)).json).toEqual({ code: "NO_COMPANY" });
  });
});

describe("hostile bodies", () => {
  let c: Company;
  beforeAll(async () => { c = await company(); });
  it("refuses a foreign or missing Origin, a big body, bad JSON and fields the employer may not set", async () => {
    expect((await post(c.owner.cookie, good, { origin: "https://evil.example" })).json).toEqual({ code: "BAD_ORIGIN" });
    expect((await post(c.owner.cookie, good, { origin: null })).status).toBe(403);
    expect((await post(c.owner.cookie, { ...good, description: "x".repeat(25_000) })).status).toBe(413);
    expect((await post(c.owner.cookie, null, { raw: "{nope" })).status).toBe(400);
    for (const extra of [{ badge: "sponsor_confirmed" }, { passRoute: "big_company" }, { organisationId: 1 }, { postedByMembershipId: 1 }, { payFloorId: 1 }, { source: "fetched" }])
      expect((await post(c.owner.cookie, { ...good, ...extra })).status, JSON.stringify(extra)).toBe(400);
    for (const title of ["a‮b title", "zero​width", "line\nbreak"]) expect((await post(c.owner.cookie, { ...good, title })).status).toBe(400);
    expect((await post(c.owner.cookie, { ...good, ownPageUrl: "javascript:alert(1)//aaaaa" })).status).toBe(400);
    for (const jobId of [1, "0", "01", "-1", "9".repeat(19), "1;drop", null]) expect((await edit(c.owner.cookie, { ...good, jobId })).status, String(jobId)).toBe(400);
    expect(await jobCount(c.org)).toBe(0);
  });
  it("limits a login to 30 writes in the window", async () => {
    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await renew(c.owner.cookie, { jobId: "999999999" })).status);
    expect(codes.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe("budgets: median of 9 calls", () => {
  it("stays inside the statement and time budgets", async () => {
    await seedTexts();
    const c = await company();
    const [p, sp] = await counted(() => post(c.owner.cookie, good));
    expect(p.status).toBe(200);
    expect(sp, `${sp} post statements`).toBeLessThanOrEqual(BUDGET.post);
    const [s, ss] = await counted(() => post(c.owner.cookie, { ...good, statement: signed }));
    expect(s.status).toBe(200);
    expect(ss, `${ss} signed post statements`).toBeLessThanOrEqual(BUDGET.signed);
    await su.query("delete from portal_rate_limit where key like 'jobs:%'");
    const postMs = await median(async () => { expect((await post(c.owner.cookie, good)).status).toBe(200); });
    expect(postMs).toBeLessThan(BUDGET.postMs);
    await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector)
      select $1, 'employer', (select id from job_source where kind = 'portal' and board = 'employer'), 'Fake', 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 50000, 'x'
        from generate_series(1, 50)`, [c.org]);
    // P14: a renewal reads the rules (cached per process, as here after the posts) and the locked job before it writes
    const rid = (await post(c.owner.cookie, good)).json!.jobId;
    const [rn, sr] = await counted(() => renew(c.owner.cookie, { jobId: rid }));
    expect(rn.json?.status).toBe("live");
    expect(sr, `${sr} renew statements`).toBeLessThanOrEqual(BUDGET.renew);
    await su.query("delete from portal_rate_limit where key like 'jobs:%'");
    const renewMs = await median(async () => { expect((await renew(c.owner.cookie, { jobId: rid })).json?.status).toBe("live"); });
    expect(renewMs).toBeLessThan(BUDGET.renewMs);
    console.log(`renew budget: ${sr} statements, median ${renewMs.toFixed(1)} ms`);
    const [l, sl] = await counted(() => list(c.viewer.cookie));
    expect(l.json!.jobs.length).toBeGreaterThan(50);
    expect(sl, `${sl} list statements`).toBeLessThanOrEqual(BUDGET.list);
    const listMs = await median(() => list(c.viewer.cookie));
    expect(listMs).toBeLessThan(BUDGET.listMs);
    console.log(`jobs budgets: post ${sp} statements (signed ${ss}), median ${postMs.toFixed(1)} ms; list ${sl} statements, median ${listMs.toFixed(1)} ms`);
  });
});

// General Employment Permit posts (feature plan 4.2) and the exception tick. The rules in force are read through getRules, which keeps them 5 minutes per
// process, so the tests move the clock past that after changing the minimums row (only Date is faked; the other timers stay real).
describe("General Employment Permit posts", () => {
  const care = { ...good, title: "Healthcare Assistant", description: "We are hiring a healthcare assistant for our care home in Cork. Full sponsorship offered.", county: "Cork",
    occupationCode: "6145", salaryLow: 33000, salaryHigh: null, permitType: "general", statement: signed, exceptionConfirmed: true };
  const chef = { ...good, title: "Head Chef", description: "We are hiring a head chef for our restaurant in Galway. Full sponsorship offered.", county: "Galway",
    occupationCode: "5434", salaryLow: 80000, salaryHigh: null };
  const GENERAL = { general: 36605, generalLower: 32691, generalLowerCodes: ["6145"], generalQuotaFullCodes: [] as string[] };
  let clock = Date.now();
  const setMinimums = async (extra: object) => {
    await su.query("update rules_version set data = (data - 'general' - 'generalLower' - 'generalLowerCodes' - 'generalQuotaFullCodes') || $1::jsonb where kind = 'minimums' and seeded_by_owner", [JSON.stringify(extra)]);
    clock += 6 * 60_000; // past the 5 minute cache
    vi.setSystemTime(clock);
  };
  beforeAll(async () => { await seedTexts(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock); });
  afterAll(() => { vi.useRealTimers(); });

  it("is refused with GENERAL_RULES_NOT_SET while the rules in force have no General figures; a draft still saves", async () => {
    await setMinimums({});
    const c = await company();
    const r = await post(c.owner.cookie, care);
    expect([r.status, r.json]).toEqual([422, { code: "GENERAL_RULES_NOT_SET" }]);
    expect(await jobCount(c.org)).toBe(0);
    expect((await post(c.owner.cookie, { ...care, status: "draft" })).json).toMatchObject({ status: "draft", passRoute: null });
    expect((await one("select permit_type from job where organisation_id = $1", [c.org])).permit_type).toBe("general");
  });

  it("goes live with permit_type general, Sponsor confirmed and the stated pay route; refused without the statement", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Care Home Limited" });
    const r = await post(c.owner.cookie, care);
    expect([r.status, r.json]).toMatchObject([200, { status: "live", badge: "sponsor_confirmed", passRoute: "stated_pay" }]);
    expect(await job(r.json!.jobId)).toMatchObject({ permit_type: "general", badge: "sponsor_confirmed", pass_route: "stated_pay", sector: "care", status: "live" }); // #257: 6145 is care
    const before = await jobCount(c.org);
    const nostate = await post(c.owner.cookie, { ...care, statement: undefined });
    expect([nostate.status, nostate.json]).toEqual([422, { code: "STATEMENT_REQUIRED" }]);
    for (const [o, code] of [[{ salaryLow: 32690 }, "PAY_BELOW_MINIMUM"], [{ occupationCode: "3545", salaryLow: 36604 }, "PAY_BELOW_MINIMUM"], [{ salaryLow: null, payGrade: "Care scale" }, "PAY_REQUIRED"],
      [{ occupationCode: "4112" }, "OCCUPATION_INELIGIBLE"]] as [object, string][]) {
      const x = await post(c.owner.cookie, { ...care, ...o });
      expect([x.status, x.json?.code], JSON.stringify(o)).toEqual([422, code]);
    }
    expect(await jobCount(c.org)).toBe(before);
    // a short fixed term is fine for General; the Critical Skills default still needs 24 months and its own minimum
    expect((await post(c.owner.cookie, { ...care, contractType: "fixed_term", contractMonths: 6 })).status).toBe(200);
    const cs = await post(c.owner.cookie, { ...care, permitType: undefined });
    expect([cs.status, cs.json?.code]).toEqual([422, "PAY_BELOW_MINIMUM"]);
    expect((await post(c.owner.cookie, { ...good, statement: signed })).json).toMatchObject({ status: "live", badge: "sponsor_confirmed" });
    expect((await one("select permit_type from job where id = $1", [(await post(c.owner.cookie, good)).json!.jobId])).permit_type).toBe("critical_skills");
  });

  it("an update that switches the permit type runs the rules again", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Care Home Limited" });
    const id = (await post(c.owner.cookie, { ...good, statement: signed })).json!.jobId;
    expect((await job(id)).permit_type).toBe("critical_skills");
    const noState = await edit(c.owner.cookie, { ...good, jobId: id, permitType: "general" });
    expect([noState.status, noState.json]).toEqual([422, { code: "STATEMENT_REQUIRED" }]);
    expect((await job(id)).permit_type).toBe("critical_skills");
    const toGeneral = await edit(c.owner.cookie, { ...care, jobId: id });
    expect([toGeneral.status, toGeneral.json]).toMatchObject([200, { status: "live", badge: "sponsor_confirmed", passRoute: "stated_pay" }]);
    expect(await job(id)).toMatchObject({ permit_type: "general", occupation_code: "6145", salary_low: 33000 });
    const back = await edit(c.owner.cookie, { ...care, jobId: id, permitType: "critical_skills" });
    expect([back.status, back.json]).toEqual([422, { code: "PAY_BELOW_MINIMUM" }]); // care work at 33,000 is not a Critical Skills pay
    expect((await job(id)).permit_type).toBe("general");
    const lower = await edit(c.owner.cookie, { ...care, jobId: id, salaryLow: 32000 });
    expect(lower.json).toEqual({ code: "PAY_BELOW_MINIMUM" });
  });

  it("a full quota blocks the code", async () => {
    await setMinimums({ ...GENERAL, generalQuotaFullCodes: ["6145"] });
    const c = await company({ name: "Fake Care Home Limited" });
    expect((await post(c.owner.cookie, care)).json).toEqual({ code: "QUOTA_FULL" });
    expect((await post(c.owner.cookie, { ...care, occupationCode: "3545", salaryLow: 36605 })).status).toBe(200);
    await setMinimums(GENERAL);
  });

  it("a chef is refused without the exception tick, with the wording, and passes with it, for both permit types", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Restaurant Limited" });
    for (const permitType of ["critical_skills", "general"]) {
      const body = { ...chef, permitType, statement: signed, ...(permitType === "general" ? { salaryLow: 40000 } : {}) };
      const no = await post(c.owner.cookie, body);
      expect([no.status, no.json?.code, no.json?.exception]).toEqual([422, "OCCUPATION_INELIGIBLE", expect.stringContaining("Executive Chef")]);
      const yes = await post(c.owner.cookie, { ...body, exceptionConfirmed: true });
      expect([yes.status, yes.json], permitType).toMatchObject([200, { status: "live", passRoute: "stated_pay" }]);
      expect((await job(yes.json!.jobId)).permit_type).toBe(permitType);
    }
    const plain = await post(c.owner.cookie, { ...good, occupationCode: "4112", exceptionConfirmed: true });
    expect([plain.status, plain.json]).toEqual([422, { code: "OCCUPATION_INELIGIBLE" }]); // no exception wording on this entry, so no tick helps
  });

  it("the exception tick is stored when a post or edit passes with it, renewal reads it, and an edit to a code with no condition clears it (gap 1)", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Restaurant Limited" });
    const tick = async (id: string) => (await job(Number(id))).exception_confirmed_at !== null;
    const listed = async (id: string) => (await list(c.owner.cookie)).json!.jobs.find((j: { id: string }) => j.id === id);
    const id = (await post(c.owner.cookie, { ...chef, exceptionConfirmed: true })).json!.jobId;
    expect(await tick(id)).toBe(true);
    expect(await listed(id)).toMatchObject({ exceptionConfirmed: true });
    const r = await renew(c.owner.cookie, { jobId: id }); // no tick in the body: the stored one counts
    expect([r.status, r.json?.status]).toEqual([200, "live"]);
    expect(await tick(id)).toBe(true);
    // a tick on a code that needs none is not stored
    const plain = (await post(c.owner.cookie, { ...good, exceptionConfirmed: true })).json!.jobId;
    expect(await tick(plain)).toBe(false);
    // an edit that does not run the rules keeps it; an edit to a code with no condition clears it; back to the chef needs the tick again
    expect((await edit(c.owner.cookie, { ...chef, county: "Cork", jobId: id, exceptionConfirmed: true })).status).toBe(200);
    expect(await tick(id)).toBe(true);
    expect((await edit(c.owner.cookie, { ...chef, county: "Cork", jobId: id })).status).toBe(200); // county only: the rules do not run, the tick stays
    expect(await tick(id)).toBe(true);
    expect((await edit(c.owner.cookie, { ...good, jobId: id })).status).toBe(200);
    expect(await tick(id)).toBe(false);
    expect(await listed(id)).toMatchObject({ exceptionConfirmed: false });
    const back = await edit(c.owner.cookie, { ...chef, jobId: id });
    expect([back.status, back.json?.code]).toEqual([422, "OCCUPATION_INELIGIBLE"]);
    expect((await edit(c.owner.cookie, { ...chef, jobId: id, exceptionConfirmed: true })).status).toBe(200);
    expect(await tick(id)).toBe(true);
    // a draft stores nothing (no rules run); it is stored when the draft goes live with the tick
    const d = (await post(c.owner.cookie, { ...chef, status: "draft", exceptionConfirmed: true })).json!.jobId;
    expect(await tick(d)).toBe(false);
    expect((await edit(c.owner.cookie, { ...chef, jobId: d, exceptionConfirmed: true })).json?.status).toBe("live");
    expect(await tick(d)).toBe(true);
  });

  it("a job with no stored tick whose code now has a condition is asked at renewal (422, nothing moved) and stores it once renewed with it (#254)", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Restaurant Limited" });
    const id = (await post(c.owner.cookie, { ...chef, exceptionConfirmed: true })).json!.jobId;
    await su.query("update job set exception_confirmed_at = null where id = $1", [id]); // as if the Ineligible entry gained its exception after the post
    const before = await job(id);
    const ask = await renew(c.owner.cookie, { jobId: id });
    expect([ask.status, ask.json?.code, ask.json?.exception]).toEqual([422, "OCCUPATION_INELIGIBLE", expect.stringContaining("Executive Chef")]);
    expect(await job(id)).toMatchObject({ status: "live", closes_at: before.closes_at, exception_confirmed_at: null });
    const r = await renew(c.owner.cookie, { jobId: id, exceptionConfirmed: true });
    expect([r.status, r.json?.status]).toEqual([200, "live"]);
    expect((await job(id)).exception_confirmed_at).not.toBeNull();
    expect((await renew(c.owner.cookie, { jobId: id })).json?.status).toBe("live");
  });

  it("the 0045 backfill ticks open jobs whose code has a condition, and nothing else", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Restaurant Limited" });
    const mk = async (body: object) => (await post(c.owner.cookie, body)).json!.jobId as string;
    const jobs = { chef: await mk({ ...chef, exceptionConfirmed: true }), care: await mk({ ...care }), plain: await mk(good), draft: await mk({ ...chef, status: "draft" }),
      closed: await mk({ ...chef, exceptionConfirmed: true }), underReview: await mk({ ...chef, exceptionConfirmed: true }) };
    await close(c.owner.cookie, { jobId: jobs.closed, hireAnswer: "no" });
    await su.query("update job set status = 'under_review' where id = $1", [jobs.underReview]);
    await su.query("update job set exception_confirmed_at = null where id = any($1::bigint[])", [Object.values(jobs)]);
    const sql = readFileSync(new URL("../migrations/0045_job_review_marks.sql", import.meta.url), "utf8");
    const backfill = sql.slice(sql.indexOf("update job j set exception_confirmed_at"), sql.indexOf(";", sql.indexOf("update job j set exception_confirmed_at")));
    await su.query(backfill);
    const ticked = Object.fromEntries(await Promise.all(Object.entries(jobs).map(async ([k, id]) => [k, (await job(Number(id))).exception_confirmed_at !== null])));
    expect(ticked).toEqual({ chef: true, care: true, plain: false, draft: false, closed: false, underReview: true });
    for (const id of [jobs.chef, jobs.care]) expect((await renew(c.owner.cookie, { jobId: id })).json?.status).toBe("live");
  });

  it("security: the tick is the employer's own and only true counts; the portal cannot read or write another company's", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Restaurant Limited" }), other = await company();
    const id = (await post(c.owner.cookie, { ...chef, exceptionConfirmed: true })).json!.jobId;
    await su.query("update job set exception_confirmed_at = null where id = $1", [id]);
    for (const e of ["yes", 1, null, [true], { a: true }]) expect((await renew(c.owner.cookie, { jobId: id, exceptionConfirmed: e })).status, JSON.stringify(e)).toBe(400);
    expect((await renew(c.owner.cookie, { jobId: id, exceptionConfirmed: false })).status).toBe(422);
    expect((await renew(other.owner.cookie, { jobId: id, exceptionConfirmed: true })).json).toEqual({ code: "JOB_NOT_FOUND" });
    expect((await renew(c.viewer.cookie, { jobId: id, exceptionConfirmed: true })).json).toEqual({ code: "NOT_A_POSTER" });
    expect((await job(id)).exception_confirmed_at).toBeNull();
    expect((await list(other.owner.cookie)).json!.jobs.some((j: { id: string }) => j.id === id)).toBe(false);
    await expect(db.pool("app_candidate").query("select exception_confirmed_at from job limit 1")).rejects.toThrow(/permission denied/);
    await expect(db.pool("app_fetcher").query("update job set exception_confirmed_at = now() where id = $1", [id])).rejects.toThrow(/permission denied/);
  });

  it("S8: every write of a General job sets its quota mark from the rules in force; a code or permit change clears it (gap 3)", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Care Home Limited" });
    const live = (await post(c.owner.cookie, care)).json!.jobId;
    const draft = (await post(c.owner.cookie, { ...care, status: "draft" })).json!.jobId;
    const mark = async (id: string) => (await job(Number(id))).quota_full;
    expect([await mark(live), await mark(draft)]).toEqual([false, false]);
    await setMinimums({ ...GENERAL, generalQuotaFullCodes: ["6145"] });
    // no rules run has applied the version yet: the next write of each job is right at once
    expect((await edit(c.owner.cookie, { ...care, jobId: live, county: "Kerry" })).status).toBe(200); // county only: the rules do not run
    expect(await mark(live)).toBe(true);
    expect((await post(c.owner.cookie, { ...care, status: "draft" })).json?.status).toBe("draft");
    expect(await mark((await one("select max(id)::text id from job where organisation_id = $1", [c.org])).id)).toBe(true);
    expect((await edit(c.owner.cookie, { ...care, jobId: draft, occupationCode: "3545", salaryLow: 36605, status: "draft" })).status).toBe(200);
    expect(await mark(draft)).toBe(false);
    await su.query("update job set permit_type = 'critical_skills' where id = $1", [live]);
    expect(await mark(live)).toBe(false);
    // the fetcher and staff writes go through the same trigger; the portal still cannot write the column itself
    await su.query("update job set permit_type = 'general' where id = $1", [live]);
    expect(await mark(live)).toBe(true);
    await expect(db.pool("app_portal").query("update job set quota_full = false where id = $1", [live])).rejects.toThrow(/permission denied/);
    await setMinimums(GENERAL);
    await su.query("update job set occupation_code = occupation_code where id = $1", [live]);
    expect(await mark(live)).toBe(false);
  });

  it("security: every role and company state is tried with permitType general", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Care Home Limited" });
    const before = await jobCount(c.org);
    expect((await post(c.viewer.cookie, care)).json).toEqual({ code: "NOT_A_POSTER" });
    expect((await post((await login()).cookie, care)).json).toEqual({ code: "NOT_A_MEMBER" });
    expect((await post(undefined, care)).status).toBe(401);
    expect((await post(c.poster.cookie, care)).json).toEqual({ code: "NOT_A_SIGNER" }); // a poster without the signer switch cannot sign the statement
    expect(await jobCount(c.org)).toBe(before);
    expect((await post(c.poster.cookie, { ...care, statement: undefined })).json).toEqual({ code: "STATEMENT_REQUIRED" });
    expect((await post((await company({ status: "pending_review" })).owner.cookie, care)).json).toEqual({ code: "COMPANY_NOT_ACTIVE" });
    const susp = await company({ status: "suspended" });
    expect((await post(susp.owner.cookie, care)).status).toBe(403);
    const r = await company();
    const k = await su.connect();
    try {
      await k.query("begin");
      await k.query("set local session_replication_role = replica");
      await k.query("update organisation set restricted_until = now() + interval '30 days' where id=$1", [r.org]);
      await k.query("commit");
    } finally { k.release(); }
    expect((await post(r.owner.cookie, care)).json).toEqual({ code: "BADGE_RESTRICTED" });
    expect((await post(r.owner.cookie, { ...care, statement: undefined, status: "draft" })).status).toBe(200);
  });

  it("security: hostile permitType and exceptionConfirmed are refused with nothing written, and a General job never gets critical_skills_eligible", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Care Home Limited" });
    const before = await jobCount(c.org);
    for (const o of [{ permitType: "stamp4" }, { permitType: "General" }, { permitType: 1 }, { permitType: null }, { permitType: { a: 1 } }, { permitType: ["general"] }, { permitType: "general".repeat(2000) },
      { exceptionConfirmed: "true" }, { exceptionConfirmed: 1 }, { exceptionConfirmed: null }, { exceptionConfirmed: { a: 1 } }, { exceptionConfirmed: "x".repeat(20_000) },
      { badge: "critical_skills_eligible" }, { permitType: "general", badge: "critical_skills_eligible" }])
      expect((await post(c.owner.cookie, { ...care, ...o })).status, JSON.stringify(o).slice(0, 60)).toBe(400);
    expect((await edit(c.owner.cookie, { ...care, jobId: "1", permitType: "nope" })).status).toBe(400);
    expect(await jobCount(c.org)).toBe(before);
    const id = (await post(c.owner.cookie, care)).json!.jobId;
    await expect(su.query("update job set badge = 'critical_skills_eligible' where id = $1", [id])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("app_portal", "update job set badge = 'critical_skills_eligible' where id = $1", [id])).rejects.toBeDefined();
    expect((await job(id)).badge).toBe("sponsor_confirmed");
  });

  it("budget: a signed General post uses no more statements than a signed Critical Skills one", async () => {
    await setMinimums(GENERAL);
    const c = await company({ name: "Fake Care Home Limited" });
    expect((await post(c.owner.cookie, care)).status).toBe(200); // warms the rules cache
    const [g, sg] = await counted(() => post(c.owner.cookie, care));
    expect(g.status).toBe(200);
    expect(sg, `${sg} signed General post statements`).toBeLessThanOrEqual(BUDGET.signed);
    await su.query("delete from portal_rate_limit where key like 'jobs:%'");
    const ms = await median(async () => { expect((await post(c.owner.cookie, care)).status).toBe(200); });
    expect(ms).toBeLessThan(BUDGET.postMs);
    console.log(`General post budget: ${sg} statements (signed Critical Skills budget ${BUDGET.signed}), median ${ms.toFixed(1)} ms`);
  });
});

describe("the replies match docs/openapi/portal.yaml (decision #248)", () => {
  it("post, list and close a job, and the refusals on the way", async () => {
    const spec = loadSpec("portal");
    const c = await company();
    const posted = await post(c.owner.cookie, good);
    const id = posted.json!.jobId;
    const checks: [string, Reply][] = [
      ["/api/portal/jobs", posted], ["/api/portal/jobs", await post(c.viewer.cookie, good)], ["/api/portal/jobs", await post(undefined, good)],
      ["/api/portal/jobs", await post(c.owner.cookie, good, { origin: "https://elsewhere.example.com" })], ["/api/portal/jobs", await post(c.owner.cookie, { ...good, title: 5 })],
      ["/api/portal/jobs/close", await close(c.owner.cookie, { jobId: id, hireAnswer: "no" })], ["/api/portal/jobs/close", await close(c.owner.cookie, { jobId: id })],
    ];
    expect(checks.map(([, r]) => r.status)).toEqual([200, 403, 401, 403, 400, 200, 400]);
    for (const [path, r] of checks) expect(replyProblems(spec, "POST", path, r.status, r.json), `${r.status} ${path} ${r.text.slice(0, 200)}`).toEqual([]);
    const l = await list(c.owner.cookie);
    expect([l.status, replyProblems(spec, "GET", "/api/portal/jobs", l.status, l.json)]).toEqual([200, []]);
    // the changed shapes: ids as text, times with Z (the Timestamp pattern), no company is 404, the renewal's closesAt
    const live = (await post(c.owner.cookie, good)).json!.jobId;
    const rn = await renew(c.owner.cookie, { jobId: live });
    expect([rn.status, replyProblems(spec, "POST", "/api/portal/jobs/renew", rn.status, rn.json)]).toEqual([200, []]);
    await su.query("update job set salary_low = 30000, salary_high = null where id = $1", [live]); // P14: the under-review reply matches the spec too
    const ur = await renew(c.owner.cookie, { jobId: live });
    expect([ur.json?.status, replyProblems(spec, "POST", "/api/portal/jobs/renew", ur.status, ur.json)]).toEqual(["under_review", []]);
    const none = await list((await login()).cookie);
    expect([none.status, replyProblems(spec, "GET", "/api/portal/jobs", none.status, none.json)]).toEqual([404, []]);
    // a number id or a +00:00 time would fail the schema
    expect(replyProblems(spec, "GET", "/api/portal/jobs", 200, { jobs: [{ ...l.json!.jobs[0], id: 5 }] })).not.toEqual([]);
    expect(replyProblems(spec, "GET", "/api/portal/jobs", 200, { jobs: [{ ...l.json!.jobs[0], postedAt: "2026-11-10T08:00:00.000000+00:00" }] })).not.toEqual([]);
  });
});
