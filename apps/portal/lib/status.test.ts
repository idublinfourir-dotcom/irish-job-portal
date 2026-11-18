import { describe, expect, it } from "vitest";
import { checkStatus, statusRefusal } from "./status";

const good = { action: "reply", caseId: "5", text: "We did nothing wrong." };
describe("checkStatus", () => {
  it("accepts good bodies and trims the text", () => {
    expect(checkStatus(good)).toEqual(good);
    expect(checkStatus({ ...good, action: "appeal", text: "  a\nb\tc\r\n " })).toEqual({ action: "appeal", caseId: "5", text: "a\nb\tc" });
    expect(checkStatus({ ...good, text: "x".repeat(1800) })).not.toBeNull();
  });
  it.each([
    ["null", null], ["array", []], ["string", "x"], ["unknown field", { ...good, extra: 1 }], ["missing text", { action: "reply", caseId: "5" }],
    ["action decide", { ...good, action: "decide" }], ["action upper", { ...good, action: "Reply" }],
    ["caseId number", { ...good, caseId: 5 }], ["caseId 0", { ...good, caseId: "0" }], ["caseId leading zero", { ...good, caseId: "05" }], ["caseId too long", { ...good, caseId: "9".repeat(19) }], ["caseId negative", { ...good, caseId: -1 }],
    ["caseId float", { ...good, caseId: 1.5 }], ["caseId 1e30", { ...good, caseId: 1e30 }], ["caseId NaN", { ...good, caseId: NaN }],
    ["text number", { ...good, text: 5 }], ["empty", { ...good, text: "" }], ["spaces", { ...good, text: " \n\t " }],
    ["1801", { ...good, text: "x".repeat(1801) }], ["rtl override", { ...good, text: "a\u202eb" }], ["null char", { ...good, text: "a\u0000b" }],
    ["zero width", { ...good, text: "a\u200bb" }], ["bell", { ...good, text: "a\u0007b" }], ["del", { ...good, text: "a\u007fb" }],
  ])("refuses %s", (_n, b) => expect(checkStatus(b)).toBeNull());
});

describe("statusRefusal", () => {
  const e = (message: string, code = "P0001") => ({ code, message });
  it.each([["BAD_REQUEST", 400], ["BAD_TEXT", 400], ["REFUSED", 403], ["NOT_A_MEMBER", 403], ["NOT_OWNER", 403], ["CASE_NOT_FOUND", 404],
    ["ALREADY_REPLIED", 409], ["REPLY_CLOSED", 409], ["ALREADY_APPEALED", 409], ["APPEAL_CLOSED", 409]])("maps %s to %i", (c, s) =>
    expect(statusRefusal(e(`status refused: ${c} some detail`))).toEqual({ status: s, code: c }));
  it("falls back to REFUSED for an unknown code or odd message, and ignores other errors", () => {
    expect(statusRefusal(e("status refused: WHATEVER x"))).toEqual({ status: 403, code: "REFUSED" });
    expect(statusRefusal(e("something else"))).toEqual({ status: 403, code: "REFUSED" });
    expect(statusRefusal(e("status refused: NOT_OWNER", "23505"))).toBeNull();
    expect(statusRefusal(new Error("boom"))).toBeNull();
    expect(statusRefusal(undefined)).toBeNull();
  });
});
