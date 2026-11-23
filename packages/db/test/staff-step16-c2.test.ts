// Integration: step 16 round 2, slices B61 (account review item fields, tabs and counts), B62 (fetched job item fields, the stage filter and counts) and B63 (the fetched
// job dry run), through the admin app's real route handlers on the real test database as app_admin, with real staff sessions. Every role is tried, plus no login, a forged
// cookie, a disabled login, hostile queries, and the proof that the dry run writes nothing. Fake people only, no network (the matcher is the reviewer's own code).
// The pure part of the dry run (the check list) is in src/admin-queue.test.ts; the import wall for data.ts is apps/admin/lib/data.test.ts.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REVIEW_COUNTS } from "../src/account-review";
import { LOOK, QUEUE_COUNTS, QUEUE_FIRST } from "../src/admin-queue";
import { PAGE_SIZE } from "../src/search";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { assertPageBudget, measurePages } from "./perf/pages";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

// Measured on 23 November 2026 (this file alone, printed by the performance tests below). Statements through a route: the account review list 5 (session 2, role, page, counts),
// the fetched-job list 5 (the same), the dry run 4 (session 2, role, the read; the rules data is read once and kept). Page limits are about 3 to 4 times the measures,
// time limits a floor for a busy laptop. Raise these only on purpose. The fetched-job pages are measured with 300 open items (the queue is cleared daily, the frame shows 34): the
// stage counts read 713 pages and a page 759 (717 before B62: the new subselect costs 2 pages a row), so the cost grows with the queue, about 2.4 pages an item. The account review
// counts read 66 pages with 3,000 decided items once autovacuum has run (the 0073 index; 6,147 pages without it).
const BUDGET = { reviewList: 5, fetchedList: 5, dryRun: 5, ms: 25, pages: { reviewCounts: 200, fetchedCounts: 1000, look: 100, fetchedFirst: 1100 } };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
let id: (p: string) => string;
let F: { org: (o?: { status?: string; name?: string }) => Promise<number>; portal: (o?: { email?: string; name?: string }) => Promise<string> };
const R = {} as Record<"review" | "fetched" | "dry", Route>;
const spec = loadSpec("admin");
const review = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(R.review, "/api/account-review", who, undefined, { ...o, query });
const fetched = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(R.fetched, "/api/fetched-jobs", who, undefined, { ...o, query });
const dry = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(R.dry, "/api/fetched-jobs/dry-run", who, undefined, { ...o, query });
const act = (route: Route, path: string, who: string, body: object) => h.call(route, path, who, body);
const qs = (p: Record<string, string>) => "?" + new URLSearchParams(p).toString();
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  ({ id, F } = fixtures(db) as unknown as { id: typeof id; F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  R.review = await import("../../../apps/admin/app/api/account-review/route");
  R.fetched = await import("../../../apps/admin/app/api/fetched-jobs/route");
  R.dry = await import("../../../apps/admin/app/api/fetched-jobs/dry-run/route");
  for (const n of ["ar1", "ar2"]) await h.makeStaff(n, ["account_reviewer"]);
  for (const n of ["jr1", "jr2"]) await h.makeStaff(n, ["fetched_job_reviewer"]);
  for (const r of ROLE_NAMES) if (r !== "account_reviewer" && r !== "fetched_job_reviewer") await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["account_reviewer", "fetched_job_reviewer"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

// ===== B61 =====
const portal = () => db.pool("app_portal");
/** A new registration (first-time employer) by a new verified login: always goes to review. */
async function registered(o: { email?: string; name?: string; kind?: "employer" | "agency" } = {}) {
  const user = await F.portal({ email: o.email ?? `${id("founder")}@${id("new")}.example.test`, name: o.name });
  const kind = o.kind ?? "employer";
  const r = (await portal().query("select private.register_organisation($1, $2, 'Fresh Start Ltd', $3, $4) r", [user, kind, kind === "employer" ? id("cro") : null, kind === "agency" ? id("wrc") : null])).rows[0].r;
  const item = (await su.query("select id::text from review_item where queue = 'account_review' and organisation_id = $1", [r.organisation_id])).rows[0].id as string;
  return { org: String(r.organisation_id), user, item };
}
const ids = (r: { json: Record<string, any> }) => (r.json.items as { id: string }[]).map((i) => i.id); // eslint-disable-line @typescript-eslint/no-explicit-any

describe("B61: account review item fields", () => {
  it("gives the claimant's name, the free email and non-domain flags, the permit label and last year, and the ban flag", async () => {
    const a = await registered({ email: "aoife@gmail.com" });
    await su.query("update portal_user set name = 'Aoife Byrne' where id = $1", [a.user]);
    const x = (await h.ok(review("ar1", qs({ id: a.item })))).item;
    expect(x).toMatchObject({ claimantName: "Aoife Byrne", freeEmail: true, nonDomainEmail: true, permitHistory: "not_linked", lastPermitYear: null, banned: false, decidedAt: null, outcome: null });

    // a company address that the company has not saved is a non-domain email; saved, it is not
    const b = await registered({ email: "jane@acme-fake.example.test" });
    let y = (await h.ok(review("ar1", qs({ id: b.item })))).item;
    expect([y.freeEmail, y.nonDomainEmail]).toEqual([false, true]);
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, 'acme-fake.example.test', 'admin')", [b.org]);
    y = (await h.ok(review("ar1", qs({ id: b.item })))).item;
    expect(y.nonDomainEmail).toBe(false);

    // permits: the newest year with permits (a year of zero does not count), across the company's names
    const n = await one("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Fresh Start Ltd', $2, 'legal', 'dete') returning id", [b.org, id("fresh")]);
    await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, permits) values ('Fresh Start', $1, 2022, 3), ('Fresh Start', $1, 2024, 0)", [n.id]);
    await su.query("update organisation set permit_history = 'has_history' where id = $1", [b.org]);
    expect((await h.ok(review("ar1", qs({ id: b.item })))).item).toMatchObject({ permitHistory: "has_history", lastPermitYear: 2022 });

    // banned: the owner's email domain on the ban list (a ban row needs a strike and an approval, so the owner writes it with checks off)
    const c = await registered({ email: "boss@banned-fake.example.test" });
    const k = await su.connect();
    try {
      await k.query("begin");
      await k.query("set local session_replication_role = replica");
      await k.query("insert into ban(email_domain, reason_code, strike_id, approval_request_id) values ('banned-fake.example.test', 'fake_company', 0, 0)");
      await k.query("commit");
    } finally { k.release(); }
    expect((await h.ok(review("ar1", qs({ id: c.item })))).item.banned).toBe(true);
  });

  it("the claimant's name is plain text: markup and a spreadsheet formula in it come back as typed", async () => {
    const a = await registered();
    await su.query("update portal_user set name = $2 where id = $1", [a.user, "<img src=x onerror=alert(1)> =HYPERLINK(1)"]);
    expect((await h.ok(review("ar1", qs({ id: a.item })))).item.claimantName).toBe("<img src=x onerror=alert(1)> =HYPERLINK(1)");
  });
});

describe("B61: tabs and counts", () => {
  it("splits waiting, needs more info, approved and rejected, with a count for each, and every list carries the counts", async () => {
    await su.query("update review_item set status = 'dropped' where queue = 'account_review'"); // a clean slate for the counts
    const w1 = await registered(), w2 = await registered(), ni = await registered(), ap = await registered(), rj = await registered();
    await su.query("update review_item set status = 'open' where id = any($1::bigint[])", [[w1.item, w2.item, ni.item]]);
    await su.query("update organisation set status = 'needs_info' where id = $1", [ni.org]);
    await su.query("update review_item set status = 'done', outcome = 'approved', decided_at = now() - interval '2 days' where id = $1", [ap.item]);
    await su.query("update review_item set status = 'done', outcome = 'rejected', decided_at = now() - interval '1 day' where id = $1", [rj.item]);

    const tab = (t: string) => h.ok(review("ar1", qs({ tab: t })));
    expect(ids({ json: await tab("waiting") })).toEqual([w1.item, w2.item]);
    expect(ids({ json: await tab("needs_info") })).toEqual([ni.item]);
    expect(ids({ json: await tab("approved") })).toEqual([ap.item]);
    expect(ids({ json: await tab("rejected") })).toEqual([rj.item]);
    const all = await h.ok(review("ar1")); // no tab: the open items, as before
    expect(ids({ json: all })).toEqual([w1.item, w2.item, ni.item]);
    for (const j of [await tab("waiting"), await tab("approved"), all]) expect(j.counts).toEqual({ waiting: 2, needsInfo: 1, approved: 1, rejected: 1 });
    const approved = (await tab("approved")).items[0];
    expect(approved).toMatchObject({ status: "done", outcome: "approved" });
    expect(approved.decidedAt).toMatch(/^\d{4}-\d\d-\d\d /);
  });

  it("pages a decided tab newest decision first, a page at a time, with no repeat or gap", async () => {
    await su.query(
      `insert into review_item(queue, organisation_id, status, outcome, decided_at, reason)
       select 'account_review', (select min(id) from organisation), 'done', 'approved', now() - (g || ' minutes')::interval, 'new organisation' from generate_series(1, $1::int) g`, [PAGE_SIZE * 2 + 3]);
    const seen: string[] = [];
    let after: string | null = null, pages = 0;
    do {
      const r = await h.ok(review("ar1", qs({ tab: "approved", ...(after ? { after } : {}) })));
      seen.push(...ids({ json: r }));
      after = r.next; pages++;
    } while (after && pages < 10);
    const expected = (await su.query("select id::text from review_item where queue = 'account_review' and outcome = 'approved' and status = 'done' order by coalesce(decided_at, created_at) desc, id desc")).rows.map((r) => r.id);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
  });

  it("refuses a tab that is not one, a tab given twice, and any other key", async () => {
    for (const t of ["", "Waiting", "all", "done", "waiting;drop", "x".repeat(300)]) await h.no(review("ar1", qs({ tab: t })), 400, "bad_tab");
    await h.no(review("ar1", "?tab=waiting&tab=approved"), 400, "bad_query");
    await h.no(review("ar1", "?status=done"), 400, "bad_query");
    await h.no(review("ar1", qs({ tab: "approved", after: "not-a-token" })), 400, "bad_cursor");
  });

  it("is refused to every login that is not an active account reviewer, tab or not", async () => {
    for (const who of [null, "disabled", "norole", ...ROLE_NAMES.filter((r) => r !== "account_reviewer").map((r) => `only_${r}`)]) {
      const r = await review(who, "?tab=waiting");
      expect([401, 403], `${who}`).toContain(r.status);
      expect(JSON.stringify(r.json), `${who}`).not.toMatch(/claimantEmail|counts/);
    }
    await h.no(review(null, "?tab=waiting", { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(review("only_administrator", "?tab=approved"), 403, "not_reviewer"); // no role stands in
  });

  it("matches docs/openapi/admin.yaml for the list, a tab and the item", async () => {
    const x = await review("ar1", "?tab=waiting");
    expect(replyProblems(spec, "GET", "/api/account-review", x.status, x.json)).toEqual([]);
    const first = ids(x)[0]!;
    const y = await review("ar1", qs({ id: first }));
    expect(replyProblems(spec, "GET", "/api/account-review", y.status, y.json)).toEqual([]);
    const z = await review("ar1", "?tab=nope");
    expect(replyProblems(spec, "GET", "/api/account-review", z.status, z.json)).toEqual([]);
  });

  it("is inside its statement, time and page budgets, with 3,000 decided items", async () => {
    await su.query(
      `insert into review_item(queue, organisation_id, status, outcome, decided_at, reason)
       select 'account_review', (select min(id) from organisation), 'done', case when g % 5 = 0 then 'rejected' else 'approved' end, now() - (g || ' minutes')::interval, 'new organisation' from generate_series(1, 3000) g`);
    const [, n] = await counted(() => review("ar1", "?tab=approved"));
    const ms = await median(() => review("ar1", "?tab=approved"));
    const client = await su.connect();
    try {
      await client.query("vacuum analyze review_item, organisation"); // as autovacuum keeps them in use: the count then runs from the index alone
      const pages = await measurePages(client, [REVIEW_COUNTS]);
      console.log(`B61 review budget: ${n} statements, median ${ms.toFixed(1)} ms, counts ${pages[0]!.pages} pages (${pages[0]!.scans})`);
      assertPageBudget("account review tab counts", pages, BUDGET.pages.reviewCounts);
    } finally { client.release(); }
    expect(n).toBeLessThanOrEqual(BUDGET.reviewList);
    expect(ms).toBeLessThan(BUDGET.ms);
  });
});

// ===== B62 and B63 =====
const PAY = "Join our team building fake things. The salary is €60,000 a year.";
async function queued(o: { text?: string | null; county?: string | null; stage?: string; kind?: string; evidence?: string | null; model?: string | null } = {}) {
  const src = (await su.query("insert into job_source(kind, board) values ($1, $2) returning id", [o.kind ?? "greenhouse", id("b")])).rows[0].id;
  const advert = (await su.query(
    "insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason, quoted_evidence, matcher_model) values ($1, $2, 'https://jobs.example.test/a', 'Fixed-term Platform Engineer', 'Acme Widgets', 'queued', $3, 'title', $4, $5) returning id::text",
    [src, id("ext"), o.stage ?? "7 contract unclear (admin queue)", o.evidence === undefined ? "...a fixed-term contract..." : o.evidence, o.model === undefined ? "fake-matcher-1" : o.model])).rows[0].id as string;
  const org = await F.org();
  const job = (await su.query(
    `insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url, pay_grade)
     values ($1, 'fetched', $2, $3, 'Fixed-term Platform Engineer', 'Acme Widgets', $4, 'IT', '2134', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', 'x'), 'https://jobs.example.test/a', 'Grade VIII') returning id::text`,
    [org, src, advert, o.county === undefined ? "Dublin" : o.county])).rows[0].id as string;
  if (o.text !== null) await su.query("insert into job_text(job_id, advert_text) values ($1, $2)", [job, o.text ?? PAY]);
  const item = (await su.query("select id::text from review_item where queue = 'fetched_job' and job_id = $1", [job])).rows[0].id as string;
  return { job, item };
}
const FJ = "/api/fetched-jobs";

describe("B62: fetched job item fields, stage filter and counts", () => {
  it("lists queued-at, county and source kind, and the one-item read adds the quoted evidence and the matcher model", async () => {
    const q = await queued({ county: "Cork", kind: "careers_page", evidence: "...a specified purpose contract...", model: "fake-matcher-9" });
    const list = await h.ok(fetched("jr1"));
    const row = (list.items as Record<string, unknown>[]).find((i) => i.id === q.item)!;
    expect(row).toMatchObject({ county: "Cork", sourceKind: "careers_page", stage: "7 contract unclear (admin queue)" });
    expect(row.queuedAt).toMatch(/^\d{4}-\d\d-\d\d /);
    expect(row).not.toHaveProperty("quotedEvidence"); // the evidence is long: only the one-item read
    const item = (await h.ok(fetched("jr1", qs({ id: q.item })))).item;
    expect(item).toMatchObject({ quotedEvidence: "...a specified purpose contract...", matcherModel: "fake-matcher-9", county: "Cork", sourceKind: "careers_page", advertText: PAY });
    const bare = await queued({ evidence: null, model: null, county: null });
    expect((await h.ok(fetched("jr1", qs({ id: bare.item })))).item).toMatchObject({ quotedEvidence: null, matcherModel: null, county: null });
  });

  it("keeps the evidence as typed text (markup is not touched) and shows it to no other role", async () => {
    const q = await queued({ evidence: "<script>alert(1)</script> =cmd|' /C calc'!A0" });
    expect((await h.ok(fetched("jr1", qs({ id: q.item })))).item.quotedEvidence).toBe("<script>alert(1)</script> =cmd|' /C calc'!A0");
    for (const who of [null, "disabled", "norole", ...ROLE_NAMES.filter((r) => r !== "fetched_job_reviewer").map((r) => `only_${r}`)]) {
      const r = await fetched(who, qs({ id: q.item }));
      expect([401, 403], `${who}`).toContain(r.status);
      expect(JSON.stringify(r.json), `${who}`).not.toMatch(/quotedEvidence|matcherModel/);
    }
  });

  it("filters by stage text and counts the open items per stage, biggest first; the counts ignore the filter", async () => {
    await su.query("update review_item set status = 'dropped' where queue = 'fetched_job'");
    const a = await queued({ stage: "5 unsure occupation (admin queue)" }), b = await queued({ stage: "5 unsure occupation (admin queue)" });
    const c = await queued({ stage: "7 contract unclear (admin queue)" });
    const all = await h.ok(fetched("jr1"));
    expect(ids({ json: all })).toEqual([a.item, b.item, c.item]);
    expect(all.counts).toEqual({ total: 3, stages: [{ stage: "5 unsure occupation (admin queue)", count: 2 }, { stage: "7 contract unclear (admin queue)", count: 1 }] });
    const f = await h.ok(fetched("jr1", qs({ stage: "7 contract unclear (admin queue)" })));
    expect(ids({ json: f })).toEqual([c.item]);
    expect(f.counts).toEqual(all.counts);
    expect(ids({ json: await h.ok(fetched("jr1", qs({ stage: "no such stage" }))) })).toEqual([]);
    const page = await h.ok(fetched("jr1", qs({ stage: "5 unsure occupation (admin queue)" })));
    expect(page.next).toBeNull();
    // a decided item leaves the counts
    await su.query("update review_item set status = 'dropped' where id = $1", [a.item]);
    expect((await h.ok(fetched("jr1"))).counts.total).toBe(2);
  });

  it("pages a stage-filtered list with the same token", async () => {
    await su.query("update review_item set status = 'dropped' where queue = 'fetched_job'");
    const made: string[] = [];
    for (let i = 0; i < PAGE_SIZE + 2; i++) made.push((await queued({ stage: "8 no salary, not a big company" })).item);
    await queued({ stage: "7 contract unclear (admin queue)" });
    const stage = "8 no salary, not a big company";
    const p1 = await h.ok(fetched("jr1", qs({ stage })));
    expect(p1.items).toHaveLength(PAGE_SIZE);
    const p2 = await h.ok(fetched("jr1", qs({ stage, after: p1.next })));
    expect([...ids({ json: p1 }), ...ids({ json: p2 })]).toEqual(made);
    expect(p2.next).toBeNull();
  });

  it("refuses an empty or over-long stage, a stage given twice and unknown keys", async () => {
    await h.no(fetched("jr1", "?stage="), 400, "bad_stage");
    await h.no(fetched("jr1", qs({ stage: "x".repeat(201) })), 400, "bad_stage");
    await h.no(fetched("jr1", "?stage=a&stage=b"), 400, "bad_query");
    await h.no(fetched("jr1", "?category=a"), 400, "bad_query");
    for (const bad of ["\u0000x", "a\nb", "a\u202Eb"]) await h.no(fetched("jr1", qs({ stage: bad })), 400, "bad_stage");
    for (const hostile of ["' or 1=1 --", "%", "a".repeat(200)]) {
      const r = await fetched("jr1", qs({ stage: hostile }));
      expect([r.status, r.json.items], hostile).toEqual([200, []]); // only ever a bound parameter: it matches nothing and breaks nothing
    }
  });

  it("matches docs/openapi/admin.yaml, and stays inside its statement and page budgets", async () => {
    const list = await fetched("jr1", qs({ stage: "7 contract unclear (admin queue)" }));
    expect(replyProblems(spec, "GET", FJ, list.status, list.json)).toEqual([]);
    const item = await fetched("jr1", qs({ id: (await queued()).item }));
    expect(replyProblems(spec, "GET", FJ, item.status, item.json)).toEqual([]);
    const bad = await fetched("jr1", "?stage=");
    expect(replyProblems(spec, "GET", FJ, bad.status, bad.json)).toEqual([]);

    for (let i = 0; i < 300; i++) await queued({ stage: i % 2 ? "5 unsure occupation (admin queue)" : "7 contract unclear (admin queue)" });
    const [, n] = await counted(() => fetched("jr1", qs({ stage: "5 unsure occupation (admin queue)" })));
    const ms = await median(() => fetched("jr1"));
    const client = await su.connect();
    try {
      await client.query("vacuum analyze review_item, job, fetched_advert"); // as autovacuum keeps them in use
      const pages = await measurePages(client, [QUEUE_COUNTS, { text: QUEUE_FIRST, values: ["5 unsure occupation (admin queue)"] }, { text: QUEUE_FIRST, values: [null] }, QUEUE_FIRST.replace(", j.county, (select s.kind from job_source s where s.id = j.job_source_id) as source_kind", "").replace("and ($1::text is null or f.stage = $1) ", "")]);
      console.log(`B62 budget: ${n} statements, median ${ms.toFixed(1)} ms, counts ${pages[0]!.pages} pages (${pages[0]!.scans}), filtered first page ${pages[1]!.pages} (${pages[1]!.scans}), unfiltered ${pages[2]!.pages}, baseline ${pages[3]!.pages} (${pages[3]!.scans})`);
      assertPageBudget("fetched counts", [pages[0]!], BUDGET.pages.fetchedCounts);
      assertPageBudget("fetched first page", [pages[1]!], BUDGET.pages.fetchedFirst);
    } finally { client.release(); }
    expect(n).toBeLessThanOrEqual(BUDGET.fetchedList);
    expect(ms).toBeLessThan(BUDGET.ms);
  });
});

describe("B63: the fetched job dry run", () => {
  const ASK = (item: string, extra: Record<string, string> = {}) => qs({ id: item, occupationCode: "2134", contractConfirmed: "true", ...extra });
  const snapshot = async (q: { job: string; item: string }) => ({
    job: (await one("select status, badge, pass_route, occupation_code, salary_low, salary_high, close_reason from job where id = $1", [q.job])),
    item: (await one("select status, claimed_by_staff_user_id, decided_at, outcome from review_item where id = $1", [q.item])),
    audit: (await one("select count(*)::int n from audit_event where object_id = any($1::text[])", [[q.job, q.item]])).n,
  });

  it("says what Approve would do, check by check, with the badge, pay grade and quota status, and writes nothing", async () => {
    const q = await queued();
    const before = await snapshot(q);
    const r = await h.ok(dry("jr1", ASK(q.item)));
    expect(r).toMatchObject({
      itemId: q.item, jobId: q.job, wouldPublish: true, passRoute: "stated_pay", failedStage: null, badge: "critical_skills_eligible", occupationCode: "2134",
      salaryLow: 60000, salaryHigh: 60000, payGrade: "Grade VIII", quotaFull: false, stage: "PASS (salary stated)",
    });
    expect(r.checks.map((c: { check: string }) => c.check)).toEqual(["irish_employer", "sponsorship_wording", "occupation_known", "critical_skills_list", "contract", "salary", "scam_wording"]);
    expect(r.checks.every((c: { result: string }) => c.result === "pass")).toBe(true);
    expect(await snapshot(q)).toEqual(before); // no write: not the job, not the item, not the audit log
    // and it matches what the real Approve then does, once claimed
    await h.ok(act(R.fetched, FJ, "jr1", { action: "claim", itemId: q.item }));
    expect(await h.ok(act(R.fetched, FJ, "jr1", { action: "approve", itemId: q.item, occupationCode: "2134", contractConfirmed: true }))).toMatchObject({ passRoute: r.passRoute });
  });

  it("says why it would refuse, with the stage and the failed check, and takes the reviewer's pay and contract", async () => {
    const q = await queued({ text: "Join our team building fake things." });
    const no = await h.ok(dry("jr1", ASK(q.item)));
    expect(no).toMatchObject({ wouldPublish: false, passRoute: null, badge: null, failedStage: "8 no salary, not a big company", salaryLow: null });
    expect(no.checks.find((c: { check: string }) => c.check === "salary").result).toBe("fail");
    expect(no.checks.find((c: { check: string }) => c.check === "contract").result).toBe("pass");
    const yes = await h.ok(dry("jr1", ASK(q.item, { salaryLow: "50000", salaryHigh: "70000" })));
    expect(yes).toMatchObject({ wouldPublish: true, salaryLow: 50000, salaryHigh: 70000 });
    const unsure = await h.ok(dry("jr1", qs({ id: q.item, occupationCode: "2134", salaryLow: "50000" }))); // contract not confirmed: back to the admin queue
    expect(unsure).toMatchObject({ wouldPublish: false });
    expect(unsure.checks.find((c: { check: string }) => c.check === "contract").result).toBe("unsure");
    expect(unsure.checks.find((c: { check: string }) => c.check === "salary").result).toBe("not_run");
  });

  it("works before the item is claimed, and refuses a decided item, a job out of review, a missing advert and an unknown item", async () => {
    const open = await queued();
    await h.ok(dry("jr2", ASK(open.item))); // not claimed by anyone
    await h.ok(act(R.fetched, FJ, "jr1", { action: "claim", itemId: open.item }));
    await h.ok(dry("jr2", ASK(open.item))); // claimed by someone else: a read, not a decision
    await h.ok(act(R.fetched, FJ, "jr1", { action: "reject", itemId: open.item, reason: "not_suitable" }));
    await h.no(dry("jr1", ASK(open.item)), 409, "already_decided");
    const out = await queued();
    await su.query("update job set status = 'closed' where id = $1", [out.job]);
    await h.no(dry("jr1", ASK(out.item)), 409, "job_not_in_review");
    await h.no(dry("jr1", ASK((await queued({ text: null })).item)), 409, "no_advert_text");
    await h.no(dry("jr1", ASK("99999999")), 404, "not_found");
  });

  it("refuses hostile or incomplete queries with a code and writes no audit row", async () => {
    const q = await queued();
    const base = { id: q.item, occupationCode: "2134" };
    await h.no(dry("jr1", qs({ occupationCode: "2134" })), 400, "bad_item_id");
    await h.no(dry("jr1", qs({ ...base, id: "1; drop table job" })), 400, "bad_item_id");
    await h.no(dry("jr1", qs({ id: q.item })), 400, "bad_occupation_code");
    for (const c of ["213", "21345", "abcd", "9999"]) await h.no(dry("jr1", qs({ ...base, occupationCode: c })), 400, "bad_occupation_code");
    // 1225 is on the ineligible list only: a valid ask, and the dry run says the Critical Skills check would fail
    const inel = await h.ok(dry("jr1", qs({ ...base, occupationCode: "1225" })));
    expect([inel.wouldPublish, inel.failedStage, inel.checks.find((c: { check: string }) => c.check === "critical_skills_list").result]).toEqual([false, "6 not on Critical Skills list", "fail"]);
    for (const s of ["0", "-5", "1.5", "abc", "12345678", "1000001"]) await h.no(dry("jr1", qs({ ...base, salaryLow: s })), 400, "bad_salary");
    await h.no(dry("jr1", qs({ ...base, salaryHigh: "50000" })), 400, "bad_salary"); // a top with no bottom
    await h.no(dry("jr1", qs({ ...base, salaryLow: "60000", salaryHigh: "50000" })), 400, "bad_salary");
    for (const c of ["yes", "1", "TRUE", ""]) await h.no(dry("jr1", qs({ ...base, contractConfirmed: c })), 400, "bad_input");
    await h.no(dry("jr1", `${qs(base)}&extra=1`), 400, "bad_query");
    await h.no(dry("jr1", `${qs(base)}&id=${q.item}`), 400, "bad_query");
    expect(Object.keys(R.dry).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    expect((await one("select count(*)::int n from audit_event where object_id = $1", [q.job])).n).toBe(0);
  });

  it("is refused to every login that is not an active fetched-job reviewer", async () => {
    const q = await queued();
    for (const who of [null, "disabled", "norole", "ar1", ...ROLE_NAMES.filter((r) => r !== "fetched_job_reviewer").map((r) => `only_${r}`)]) {
      const r = await dry(who, ASK(q.item));
      expect([401, 403], `${who}`).toContain(r.status);
      expect(JSON.stringify(r.json), `${who}`).not.toMatch(/checks|wouldPublish|payGrade/);
    }
    await h.no(dry(null, ASK(q.item), { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(dry("only_administrator", ASK(q.item)), 403, "not_reviewer"); // no role stands in
  });

  it("matches docs/openapi/admin.yaml and is never cached", async () => {
    const q = await queued();
    for (const query of [ASK(q.item), ASK(q.item, { salaryLow: "x" }), qs({ id: q.item })]) {
      const r = await dry("jr1", query);
      expect(replyProblems(spec, "GET", `${FJ}/dry-run`, r.status, r.json), query).toEqual([]);
    }
    const res = await R.dry.GET(new Request(`http://localhost:3002${FJ}/dry-run${ASK(q.item)}`, { headers: { cookie: h.cookies.jr1! } }));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is inside its statement, time and page budgets", async () => {
    const q = await queued();
    const [, n] = await counted(() => dry("jr1", ASK(q.item)));
    const ms = await median(() => dry("jr1", ASK(q.item)));
    const client = await su.connect();
    try {
      const pages = await measurePages(client, [{ text: LOOK, values: [q.item] }]);
      console.log(`B63 budget: ${n} statements, median ${ms.toFixed(1)} ms, read ${pages[0]!.pages} pages`);
      assertPageBudget("dry run read", pages, BUDGET.pages.look);
    } finally { client.release(); }
    expect(n).toBeLessThanOrEqual(BUDGET.dryRun);
    expect(ms).toBeLessThan(BUDGET.ms * 2);
  });
});
