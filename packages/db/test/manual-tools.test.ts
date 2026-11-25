// Integration: the manual posting tools (B72) through the real admin route handlers, real staff sessions and the real test database as app_admin: the company search,
// the dry run, one's own posts, and the later two-person "Sponsor confirmed" (#232, Q6) with what the pages need to show it. Every role is tried, and hostile input.
// memoryStore() is the file store; no network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryStore, setFileStore } from "../src/file-store";
import { PDF } from "../src/file-fixture";
import { MANUAL_COMPANIES } from "../src/manual-posting";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { assertPageBudget, measurePages } from "./perf/pages";
import { BASE, counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements per call, requireStaff's 2 included (25 Nov 2026): search 4 (role check, query), dry run 8 (begin, role check, company, closing date, rules, commit),
// create 11 (the rules are read fresh since B66, it was 10). Times are medians of 9 warm calls with a floor for a busy laptop. Pages: the search over 3,000 companies.
const BUDGET = { search: 4, dryRun: 8, create: 11, searchMs: 40, dryRunMs: 40, searchPages: 400 };

const spec = loadSpec("admin");
const J = "/api/manual-jobs", D = "/api/manual-jobs/dry-run", C = "/api/manual-jobs/companies", S = "/api/manual-jobs/sponsor-confirmation";
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
let manual: Route, dry: { POST: (r: Request) => Promise<Response> }, companies: Route, sponsor: Route;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number>; text(p: string): Promise<string> };
const AR = "account_reviewer", NOT_AR = [...ROLE_NAMES.filter((r) => r !== AR), "norole"];
const one = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  manual = await import("../../../apps/admin/app/api/manual-jobs/route");
  dry = await import("../../../apps/admin/app/api/manual-jobs/dry-run/route");
  companies = await import("../../../apps/admin/app/api/manual-jobs/companies/route");
  sponsor = await import("../../../apps/admin/app/api/manual-jobs/sponsor-confirmation/route");
  for (const r of ROLE_NAMES) await h.makeStaff(r, [r]);
  await h.makeStaff("ar2", [AR]);
  await h.makeStaff("ar_ad", [AR, "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", [AR]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  setFileStore(memoryStore());
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const post = (org: number | string, o: object = {}) => ({ organisationId: String(org), title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractMonths: null, salaryLow: 50000,
  salaryHigh: 60000, weeklyHours: 39, closesOn: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10), applyUrl: "https://careers.example.ie/jobs/1", ...o });
const create = (who: string, org: number, o: object = {}) => h.ok(h.call(manual, J, who, { action: "create", ...post(org, o) }));
const dryRun = (who: string | null, body: unknown, o: object = {}) => h.call(dry as unknown as Route, D, who, body, o);
const find = (who: string | null, q: string) => h.call(companies, C, who, undefined, { query: q });

describe("the company search", () => {
  it("finds the companies a post can be made for, by display name, another name or CRO number; the others are left out; no login or email", async () => {
    const a = await F.org({ name: "Lakeside 100% Care Homes", cro: "765432" });
    await F.member(a, await F.portal());
    const agency = await F.org({ name: "Lakeside Agency", kind: "agency", wrc: "EA-lake" });
    const b = await F.org({ name: "Fake Trading" });
    await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Lakeside Holdings CLG', 'lakeside holdings clg', 'legal', 'admin')", [b]);
    const merged = await F.org({ name: "Lakeside Merged" });
    await su.query("update organisation set merged_into_id = $2 where id = $1", [merged, a]);
    for (const status of ["rejected", "closed", "banned", "suspended"]) await F.org({ name: `Lakeside ${status}`, status });
    await F.org({ name: "Lakeside Public Body", kind: "public_body" });
    const r = await h.ok(find(AR, "?q=lakeSIDE"));
    expect(replyProblems(spec, "GET", C, 200, r)).toEqual([]);
    expect(r.items.map((x: { id: string }) => x.id).sort()).toEqual([a, agency, b].map(String).sort());
    expect(r.more).toBe(false);
    expect(r.items.find((x: { id: string }) => x.id === String(a))).toEqual({ id: String(a), displayName: "Lakeside 100% Care Homes", kind: "employer", croNumber: "765432", status: "verified", county: null });
    expect(JSON.stringify(r)).not.toMatch(/@|portal_user|membership/);
    expect((await h.ok(find(AR, "?q=7654"))).items.map((x: { id: string }) => x.id)).toEqual([String(a)]);
    expect((await h.ok(find(AR, "?q=100%25"))).items.map((x: { id: string }) => x.id)).toEqual([String(a)]); // % is a plain character
    expect((await h.ok(find(AR, "?q=%25%25%25"))).items).toEqual([]);
    // the company it finds is one a post is accepted for
    for (const x of r.items) expect((await h.ok(dryRun(AR, post(x.id)))).status).toBe("live");
    for (let i = 0; i < 11; i++) await F.org({ name: `Manyfold ${i}` });
    const many = await h.ok(find(AR, "?q=manyfold"));
    expect([many.items.length, many.more]).toEqual([10, true]);
  });
  it("only account reviewers; hostile queries are refused", async () => {
    for (const who of NOT_AR) await h.no(find(who, "?q=lakeside"), 403, "not_account_reviewer");
    await h.no(find(null, "?q=lakeside"), 401, "no_session");
    await h.no(find("disabled", "?q=lakeside"), 401, "not_active");
    for (const q of ["", "?q=ab", "?q=%20%20ab%20", `?q=${"x".repeat(101)}`, "?q=ab%00cd", "?q=abc&q=abc", "?q=abc&email=1"]) await h.no(find(AR, q), 400, "bad_query");
    expect((await h.ok(find(AR, "?q=');drop table job;--"))).items).toEqual([]);
  });
});

describe("the dry run", () => {
  it("answers what the post then does, with every check, and writes nothing", async () => {
    const o = await F.org({ name: "Fake Dry Run Ltd" });
    const count = async () => [(await one("select count(*)::int n from job")).n, (await one("select count(*)::int n from audit_event where object_type = 'job'")).n, (await one("select count(*)::int n from job_text")).n];
    const before = await count();
    const good = await h.ok(dryRun(AR, post(o)));
    expect(replyProblems(spec, "POST", D, 200, good)).toEqual([]);
    expect(good).toMatchObject({ status: "live", badge: "critical_skills_eligible", passRoute: "stated_pay", reason: null });
    expect(good.checks.map((c: { id: string; state: string }) => `${c.id} ${c.state}`)).toEqual(["occupation pass", "contract pass", "wording pass", "money pass", "pay pass"]);
    const cases: [object, string][] = [[{ salaryLow: 30000, salaryHigh: null }, "pay_below_minimum"], [{ occupationCode: "4112" }, "occupation_ineligible"], [{ contractMonths: 12 }, "contract_too_short"],
      [{ description: desc + " We cannot offer visa sponsorship." }, "rules_failed"], [{ description: desc + " Candidates must pay a registration fee before the interview." }, "needs_review"]];
    const seen: object[] = [];
    for (const [x, code] of cases) {
      const r = await h.ok(dryRun(AR, post(o, x)));
      expect(replyProblems(spec, "POST", D, 200, r), code).toEqual([]);
      expect(r, code).toMatchObject({ status: "draft", badge: null, passRoute: null, reason: { code } });
      expect(r.checks.some((c: { code?: string }) => c.code === code), code).toBe(true);
      seen.push(r);
    }
    expect(await count()).toEqual(before);
    for (const [i, [x]] of cases.entries()) { const p = await create(AR, o, x); expect({ status: p.status, passRoute: p.passRoute, reason: p.reason }).toEqual({ status: (seen[i] as { status: string }).status, passRoute: null, reason: (seen[i] as { reason: object }).reason }); }
  });
  it("only account reviewers; the post's own refusals; Origin, size, query and odd bodies", async () => {
    const o = await F.org({ name: "Fake Dry Run Two" }), banned = await F.org({ name: "Fake Banned", status: "banned" });
    for (const who of NOT_AR) await h.no(dryRun(who, post(o)), 403, "not_account_reviewer");
    await h.no(dryRun(null, post(o)), 401, "no_session");
    await h.no(dryRun("disabled", post(o)), 401, "not_active");
    await h.no(dryRun(AR, post(banned)), 409, "company_not_postable");
    await h.no(dryRun(AR, post(88888888)), 404, "company_not_found");
    await h.no(dryRun(AR, post(o, { closesOn: "2099-01-01" })), 400, "bad_closing_date");
    await h.no(dryRun(AR, post(o, { title: "a‮b" })), 400, "bad_title");
    await h.no(dryRun(AR, post("1;drop table job")), 400, "bad_organisation_id");
    for (const x of [{ action: "create" }, { badge: "sponsor_confirmed" }, { permitType: "general" }, { namedPerson: "x" }]) await h.no(dryRun(AR, post(o, x)), 400, "bad_body");
    for (const raw of ["[]", "{", "null", "5", `"${"x".repeat(31_000)}"`]) await h.no(dryRun(AR, undefined, { raw }), 400, "bad_body");
    for (const origin of ["https://evil.example", null]) await h.no(dryRun(AR, post(o), { origin }), 403, "bad_origin");
    await h.no(dryRun(AR, post(o), { length: "100000" }), 400, "bad_body");
    await h.no(dryRun(AR, post(o), { query: "?x=1" }), 400, "bad_query");
  });
  it("a pay-deal employer switched off stops passing the pay check at once, in the dry run and in the post (no cached rules)", async () => {
    const name = "beaumont hospital", o = await F.org({ name: "Beaumont Hospital" });
    const nurse = { title: "Staff Nurse", occupationCode: "2231", description: "We are hiring a staff nurse for our hospital in Dublin. Full sponsorship offered.", salaryLow: null, salaryHigh: null, payGrade: "Staff Nurse scale" };
    expect(await h.ok(dryRun(AR, post(o, nurse)))).toMatchObject({ status: "live", passRoute: "public_pay" });
    const set = (patch: object) => su.query("update rules_version set data = jsonb_set(data, array[$1::text], data->$1 || $2::jsonb) where kind = 'public_pay_employers'", [name, JSON.stringify(patch)]);
    await set({ on: false });
    expect(await h.ok(dryRun(AR, post(o, nurse)))).toMatchObject({ status: "draft", reason: { code: "pay_required" } });
    expect(await create(AR, o, nurse)).toMatchObject({ status: "draft", reason: { code: "pay_required" } });
    await set({ on: true });
    expect(await create(AR, o, nurse)).toMatchObject({ status: "live", passRoute: "public_pay" });
  });
});

describe("one's own posts and the later Sponsor confirmed (#232, Q6)", () => {
  const list = async (who: string, q = "") => (await h.ok(h.call(manual, J, who, undefined, { query: q })));
  async function upload(who: string, job: string) {
    const f = new FormData(); f.append("file", new Blob([PDF as Uint8Array<ArrayBuffer>]), "letter.pdf");
    const res = await sponsor.POST!(new Request(`${BASE}${S}?jobId=${job}`, { method: "POST", headers: { cookie: h.signedIn(who), origin: BASE }, body: f }));
    return { status: res.status, json: await res.json() };
  }
  it("mine=true lists only the member's own posts; any other value is refused", async () => {
    const o = await F.org({ name: "Fake Mine Ltd" });
    const mine = (await create("ar2", o)).jobId, theirs = (await create(AR, o)).jobId;
    const r = await list("ar2", "?mine=true");
    expect(replyProblems(spec, "GET", J, 200, r)).toEqual([]);
    expect(r.items.map((x: { id: string }) => x.id)).toEqual([mine]);
    expect((await list("ar2")).items.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([mine, theirs]));
    expect((await list("administrator", "?mine=true")).items).toEqual([]);
    for (const q of ["?mine=false", "?mine=1", "?mine=", "?mine=true&mine=true"]) await h.no(h.call(manual, J, AR, undefined, { query: q }), 400, "bad_query");
  });
  it("the list shows the badge and the waiting request; the confirm list names the post and its company; a draft takes no confirmation", async () => {
    await F.text("sponsorship_statement");
    const o = await F.org({ name: "Fake Sponsor Ltd" });
    const { jobId } = await create("ar_ad", o), draft = (await create("ar_ad", o, { salaryLow: 20000, salaryHigh: null })).jobId;
    const item = async () => (await list("ar_ad", "?mine=true")).items.find((x: { id: string }) => x.id === jobId);
    expect(await item()).toMatchObject({ badge: "critical_skills_eligible", sponsor_request_id: null });
    expect(await upload("ar_ad", draft)).toEqual({ status: 409, json: { error: "job_not_live" } });
    const up = await upload("ar_ad", jobId);
    expect(up.status).toBe(200);
    expect(await item()).toMatchObject({ badge: "critical_skills_eligible", sponsor_request_id: up.json.requestId });
    const waiting = await h.ok(h.call(sponsor, S, "administrator"));
    expect(replyProblems(spec, "GET", S, 200, waiting)).toEqual([]);
    expect(waiting.pending).toEqual([{ requestId: up.json.requestId, jobId, title: "Software Engineer", organisationId: String(o), displayName: "Fake Sponsor Ltd", fileName: "letter.pdf", contentType: "pdf",
      sizeBytes: PDF.length, proposedBy: h.staff.ar_ad, proposedByName: "Fake ar_ad", createdAt: expect.any(String) }]);
    // the same person never confirms: the route, and the database when app_admin writes it directly
    await h.no(h.call(sponsor, S, "ar_ad", { action: "confirm", requestId: up.json.requestId }), 409, "same_person");
    const c = await db.pool("app_admin").connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ar_ad]);
      await expect(c.query("update approval_request set status = 'confirmed' where id = $1", [up.json.requestId])).rejects.toMatchObject({ code: "23514" });
    } finally { await c.query("rollback"); c.release(); }
    await h.ok(h.call(sponsor, S, "administrator", { action: "confirm", requestId: up.json.requestId }));
    expect(await item()).toMatchObject({ badge: "sponsor_confirmed", sponsor_request_id: null });
  });
});

describe("performance", () => {
  it("the search, the dry run and the post stay inside their statement, time and page budgets", async () => {
    await su.query("insert into organisation(slug, display_name, kind, status) select 'perf-' || g, 'Fake Perf Company ' || g, 'employer', 'verified' from generate_series(1, 3000) g");
    await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) select id, display_name || ' Legal', lower(display_name) || ' legal', 'legal', 'admin' from organisation where slug like 'perf-%'");
    await su.query("analyze organisation"); await su.query("analyze organisation_name");
    const o = await F.org({ name: "Fake Perf Post" });
    const [, searchN] = await counted(() => find(AR, "?q=company"));
    const [, dryRunN] = await counted(() => h.ok(dryRun(AR, post(o))));
    const [, createN] = await counted(() => create(AR, o));
    expect({ searchN, dryRunN, createN }).toEqual({ searchN: BUDGET.search, dryRunN: BUDGET.dryRun, createN: BUDGET.create });
    expect(await median(() => find(AR, "?q=company"))).toBeLessThan(BUDGET.searchMs);
    expect(await median(() => dryRun(AR, post(o)))).toBeLessThan(BUDGET.dryRunMs);
    const client = await su.connect();
    try {
      await client.query("begin");
      const pages = await measurePages(client, [{ text: MANUAL_COMPANIES, values: ["%nothing like it%", "nothing%", ["closed"]] }]);
      console.log(`manual company search: ${pages[0]!.pages} pages`);
      assertPageBudget("manual company search", pages, BUDGET.searchPages);
    } finally { await client.query("rollback"); client.release(); }
  });
});
