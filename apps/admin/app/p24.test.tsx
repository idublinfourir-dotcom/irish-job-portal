// P24: the reports and strikes page (D08) and the ban list (D09) rendered to HTML from fixture props (react-dom/server, no browser, no database, no network), the words of every refusal the
// contract names for their routes (codes read from docs/openapi/admin.yaml), the guard's role refusal and the form body of the new date field. Fixtures are fake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { bodyOf } from "./_queue/act";
import { guarded } from "./_queue/guard";
import { staffWords } from "./_queue/staff-words";
import { EvidenceView } from "./reports/evidence";
import { type CaseItem, type Counts, href, isTab, parseLabel, type ReportItem, type Row, timeline } from "./reports/text";
import { CasePanel, List, ReportPanel, Reports, type Selected } from "./reports/view";
import { BanList, Bans, type Ban, caseHref, type Wrc } from "./ban-list/view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));

const NOW = new Date("2026-11-25T12:00:00Z");
const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Launch B|Sample/);
const XSS = "<img src=x onerror=alert(1)><script>x</script>";
const noMarkup = (s: string) => expect(s).not.toMatch(/<img|<script/);
const REPORTER = "cand-secret-user-id-77";

const row = (o: Partial<Row> = {}): Row => ({ kind: "report", id: "91", label: "R-0091", createdAt: "2026-11-25T10:00:00.000Z", organisationId: "5", displayName: "Fake Hotels Ltd", organisationKind: "employer", jobId: "7", jobTitle: "Night Porter", reason: "asks_for_money", state: "open", outcome: null, level: null, reportId: null, jobReports: 3, companyReports: 200, ...o });
const report = (o: Partial<ReportItem> = {}): ReportItem => ({ id: "91", status: "open", targetKind: "job", reason: "asks_for_money", createdText: "2026-11-24 10:42:00+00", targetJobId: "7", jobTitle: "Night Porter", jobStatus: "live", organisationId: "5", displayName: "Fake Hotels Ltd", evidenceText: "They asked for 450 euro.", reporterCandidateUserId: REPORTER, reporterPortalUserId: null, decidedAt: null, evidenceFile: false, caseId: null, ...o });
const kase = (o: Partial<CaseItem> = {}): CaseItem => ({
  id: "12", organisationId: "5", caseKind: "false_claim", jobId: null, reportId: "91", reasonCode: "false_sponsorship", noticeSummary: null, level: null, stage: "case_open", outcome: null, replyDueAt: null, employerReply: null, replyReceivedAt: null, decidedAt: null,
  appealDueAt: null, appealText: null, appealedAt: null, appealDecidedAt: null, banLiftedAt: null, createdAt: "2026-11-20T09:00:00.000Z", evidenceFile: false, displayName: "Fake Hotels Ltd", organisationKind: "employer", organisationStatus: "verified",
  pending: [], bans: [], notes: [], wrcReported: false, ...o,
});
const panel = (c: CaseItem, meId = "me") => html(<CasePanel c={c} label="C-0012" reportLabel={c.reportId ? "R-0091" : undefined} meId={meId} here="/reports?id=C-0012" now={NOW} />);
const rpanel = (r: ReportItem) => html(<ReportPanel r={r} label="R-0091" here="/reports?id=R-0091" now={NOW} />);

describe("the words of every refusal the contract names for these routes", () => {
  const SPEC = parse(readFileSync(join(import.meta.dirname, "../../../docs/openapi/admin.yaml"), "utf8")) as { paths: Record<string, Record<string, { responses?: Record<string, { description?: string }> }>> };
  const NOT_CODES = new Set(["id", "after", "conclusive", "file", "reportId", "caseId", "tab"]); // request fields named in a description, not refusal codes
  const GENERIC = staffWords("zz_not_a_code", 400);
  for (const path of ["/api/trust-safety/list", "/api/trust-safety/bans", "/api/trust-safety/wrc", "/api/trust-safety/reports", "/api/trust-safety/cases", "/api/trust-safety/evidence"])
    it(`${path}: each code has its own sentence, no dash and no code text`, () => {
      const codes = Object.values(SPEC.paths[path]!).flatMap((op) => Object.entries(op.responses ?? {}).filter(([s]) => Number(s) >= 400)
        .flatMap(([s, r]) => [...(r.description ?? "").matchAll(/`([a-z][a-z_]*)`/g)].map((m) => ({ code: m[1]!, status: Number(s) })))).filter((c) => !NOT_CODES.has(c.code));
      expect(codes.length, path).toBeGreaterThan(3);
      for (const { code, status } of codes) {
        const w = staffWords(code, status);
        expect(w, `${path} ${code}`).not.toBe(GENERIC);
        expect(w, `${path} ${code}`).not.toMatch(/[–—]|undefined|\[object/);
        expect(w, `${path} ${code}`).not.toContain(code);
      }
    });
});

describe("the address and the guard", () => {
  it("an id label is R or C and 4 or more digits; anything else is no label (a hostile ?id= never reaches a read)", () => {
    expect(parseLabel("R-0091")).toEqual({ kind: "report", id: "91" });
    expect(parseLabel("C-123456")).toEqual({ kind: "case", id: "123456" });
    for (const bad of [undefined, "", "R-1", "X-0091", "r-0091", "R-0091; drop table", "R-00911111111111111111111", "../etc", XSS, "R-0091\n"]) expect(parseLabel(bad), String(bad)).toBeNull();
    expect(isTab("closed")).toBe(true);
    expect(isTab("scam")).toBe(false);
    expect(href("open")).toBe("/reports");
    expect(href("closed", "C-0012", "abc")).toBe("/reports?tab=closed&id=C-0012&after=abc");
    expect(caseHref("C-0012")).toBe("/reports?id=C-0012");
  });
  it("a login without the trust and safety role gets the refused state, a signed-out visitor goes to sign in, a fault stays a fault", async () => {
    expect(await guarded(async () => { throw new Error("not_trust_and_safety"); })).toEqual({ refused: true });
    await expect(guarded(async () => { throw new Error("no_session"); })).rejects.toThrow("redirect:/sign-in");
    await expect(guarded(async () => { throw new Error("connection refused"); })).rejects.toThrow("connection refused");
  });
  it("the date field's body is ISO with the zone; a bad one goes as empty text for the route to refuse", () => {
    const f = new FormData(); f.set("receivedAt", "2026-11-24T10:42");
    expect(bodyOf({}, [{ name: "receivedAt", label: "x", kind: "datetime" }], f).receivedAt).toBe(new Date("2026-11-24T10:42").toISOString());
    f.set("receivedAt", "not a date");
    expect(bodyOf({}, [{ name: "receivedAt", label: "x", kind: "datetime" }], f).receivedAt).toBe("");
  });
});

describe("the list", () => {
  it("shows the one label, the company and job, the reason, both counts (200 as 200+), the state and the age, and the open row", () => {
    const h = html(<List tab="open" items={[row(), row({ kind: "case", label: "C-0012", id: "12", state: "employer_notified", reason: "false_sponsorship", jobReports: 0, companyReports: 1 })]} selected="R-0091" now={NOW} next="/reports?after=x" prev="/reports" />);
    expect(h).toMatch(/R-0091/); expect(h).toMatch(/C-0012/); expect(h).toMatch(/Night Porter/); expect(h).toMatch(/Asks for money/); expect(h).toMatch(/3 \/ 200\+/);
    expect(h).toMatch(/Waiting for reply/); expect(h).toMatch(/2 h/); expect(h).toMatch(/aria-current="true"/); expect(h).toMatch(/Previous/); expect(h).toMatch(/Next/);
    expect(h).toContain('href="/reports?id=R-0091"');
    clean(h);
  });
  it("each tab has its own empty state", () => {
    for (const [tab, text] of [["open", "Nothing is open"], ["waiting", "No case is waiting"], ["appeals", "No appeal is waiting"], ["closed", "Nothing closed yet"]] as const)
      expect(html(<List tab={tab} items={[]} now={NOW} />)).toMatch(text);
  });
  it("company names and job titles are text, never markup", () => {
    const h = html(<List tab="open" items={[row({ displayName: XSS, jobTitle: XSS })]} now={NOW} />);
    noMarkup(h);
  });
  it("the page: the tabs with their counts (none on a later page), a missing id notice, and the panel beside the list", () => {
    const counts: Counts = { open: 6, waiting: 2, appeals: 0, closed: 200 };
    const sel: Selected = { kind: "report", item: report(), label: "R-0091" };
    const h = html(<Reports tab="open" items={[row()]} counts={counts} selected={sel} meId="me" now={NOW} />);
    expect(h).toMatch(/Waiting for employer reply/); expect(h).toMatch(/200\+/); expect(h).toMatch(/aria-label="Report R-0091"/);
    expect(html(<Reports tab="open" items={[row()]} counts={null} selected={null} missingId meId="me" now={NOW} />)).toMatch(/was not found/);
    clean(h);
  });
});

describe("a report", () => {
  it("shows the evidence as text, who reported it (the kind, never the id), the steps and the decisions of an open job report", () => {
    const h = rpanel(report({ evidenceText: XSS }));
    noMarkup(h);
    expect(h).toMatch(/Reported by a candidate/); expect(h).not.toContain(REPORTER);
    expect(h).toMatch(/Hide the job/); expect(h).toMatch(/Clear the report/); expect(h).toMatch(/Uphold the report and open a case/); expect(h).toMatch(/Open an instant-ban case/);
    expect(h).toMatch(/Attach the evidence file/); expect(h).toMatch(/Waiting for a decision/);
    clean(h);
  });
  it("a hidden job has no Hide button; a company report has none either; a file already there opens through the audited route and cannot be attached again", () => {
    expect(rpanel(report({ status: "job_hidden" }))).not.toMatch(/Hide the job/);
    expect(rpanel(report({ targetJobId: null, jobTitle: null }))).not.toMatch(/Hide the job/);
    const h = rpanel(report({ evidenceFile: true }));
    expect(h).toContain('href="/api/trust-safety/evidence?reportId=91"'); expect(h).not.toMatch(/Attach the evidence file/);
  });
  it("a closed report has no action, no reporter, and a link to its case", () => {
    const h = rpanel(report({ status: "upheld", reporterCandidateUserId: null, decidedAt: "2026-11-24T12:00:00.000Z", caseId: "12" }));
    expect(h).not.toMatch(/Clear the report|Hide the job|Uphold/); expect(h).toMatch(/The reporter was cleared/); expect(h).toContain('href="/reports?id=C-0012"'); expect(h).toMatch(/Upheld/);
  });
});

describe("a case", () => {
  it("not yet notified: notify, no action, strike, notes, the evidence form; no reply or appeal form", () => {
    const h = panel(kase());
    for (const t of ["Notify the employer", "No action", "Apply strike", "Add note", "Attach the evidence file"]) expect(h).toContain(t);
    expect(h).not.toMatch(/Record the reply|Record the appeal|Confirm</); expect(h).toContain('href="/reports?id=R-0091"');
    clean(h);
  });
  it("an instant-ban case offers the ban with the conclusive tick instead of a strike, and the WRC tick-off for an agency until it is done", () => {
    const h = panel(kase({ caseKind: "instant_ban", organisationKind: "agency", reasonCode: "asks_for_money" }));
    expect(h).toMatch(/Propose the ban/); expect(h).toMatch(/Conclusive evidence/); expect(h).not.toMatch(/Apply strike/); expect(h).toMatch(/Mark as reported to the WRC/);
    expect(panel(kase({ caseKind: "instant_ban", organisationKind: "agency", wrcReported: true }))).not.toMatch(/Mark as reported to the WRC/);
    expect(panel(kase({ caseKind: "instant_ban", organisationKind: "employer" }))).not.toMatch(/WRC/);
  });
  it("notified: the reply can be recorded, with its date; the employer's words show as text", () => {
    const h = panel(kase({ stage: "employer_notified", replyDueAt: "2026-11-30T09:00:00.000Z", employerReply: XSS, replyReceivedAt: "2026-11-22T09:00:00.000Z" }));
    expect(h).toMatch(/Record the reply/); expect(h).toContain('type="datetime-local"'); expect(h).not.toMatch(/Notify the employer/); noMarkup(h);
  });
  it("two-person step: the proposer sees Withdraw only; another officer sees Confirm and Refuse; no decision is offered while one waits", () => {
    const c = kase({ stage: "employer_notified", replyDueAt: "2026-11-20T09:00:00.000Z", pending: [{ id: "3", kind: "strike_2", change: {}, proposedBy: "me" }] });
    const mine = panel(c, "me"), other = panel(c, "someone-else");
    expect(mine).toMatch(/Waiting for a second officer/); expect(mine).toMatch(/Withdraw/); expect(mine).not.toMatch(/>Confirm</);
    expect(other).toMatch(/>Confirm</); expect(other).toMatch(/>Refuse</);
    expect(mine).not.toMatch(/Apply strike|>No action</);
  });
  it("a ban in force can be proposed for lifting, not while a lift already waits; an appeal can be recorded in its window and decided once entered", () => {
    expect(panel(kase({ outcome: "strike", level: 3, stage: "applied", bans: [{ id: "1" }] }))).toMatch(/Propose lifting the ban/);
    expect(panel(kase({ outcome: "ban", stage: "applied", bans: [{ id: "1" }], pending: [{ id: "4", kind: "ban_lift", change: {}, proposedBy: "x" }] }))).not.toMatch(/Propose lifting/);
    const window = kase({ outcome: "strike", level: 1, stage: "applied", appealDueAt: "2026-12-01T09:00:00.000Z" });
    expect(panel(window)).toMatch(/Record the appeal/); expect(panel(window)).not.toMatch(/Appeal: overturn/);
    const entered = kase({ ...window, stage: "appealed", appealedAt: "2026-11-24T09:00:00.000Z", appealText: XSS });
    const h = panel(entered);
    expect(h).toMatch(/Appeal: overturn/); expect(h).toMatch(/Appeal: keep the decision/); expect(h).not.toMatch(/Record the appeal/); noMarkup(h);
  });
  it("a decided case with a decided appeal has no step left but notes", () => {
    const h = panel(kase({ outcome: "strike", level: 1, stage: "upheld", appealedAt: "2026-11-24T09:00:00.000Z", appealDecidedAt: "2026-11-25T09:00:00.000Z" }));
    expect(h).not.toMatch(/Appeal: |Record the|Notify|Apply strike|No action/); expect(h).toMatch(/Add note/);
  });
  it("notes show their writer as text and say they stay with staff; staff text is never markup", () => {
    const h = panel(kase({ notes: [{ id: "1", text: XSS, staffName: XSS, createdAt: "2026-11-24T09:00:00.000Z" }], noticeSummary: XSS }));
    noMarkup(h); expect(h).toMatch(/Staff only/); expect(h).not.toMatch(/No notes yet/);
  });
  it("the five steps: done, now, and still to come", () => {
    const t = timeline(kase({ stage: "employer_notified", replyDueAt: "2026-12-30T09:00:00.000Z" }), NOW);
    expect(t.map((s) => s.ok)).toEqual([true, true, false, null, null]);
    expect(timeline(kase(), NOW).map((s) => s.ok)).toEqual([true, false, null, null, null]);
    expect(timeline(kase({ outcome: "cleared", stage: "decided", replyDueAt: "2026-11-21T09:00:00.000Z" }), NOW).map((s) => s.ok)).toEqual([true, true, true, true, false]);
  });
});

describe("the evidence form", () => {
  it("shows the file field with its limits, an error in words, and the sign-in link when a fresh sign-in is asked for", () => {
    const h = html(<EvidenceView s={{ pending: false, error: { code: "reauth_required", text: "For safety, sign in again to do this." } }} here="/reports?id=C-0012" onSubmit={() => {}} />);
    expect(h).toMatch(/type="file"/); expect(h).toMatch(/4 MB/); expect(h).toContain("/sign-in?again=1&amp;next=%2Freports%3Fid%3DC-0012");
    expect(html(<EvidenceView s={{ pending: true }} here="/" onSubmit={() => {}} />)).toMatch(/disabled/);
  });
});

describe("the ban list", () => {
  const ban = (o: Partial<Ban> = {}): Ban => ({ banId: "1", type: "cro_number", value: "123456", reasonCode: "asks_for_money", caseId: "12", caseLabel: "C-0012", displayName: "Fake Agency Ltd", addedAt: "2026-11-20T09:00:00.000Z", proposedBy: "Kit Nolan", confirmedBy: "Dara Kelly", liftPending: false, ...o });
  const wrc: Wrc = { caseId: "12", caseLabel: "C-0012", displayName: "Fake Agency Ltd", reasonCode: "asks_for_money", reportedAt: "2026-11-21T09:00:00.000Z", reportedBy: "Dara Kelly" };
  it("lists type, value, organisation, reason, case, date and who; no Add and no Remove (#44, CF109); the lift is on the case", () => {
    const h = html(<BanList bans={{ items: [ban(), ban({ type: "email_domain", value: "fake-agency.example", liftPending: true })], next: "/ban-list?after=x" }} wrc={{ items: [wrc] }} />);
    for (const t of ["CRO number", "Email domain", "123456", "fake-agency.example", "Fake Agency Ltd", "Asks for money", "Kit Nolan and Dara Kelly", "Lift waiting", "Reported to the WRC", "Scam wording flags"]) expect(h).toContain(t);
    expect(h).toContain('href="/reports?id=C-0012"'); expect(h).not.toMatch(/Add entry|Add keyword|>Remove</); expect(h).toMatch(/Next/);
    clean(h);
  });
  it("empty states, and every value is text", () => {
    expect(html(<Bans items={[]} />)).toMatch(/No bans yet/);
    expect(html(<BanList bans={{ items: [] }} wrc={{ items: [] }} />)).toMatch(/No case has been reported to the WRC yet/);
    noMarkup(html(<Bans items={[ban({ value: XSS, displayName: XSS })]} />));
  });
});
