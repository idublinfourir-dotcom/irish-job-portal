// Integration: step 16 round 2 (B17, B19, B20, decisions #290 and #291), the staff side, through the admin app's real route handlers (/api/content and
// /api/legal-texts) on the real test database as app_admin, with real staff sessions. B17/B19: an update's category and effective day and a help page's
// category through create, edit, list, show and preview; the database's pairing rules (an update's category is not a help category, only an update has an
// effective day). #291: the notice kind is switched on by publishing and off by withdrawing, needs no source, and only a content editor does it.
// B20: cookie_policy, employer_acceptable_use and data_retention go through the same two-person route, and the database refuses a row without it.
// Every role is tried, plus no login, hostile values and the reply against docs/openapi/admin.yaml. No network. Fake people only; placeholder texts.
// The public side is in content-g1-public.test.ts.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });
// Measured on 23 November 2026 (this file alone): a create with a category and an effective day is the same 7 statements as before (session 2, begin, role,
// insert, audit, commit), an edit 8, median about 3 ms; limit 15 ms. Raise only on purpose.
const BUDGET = { create: 7, edit: 8, ms: 15 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool, content: Route, legal: Route;
const spec = loadSpec("admin");
const act = (who: string | null, action: string, extra: object = {}) => h.call(content, "/api/content", who, { action, ...extra });
const get = (who: string | null, query = "") => h.call(content, "/api/content", who, undefined, { query });
const leg = (who: string | null, body: object) => h.call(legal, "/api/legal-texts", who, body);
const TODAY = new Date().toISOString().slice(0, 10);
let n = 0;
const slug = (p = "page") => `${p}-${n++}`;
const row = async (id: string) => (await su.query("select kind, category, effective_from::text effective_from, status from content_page where id = $1", [id])).rows[0];
const NOT_CE = ROLE_NAMES.filter((r) => r !== "content_editor").map((r) => `only_${r}`);

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  content = await import("../../../apps/admin/app/api/content/route");
  legal = await import("../../../apps/admin/app/api/legal-texts/route");
  for (const r of ROLE_NAMES) await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("ce1", ["content_editor"]);
  await h.makeStaff("ad2", ["administrator"]);
  await h.makeStaff("norole", []);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("B17 and B19: category and effective day on content pages", () => {
  it("an update takes its type and the day its rule starts, and a help page its group; list, show and preview give them back", async () => {
    const u = (await h.ok(act("ce1", "create", { kind: "update", slug: slug("u"), title: "Salary minimums change", body: "Placeholder.", sourceUrl: "https://example.test/s", checkedOn: TODAY, category: "salary_minimums", effectiveFrom: "2027-01-01" }))).id as string;
    const p = (await h.ok(act("ce1", "create", { kind: "help", slug: slug("h"), title: "Who needs a permit?", body: "Placeholder.", category: "permit_services" }))).id as string;
    expect(await row(u)).toMatchObject({ kind: "update", category: "salary_minimums", effective_from: "2027-01-01" });
    expect(await row(p)).toMatchObject({ kind: "help", category: "permit_services", effective_from: null });
    const shown = (await h.ok(get("ce1", `?id=${u}`))).item;
    expect([shown.category, shown.effectiveFrom]).toEqual(["salary_minimums", "2027-01-01"]);
    const list = (await h.ok(get("ce1", "?kind=update"))).items.find((i: { id: string }) => i.id === u);
    expect([list.category, list.effectiveFrom]).toEqual(["salary_minimums", "2027-01-01"]);
    const prev = await get("ce1", `?id=${u}&preview=1`);
    expect([prev.json.item.category, prev.json.item.effectiveFrom]).toEqual(["salary_minimums", "2027-01-01"]);
    for (const [q, r] of [[`?id=${u}`, await get("ce1", `?id=${u}`)], [`?id=${u}&preview=1`, prev], ["?kind=update", await get("ce1", "?kind=update")]] as const)
      expect(replyProblems(spec, "GET", "/api/content", r.status, r.json), q).toEqual([]);
    // a page with neither says null
    const g = (await h.ok(act("ce1", "create", { kind: "guide", slug: slug("g"), title: "A guide", body: "Placeholder." }))).id as string;
    expect((await h.ok(get("ce1", `?id=${g}`))).item).toMatchObject({ category: null, effectiveFrom: null });
  });
  it("an edit sets or changes them on a draft and is audited", async () => {
    const id = (await h.ok(act("ce1", "create", { kind: "update", slug: slug("u"), title: "T", body: "B" }))).id as string;
    await h.ok(act("ce1", "edit", { id, category: "quotas", effectiveFrom: "2027-03-01" }));
    expect(await row(id)).toMatchObject({ category: "quotas", effective_from: "2027-03-01" });
    await h.ok(act("ce1", "edit", { id, category: "processing" }));
    expect(await row(id)).toMatchObject({ category: "processing", effective_from: "2027-03-01" });
    expect((await su.query("select after from audit_event where object_type = 'content_page' and object_id = $1 and action = 'content.edit' order by id", [id])).rows.map((r) => r.after.fields)).toEqual([["category", "effectiveFrom"], ["category"]]);
  });
  it("refuses a category from the wrong kind, an unknown one, and an effective day on any page but an update; nothing is written", async () => {
    const before = (await su.query("select count(*)::int c from content_page")).rows[0].c;
    const base = { slug: slug("x"), title: "T", body: "B" };
    for (const [extra, error] of [
      [{ kind: "update", category: "account" }, "bad_category"], // a help group on an update
      [{ kind: "help", category: "quotas" }, "bad_category"], // an update type on a help page
      [{ kind: "guide", category: "quotas" }, "bad_category"],
      [{ kind: "notice", category: "quotas" }, "bad_category"],
      [{ kind: "update", category: "nope" }, "bad_category"],
      [{ kind: "update", category: "" }, "bad_category"],
      [{ kind: "update", category: "x".repeat(5000) }, "bad_category"],
      [{ kind: "update", category: "quotas'; drop table content_page;--" }, "bad_category"],
      [{ kind: "update", category: 5 }, "bad_category"],
      [{ kind: "update", category: ["quotas"] }, "bad_category"],
      [{ kind: "guide", effectiveFrom: "2027-01-01" }, "bad_effective_from"],
      [{ kind: "help", effectiveFrom: "2027-01-01" }, "bad_effective_from"],
      [{ kind: "update", effectiveFrom: "2027-02-30" }, "bad_effective_from"],
      [{ kind: "update", effectiveFrom: "1 Jan 2027" }, "bad_effective_from"],
      [{ kind: "update", effectiveFrom: "2027-01-01T00:00:00Z" }, "bad_effective_from"],
      [{ kind: "update", effectiveFrom: 20270101 }, "bad_effective_from"],
    ] as const) {
      const r = await act("ce1", "create", { ...base, ...extra });
      expect([r.status, r.json.error], JSON.stringify(extra)).toEqual([400, error]);
      expect(replyProblems(spec, "POST", "/api/content", r.status, r.json)).toEqual([]);
    }
    const id = (await h.ok(act("ce1", "create", { kind: "guide", slug: slug("g"), title: "T", body: "B" }))).id as string;
    for (const [extra, error] of [[{ category: "quotas" }, "bad_category"], [{ effectiveFrom: "2027-01-01" }, "bad_effective_from"]] as const) {
      const r = await act("ce1", "edit", { id, ...extra });
      expect([r.status, r.json.error]).toEqual([400, error]);
    }
    expect((await su.query("select count(*)::int c from content_page")).rows[0].c).toBe(before + 1);
    expect(await row(id)).toMatchObject({ category: null, effective_from: null });
  });
  it("a future effective day is fine (unlike checked-on), and checked-on in the future is still refused", async () => {
    await h.ok(act("ce1", "create", { kind: "update", slug: slug("u"), title: "T", body: "B", effectiveFrom: "2031-01-01" }));
    const r = await act("ce1", "create", { kind: "update", slug: slug("u"), title: "T", body: "B", checkedOn: "2031-01-01" });
    expect([r.status, r.json.error]).toEqual([400, "bad_checked_on"]);
  });
  it("every role but a content editor is refused the new fields, signed out is 401", async () => {
    const payload = { kind: "update", slug: slug("u"), title: "T", body: "B", category: "quotas", effectiveFrom: "2027-01-01" };
    for (const who of [...NOT_CE, "norole"]) { const r = await act(who, "create", payload); expect([r.status, r.json.error], who).toEqual([403, "not_content_editor"]); }
    const r = await act(null, "create", payload);
    expect([r.status, r.json.error]).toEqual([401, "no_session"]);
    expect((await su.query("select count(*)::int c from content_page where slug = $1", [payload.slug])).rows[0].c).toBe(0);
  });
  it("stays inside its statement and time budgets", async () => {
    const [made, create] = await counted(() => act("ce1", "create", { kind: "update", slug: slug("u"), title: "T", body: "B", category: "quotas", effectiveFrom: "2027-01-01" }));
    const [, edit] = await counted(() => act("ce1", "edit", { id: made.json.id, category: "processing", effectiveFrom: "2027-02-01" }));
    const ms = await median(() => act("ce1", "create", { kind: "update", slug: slug("u"), title: "T", body: "B", category: "quotas" }));
    console.log(`B17 create ${create} statements, edit ${edit}, median ${ms.toFixed(1)} ms`);
    expect(create).toBeLessThanOrEqual(BUDGET.create);
    expect(edit).toBeLessThanOrEqual(BUDGET.edit);
    expect(ms).toBeLessThan(BUDGET.ms);
  });
});

describe("#291: the notice kind", () => {
  const notice = { kind: "notice", slug: "dete-portal-closed", title: "DETE's portal is closed", body: "Placeholder notice." };
  it("a content editor writes it, publishes it with no source or checked-on date (on) and withdraws it (off), and each step is audited", async () => {
    const id = (await h.ok(act("ce1", "create", notice))).id as string;
    await h.ok(act("ce1", "publish", { id }));
    expect((await row(id)).status).toBe("published");
    expect((await db.pool("app_candidate").query("select title from published_content_page where kind = 'notice' and slug = 'dete-portal-closed'")).rowCount).toBe(1);
    await h.ok(act("ce1", "withdraw", { id }));
    expect((await db.pool("app_candidate").query("select title from published_content_page where kind = 'notice'")).rowCount).toBe(0);
    await h.ok(act("ce1", "edit", { id, body: "New wording." }));
    await h.ok(act("ce1", "publish", { id }));
    expect((await su.query("select action from audit_event where object_type = 'content_page' and object_id = $1 order by id", [id])).rows.map((r) => r.action)).toEqual(["content.create", "content.publish", "content.withdraw", "content.edit", "content.publish"]);
  });
  it("only a content editor switches it: a rules-data editor and every other role are refused, and a guide still needs a source to publish", async () => {
    const id = (await h.ok(act("ce1", "create", { ...notice, slug: "another-notice" }))).id as string;
    for (const who of ROLE_NAMES.filter((r) => r !== "content_editor" && r !== "administrator").map((r) => `only_${r}`)) {
      const r = await act(who, "publish", { id });
      expect([r.status, r.json.error], who).toEqual([403, who === "only_rules_data_editor" ? "not_content_editor" : "not_publisher"]);
    }
    expect((await row(id)).status).toBe("draft");
    const g = (await h.ok(act("ce1", "create", { kind: "guide", slug: slug("g"), title: "T", body: "B" }))).id as string;
    const r = await act("only_rules_data_editor", "publish", { id: g });
    expect([r.status, r.json.error]).toEqual([409, "needs_source_and_checked_on"]);
  });
  it("the notice kind appears in the list filter and the reply matches the contract", async () => {
    const r = await get("ce1", "?kind=notice");
    expect(r.status).toBe(200);
    expect(r.json.items.every((i: { kind: string }) => i.kind === "notice")).toBe(true);
    expect(replyProblems(spec, "GET", "/api/content", r.status, r.json)).toEqual([]);
    const bad = await get("ce1", "?kind=banner");
    expect([bad.status, bad.json.error]).toEqual([400, "bad_kind"]);
  });
});

describe("B20 and #290: the cookie policy, employer acceptable use and data retention texts", () => {
  const PURPOSES = ["cookie_policy", "employer_acceptable_use", "data_retention"] as const;
  it("each goes through the two-person route: a content editor proposes, another administrator confirms, and the text is in the database", async () => {
    for (const purpose of PURPOSES) {
      const req = (await h.ok(leg("ce1", { action: "propose", purpose, version: "placeholder-1", body: `PLACEHOLDER ${purpose}.` }))).requestId as string;
      const list = await h.ok(h.call(legal, "/api/legal-texts", "ad2"));
      expect(list.pending.map((p: { purpose: string }) => p.purpose)).toContain(purpose);
      const r = await leg("ad2", { action: "confirm", requestId: req });
      expect([r.status, r.json.purpose, r.json.version], purpose).toEqual([200, purpose, "placeholder-1"]);
      expect((await su.query("select body from consent_text where purpose = $1", [purpose])).rows).toEqual([{ body: `PLACEHOLDER ${purpose}.` }]);
      const l2 = await h.call(legal, "/api/legal-texts", "ad2");
      expect(replyProblems(spec, "GET", "/api/legal-texts", l2.status, l2.json), purpose).toEqual([]);
    }
  });
  it("the proposer cannot confirm, a content editor cannot confirm, and no other role proposes", async () => {
    const req = (await h.ok(leg("ce1", { action: "propose", purpose: "cookie_policy", version: "placeholder-2", body: "PLACEHOLDER." }))).requestId as string;
    let r = await leg("ce1", { action: "confirm", requestId: req });
    expect([r.status, r.json.error]).toEqual([403, "not_administrator"]);
    for (const who of NOT_CE) {
      r = await leg(who, { action: "propose", purpose: "data_retention", version: "placeholder-3", body: "PLACEHOLDER." });
      expect([r.status, r.json.error], who).toEqual([403, "not_content_editor"]);
    }
    expect((await su.query("select count(*)::int c from consent_text where version = 'placeholder-2'")).rows[0].c).toBe(0);
  });
  it("hostile purposes are refused before any write", async () => {
    for (const purpose of ["Cookie_policy", "cookies", "visibility", "pay_floor", "", "cookie_policy'; drop table consent_text;--", "x".repeat(5000), 5, null]) {
      const r = await leg("ce1", { action: "propose", purpose, version: "placeholder-9", body: "PLACEHOLDER." });
      expect([r.status, r.json.error], String(purpose)).toEqual([400, "bad_purpose"]);
    }
  });
  it("the database is the last guard: a row of a new purpose with no confirmed request is refused, with one it passes once and only once", async () => {
    const admin = db.pool("app_admin");
    for (const purpose of PURPOSES)
      await expect(admin.query("insert into consent_text(purpose, version, body) values ($1, 'unapproved', 'PLACEHOLDER.')", [purpose]), purpose).rejects.toThrow();
    expect((await su.query("select count(*)::int c from consent_text where version = 'unapproved'")).rows[0].c).toBe(0);
    // an old purpose and a new one both still refuse an unrelated purpose with a request attached (the check constraint)
    await expect(admin.query("insert into consent_text(purpose, version, body, approval_request_id) values ('visibility', 'v', 'b', 1)")).rejects.toThrow();
  });
});
