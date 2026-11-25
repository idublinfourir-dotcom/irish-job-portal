// Step 16 page slice P20 (employer permit services): the pages' server code and the routes their forms call, on the test database with real portal sessions. Only Next's own request
// context is stood in (server-only, next/headers, redirect, notFound); no test reaches the network. Fake people and companies only. Also holds the statement and time budgets of the pages
// (check 5) and the role, hostile input and exposure tests (check 6).
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { counted, median } from "./staff-routes-harness";

const ctx = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => ctx.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ replace() {}, refresh() {} }),
}));

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
const secret = "trial-only-secret-trial-only-secret-32", BASE = "http://localhost:3001";
const BUDGET = { listStatements: 12, caseStatements: 22, requestStatements: 12, ms: 120 }; // measured 25 Nov 2026: list 8 statements, case page 17, request page 8; medians 4 to 10 ms of 9 warm renders

type El = { props: Record<string, unknown> };
type Handler = (r: Request) => Promise<Response>;
type Page = (p: never) => Promise<El>;
let db: TestDb, su: pg.Pool, AUTH: { POST: Handler };
let F: { org(o?: object): Promise<number>; member(org: string | number, user: string | null, o?: object): Promise<number>; text(p?: string): Promise<string>; staff(): Promise<string> };
let List: Page, Case: Page, NewPage: Page;
let CASES: { POST: Handler }, WITHDRAW: { POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  await F.text("services_request"); await F.text("employer_contact");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret, CANDIDATE_AUTH_URL: "https://candidates.example.test" });
  const app = "../../../apps/portal/app";
  AUTH = (await import(`${app}/api/auth/portal/[...all]/route`)) as typeof AUTH;
  CASES = await import(/* @vite-ignore */ `${app}/api/portal/cases/route`);
  WITHDRAW = await import(/* @vite-ignore */ `${app}/api/portal/cases/[id]/withdraw/route`);
  List = (await import(/* @vite-ignore */ `${app}/services/page`)).default;
  Case = (await import(/* @vite-ignore */ `${app}/services/[id]/page`)).default;
  NewPage = (await import(/* @vite-ignore */ `${app}/services/request/page`)).default;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const ip = () => `198.51.100.${(++n % 200) + 10}`;
const PASSWORD = "Fake-password-12345";
const html = (e: El) => renderToStaticMarkup(e as never).replaceAll("<!-- -->", "");
const text = (e: El) => html(e).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const post = (path: string, body: unknown) => AUTH.POST(new Request(`${BASE}/api/auth/portal/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip() }, body: JSON.stringify(body) }));
type Who = { id: string; cookie: string };
async function login(): Promise<Who> {
  const email = `fake.p20.${++n}.${Date.now().toString(36)}@fakehotels.example.test`;
  expect((await post("sign-up/email", { email, password: PASSWORD, name: "Fake Person", ...portalAnswers })).status).toBe(200);
  const id = (await su.query("select id from portal_user where email=$1", [email])).rows[0].id as string;
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const s = await post("sign-in/email", { email, password: PASSWORD });
  expect(s.status).toBe(200);
  return { id, cookie: s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
/** A verified company with one login per role (owner, recruiter, poster, viewer). */
async function company() {
  const org = String(await F.org({ status: "verified" })), who: Record<string, Who> = {};
  for (const role of ["account_owner", "recruiter", "poster", "viewer"]) { who[role] = await login(); await F.member(org, who[role].id, { role, signer: role === "account_owner" }); }
  return { org, ...who } as { org: string; account_owner: Who; recruiter: Who; poster: Who; viewer: Who };
}
const as = (w: Who | null) => { ctx.headers = new Headers({ ...(w ? { cookie: w.cookie } : {}), "x-vercel-forwarded-for": ip() }); };
const q = (p: Record<string, string> = {}) => ({ searchParams: Promise.resolve(p) }) as never;
const id = (v: string) => ({ params: Promise.resolve({ id: v }) }) as never;
const lands = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { const x = e as Error & { url?: string }; return x.url ? `${x.message} ${x.url}` : x.message; } return null; };
const BODY = { permitType: "critical_skills", offerDetails: { occupationCode: "2231", annualPay: "45000", relevantDegree: "true" }, servicesConsent: true };
const request = (w: Who, body: object = {}, key = `key-${Date.now()}-${++n}-abcdefgh`) => CASES.POST(new Request(`${BASE}/api/portal/cases`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: w.cookie, "x-vercel-forwarded-for": ip() }, body: JSON.stringify({ ...BODY, idempotencyKey: key, ...body }) }));
async function ask(w: Who) { const r = await request(w); expect(r.status).toBe(200); return ((await r.json()) as { case: { id: string } }).case.id; }

describe("the permit services pages on the real database", () => {
  it("the list: the requester and a recruiter see the company's case, a poster and a viewer see the refusal, another company sees nothing, signed out goes to sign-in", async () => {
    const a = await company(), b = await company();
    const c = await ask(a.account_owner);
    for (const w of [a.account_owner, a.recruiter]) {
      as(w);
      const el = await List(q());
      expect((el.props.cases as { id: string }[]).map((x) => x.id)).toEqual([c]);
      expect(html(el)).toContain(`href="/services/${c}"`);
    }
    for (const w of [a.poster, a.viewer]) { as(w); expect(text(await List(q()))).toContain("Not open to your role"); }
    as(b.account_owner);
    expect(text(await List(q()))).toContain("No permit cases yet");
    as(null);
    expect(await lands(() => List(q()))).toMatch(/^NEXT_REDIRECT \/sign-in/);
    as(a.account_owner);
    expect((await List(q({ after: "forged token!" }))).props.nextHref).toBeNull(); // a token outside the alphabet is not passed on
    expect(text(await List(q({ after: "forgedtoken" })))).toContain("could not be loaded"); // a forged paging token is 400 BAD_REQUEST
  });

  it("one case: the requester has the copies, upload and withdraw; a recruiter reads the case only; another company, a missing case and a bad id are the same 404", async () => {
    const a = await company(), b = await company();
    const c = await ask(a.account_owner), staff = await F.staff();
    await su.query("insert into case_event(case_id, kind, status, staff_user_id, detail) values ($1, 'assigned', 'received', $2, $3), ($1, 'documents_needed', 'documents_needed', $2, $4)",
      [c, staff, JSON.stringify({ assignedStaffUserId: staff }), JSON.stringify({ documentsNeeded: ["offer_letter", "degree"] })]);
    await su.query("update services_case set status = 'documents_needed', documents_needed = $2 where id = $1", [c, ["offer_letter", "degree"]]);
    await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1, $2, 'Secret staff note')", [c, staff]);
    await su.query("insert into portal_case_document(services_case_id, storage_key, file_name, content_type, byte_size, portal_user_id) values ($1, 'case/k1', 'offer.pdf', 'pdf', 1000, $2)", [c, a.account_owner.id]);
    as(a.account_owner);
    const mine = await Case(id(c));
    expect(mine.props).toMatchObject({ requester: true });
    for (const w of ["Documents needed", "Job offer letter", "Degree or qualification", "offer.pdf", "We asked you for: Job offer letter, Degree or qualification", "Request received", "Copies only, never originals.", "Withdraw this request"]) expect(text(mine)).toContain(w);
    expect(html(mine)).toMatch(/href="\/api\/portal\/cases\/\d+\/documents\/\d+"/);
    for (const bad of [staff, "Fake Staff", "Secret", "assignedStaffUserId", "case/k1", "Needed from"]) expect(html(mine)).not.toContain(bad);
    as(a.recruiter);
    const theirs = await Case(id(c));
    expect(theirs.props).toMatchObject({ requester: false, docs: [] });
    expect(text(theirs)).toContain("Documents needed");
    expect(text(theirs)).not.toContain("offer.pdf");
    expect(text(theirs)).not.toContain("Withdraw this request");
    expect(text(theirs)).not.toContain("Copies only"); // no upload box for someone who did not ask
    for (const w of [a.poster, a.viewer]) { as(w); expect(text(await Case(id(c)))).toContain("Not open to your role"); }
    as(b.account_owner);
    expect(await lands(() => Case(id(c)))).toBe("NEXT_NOT_FOUND");
    expect(await lands(() => Case(id("999999999")))).toBe("NEXT_NOT_FOUND");
    for (const bad of ["abc", "1 or 1=1", "%00", "1".repeat(30), "-1"]) expect(await lands(() => Case(id(bad))), bad).toBe("NEXT_NOT_FOUND");
    as(null);
    expect(await lands(() => Case(id(c)))).toMatch(/^NEXT_REDIRECT \/sign-in/);
  });

  it("withdraw: only the requester; the page then shows the ended case with no upload or withdraw", async () => {
    const a = await company();
    const c = await ask(a.account_owner);
    const w = (who: Who) => WITHDRAW.POST(new Request(`${BASE}/api/portal/cases/${c}/withdraw`, { method: "POST", headers: { origin: BASE, cookie: who.cookie, "x-vercel-forwarded-for": ip() } }), id(c));
    const refused = await w(a.recruiter);
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([403, "NOT_REQUESTER"]);
    expect((await w(a.account_owner)).status).toBe(200);
    as(a.account_owner);
    const el = await Case(id(c));
    expect(text(el)).toContain("Request withdrawn");
    expect(text(el)).not.toContain("Withdraw this request");
    expect(text(el)).not.toContain("Copies only");
  });

  it("the request: the form's body is accepted by the real route with its free check; a second send of the same key opens the same case; a poster, a viewer and the sixth open case are refused; hostile values are refused", async () => {
    const { buildRequest } = await import("../../../apps/portal/app/services/request/build");
    const a = await company();
    const key = "form-key-0000000000000001";
    const body = buildRequest({ permitType: "general", occupationCode: "2231", annualPay: "45000", relevantDegree: "yes", degreeAwardMonth: "2020-06", contractMonths: "", title: "Fake Nurse", jobId: "" }, key);
    const send = (w: Who) => CASES.POST(new Request(`${BASE}/api/portal/cases`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: w.cookie, "x-vercel-forwarded-for": ip() }, body: JSON.stringify(body) }));
    const first = (await (await send(a.account_owner)).json()) as { case: { id: string; permitType: string }; freeCheck: { qualifies: boolean } | null; replayed: boolean };
    expect(first).toMatchObject({ case: { permitType: "general" }, replayed: false });
    expect(first.freeCheck).not.toBeNull();
    const again = (await (await send(a.account_owner)).json()) as { case: { id: string }; replayed: boolean };
    expect([again.case.id, again.replayed]).toEqual([first.case.id, true]);
    for (const w of [a.poster, a.viewer]) { const r = await request(w); expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([403, "ROLE_REFUSED"]); }
    for (const bad of [{ permitType: "x" }, { offerDetails: { annualPay: "1".repeat(501) } }, { servicesConsent: false }, { jobId: "999999999" }, { idempotencyKey: "short" }]) expect((await request(a.account_owner, bad)).status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    for (let i = 0; i < 4; i++) await ask(a.account_owner); // the first one above and these four make five
    const sixth = await request(a.account_owner);
    expect([sixth.status, ((await sixth.json()) as { code: string }).code]).toEqual([409, "CASE_LIMIT"]);
  });

  it("the request page: the owner and a recruiter get the occupations and the live jobs; a poster, a viewer and a signed-out visitor do not", async () => {
    const a = await company();
    const live = await liveJob(a.org);
    for (const w of [a.account_owner, a.recruiter]) {
      as(w);
      const el = await (NewPage as unknown as () => Promise<El>)();
      const p = (el as El).props as { occupations: unknown[]; jobs: { id: string }[] };
      expect(p.occupations.length).toBeGreaterThan(100);
      expect(p.jobs.map((j) => j.id)).toEqual([live]);
    }
    for (const w of [a.poster, a.viewer]) { as(w); expect(text(await (NewPage as unknown as () => Promise<El>)())).toContain("Not open to your role"); }
    as(null);
    expect(await lands(() => (NewPage as unknown as () => Promise<El>)())).toMatch(/^NEXT_REDIRECT \/sign-in/);
  });
});

async function liveJob(org: string): Promise<string> {
  const mk = async (title: string, status: string) => String((await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, salary_low, salary_high, quota_full, status, closes_at, own_page_url, search_vector)
     values ($1,'employer',$2,$3,'Fake Hotels Limited','Cork','health','2231','critical_skills','critical_skills_eligible',45000,45000,false,$4, now() + interval '20 days','https://example.test/apply', to_tsvector('english',$3)) returning id`, [org, (await su.query("insert into job_source(kind, board) values ('portal', $1) returning id", [`board-${++n}`])).rows[0].id, title, status])).rows[0].id);
  await mk("Closed Cook", "closed");
  return mk("Live Cook", "live");
}

describe("performance", () => {
  it("the list, the case page and the request page stay within their statement and time budgets", async () => {
    const a = await company();
    const c = await ask(a.account_owner);
    as(a.account_owner);
    const RequestPage = NewPage as unknown as () => Promise<El>;
    await List(q()); await Case(id(c)); await RequestPage();
    const [, listN] = await counted(() => List(q())), [, caseN] = await counted(() => Case(id(c))), [, reqN] = await counted(() => RequestPage());
    const listMs = await median(() => List(q())), caseMs = await median(() => Case(id(c))), reqMs = await median(() => RequestPage());
    process.stdout.write(`p20 list: ${listN} statements, ${listMs.toFixed(1)} ms; case: ${caseN}, ${caseMs.toFixed(1)} ms; request: ${reqN}, ${reqMs.toFixed(1)} ms\n`);
    expect([listN <= BUDGET.listStatements, caseN <= BUDGET.caseStatements, reqN <= BUDGET.requestStatements]).toEqual([true, true, true]);
    for (const ms of [listMs, caseMs, reqMs]) expect(ms).toBeLessThanOrEqual(BUDGET.ms);
  });
});
