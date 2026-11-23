// Integration: step 16 round 1, slices B57 (who am I, and the sidebar counts), B59 (audit names, labels, kind and case filters, the CSV export) and B74 (stale help
// and occupation pages, the draft preview), through the admin app's real route handlers on the real test database as app_admin, with real staff sessions.
// Every role is tried, plus no login, a forged cookie, a disabled login, a stale session (the export), hostile filters and a spreadsheet formula planted in a name and a
// job title. Fake people only, no network. The unit side (the CSV text) is in src/audit-read.test.ts, the data layer wall in apps/admin/lib/data.test.ts.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_EXPORT_MAX, AUDIT_EXPORT_SQL, AUDIT_LABELS } from "../src/audit-read";
import { CONTENT_STALE, STALE_DAYS } from "../src/content-admin";
import { STAFF_ME } from "../src/staff-admin";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { BASE, counted, median, ROLE_NAMES, oneOfEachRole, staffHarness, type Route } from "./staff-routes-harness";
import { assertPageBudget, measurePages } from "./perf/pages";

// Measured on 23 November 2026 (this file alone, printed by the performance tests below): who am I 3 statements (the session 2, the read), median 2.4 ms, 4 pages;
// the audit page 5 statements (session 2, role 1, the page, one read for the staff names and object labels), median 3.6 ms; that names and labels read 42 pages for a page of
// 51 rows; the export 8 statements (session 2, begin, role, the page, the names and labels, the audit row, commit), median 14 ms for 2,001 rows, its page 131 pages; the
// stale read 4 statements (session 2, role, the read) and 2 pages. Page and time limits are about 3 to 4 times the measures. Raise these only on purpose.
const BUDGET = { me: 3, audit: 5, exportStatements: 8, ms: 15, exportMs: 60, pages: { me: 12, labels: 120, exportPage: 400, stale: 8 } };
vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
const R = {} as Record<"me" | "counts" | "audit" | "export" | "content" | "links", Route>;
const spec = loadSpec("admin");
const get = (r: keyof typeof R, path: string, who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(R[r], path, who, undefined, { ...o, query });
const q = (p: Record<string, string>) => "?" + new URLSearchParams(p).toString();
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const ids: Record<string, string> = {};

/** The CSV answer of the export route, as text (the harness reads JSON). */
async function exportCsv(who: string | null, query = "", cookie?: string) {
  const c = cookie ?? (who ? h.cookies[who] : undefined);
  const res = await R.export.GET(new Request(`${BASE}/api/audit/export${query}`, { headers: c ? { cookie: c } : {} }));
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, lines: text.split("\r\n").filter(Boolean) };
}
/** One CSV line as its cells (every cell is quoted; a quote inside is doubled). */
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replaceAll('""', '"'));

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  R.me = await import("../../../apps/admin/app/api/staff/me/route");
  R.counts = await import("../../../apps/admin/app/api/staff/me/counts/route");
  R.audit = await import("../../../apps/admin/app/api/audit/route");
  R.export = await import("../../../apps/admin/app/api/audit/export/route");
  R.content = await import("../../../apps/admin/app/api/content/route");
  R.links = await import("../../../apps/admin/app/api/companies/dete-links/route");
  await oneOfEachRole(h);
  for (const n of ["ad1", "ad2"]) await h.makeStaff(n, ["administrator"]);
  await h.makeStaff("two", ["content_editor", "account_reviewer"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("B57: GET /api/staff/me", () => {
  it("answers the signed-in member's id, name and roles, whatever the roles (a login with none gets an empty list), roles sorted", async () => {
    for (const r of ROLE_NAMES) {
      const x = await h.ok(get("me", "/api/staff/me", `only_${r}`));
      expect(x, r).toEqual({ id: h.staff[`only_${r}`], name: `Fake only_${r}`, roles: [r] });
    }
    expect(await h.ok(get("me", "/api/staff/me", "two"))).toEqual({ id: h.staff.two, name: "Fake two", roles: ["account_reviewer", "content_editor"] });
    expect((await h.ok(get("me", "/api/staff/me", "norole"))).roles).toEqual([]);
  });
  it("shows no email, no other member and nothing but id, name and roles", async () => {
    const x = await h.ok(get("me", "/api/staff/me", "only_administrator"));
    expect(Object.keys(x).sort()).toEqual(["id", "name", "roles"]);
    expect(JSON.stringify(x)).not.toMatch(/example\.test|password|token|hash/i);
  });
  it("refuses a call with no session, a forged one and a disabled login, and any query key", async () => {
    await h.no(get("me", "/api/staff/me", null), 401, "no_session");
    await h.no(get("me", "/api/staff/me", null, "", { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(get("me", "/api/staff/me", "disabled"), 401, "not_active");
    await h.no(get("me", "/api/staff/me", "ad1", "?x=1"), 400, "bad_query");
    await h.no(get("me", "/api/staff/me", "ad1", "?id=" + h.staff.ad2), 400, "bad_query"); // no way to ask for another member
  });
  it("has no write method, and the reply matches docs/openapi/admin.yaml", async () => {
    expect(Object.keys(R.me).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    for (const [who, query] of [["ad1", ""], ["norole", ""], ["ad1", "?x=1"], [null, ""]] as const) {
      const r = await get("me", "/api/staff/me", who, query);
      expect(replyProblems(spec, "GET", "/api/staff/me", r.status, r.json), `${who} ${query}`).toEqual([]);
    }
  });
  it("is inside its statement, time and page budgets", async () => {
    const [, n] = await counted(() => get("me", "/api/staff/me", "ad1"));
    const ms = await median(() => get("me", "/api/staff/me", "ad1"));
    const client = await su.connect();
    try {
      const pages = await measurePages(client, [{ text: STAFF_ME, values: [h.staff.ad1!] }]);
      console.log(`B57 me budget: ${n} statements, median ${ms.toFixed(1)} ms, ${pages[0]!.pages} pages`);
      assertPageBudget("who am I", pages, BUDGET.pages.me);
    } finally { client.release(); }
    expect(n).toBeLessThanOrEqual(BUDGET.me);
    expect(ms).toBeLessThan(BUDGET.ms);
  });
});

describe("B57: the new counts", () => {
  it("oldest wait per queue, reports with the job hidden, every open services case; each only for the roles that work them", async () => {
    // a fetched_job item 3 hours old and a newer one; a report whose job is hidden; two open services cases
    const org = (await one("insert into organisation(slug, display_name, kind) values ('fake-counts', 'Fake Counts Ltd', 'employer') returning id::text id")).id;
    const src = (await one("insert into job_source(kind, board) values ('greenhouse', 'fake-b57') returning id")).id;
    const advert = async (n: number) => (await one("insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason, quoted_evidence) values ($1, $2, 'https://jobs.example.test/f', 'Fake', 'Fake', 'queued', '7 contract unclear (admin queue)', 'title', 'x') returning id::text id", [src, `b57-${n}`])).id;
    const jobs: string[] = [];
    for (const n of [1, 2]) {
      jobs.push((await one(`insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
        values ($1, 'fetched', $2, $3, 'Fake queued job', 'Fake', 'Dublin', 'IT', '2134', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', 'fake'), 'https://jobs.example.test/f') returning id::text id`, [org, src, await advert(n)])).id);
    }
    await su.query("update review_item set created_at = now() - interval '3 hours' where queue = 'fetched_job' and job_id = $1", [jobs[0]]);
    const live = (await one(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
      values ($1, 'admin_manual', $2, 'Fake live job', 'Fake', 'IT', '2134', 'critical_skills', 'live', 'infinity', to_tsvector('english', 'fake'), 'https://jobs.example.test/l') returning id::text id`, [org, src])).id;
    await su.query("insert into report(target_kind, target_job_id, reason) values ('job', $1, 'other'), ('job', $1, 'other')", [live]);
    await su.query("update report set status = 'job_hidden', hidden_at = now() where id = (select min(id) from report)").catch(async () => {
      await su.query("update report set status = 'job_hidden' where id = (select min(id) from report)");
    });
    const text = (await one("insert into consent_text(purpose, version, body) values ('services_request', 'v-b57', 'Fake') returning id")).id;
    const pu = (await one("insert into portal_user(id, name, email, email_verified, created_at, updated_at) values ('p-b57', 'Fake Member', 'p-b57@example.test', true, now(), now()) returning id")).id;
    const consent = (await one("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [pu, text])).id;
    await su.query("insert into services_case(portal_user_id, consent_record_id, dedupe_key, status) values ($1, $2, 'b57-1', 'received'), ($1, $2, 'b57-2', 'received')", [pu, consent]);
    await su.query("update services_case set assigned_staff_user_id = $1 where dedupe_key = 'b57-2'", [h.staff.only_services_case_handler]);

    const counts = async (who: string) => { const r = await get("counts", "/api/staff/me/counts", who); expect([r.status, replyProblems(spec, "GET", "/api/staff/me/counts", r.status, r.json)], who).toEqual([200, []]); return r.json; };
    const fj = await counts("only_fetched_job_reviewer");
    expect(fj.queues.fetched_job).toBe(2);
    expect(fj.oldestSeconds.fetched_job).toBeGreaterThanOrEqual(10800);
    expect(fj.oldestSeconds.fetched_job).toBeLessThan(10800 + 300);
    expect(Object.keys(fj.oldestSeconds).sort()).toEqual(Object.keys(fj.queues).sort()); // one age for every queue counted
    const ts = await counts("only_trust_and_safety");
    expect([ts.reportsOpen, ts.reportsJobHidden]).toEqual([2, 1]);
    const sh = await counts("only_services_case_handler");
    expect([sh.casesOpen, sh.casesUnassigned, sh.casesMine]).toEqual([2, 1, 1]);
    for (const r of ROLE_NAMES) {
      const c = await counts(`only_${r}`);
      if (r !== "trust_and_safety") expect(c.reportsJobHidden, r).toBeNull();
      if (r !== "services_case_handler") expect(c.casesOpen, r).toBeNull();
      expect(c.mergeSuggestions, r).toBeNull(); // not asked
    }
    expect(await counts("norole")).toMatchObject({ queues: {}, oldestSeconds: {}, reportsJobHidden: null, casesOpen: null, mergeSuggestions: null });
  });
  it("?merges=1 adds the suggestion count for the roles that may view suggestions, equal to the suggestions list's total; null for the rest", async () => {
    for (const [name, year, permits] of [["Fake Acme Robotics Ltd", 2024, 9], ["Fake Beta Robotics Ltd", 2024, 4]] as const) await su.query("insert into dete_permit_count(dete_name, year, permits) values ($1, $2, $3)", [name, year, permits]);
    await su.query("insert into organisation(slug, display_name, kind) values ('fake-acme', 'Fake Acme Robotics', 'employer'), ('fake-beta', 'Fake Beta Robotics', 'employer')");
    const total = (await h.ok(get("links", "/api/companies/dete-links", "only_account_reviewer"))).total;
    expect(total).toBeGreaterThanOrEqual(2);
    for (const r of ROLE_NAMES) {
      const x = await get("counts", "/api/staff/me/counts", `only_${r}`, "?merges=1");
      expect(x.status, r).toBe(200);
      expect(x.json.mergeSuggestions, r).toBe(["account_reviewer", "trust_and_safety", "administrator"].includes(r) ? total : null);
      expect(replyProblems(spec, "GET", "/api/staff/me/counts", x.status, x.json), r).toEqual([]);
    }
    expect((await h.ok(get("counts", "/api/staff/me/counts", "norole", "?merges=1"))).mergeSuggestions).toBeNull();
    // the counts of the roles do not change with the flag
    const plain = await h.ok(get("counts", "/api/staff/me/counts", "only_administrator"));
    const withMerges = await h.ok(get("counts", "/api/staff/me/counts", "only_administrator", "?merges=1"));
    expect({ ...withMerges, mergeSuggestions: null }).toEqual(plain);
  });
  it("refuses a bad flag, a repeated one and any other key", async () => {
    for (const bad of ["?merges=0", "?merges=2", "?merges=", "?merges=true", "?merges=1&merges=1", "?x=1", "?merges=1&x=1"]) await h.no(get("counts", "/api/staff/me/counts", "ad1", bad), 400, "bad_query");
    await h.no(get("counts", "/api/staff/me/counts", null, "?merges=1"), 401, "no_session");
    await h.no(get("counts", "/api/staff/me/counts", "disabled", "?merges=1"), 401, "not_active");
  });
});

describe("B59: names and labels on audit rows, the kind and case filters", () => {
  const ev = (o: Record<string, unknown>) => su.query(
    `insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, related_case, second_staff_user_id, source)
     values ($1, $2, $3, $4, $5, $6, $7, 'panel')`, [o.kind ?? "admin_action", o.actor, o.action ?? "test.act", o.type ?? null, o.id ?? null, o.case ?? null, o.second ?? null]);
  beforeAll(async () => {
    ids.org = (await one("insert into organisation(slug, display_name, kind) values ('fake-lakeside', 'Lakeside Care Homes', 'employer') returning id::text id")).id;
    const src = (await one("insert into job_source(kind, board) values ('portal', 'fake-b59') returning id")).id;
    ids.job = (await one(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
      values ($1, 'admin_manual', $2, '=HYPERLINK("https://evil.example.test","Care Assistant")', 'Fake', 'IT', '2134', 'critical_skills', 'live', 'infinity', to_tsvector('english', 'fake'), 'https://jobs.example.test/l') returning id::text id`, [ids.org, src])).id;
    ids.page = (await one("insert into content_page(kind, slug, title, body) values ('help', 'fake-help', 'Fake help page', 'Body') returning id::text id")).id;
    ids.strike = (await one("insert into strike(organisation_id, case_kind, reason_code) values ($1, 'instant_ban', 'fake_company') returning id::text id", [ids.org])).id;
    ids.report = (await one("insert into report(target_kind, target_job_id, reason) values ('job', $1, 'other') returning id::text id", [ids.job])).id;
    const a = h.staff.ad1, b = h.staff.ad2, c = h.staff.only_content_editor;
    await ev({ actor: a, type: "organisation", id: ids.org, second: b, case: "strike:7" });
    await ev({ actor: a, type: "job", id: ids.job });
    await ev({ actor: a, type: "staff_user", id: b });
    await ev({ actor: a, type: "content_page", id: ids.page });
    await ev({ actor: a, type: "strike", id: ids.strike, case: "strike:7" });
    await ev({ actor: a, type: "report", id: ids.report });
    await ev({ actor: a, type: "candidate_user", id: "cand-1" }); // no label for a candidate
    await ev({ actor: a, type: "organisation", id: "99999999" }); // an object that is gone
    await ev({ actor: a, type: "organisation", id: "abc" }); // not an id
    await ev({ actor: a, type: "organisation", id: "99999999999999999999" }); // too long for a bigint
    await ev({ actor: a, kind: "data_access", action: "case_document.open", type: "case_document", id: "5", case: "strike:9" });
    await ev({ actor: c, type: "content_page", id: ids.page, second: b, case: "strike:7", action: "content.publish" });
    await ev({ actor: c, kind: "data_access", action: "case_document.open", type: "case_document", id: "6" });
  });
  const rows = async (who: string, query: string) => (await h.ok(get("audit", "/api/audit", who, query))).events as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("gives the staff member's name on the row, and an object label for an organisation, job, staff member, content page, strike and report; none for the rest", async () => {
    const by: Record<string, Record<string, any>> = Object.fromEntries((await rows("ad1", q({ staff: h.staff.ad1!, action: "test.act" }))).map((e) => [`${e.objectType}:${e.objectId}`, e])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(by[`organisation:${ids.org}`]!.objectLabel).toBe("Lakeside Care Homes");
    expect(by[`job:${ids.job}`]!.objectLabel).toBe('=HYPERLINK("https://evil.example.test","Care Assistant")'); // stored as typed; the CSV is where it is made safe
    expect(by[`staff_user:${h.staff.ad2}`]!.objectLabel).toBe("Fake ad2");
    expect(by[`content_page:${ids.page}`]!.objectLabel).toBe("Fake help page");
    expect(by[`strike:${ids.strike}`]!.objectLabel).toBe("Lakeside Care Homes");
    expect(by[`report:${ids.report}`]!.objectLabel).toBe('=HYPERLINK("https://evil.example.test","Care Assistant")');
    for (const k of ["candidate_user:cand-1", "organisation:99999999", "organisation:abc", "organisation:99999999999999999999"]) expect(by[k]!.objectLabel, k).toBeNull();
    for (const e of Object.values(by)) expect(e.actor.staffName).toBe("Fake ad1");
  });
  it("an administrator is given the second person's name; anyone else is not, and sees only their own rows", async () => {
    const adm = (await rows("ad1", q({ case: "strike:7", objectType: "organisation" })))[0]!;
    expect([adm.secondStaff, adm.secondStaffName]).toEqual([h.staff.ad2, "Fake ad2"]);
    const own = (await rows("only_content_editor", q({ action: "content.publish" })))[0]!;
    expect([own.actor.staff, own.actor.staffName, own.secondStaff, own.secondStaffName, own.objectLabel]).toEqual([h.staff.only_content_editor, "Fake only_content_editor", h.staff.ad2, null, "Fake help page"]);
    for (const e of await rows("only_content_editor", "")) expect(e.actor.staff).toBe(h.staff.only_content_editor);
  });
  it("filters by kind (data_access is the personal data views) and by case, alone and together, and a non-administrator's filter only narrows their own rows", async () => {
    const all = await rows("ad1", q({ kind: "data_access" }));
    expect(all.length).toBe((await one("select count(*)::int n from audit_event where kind = 'data_access'")).n);
    expect(all.every((e) => e.kind === "data_access")).toBe(true);
    const byCase = await rows("ad1", q({ case: "strike:7" }));
    expect(byCase.length).toBe((await one("select count(*)::int n from audit_event where related_case = 'strike:7'")).n);
    expect(byCase.every((e) => e.relatedCase === "strike:7")).toBe(true);
    expect((await rows("ad1", q({ case: "strike:7", kind: "data_access" }))).length).toBe(0);
    expect((await rows("ad1", q({ case: "strike:9", kind: "data_access" }))).length).toBe(1);
    expect((await rows("ad1", q({ case: "strike:none" }))).length).toBe(0);
    const mine = await rows("only_content_editor", q({ kind: "data_access" }));
    expect(mine.map((e) => e.objectId)).toEqual(["6"]); // not ad1's "5"
    expect((await rows("only_content_editor", q({ case: "strike:9" }))).length).toBe(0);
  });
  it("refuses a bad kind or case, and hostile text in either", async () => {
    for (const k of ["Admin_Action", "security ", "other", "", "a".repeat(300), "admin_action' or '1'='1", "data_access;drop table audit_event"]) await h.no(get("audit", "/api/audit", "ad1", q({ kind: k })), 400, "bad_kind");
    for (const c of ["a b", "x".repeat(101), "a;b", "a'--", "a\nb", ""]) await h.no(get("audit", "/api/audit", "ad1", q({ case: c })), 400, "bad_case_id");
    expect((await one("select count(*)::int n from audit_event")).n).toBeGreaterThan(0); // the log is still there
  });
  it("the reply matches docs/openapi/admin.yaml, with and without the new filters", async () => {
    for (const query of ["", q({ kind: "data_access" }), q({ case: "strike:7" }), q({ kind: "nope" }), q({ case: "a b" })]) {
      const r = await get("audit", "/api/audit", "ad1", query);
      expect(replyProblems(spec, "GET", "/api/audit", r.status, r.json), `${query} ${r.status}`).toEqual([]);
    }
    const r = await get("audit", "/api/audit", "only_content_editor");
    expect(replyProblems(spec, "GET", "/api/audit", r.status, r.json)).toEqual([]);
  });
});

describe("B59: GET /api/audit/export", () => {
  it("answers the filtered rows as a CSV file, newest first, with the names and labels, and logs the export", async () => {
    const before = (await one("select count(*)::int n from audit_event")).n;
    const x = await exportCsv("ad1", q({ case: "strike:7" }));
    expect(x.status).toBe(200);
    expect(x.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(x.headers.get("cache-control")).toBe("no-store");
    expect(x.headers.get("content-disposition")).toMatch(/^attachment; filename="audit-\d{4}-\d\d-\d\d\.csv"$/);
    expect(x.headers.get("x-audit-export-truncated")).toBeNull();
    expect(cells(x.lines[0]!)).toEqual(["id", "at", "kind", "staffId", "staffName", "action", "objectType", "objectId", "objectLabel", "reasonCode", "relatedCase", "secondStaffId", "secondStaffName", "source", "changedColumns", "before", "after"]);
    const want = (await su.query("select id::text id from audit_event where related_case = 'strike:7' order by at desc, id desc")).rows.map((r) => r.id);
    expect(x.lines.slice(1).map((l) => cells(l)[0])).toEqual(want);
    const org = x.lines.slice(1).map(cells).find((c) => c[6] === "organisation")!;
    expect([org[4], org[8], org[12]]).toEqual(["Fake ad1", "Lakeside Care Homes", "Fake ad2"]);
    // the export itself is one more audit row, in the exporter's name, with the filter and the count
    expect((await one("select count(*)::int n from audit_event")).n).toBe(before + 1);
    const logged = await one("select kind, actor_staff_user_id, action, object_type, object_id, after, source from audit_event where action = 'audit.export' order by id desc limit 1");
    expect(logged).toEqual({ kind: "admin_action", actor_staff_user_id: h.staff.ad1, action: "audit.export", object_type: "audit_event", object_id: "export", after: { filter: { case: "strike:7" }, rows: want.length, truncated: false }, source: "panel" });
  });
  it("makes a spreadsheet formula in a name or a job title harmless, and doubles a quote", async () => {
    const x = await exportCsv("ad1", q({ objectType: "job" }));
    const row = x.lines.slice(1).map(cells).find((c) => c[7] === ids.job)!;
    expect(row[8]).toBe(`'=HYPERLINK("https://evil.example.test","Care Assistant")`);
    expect(x.text).toContain(`"'=HYPERLINK(""https://evil.example.test"",""Care Assistant"")"`);
    for (const l of x.lines.slice(1)) for (const c of cells(l)) expect(c, c).not.toMatch(/^[=+\-@\t\r]/);
    await su.query("update staff_user set name = '+cmd|calc' where id = $1", [h.staff.ad1]);
    try {
      const y = await exportCsv("ad2", q({ staff: h.staff.ad1!, action: "test.act" }));
      expect(cells(y.lines[1]!)[4]).toBe("'+cmd|calc");
    } finally { await su.query("update staff_user set name = 'Fake ad1' where id = $1", [h.staff.ad1]); }
  });
  it("gives an administrator every row and anyone else their own; another member's id is refused; the same filters as the list", async () => {
    const mine = await exportCsv("only_content_editor");
    expect(mine.status).toBe(200);
    expect(mine.lines.slice(1).map(cells).every((c) => c[3] === h.staff.only_content_editor)).toBe(true);
    const list: string[] = [];
    let after = "";
    for (;;) { const r = await h.ok(get("audit", "/api/audit", "only_content_editor", after)); list.push(...r.events.map((e: { id: string }) => e.id)); if (!r.next) break; after = q({ after: r.next }); }
    expect(mine.lines.slice(1).map((l) => cells(l)[0])).toEqual(list.slice(1)); // the list also has the export's own row, written after it read
    const refused = await exportCsv("only_content_editor", q({ staff: h.staff.ad1! }));
    expect([refused.status, JSON.parse(refused.text).error]).toEqual([403, "not_administrator"]);
    const adm = await exportCsv("ad1");
    expect(new Set(adm.lines.slice(1).map((l) => cells(l)[3])).size).toBeGreaterThan(1);
    // every role may export, and each reads only its own
    for (const r of ROLE_NAMES.filter((x) => x !== "administrator")) {
      const x = await exportCsv(`only_${r}`);
      expect(x.status, r).toBe(200);
      expect(x.lines.slice(1).map(cells).every((c) => c[3] === h.staff[`only_${r}`]), r).toBe(true);
    }
  });
  it("refuses no session, a forged cookie, a disabled login, a stale sign-in, a cursor, an unknown key and a bad filter", async () => {
    const err = async (x: Awaited<ReturnType<typeof exportCsv>>) => [x.status, JSON.parse(x.text).error];
    expect(await err(await exportCsv(null))).toEqual([401, "no_session"]);
    expect(await err(await exportCsv(null, "", "better-auth.session_token=forged"))).toEqual([401, "no_session"]);
    expect(await err(await exportCsv("disabled"))).toEqual([401, "not_active"]);
    await su.query("update staff_session set created_at = now() - interval '11 minutes' where user_id = $1", [h.staff.only_trust_and_safety]);
    expect(await err(await exportCsv("only_trust_and_safety"))).toEqual([403, "reauth_required"]);
    const n = (await one("select count(*)::int n from audit_event where action = 'audit.export'")).n;
    for (const [query, code] of [["?after=abc", "bad_query"], ["?x=1", "bad_query"], ["?kind=data_access&kind=data_access", "bad_query"], ["?kind=nope", "bad_kind"], ["?case=a%20b", "bad_case_id"],
      ["?from=2026-02-30", "bad_from"], ["?to=yesterday", "bad_to"], ["?from=2026-03-12&to=2026-03-11", "bad_range"], ["?staff=a%20b", "bad_staff_id"], ["?action=Bad", "bad_action"],
      ["?objectType=a.b", "bad_object_type"], ["?objectId=a%3Bb", "bad_object_id"]] as const)
      expect(await err(await exportCsv("ad1", query)), query).toEqual([400, code]);
    expect((await one("select count(*)::int n from audit_event where action = 'audit.export'")).n).toBe(n); // a refusal logs nothing
    expect(Object.keys(R.export).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
  it("the refusals match docs/openapi/admin.yaml", async () => {
    for (const [who, query] of [["ad1", "?kind=nope"], [null, ""], ["only_trust_and_safety", ""]] as const) {
      const x = await exportCsv(who, query);
      expect(replyProblems(spec, "GET", "/api/audit/export", x.status, JSON.parse(x.text)), `${who} ${query}`).toEqual([]);
    }
  });
  it("stops at 2,000 rows and says so in a header", async () => {
    await su.query("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, source, at) select 'admin_action', $1, 'bulk.big', 'org', g::text, 'panel', now() - make_interval(secs => g) from generate_series(1, $2::int) g", [h.staff.ad1, AUDIT_EXPORT_MAX + 50]);
    const x = await exportCsv("ad1", q({ action: "bulk.big" }));
    expect(x.status).toBe(200);
    expect(x.lines.length).toBe(1 + AUDIT_EXPORT_MAX);
    expect(x.headers.get("x-audit-export-truncated")).toBe("1");
    const logged = await one("select after from audit_event where action = 'audit.export' order by id desc limit 1");
    expect(logged.after).toEqual({ filter: { action: "bulk.big" }, rows: AUDIT_EXPORT_MAX, truncated: true });
  });
});

describe("B59: performance", () => {
  it("the audit page, the names and labels read and the export stay inside their statement, time and page budgets", async () => {
    const actors = Object.values(h.staff);
    await su.query(
      `insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, second_staff_user_id, source, at)
       select 'admin_action', ($1::text[])[1 + g % $2], 'perf.act' || (g % 25), (array['organisation','job','strike','report','staff_user','content_page'])[1 + g % 6], (1 + g % 40)::text, ($1::text[])[1 + (g + 1) % $2], 'panel', now() - make_interval(mins => g)
         from generate_series(1, 20000) g`, [actors, actors.length]);
    await su.query("vacuum (analyze) audit_event");
    const [, n] = await counted(() => get("audit", "/api/audit", "ad1"));
    const ms = await median(() => get("audit", "/api/audit", "ad1"));
    const page = (await h.ok(get("audit", "/api/audit", "ad1"))).events as { objectType: string; objectId: string; actor: { staff: string }; secondStaff: string }[];
    const by = (t: string) => [...new Set(page.filter((e) => e.objectType === t && /^\d{1,18}$/.test(e.objectId)).map((e) => e.objectId))];
    const staffIds = [...new Set(page.flatMap((e) => [e.actor.staff, e.secondStaff, ...(e.objectType === "staff_user" ? [e.objectId] : [])]))];
    const client = await su.connect();
    try {
      const labels = await measurePages(client, [{ text: AUDIT_LABELS, values: [by("organisation"), by("job"), staffIds, by("content_page"), by("strike"), by("report")] }]);
      const exp = await measurePages(client, [{ text: AUDIT_EXPORT_SQL, values: [null, null, null, null, null, null, null, null, null, null] }]);
      const exportCall = await counted(() => exportCsv("ad1"));
      const exportMs = await median(() => exportCsv("ad1"));
      console.log(`B59 budget: audit page ${n} statements, median ${ms.toFixed(1)} ms; labels ${labels[0]!.pages} pages; export page ${exp[0]!.pages} pages, ${exportCall[1]} statements, median ${exportMs.toFixed(0)} ms`);
      assertPageBudget("audit names and labels", labels, BUDGET.pages.labels);
      assertPageBudget("audit export page", exp, BUDGET.pages.exportPage);
      expect(exportCall[1]).toBeLessThanOrEqual(BUDGET.exportStatements);
      expect(exportMs).toBeLessThan(BUDGET.exportMs);
    } finally { client.release(); }
    expect(n).toBeLessThanOrEqual(BUDGET.audit);
    expect(ms).toBeLessThan(BUDGET.ms);
  });
});

describe("B74: stale help and occupation pages, and the draft preview", () => {
  const ins = (kind: string, slug: string, days: number | null, status = "published") => one(
    `insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at) values ($1, $2, $3, 'Fake body', 'https://example.test/s', case when $4::int is null then null else current_date - $4::int end, $5, case when $5 = 'published' then now() end) returning id::text id`,
    [kind, slug, `Fake ${slug}`, days, status]);
  it("lists published guides, help and occupation pages not checked for STALE_DAYS, oldest first; a kind narrows it; updates and undated help are left out", async () => {
    await ins("guide", "g-old", 400);
    await ins("help", "h-stale", STALE_DAYS + 1);
    await ins("occupation", "2134", 200);
    await ins("help", "h-fresh", 10);
    await ins("help", "h-undated", null);
    await ins("help", "h-draft", 500, "draft");
    await ins("occupation", "2135", 500, "withdrawn");
    await ins("update", "u-old", 500);
    const slugs = async (query: string, who = "only_content_editor") => (await h.ok(get("content", "/api/content", who, query))).items.map((i: { slug: string }) => i.slug);
    const all = [...(await slugs("?stale=1"))].filter((s) => !["old", "stale", "edge"].includes(s)); // no other file's rows here, but keep the test about its own
    expect(all).toEqual(["g-old", "2134", "h-stale"]);
    expect(await slugs("?stale=1&kind=help")).toEqual(["h-stale"]);
    expect(await slugs("?stale=1&kind=guide")).toEqual(["g-old"]);
    expect(await slugs("?stale=1&kind=occupation")).toEqual(["2134"]);
    for (const who of ["only_rules_data_editor", "only_administrator"]) expect(await slugs("?stale=1", who)).toEqual(all);
    const r = await get("content", "/api/content", "only_content_editor", "?stale=1");
    expect([r.json.staleDays, r.json.truncated, replyProblems(spec, "GET", "/api/content", r.status, r.json)]).toEqual([STALE_DAYS, false, []]);
    for (const who of ["only_account_reviewer", "only_fetched_job_reviewer", "only_trust_and_safety", "only_services_case_handler", "norole"]) await h.no(get("content", "/api/content", who, "?stale=1&kind=help"), 403, "not_content_staff");
    for (const k of ["update", "Help", "occupation ", "x'; drop table content_page;--", "a".repeat(300), ""]) await h.no(get("content", "/api/content", "only_content_editor", q({ stale: "1", kind: k })), 400, "bad_kind");
    await h.no(get("content", "/api/content", null, "?stale=1&kind=help"), 401, "no_session");
  });
  it("stays on a few pages for the whole table and inside its statement budget", async () => {
    const client = await su.connect();
    try {
      const pages = await measurePages(client, [{ text: CONTENT_STALE, values: [STALE_DAYS, ["guide", "help", "occupation"]] }]);
      console.log(`B74 stale budget: ${pages[0]!.pages} pages`);
      assertPageBudget("stale content", pages, BUDGET.pages.stale);
    } finally { client.release(); }
    expect((await counted(() => get("content", "/api/content", "only_content_editor", "?stale=1")))[1]).toBe(4); // session 2, role 1, the read
  });
  it("previews a page of any state as its public page would be made, with its state, and no staff id", async () => {
    const draft = (await ins("guide", "pv-draft", null, "draft")).id;
    const pub = (await ins("occupation", "2136", 5)).id;
    for (const [id, status, kind] of [[draft, "draft", "guide"], [pub, "published", "occupation"]] as const) {
      const r = await get("content", "/api/content", "only_content_editor", q({ id, preview: "1" }));
      expect(r.status).toBe(200);
      expect(Object.keys(r.json)).toEqual(["item"]);
      expect(Object.keys(r.json.item).sort()).toEqual(["body", "checkedOn", "id", "kind", "publishedAt", "slug", "sourceUrl", "status", "title", "updatedAt"]);
      expect([r.json.item.status, r.json.item.kind, r.json.item.body]).toEqual([status, kind, "Fake body"]);
      expect(replyProblems(spec, "GET", "/api/content", r.status, r.json)).toEqual([]);
    }
    expect((await get("content", "/api/content", "only_content_editor", q({ id: draft, preview: "1" }))).json.item.publishedAt).toBeNull();
    const raw = await R.content.GET(new Request(`${BASE}/api/content${q({ id: draft, preview: "1" })}`, { headers: { cookie: h.cookies.only_content_editor! } }));
    expect(raw.headers.get("cache-control")).toBe("no-store");
    for (const who of ["only_rules_data_editor", "only_administrator"]) await h.ok(get("content", "/api/content", who, q({ id: draft, preview: "1" })));
    for (const who of ["only_account_reviewer", "only_fetched_job_reviewer", "only_trust_and_safety", "only_services_case_handler", "norole"]) await h.no(get("content", "/api/content", who, q({ id: draft, preview: "1" })), 403, "not_content_staff");
    await h.no(get("content", "/api/content", null, q({ id: draft, preview: "1" })), 401, "no_session");
    await h.no(get("content", "/api/content", "disabled", q({ id: draft, preview: "1" })), 401, "not_active");
  });
  it("refuses a preview of nothing, a bad id, and a bad flag or extra key", async () => {
    for (const id of ["999999999", "0", "-1", "abc", "1; drop table content_page", "9".repeat(30), "1.5"]) await h.no(get("content", "/api/content", "only_content_editor", q({ id, preview: "1" })), 404, "not_found");
    const id = (await one("select id::text id from content_page limit 1")).id;
    for (const bad of ["?preview=1", "?preview=0", `?id=${id}&preview=2`, `?id=${id}&preview=`, `?id=${id}&preview=1&preview=1`, `?id=${id}&preview=1&kind=guide`, `?id=${id}&preview=1&stale=1`]) await h.no(get("content", "/api/content", "only_content_editor", bad), 400, "bad_query");
    const r = await get("content", "/api/content", "only_content_editor", q({ id: "999999999", preview: "1" }));
    expect(replyProblems(spec, "GET", "/api/content", r.status, r.json)).toEqual([]);
  });
  it("the plain read of one page and the list are unchanged", async () => {
    const id = (await one("select id::text id from content_page where slug = 'pv-draft'")).id;
    const r = await h.ok(get("content", "/api/content", "only_content_editor", q({ id })));
    expect(Object.keys(r.item).sort()).toEqual(["body", "checkedOn", "id", "kind", "publishedAt", "slug", "sourceUrl", "status", "title", "updatedAt", "updatedBy"]);
    expect((await h.ok(get("content", "/api/content", "only_content_editor", q({ kind: "guide" })))).items.length).toBeGreaterThan(0);
  });
});
