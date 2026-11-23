// Unit tests (no database, network or browser) for the audit export's CSV text (B59): quoting, the formula guard, empty cells, line ends.
import { describe, expect, it } from "vitest";
import { AUDIT_CSV_HEAD, auditCsv, type AuditRow } from "./audit-read";

const row = (o: Partial<AuditRow> = {}): AuditRow => ({
  id: "1", at: "2026-11-18 09:30:00+00", kind: "admin_action", actor: { staff: "s1", staffName: "Dara Kelly", candidate: null, portal: null, system: null }, roleInForce: null,
  action: "a.b", objectType: "organisation", objectId: "310", objectLabel: "Lakeside", changedColumns: ["status", "name"], before: { status: "x" }, after: null, reasonCode: null,
  secondStaff: null, secondStaffName: null, relatedCase: null, source: "panel", ...o,
});
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replaceAll('""', '"'));

describe("auditCsv", () => {
  it("is a header line and one line a row, each cell quoted, lines ended by CRLF, null cells empty, JSON as text, column names joined by a semicolon", () => {
    const lines = auditCsv([row()]).split("\r\n");
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("");
    expect(cells(lines[0]!)).toEqual(AUDIT_CSV_HEAD);
    expect(cells(lines[1]!)).toEqual(["1", "2026-11-18 09:30:00+00", "admin_action", "s1", "Dara Kelly", "a.b", "organisation", "310", "Lakeside", "", "", "", "", "panel", "status;name", '{"status":"x"}', ""]);
    expect(auditCsv([]).split("\r\n")).toEqual([AUDIT_CSV_HEAD.map((h) => `"${h}"`).join(","), ""]);
  });
  it("doubles a quote and keeps a comma or a line break inside its cell", () => {
    const c = cells(auditCsv([row({ objectLabel: 'Say "hi", then\nleave' })]).split("\r\n")[1]!);
    expect(c[8]).toBe('Say "hi", then\nleave');
  });
  it("puts a quote mark in front of a cell a spreadsheet would run as a formula", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", '=HYPERLINK("http://x","y")']) expect(cells(auditCsv([row({ objectLabel: bad, actor: { staff: "s1", staffName: bad, candidate: null, portal: null, system: null } })]).split("\r\n")[1]!)[8], bad).toBe(`'${bad}`);
    for (const fine of ["a=b", "1-1", "x@y", " =x", "Lakeside"]) expect(cells(auditCsv([row({ objectLabel: fine })]).split("\r\n")[1]!)[8], fine).toBe(fine);
  });
});
