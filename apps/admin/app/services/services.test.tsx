// The services board pages (frame D11): the words, every state of the board, the table, the case panel, the documents table and the buttons. react-dom/server, no browser, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Actions, ActionsView, closeReasons, type Handlers, type Props, type ViewState } from "./[id]/actions";
import { CaseView, Documents } from "./[id]/detail";
import { OpenCopyView } from "./[id]/open-copy";
import { DOC_CODES, MOVES, STATUSES, caseRef, holder, permitLabel, payerLabel, sideLabel, words, type CaseItem, type Doc, type Row } from "./text";
import { Board, Services, Table, href, keep, isWho } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/services" }));

const NOW = new Date("2026-11-25T12:00:00Z");
const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Launch B|Sample|Ready to submit|New case/);
const row = (o: Partial<Row> = {}): Row => ({ id: "245", status: "received", createdAt: "2026-11-22 09:00:00+00", permitType: "critical_skills", payer: "employer", hrContactConsent: false, assignedStaffUserId: null, side: "candidate", ...o });
const item = (o: Partial<CaseItem> = {}): CaseItem => ({
  id: "241", status: "documents_needed", createdAt: "2026-11-20 09:00:00+00", permitType: "critical_skills", offerDetails: { details: { title: "Fake Title", employerName: "Fake Employer Ltd" } }, payer: "employer", hrContactConsent: true,
  decisionOutcome: null, documentsNeeded: [{ code: "degree", label: "Degree or qualification" }], decidedAt: null, closedAt: null, closeReason: null, referralSolicitorId: null, assignedStaffUserId: "me", side: "candidate",
  requesterErased: false, requesterName: "Fake Person", requesterEmail: "fake@example.test", copies: 1, notes: [{ id: "1", authorStaffUserId: "me", body: "Fake note body", createdAt: "2026-11-21 10:00:00+00" }], ...o,
});
const doc = (o: Partial<Doc> = {}): Doc => ({ id: "7", fileName: "offer-fake.pdf", contentType: "pdf", sizeBytes: 100, uploadedAt: "2026-11-21 10:00:00+00", copyDeleted: false, uploadedBy: "candidate", ...o });
const cols = (rows: Row[] = [row()]) => STATUSES.map((s) => ({ status: s, rows: s === "received" ? rows : [], more: false }));

describe("the words", () => {
  it("labels, references and who holds a case", () => {
    expect(caseRef("245")).toBe("PS-0245");
    expect(permitLabel("critical_skills")).toBe("Critical Skills");
    expect(permitLabel(null)).toBe("Permit not chosen");
    expect([payerLabel("agency"), payerLabel(null), sideLabel("portal"), sideLabel(null)]).toEqual(["Agency", "Not set", "Employer or agency", "Not known"]);
    expect([holder(null, "me"), holder("me", "me"), holder("x", "me")]).toEqual(["none", "me", "other"]);
    expect(STATUSES).not.toContain("ready_to_submit");
  });
  it("the status moves are the route's (the decision stage has none) and the document codes are the route's list in admin.yaml", () => {
    expect(MOVES.decision).toEqual([]);
    expect(MOVES.submitted).toEqual(["documents_needed", "decision"]);
    const yaml = readFileSync(path.join(import.meta.dirname, "../../../../docs/openapi/admin.yaml"), "utf8");
    const line = yaml.match(/`documents`: codes from the fixed list \(([^)]*)\)/)![1]!;
    expect(DOC_CODES.map(([c]) => c)).toEqual(line.split(",").map((c) => c.trim()));
  });
  it("close reasons follow the outcome", () => {
    expect(closeReasons("granted").map(([k]) => k)).toEqual(["decided"]);
    expect(closeReasons(null).map(([k]) => k)).toEqual(["employer_not_engaged", "no_reply"]);
  });
  it("every refusal code the services routes list in admin.yaml has its own plain sentence", () => {
    const yaml = readFileSync(path.join(import.meta.dirname, "../../../../docs/openapi/admin.yaml"), "utf8");
    const block = (from: string, to: string) => yaml.slice(yaml.indexOf(from), yaml.indexOf(to, yaml.indexOf(from) + 1));
    const text = [block("  /api/services/cases/{id}/documents:", "  /api/staff/me:"), block("  /api/services/cases:\n", "  /api/services/solicitors:"), block("    NoStaffSession:", "    ServerError:")].join("\n");
    const codes = [...new Set([...text.matchAll(/`([a-z][a-z_]+)`:/g)].map((m) => m[1]!))].filter((c) => c.includes("_"));
    expect(codes.length).toBeGreaterThan(30);
    const generic = words("zzz_unknown", 400);
    for (const c of codes) {
      const w = words(c, c === "server_error" ? 500 : 400);
      expect(w, c).not.toBe(generic);
      expect(w, c).not.toContain(c);
      expect(w, c).toMatch(/[.]$/);
      expect(w, c).not.toMatch(/[–—]/);
    }
    expect(words("", 0)).toMatch(/Could not reach/);
    expect(words("x", 429)).toMatch(/Too many/);
  });
  it("href keeps only what is not a default", () => {
    expect(href({})).toBe("/services");
    expect(href({ view: "table", status: "received" })).toBe("/services?view=table");
    expect(href({ view: "table", status: "submitted", who: "mine", after: "abc" })).toBe("/services?view=table&status=submitted&who=mine&after=abc");
    expect(isWho("mine")).toBe(true);
    expect(isWho("<x>")).toBe(false);
    expect(keep([row({ id: "1", assignedStaffUserId: "me" }), row({ id: "2" }), row({ id: "3", assignedStaffUserId: "x" })], "mine", "me").map((r) => r.id)).toEqual(["1"]);
    expect(keep([row({ id: "1", assignedStaffUserId: "me" }), row({ id: "2" })], "unassigned", "me").map((r) => r.id)).toEqual(["2"]);
  });
});

describe("the board and the table", () => {
  it("five columns, a card with its reference, permit and who holds it, and the copies line", () => {
    const p = html(<Services view="board" status="received" who="all" me="me" now={NOW} columns={cols()} />);
    clean(p);
    for (const w of ["Received", "Documents needed", "Waiting on employer", "Submitted", "Decision"]) expect(p).toContain(w);
    expect(p).toContain("PS-0245");
    expect(p).toContain("Critical Skills");
    expect(p).toContain("Unassigned");
    expect(p).toContain("Copies only, never originals.");
    expect(p).toContain("Our service fee is paid by the employer or agency.");
    expect(p).toContain('href="/services/245"');
    expect(p).not.toMatch(/Candidate pays|candidate pays/);
    expect(p).toContain("Nothing here.");
  });
  it("a card says Yours for the viewer's case; the filter keeps only that and says it covers the first page", () => {
    const rows = [row({ id: "1", assignedStaffUserId: "me" }), row({ id: "2", assignedStaffUserId: "x" })];
    const p = html(<Services view="board" status="received" who="mine" me="me" now={NOW} columns={cols(rows)} />);
    expect(p).toContain("Yours");
    expect(p).toContain("/services/1\"");
    expect(p).not.toContain("/services/2\"");
    expect(p).toMatch(/first 20 cases/);
  });
  it("a full column says so and links to the table", () => {
    const p = html(<Board columns={[{ status: "received", rows: [row()], more: true }]} who="all" me="me" now={NOW} />);
    expect(p).toContain("1+");
    expect(p).toContain("See all received");
    expect(p).toContain("/services?view=table");
  });
  it("the table: rows, the status tabs, an empty state and Previous and Next only", () => {
    const t = html(<Table status="submitted" rows={[row({ status: "submitted" })]} who="all" me="me" now={NOW} next="/services?view=table&after=x" prev="/services?view=table" />);
    expect(t).toContain("PS-0245");
    expect(t).toMatch(/aria-current="page"[^>]*>Submitted/);
    expect(t).toMatch(/Previous/);
    expect(t).toMatch(/Next/);
    expect(t).not.toMatch(/Page \d/);
    const e = html(<Table status="decision" rows={[]} who="mine" me="me" now={NOW} />);
    expect(e).toContain("No decision cases match this filter");
    clean(t + e);
  });
});

const props = (o: Partial<Props> = {}): Props => ({ caseId: "241", status: "documents_needed", outcome: null, held: "me", isHandler: true, isAdmin: false, meId: "me", handlers: [], solicitors: [{ id: "3", firm: "Fake Solicitors LLP" }], ...o });
const state = (o: Partial<ViewState> = {}): ViewState => ({ ask: null, pending: false, codes: [], note: "", reason: "no_reply", solicitor: "", assignTo: "", ...o });
const noop: Handlers = { onAsk() {}, onConfirm() {}, onNote() {}, onChange() {} };
const view = (p: Partial<Props>, s: Partial<ViewState> = {}) => html(<ActionsView p={props(p)} s={state(s)} h={noop} />);

describe("the buttons", () => {
  it("the assigned handler gets the moves, the document codes, close, refer with the scope line, and a note", () => {
    const v = view({});
    clean(v);
    expect(v).toContain("Waiting on employer");
    expect(v).toMatch(/>Submitted</);
    for (const [, label] of DOC_CODES) expect(v).toContain(label);
    expect(v).toContain("Copies only, never originals.");
    expect(v).toContain("Scope: application support, not legal advice.");
    expect(v).toContain("Fake Solicitors LLP");
    expect(v).toContain("Add a note");
    expect(v).toContain("Staff only, never shown to the requester");
    expect(v).toMatch(/Ask for documents<\/button>/);
    expect(v).toMatch(/<button[^>]*disabled[^>]*>Ask for documents/); // nothing ticked
    expect(v).not.toMatch(/Take this case|Record the outcome/);
  });
  it("at the decision stage the outcome is recorded; with an outcome only Decided closes; documents are no longer asked for", () => {
    const d = view({ status: "decision" });
    expect(d).toContain("Record the outcome");
    expect(d).toMatch(/>Granted</);
    expect(d).toMatch(/>Refused</);
    expect(d).not.toMatch(/Ask for documents/);
    const g = view({ status: "decision", outcome: "granted" });
    expect(g).not.toContain("Record the outcome");
    expect(g).toMatch(/<option value="decided"/);
    expect(g).not.toMatch(/employer_not_engaged/);
  });
  it("an unassigned case offers Take this case and nothing else; another handler's case offers nothing", () => {
    const u = view({ held: "none" });
    expect(u).toContain("Take this case");
    expect(u).not.toMatch(/Close the case|Add a note|Ask for documents/);
    const o = view({ held: "other" });
    expect(o).toContain("Another handler holds this case");
    expect(o).not.toMatch(/Take this case|Close the case|Add a note/);
  });
  it("an administrator may assign and nothing else; a closed case offers nothing", () => {
    const a = view({ isHandler: false, isAdmin: true, held: "other", handlers: [{ id: "h1", name: "Fake Handler" }] });
    expect(a).toContain("Assign to");
    expect(a).toContain("Fake Handler");
    expect(a).not.toMatch(/Close the case|Add a note|Ask for documents|Refer to solicitor/);
    expect(view({ status: "closed" })).toMatch(/This case is closed/);
  });
  it("the confirm dialog shows its words and an error in plain words", () => {
    const v = view({}, { ask: { title: "Close this case?", text: "A closed case cannot be reopened.", button: "Close the case", danger: true, body: {} }, error: words("bad_move", 409) });
    expect(v).toContain("Close this case?");
    expect(v).toContain("A closed case cannot be reopened.");
    expect(v).toContain("That status move is not allowed");
  });
  it("renders its stateful wrapper", () => {
    expect(html(<Actions {...props()} />)).toContain("Add a note");
  });
});

describe("the case panel and the documents", () => {
  const detail = (it: CaseItem, o: { isHandler?: boolean; isAdmin?: boolean; docs?: Parameters<typeof CaseView>[0]["docs"] } = {}) =>
    html(<CaseView item={it} meId="me" isHandler={o.isHandler ?? true} isAdmin={o.isAdmin ?? false} docs={o.docs ?? { kind: "list", docs: [doc(), doc({ id: "8", fileName: null, copyDeleted: true })] }} handlers={[]} solicitors={[]} />);
  it("a handler sees the requester, the payer and fee line, the offer, the notes, and the copies with Open only on a live copy", () => {
    const p = detail(item());
    clean(p);
    expect(p).toContain("PS-0241");
    expect(p).toContain("Fake Person");
    expect(p).toContain("fake@example.test");
    expect(p).toContain("Our service fee is paid by the employer or agency.");
    expect(p).toContain("Fake Title");
    expect(p).toContain("Fake note body");
    expect(p).toContain("Copies only, never originals.");
    expect(p).toContain("Copies are deleted 30 days after a case closes.");
    expect(p).toContain("offer-fake.pdf");
    expect(p).toContain("Copy deleted");
    expect((p.match(/Open the copy/g) ?? []).length).toBe(1);
    expect(p).toContain("Degree or qualification");
    expect(p).not.toMatch(/never keep a passport/i);
  });
  it("an administrator's page carries no note, copy, name or email, because the read gave none", () => {
    const p = detail(item({ requesterName: undefined, requesterEmail: undefined, copies: undefined, notes: undefined, assignedStaffUserId: "h1" }), { isHandler: false, isAdmin: true, docs: { kind: "hidden", why: "admin" } });
    expect(p).toMatch(/Administrators do not see/);
    expect(p).not.toMatch(/Fake note body|offer-fake|Fake Person|fake@example/);
  });
  it("an erased requester, a closed case, and the documents states", () => {
    expect(detail(item({ requesterErased: true, requesterName: null, requesterEmail: null }))).toContain("Removed at the requester&#x27;s request");
    const c = detail(item({ status: "closed", closeReason: "no_reply", closedAt: "2026-11-24 10:00:00+00", requesterName: null, requesterEmail: null }));
    expect(c).toContain("No reply");
    expect(c).toMatch(/This case is closed/);
    const asked = [{ code: "zzz", label: null }];
    expect(html(<Documents caseId="1" state={{ kind: "list", docs: [] }} asked={asked} />)).toMatch(/No copies have been uploaded yet.*|zzz/s);
    expect(html(<Documents caseId="1" state={{ kind: "hidden", why: "not_mine" }} asked={[]} />)).toContain("Take this case to see its copies.");
    expect(html(<Documents caseId="1" state={{ kind: "error", text: words("case_not_found", 404) }} asked={[]} />)).toContain("not assigned to you");
  });
  it("opening a copy: a pending or blocked copy has no open button; an error shows its words", () => {
    const open = () => {};
    expect(html(<OpenCopyView state="idle" onOpen={open} name="a.pdf" />)).toContain("Open the copy a.pdf");
    expect(html(<OpenCopyView state="scan_pending" onOpen={open} name="a.pdf" />)).not.toContain("<button");
    expect(html(<OpenCopyView state="file_blocked" onOpen={open} name="a.pdf" />)).toMatch(/Blocked/);
    expect(html(<OpenCopyView state="file_blocked" onOpen={open} name="a.pdf" />)).not.toContain("<button");
    expect(html(<OpenCopyView state={{ error: words("document_not_found", 404) }} onOpen={open} name="a.pdf" />)).toContain("no longer on this case");
  });
});
