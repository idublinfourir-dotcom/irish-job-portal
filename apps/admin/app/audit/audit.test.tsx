// The audit log page (frame D13): the rows, the filters, the export button and the roles. react-dom/server, no browser, no network.
import type { AuditRow } from "@portal/db";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExportView } from "./export";
import { actionText, changeText, cleanFilters, href, objectText, routeQuery } from "./text";
import { Audit, Rows } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/audit" }));

const row = (o: Partial<AuditRow> = {}): AuditRow => ({
  id: "88001", at: "2026-11-09 10:58:00.123456+00", kind: "admin_action", actor: { staff: "stf1", staffName: "Fake Dara", candidate: null, portal: null, system: null }, roleInForce: null, action: "account_review.approved",
  objectType: "organisation", objectId: "310", objectLabel: "Fake Lakeside Care", changedColumns: ["status"], before: { status: "pending_review" }, after: { status: "verified" }, reasonCode: null, secondStaff: null, secondStaffName: null, relatedCase: null, source: "panel", ...o,
});
type O = Partial<Parameters<typeof Audit>[0]>;
const page = (o: O = {}) => html(<Audit events={[row()]} filters={{}} isAdmin={false} people={[]} {...o} />);
const clean = (t: string) => expect(t).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample/);

describe("the rows", () => {
  it("shows when, who, action, object and before to after", () => {
    const p = page();
    expect(p).toMatch(/09 Nov 10:58/);
    expect(p).toMatch(/Fake Dara/);
    expect(p).toMatch(/Approved an account/);
    expect(p).toMatch(/Fake Lakeside Care/);
    expect(p).toMatch(/status: pending review → verified/);
    clean(p);
  });
  it("a personal data view has no change; an actor with no name is named by what it is; a second person is named", () => {
    const p = html(<Rows events={[row({ kind: "data_access", changedColumns: null, before: null, after: null, action: "data_access.view", objectLabel: null, objectType: "candidate", objectId: "7" }),
      row({ id: "2", actor: { staff: null, staffName: null, candidate: null, portal: null, system: "job" }, secondStaffName: "Fake Kit" })]} />);
    expect(p).toMatch(/candidate 7/);
    expect(p).toMatch(/>-</);
    expect(p).toMatch(/>System</);
    expect(p).toMatch(/second person: Fake Kit/);
    expect(p).toMatch(/Data access view/);
  });
  it("no rows is a state, not an empty table", () => {
    expect(page({ events: [] })).toMatch(/No rows match/);
    expect(page({ events: [] })).not.toMatch(/<table/);
  });
  it("text from people is escaped, never markup", () => {
    const p = page({ events: [row({ objectLabel: "<img src=x onerror=alert(1)>", actor: { staff: "s", staffName: "<script>x</script>", candidate: null, portal: null, system: null }, after: { status: "<b>v</b>" }, before: null })] });
    expect(p).not.toMatch(/<img|<script|<b>/);
    expect(p).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
  });
  it("Previous and Next, never page numbers", () => {
    const p = page({ next: "/audit?after=abc", prev: "/audit" });
    expect(p).toMatch(/Previous/);
    expect(p).toMatch(/Next/);
    expect(page()).not.toMatch(/Previous|Next/);
    expect(p).not.toMatch(/>2<\/a>|>40<\/a>/);
  });
});

describe("the roles", () => {
  it("an administrator may filter by person and reads the whole log; any other member reads their own", () => {
    const a = page({ isAdmin: true, people: [{ id: "stf1", name: "Fake Dara" }] });
    expect(a).toMatch(/name="staff"/);
    expect(a).toMatch(/Every admin action, and every staff view of candidate data/);
    const o = page();
    expect(o).not.toMatch(/name="staff"/);
    expect(o).toMatch(/Your own actions/);
    expect(o).not.toMatch(/Every admin action/);
  });
  it("the kind chips keep the other filters, the open one is marked, and Clear shows only when a filter is on", () => {
    const p = page({ filters: { kind: "data_access", from: "2026-11-01" } });
    expect(p).toMatch(/href="\/audit\?from=2026-11-01"[^>]*>All actions/);
    expect(p).toMatch(/aria-current="true"[^>]*>Personal data views|>Personal data views/);
    expect(p).toMatch(/>Clear</);
    expect(page()).not.toMatch(/>Clear</);
    expect(page({ notice: "x notice" })).toMatch(/x notice/);
  });
});

describe("the filters", () => {
  it("each value is kept only in the route's shape; a hostile address reads the log with no filter", () => {
    expect(cleanFilters({ kind: "data_access", action: "account_review.approved", staff: "abc_DEF-1", q: "strike:12", from: "2026-11-01", to: "2026-11-30" })).toEqual({ kind: "data_access", action: "account_review.approved", staff: "abc_DEF-1", q: "strike:12", from: "2026-11-01", to: "2026-11-30" });
    const bad = { kind: "evil", action: "Drop Table", staff: "a b", q: "x y", from: "2026-13-45", to: "tomorrow" };
    expect(cleanFilters(bad)).toEqual({});
    expect(cleanFilters({ action: "a".repeat(200), q: "<script>", staff: "s".repeat(65), from: "'; drop table audit_event; --" })).toEqual({});
    expect(cleanFilters({ kind: undefined })).toEqual({});
  });
  it("the route's query: a colon makes a case reference, anything else an object number; the page address keeps the text as typed", () => {
    expect(routeQuery({ q: "strike:12", kind: "admin_action" })).toBe("kind=admin_action&case=strike%3A12");
    expect(routeQuery({ q: "310", from: "2026-11-01" })).toBe("objectId=310&from=2026-11-01");
    expect(routeQuery({}, "cur")).toBe("after=cur");
    expect(href({})).toBe("/audit");
    expect(href({ q: "strike:12" }, "c")).toBe("/audit?q=strike%3A12&after=c");
  });
  it("words: change text for several columns and long values, the action and the object", () => {
    expect(changeText(row({ changedColumns: ["a", "b", "c", "d"], before: { a: 1, b: 2, c: 3, d: 4 }, after: { a: 2, b: 3, c: 4, d: 5 } }))).toMatch(/1 more$/);
    expect(changeText(row({ changedColumns: ["note"], before: { note: "x".repeat(100) }, after: { note: "y" } }))).toMatch(/\.\.\. → y/);
    expect(changeText(row({ changedColumns: null, before: null, after: { kind: "help", slug: "s" } }))).toBe("kind: help; slug: s");
    expect(actionText("fetched_job.approve")).toBe("Approved a fetched job");
    expect(actionText("some.new_action")).toBe("Some new action");
    expect(objectText(row({ objectLabel: null, objectType: null, objectId: null }))).toBe("-");
  });
});

describe("the export button", () => {
  const E = (shown: Parameters<typeof ExportView>[0]["shown"], pending = false) => html(<ExportView pending={pending} shown={shown} back="/audit?kind=security" onClick={() => {}} />);
  it("offers Export, locks while it runs, and says what went wrong in words (the sign-in link for the fresh sign-in)", () => {
    expect(E({ failed: null, truncated: false })).toMatch(/>Export</);
    expect(E({ failed: null, truncated: false }, true)).toMatch(/disabled[^>]*>[^>]*Exporting|Exporting/);
    const r = E({ failed: { code: "reauth_required", status: 403 }, truncated: false });
    expect(r).toMatch(/href="\/sign-in\?again=1&amp;next=%2Faudit%3Fkind%3Dsecurity"/);
    expect(E({ failed: { code: "bad_range", status: 400 }, truncated: false })).toMatch(/first day is after the last day/);
    expect(E({ failed: { code: "", status: 0 }, truncated: false })).toMatch(/Could not reach the server/);
    expect(E({ failed: null, truncated: true })).toMatch(/More than 2,000 rows matched/);
    clean(r);
  });
});
