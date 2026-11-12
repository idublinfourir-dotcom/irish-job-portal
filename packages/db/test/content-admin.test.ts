// Integration: the content editor (step 13d, #234 D3) through the real /api/content handler, real staff sessions, the real test database as app_admin.
// A content editor writes drafts, publishes help pages and updates and withdraws any page; a rules-data editor publishes guides and occupation texts;
// nobody else touches content. The database still wants a source and a checked-on date to publish anything but help. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTENT_LIST } from "../src/content-admin";
import { createTestDb, type TestDb } from "./db";
import { counted, median, staffHarness, type Route } from "./staff-routes-harness";
import { assertPageBudget, measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Measured on 13 November 2026 (requireStaff is 2 statements): list = role check + page (4 in all); create = begin, role check, insert, audit, commit (+2 = 7);
// publish = begin, role check, lock page, update, audit, commit (+2 = 8). Medians over 9 warm calls through the route: 1.5 to 1.8 ms (list), 1.6 to 1.9 (create),
// 1.8 to 2.0 (publish); limits are about 5 times that. One list page of 21 rows out of 300 touches 24 pages (planning + execution + serialisation).
const BUDGET = { list: 4, create: 7, publish: 8, listMs: 10, createMs: 10, publishMs: 10, pages: 60 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/content", who, body, o);
const act = (who: string | null, action: string, extra: object = {}) => call(who, { action, ...extra });
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);
const TODAY = new Date().toISOString().slice(0, 10);
let n = 0;
const slug = (p = "page") => `${p}-${n++}`;
const draft = (o: object = {}) => ({ action: "create", kind: "help", slug: slug(), title: "A fake title", body: "Fake body text.", ...o });
const row = async (id: string) => (await su.query("select kind, slug, title, body, status, source_url, checked_on::text checked_on, published_at is not null as published, updated_by_staff_user_id by from content_page where id = $1", [id])).rows[0];
const audits = (id: string) => su.query("select action, actor_staff_user_id a, after from audit_event where object_type = 'content_page' and object_id = $1 order by id", [id]).then((r) => r.rows);
/** A page in the given state, made by a content editor (publishing as whoever the kind needs). */
async function page(kind: string, state: "draft" | "published" | "withdrawn" = "draft") {
  const id = (await ok(call("ce1", draft({ kind, slug: kind === "occupation" ? String(1000 + n++) : slug(kind), sourceUrl: "https://example.test/source", checkedOn: TODAY })))).id as string;
  if (state !== "draft") {
    await ok(act(kind === "guide" || kind === "occupation" ? "re1" : "ce1", "publish", { id }));
    if (state === "withdrawn") await ok(act("ce1", "withdraw", { id }));
  }
  return id;
}
const view = async (kind: string, s: string) => (await db.pool("app_candidate").query("select title from published_content_page where kind = $1 and slug = $2", [kind, s])).rowCount;

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  route = await import("../../../apps/admin/app/api/content/route");
  for (const [name, roles] of [["ce1", ["content_editor"]], ["ce2", ["content_editor"]], ["re1", ["rules_data_editor"]], ["ad1", ["administrator"]], ["both", ["content_editor", "rules_data_editor"]]] as const) await h.makeStaff(name, [...roles]);
  for (const r of ["account_reviewer", "fetched_job_reviewer", "trust_and_safety", "services_case_handler"]) await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["content_editor"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("access", () => {
  it("refuses a call with no session, a forged one and a disabled login", async () => {
    await no(call(null), 401, "no_session");
    await no(call("disabled"), 401, "not_active");
    await no(act("disabled", "create", draft()), 401, "not_active");
    await no(call(null, draft(), { cookie: "better-auth.session_token=forged" }), 401, "no_session");
  });
  it("reading is for a content editor, a rules-data editor and an administrator; every other role is refused and nothing changes", async () => {
    const id = await page("help");
    for (const who of ["ce1", "re1", "ad1"]) { await ok(call(who)); await ok(call(who, undefined, { query: `?id=${id}` })); }
    const before = (await su.query("select count(*)::int n from content_page")).rows[0].n;
    for (const who of ["only_account_reviewer", "only_fetched_job_reviewer", "only_trust_and_safety", "only_services_case_handler", "norole"]) {
      await no(call(who), 403, "not_content_staff");
      await no(call(who, undefined, { query: `?id=${id}` }), 403, "not_content_staff");
      await no(act(who, "create", draft()), 403, "not_content_editor");
      await no(act(who, "edit", { id, title: "x" }), 403, "not_content_editor");
      await no(act(who, "publish", { id }), 403, "not_publisher");
      await no(act(who, "withdraw", { id }), 403, "not_content_editor");
    }
    expect((await su.query("select count(*)::int n from content_page")).rows[0].n).toBe(before);
    expect((await row(id)).status).toBe("draft");
  });
  it("only a content editor writes drafts and withdraws; a rules-data editor and an administrator cannot", async () => {
    const id = await page("guide");
    for (const who of ["re1", "ad1"]) {
      await no(act(who, "create", draft()), 403, "not_content_editor");
      await no(act(who, "edit", { id, title: "x" }), 403, "not_content_editor");
    }
    const published = await page("help", "published");
    for (const who of ["re1", "ad1"]) await no(act(who, "withdraw", { id: published }), 403, "not_content_editor");
    expect((await row(published)).status).toBe("published");
  });
});

describe("drafts", () => {
  it("creates a draft of each kind, recording the writer, and nothing is public yet", async () => {
    for (const [kind, s] of [["help", slug()], ["update", slug()], ["guide", slug()], ["occupation", "2134"]] as const) {
      const r = await ok(call("ce1", draft({ kind, slug: s })));
      expect(await row(r.id)).toMatchObject({ kind, slug: s, title: "A fake title", status: "draft", published: false, by: h.staff.ce1 });
      expect(await view(kind, s)).toBe(0);
      expect((await audits(r.id)).map((a) => [a.action, a.a, a.after])).toEqual([["content.create", h.staff.ce1, { kind, slug: s }]]);
    }
  });
  it("applies the slug rules: lower-case words with hyphens, four digits for an occupation, one per kind", async () => {
    for (const s of ["Bad", "has space", "-lead", "a/b", "a_b", "a".repeat(101), "", "ü", "a\nb"]) await no(call("ce1", draft({ slug: s })), 400, "bad_slug");
    for (const s of ["213", "21345", "abcd", "2134 ", "-123"]) await no(call("ce1", draft({ kind: "occupation", slug: s })), 400, "bad_slug");
    const a = await ok(call("ce1", draft({ slug: "same-slug" })));
    expect(a.id).toMatch(/^\d+$/);
    await no(call("ce1", draft({ slug: "same-slug" })), 409, "slug_taken");
    await ok(call("ce1", draft({ kind: "update", slug: "same-slug" }))); // the same slug in another kind is another page
    await no(call("ce1", draft({ kind: "other" })), 400, "bad_kind");
  });
  it("limits the title, the body, the link and the date, and refuses control and format characters", async () => {
    for (const title of ["", "  ", "a".repeat(201), "a\nb", "a\u0000b", "a‮b", "a​b"]) await no(call("ce1", draft({ title })), 400, "bad_title");
    for (const body of ["", " \n ", "a".repeat(50_001), "a\u0000b", "a‮b", "a​b", "a\u001bb"]) await no(call("ce1", draft({ body })), 400, "bad_body_text");
    await ok(call("ce1", draft({ body: "a".repeat(50_000) })));
    await ok(call("ce1", draft({ body: "Line one\nLine two\r\n\tIndented" })));
    for (const sourceUrl of ["", "ftp://x.test", "javascript:alert(1)", "not a url", "a".repeat(501), "https://x.test/\u0000", "data:text/html,x"]) await no(call("ce1", draft({ sourceUrl })), 400, "bad_source_url");
    for (const checkedOn of ["", "2026-02-30", "2026-13-01", "26-1-1", "2026-11-13T00:00:00Z", "tomorrow", "2099-01-01"]) await no(call("ce1", draft({ checkedOn })), 400, "bad_checked_on");
    await ok(call("ce1", draft({ sourceUrl: "http://example.test/a", checkedOn: "2026-01-31" })));
  });
  it("edits a draft, keeps kind and slug, records the editor, and refuses a published page or nothing to change", async () => {
    const id = await page("help");
    await ok(act("ce2", "edit", { id, title: "A new title", body: "New body" }));
    expect(await row(id)).toMatchObject({ title: "A new title", body: "New body", by: h.staff.ce2, status: "draft" });
    await ok(act("ce2", "edit", { id, sourceUrl: "https://example.test/b", checkedOn: "2026-02-02" }));
    expect(await row(id)).toMatchObject({ source_url: "https://example.test/b", checked_on: "2026-02-02", title: "A new title" });
    await no(act("ce1", "edit", { id }), 400, "nothing_to_change");
    await no(act("ce1", "edit", { id: "987654321", title: "x" }), 404, "not_found");
    await no(act("ce1", "edit", { id, title: "" }), 400, "bad_title");
    await no(act("ce1", "edit", { id, kind: "guide" }), 400, "bad_body");
    await no(act("ce1", "edit", { id, slug: "other" }), 400, "bad_body");
    const live = await page("help", "published");
    await no(act("ce1", "edit", { id: live, title: "changed while live" }), 409, "not_editable");
    expect((await row(live)).title).toBe("A fake title");
    expect((await audits(id)).map((a) => a.action)).toEqual(["content.create", "content.edit", "content.edit"]);
  });
});

describe("publish and withdraw", () => {
  it("a content editor publishes help and updates, and cannot publish a guide or an occupation text", async () => {
    for (const kind of ["help", "update"]) {
      const id = await page(kind);
      await ok(act("ce1", "publish", { id }));
      expect(await row(id)).toMatchObject({ status: "published", published: true, by: h.staff.ce1 });
      expect(await view(kind, (await row(id)).slug)).toBe(1);
      await no(act("ce1", "publish", { id }), 409, "already_published");
    }
    for (const kind of ["guide", "occupation"]) {
      const id = await page(kind);
      await no(act("ce1", "publish", { id }), 403, "not_rules_data_editor");
      await no(act("ce2", "publish", { id }), 403, "not_rules_data_editor");
      await no(act("ad1", "publish", { id }), 403, "not_publisher"); // an administrator publishes nothing
      expect((await row(id)).status).toBe("draft");
      expect(await view(kind, (await row(id)).slug)).toBe(0);
    }
  });
  it("a rules-data editor publishes guides and occupation texts, and cannot publish help or an update", async () => {
    for (const kind of ["guide", "occupation"]) {
      const id = await page(kind);
      await ok(act("re1", "publish", { id }));
      expect(await row(id)).toMatchObject({ status: "published", by: h.staff.re1 });
      expect(await view(kind, (await row(id)).slug)).toBe(1);
    }
    for (const kind of ["help", "update"]) {
      const id = await page(kind);
      await no(act("re1", "publish", { id }), 403, "not_content_editor");
      expect((await row(id)).status).toBe("draft");
    }
  });
  it("someone holding both roles publishes every kind", async () => {
    for (const kind of ["help", "update", "guide", "occupation"]) await ok(act("both", "publish", { id: await page(kind) }));
  });
  it("the database still wants a source and a checked-on date for a guide, an update or an occupation text, and not for help", async () => {
    for (const kind of ["guide", "update", "occupation"]) {
      const id = (await ok(call("ce1", draft({ kind, slug: kind === "occupation" ? String(1000 + n++) : slug(kind) })))).id;
      const who = kind === "update" ? "ce1" : "re1";
      await no(act(who, "publish", { id }), 409, "needs_source_and_checked_on");
      await ok(act("ce1", "edit", { id, sourceUrl: "https://example.test/s" }));
      await no(act(who, "publish", { id }), 409, "needs_source_and_checked_on");
      await ok(act("ce1", "edit", { id, checkedOn: TODAY }));
      await ok(act(who, "publish", { id }));
    }
    await ok(act("ce1", "publish", { id: (await ok(call("ce1", draft()))).id })); // help needs neither
  });
  it("a content editor withdraws any kind; the page leaves the public view, can be fixed, and published again", async () => {
    for (const kind of ["help", "update", "guide", "occupation"]) {
      const id = await page(kind, "published");
      const s = (await row(id)).slug;
      expect(await view(kind, s)).toBe(1);
      await ok(act("ce2", "withdraw", { id }));
      expect(await row(id)).toMatchObject({ status: "withdrawn", by: h.staff.ce2 });
      expect(await view(kind, s)).toBe(0);
      await no(act("ce1", "withdraw", { id }), 409, "not_published");
      await ok(act("ce1", "edit", { id, title: "Fixed title" }));
      await ok(act(kind === "guide" || kind === "occupation" ? "re1" : "ce1", "publish", { id }));
      expect(await view(kind, s)).toBe(1);
      expect((await audits(id)).map((a) => a.action)).toEqual(["content.create", "content.publish", "content.withdraw", "content.edit", "content.publish"]);
    }
    await no(act("ce1", "withdraw", { id: await page("help") }), 409, "not_published"); // a draft is not published
    await no(act("ce1", "withdraw", { id: "987654321" }), 404, "not_found");
    await no(act("re1", "publish", { id: "987654321" }), 404, "not_found");
  });
  it("two publishers at once: one wins, one is told it is already published", async () => {
    const id = await page("help");
    const rs = await Promise.all([act("ce1", "publish", { id }), act("ce2", "publish", { id }), act("both", "publish", { id })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(rs.filter((r) => r.status === 409).every((r) => r.json.error === "already_published")).toBe(true);
  });
});

describe("the list", () => {
  it("shows pages of every state with the writer, filters by kind and state, and shows one page with its body", async () => {
    const [d, p, w] = [await page("help", "draft"), await page("update", "published"), await page("help", "withdrawn")];
    const all = (await ok(call("ad1"))).items as { id: string; status: string; kind: string }[];
    expect(all.map((x) => x.id)).toEqual(expect.arrayContaining([d, p, w].filter((x) => all.some((y) => y.id === x))));
    const byState = (await ok(call("ce1", undefined, { query: "?status=withdrawn" }))).items as { status: string }[];
    expect(byState.length).toBeGreaterThan(0);
    expect(byState.every((x) => x.status === "withdrawn")).toBe(true);
    const byKind = (await ok(call("re1", undefined, { query: "?kind=occupation&status=published" }))).items as { kind: string; status: string }[];
    expect(byKind.every((x) => x.kind === "occupation" && x.status === "published")).toBe(true);
    const one = (await ok(call("ce1", undefined, { query: `?id=${d}` }))).item;
    expect(one).toMatchObject({ id: d, kind: "help", status: "draft", body: "Fake body text.", updatedBy: h.staff.ce1 });
    for (const bad of ["987654321", "0", "abc", "1;2"]) await no(call("ce1", undefined, { query: `?id=${bad}` }), bad === "987654321" ? 404 : 404, "not_found");
  });
  it("pages 20 at a time, newest change first, with no page twice, and refuses a bad filter or cursor", async () => {
    for (let i = 0; i < 25; i++) await page("help");
    const seen: string[] = [];
    let query = "";
    for (;;) {
      const r = await ok(call("ce1", undefined, { query }));
      expect(r.items.length).toBeLessThanOrEqual(20);
      seen.push(...r.items.map((x: { id: string }) => x.id));
      if (!r.next) break;
      query = `?after=${r.next}`;
    }
    const total = (await su.query("select count(*)::int n from content_page")).rows[0].n;
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    const order = (await su.query("select id::text id from content_page order by updated_at desc, id desc")).rows.map((r) => r.id);
    expect(seen).toEqual(order);
    await no(call("ce1", undefined, { query: "?kind=other" }), 400, "bad_kind");
    await no(call("ce1", undefined, { query: "?status=live" }), 400, "bad_status");
    await no(call("ce1", undefined, { query: "?x=1" }), 400, "bad_query");
    const forged = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const c of ["x", "!!!", "a".repeat(300), forged({ t: "now", i: "1" }), forged({ t: "2026-11-11 10:00:00+00", i: "1; drop table content_page" }), forged(null)]) await no(call("ce1", undefined, { query: `?after=${c}` }), 400, "bad_cursor");
  });
});

describe("hostile requests", () => {
  it("refuses a missing or foreign Origin, a long body and bad JSON, and writes nothing", async () => {
    const before = (await su.query("select count(*)::int n from content_page")).rows[0].n;
    await no(call("ce1", draft(), { origin: null }), 403, "bad_origin");
    await no(call("ce1", draft(), { origin: "https://evil.example.test" }), 403, "bad_origin");
    await no(call("ce1", draft(), { length: "1000000" }), 400, "bad_body");
    await no(call("ce1", undefined, { raw: "x".repeat(120_000) }), 400, "bad_body");
    for (const raw of ["", "{", "null", "[]", "1", '"create"']) await no(call("ce1", undefined, { raw }), 400, "bad_body");
    expect((await su.query("select count(*)::int n from content_page")).rows[0].n).toBe(before);
  });
  it("refuses unknown actions, unknown fields, wrong types and a missing field", async () => {
    const id = await page("help");
    for (const action of ["delete", "update", "toString", "__proto__", "", 5, null]) await no(call("ce1", { action, id }), 400, "bad_action");
    for (const extra of [{ status: "published" }, { updatedBy: h.staff.ce2 }, { publishedAt: "2026-01-01" }, { id: "1" }]) await no(call("ce1", draft(extra)), 400, "bad_body");
    for (const k of ["kind", "slug", "title", "body"]) { const d = draft() as Record<string, unknown>; delete d[k]; await no(call("ce1", d), 400, `bad_${k === "body" ? "body_text" : k}`); }
    for (const v of [5, null, ["x"], { a: 1 }, true]) {
      await no(call("ce1", draft({ title: v })), 400, "bad_title");
      await no(call("ce1", draft({ body: v })), 400, "bad_body_text");
    }
    for (const bad of [5, null, "", "0", "01", "-1", "1.5", "1e3", "1 or 1=1", "12345678901234567890", ["1"]]) for (const a of ["edit", "publish", "withdraw"]) await no(call("ce1", { action: a, id: bad, title: "x" }), 400, a === "edit" ? "bad_id" : "bad_body");
    expect((await row(id)).status).toBe("draft");
  });
  it("stores hostile text as plain text", async () => {
    const t = `x'); drop table content_page; -- <script>alert(1)</script>`;
    const id = (await ok(call("ce1", draft({ title: t, body: t })))).id;
    expect(await row(id)).toMatchObject({ title: t, body: t });
    expect((await su.query("select count(*)::int n from content_page")).rows[0].n).toBeGreaterThan(0);
  });
});

describe("performance", () => {
  it("list, create and publish stay inside their statement and time budgets; a list page stays under its page budget", async () => {
    await su.query("insert into content_page(kind, slug, title, body, updated_by_staff_user_id) select 'help', 'bulk-' || g, 'Bulk ' || g, repeat('Fake text. ', 40), $1 from generate_series(1, 300) g", [h.staff.ce1]);
    const [, listN] = await counted(() => call("ce1"));
    const [c, createN] = await counted(() => call("ce1", draft()));
    const [, publishN] = await counted(() => act("ce1", "publish", { id: c.json.id }));
    expect([listN, createN, publishN]).toEqual([BUDGET.list, BUDGET.create, BUDGET.publish]);
    expect(await median(() => call("ce1"))).toBeLessThan(BUDGET.listMs);
    expect(await median(() => call("ce1", draft()))).toBeLessThan(BUDGET.createMs);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await ok(call("ce1", draft()))).id);
    expect(await median((i) => ok(act("ce1", "publish", { id: ids[i] })))).toBeLessThan(BUDGET.publishMs);
    const client = await su.connect();
    try {
      assertPageBudget("content list", await measurePages(client, [{ text: CONTENT_LIST, values: [null, null, null, null] }]), BUDGET.pages);
    } finally { client.release(); }
  });
});
