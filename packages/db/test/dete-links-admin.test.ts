// Step 15 Q5: DETE name links by staff through the real /api/companies/dete-links handlers, real staff sessions, the test database as app_admin (migration 0051).
// Real size: 24,326 DETE names (about 3 rows each) and 400 companies of two names each, written as postgres. Every role, a disabled login, no session,
// hostile input, and the permit history label and sponsor key of the company changing at once. No network. Fake names only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { permitsLast5Years } from "../src/dete";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

// Measured on 19 November 2026: GET 6 statements (requireStaff 2, role check 1, three reads), median 166 ms at real size (nearly all of it the matcher);
// POST link and unlink 3 statements each (requireStaff 2, the function 1), median 5 ms. Time budgets about 2.5 and 12 times the measure.
const BUDGET = { getStatements: 6, getMs: 400, postStatements: 3, postMs: 60 };
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
const P = "/api/companies/dete-links";
const ACME = "Fake Acme Robotics Ireland Limited";
const HOSTILE = "<script>x</script>'; drop table job; --";
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route;
const ids = {} as { acme: string; other: string; merged: string };

const get = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(route, P, who, undefined, { ...o, query });
const post = (who: string | null, body: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, P, who, body, o);
const q = async (sql: string, args: unknown[] = []) => (await h.su.query(sql, args)).rows;
const org = async (name: string, extra = "") => String((await q(`insert into organisation(slug, display_name, kind${extra ? ", merged_into_id" : ""}) values ($1, $2, 'employer'${extra ? ", $3" : ""}) returning id`,
  extra ? [name.toLowerCase().replace(/\W+/g, "-"), name, extra] : [name.toLowerCase().replace(/\W+/g, "-"), name]))[0].id);
const label = async (id: string) => (await q("select permit_history, sponsor_sort from organisation where id = $1", [id]))[0];

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  route = await import("../../../apps/admin/app/api/companies/dete-links/route");
  await oneOfEachRole(h);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["account_reviewer", "administrator"]);
  await q("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  // the bulk: names that share a word with one of 400 companies (about 8 each) and many that match none
  await q(`insert into dete_permit_count(dete_name, year, permits) select 'Fakeco' || (g % 3000) || ' ' || (array['Healthcare','Software','Foods','Engineering','Care'])[1 + g % 5]
    || ' Unit' || g || ' Limited', y, 1 + (g * y) % 40 from generate_series(1, 24320) g cross join generate_series(2022, 2024) y`);
  await q(`with o as (insert into organisation(slug, display_name, kind) select 'fakeco-' || g, 'Fakeco' || g || ' Group', 'employer' from generate_series(1, 400) g returning id, display_name)
    insert into organisation_name(organisation_id, name, normalised_name, kind, source) select id, split_part(display_name, ' ', 1) || ' Software', lower(split_part(display_name, ' ', 1)) || ' software', 'alias', 'job_site' from o`);
  ids.acme = await org("Fake Acme Robotics");
  ids.other = await org("Fake Other Robotics Co");
  ids.merged = await org("Fake Gone Robotics", ids.other);
  for (const [name, year, permits] of [[ACME, 2019, 5], [ACME, 2025, 100000], ["Fake Other Robotics Co Ltd", 2024, 7], [HOSTILE, 2024, 3], ["Fake Taken Ltd", 2024, 2], ["Fake Spare Ltd", 2024, 1]] as const)
    await q("insert into dete_permit_count(dete_name, year, permits) values ($1, $2, $3)", [name, year, permits]);
  // a name of the form "fake taken ltd" already belongs to the other company
  await q("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Fake Taken LTD', 'fake taken ltd', 'alias', 'admin')", [ids.other]);
  await q("analyze dete_permit_count; analyze organisation; analyze organisation_name");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("GET /api/companies/dete-links", () => {
  it("the account reviewer, trust and safety and the administrator read the suggestions, best first, 50 a page; every other role is refused", async () => {
    for (const r of ROLE_NAMES) {
      const x = await get(`only_${r}`);
      if (["account_reviewer", "trust_and_safety", "administrator"].includes(r)) {
        expect(x.status, r).toBe(200);
        expect(x.json.suggestions[0], r).toEqual({ deteName: ACME, permits: 100005, organisationId: ids.acme, organisation: "Fake Acme Robotics", matchedName: "Fake Acme Robotics", score: 1, kind: "exact" });
        expect(x.json.suggestions).toHaveLength(50);
        expect(x.json.total).toBeGreaterThan(400);
      } else expect([x.status, x.json.error], r).toEqual([403, "not_dete_link_viewer"]);
    }
    await h.no(get("norole"), 403, "not_dete_link_viewer");
    const p2 = await h.ok(get("only_administrator", "?page=2"));
    expect(p2.page).toBe(2);
    const scores = p2.suggestions.map((s: { score: number }) => s.score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    expect((await h.ok(get("only_administrator", "?page=1000"))).suggestions).toEqual([]);
  });
  it("refuses signed out, forged and disabled logins and bad queries", async () => {
    await h.no(get(null), 401, "no_session");
    await h.no(get(null, "", { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(get("disabled"), 401, "not_active");
    for (const s of ["?page=0", "?page=1001", "?page=-1", "?page=1.5", "?page=abc", "?page=" + "9".repeat(5000)]) await h.no(get("only_administrator", s), 400, "bad_page");
    for (const s of ["?page=1&page=2", "?limit=1", "?x=" + "a".repeat(5000)]) await h.no(get("only_administrator", s), 400, "bad_query");
  });
});

describe("POST /api/companies/dete-links", () => {
  it("only the account reviewer links; the name, the rows, the label and the sponsor key change at once, with one audit row", async () => {
    for (const r of ROLE_NAMES.filter((x) => x !== "account_reviewer")) {
      await h.no(post(`only_${r}`, { action: "link", deteName: ACME, organisationId: ids.acme }), 403, "not_dete_link_staff");
      await h.no(post(`only_${r}`, { action: "unlink", deteName: ACME }), 403, "not_dete_link_staff");
      await h.no(post(`only_${r}`, { action: "reject", deteName: ACME, organisationId: ids.acme }), 403, "not_dete_link_staff");
    }
    await h.no(post("norole", { action: "link", deteName: ACME, organisationId: ids.acme }), 403, "not_dete_link_staff");
    expect(await label(ids.acme)).toEqual({ permit_history: "not_linked", sponsor_sort: -1 });
    expect(await permitsLast5Years(h.su, ids.acme)).toBeNull();

    const r = await h.ok(post("only_account_reviewer", { action: "link", deteName: ACME, organisationId: ids.acme }));
    expect(r).toMatchObject({ ok: true, organisationId: ids.acme, nameAdded: true, rowsLinked: 2, labelsChanged: 1, permitHistory: "has_history" });
    expect(await q("select name, normalised_name, kind, source, confirmed_by_staff_id, organisation_id::text from organisation_name where id = $1", [r.organisationNameId]))
      .toEqual([{ name: ACME, normalised_name: "fake acme robotics ireland limited", kind: "legal", source: "dete", confirmed_by_staff_id: h.staff.only_account_reviewer, organisation_id: ids.acme }]);
    expect(await label(ids.acme)).toEqual({ permit_history: "has_history", sponsor_sort: 100000 });
    expect(await permitsLast5Years(h.su, ids.acme, new Date("2026-06-01"))).toEqual({ permits: 100000, firstYear: 2019 });
    expect(await q("select actor_staff_user_id, object_id, after from audit_event where action = 'organisation.dete_link'")).toEqual([
      { actor_staff_user_id: h.staff.only_account_reviewer, object_id: ids.acme, after: { dete_name: ACME, organisation_name_id: Number(r.organisationNameId), name_added: true, rows: 2 } }]);
    const top = (await h.ok(get("only_account_reviewer"))).suggestions;
    expect(top.some((s: { deteName: string }) => s.deteName === ACME)).toBe(false);
    // linking again changes nothing but is not refused; another company may not take it
    expect(await h.ok(post("only_account_reviewer", { action: "link", deteName: ACME, organisationId: ids.acme }))).toMatchObject({ nameAdded: false, rowsLinked: 0 });
    await h.no(post("only_account_reviewer", { action: "link", deteName: ACME, organisationId: ids.other }), 409, "linked_elsewhere");
  });
  it("unlink takes it all back, removes the added name and remembers the pair; reject hides a suggestion until a link", async () => {
    const r = await h.ok(post("only_account_reviewer", { action: "unlink", deteName: ACME }));
    expect(r).toMatchObject({ ok: true, rowsUnlinked: 2, labelsChanged: 1, organisationIds: [ids.acme] });
    expect(r.namesRemoved).toHaveLength(1);
    expect(await q("select 1 from organisation_name where name = $1", [ACME])).toEqual([]);
    expect(await label(ids.acme)).toEqual({ permit_history: "not_linked", sponsor_sort: -1 });
    expect(await q("select organisation_id::text, rejected_by_staff_id from dete_link_rejection where dete_name = $1", [ACME])).toEqual([{ organisation_id: ids.acme, rejected_by_staff_id: h.staff.only_account_reviewer }]);
    expect(await q("select count(*)::int n from audit_event where action = 'organisation.dete_unlink' and object_id = $1", [ids.acme])).toEqual([{ n: 1 }]);
    const after = (await h.ok(get("only_account_reviewer"))).suggestions;
    expect(after.some((s: { deteName: string; organisationId: string }) => s.deteName === ACME && s.organisationId === ids.acme)).toBe(false);
    await h.no(post("only_account_reviewer", { action: "unlink", deteName: ACME }), 409, "not_linked");

    const other = "Fake Other Robotics Co Ltd";
    const before = (await h.ok(get("only_account_reviewer"))).suggestions;
    expect(before.some((s: { deteName: string }) => s.deteName === other)).toBe(true);
    expect(await h.ok(post("only_account_reviewer", { action: "reject", deteName: other, organisationId: ids.other }))).toEqual({ ok: true, organisationId: ids.other, rejected: true });
    expect((await h.ok(get("only_account_reviewer"))).suggestions.some((s: { deteName: string }) => s.deteName === other)).toBe(false);
    expect(await q("select count(*)::int n from audit_event where action = 'organisation.dete_reject'")).toEqual([{ n: 1 }]);
    // a later link wins over the "no"
    await h.ok(post("only_account_reviewer", { action: "link", deteName: ACME, organisationId: ids.acme }));
    expect(await q("select 1 from dete_link_rejection where dete_name = $1", [ACME])).toEqual([]);
  });
  it("a hostile DETE name is linked as plain text", async () => {
    const r = await h.ok(post("only_account_reviewer", { action: "link", deteName: HOSTILE, organisationId: ids.other }));
    expect(await q("select name from organisation_name where id = $1", [r.organisationNameId])).toEqual([{ name: HOSTILE }]);
    expect(await q("select count(*)::int n from job")).toEqual([{ n: 0 }]);
    await h.ok(post("only_account_reviewer", { action: "unlink", deteName: HOSTILE }));
  });
  it("refuses wrong companies, unknown names and hostile input, changing nothing", async () => {
    const ar = "only_account_reviewer";
    await h.no(post(ar, { action: "link", deteName: "Fake Taken Ltd", organisationId: ids.acme }), 409, "name_taken");
    await h.no(post(ar, { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.merged }), 409, "company_merged");
    await h.no(post(ar, { action: "link", deteName: "Fake Spare Ltd", organisationId: "999999999" }), 404, "not_found");
    await h.no(post(ar, { action: "reject", deteName: "Fake Spare Ltd", organisationId: "999999999" }), 404, "not_found");
    await h.no(post(ar, { action: "link", deteName: "Fake Nowhere Ltd", organisationId: ids.acme }), 404, "name_not_found");
    await h.no(post(ar, { action: "unlink", deteName: "Fake Nowhere Ltd" }), 404, "name_not_found");
    for (const deteName of ["", " Fake Spare Ltd", "Fake Spare Ltd ", "a".repeat(301), "Fake\u0000Spare", "Fake​Spare", 42, null, ["x"]])
      await h.no(post(ar, { action: "link", deteName, organisationId: ids.acme }), 400, "bad_name");
    for (const organisationId of ["0", "-1", "1e3", "x", 7, "99999999999999999999", undefined])
      await h.no(post(ar, { action: "link", deteName: "Fake Spare Ltd", organisationId }), 400, "bad_organisation_id");
    await h.no(post(ar, { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme, extra: 1 }), 400, "bad_body");
    await h.no(post(ar, { action: "unlink", deteName: "Fake Spare Ltd", organisationId: ids.acme }), 400, "bad_body");
    await h.no(post(ar, { action: "merge", deteName: "Fake Spare Ltd" }), 400, "bad_action");
    await h.no(post(ar, undefined, { raw: "not json" }), 400, "bad_body");
    await h.no(post(ar, undefined, { raw: JSON.stringify({ action: "link", deteName: "x".repeat(2000), organisationId: ids.acme }) }), 400, "bad_body");
    await h.no(post(ar, { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme }, { length: "5000" }), 400, "bad_body");
    await h.no(post(ar, { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme }, { origin: "https://evil.example" }), 403, "bad_origin");
    await h.no(post(ar, { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme }, { origin: null }), 403, "bad_origin");
    await h.no(post(null, { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme }), 401, "no_session");
    await h.no(post("disabled", { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme }), 401, "not_active");
    expect(await q("select count(*)::int n from dete_permit_count where dete_name in ('Fake Spare Ltd', 'Fake Taken Ltd') and organisation_name_id is not null")).toEqual([{ n: 0 }]);
  });
  it("app_portal, app_candidate and app_fetcher can neither call the functions nor read the rejections", async () => {
    for (const role of ["app_portal", "app_candidate", "app_fetcher", "anon", "authenticated"] as const) {
      await expect(db.query(role, "select private.dete_link('x', 'Fake Spare Ltd', 1)"), role).rejects.toThrow(/permission denied/);
      await expect(db.query(role, "select private.dete_unlink('x', 'Fake Spare Ltd')"), role).rejects.toThrow(/permission denied/);
      await expect(db.query(role, "select * from dete_link_rejection"), role).rejects.toThrow(/permission denied/);
    }
    await expect(db.query("app_admin", "insert into dete_link_rejection(dete_name, organisation_id, rejected_by_staff_id) values ('x', 1, 'x')")).rejects.toThrow(/permission denied/);
  });
});

describe("docs and budgets", () => {
  it("matches docs/openapi/admin.yaml", async () => {
    const spec = loadSpec("admin");
    for (const r of [await get("only_administrator"), await get(null), await get("only_content_editor"), await get("only_administrator", "?page=0")])
      expect(replyProblems(spec, "GET", P, r.status, r.json), String(r.status)).toEqual([]);
    for (const r of [
      await post("only_account_reviewer", { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme }),
      await post("only_account_reviewer", { action: "unlink", deteName: "Fake Spare Ltd" }),
      await post("only_account_reviewer", { action: "reject", deteName: "Fake Spare Ltd", organisationId: ids.acme }),
      await post("only_account_reviewer", { action: "link", deteName: "Fake Taken Ltd", organisationId: ids.acme }),
      await post("only_administrator", { action: "unlink", deteName: "Fake Spare Ltd" }),
      await post("only_account_reviewer", { action: "x" }),
    ]) expect(replyProblems(spec, "POST", P, r.status, r.json), String(r.status)).toEqual([]);
  });
  it("stays inside the statement and time budgets at real size", async () => {
    const [, gs] = await counted(() => get("only_administrator"));
    const getMs = await median(() => get("only_administrator", "?page=3"));
    const [, ls] = await counted(() => post("only_account_reviewer", { action: "link", deteName: "Fake Spare Ltd", organisationId: ids.acme }));
    const [, us] = await counted(() => post("only_account_reviewer", { action: "unlink", deteName: "Fake Spare Ltd" }));
    const postMs = await median((i) => post("only_account_reviewer", { action: i % 2 ? "unlink" : "link", deteName: "Fake Spare Ltd", ...(i % 2 ? {} : { organisationId: ids.acme }) }));
    console.log(`dete links budget: GET ${gs} statements, median ${getMs.toFixed(1)} ms; POST link ${ls}, unlink ${us} statements, median ${postMs.toFixed(1)} ms`);
    expect(gs).toBeLessThanOrEqual(BUDGET.getStatements);
    expect(getMs).toBeLessThan(BUDGET.getMs);
    expect(Math.max(ls, us)).toBeLessThanOrEqual(BUDGET.postStatements);
    expect(postMs).toBeLessThan(BUDGET.postMs);
  });
});
