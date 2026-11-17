// Step 9 part 12a, end to end on the test database through the real /api/portal/jobs handlers, connected as app_portal, with real portal
// sessions (sign-up, confirm and sign-in through the real auth route). No test calls the real network. Fake people and companies only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { savePostingTexts } from "../src/posting-texts-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

// Statements counted on every pg.Client.query call, measured on 12 November 2026: a live post 9 (requirePortal 3, rate count 1, begin, the
// company, the job, its text, commit), with a statement 12 (the text, supersede, the statement); the list 4 (requirePortal 3, the function).
// Times, median of 9 calls, measured warm: post 5 to 8 ms, list of 60 jobs 3 to 5 ms. Budgets are about 4 times that, with a floor for a busy laptop.
const BUDGET = { post: 9, signed: 12, list: 4, postMs: 40, listMs: 25 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, listGET: Handler, postPOST: Handler, editPOST: Handler, renewPOST: Handler, closePOST: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number> };

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
const jobCount = async (org: number) => Number((await one("select count(*) n from job where organisation_id = $1", [org])).n);

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
type Member = Login & { mem: number };
type Company = { org: number; owner: Member; recruiter: Member; poster: Member; viewer: Member };
async function company(o: { status?: string; kind?: string; name?: string } = {}): Promise<Company> {
  const org = Number(await F.org({ status: o.status ?? "verified", kind: o.kind, name: o.name ?? "Fake Payments Limited", wrc: o.kind === "agency" ? `EA${++n}` : null }));
  const m = async (role: string, signer: boolean) => { const l = await login(); return { ...l, mem: Number(await F.member(org, l.id, { role, signer })) }; };
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
      expect([r.status, r.json], JSON.stringify(o)).toEqual([409, { code: "STATEMENT_REQUIRED" }]);
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
    expect((await edit(c.owner.cookie, { ...good, jobId: Number(fetched) })).json).toEqual({ code: "JOB_NOT_FOUND" }); // a fetched job of the company is not its post
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

describe("GET /api/portal/jobs", () => {
  it("is 401 without a session, { jobs: null } with no company, and shows only the company's own jobs to every member", async () => {
    expect((await list()).status).toBe(401);
    expect((await list((await login()).cookie)).json).toEqual({ jobs: null });
    const c = await company(), other = await company();
    const mine = (await post(c.owner.cookie, good)).json!.jobId, theirs = (await post(other.owner.cookie, good)).json!.jobId;
    const scam = (await post(c.owner.cookie, { ...good, description: desc + " Candidates must pay a registration fee before the interview." })).json!.jobId;
    for (const m of [c.owner, c.viewer]) {
      const jobs = (await list(m.cookie)).json!.jobs as { id: number; status: string; reason: string | null }[];
      expect(jobs.map((j) => j.id)).toEqual([scam, mine]);
      expect(jobs.find((j) => j.id === scam)).toMatchObject({ status: "in_review", reason: "staff_check" });
      expect(jobs.map((j) => j.id)).not.toContain(theirs);
    }
    await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [c.viewer.mem]);
    expect((await list(c.viewer.cookie)).json).toEqual({ jobs: null });
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
    expect((await edit(c.owner.cookie, { ...good, jobId: "1" })).status).toBe(400);
    expect(await jobCount(c.org)).toBe(0);
  });
  it("limits a login to 30 writes in the window", async () => {
    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await renew(c.owner.cookie, { jobId: 999999999 })).status);
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
    occupationCode: "6145", salaryLow: 33000, salaryHigh: null, permitType: "general", statement: signed };
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
    expect(await job(r.json!.jobId)).toMatchObject({ permit_type: "general", badge: "sponsor_confirmed", pass_route: "stated_pay", sector: "other", status: "live" });
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
    expect((await edit(c.owner.cookie, { ...care, jobId: 1, permitType: "nope" })).status).toBe(400);
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
