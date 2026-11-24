// Step 16 pages P14 (admin overview), P15 (account review queue) and P16 (fetched-job review): the pages' own server code on the real test database as app_admin,
// with real staff sessions. Each page function is called as Next calls it (its search params in, its element out) and the element is rendered to HTML, so what a role
// would be sent is what is asserted. All seven roles, a login with no role, a disabled login and a signed-out visitor are tried on every page and on every write
// (the real routes /api/account-review and /api/fetched-jobs); no field a role may not see appears in the HTML. Only Next's request context is stood in
// (next/headers gives the headers a test sets, next/navigation the redirect and router, server-only is empty). Fake people only, no network.
// Budget (measured 24 November 2026, three runs, printed by the last test): each read of the data layer starts with requireStaff (2 statements) and its own role check, so a page is
// several reads: an administrator's overview 27 statements (median 7.8 to 9.4 ms), a two-role reviewer's overview 32 (9.2 to 11.0 ms: it also reads two queues and the name-merge
// count), the account review page 8 (6.2 to 7.5 ms), the fetched-job page with a dry run 22 (12.3 to 13.5 ms). Limits: the measured statements plus 4, and a clock limit of
// about 8 times the slowest median with a floor for a busy laptop. Raise these only on purpose. Scale (many rows) is in perf/admin-pages.perf.ts.
import type pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { counted, median, ROLE_NAMES, staffHarness } from "./staff-routes-harness";
import { seedW5 } from "./w5-seed";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`REDIRECT:${to}`), { to }); },
  useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/",
}));

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BUDGET = { overviewAdmin: 31, overviewReviewer: 36, accounts: 12, fetched: 26, overviewMs: 100, accountsMs: 50, fetchedMs: 80 };

type Params = Record<string, string | string[] | undefined>;
type PageFn = (a: { searchParams: Promise<Params> }) => Promise<React.ReactElement>;
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool, S: Awaited<ReturnType<typeof seedW5>>;
let overview: () => Promise<React.ReactElement>, accounts: PageFn, fetched: PageFn;
let ACCOUNT: { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> }, FETCHED: typeof ACCOUNT;

// The page modules are .tsx and this package has no jsx setting, so they are loaded by a path built at run time (vite still resolves and transforms them).
const pageModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ `../../../apps/admin/app/${name}`);

/** The page as the named login would be sent it: its HTML, or "REDIRECT:/path" when the page sends the visitor elsewhere. */
async function render(who: string | null, page: () => Promise<React.ReactElement>): Promise<string> {
  state.headers = new Headers(who ? { cookie: h.cookies[who]! } : {});
  try {
    return renderToStaticMarkup(await page());
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT:")) return e.message;
    throw e;
  }
}
const accountsPage = (who: string | null, p: Params = {}) => render(who, () => accounts({ searchParams: Promise.resolve(p) }));
const fetchedPage = (who: string | null, p: Params = {}) => render(who, () => fetched({ searchParams: Promise.resolve(p) }));
const overviewPage = (who: string | null) => render(who, () => overview());
const tiles = (html: string) => [...html.matchAll(/data-tile="(\w+)"/g)].map((m) => m[1]!);
const call = (route: typeof ACCOUNT, who: string | null, body: unknown) => h.call(route as never, "/", who, body);
const ROLE = (r: string) => `only_${r}`;
const NO_ACCESS = /This page is not for your roles/;
const SIGN_IN = "REDIRECT:/sign-in";

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  for (const r of ROLE_NAMES) await h.makeStaff(ROLE(r), [r]);
  await h.makeStaff("both", ["account_reviewer", "fetched_job_reviewer"]);
  await h.makeStaff("both2", ["account_reviewer", "fetched_job_reviewer"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("gone", ["account_reviewer", "fetched_job_reviewer", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]); // after sign-in: its open session must be refused too
  S = await seedW5(db as never);
  ({ default: overview } = (await pageModule("page")) as { default: typeof overview });
  ({ default: accounts } = (await pageModule("account-reviews/page")) as { default: PageFn });
  ({ default: fetched } = (await pageModule("fetched-jobs/page")) as { default: PageFn });
  ACCOUNT = await import("../../../apps/admin/app/api/account-review/route");
  FETCHED = await import("../../../apps/admin/app/api/fetched-jobs/route");
  // audit rows: one by the account reviewer, one by someone else (the overview shows a non-administrator only their own)
  for (const [who, action, type, obj] of [["only_account_reviewer", "account_review.approved", "organisation", S.acc.approved!.org], ["only_trust_and_safety", "trust_safety.report_hide", "job", S.jobs.irish!.job]] as const)
    await su.query("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, source) values ('admin_action', $1, $2, $3, $4, 'panel')", [h.staff[who], action, type, obj]);
  // a rules version still to come (the notice), through the real two-person steps: a rules data editor proposes, an administrator confirms
  const { listRules, proposeRules, confirmRules } = await import("../src");
  const pool = db.pool("app_admin");
  const current = (await listRules(pool, h.staff.only_administrator!)).inForce.find((v) => v.kind === "minimums")!;
  const { requestId } = await proposeRules(pool, h.staff.only_rules_data_editor!, {
    kind: "minimums", effectiveFrom: new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10), data: { ...(current.data as object), criticalSkills: (current.data as { criticalSkills: number }).criticalSkills + 100 },
  });
  await confirmRules(pool, h.staff.only_administrator!, requestId);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("P14 the overview, one per role", () => {
  const WANT: Record<string, string[]> = {
    account_reviewer: ["account", "merges"], fetched_job_reviewer: ["fetched"], rules_data_editor: [], trust_and_safety: ["reports", "merges"], services_case_handler: ["services"], content_editor: [],
    administrator: ["merges", "approvals", "overdue"],
  };
  for (const role of ROLE_NAMES)
    it(`${role}: the tiles of its own queues only, ${role === "administrator" ? "every audit row" : "its own audit rows"}`, async () => {
      const p = await overviewPage(ROLE(role));
      expect(tiles(p), role).toEqual(WANT[role]);
      expect(p).toMatch(/Queues <span[^>]*>overview/);
      expect(p).toMatch(/98% or more/);
      expect(p).toMatch(/Rules change on/); // any staff member reads the rules data
      expect(p).not.toMatch(/Pipelines/);
      // work rows and names: only the queues the role may read
      expect(p.includes("Fake Harbourline Hotels Ltd"), "account rows").toBe(role === "account_reviewer");
      expect(p.includes("Fake Platform Engineer"), "fetched rows").toBe(role === "fetched_job_reviewer");
      // audit: a non-administrator sees only their own rows; the administrator sees every row
      expect(p.includes("approved an account"), "own audit row").toBe(role === "account_reviewer" || role === "administrator");
      expect(p.includes("hid a job after a report"), "another's audit row").toBe(role === "trust_and_safety" || role === "administrator");
      // no claimant contact, no id of a person, nothing raw
      expect(p).not.toMatch(/example\.test|@|portal_user|p-\d+-|\"before\"|secret/);
    });
  it("a login with no role gets the clear page, no tile, no queue name and no other person's audit row", async () => {
    const p = await overviewPage("norole");
    expect(p).toMatch(/Your login has no role yet|Your roles have no queue here/); // seeded as content editor, then stripped of its role
    expect(tiles(p)).toEqual([]);
    expect(p).not.toMatch(/Harbourline|Platform Engineer|approved an account|hid a job/);
  });
  it("roles with no queue get the clear page, not an empty one", async () => {
    for (const r of ["rules_data_editor", "content_editor"]) expect(await overviewPage(ROLE(r)), r).toMatch(/Your roles have no queue here/);
  });
  it("a signed-out visitor, a disabled login and a forged session are sent to the sign-in page", async () => {
    expect(await overviewPage(null)).toBe(SIGN_IN);
    expect(await overviewPage("gone")).toBe(SIGN_IN);
    state.headers = new Headers({ cookie: "better-auth.session_token=forged" });
    expect(await render(null, () => overview())).toBe(SIGN_IN);
  });
  it("the counts and ages come from the database: 5 waiting claims, the oldest 30 h, and the tile links go to the queue pages", async () => {
    const p = await overviewPage(ROLE("account_reviewer"));
    expect(p).toMatch(/data-tile="account"[^>]*><a[^>]*href="\/account-reviews"/);
    expect(p).toMatch(/>(\d)<\/span><span[^>]*>Account reviews · oldest 30 h</);
    expect(await overviewPage(ROLE("fetched_job_reviewer"))).toMatch(/Fetched jobs · oldest 9 h/);
  });
});

describe("P15 the account review queue", () => {
  it("only an account reviewer sees the queue; every other role, a login with no role and the administrator see the 'not for your roles' page and none of its data", async () => {
    const ok = await accountsPage(ROLE("account_reviewer"));
    expect(ok).toMatch(/Fake Harbourline Hotels Ltd/);
    expect(ok).toMatch(/Account reviews/);
    for (const who of [...ROLE_NAMES.filter((r) => r !== "account_reviewer").map(ROLE), "norole"]) {
      const p = await accountsPage(who);
      expect(p, who).toMatch(NO_ACCESS);
      expect(p, who).not.toMatch(/Harbourline|example\.test|gmail|Fake Owner|Waiting/);
    }
  });
  it("a visitor, a disabled login and a forged session are sent to the sign-in page", async () => {
    expect(await accountsPage(null)).toBe(SIGN_IN);
    expect(await accountsPage("gone")).toBe(SIGN_IN);
    expect(await render(null, () => accounts({ searchParams: Promise.resolve({}) }))).toBe(SIGN_IN);
  });
  it("shows the waiting claims oldest first with their flags, and the first one's card (Free email, the register check, the ban list)", async () => {
    const p = await accountsPage(ROLE("account_reviewer"));
    expect(p.indexOf("Fake Harbourline")).toBeGreaterThan(-1);
    expect(p).toMatch(/Free email/);
    expect(p).toMatch(/Licence found/);
    expect(p).toMatch(/Shared mailbox/);
    expect(p).toMatch(/Signed up by Fake Owner One · fake\.owner1@gmail\.com/);
    expect(p).toMatch(/Free provider \(gmail\.com\)/);
    expect(p).toMatch(/Not an agency/);
    expect(p).toMatch(/Claim this review/);
  });
  it("the tabs read their own lists: needs more info with the company's answer, approved and rejected with their counts", async () => {
    const needs = await accountsPage(ROLE("account_reviewer"), { tab: "needs_info" });
    expect(needs).toMatch(/Fake Lakeside Care Homes/);
    expect(needs).toMatch(/The company answered/);
    expect(needs).toMatch(/Fake answer: we are a care home group/);
    expect(await accountsPage(ROLE("account_reviewer"), { tab: "approved" })).toMatch(/Fake Approved Foods Ltd/);
    expect(await accountsPage(ROLE("account_reviewer"), { tab: "rejected" })).toMatch(/Fake Rejected Trading Ltd/);
    expect(await accountsPage(ROLE("account_reviewer"), { tab: "approved" })).not.toMatch(/Fake Harbourline/);
  });
  it("an item by id opens even from another tab; an id that is not an account review is a notice, never an error", async () => {
    const mine = await accountsPage(ROLE("account_reviewer"), { id: S.acc.tallis!.item });
    expect(mine).toMatch(/aria-label="Review of Fake Tallis Analytics Ltd"/);
    expect(mine).toMatch(/No register check was made at claim|No CRO number/);
    const foreign = await accountsPage(ROLE("account_reviewer"), { id: S.jobs.contract!.item }); // a fetched-job item id
    expect(foreign).toMatch(/That item is not an account review/);
    expect(foreign).not.toMatch(/Platform Engineer/);
  });
  it("hostile addresses fall back, never fail: unknown and repeated tabs, bad cursors, bad and huge ids, injection text, markup", async () => {
    const bad: Params[] = [
      { tab: "evil" }, { tab: ["waiting", "approved"] }, { tab: "waiting' or 1=1 --" }, { after: "x" }, { after: "a".repeat(500) }, { after: "!!!" }, { id: "0" }, { id: "-1" }, { id: "1 or 1=1" }, { id: "99999999999999999999" },
      { id: "１２" }, { id: "x".repeat(5000) }, { id: ["1", "2"] }, { id: "<script>alert(1)</script>" }, { tab: "<b>", id: "'; drop table review_item; --" }, { id: "1\u0000" },
    ];
    for (const p of bad) {
      const html = await accountsPage(ROLE("account_reviewer"), p);
      expect(html, JSON.stringify(p)).toMatch(/Account reviews/);
      expect(html, JSON.stringify(p)).not.toMatch(/<script>alert|<b>/);
    }
    expect((await su.query("select count(*)::int n from review_item where queue = 'account_review'")).rows[0].n).toBe(7);
  });
  it("another reviewer's staff id never reaches the page", async () => {
    await h.call(ACCOUNT as never, "/", "both2", { action: "claim", itemId: S.acc.shared!.item });
    const p = await accountsPage(ROLE("account_reviewer"), { id: S.acc.shared!.item });
    expect(p).toMatch(/Another reviewer holds this item/);
    expect(p).not.toContain(h.staff.both2!);
    await h.call(ACCOUNT as never, "/", "both2", { action: "release", itemId: S.acc.shared!.item });
  });
});

describe("P15 the writes, each role", () => {
  const writes = (item: string) => [{ action: "claim", itemId: item }, { action: "release", itemId: item }, { action: "approve", itemId: item, addDomain: true }, { action: "ask_more", itemId: item, question: "Fake question" }, { action: "reject", itemId: item, reason: "duplicate" }];
  it("every role but the account reviewer is refused on every action, a visitor and a disabled login too, and nothing changes", async () => {
    const before = (await su.query("select count(*)::int n from audit_event")).rows[0].n;
    for (const who of [...ROLE_NAMES.filter((r) => r !== "account_reviewer").map(ROLE), "norole"])
      for (const b of writes(S.acc.harbourline!.item)) { const r = await call(ACCOUNT, who, b); expect([r.status, r.json.error], `${who} ${b.action}`).toEqual([403, "not_reviewer"]); }
    for (const b of writes(S.acc.harbourline!.item)) {
      expect((await call(ACCOUNT, null, b)).status).toBe(401);
      expect((await call(ACCOUNT, "gone", b)).status).toBe(401);
    }
    expect((await su.query("select status from review_item where id = $1", [S.acc.harbourline!.item])).rows[0].status).toBe("open");
    expect((await su.query("select count(*)::int n from audit_event")).rows[0].n).toBe(before);
  });
  it("the form's own Origin check holds: a post from another origin or with none is refused", async () => {
    const b = { action: "claim", itemId: S.acc.harbourline!.item };
    expect((await h.call(ACCOUNT as never, "/", "both", b, { origin: "https://evil.example" })).json.error).toBe("bad_origin");
    expect((await h.call(ACCOUNT as never, "/", "both", b, { origin: null })).json.error).toBe("bad_origin");
  });
  it("claim, then approve with the domain: the page follows, one audit row, the company verified and the domain saved; a free email domain is refused with its code", async () => {
    expect((await call(ACCOUNT, "both", { action: "claim", itemId: S.acc.agency!.item })).status).toBe(200);
    const mine = await accountsPage("both", { id: S.acc.agency!.item });
    expect(mine).toMatch(/Add the email domain \(fakeagency\.example\.test\)/);
    expect(mine).not.toMatch(/Claim this review/);
    // a free provider's domain cannot be saved
    expect((await call(ACCOUNT, "both", { action: "claim", itemId: S.acc.harbourline!.item })).status).toBe(200);
    const free = await call(ACCOUNT, "both", { action: "approve", itemId: S.acc.harbourline!.item, addDomain: true });
    expect([free.status, free.json.error]).toEqual([409, "free_email_domain"]);
    expect((await su.query("select status from organisation where id = $1", [S.acc.harbourline!.org])).rows[0].status).toBe("pending_review");
    const ok = await call(ACCOUNT, "both", { action: "approve", itemId: S.acc.agency!.item, addDomain: true });
    expect(ok.status).toBe(200);
    expect((await su.query("select status from organisation where id = $1", [S.acc.agency!.org])).rows[0].status).toBe("verified");
    expect((await su.query("select domain from organisation_domain where organisation_id = $1", [S.acc.agency!.org])).rows.map((r) => r.domain)).toEqual(["fakeagency.example.test"]);
    expect((await su.query("select count(*)::int n from audit_event where action = 'account_review.approved' and object_id = $1", [S.acc.agency!.org])).rows[0].n).toBe(1);
    expect(await accountsPage("both", { tab: "approved" })).toMatch(/Fake Example Recruitment Ltd/);
    // a second decision on the same item is refused with its code
    expect((await call(ACCOUNT, "both", { action: "approve", itemId: S.acc.agency!.item })).json.error).toBe("already_decided");
  });
  it("ask for more keeps the item and sends the question; reject needs a reason and closes it; each writes one audit row", async () => {
    expect((await call(ACCOUNT, "both", { action: "ask_more", itemId: S.acc.harbourline!.item, question: "Please send your CRO certificate" })).status).toBe(200);
    expect((await su.query("select params->>'question' q from notification where template_key = 'account_needs_info' order by id desc limit 1")).rows[0].q).toBe("Please send your CRO certificate");
    expect((await call(ACCOUNT, "both", { action: "reject", itemId: S.acc.harbourline!.item })).json.error).toBe("bad_reason");
    expect((await call(ACCOUNT, "both", { action: "claim", itemId: S.acc.harbourline!.item })).status).toBe(200);
    expect((await call(ACCOUNT, "both", { action: "reject", itemId: S.acc.harbourline!.item, reason: "cannot_verify" })).status).toBe(200);
    expect((await su.query("select action from audit_event where object_type = 'organisation' and object_id = $1 order by id", [S.acc.harbourline!.org])).rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["account_review.needs_info", "account_review.rejected"]));
    expect(await accountsPage("both", { tab: "rejected" })).toMatch(/Fake Harbourline Hotels Ltd/);
  });
});

describe("P16 the fetched-job queue", () => {
  it("only a fetched-job reviewer sees the queue; every other role, a login with no role and the administrator see the 'not for your roles' page and none of its data", async () => {
    const ok = await fetchedPage(ROLE("fetched_job_reviewer"));
    expect(ok).toMatch(/Fake Platform Engineer, Medical Systems/);
    for (const who of [...ROLE_NAMES.filter((r) => r !== "fetched_job_reviewer").map(ROLE), "norole"]) {
      const p = await fetchedPage(who);
      expect(p, who).toMatch(NO_ACCESS);
      expect(p, who).not.toMatch(/Platform Engineer|Fake Northquay|jobs\.example\.test|specified purpose/);
    }
  });
  it("a visitor, a disabled login and a forged session are sent to the sign-in page", async () => {
    expect(await fetchedPage(null)).toBe(SIGN_IN);
    expect(await fetchedPage("gone")).toBe(SIGN_IN);
    expect(await render(null, () => fetched({ searchParams: Promise.resolve({}) }))).toBe(SIGN_IN);
  });
  it("lists the queue oldest first with the category chips from the stage texts and their counts, and opens the first item with its evidence and its checks", async () => {
    const p = await fetchedPage(ROLE("fetched_job_reviewer"));
    expect(p).toMatch(/All <span[^>]*>5</);
    expect(p).toMatch(/Contract unclear <span[^>]*>2</);
    expect(p).toMatch(/Unsure occupation <span[^>]*>2</);
    expect(p).toMatch(/Unsure Irish employer <span[^>]*>1</);
    expect(p.indexOf("Fake Platform Engineer, Medical Systems")).toBeLessThan(p.indexOf("Fake Data Analyst")); // 9 h before 7 h
    expect(p).toMatch(/Why it was queued: quoted evidence/);
    expect(p).toMatch(/specified purpose contract with a view to permanency/);
    expect(p).toMatch(/Fake Northquay Hospital Group · Cork · careers page/);
    expect(p).toMatch(/Claim this job/);
    expect(p).toMatch(/Irish employer/);
  });
  it("one category keeps only its items; an unknown category falls back to the whole queue", async () => {
    const p = await fetchedPage(ROLE("fetched_job_reviewer"), { stage: "5 unsure occupation (admin queue)" });
    expect(p).toMatch(/Fake Data Analyst/);
    expect(p).not.toMatch(/Fake Field Service Engineer/);
    expect(await fetchedPage(ROLE("fetched_job_reviewer"), { stage: "no such stage" })).toMatch(/Nothing in this category/); // a stage nobody is in: that category is empty
    expect(await fetchedPage(ROLE("fetched_job_reviewer"), { stage: "x".repeat(300) })).toMatch(/Fake Platform Engineer/); // a text the route refuses (bad_stage): the whole queue
  });
  it("the dry run follows the code in the address: a good code publishes, a code off the list is a notice, a bad one is dropped", async () => {
    const good = await fetchedPage(ROLE("fetched_job_reviewer"), { id: S.jobs.contract!.item, soc: "2134", contract: "1" });
    expect(good).toMatch(/Critical Skills eligible/);
    expect(good).toMatch(/Exclusion words/);
    expect(good).toMatch(/Quota/);
    const off = await fetchedPage(ROLE("fetched_job_reviewer"), { id: S.jobs.contract!.item, soc: "9999" });
    expect(off).toMatch(/not on the Critical Skills list/);
    const junk = await fetchedPage(ROLE("fetched_job_reviewer"), { id: S.jobs.contract!.item, soc: "21345", low: "-1", high: "1e3", contract: "x" });
    expect(junk).toMatch(/Fake Platform Engineer/);
    const noCode = await fetchedPage(ROLE("fetched_job_reviewer"), { id: S.jobs.occupation!.item }); // no code yet
    expect(noCode).toMatch(/Pick a SOC code and press Check/);
  });
  it("hostile addresses fall back, never fail", async () => {
    const bad: Params[] = [
      { stage: ["a", "b"] }, { stage: "" }, { stage: "a\u0000b" }, { stage: "' or 1=1 --" }, { after: "x" }, { after: "a".repeat(500) }, { id: "0" }, { id: "-1" }, { id: "1 or 1=1" }, { id: "99999999999999999999" },
      { id: ["1", "2"] }, { id: "<script>alert(1)</script>" }, { soc: ["2134", "2231"] }, { low: "9".repeat(50), high: "x" }, { id: S.jobs.contract!.item, soc: "2134'; drop table job; --" },
      { id: S.jobs.contract!.item, low: "50000", high: "40000", soc: "2134" }, { id: S.jobs.contract!.item, high: "50000", soc: "2134" },
    ];
    for (const p of bad) {
      const html = await fetchedPage(ROLE("fetched_job_reviewer"), p);
      expect(html, JSON.stringify(p)).toMatch(/Fetched <span/);
      expect(html, JSON.stringify(p)).not.toMatch(/<script>alert/);
    }
    expect((await su.query("select count(*)::int n from job where status = 'in_review'")).rows[0].n).toBe(5);
  });
  it("advert and employer text is escaped, never markup, on the list and the card", async () => {
    const p = await fetchedPage(ROLE("fetched_job_reviewer"), { id: S.jobs.script!.item });
    expect(p).not.toMatch(/<script>|<img |<b>bold|onerror=alert\(1\)>/);
    expect(p).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt; Fake Risk Analyst/);
  });
  it("another reviewer's staff id never reaches the page", async () => {
    await h.call(FETCHED as never, "/", "both2", { action: "claim", itemId: S.jobs.irish!.item });
    const p = await fetchedPage(ROLE("fetched_job_reviewer"), { id: S.jobs.irish!.item });
    expect(p).toMatch(/Another reviewer holds this item/);
    expect(p).not.toContain(h.staff.both2!);
    await h.call(FETCHED as never, "/", "both2", { action: "release", itemId: S.jobs.irish!.item });
  });
});

describe("P16 the writes, each role", () => {
  const writes = (item: string) => [{ action: "claim", itemId: item }, { action: "release", itemId: item }, { action: "approve", itemId: item, occupationCode: "2134", contractConfirmed: true }, { action: "reject", itemId: item, reason: "duplicate" }];
  it("every role but the fetched-job reviewer is refused on every action, a visitor and a disabled login too, and nothing changes", async () => {
    const before = (await su.query("select count(*)::int n from audit_event")).rows[0].n;
    for (const who of [...ROLE_NAMES.filter((r) => r !== "fetched_job_reviewer").map(ROLE), "norole"])
      for (const b of writes(S.jobs.contract!.item)) { const r = await call(FETCHED, who, b); expect([r.status, r.json.error], `${who} ${b.action}`).toEqual([403, "not_reviewer"]); }
    for (const b of writes(S.jobs.contract!.item)) {
      expect((await call(FETCHED, null, b)).status).toBe(401);
      expect((await call(FETCHED, "gone", b)).status).toBe(401);
    }
    expect((await su.query("select status from job where id = $1", [S.jobs.contract!.job])).rows[0].status).toBe("in_review");
    expect((await su.query("select count(*)::int n from audit_event")).rows[0].n).toBe(before);
  });
  it("the dry-run route refuses every other role as well", async () => {
    const dry = await import("../../../apps/admin/app/api/fetched-jobs/dry-run/route");
    for (const who of [...ROLE_NAMES.filter((r) => r !== "fetched_job_reviewer").map(ROLE), "norole"]) {
      const r = await h.call(dry as never, "/", who, undefined, { query: `?id=${S.jobs.contract!.item}&occupationCode=2134` });
      expect([r.status, r.json.error], who).toEqual([403, "not_reviewer"]);
    }
    expect((await h.call(dry as never, "/", null, undefined, { query: `?id=${S.jobs.contract!.item}&occupationCode=2134` })).status).toBe(401);
  });
  it("claim, check, approve with a fixed code: the job goes live with the badge and the new code, one audit row names the old and new code; the page then shows it decided", async () => {
    expect((await call(FETCHED, "both", { action: "claim", itemId: S.jobs.contract!.item })).status).toBe(200);
    const mine = await fetchedPage("both", { id: S.jobs.contract!.item, soc: "2231", contract: "1" });
    expect(mine).toMatch(/Approve and publish/);
    expect(mine).toMatch(/Check this SOC code/);
    expect(mine).toMatch(/2134 · /); // the picker holds the Critical Skills list from the rules data
    expect(mine).toMatch(/2231 · /);
    const ok = await call(FETCHED, "both", { action: "approve", itemId: S.jobs.contract!.item, occupationCode: "2134", contractConfirmed: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await su.query("select status, badge, occupation_code from job where id = $1", [S.jobs.contract!.job])).rows[0]).toMatchObject({ status: "live", badge: "critical_skills_eligible", occupation_code: "2134" });
    expect((await su.query("select count(*)::int n from audit_event where action = 'fetched_job.approve' and object_id = $1", [S.jobs.contract!.job])).rows[0].n).toBe(1);
    expect(await fetchedPage("both", { id: S.jobs.contract!.item })).toMatch(/This item is decided/);
    expect((await call(FETCHED, "both", { action: "approve", itemId: S.jobs.contract!.item, occupationCode: "2134" })).json.error).toBe("already_decided");
  });
  it("a job the rules would not publish is refused with the stage it stopped at and stays claimed; a code off the list is refused; reject closes the job; each decision writes one audit row", async () => {
    expect((await call(FETCHED, "both", { action: "claim", itemId: S.jobs.occupation2!.item })).status).toBe(200);
    const stopped = await call(FETCHED, "both", { action: "approve", itemId: S.jobs.occupation2!.item, occupationCode: "2134" }); // the advert states no pay and the employer is not a big company
    expect([stopped.status, stopped.json.error, stopped.json.stage]).toEqual([409, "rules_failed", "8 no salary, not a big company"]);
    expect((await su.query("select status from review_item where id = $1", [S.jobs.occupation2!.item])).rows[0].status).toBe("claimed");
    const bad = await call(FETCHED, "both", { action: "approve", itemId: S.jobs.occupation2!.item, occupationCode: "9999" });
    expect([bad.status, bad.json.error]).toEqual([400, "bad_occupation_code"]);
    expect((await call(FETCHED, "both", { action: "reject", itemId: S.jobs.occupation2!.item })).json.error).toBe("bad_reason");
    expect((await call(FETCHED, "both", { action: "reject", itemId: S.jobs.occupation2!.item, reason: "not_critical_skills" })).status).toBe(200);
    expect((await su.query("select status, close_reason from job where id = $1", [S.jobs.occupation2!.job])).rows[0]).toMatchObject({ status: "closed", close_reason: "removed" });
    expect((await su.query("select count(*)::int n from audit_event where action = 'fetched_job.reject' and object_id = $1", [S.jobs.occupation2!.job])).rows[0].n).toBe(1);
  });
});

describe("performance: statements and time of one page render", () => {
  const pageBudget = async (who: string, page: () => Promise<string>, max: number, ms: number, name: string) => {
    await page(); // warm
    const [, n] = await counted(page);
    const m = await median(page);
    console.log(`${name}: ${n} statements, median ${m.toFixed(1)} ms`);
    expect(n, `${name} statements`).toBeLessThanOrEqual(max);
    expect(m, `${name} median ms`).toBeLessThan(ms);
    state.headers = new Headers({ cookie: h.cookies[who]! });
  };
  it("the overview: an administrator's and a two-queue reviewer's", async () => {
    await pageBudget("only_administrator", () => overviewPage(ROLE("administrator")), BUDGET.overviewAdmin, BUDGET.overviewMs, "overview administrator");
    await pageBudget("both", () => overviewPage("both"), BUDGET.overviewReviewer, BUDGET.overviewMs, "overview reviewer");
  });
  it("the account review page and the fetched-job page", async () => {
    await pageBudget("both", () => accountsPage("both"), BUDGET.accounts, BUDGET.accountsMs, "account reviews");
    await pageBudget("both", () => fetchedPage("both", { id: S.jobs.script!.item, soc: "2134" }), BUDGET.fetched, BUDGET.fetchedMs, "fetched jobs with a dry run");
  });
});
