// No database: the body check of the answer POST and the cool-down refusal code of the claim POST.
import { describe, expect, it } from "vitest";
import { refusalFor } from "./company";
import { checkAnswer, NOTE_MAX } from "./review-answer";

describe("checkAnswer", () => {
  it("takes a trimmed plain-text note up to the cap, counting characters not bytes", () => {
    expect(checkAnswer({ note: "  Our CRO number is 123456.  " })).toEqual({ note: "Our CRO number is 123456." });
    expect(checkAnswer({ note: "x".repeat(NOTE_MAX) })).not.toBeNull();
    expect(checkAnswer({ note: "😀".repeat(NOTE_MAX) })).not.toBeNull(); // 1,000 characters, 2,000 UTF-16 units
    expect(checkAnswer({ note: "<b>Robert'); drop table organisation;--</b>" })?.note).toBe("<b>Robert'); drop table organisation;--</b>");
  });
  it("refuses empty, over-long, control or format characters, a non-string note, extra fields and non-objects", () => {
    const bad: unknown[] = [{ note: "" }, { note: "   " }, { note: "x".repeat(NOTE_MAX + 1) }, { note: "a\nb" }, { note: "a\tb" }, { note: "a\u0000b" }, { note: "a\u202eb" },
      { note: "a\u200bb" }, { note: "a\u2028b" }, { note: "a\u2029b" }, { note: "a\u00adb" }, { note: "a\u0085b" }, { note: 1 }, { note: ["a"] }, { note: { a: 1 } }, { note: null }, {},
      { note: "ok", organisationId: 1 }, { note: "ok", portalUserId: "x" }, JSON.parse('{"note":"ok","__proto__":{"x":1}}'), null, [], "note", 7];
    for (const b of bad) expect(checkAnswer(b), JSON.stringify(b)).toBeNull();
  });
});

describe("the cool-down refusal (#203)", () => {
  it("is its own code, and an unrelated refusal stays REFUSED", () => {
    const e = (message: string) => ({ code: "P0001", message });
    expect(refusalFor(e("claim refused: COOL_DOWN this login's claim of this company was rejected within 24 hours"))).toEqual({ status: 429, code: "CLAIM_COOL_DOWN" });
    expect(refusalFor(e("claim refused: company number is banned"))).toEqual({ status: 403, code: "REFUSED" });
  });
});
