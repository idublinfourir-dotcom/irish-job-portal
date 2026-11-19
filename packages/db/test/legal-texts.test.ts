// Integration: R5, the legal texts through the admin app's real route (/api/legal-texts) on the real test database as app_admin, with real staff
// sessions. A content editor proposes, an administrator who did not propose confirms and the text is published; every other role is refused, the
// same person is refused, a stale session is refused (C4); hostile bodies and labels are refused. No network. Fake people only; placeholder texts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LEGAL_VERSIONS, MAX_LEGAL_BODY } from "../src/legal-texts";
import { LEGAL_IN_FORCE } from "../src/public-read";
import { PENDING_OF } from "../src/staff-tools";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { assertPageBudget, measurePages } from "./perf/pages";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements per call through the route (the session read is 2): the list is the session, the role check and its two reads (5); a propose is the
// session, begin, role check, the label check, the insert, the audit row, commit (8); a confirm is the session, begin, role check, lock, status,
// the insert (its trigger uses the request), audit, commit (9). Measured 19 Nov 2026 (medians of 9 warm calls): list 2.9 ms; a propose followed
// by a refuse 8.5 ms, a propose followed by a confirm 8.3 ms (two calls each); limits 15 ms and 30 ms. Pages with 200 versions of another
// purpose added: versions 2, in force 2, pending 2; limit 10 each.
const BUDGET = { list: 5, propose: 8, confirm: 9, ms: 15, pages: { versions: 10, inForce: 10, pending: 10 } };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>;
let route: Route;
const spec = loadSpec("admin");
const P = "/api/legal-texts";
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, P, who, body, o);
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);
const age = (who: string, sql = "now() - interval '11 minutes'") => h.su.query(`update staff_session set created_at = ${sql} where user_id = $1`, [h.staff[who]]);
const propose = (who: string, purpose: string, version: string, body = `PLACEHOLDER ${purpose} ${version}.`) => call(who, { action: "propose", purpose, version, body });
const texts = async (purpose: string) => (await h.su.query("select version, body from consent_text where purpose = $1 order by published_at desc, id desc", [purpose])).rows;
const status = async (id: string) => (await h.su.query("select status from approval_request where id = $1", [id])).rows[0].status as string;

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  route = await import("../../../apps/admin/app/api/legal-texts/route");
  await oneOfEachRole(h);
  await h.makeStaff("ce2", ["content_editor"]);
  await h.makeStaff("ad2", ["administrator"]);
  await h.makeStaff("ceadmin", ["content_editor", "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await h.su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const NOT_CE = ROLE_NAMES.filter((r) => r !== "content_editor").map((r) => `only_${r}`);
const NOT_AD = ROLE_NAMES.filter((r) => r !== "administrator").map((r) => `only_${r}`);
const NEITHER = ROLE_NAMES.filter((r) => r !== "content_editor" && r !== "administrator").map((r) => `only_${r}`);

describe("who may call it", () => {
  it("signed out, a forged session and a disabled login are 401; another origin or none 403; a query key 400", async () => {
    await no(call(null), 401, "no_session");
    await no(call(null, undefined, { cookie: "staff.session_token=forged" }), 401, "no_session");
    await no(call("disabled"), 401, "not_active");
    await no(propose("disabled", "privacy_notice", "v1"), 401, "not_active");
    await no(call(null, { action: "refuse", requestId: "1" }), 401, "no_session");
    await no(call("only_content_editor", { action: "refuse", requestId: "1" }, { origin: "https://evil.example" }), 403, "bad_origin");
    await no(call("only_content_editor", { action: "refuse", requestId: "1" }, { origin: null }), 403, "bad_origin");
    await no(call("only_administrator", undefined, { query: "?purpose=privacy_notice" }), 400, "bad_query");
  });
  it("the list: a content editor and an administrator; every other role and a login with no role are refused", async () => {
    for (const who of ["only_content_editor", "only_administrator"]) {
      const r = await call(who);
      expect([r.status, r.json, replyProblems(spec, "GET", P, r.status, r.json)]).toEqual([200, { versions: [], pending: [] }, []]);
    }
    for (const who of [...NEITHER, "norole"]) await no(call(who), 403, "not_legal_staff");
  });
});

describe("propose and confirm (two people)", () => {
  let req: string;
  it("only a content editor proposes; every other role is refused and nothing is written", async () => {
    for (const who of [...NOT_CE, "norole"]) await no(propose(who, "privacy_notice", "v1"), 403, "not_content_editor");
    expect((await h.su.query("select count(*)::int n from approval_request")).rows[0].n).toBe(0);
    const r = await propose("only_content_editor", "privacy_notice", "v1", "PLACEHOLDER privacy notice.\nSecond line.\tTabbed.");
    expect([r.status, replyProblems(spec, "POST", P, r.status, r.json)]).toEqual([200, []]);
    req = r.json.requestId;
    expect(await texts("privacy_notice")).toEqual([]); // nothing published before the confirm
    const l = await ok(call("only_administrator"));
    expect(l.pending).toEqual([{ requestId: req, purpose: "privacy_notice", version: "v1", body: "PLACEHOLDER privacy notice.\nSecond line.\tTabbed.", proposedBy: h.staff.only_content_editor, createdAt: expect.any(String) }]);
    expect(replyProblems(spec, "GET", P, 200, l)).toEqual([]);
  });
  it("a second proposal for the same purpose waits (decision_pending), whatever its label", async () => {
    await no(propose("ce2", "privacy_notice", "v2"), 409, "decision_pending");
    await no(propose("ce2", "privacy_notice", "v1"), 409, "decision_pending");
  });
  it("only an administrator who did not propose confirms; then the text is published and the request is used once", async () => {
    for (const who of [...NOT_AD, "norole"]) await no(call(who, { action: "confirm", requestId: req }), 403, "not_administrator");
    const r = await call("only_administrator", { action: "confirm", requestId: req });
    expect([r.status, replyProblems(spec, "POST", P, r.status, r.json)]).toEqual([200, []]);
    expect(r.json).toMatchObject({ ok: true, purpose: "privacy_notice", version: "v1" });
    expect(await texts("privacy_notice")).toEqual([{ version: "v1", body: "PLACEHOLDER privacy notice.\nSecond line.\tTabbed." }]);
    await no(call("ad2", { action: "confirm", requestId: req }), 409, "request_not_pending");
    expect((await h.su.query("select confirmed_by_staff_user_id c, applied_at is not null used from approval_request where id = $1", [req])).rows[0]).toEqual({ c: h.staff.only_administrator, used: true });
    const audit = (await h.su.query("select actor_staff_user_id a, action, second_staff_user_id s from audit_event where action like 'legal_text.%' order by id")).rows;
    expect(audit).toEqual([{ a: h.staff.only_content_editor, action: "legal_text.propose", s: null }, { a: h.staff.only_administrator, action: "legal_text.confirm", s: h.staff.only_content_editor }]);
  });
  it("the same person is refused even holding both roles; a used label is version_taken", async () => {
    const r = await ok(propose("ceadmin", "signup_terms", "v1"));
    await no(call("ceadmin", { action: "confirm", requestId: r.requestId }), 409, "same_person");
    await ok(call("ad2", { action: "confirm", requestId: r.requestId }));
    await no(propose("only_content_editor", "privacy_notice", "v1"), 409, "version_taken");
    await no(propose("only_content_editor", "signup_terms", "v1"), 409, "version_taken");
  });
  it("a second version becomes the newest; the list shows both, newest first, for each purpose", async () => {
    const r = await ok(propose("ce2", "privacy_notice", "v2"));
    await ok(call("only_administrator", { action: "confirm", requestId: r.requestId }));
    const p = await ok(propose("ce2", "portal_signup_terms", "v1"));
    await ok(call("only_administrator", { action: "confirm", requestId: p.requestId }));
    const l = await ok(call("only_content_editor"));
    expect(l.versions.map((v: { purpose: string; version: string }) => `${v.purpose}:${v.version}`)).toEqual(["portal_signup_terms:v1", "privacy_notice:v2", "privacy_notice:v1", "signup_terms:v1"]);
    expect(replyProblems(spec, "GET", P, 200, l)).toEqual([]);
  });
});

describe("refuse and withdraw", () => {
  it("the proposer withdraws; another content editor may not refuse; an administrator refuses; a request of another kind is not found", async () => {
    const a = (await ok(propose("only_content_editor", "privacy_notice", "v3"))).requestId;
    await no(call("ce2", { action: "refuse", requestId: a }), 403, "not_administrator");
    for (const who of [...NEITHER, "norole"]) await no(call(who, { action: "refuse", requestId: a }), 403, "not_legal_staff");
    await ok(call("only_content_editor", { action: "refuse", requestId: a }));
    expect(await status(a)).toBe("withdrawn");
    const b = (await ok(propose("only_content_editor", "privacy_notice", "v3"))).requestId;
    await ok(call("ad2", { action: "refuse", requestId: b }));
    expect(await status(b)).toBe("refused");
    await no(call("ad2", { action: "confirm", requestId: b }), 409, "request_not_pending");
    expect((await texts("privacy_notice")).map((t) => t.version)).toEqual(["v2", "v1"]);
    // a setting request is another kind: not found here
    await h.su.query("insert into setting(key, value, unit, is_guess) values ('fake_legal_test', 1, 'days', true) on conflict do nothing");
    const { proposeSetting } = await import("../src/staff-tools");
    const { getPool } = await import("../src");
    const s = (await proposeSetting(getPool(), h.staff.only_administrator!, "fake_legal_test", 2)).requestId;
    await no(call("ad2", { action: "confirm", requestId: s }), 404, "not_found");
    await no(call("ad2", { action: "refuse", requestId: s }), 404, "not_found");
    await no(call("ad2", { action: "confirm", requestId: "999999" }), 404, "not_found");
  });
});

describe("C4: a stale session", () => {
  it("propose and confirm need a sign-in in the last 10 minutes from every role; refuse does not", async () => {
    const pending = (await ok(propose("only_content_editor", "signup_terms", "v2"))).requestId;
    for (const r of [...ROLE_NAMES.map((x) => `only_${x}`), "ce2", "ad2"]) {
      await age(r);
      await no(propose(r, "signup_terms", "v9"), 403, "reauth_required");
      await no(call(r, { action: "confirm", requestId: pending }), 403, "reauth_required");
    }
    expect(await status(pending)).toBe("pending");
    await ok(call("ad2", { action: "refuse", requestId: pending })); // ending a request publishes nothing
    for (const r of [...ROLE_NAMES.map((x) => `only_${x}`), "ce2", "ad2"]) await age(r, "now() - interval '9 minutes'");
    const again = (await ok(propose("only_content_editor", "signup_terms", "v2"))).requestId;
    await ok(call("ad2", { action: "confirm", requestId: again }));
    expect((await texts("signup_terms"))[0].version).toBe("v2");
  });
});

describe("hostile input", () => {
  it("refuses bad purposes, labels and bodies, unknown fields, wrong types and oversize bodies; nothing is written", async () => {
    const who = "only_content_editor";
    const before = (await h.su.query("select count(*)::int n from approval_request")).rows[0].n;
    for (const purpose of ["visibility", "pay_floor", "SIGNUP_TERMS", "", 5, null, ["privacy_notice"]])
      await no(call(who, { action: "propose", purpose, version: "v9", body: "x" }), 400, "bad_purpose");
    for (const version of ["", "V1", "-v1", ".v", "v 1", "v1\n", "../v", "v/1", "x".repeat(65), "v1‮", 1, null, {}])
      await no(call(who, { action: "propose", purpose: "privacy_notice", version, body: "x" }), 400, "bad_version");
    for (const body of ["", "   \n\t ", "a\u0000b", "a\u0007b", "a‮b", "a⁦b", "a​b", "a‏b", "a﻿b", "x".repeat(MAX_LEGAL_BODY + 1), 5, null, ["x"], { t: "x" }])
      await no(call(who, { action: "propose", purpose: "privacy_notice", version: "v9", body }), 400, "bad_body_text");
    await no(call(who, { action: "propose", purpose: "privacy_notice", version: "v9", body: "x", extra: 1 }), 400, "bad_body");
    await no(call(who, { action: "publish", purpose: "privacy_notice", version: "v9", body: "x" }), 400, "bad_action");
    await no(call(who, { action: "propose", purpose: "privacy_notice", version: "v9" }), 400, "bad_body_text");
    await no(call(who, undefined, { raw: "not json" }), 400, "bad_body");
    await no(call(who, undefined, { raw: "[]" }), 400, "bad_body");
    await no(call(who, undefined, { raw: "x".repeat(400_001) }), 400, "bad_body");
    await no(call(who, { action: "refuse", requestId: "1" }, { length: "400001" }), 400, "bad_body");
    for (const requestId of ["0", "-1", "abc", "99999999999999999999", 5, null, "1 or 1=1"])
      await no(call("ad2", { action: "confirm", requestId }), 400, "bad_request_id");
    expect((await h.su.query("select count(*)::int n from approval_request")).rows[0].n).toBe(before);
    // the longest body passes, with Irish letters
    const r = await ok(propose(who, "privacy_notice", "v-long", "á".repeat(MAX_LEGAL_BODY)));
    await ok(call("ad2", { action: "refuse", requestId: r.requestId }));
  });
  it("the database still refuses a text written past the route (no confirmed request)", async () => {
    await expect(db.pool("app_admin").query("insert into consent_text(purpose, version, body) values ('privacy_notice', 'sneak', 'x')")).rejects.toThrow();
    await expect(db.pool("app_candidate").query("insert into consent_text(purpose, version, body) values ('privacy_notice', 'sneak', 'x')")).rejects.toThrow(/permission denied/);
  });
});

describe("performance", () => {
  it("keeps the statements, time and pages within budget", async () => {
    const [, listN] = await counted(() => ok(call("only_content_editor")));
    const [p, proposeN] = await counted(() => ok(propose("only_content_editor", "privacy_notice", "v-perf")));
    const [, confirmN] = await counted(() => ok(call("ad2", { action: "confirm", requestId: p.requestId })));
    expect([listN, proposeN, confirmN]).toEqual([BUDGET.list, BUDGET.propose, BUDGET.confirm]);
    const measured: Record<string, number> = {};
    measured.list = await median(() => ok(call("only_content_editor")));
    measured.propose = await median(async (i) => { const r = await ok(propose("only_content_editor", "portal_signup_terms", `m${i}`)); await ok(call("ad2", { action: "refuse", requestId: r.requestId })); });
    measured.confirm = await median(async (i) => { const r = await ok(propose("only_content_editor", "portal_signup_terms", `c${i}`)); await ok(call("ad2", { action: "confirm", requestId: r.requestId })); });
    for (const k of ["list", "propose", "confirm"]) expect(measured[k], k).toBeLessThan(BUDGET.ms * (k === "list" ? 1 : 2)); // a propose or confirm here is two calls
    // bulk: 200 versions of other purposes and 200 pending requests of another kind
    await h.su.query("insert into consent_text(purpose, version, body) select 'visibility', 'bulk-' || g, 'x' from generate_series(1, 200) g");
    const client = await h.su.connect();
    try {
      for (const [name, text, values, budget] of [["versions", LEGAL_VERSIONS, [["signup_terms", "portal_signup_terms", "privacy_notice"]], BUDGET.pages.versions],
        ["in force", LEGAL_IN_FORCE, ["privacy_notice"], BUDGET.pages.inForce], ["pending", PENDING_OF, ["terms_privacy_page"], BUDGET.pages.pending]] as const) {
        const cost = await measurePages(client, [{ text, values: [...values] }]);
        measured[`${name} pages`] = cost[0]!.pages;
        assertPageBudget(name, cost, budget);
      }
    } finally { client.release(); }
    console.log("legal texts measured (ms, pages):", JSON.stringify(measured));
  });
});
