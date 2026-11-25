// Step 16 pages P23 (company name merges), P27 (content editor) and P28 (audit log, staff and roles), plus the re-sign-in on the staff sign-in page (DD10): the pages' own server code on the real
// test database as app_admin, with real staff sessions. Each page function is called as Next calls it (its search params in, its element out) and the element is rendered to HTML, so what a role
// would be sent is what is asserted. All seven roles, a login with no role, a disabled login, a forged session and a signed-out visitor are tried on every page, and the writes go through the
// real routes (/api/companies/dete-links, /api/companies/merge, /api/content, /api/staff). Only Next's request context is stood in (next/headers, next/navigation, server-only). Fake people only,
// no network. The staff invite (it sends an email) is not driven here: the router calls it the same way as the other actions and the page offers it as a dialog (unit test).
// Budget: see BUDGET below (measured 25 November 2026, three runs, printed by the last test): the limits are the measured statements plus 2 and a clock limit of about 5 times the slowest median (13, 11, 7, 13, 8, 8 and 0 statements; 9 to 29 ms)
// with a floor for a busy laptop. Raise these only on purpose.
import type pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`REDIRECT:${to}`), { to }); },
  useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/",
}));
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
// auditAdminMs: the administrator's audit page returns about 8 KB (31 rows of the test log); a result of exactly that size stalls 200 ms on this laptop's loopback to the database container
// (measured: `select repeat('x', 8000)` takes 207 ms, 4000 or 9000 bytes take 0 ms; the SQL itself runs in 0.2 ms), so that one page gets 300 ms. Not a code cost.
const BUDGET = { merges: 15, content: 13, audit: 15, staff: 10, signIn: 2, ms: 150, auditAdminMs: 300 };

type Params = Record<string, string | string[] | undefined>;
type PageFn = (a: { searchParams: Promise<Params> }) => Promise<React.ReactElement | null>;
type R = Route & { POST: (r: Request) => Promise<Response> };
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
let merges: PageFn, content: PageFn, audit: PageFn, staffPage: () => Promise<React.ReactElement>, signIn: PageFn;
let LINKS: R, MERGE: R, CONTENT: R, STAFF: R;
const ID = {} as Record<string, string>;

const pageModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ `../../../apps/admin/app/${name}`);
const ROLE = (r: string) => `only_${r}`;
const NO_ACCESS = /This page is not for your roles/;
const SIGN_IN = "REDIRECT:/sign-in";
const q = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;

async function render(who: string | null, page: () => Promise<React.ReactElement | null>, cookie?: string): Promise<string> {
  state.headers = new Headers(cookie ? { cookie } : who ? { cookie: h.cookies[who]! } : {});
  try {
    const el = await page();
    return el ? renderToStaticMarkup(el) : "";
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT:")) return e.message;
    throw e;
  }
}
const mergesPage = (who: string | null, p: Params = {}) => render(who, () => merges({ searchParams: Promise.resolve(p) }));
const contentPage = (who: string | null, p: Params = {}) => render(who, () => content({ searchParams: Promise.resolve(p) }));
const auditPage = (who: string | null, p: Params = {}) => render(who, () => audit({ searchParams: Promise.resolve(p) }));
const staffView = (who: string | null) => render(who, () => staffPage());
const signInPage = (who: string | null, p: Params = {}) => render(who, () => signIn({ searchParams: Promise.resolve(p) }));
/** The table rows of an audit page (the action filter lists every action word too). */
const rowsOf = (html: string) => html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>") + 1);
const call = (route: R, who: string | null, body: unknown) => h.call(route as never, "/", who, body);
const others = (allowed: string[]) => [...ROLE_NAMES.filter((r) => !allowed.includes(r)).map(ROLE), "norole"];
const LINK_VIEWERS = ["account_reviewer", "trust_and_safety", "administrator"], MERGE_ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "administrator"];
const CONTENT_ROLES = ["content_editor", "rules_data_editor", "administrator"];
const ACME_DETE = "Fake Acme Robotics Ireland Limited";

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  for (const r of ROLE_NAMES) await h.makeStaff(ROLE(r), [r]);
  await h.makeStaff("admin2", ["administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("gone", ["account_reviewer", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]); // after sign-in: its open session must be refused too
  const org = async (name: string) => String((await q("insert into organisation(slug, display_name, kind) values ($1, $2, 'employer') returning id", [name.toLowerCase().replace(/\W+/g, "-"), name]))[0].id);
  ID.acme = await org("Fake Acme Robotics");
  ID.other = await org("Fake Other Robotics Co");
  ID.third = await org("Fake Third Care Co");
  for (const [name, permits] of [[ACME_DETE, 12], ["Fake Other Robotics Co Ltd", 1], ["<script>x</script> Fake Third Care Co", 3]] as const) await q("insert into dete_permit_count(dete_name, year, permits) values ($1, 2024, $2)", [name, permits]);
  // content: a draft update, a published update, a draft guide, a published guide long unchecked, a published help page, a published occupation page
  const page = async (kind: string, slug: string, title: string, status: string, checked: string | null, extra: { category?: string; eff?: string } = {}) =>
    String((await q(`insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at, category, effective_from, updated_by_staff_user_id)
      values ($1, $2, $3, $4, $5, $6, $7, case when $7 = 'published' then now() end, $8, $9, $10) returning id`, [kind, slug, title, "Fake body\n<b>two</b>", checked ? "https://enterprise.gov.ie/x" : null, checked, status, extra.category ?? null, extra.eff ?? null, h.staff.only_content_editor]))[0].id);
  ID.updDraft = await page("update", "fake-salary-change", "Fake salary change", "draft", null, { category: "salary_minimums", eff: "2027-01-01" });
  ID.updLive = await page("update", "fake-quota-renewed", "Fake quota renewed", "published", "2026-11-09", { category: "quotas", eff: "2026-10-14" });
  ID.guideDraft = await page("guide", "fake-guide", "Fake guide draft", "draft", null);
  ID.guideOld = await page("guide", "fake-old-guide", "Fake old guide", "published", "2026-01-05");
  ID.help = await page("help", "fake-help", "Fake help page", "published", null, { category: "account" });
  ID.occ = await page("occupation", "2134", "Fake occupation text", "published", "2026-11-01");
  // audit rows: one by the account reviewer, one by trust and safety, one personal data view by trust and safety
  for (const [who, kind, action, type, obj, cols, before, after] of [
    ["account_reviewer", "admin_action", "account_review.approved", "organisation", ID.acme, ["status"], { status: "pending_review" }, { status: "verified" }],
    ["trust_and_safety", "admin_action", "trust_safety.report_hide", "job", "77", null, null, null],
    ["trust_and_safety", "data_access", "data_access.view", "candidate", "88", null, null, null],
  ] as const)
    await q("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, source) values ($1, $2, $3, $4, $5, $6, $7, $8, 'panel')",
      [kind, h.staff[ROLE(who)], action, type, obj, cols, before && JSON.stringify(before), after && JSON.stringify(after)]);
  ({ default: merges } = (await pageModule("name-merges/page")) as { default: PageFn });
  ({ default: content } = (await pageModule("content/page")) as { default: PageFn });
  ({ default: audit } = (await pageModule("audit/page")) as { default: PageFn });
  ({ default: staffPage } = (await pageModule("staff/page")) as { default: typeof staffPage });
  ({ default: signIn } = (await pageModule("(auth)/sign-in/page")) as { default: PageFn });
  LINKS = await import("../../../apps/admin/app/api/companies/dete-links/route");
  MERGE = await import("../../../apps/admin/app/api/companies/merge/route");
  CONTENT = await import("../../../apps/admin/app/api/content/route");
  STAFF = await import("../../../apps/admin/app/api/staff/route");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("P23 company name merges", () => {
  it("every role of the sidebar link opens the page; the others see 'not for your roles' and none of its data", async () => {
    for (const r of MERGE_ROLES) expect(await mergesPage(ROLE(r)), r).toMatch(/Company name merges/);
    for (const who of others(MERGE_ROLES)) {
      const p = await mergesPage(who, { a: ID.acme, b: ID.other });
      expect(p, who).toMatch(NO_ACCESS);
      expect(p, who).not.toMatch(/Fake Acme|Fake Other|Robotics/);
    }
  });
  it("a visitor, a disabled login and a forged session are sent to the sign-in page", async () => {
    expect(await mergesPage(null)).toBe(SIGN_IN);
    expect(await mergesPage("gone")).toBe(SIGN_IN);
    expect(await render(null, () => merges({ searchParams: Promise.resolve({}) }), "better-auth.session_token=forged")).toBe(SIGN_IN);
  });
  it("the DETE names show for the three roles that read them, with Confirm link and Not the same for the account reviewer only; the two others have the note and the merge part", async () => {
    for (const r of ROLE_NAMES) {
      const p = await mergesPage(ROLE(r));
      expect(p.includes(ACME_DETE), `${r} names`).toBe(LINK_VIEWERS.includes(r));
      expect(p.includes("Confirm link"), `${r} buttons`).toBe(r === "account_reviewer");
      if (MERGE_ROLES.includes(r) && !LINK_VIEWERS.includes(r)) expect(p, r).toMatch(/The DETE name links are not for your roles/);
    }
    const p = await mergesPage(ROLE("account_reviewer"));
    expect(p).toMatch(/Same name as Fake Acme Robotics/);
    expect(p).toMatch(/12 permits/);
    expect(p).not.toMatch(/\d+% match|Eircode|automatically merged/);
    expect(p).not.toMatch(/&lt;script&gt;x&lt;\/script&gt;.*<script/); // the hostile name is escaped text
    expect(p).not.toMatch(/<script>x/);
  });
  it("the two-company comparison shows the counts to the five roles, Keep buttons only to the two that merge; a missing, equal or hostile number is a notice", async () => {
    for (const r of MERGE_ROLES) {
      const p = await mergesPage(ROLE(r), { a: ID.acme, b: ID.other });
      expect(p, r).toMatch(/Fake Acme Robotics/);
      expect(p, r).toMatch(/Active members/);
      expect(p.includes("Keep Fake Acme Robotics"), `${r} merge buttons`).toBe(r === "account_reviewer" || r === "fetched_job_reviewer");
    }
    expect(await mergesPage(ROLE("account_reviewer"), { a: ID.acme, b: "999999" })).toMatch(/Company number 999999 was not found/);
    expect(await mergesPage(ROLE("account_reviewer"), { a: ID.acme, b: ID.acme })).toMatch(/Pick two different companies/);
    for (const bad of [{ a: "1 or 1=1", b: "2" }, { a: "0", b: "-1" }, { a: "x".repeat(5000), b: "<script>" }, { a: ["1", "2"], b: "3" }, { a: "99999999999999999999", b: "1" }, { a: "１２", b: "1" }])
      expect(await mergesPage(ROLE("account_reviewer"), bad), JSON.stringify(bad)).toMatch(/Company name merges/);
  });
  it("hostile page numbers fall back to the first page, never fail", async () => {
    for (const page of ["0", "-1", "abc", "1001", "99999999999", "1 or 1=1", ["1", "2"], "２", "1\u0000", "<b>"]) expect(await mergesPage(ROLE("account_reviewer"), { page }), JSON.stringify(page)).toMatch(/Company name merges/);
    expect(await mergesPage(ROLE("account_reviewer"), { page: "9" })).toMatch(/No names on this page/);
  });
  it("the writes: every role but the account reviewer is refused a link; the page follows a link and a rejection; a name linked elsewhere gets its code", async () => {
    const before = (await q("select count(*)::int n from audit_event"))[0].n;
    for (const who of others(["account_reviewer"])) expect((await call(LINKS, who, { action: "link", deteName: ACME_DETE, organisationId: ID.acme })).json.error, who).toBe("not_dete_link_staff");
    expect((await call(LINKS, null, { action: "link", deteName: ACME_DETE, organisationId: ID.acme })).status).toBe(401);
    expect((await q("select count(*)::int n from audit_event"))[0].n).toBe(before);
    expect((await h.call(LINKS as never, "/", "only_account_reviewer", { action: "link", deteName: ACME_DETE, organisationId: ID.acme }, { origin: "https://evil.example" })).json.error).toBe("bad_origin");
    await h.ok(call(LINKS, ROLE("account_reviewer"), { action: "link", deteName: ACME_DETE, organisationId: ID.acme }));
    expect(await mergesPage(ROLE("account_reviewer"))).not.toContain(ACME_DETE);
    await h.no(call(LINKS, ROLE("account_reviewer"), { action: "link", deteName: ACME_DETE, organisationId: ID.other }), 409, "linked_elsewhere");
    const third = (await mergesPage(ROLE("account_reviewer"))).match(/Fake Third Care Co/);
    expect(third).not.toBeNull();
    await h.ok(call(LINKS, ROLE("account_reviewer"), { action: "reject", deteName: "<script>x</script> Fake Third Care Co", organisationId: ID.third }));
    expect(await mergesPage(ROLE("account_reviewer"))).not.toMatch(/Third Care/);
  });
  it("the merge: refused to the other roles, then done by the account reviewer; the absorbed company shows as merged", async () => {
    for (const who of others(["account_reviewer", "fetched_job_reviewer"])) expect((await call(MERGE, who, { absorbedId: ID.third, survivorId: ID.other })).json.error, who).toBe("not_company_staff");
    await h.ok(call(MERGE, ROLE("fetched_job_reviewer"), { absorbedId: ID.third, survivorId: ID.other }));
    expect(await mergesPage(ROLE("account_reviewer"), { a: ID.third, b: ID.other })).toMatch(/Already merged into another company/);
    await h.no(call(MERGE, ROLE("account_reviewer"), { absorbedId: ID.third, survivorId: ID.other }), 409, "already_merged");
  });
});

describe("P27 the content editor", () => {
  it("a content editor, a rules data editor and an administrator open it; every other role sees 'not for your roles' and no title", async () => {
    for (const r of CONTENT_ROLES) expect(await contentPage(ROLE(r)), r).toMatch(/Fake salary change/);
    for (const who of others(CONTENT_ROLES)) {
      const p = await contentPage(who, { id: ID.updDraft });
      expect(p, who).toMatch(NO_ACCESS);
      expect(p, who).not.toMatch(/Fake salary|Fake guide|Fake body/);
    }
    expect(await contentPage(null)).toBe(SIGN_IN);
    expect(await contentPage("gone")).toBe(SIGN_IN);
  });
  it("the tabs read their own kind; the stale list holds only the published guide not checked for 90 days", async () => {
    const e = ROLE("content_editor");
    const upd = await contentPage(e);
    expect(upd).toMatch(/Fake quota renewed/);
    expect(upd).toMatch(/Quotas/);
    expect(upd).not.toMatch(/Fake guide|Fake help page/);
    expect(await contentPage(e, { tab: "guide" })).toMatch(/Fake guide draft/);
    expect(await contentPage(e, { tab: "help" })).toMatch(/Fake help page/);
    expect(await contentPage(e, { tab: "occupation" })).toMatch(/Fake occupation text/);
    const stale = await contentPage(e, { tab: "stale" });
    expect(stale).toMatch(/Fake old guide/);
    expect(stale).not.toMatch(/Fake guide draft|Fake quota|Fake occupation text/);
    expect(stale).toMatch(/Not checked lately/);
  });
  it("an open page shows its form by role: the content editor edits a draft; the rules data editor publishes a guide but cannot edit; the administrator only reads", async () => {
    const draft = await contentPage(ROLE("content_editor"), { id: ID.updDraft });
    expect(draft).toMatch(/aria-label="Edit Fake salary change"/);
    expect(draft).toMatch(/>Save draft</);
    expect(draft).toMatch(/>Publish</);
    expect(draft).toMatch(/&lt;b&gt;two&lt;\/b&gt;/);
    expect(draft).not.toMatch(/<b>two|Email (me|candidates)/);
    const guide = await contentPage(ROLE("rules_data_editor"), { id: ID.guideDraft, tab: "guide" });
    expect(guide).toMatch(/>Publish</);
    expect(guide).not.toMatch(/>Save draft</);
    expect(await contentPage(ROLE("content_editor"), { id: ID.guideDraft, tab: "guide" })).not.toMatch(/>Publish</);
    const admin = await contentPage(ROLE("administrator"), { id: ID.updDraft });
    expect(admin).not.toMatch(/>Save draft<|>Publish<|>Withdraw</);
    expect(admin).toMatch(/Preview/);
    expect(await contentPage(ROLE("content_editor"), { id: ID.updLive })).toMatch(/>Withdraw</);
  });
  it("the preview shows the page as made, whatever its state; an id of nothing is a notice", async () => {
    const p = await contentPage(ROLE("content_editor"), { id: ID.updDraft, preview: "1" });
    expect(p).toMatch(/Preview of Fake salary change/);
    expect(p).toMatch(/Draft/);
    expect(p).not.toMatch(/<b>two/);
    expect(await contentPage(ROLE("content_editor"), { id: "999999" })).toMatch(/That page was not found/);
    expect(await contentPage(ROLE("content_editor"), { id: "999999", preview: "1" })).toMatch(/That page was not found/);
  });
  it("hostile addresses fall back, never fail", async () => {
    const bad: Params[] = [{ tab: "evil" }, { tab: ["guide", "help"] }, { tab: "<b>" }, { id: "0" }, { id: "-1" }, { id: "1 or 1=1" }, { id: "99999999999999999999" }, { id: ["1", "2"] }, { id: "<script>alert(1)</script>" }, { after: "x" }, { after: "a".repeat(500) },
      { after: "!!!" }, { preview: "1" }, { new: "1", id: ID.updDraft }, { tab: "stale", new: "1" }, { id: "１２" }, { id: "1\u0000" }];
    for (const p of bad) {
      const html = await contentPage(ROLE("content_editor"), p);
      expect(html, JSON.stringify(p)).toMatch(/Content editor/);
      expect(html, JSON.stringify(p)).not.toMatch(/<script>alert|<b>two/);
    }
    expect((await q("select count(*)::int n from content_page"))[0].n).toBe(6);
  });
  it("the writes through the route, then the page: create, refused edit of a published page, publish by the right role, withdraw; every other role is refused", async () => {
    const e = ROLE("content_editor"), rd = ROLE("rules_data_editor");
    const draft = { action: "create", kind: "update", slug: "fake-new-update", title: "Fake new update", body: "Fake text", category: "processing", effectiveFrom: "2027-03-01" };
    for (const who of others(["content_editor"])) expect((await call(CONTENT, who, draft)).json.error, who).toBe("not_content_editor");
    const made = await h.ok(call(CONTENT, e, draft));
    expect(await contentPage(e)).toMatch(/Fake new update/);
    await h.no(call(CONTENT, e, draft), 409, "slug_taken");
    await h.no(call(CONTENT, e, { action: "publish", id: made.id }), 409, "needs_source_and_checked_on");
    await h.ok(call(CONTENT, e, { action: "edit", id: made.id, sourceUrl: "https://enterprise.gov.ie/y", checkedOn: "2026-11-20" }));
    await h.no(call(CONTENT, rd, { action: "publish", id: made.id }), 403, "not_content_editor"); // help and updates are the content editor's to publish
    await h.ok(call(CONTENT, e, { action: "publish", id: made.id }));
    expect(await contentPage(e, { id: made.id })).toMatch(/A published page cannot be edited/);
    await h.no(call(CONTENT, e, { action: "edit", id: made.id, title: "x" }), 409, "not_editable");
    await h.ok(call(CONTENT, e, { action: "withdraw", id: made.id }));
    expect(await contentPage(e, { id: made.id })).toMatch(/Withdrawn/);
    await h.no(call(CONTENT, e, { action: "withdraw", id: made.id }), 409, "not_published");
    // a guide is published by the rules data editor, never by the content editor
    await h.ok(call(CONTENT, e, { action: "edit", id: ID.guideDraft, sourceUrl: "https://enterprise.gov.ie/z", checkedOn: "2026-11-21" }));
    await h.no(call(CONTENT, e, { action: "publish", id: ID.guideDraft }), 403, "not_rules_data_editor");
    await h.ok(call(CONTENT, rd, { action: "publish", id: ID.guideDraft }));
    expect(await contentPage(e, { tab: "guide" })).toMatch(/Published/);
  });
});

describe("P28 the audit log", () => {
  it("every role and a login with no role reads it; a visitor, a disabled login and a forged session are sent to sign in", async () => {
    for (const r of ROLE_NAMES) expect(await auditPage(ROLE(r)), r).toMatch(/Audit log/);
    expect(await auditPage("norole")).toMatch(/Audit log/);
    expect(await auditPage(null)).toBe(SIGN_IN);
    expect(await auditPage("gone")).toBe(SIGN_IN);
    expect(await render(null, () => audit({ searchParams: Promise.resolve({}) }), "better-auth.session_token=forged")).toBe(SIGN_IN);
  });
  it("an administrator reads every row, including the personal data views; any other member reads their own rows only", async () => {
    const a = rowsOf(await auditPage(ROLE("administrator")));
    for (const w of [/Approved an account/, /Hid a job after a report/, /candidate 88/, /Fake only_account_reviewer/, /Fake only_trust_and_safety/, /status: pending review → verified/]) expect(a).toMatch(w);
    expect(await auditPage(ROLE("administrator"))).toMatch(/name="staff"/);
    const ar = rowsOf(await auditPage(ROLE("account_reviewer")));
    expect(ar).toMatch(/Approved an account/);
    expect(ar).not.toMatch(/Hid a job|candidate 88|Fake only_trust_and_safety/);
    expect(await auditPage(ROLE("account_reviewer"))).not.toMatch(/name="staff"/);
    const ts = rowsOf(await auditPage(ROLE("trust_and_safety")));
    expect(ts).toMatch(/Hid a job/);
    expect(ts).not.toMatch(/Approved an account/);
    const none = rowsOf(await auditPage(ROLE("services_case_handler")));
    expect(await auditPage(ROLE("services_case_handler"))).toMatch(/No rows match/);
    expect(none).not.toMatch(/Approved an account|Hid a job/);
  });
  it("another member's id in the address never widens a non-administrator's view; an administrator may filter by person", async () => {
    const forged = rowsOf(await auditPage(ROLE("account_reviewer"), { staff: h.staff.only_trust_and_safety }));
    expect(forged).toMatch(/Approved an account/);
    expect(forged).not.toMatch(/Hid a job/);
    expect(await auditPage(ROLE("account_reviewer"), { staff: h.staff.only_trust_and_safety })).not.toContain(h.staff.only_trust_and_safety!);
    const by = rowsOf(await auditPage(ROLE("administrator"), { staff: h.staff.only_trust_and_safety }));
    expect(by).toMatch(/Hid a job/);
    expect(by).not.toMatch(/Approved an account/);
  });
  it("the kind chips, the action and the object filters read their own rows; dates and a bad range fall back with a notice", async () => {
    const a = ROLE("administrator");
    const data = rowsOf(await auditPage(a, { kind: "data_access" }));
    expect(data).toMatch(/candidate 88/);
    expect(data).not.toMatch(/Approved an account/);
    expect(rowsOf(await auditPage(a, { action: "account_review.approved" }))).not.toMatch(/Hid a job/);
    expect(rowsOf(await auditPage(a, { q: ID.acme }))).toMatch(/Approved an account/);
    expect(rowsOf(await auditPage(a, { q: ID.acme }))).not.toMatch(/Hid a job/);
    expect(await auditPage(a, { from: "2099-01-01" })).toMatch(/No rows match/);
    expect(await auditPage(a, { from: "2026-12-31", to: "2026-01-01" })).toMatch(/first day is after the last day/);
  });
  it("hostile addresses read the log with no filter, never fail", async () => {
    const bad: Params[] = [{ kind: "evil" }, { kind: ["a", "b"] }, { action: "Drop Table" }, { staff: "a b" }, { q: "<script>alert(1)</script>" }, { from: "2026-13-45" }, { to: "'; drop table audit_event; --" }, { after: "x" }, { after: "a".repeat(500) }, { after: "!!!" },
      { q: "x".repeat(5000) }, { from: "１２" }, { kind: "\u0000" }];
    for (const p of bad) {
      const html = await auditPage(ROLE("administrator"), p);
      expect(html, JSON.stringify(p)).toMatch(/Audit log/);
      expect(html, JSON.stringify(p)).not.toMatch(/<script>alert/);
    }
    expect((await q("select count(*)::int n from audit_event where action like 'audit.%'"))[0].n).toBe(0); // the page reads, it writes nothing
  });
  it("the export is the documented CSV route: an administrator gets every row, another member their own, and the page's button is built on the same filters", async () => {
    const EXPORT = (await import("../../../apps/admin/app/api/audit/export/route")) as unknown as { GET: (r: Request) => Promise<Response> };
    const get = async (who: string, qs = "") => EXPORT.GET(new Request(`http://localhost:3002/api/audit/export${qs}`, { headers: { cookie: h.cookies[who]! } }));
    const all = await get(ROLE("administrator"));
    expect(all.status).toBe(200);
    expect(all.headers.get("content-disposition")).toMatch(/attachment; filename="audit-\d{4}-\d\d-\d\d\.csv"/);
    const csv = await all.text();
    expect(csv).toMatch(/Hid a job|trust_safety\.report_hide/);
    const mine = await (await get(ROLE("account_reviewer"))).text();
    expect(mine).toMatch(/account_review\.approved/);
    expect(mine).not.toMatch(/trust_safety\.report_hide|data_access\.view/);
    expect((await get(ROLE("account_reviewer"), `?staff=${h.staff.only_trust_and_safety}`)).status).toBe(403);
    const p = await auditPage(ROLE("administrator"), { kind: "admin_action", q: "strike:12" });
    expect(p).toMatch(/Export/);
  });
});

describe("P28 staff and roles", () => {
  it("only an administrator opens it; every other role and a login with no role see 'not for your roles' and no one's email", async () => {
    const ok = await staffView(ROLE("administrator"));
    expect(ok).toMatch(/Staff and roles/);
    expect(ok).toMatch(/only_account_reviewer@example\.test/);
    for (const who of others(["administrator"])) {
      const p = await staffView(who);
      expect(p, who).toMatch(NO_ACCESS);
      expect(p, who).not.toMatch(/example\.test|Fake only_/);
    }
    expect(await staffView(null)).toBe(SIGN_IN);
    expect(await staffView("gone")).toBe(SIGN_IN);
  });
  it("shows each login with its roles and state, the matrix, and no two-step or last-active column", async () => {
    const p = await staffView(ROLE("administrator"));
    for (const w of [/Fake only_content_editor/, />Content editor</, />Active</, /Permission matrix/, /Yes<span class="sr-only"> for Administrator/, /Staff and roles/]) expect(p).toMatch(w);
    expect(p).not.toMatch(/Two-step|Last active|Super admin/);
    expect(p).toMatch(/>Disabled</); // the disabled login "gone"
  });
  it("the writes are refused to every other role, a visitor and a disabled login, and nothing changes", async () => {
    const before = (await q("select (select count(*) from staff_role) + (select count(*) from approval_request) n"))[0].n;
    const bodies = [{ action: "propose_role", staffId: h.staff.norole, role: "content_editor" }, { action: "remove_role", staffId: h.staff.only_content_editor, role: "content_editor" }, { action: "disable", staffId: h.staff.norole }];
    for (const who of others(["administrator"])) for (const b of bodies) expect((await call(STAFF, who, b)).json.error, `${who} ${b.action}`).toBe("not_administrator");
    for (const b of bodies) { expect((await call(STAFF, null, b)).status).toBe(401); expect((await call(STAFF, "gone", b)).status).toBe(401); }
    expect((await q("select (select count(*) from staff_role) + (select count(*) from approval_request) n"))[0].n).toBe(before);
  });
  it("two-person grant: the page shows who proposed; the proposer cannot confirm; a different administrator confirms and the page follows", async () => {
    const a1 = ROLE("administrator");
    const { requestId } = await h.ok(call(STAFF, a1, { action: "propose_role", staffId: h.staff.norole, role: "content_editor" }));
    const mine = await staffView(a1);
    expect(mine).toMatch(/Waiting for a second administrator/);
    expect(mine).toMatch(/Proposed by you/);
    expect(mine).toMatch(/A different administrator confirms it/);
    expect(mine).not.toMatch(/>Confirm</);
    await h.no(call(STAFF, a1, { action: "confirm_role", requestId }), 409, "same_person");
    const theirs = await staffView("admin2");
    expect(theirs).toMatch(/Proposed by Fake only_administrator/);
    expect(theirs).toMatch(/>Confirm</);
    expect(theirs).toMatch(/>Refuse</);
    await h.ok(call(STAFF, "admin2", { action: "confirm_role", requestId }));
    expect(await staffView(a1)).toMatch(/No role grant is waiting/);
    expect((await q("select role from staff_role where staff_user_id = $1", [h.staff.norole])).map((r) => r.role)).toEqual(["content_editor"]);
  });
  it("the last active administrator cannot lose the role or be disabled: the buttons are off, and the route refuses it with its code", async () => {
    // two active administrators now (only_administrator, admin2); take one away, leaving one
    await h.ok(call(STAFF, "admin2", { action: "disable", staffId: h.staff.admin2 }));
    const p = await staffView(ROLE("administrator"));
    expect(p).toMatch(/last active administrator cannot lose the role or be disabled/);
    expect(p).toMatch(/<button[^>]*disabled[^>]*>Remove Administrator/);
    await h.no(call(STAFF, ROLE("administrator"), { action: "remove_role", staffId: h.staff.only_administrator, role: "administrator" }), 409, "last_administrator");
    await h.no(call(STAFF, ROLE("administrator"), { action: "disable", staffId: h.staff.only_administrator }), 409, "last_administrator");
    await h.no(call(STAFF, ROLE("administrator"), { action: "enable", staffId: h.staff.admin2 }), 409, "holds_roles");
    await h.ok(call(STAFF, ROLE("administrator"), { action: "remove_role", staffId: h.staff.admin2, role: "administrator" }));
    expect(await staffView(ROLE("administrator"))).toMatch(/>Enable</);
    await h.ok(call(STAFF, ROLE("administrator"), { action: "enable", staffId: h.staff.admin2 }));
  });
  it("a write after the sign-in is older than 10 minutes is refused with reauth_required, and the sign-in page then takes the person back", async () => {
    await su.query("update staff_session set created_at = now() - interval '11 minutes' where user_id = $1", [h.staff.only_administrator]);
    await h.no(call(STAFF, ROLE("administrator"), { action: "disable", staffId: h.staff.norole }), 403, "reauth_required");
    expect((await q("select status from staff_user where id = $1", [h.staff.norole]))[0].status).toBe("active");
    const again = await signInPage(ROLE("administrator"), { again: "1", next: "/staff" });
    expect(again).toMatch(/Staff <span[^>]*>sign in/);
    expect(again).toMatch(/needs a sign-in from the last 10 minutes/);
    expect(await staffView(ROLE("administrator"))).toMatch(/Staff and roles/); // reading still works
  });
});

describe("the staff sign-in page: the re-sign-in (DD10)", () => {
  it("a visitor sees the form; a signed-in member goes to the overview, or to an own path in next; with again=1 the form shows to a signed-in member", async () => {
    expect(await signInPage(null)).toMatch(/Staff <span[^>]*>sign in/);
    expect(await signInPage(ROLE("account_reviewer"))).toBe("REDIRECT:/");
    expect(await signInPage(ROLE("account_reviewer"), { next: "/staff" })).toBe("REDIRECT:/staff");
    expect(await signInPage(ROLE("account_reviewer"), { next: "/audit?kind=security" })).toBe("REDIRECT:/audit?kind=security");
    expect(await signInPage(ROLE("account_reviewer"), { again: "1", next: "/staff" })).toMatch(/Staff <span[^>]*>sign in/);
  });
  it("a return address that is not our own path is dropped: an open redirect is never followed", async () => {
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", "https:evil.example", "/%2Fevil.example", "javascript:alert(1)", "/sign-in", "/api/staff", ["/staff", "/audit"], "x".repeat(2000)])
      expect(await signInPage(ROLE("account_reviewer"), { next }), JSON.stringify(next).slice(0, 40)).toBe("REDIRECT:/");
  });
});

describe("performance: statements and time of one page render", () => {
  const budget = async (who: string, page: () => Promise<string>, max: number, name: string, ms = BUDGET.ms) => {
    await page(); // warm
    const [, n] = await counted(page);
    const m = await median(page);
    console.log(`${name}: ${n} statements, median ${m.toFixed(1)} ms`);
    expect(n, `${name} statements`).toBeLessThanOrEqual(max);
    expect(m, `${name} median ms`).toBeLessThan(ms);
    state.headers = new Headers({ cookie: h.cookies[who]! });
  };
  it("each page for the role that works it", async () => {
    await budget(ROLE("account_reviewer"), () => mergesPage(ROLE("account_reviewer"), { a: ID.acme, b: ID.other }), BUDGET.merges, "name merges with a comparison");
    await budget(ROLE("content_editor"), () => contentPage(ROLE("content_editor"), { id: ID.updDraft }), BUDGET.content, "content with an open page");
    await budget(ROLE("content_editor"), () => contentPage(ROLE("content_editor"), { tab: "stale" }), BUDGET.content, "content stale list");
    await budget(ROLE("administrator"), () => auditPage(ROLE("administrator")), BUDGET.audit, "audit log, administrator", BUDGET.auditAdminMs);
    await budget(ROLE("account_reviewer"), () => auditPage(ROLE("account_reviewer")), BUDGET.audit, "audit log, member");
    await budget(ROLE("administrator"), () => staffView(ROLE("administrator")), BUDGET.staff, "staff and roles");
    await budget(ROLE("account_reviewer"), () => signInPage(ROLE("account_reviewer"), { again: "1", next: "/staff" }), BUDGET.signIn, "sign-in page, re-sign-in");
  });
});
