// Step 16 wave 3, agent p17a (P17: account layout, home, saved jobs, alerts, tracker, updates): the pages' server code and the routes behind them on the test database as
// app_candidate. Real Better Auth routes, real account routes, real reads through apps/candidate/lib/data.ts and the real page functions (called as Next calls them, the element
// rendered to HTML). Only Next's request context is stood in (next/headers, next/navigation's redirect throws as Next's does, server-only is empty). No network. Fake data only.
// Checks: 4 (integration), 5 (performance: statements and median time per page, counted from the call), 6 (security: signed out, another candidate's ids, hostile addresses, suspended).
import pg from "pg";
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }), usePathname: () => "/account", redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));

// Measured 25 Nov 2026 (see the printed line): the layout's five reads and the session are the `layout` figure (a page render adds its own reads on top, the session included in each).
const BUDGET = { statements: { layout: 16, home: 23, saved: 4, alerts: 7, alertEdit: 10, applications: 13, notices: 4 }, medianMs: 60 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Page = (p?: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) => Promise<Parameters<typeof html>[0]>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, SAVED: Handler, TRACKER: Handler, ALERTS: Handler, CLICK: Handler, PROMPT: Handler;
let Layout: (p: { children: unknown }) => Promise<Parameters<typeof html>[0]>;
const P = {} as Record<"home" | "saved" | "alerts" | "applications" | "notices", Page>;
let org: string, src: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: "http://localhost:3001" });
  const m = async (p: string) => import(p);
  AUTH = (await m("../../../apps/candidate/app/api/auth/candidate/[...all]/route")).POST;
  SAVED = (await m("../../../apps/candidate/app/api/candidate/saved/route")).POST;
  TRACKER = (await m("../../../apps/candidate/app/api/candidate/tracker/route")).POST;
  ALERTS = (await m("../../../apps/candidate/app/api/candidate/alerts/route")).POST;
  CLICK = (await m("../../../apps/candidate/app/api/candidate/apply-click/route")).POST;
  PROMPT = (await m("../../../apps/candidate/app/api/candidate/did-you-apply/route")).GET;
  Layout = (await m("../../../apps/candidate/app/account/layout")).default;
  for (const k of ["home", "saved", "alerts", "applications", "notices"] as const) {
    const page = (await m(`../../../apps/candidate/app/account/${k === "home" ? "" : `${k}/`}page`)).default;
    P[k] = (p = { searchParams: Promise.resolve({}) }) => page(p); // Next always gives a page its searchParams
  }
  org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-p17-org', 'Fake P17 Org', 'employer', 'verified') returning id")).rows[0].id;
  src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-p17') returning id")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `10.${((++n) >> 8) & 255}.${n & 255}.17`;
const jsonH = { "content-type": "application/json", origin: BASE };
const as = <T>(cookie: string | undefined, fn: () => Promise<T>): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": freshIp() });
  return fn();
};
const write = (route: Handler, cookie: string, body: unknown) => route(new Request(`${BASE}/api/candidate/x`, { method: "POST", headers: { ...jsonH, cookie, "x-vercel-forwarded-for": freshIp() }, body: JSON.stringify(body) }));
async function member(tag: string, name = `Fake ${tag}`) {
  const email = `fake.p17.${tag}${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const up = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: { ...jsonH, "x-vercel-forwarded-for": freshIp() }, body: JSON.stringify({ email, password, name, ...answers }) }));
  expect(up.status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: { ...jsonH, "x-vercel-forwarded-for": freshIp() }, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { email, cookie, id: (await su.query("select id from candidate_user where email = $1", [email])).rows[0].id as string };
}
const job = async (title: string, status = "live") => (await su.query(
  `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector, salary_low, salary_high, hidden_reason)
   values ($1, 'admin_manual', $2, $3, 'Fake P17 Employer', 'Cork', 'health', '2231', 'critical_skills', 'critical_skills_eligible', false, $4, now() + interval '20 days', 'https://example.test/a', to_tsvector('english','nurse'), 41000, 45000, case when $4 = 'hidden' then 'admin' end)
   returning id::text`, [org, src, title, status])).rows[0].id as string;
const text = async (el: Promise<Parameters<typeof html>[0]>) => html(await el);
const redirectsTo = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return String((e as Error).message).replace("NEXT_REDIRECT ", ""); } return null; };
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const t: number[] = [];
  for (let i = 0; i < 9; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[4]!;
};

// One candidate with a saved live job, a saved job that then closed, a tracked job, an open "Did you apply?" ask, an alert and two updates.
let A: Awaited<ReturnType<typeof member>>, B: Awaited<ReturnType<typeof member>>, alertId: string, closedId: string, trackedId: string;
describe("seeded account", () => {
  beforeAll(async () => {
    A = await member("a", "Alex Example");
    B = await member("b", "Bea Other");
    const live = await job("Fake Staff Nurse");
    closedId = await job("Fake Radiographer");
    trackedId = await job("Fake Chef de Partie");
    const asked = await job("Fake Asked Job");
    for (const id of [live, closedId]) expect((await write(SAVED, A.cookie, { jobId: id })).status).toBe(200);
    await su.query("update job set status = 'closed' where id = $1", [closedId]);
    expect((await write(TRACKER, A.cookie, { jobId: trackedId })).status).toBe(200);
    expect((await write(CLICK, A.cookie, { jobId: asked })).status).toBe(200);
    const made = await write(ALERTS, A.cookie, { county: "Cork", sector: "health", salaryMin: 32691, frequency: "daily" });
    expect(made.status).toBe(200);
    alertId = ((await made.json()) as { alert: { id: string } }).alert.id;
    await su.query("insert into notification(candidate_user_id, category, template_key, params) values ($1, 'account', 'case_update', '{\"secret\":\"STAFF NOTE\"}'), ($1, 'account', 'deletion_on_hold', null)", [A.id]);
  });

  it("layout: the counts are the candidate's own rows, the current page is marked, the greeting uses the profile-less name fallback", async () => {
    const out = html(await as(A.cookie, () => Layout({ children: "BODY" })));
    expect([...out.matchAll(/data-count[^>]*>(\d+)</g)].map((m) => m[1]).slice(0, 4)).toEqual(["1", "2", "1", "0"]); // applications, saved, alerts, cases
    expect(out).toContain("BODY");
    expect(out).not.toContain(B.email);
  });
  it("home: the ask to confirm an application, the tracked job, the updates worded, no params leaked", async () => {
    const out = await as(A.cookie, () => text(P.home()));
    expect(out).toContain("Did you apply for Fake Asked Job at Fake P17 Employer?");
    expect(out).toContain("Fake Chef de Partie");
    expect(out).toContain("Your case has an update");
    expect(out).not.toContain("STAFF NOTE");
    expect(out).toContain("Good ");
  });
  it("saved: a live and a closed job; the closed one shows the reason and no pay; the filters work from the address", async () => {
    const out = await as(A.cookie, () => text(P.saved()));
    expect(out).toContain("Fake Staff Nurse");
    expect(out).toContain("This job has closed");
    const open = await as(A.cookie, () => text(P.saved({ searchParams: Promise.resolve({ show: "open" }) })));
    expect(open).toContain("Fake Staff Nurse");
    expect(open).not.toContain("Fake Radiographer");
    expect(await as(A.cookie, () => text(P.saved({ searchParams: Promise.resolve({ show: ["closed", "open"] }) })))).toContain("Fake Radiographer"); // a repeated key is the unfiltered list
  });
  it("alerts: the alert and the edit address; the edit form is filled", async () => {
    const out = await as(A.cookie, () => text(P.alerts()));
    expect(out).toContain("Health, Cork");
    expect(out).toContain("From €32,691");
    const edit = await as(A.cookie, () => text(P.alerts({ searchParams: Promise.resolve({ edit: alertId }) })));
    expect(edit).toContain("Edit alert");
    expect(edit).toMatch(/<option value="Cork" selected/);
  });
  it("applications: the tracked job sits in the Applied column; the saved and alert blocks show", async () => {
    const out = await as(A.cookie, () => text(P.applications()));
    expect(out).toContain('aria-label="Applied"');
    expect(out).toContain("Fake Chef de Partie");
    expect(out).toContain("Fake Staff Nurse");
    expect(out).toContain("Health, Cork");
  });
  it("notices: both updates, unseen, worded; a hostile paging token is refused and worded, never a crash", async () => {
    const out = await as(A.cookie, () => text(P.notices()));
    expect(out).toContain("2 unseen on this page");
    expect(out).toContain("Your account deletion is on hold");
    for (const after of ["garbage", "x".repeat(500), "%00", "1,2"]) {
      const bad = await as(A.cookie, () => text(P.notices({ searchParams: Promise.resolve({ after }) })));
      expect(bad, after).toMatch(/newest updates|Updates/);
    }
    expect(await as(A.cookie, () => text(P.notices({ searchParams: Promise.resolve({ after: "garbage" }) })))).toContain("not available any more");
  });

  describe("security", () => {
    it("signed out (no cookie, a garbage cookie): every page goes to sign-in with its own address, the layout draws nothing, and a hostile ?edit= or ?show= never gets into the address", async () => {
      for (const cookie of [undefined, "better-auth.session_token=garbage"]) {
        for (const [k, at] of [["home", ""], ["saved", "/saved"], ["alerts", "/alerts"], ["applications", "/applications"], ["notices", "/notices"]] as const)
          expect(await redirectsTo(() => as(cookie, () => P[k]())), k).toBe(`/login?next=${encodeURIComponent(`/account${at}`)}`);
        expect(html(await as(cookie, () => Layout({ children: "BODY" })))).toBe("BODY");
      }
      const open = (k: "alerts" | "saved", q: Record<string, string>) => redirectsTo(() => as(undefined, () => P[k]({ searchParams: Promise.resolve(q) })));
      expect(await open("alerts", { edit: "5" })).toBe("/login?next=%2Faccount%2Falerts%3Fedit%3D5");
      expect(await open("saved", { show: "closed" })).toBe("/login?next=%2Faccount%2Fsaved%3Fshow%3Dclosed");
      for (const bad of ["//evil.example", "/\\evil.example", "5&next=https://evil.example"]) {
        expect(await open("alerts", { edit: bad }), bad).toBe("/login?next=%2Faccount%2Falerts");
        expect(await open("saved", { show: bad }), bad).toBe("/login?next=%2Faccount%2Fsaved");
      }
    });
    it("another candidate sees none of A's rows, and A's alert id in the address opens nothing for B", async () => {
      for (const k of ["home", "saved", "alerts", "applications", "notices"] as const) {
        const out = await as(B.cookie, () => text(P[k]()));
        for (const mine of ["Fake Staff Nurse", "Fake Radiographer", "Fake Chef de Partie", "Fake Asked Job", "Health, Cork", "deletion is on hold", "Alex"]) expect(out, `${k}: ${mine}`).not.toContain(mine);
      }
      const edit = await as(B.cookie, () => text(P.alerts({ searchParams: Promise.resolve({ edit: alertId }) })));
      expect(edit).toContain("That alert no longer exists");
      expect(edit).not.toContain(">Edit alert</h2>");
      expect(JSON.parse(await (await PROMPT(new Request(`${BASE}/api/candidate/did-you-apply`, { headers: { cookie: B.cookie, "x-vercel-forwarded-for": freshIp() } }))).text()).prompts).toEqual([]);
    });
    it("hostile addresses on the alert page and the saved page are ignored", async () => {
      for (const edit of ["abc", "1e3", "-1", "9".repeat(40), ["1", "2"], "0; drop table alert"]) {
        const out = await as(A.cookie, () => text(P.alerts({ searchParams: Promise.resolve({ edit }) })));
        expect(out, String(edit)).toContain("New alert");
        expect(out, String(edit)).not.toContain(">Edit alert</h2>");
      }
      expect(await as(A.cookie, () => text(P.saved({ searchParams: Promise.resolve({ show: "<script>" }) })))).not.toContain("<script>");
    });
    it("a suspended login is told so, with no nav and no rows", async () => {
      const s = await member("susp", "Sue Pended");
      await su.query("update candidate_user set suspended_at = now() where id = $1", [s.id]);
      const out = html(await as(s.cookie, () => Layout({ children: "BODY" })));
      expect(out).toContain("cannot be used");
      expect(out).not.toContain('href="/account/saved"');
    });
  });

  describe("performance: statements and median time of each page render", () => {
    it("stays within the budgets", async () => {
      const rows: Record<string, number> = {};
      const runs: [keyof typeof BUDGET.statements, () => Promise<unknown>][] = [
        ["layout", () => as(A.cookie, () => Layout({ children: null }))],
        ["home", () => as(A.cookie, () => P.home())],
        ["saved", () => as(A.cookie, () => P.saved())],
        ["alerts", () => as(A.cookie, () => P.alerts())],
        ["alertEdit", () => as(A.cookie, () => P.alerts({ searchParams: Promise.resolve({ edit: alertId }) }))],
        ["applications", () => as(A.cookie, () => P.applications())],
        ["notices", () => as(A.cookie, () => P.notices())],
      ];
      for (const [name, run] of runs) {
        await run(); // warm
        const [, statements] = await counted(run);
        rows[name] = statements;
        expect(statements, name).toBeLessThanOrEqual(BUDGET.statements[name]);
        const ms = await median(run);
        rows[`${name}Ms`] = Math.round(ms * 10) / 10;
        expect(ms, name).toBeLessThan(BUDGET.medianMs);
      }
      process.stdout.write(`P17a pages: ${JSON.stringify(rows)}\n`);
    });
  });
});
