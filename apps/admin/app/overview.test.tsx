// The staff overview (frame ND1): which tile each role gets, the work table, the audit rows and the rules notice. react-dom/server, no browser, no network.
import type { AuditRow, QueueItem, ReviewItem } from "@portal/db";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { auditSentence } from "./_queue/audit-text";
import { kindWords, Overview, tilesOf, type Tile } from "./overview";
import { nextRules, workRows, WORK_ROWS } from "./overview-data";

const NOW = new Date("2026-11-24T12:00:00Z");
const ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"] as const;
type Counts = Parameters<typeof tilesOf>[0];
const NONE: Counts = { queues: {}, oldestSeconds: {}, reportsOpen: null, reportsNew: null, reportsJobHidden: null, appeals: null, contact: null, approvals: null, casesUnassigned: null, casesMine: null, casesOpen: null, mergeSuggestions: null };
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample|Pipelines/);
const keys = (t: Tile[]) => t.map((x) => x.key);

// what the counts read gives each role (staff-counts.ts): a count a role does not cover is null
const countsFor = (roles: string[]): Counts => ({
  ...NONE,
  queues: { ...(roles.includes("account_reviewer") ? { account_review: 9 } : {}), ...(roles.includes("fetched_job_reviewer") ? { fetched_job: 34 } : {}) },
  oldestSeconds: { ...(roles.includes("account_reviewer") ? { account_review: 5 * 3600 } : {}), ...(roles.includes("fetched_job_reviewer") ? { fetched_job: 9 * 3600 } : {}) },
  reportsOpen: roles.includes("trust_and_safety") ? 6 : null, reportsJobHidden: roles.includes("trust_and_safety") ? 1 : null,
  casesOpen: roles.includes("services_case_handler") ? 11 : null, casesMine: roles.includes("services_case_handler") ? 3 : null,
  mergeSuggestions: roles.some((r) => ["account_reviewer", "trust_and_safety", "administrator"].includes(r)) ? 14 : null,
  approvals: roles.includes("administrator") ? 2 : null,
});

describe("which tile each role gets", () => {
  it("one tile for the queue each role works, none for a queue it cannot read", () => {
    const want: Record<string, string[]> = {
      account_reviewer: ["account", "merges"], fetched_job_reviewer: ["fetched"], rules_data_editor: [], trust_and_safety: ["reports", "merges"], services_case_handler: ["services"], content_editor: [],
      administrator: ["merges", "approvals", "overdue"],
    };
    for (const r of ROLES) expect(keys(tilesOf(countsFor([r]), [r], r === "administrator" ? { count: 4, more: false } : null)), r).toEqual(want[r]);
  });
  it("a login with no role has no tile, and all seven roles together have every tile in the frame's order", () => {
    expect(tilesOf(NONE, [], null)).toEqual([]);
    expect(keys(tilesOf(countsFor([...ROLES]), [...ROLES], { count: 2, more: true }))).toEqual(["account", "fetched", "reports", "services", "merges", "approvals", "overdue"]);
  });
  it("the tile says the count, how old the oldest item is, and what a person needs; an empty queue the role works is 0, not missing", () => {
    const t = tilesOf(countsFor([...ROLES]), [...ROLES], null);
    expect(t[0]).toMatchObject({ value: 9, label: "Account reviews", note: "oldest 5 h", href: "/account-reviews" });
    expect(t[1]).toMatchObject({ value: 34, note: "oldest 9 h", href: "/fetched-jobs" });
    expect(t[2]).toMatchObject({ value: 6, note: "1 job hidden", href: "/reports" });
    expect(t[3]).toMatchObject({ value: 11, note: "3 on us", href: "/services" });
    expect(tilesOf({ ...NONE }, ["account_reviewer"], null)[0]).toMatchObject({ value: 0, note: undefined });
    expect(tilesOf({ ...NONE, reportsOpen: 2, reportsJobHidden: 0 }, ["trust_and_safety"], null)[0]!.note).toBeUndefined();
  });
  it("the two administrator tiles are not links: nothing here opens them", () => {
    const t = tilesOf(countsFor(["administrator"]), ["administrator"], { count: 100, more: true });
    expect(t.filter((x) => x.key === "approvals" || x.key === "overdue").every((x) => x.href === undefined)).toBe(true);
    expect(t.at(-1)!.label).toMatch(/or more/);
  });
});

describe("the work table and the rules notice", () => {
  const acct = (id: string, since: string, o: Partial<ReviewItem> = {}) => ({ id, displayName: `Org ${id}`, createdAt: since, flags: [], freeEmail: false, nonDomainEmail: false, banned: false, kind: "employer", signupPath: "first_time", detail: null, ...o }) as unknown as ReviewItem;
  const fetched = (id: string, since: string) => ({ id, title: `Job ${id}`, employerName: "Emp", queuedAt: since, stage: "7 contract unclear (admin queue)" }) as unknown as QueueItem;
  it("puts the oldest first across the queues, with the reason and a link to the item, and keeps at most five", () => {
    const rows = workRows({
      accounts: [acct("1", "2026-11-24 10:00:00+00", { freeEmail: true }), acct("2", "2026-11-24 03:00:00+00")], fetched: [fetched("7", "2026-11-24 05:00:00+00"), fetched("8", "2026-11-24 11:00:00+00")],
      reports: [{ id: "4", jobTitle: "Fake Care Job", reason: "asks_for_money", createdText: "2026-11-24 04:00:00+00" }, { id: "5", displayName: "Fake Co", reason: "", createdText: "2026-11-24 11:30:00+00" }],
    });
    expect(rows).toHaveLength(WORK_ROWS);
    expect(rows.map((r) => r.key)).toEqual(["a2", "r4", "f7", "a1", "f8"]);
    expect(rows[0]).toMatchObject({ title: "Org 2", queue: "Account reviews", why: "First-time sponsor", href: "/account-reviews?id=2" });
    expect(rows[1]).toMatchObject({ title: "Fake Care Job", queue: "Reports", why: "Asks for money", href: "/reports" });
    expect(rows[2]).toMatchObject({ title: "Job 7 · Emp", why: "Contract unclear", href: "/fetched-jobs?id=7" });
    expect(rows[3]!.why).toBe("Free email");
  });
  it("a queue the member may not read adds nothing, and nothing at all is an empty list", () => {
    expect(workRows({ accounts: null, fetched: null, reports: null })).toEqual([]);
    expect(workRows({ accounts: null, fetched: [fetched("1", "2026-11-24 05:00:00+00")], reports: null }).map((r) => r.queue)).toEqual(["Fetched jobs"]);
    expect(workRows({ accounts: null, fetched: null, reports: [{ id: "1", reason: "x", createdText: "" }] })).toEqual([]);
  });
  it("the next rules change is the earliest confirmed version still to start, with every kind starting that day", () => {
    expect(nextRules([])).toBeNull();
    expect(nextRules([{ kind: "pay_scales", effectiveFrom: "2027-02-01" }, { kind: "minimums", effectiveFrom: "2027-01-01" }, { kind: "critical_skills_list", effectiveFrom: "2027-01-01" }])).toEqual({ from: "2027-01-01", kinds: ["minimums", "critical_skills_list"] });
    expect(kindWords(["minimums"])).toBe("the salary minimums");
    expect(kindWords(["minimums", "critical_skills_list", "pay_scales"])).toBe("the salary minimums, the Critical Skills list and the public pay scales");
    expect(kindWords(["new_kind"])).toBe("new kind");
  });
});

describe("the page", () => {
  const audit = (o: Partial<AuditRow> = {}): AuditRow => ({ id: "1", at: "2026-11-24 10:58:00+00", kind: "admin_action", actor: { staff: "s", staffName: "Fake Dara", candidate: null, portal: null, system: null }, roleInForce: null, action: "account_review.approved", objectType: "organisation", objectId: "5", objectLabel: "Fake Lakeside Care Homes", changedColumns: null, before: { secret: "x" }, after: null, reasonCode: "approved", secondStaff: null, secondStaffName: null, relatedCase: null, source: "panel", ...o });
  const page = (o: Partial<Parameters<typeof Overview>[0]> = {}) => html(<Overview now={NOW} tiles={[]} work={[]} audit={[]} auditFull={false} upcoming={null} roleCount={1} {...o} />);
  it("has one H1, the date and the target, the two targets and no pipelines card", () => {
    const p = page({ tiles: tilesOf(countsFor(["account_reviewer"]), ["account_reviewer"], null) });
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(p).toMatch(/Tuesday 24 Nov 2026 · target: every queue cleared within 1 working day/);
    expect(p).toMatch(/98% or more/);
    expect(p).toMatch(/Within 24 hours/);
    expect(p).toMatch(/data-tile="account"/);
    expect(p).toMatch(/Account reviews · oldest 5 h/);
    clean(p);
  });
  it("a login with no role, and roles with no queue, each get a clear page, not an empty one", () => {
    expect(page({ roleCount: 0 })).toMatch(/Your login has no role yet/);
    expect(page({ roleCount: 1 })).toMatch(/Your roles have no queue here/);
    expect(page({ roleCount: 1, tiles: tilesOf(countsFor(["fetched_job_reviewer"]), ["fetched_job_reviewer"], null) })).not.toMatch(/have no queue here/);
  });
  it("the audit rows read as sentences with the object's label and the time, and show no before or after data", () => {
    const p = page({ audit: [audit(), audit({ id: "2", action: "weird.thing_done", objectLabel: null, actor: { staff: null, staffName: null, candidate: null, portal: null, system: "scheduled_job" } })] });
    expect(p).toMatch(/Fake Dara approved an account/);
    expect(p).toMatch(/Fake Lakeside Care Homes/);
    expect(p).toMatch(/10:58/);
    expect(p).toMatch(/scheduled_job weird thing done/);
    expect(p).not.toMatch(/secret|approved<\/span>/);
    expect(p).toMatch(/href="\/audit"/);
    expect(page({ audit: [], auditFull: false })).toMatch(/Nothing of yours has been logged yet/);
    expect(page({ audit: [], auditFull: true })).toMatch(/Nothing has been logged yet/);
    expect(auditSentence("audit.export")).toBe("exported the audit log");
  });
  it("the rules notice shows only when a version is coming, with the date and kinds read, never typed", () => {
    expect(page()).not.toMatch(/Rules change on/);
    const p = page({ upcoming: { from: "2027-01-01", kinds: ["minimums"] } });
    expect(p).toMatch(/Rules change on 1 January 2027/);
    expect(p).toMatch(/A new version of the salary minimums starts that day/);
    expect(p).toMatch(/href="\/rules"/);
  });
  it("an item's text is escaped, never markup", () => {
    const p = page({ work: [{ key: "a1", title: "<img src=x onerror=1>", queue: "Account reviews", why: "<script>x</script>", since: "2026-11-24 10:00:00+00", href: "/account-reviews?id=1" }], audit: [audit({ objectLabel: "<b>x</b>" })] });
    expect(p).not.toMatch(/<img|<script|<b>/);
  });
});
