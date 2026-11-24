// B58: the staff search (GET /api/search) through the admin app's real route handler on the real test database as app_admin, with real staff sessions.
// Every one of the seven roles, a login with no role, a disabled login and a signed-out visitor; hostile text; the fields a role may see; the limit and "more".
// Budget (measured 24 Nov 2026, printed below), statements through the route: a text search is 2 (session) + 1 (roles) + one per kind it may search that the text can match
// (an administrator 5, a company role 5, a case handler 3: a case needs an id); a case id as an administrator 6. The 100,000-job time budget is in perf/staff-search.perf.ts. Fake people only; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { counted, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BUDGET = { administrator: 5, company: 5, handler: 3, administratorById: 6 };
const COMPANY = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "administrator"];
const CASE = ["services_case_handler", "administrator"];

let db: TestDb, su: pg.Pool, h: Awaited<ReturnType<typeof staffHarness>>, R: Route;
let F: { cand: () => Promise<string>; text: (p: string) => Promise<string> };
let caseId: string, closedCaseId: string, jobId: string;
const enc = encodeURIComponent;
const search = (who: string | null, q: string) => h.call(R, "/api/search", who, undefined, { query: `?q=${enc(q)}` });
const ok = (who: string | null, q: string) => h.ok(search(who, q));

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  for (const r of ROLE_NAMES) await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("gone", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]);
  R = await import("../../../apps/admin/app/api/search/route");

  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  const org = async (name: string, o: { cro?: string; merged?: boolean; kind?: string; status?: string } = {}) => {
    const into = o.merged ? (await su.query("select min(id) id from organisation")).rows[0].id : null;
    return (await su.query("insert into organisation(slug, display_name, kind, status, cro_number, merged_into_id) values ($1,$2,$3,$4,$5,$6) returning id::text id",
      [name.toLowerCase().replace(/\W+/g, "-") + Math.random().toString(36).slice(2, 6), name, o.kind ?? "employer", o.status ?? "verified", o.cro ?? null, into])).rows[0].id as string;
  };
  await su.query("select setval(pg_get_serial_sequence('job', 'id'), 1000), setval(pg_get_serial_sequence('services_case', 'id'), 2000)"); // ids of 3 or more digits: a text under 3 characters is refused
  const first = await org("Fake Aardvark Ltd", { cro: "700001" });
  await org("Fake Orchard Foods Ltd", { cro: "700123" });
  await org("Fake Orchard 100% Ltd", { cro: "700124", status: "banned" });
  await org("Fake Under_score Ltd", { cro: "700125", kind: "agency" });
  await org("Fake Back\\slash Ltd");
  await org("Fake Orchard Merged Ltd", { merged: true });
  for (let i = 0; i < 12; i++) await org(`Fake Crowd ${String(i).padStart(2, "0")} Ltd`);
  const job = async (title: string, status: string, employer = "Fake Orchard Foods Ltd", county: string | null = "Cork") =>
    (await su.query(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector, hidden_reason)
       values ($1, 'employer', $2, $3, $4, $5, 'IT', 'critical_skills', $6, now() + interval '20 days', 'https://example.test', 40000, to_tsvector('x'), case when $6 = 'hidden' then 'admin' end) returning id::text id`,
      [first, src, title, employer, county, status])).rows[0].id as string;
  jobId = await job("Fake Welder", "live");
  await job("Fake Welder Draft", "draft");
  await job("Fake Welder Hidden", "hidden");
  await job("Fake 50% Welder", "closed");
  for (let i = 0; i < 12; i++) await job(`Fake Fitter ${i}`, "live");

  const cand = await F.cand();
  const consent = (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text("services_request")])).rows[0].id;
  caseId = (await su.query("insert into services_case(candidate_user_id, consent_record_id, payer, permit_type) values ($1,$2,'employer','general') returning id::text id", [cand, consent])).rows[0].id;
  const cand2 = await F.cand();
  const consent2 = (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand2, await F.text("services_request")])).rows[0].id;
  closedCaseId = (await su.query("insert into services_case(candidate_user_id, consent_record_id, payer, status, closed_at, close_reason) values ($1,$2,'employer','closed', now(), 'no_reply') returning id::text id", [cand2, consent2])).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("who gets which kind", () => {
  for (const role of ROLE_NAMES) {
    it(`${role}: ${COMPANY.includes(role) ? "organisations and jobs" : "no company kinds"}, ${CASE.includes(role) ? "cases" : "no cases"}`, async () => {
      const keys = Object.keys(await ok(`only_${role}`, "Fake")).sort();
      expect(keys).toEqual([...(CASE.includes(role) ? ["cases"] : []), ...(COMPANY.includes(role) ? ["jobs", "organisations"] : [])].sort());
    });
  }
  it("a case id finds the case for a handler and an administrator, with no requester field, and finds nothing for a text", async () => {
    for (const who of ["only_services_case_handler", "only_administrator"]) {
      const j = await ok(who, caseId);
      expect(j.cases.items).toEqual([{ id: caseId, status: "received", permitType: "general", createdAt: expect.any(String) }]);
      expect(JSON.stringify(j)).not.toMatch(/@example|Fake cand|candidate|requester|offer/i);
      expect((await ok(who, closedCaseId)).cases.items[0].status).toBe("closed"); // closed cases are found by id
      expect((await ok(who, "Fake Welder")).cases.items).toEqual([]);
    }
    for (const who of ["only_account_reviewer", "only_trust_and_safety", "only_content_editor", "only_fetched_job_reviewer", "only_rules_data_editor"]) expect((await ok(who, caseId)).cases).toBeUndefined();
  });
  it("a login with no role gets {} and a content editor gets {}", async () => {
    expect(await ok("norole", "Fake")).toEqual({});
    expect(await ok("only_content_editor", "Fake")).toEqual({});
  });
});

describe("refusals", () => {
  it("a signed-out visitor is 401 no_session; a forged or ended cookie too; a disabled login is refused", async () => {
    await h.no(search(null, "Fake"), 401, "no_session");
    await h.no(h.call(R, "/api/search", null, undefined, { query: "?q=Fake", cookie: "staff.session_token=forged" }), 401, "no_session");
    const r = await search("gone", "Fake");
    expect([401, 403]).toContain(r.status);
    expect(JSON.stringify(r.json)).not.toMatch(/Fake Orchard/);
  });
  it("a bad query is 400 bad_query: missing, short, long, repeated, unknown key, control characters", async () => {
    for (const query of ["", "?q=", "?q=ab", `?q=${enc("  a  ")}`, `?q=${"x".repeat(101)}`, "?q=Fake&q=Fake", "?q=Fake&x=1", "?x=Fake", "?q=Fa%00ke", "?q=Fake%0Aboo", "?q=%1B%5B31mred", `?q=${enc("a\u0085bc")}`])
      await h.no(h.call(R, "/api/search", "only_administrator", undefined, { query }), 400, "bad_query");
  });
  it("no POST route exists", () => expect((R as { POST?: unknown }).POST).toBeUndefined());
});

describe("organisations", () => {
  it("find by name inside, any case, or by CRO number from its start; merged-away companies are left out; the fields are exactly five", async () => {
    const byName = (await ok("only_account_reviewer", "ORCHARD")).organisations;
    expect(byName.items.map((x: { displayName: string }) => x.displayName)).toEqual(["Fake Orchard 100% Ltd", "Fake Orchard Foods Ltd"]);
    expect(Object.keys(byName.items[0]).sort()).toEqual(["croNumber", "displayName", "id", "kind", "status"]);
    expect(byName.more).toBe(false);
    expect((await ok("only_trust_and_safety", "700")).organisations.items.map((x: { croNumber: string }) => x.croNumber).sort()).toEqual(["700001", "700123", "700124", "700125"]);
    expect((await ok("only_trust_and_safety", "700123")).organisations.items).toHaveLength(1);
    expect((await ok("only_trust_and_safety", "123")).organisations.items).toHaveLength(0); // from the start, not inside
  });
  it("more than 10 matches: 10 rows and more is true, in name order", async () => {
    const o = (await ok("only_administrator", "Fake Crowd")).organisations;
    expect(o.items).toHaveLength(10);
    expect(o.more).toBe(true);
    expect(o.items.map((x: { displayName: string }) => x.displayName)).toEqual([...o.items.map((x: { displayName: string }) => x.displayName)].sort());
  });
});

describe("jobs", () => {
  it("find by title or employer name, by id; drafts are left out; the fields are exactly five; newest first", async () => {
    const j = (await ok("only_fetched_job_reviewer", "welder")).jobs;
    expect(j.items.map((x: { title: string }) => x.title).sort()).toEqual(["Fake 50% Welder", "Fake Welder", "Fake Welder Hidden"]);
    expect(Object.keys(j.items[0]).sort()).toEqual(["county", "employerName", "id", "status", "title"]);
    expect((await ok("only_administrator", jobId)).jobs.items.map((x: { id: string }) => x.id)).toContain(jobId);
    expect((await ok("only_administrator", "Fake Orchard Foods")).jobs.items.length).toBeGreaterThan(0); // by employer name
    const fit = (await ok("only_administrator", "Fake Fitter")).jobs;
    expect(fit.items).toHaveLength(10);
    expect(fit.more).toBe(true);
    const ids = fit.items.map((x: { id: string }) => BigInt(x.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? 1 : -1)));
  });
  it("no advert text, pay, badge or organisation id comes back", async () => {
    const text = JSON.stringify(await ok("only_administrator", "Fake Welder"));
    expect(text).not.toMatch(/salary|badge|search_vector|own_page|example\.test|critical_skills|permit|hidden_reason/);
  });
});

describe("hostile text", () => {
  it("LIKE characters are plain text: % and _ and a backslash match only themselves", async () => {
    expect((await ok("only_administrator", "100%")).organisations.items.map((x: { displayName: string }) => x.displayName)).toEqual(["Fake Orchard 100% Ltd"]);
    expect((await ok("only_administrator", "%%%")).organisations.items).toEqual([]);
    expect((await ok("only_administrator", "___")).organisations.items).toEqual([]);
    expect((await ok("only_administrator", "Aar_vark")).organisations.items).toEqual([]);
    expect((await ok("only_administrator", "Under_score")).organisations.items).toHaveLength(1);
    expect((await ok("only_administrator", "Back\\slash")).organisations.items).toHaveLength(1);
    expect((await ok("only_administrator", "\\\\\\")).organisations.items).toEqual([]);
    expect((await ok("only_administrator", "50%")).jobs.items.map((x: { title: string }) => x.title)).toEqual(["Fake 50% Welder"]);
  });
  it("quotes, SQL and markup are plain text: nothing is run, nothing extra comes back, no error", async () => {
    for (const q of ["' or 1=1 --", "'; drop table job; --", "\" or \"\"=\"", "Fake' union select id::text,slug,slug,slug,slug from organisation --", "<script>alert(1)</script>", "${7*7}", "{{7*7}}", "ＦＡＫＥ ｕｎｉｃｏｄｅ", "😀😀😀", "9".repeat(30), "0".repeat(19), "-1-1-1", "1.5e3", "9223372036854775808"]) {
      const j = await ok("only_administrator", q);
      expect(j.organisations.items, q).toEqual([]);
      expect(j.jobs.items, q).toEqual([]);
      expect(j.cases.items, q).toEqual([]);
    }
    expect((await su.query("select count(*)::int n from job")).rows[0].n).toBeGreaterThan(10);
    expect((await ok("only_administrator", "x".repeat(100))).organisations.items).toEqual([]); // the longest allowed text
  });
  it("a text with spaces around it is trimmed; a 3 character text works", async () => {
    expect((await ok("only_administrator", "   Fake Aardvark   ")).organisations.items).toHaveLength(1);
    expect((await ok("only_administrator", "Aar")).organisations.items).toHaveLength(1);
  });
});

describe("the contract", () => {
  it("every answer matches docs/openapi/admin.yaml", async () => {
    const spec = loadSpec("admin");
    for (const [who, q] of [["only_administrator", "Fake"], ["only_services_case_handler", caseId], ["norole", "Fake"], ["only_account_reviewer", "Fake Orchard"], [null, "Fake"], ["only_administrator", "a"]] as const) {
      const x = await search(who, q);
      expect(replyProblems(spec, "get", "/api/search", x.status, x.json), `${who} ${q} ${x.status}`).toEqual([]);
    }
  });
});

describe("budget", () => {
  it("statements per search: administrator, a company role, a case handler", async () => {
    const n = async (who: string) => { const [r, c] = await counted(() => search(who, "Fake")); expect(r.status).toBe(200); return c; };
    for (const who of ["only_administrator", "only_account_reviewer", "only_services_case_handler"]) await n(who); // warm
    const got = { administrator: await n("only_administrator"), company: await n("only_account_reviewer"), handler: await n("only_services_case_handler"), administratorById: 0 };
    [, got.administratorById] = await counted(() => search("only_administrator", caseId));
    console.log(`staff search statements: ${JSON.stringify(got)}`);
    expect(got.administrator).toBeLessThanOrEqual(BUDGET.administrator);
    expect(got.company).toBeLessThanOrEqual(BUDGET.company);
    expect(got.handler).toBeLessThanOrEqual(BUDGET.handler);
    expect(got.administratorById).toBeLessThanOrEqual(BUDGET.administratorById);
  });
});
