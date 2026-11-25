// Step 16 page slice P19 (post a job: /jobs/new and /jobs/<id>/edit) and the "Report the agency" button of the dashboard, on the test database through the real routes of apps/portal with real
// portal sessions. Only Next's own request context is stood in (server-only, next/headers, next/navigation's redirect and notFound); no test reaches the network. Fake people and companies only.
// Also holds the statement and time budgets of the pages and of the check route (check 5) and the role, hostile input and cross-company tests (check 6).
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { savePostingTexts } from "../src/posting-texts-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

const ctx = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => ctx.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
}));

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
// Budgets (check 5), measured 25 Nov 2026 (printed lines): statements per page render and the median of 9 warm renders; about 2 times the statements, and a time floor for a busy laptop.
const BUDGET = { newPage: 18, editPage: 22, check: 10, ms: 250 }; // measured 25 Nov 2026: new page 12, edit page 16 (with a job), check 6 statements; medians 5 to 13 ms (each page reads the session, company, form and job once)

type Handler = (r: Request) => Promise<Response>;
type Page = (p: { params?: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<import("react").ReactElement>;
let db: TestDb, su: pg.Pool, AUTH: Handler, POST: Handler, EDIT: Handler, CHECK: Handler, REPORT: Handler, AGENCY: Handler;
let AUTHORITY: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };
const pages: Record<string, Page> = {};
const load = async (rel: string): Promise<Page> => ((await import(/* @vite-ignore */ `../../../apps/portal/app/${rel}`)) as { default: Page }).default;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  const admin = await db.pool("app_admin").connect();
  try { await savePostingTexts(admin); } finally { admin.release(); }
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret, CANDIDATE_AUTH_URL: "https://candidates.example.test" });
  ({ POST: AUTH } = (await import("../../../apps/portal/app/api/auth/portal/[...all]/route")) as unknown as { POST: Handler });
  ({ POST } = (await import("../../../apps/portal/app/api/portal/jobs/route")) as unknown as { POST: Handler });
  ({ POST: EDIT } = (await import("../../../apps/portal/app/api/portal/jobs/edit/route")) as unknown as { POST: Handler });
  ({ POST: CHECK } = (await import("../../../apps/portal/app/api/portal/jobs/check/route")) as unknown as { POST: Handler });
  ({ POST: REPORT } = (await import("../../../apps/portal/app/api/portal/report/route")) as unknown as { POST: Handler });
  ({ GET: AGENCY } = (await import("../../../apps/portal/app/api/portal/agency-jobs/route")) as unknown as { GET: Handler });
  ({ GET: AUTHORITY } = (await import("../../../apps/portal/app/api/portal/jobs/[id]/authority/route")) as unknown as { GET: typeof AUTHORITY });
  for (const [k, f] of Object.entries({ newJob: "jobs/new/page", edit: "jobs/[id]/edit/page", jobs: "jobs/page", dashboard: "dashboard/page" })) pages[k] = await load(f);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit"); });

let n = 0;
const ip = () => `198.51.101.${(++n % 200) + 10}`;
const post = (path: string, body: unknown) => AUTH(new Request(`${BASE}/api/auth/portal/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip() }, body: JSON.stringify(body) }));
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
type Who = { email: string; id: string; cookie: string };
async function login(): Promise<Who> {
  const email = `fake.p19.${++n}.${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  expect((await post("sign-up/email", { email, password, name: "Fake Person", ...portalAnswers })).status).toBe(200);
  const id = (await one("select id from portal_user where email=$1", [email])).id as string;
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const s = await post("sign-in/email", { email, password });
  expect(s.status).toBe(200);
  return { email, id, cookie: s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
type Co = { org: string; owner: Who; poster: Who; viewer: Who };
/** A verified company with an owner (signer), a poster and a viewer. */
async function company(o: { name?: string; kind?: string } = {}): Promise<Co> {
  const owner = await login(), poster = await login(), viewer = await login();
  const org = String(await F.org({ status: "verified", name: o.name ?? "Fake Kitchens Limited", kind: o.kind, wrc: o.kind === "agency" ? `EA${++n}` : null }));
  await F.member(org, owner.id, { role: "account_owner", signer: true });
  await F.member(org, poster.id, { role: "poster" });
  await F.member(org, viewer.id, { role: "viewer" });
  return { org, owner, poster, viewer };
}
const as = <T>(cookie: string | undefined, fn: () => Promise<T>): Promise<T> => { ctx.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip() }); return fn(); };
type El = import("react").ReactElement<unknown> & { type: (p: unknown) => unknown };
const open = (name: string, cookie: string | undefined, q: Record<string, string | string[] | undefined> = {}, id?: string) => as(cookie, async () => {
  let el = (await pages[name]!({ ...(id !== undefined ? { params: Promise.resolve({ id }) } : {}), searchParams: Promise.resolve(q) })) as unknown as El;
  while (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") el = (await el.type(el.props)) as El;
  return renderToStaticMarkup(el);
});
async function redirectOf(name: string, cookie: string | undefined, q: Record<string, string | string[] | undefined> = {}, id?: string): Promise<string | null> {
  try { await open(name, cookie, q, id); return null; } catch (e) { return (e as { url?: string }).url ?? Promise.reject(e); }
}
const send = async (h: Handler, path: string, cookie: string | undefined, body?: unknown) => {
  const res = await h(new Request(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, json, code: json.code as string | undefined };
};
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => { const ms: number[] = []; for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); } return ms.sort((a, b) => a - b)[4]!; };

const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const good = { status: "live", title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractType: "permanent", salaryLow: 50000, salaryHigh: 60000, ownPageUrl: "https://careers.example.ie/jobs/1" };
const signed = { signerName: "Fake Signer", signerTitle: "HR Director" };
const postJob = (cookie: string, body: unknown) => send(POST, "/api/portal/jobs", cookie, body);
const check = (cookie: string, body: unknown) => send(CHECK, "/api/portal/jobs/check", cookie, body);
const jobsOf = async (org: string) => Number((await one("select count(*) c from job where organisation_id=$1", [org])).c);
let src: string;
/** A closed job of `org` (as postgres), for the repost and the "cannot be edited" tests. */
async function closedJob(org: string, title: string): Promise<string> {
  src ??= (await one("insert into job_source(kind, board) values ('portal', 'portal') returning id::text")).id;
  return (await one(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, close_reason, closed_at, salary_low, closes_at, own_page_url)
     values ($1, 'employer', $2, $3, 'Fake Org', 'it', 'critical_skills', 'closed', 'closed', now(), 40000, now(), 'https://example.test/apply') returning id::text`, [org, src, title])).id;
}

describe("/jobs/new: what each person sees (checks 4 and 6)", () => {
  it("an owner and a poster get the form with the wording in force and the occupation list; a signed-out visitor goes to sign-in and back; no company goes to the claim step", async () => {
    const c = await company();
    const wording = String((await one("select body from consent_text where purpose = 'sponsorship_statement' order by published_at desc, id desc limit 1")).body);
    for (const who of [c.owner, c.poster]) {
      const html = await open("newJob", who.cookie);
      expect(html).toContain("<form"); expect(html).toContain("Publish job"); expect(html).toContain("Save draft"); expect(html).toContain("<datalist id=\"occupation-list\">");
      expect(html).toContain(wording.slice(0, 40).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")); // the statement wording comes from the database, not the page
      expect(html).not.toMatch(/Public pay-scale grade|data-agency|Town or Eircode|Receive applications|>Applied<|Launch B/);
    }
    expect(await redirectOf("newJob", undefined)).toBe("/sign-in?next=%2Fjobs%2Fnew");
    expect(await redirectOf("newJob", (await login()).cookie)).toBe("/sign-up/claim");
  });
  it("a viewer sees why there is no form, and no field", async () => {
    const c = await company();
    const html = await open("newJob", c.viewer.cookie);
    expect(html).toContain("Your role cannot post jobs"); expect(html).not.toMatch(/<form|<input|Publish job/);
    expect(await open("edit", c.viewer.cookie, {}, "1")).not.toMatch(/<form|<input/);
  });
  it("a public pay employer gets the grade picker; an agency never does, and sees who the permit employer is; an employer sees no agency block", async () => {
    const hse = await company({ name: "Health Service Executive", kind: "public_body" });
    expect(await open("newJob", hse.owner.cookie)).toContain("Public pay-scale grade");
    const hseAgency = await company({ name: "Health Service Executive", kind: "agency" });
    const ag = await open("newJob", hseAgency.owner.cookie);
    expect(ag).not.toContain("Public pay-scale grade"); expect(ag).toContain("data-agency"); expect(ag).toContain("The client");
    expect(await open("newJob", (await company()).owner.cookie)).not.toContain("data-agency");
  });
  it("hostile ?from values are ignored; another company's job is a 404 and so is an id that does not exist, the same way", async () => {
    const c = await company(), other = await company({ name: "Fake Other Limited" });
    const theirs = await closedJob(other.org, "Fake Their Job"), mine = await closedJob(c.org, "Fake Closed Chef");
    for (const bad of ["abc", "0", "1".repeat(40), "../x", "1 or 1=1"]) expect(await open("newJob", c.owner.cookie, { from: bad }), bad).toContain('value=""');
    await expect(open("newJob", c.owner.cookie, { from: theirs })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(open("newJob", c.owner.cookie, { from: "999999999" })).rejects.toThrow("NEXT_NOT_FOUND");
    const repost = await open("newJob", c.owner.cookie, { from: mine });
    expect(repost).toContain("Post this job again"); expect(repost).toContain('value="Fake Closed Chef"');
  });
});

describe("/jobs/[id]/edit", () => {
  it("a draft opens with what was saved; another company's job, a bad id and a missing one are the same 404; a closed job cannot be edited and links to repost", async () => {
    const c = await company(), other = await company({ name: "Fake Other Limited" });
    const d = await postJob(c.poster.cookie, { status: "draft", title: "Fake Draft Chef", county: "Kerry", salaryLow: 41000 });
    expect([d.status, d.json.status]).toEqual([200, "draft"]);
    const html = await open("edit", c.poster.cookie, {}, String(d.json.jobId));
    expect(html).toContain("Edit job"); expect(html).toContain('value="Fake Draft Chef"'); expect(html).toContain('value="41000"'); expect(html).toContain("Publish job");
    const theirs = String((await postJob(other.owner.cookie, { status: "draft", title: "Fake Their Draft" })).json.jobId);
    for (const id of [theirs, "999999999", "abc", "-1", "1".repeat(30)]) await expect(open("edit", c.owner.cookie, {}, id), id).rejects.toThrow("NEXT_NOT_FOUND");
    const closed = await closedJob(c.org, "Fake Closed One");
    const gone = await open("edit", c.owner.cookie, {}, closed);
    expect(gone).toContain("This job is closed"); expect(gone).toContain(`/jobs/new?from=${closed}`); expect(gone).not.toContain("<form");
    expect(await redirectOf("edit", undefined, {}, d.json.jobId)).toBe(`/sign-in?next=${encodeURIComponent(`/jobs/${d.json.jobId}/edit`)}`);
  });
  it("the saved line shows for the states a save ends in and for nothing else", async () => {
    const c = await company();
    expect(await open("jobs", c.owner.cookie, { saved: "in_review" })).toContain("Our team checks the job before it goes live");
    expect(await open("jobs", c.owner.cookie, { saved: "draft" })).toContain("Draft saved");
    const html = await open("jobs", c.owner.cookie, { saved: "<script>alert(1)</script>" });
    expect(html).not.toMatch(/<script>alert|Draft saved|Our team checks/);
    expect(await open("jobs", c.owner.cookie)).toContain('href="/jobs/new"'); // the switch is on
  });
});

describe("the routes the form calls (checks 4 and 6)", () => {
  it("the check lists every check and writes nothing; below the minimum is a 422 with the same list; a viewer is refused", async () => {
    const c = await company();
    const before = await jobsOf(c.org);
    const ok = await check(c.owner.cookie, good);
    expect(ok.status).toBe(200); expect(ok.json.checks.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["occupation", "contract", "wording", "money", "pay"]));
    const low = await check(c.owner.cookie, { ...good, salaryLow: 20000, salaryHigh: undefined });
    expect([low.status, low.code]).toEqual([422, "PAY_BELOW_MINIMUM"]);
    expect(low.json.checks.find((x: { id: string }) => x.id === "pay")).toMatchObject({ state: "blocked", code: "PAY_BELOW_MINIMUM", detail: { countedEur: 20000 } });
    expect(await jobsOf(c.org)).toBe(before);
    expect((await check(c.viewer.cookie, good)).code).toBe("NOT_A_POSTER");
    expect((await check(c.poster.cookie, { ...good, ownPageUrl: "http://careers.example.ie" })).status).toBe(400); // https only
    expect((await send(CHECK, "/api/portal/jobs/check", undefined, good)).status).toBe(401);
  });
  it("a draft needs only a title; a viewer cannot save; the edit changes the draft and publishes it; a refused post leaves no row", async () => {
    const c = await company();
    const d = await postJob(c.poster.cookie, { status: "draft", title: "Fake Half Job" });
    expect([d.status, d.json.status]).toEqual([200, "draft"]);
    expect((await postJob(c.viewer.cookie, { status: "draft", title: "Fake Viewer Job" })).code).toBe("NOT_A_POSTER");
    const before = await jobsOf(c.org);
    expect((await postJob(c.owner.cookie, { ...good, salaryLow: 20000, salaryHigh: undefined })).code).toBe("PAY_BELOW_MINIMUM");
    expect(await jobsOf(c.org)).toBe(before);
    const live = await send(EDIT, "/api/portal/jobs/edit", c.poster.cookie, { ...good, jobId: String(d.json.jobId) });
    expect([live.status, live.json.status]).toEqual([200, "live"]);
    const other = await company({ name: "Fake Other Limited" });
    expect((await send(EDIT, "/api/portal/jobs/edit", other.owner.cookie, { ...good, jobId: String(d.json.jobId) })).code).toBe("JOB_NOT_FOUND");
  });
  it("an agency job for a client: the client check says not matched and the post goes in review; an employer cannot name a client; the authority tick is needed with the statement", async () => {
    const a = await company({ kind: "agency", name: "Fake Recruitment Limited" }), e = await company();
    const body = { ...good, clientName: "Fake Unknown Client Limited" };
    const c1 = await check(a.owner.cookie, { ...body, statement: { ...signed, writtenAuthority: true } });
    expect(c1.status).toBe(200); expect(c1.json.status).toBe("in_review"); expect(c1.json.checks.find((x: { id: string }) => x.id === "client")).toMatchObject({ state: "note", detail: { found: false } });
    expect((await postJob(a.owner.cookie, { ...body, statement: signed })).code).toBe("WRITTEN_AUTHORITY_REQUIRED");
    const saved = await postJob(a.owner.cookie, { ...body, statement: { ...signed, writtenAuthority: true } });
    expect([saved.status, saved.json.status]).toEqual([200, "in_review"]);
    expect((await postJob(e.owner.cookie, body)).code).toBe("CLIENT_ONLY_FOR_AGENCIES");
    expect((await check(e.owner.cookie, body)).code).toBe("CLIENT_ONLY_FOR_AGENCIES");
    // the edit page of that agency job shows the written authority panel; an employer's job never does
    const html = await open("edit", a.owner.cookie, {}, String(saved.json.jobId));
    expect(html).toContain('value="Fake Unknown Client Limited"'); expect(html).toContain("Copies of the client");
    // the authority list route: the agency's own client job answers, an employer's job, a viewer and another company get the same 404
    const list = (cookie: string, id: string) => as(cookie, async () => { const r = await AUTHORITY(new Request(`${BASE}/api/portal/jobs/${id}/authority`, { headers: { cookie } }), { params: Promise.resolve({ id }) }); return { status: r.status, json: (await r.json()) as { code?: string; documents?: unknown[] } }; });
    expect(await list(a.owner.cookie, String(saved.json.jobId))).toEqual({ status: 200, json: { documents: [] } });
    const mine = String((await postJob(e.owner.cookie, good)).json.jobId);
    for (const [cookie, id] of [[e.owner.cookie, mine], [a.viewer.cookie, String(saved.json.jobId)], [e.owner.cookie, String(saved.json.jobId)]] as const) expect((await list(cookie, id)).json.code, id).toBe("JOB_NOT_FOUND");
  });
  it("a Critical Skills job can be signed by a signer and is refused to a poster who is not one; the wording sent back is only the signer's name and role", async () => {
    const c = await company();
    const r = await postJob(c.owner.cookie, { ...good, statement: signed });
    expect([r.status, r.json.badge]).toEqual([200, "sponsor_confirmed"]);
    expect((await postJob(c.poster.cookie, { ...good, statement: signed })).code).toBe("NOT_A_SIGNER");
    expect((await postJob(c.owner.cookie, { ...good, statement: { ...signed, text: "my own wording" } })).status).toBe(400); // nothing but the signer fields is accepted
  });
});

// The "Report the agency" button (the dashboard's agency list): the client reports the agency with its company id from the agency-jobs read.
describe("Report the agency", () => {
  it("the client's dashboard offers it on an agency job; the report names the agency, is filed once, takes only a company reason, and a viewer may report too", async () => {
    const client = await company({ name: "Fake Client Limited" }), agency = await company({ kind: "agency", name: "Fake Recruitment Limited" });
    await su.query("insert into organisation_name(organisation_id,name,normalised_name,kind,source) values ($1,'Fake Client Limited','fake client limited','legal','admin')", [client.org]);
    const posted = await postJob(agency.owner.cookie, { ...good, clientName: "Fake Client Limited", statement: { ...signed, writtenAuthority: true } });
    expect([posted.status, posted.json.status]).toEqual([200, "live"]);
    const list = await send(AGENCY, "/api/portal/agency-jobs", client.owner.cookie);
    expect(list.json.jobs).toHaveLength(1); expect(list.json.jobs[0].agencyId).toBe(agency.org);
    const dash = await open("dashboard", client.owner.cookie);
    expect(dash).toContain("Report the agency"); expect(dash).toContain("Fake Recruitment Limited"); expect(dash).toContain("I do not recognise this job");
    const viewerDash = await open("dashboard", client.viewer.cookie);
    expect(viewerDash).toContain("Report the agency"); expect(viewerDash).not.toContain("I do not recognise this job"); // the owner's button only
    const report = (cookie: string, body: unknown) => send(REPORT, "/api/portal/report", cookie, body);
    expect((await report(client.owner.cookie, { companyId: agency.org, reason: "job_closed" })).status).toBe(400); // a job reason does not fit a company
    const filed = await report(client.owner.cookie, { companyId: agency.org, reason: "fake_company", evidence: "They never told us about this job." });
    expect(filed.status).toBe(200);
    expect(await one("select target_kind, reason, reporter_portal_user_id from report where target_organisation_id = $1", [agency.org])).toEqual({ target_kind: "organisation", reason: "fake_company", reporter_portal_user_id: client.owner.id }); // the agency is the target, the reporter is stored for staff only
    expect((await report(client.owner.cookie, { companyId: agency.org, reason: "fake_company" })).code).toBe("ALREADY_REPORTED");
    expect((await report(client.viewer.cookie, { companyId: agency.org, reason: "other" })).status).toBe(200);
    expect((await report(client.owner.cookie, { companyId: "999999999", reason: "other" })).code).toBe("COMPANY_NOT_FOUND");
    expect((await send(REPORT, "/api/portal/report", undefined, { companyId: agency.org, reason: "other" })).status).toBe(401);
  });
});

describe("performance: statements and time of the posting pages and the check (check 5)", () => {
  it("each stays inside its statement budget and median time", async () => {
    const c = await company();
    const id = String((await postJob(c.owner.cookie, good)).json.jobId);
    const rows: [string, () => Promise<unknown>, number][] = [
      ["new page", () => open("newJob", c.owner.cookie), BUDGET.newPage], ["edit page", () => open("edit", c.owner.cookie, {}, id), BUDGET.editPage], ["check", () => check(c.owner.cookie, good), BUDGET.check],
    ];
    for (const [label, run, limit] of rows) {
      await run(); // warm
      const [, statements] = await counted(run);
      const ms = await median(run);
      console.log(`P19 ${label}: ${statements} statements, median ${ms.toFixed(1)} ms`);
      expect(statements, label).toBeLessThanOrEqual(limit);
      expect(ms, label).toBeLessThan(BUDGET.ms);
    }
  });
});
