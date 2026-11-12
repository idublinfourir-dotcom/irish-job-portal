import { describe, expect, it } from "vitest";
import { checkReport, MAX_EVIDENCE, REPORT_REASONS } from "./report";

const ok = { jobId: "123", reason: "other" };
describe("checkReport", () => {
  it("accepts every reason, with and without evidence", () => {
    for (const reason of REPORT_REASONS) expect(checkReport({ jobId: "9", reason })).toEqual({ jobId: "9", reason, evidence: null });
    expect(checkReport({ ...ok, evidence: "line one\n\tline two" })?.evidence).toBe("line one\n\tline two");
    expect(checkReport({ ...ok, evidence: "x".repeat(MAX_EVIDENCE) })).not.toBeNull();
  });
  it("refuses hostile bodies", () => {
    const bad: unknown[] = [
      null, undefined, "text", 5, [], [ok], {}, { jobId: "1" }, { reason: "other" },
      { ...ok, extra: 1 }, { ...ok, status: "upheld" }, { ...ok, reporter_portal_user_id: "x" },
      { ...ok, jobId: 123 }, { ...ok, jobId: "" }, { ...ok, jobId: "0x10" }, { ...ok, jobId: "-1" }, { ...ok, jobId: "1; drop table report" },
      { ...ok, jobId: "9223372036854775808" }, { ...ok, jobId: ["1"] }, { ...ok, jobId: null },
      { ...ok, reason: "spam" }, { ...ok, reason: 1 }, { ...ok, reason: null }, { ...ok, reason: ["other"] }, { ...ok, reason: "OTHER" },
      { ...ok, evidence: "" }, { ...ok, evidence: null }, { ...ok, evidence: 5 }, { ...ok, evidence: ["a"] }, { ...ok, evidence: { a: 1 } },
      { ...ok, evidence: "x".repeat(MAX_EVIDENCE + 1) },
      { ...ok, evidence: "a\u0000b" }, { ...ok, evidence: "a\rb" }, { ...ok, evidence: "a\u001bb" }, { ...ok, evidence: "a‮b" }, { ...ok, evidence: "a​b" },
    ];
    for (const b of bad) expect(checkReport(b), JSON.stringify(b)).toBeNull();
  });
  it("does not accept a polluted prototype key", () => {
    expect(checkReport(JSON.parse('{"jobId":"1","reason":"other","__proto__":{"a":1}}'))).toBeNull();
  });
});
