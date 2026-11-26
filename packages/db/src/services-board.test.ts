// Unit: the pure parts of the services board (SV-B2): the status moves, the document codes, the note and firm text checks, the timeline's reply.
// No database: a call that would reach one fails.
import { describe, expect, it } from "vitest";
import { CASE_DOCUMENT_CODES, documentLabels, isCaseDocumentCode } from "./case-document-codes";
import { canMove, CASE_MOVES, noteOk, OPEN_STATUSES, solicitorText, STAFF_CLOSE_REASONS, timelineEvents, timelineSql } from "./services-board";

describe("status moves", () => {
  it("allows exactly the moves of services-plan-check.md section 4 plus submitted back to documents_needed (DETE asks for more); closing is never a move", () => {
    const allowed = OPEN_STATUSES.flatMap((f) => [...OPEN_STATUSES, "closed"].filter((t) => canMove(f, t)).map((t) => `${f}>${t}`));
    expect(allowed).toEqual(["received>documents_needed", "received>waiting_for_employer", "received>submitted", "documents_needed>waiting_for_employer",
      "documents_needed>submitted", "waiting_for_employer>documents_needed", "waiting_for_employer>submitted", "submitted>documents_needed", "submitted>decision"]);
    expect(canMove("closed", "received")).toBe(false);
    expect(canMove("__proto__", "constructor")).toBe(false);
    expect(Object.keys(CASE_MOVES)).toEqual([...OPEN_STATUSES]);
    expect(STAFF_CLOSE_REASONS).not.toContain("withdrawn");
  });
});

describe("document codes", () => {
  it("every code passes 0061's private.case_codes_ok shape, and labels are placeholders", () => {
    for (const c of Object.keys(CASE_DOCUMENT_CODES)) expect(c).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    expect(Object.keys(CASE_DOCUMENT_CODES)).toHaveLength(16);
    for (const c of ["passport_photo", "revenue_statement", "lmnt_advert_evidence", "hgv_licence"]) expect(isCaseDocumentCode(c)).toBe(true); // the route takes the checklist codes
    expect(isCaseDocumentCode("bank_statement")).toBe(false);
    expect(isCaseDocumentCode("cv")).toBe(true);
    for (const x of ["toString", "__proto__", "CV", "", 1, null]) expect(isCaseDocumentCode(x)).toBe(false);
    expect(documentLabels(["cv", "gone"])).toEqual([{ code: "cv", label: "CV" }, { code: "gone", label: null }]);
  });
});

describe("text checks", () => {
  it("a note: 1 to 2000 characters, newlines and tabs only", () => {
    expect(noteOk("a\nb\tc")).toBe(true);
    for (const x of ["", "  \n ", "x".repeat(2001), "a\u0000b", "a‮b", "a\rb", 5, null]) expect(noteOk(x)).toBe(false);
  });
  it("a firm or contact: trimmed, within the limit, no control characters", () => {
    expect(solicitorText("Fake LLP", 200)).toBe(true);
    for (const x of ["", " a", "a ", "a\nb", "a​b", "x".repeat(201), 3]) expect(solicitorText(x, 200)).toBe(false);
  });
});

describe("the timeline reply", () => {
  it("labels the codes and the outcome, never an id; the firm only when given", () => {
    const ev = [
      { at: "t1", kind: "documents_needed", status: "received", detail: { documentsNeeded: ["cv"] } },
      { at: "t2", kind: "decision", status: "decision", detail: { outcome: "refused" as const } },
      { at: "t3", kind: "referred", status: "closed", detail: { referralSolicitorId: 7 } as never },
      { at: "t4", kind: "assigned", status: "closed", detail: {} },
    ];
    expect(timelineEvents(ev, null)).toEqual([
      { at: "t1", kind: "documents_needed", status: "received", documentsNeeded: [{ code: "cv", label: "CV" }] },
      { at: "t2", kind: "decision", status: "decision", outcome: { code: "refused", label: "Permit refused" } },
      { at: "t3", kind: "referred", status: "closed", referral: { code: "referred_to_solicitor" } },
      { at: "t4", kind: "assigned", status: "closed" },
    ]);
    expect(timelineEvents(ev, "Fake LLP")[2]).toEqual({ at: "t3", kind: "referred", status: "closed", referral: { code: "referred_to_solicitor", firm: "Fake LLP" } });
  });
  it("reads through the side's own wrappers only, and the firm reader only when shown", () => {
    expect(timelineSql("candidate", false)).not.toMatch(/portal_|referral_firm|case_timeline\(\s*'/);
    expect(timelineSql("portal", true)).toMatch(/private\.portal_case_referral_firm/);
    expect(timelineSql("portal", true)).not.toMatch(/candidate_/);
  });
});
