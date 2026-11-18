// Unit tests, no database: the notice page token round trip, the template and params of each account decision (N4), and the question check.
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { checkQuestion, decisionNotice, decodeReviewCursor, QUESTION_MAX } from "./account-review";
import { encodeNoticeCursor } from "./notices";

const why = (f: () => unknown) => { try { f(); return "accepted"; } catch (e) { return e instanceof QueueRefused ? e.why : "other"; } };

describe("notice page token", () => {
  it("round-trips the time text and id through the review queue's decoder", () => {
    const t = encodeNoticeCursor({ created_text: "2026-11-18 10:15:30.123456+00", id: "9223372036854775807" });
    expect(decodeReviewCursor(t)).toEqual(["2026-11-18 10:15:30.123456+00", "9223372036854775807"]);
  });
  it("refuses a huge, tampered or wrong-shaped token", () => {
    const bad = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const t of ["x".repeat(10_000), "not base64!", bad({ t: "yesterday", i: "1" }), bad({ t: "2026-11-18 10:15:30+00", i: "0" }), bad({ t: "2026-11-18 10:15:30+00", i: "1; drop" }), bad([1]), bad(null)])
      expect(why(() => decodeReviewCursor(t)), t.slice(0, 30)).toBe("bad_cursor");
  });
});

describe("decisionNotice", () => {
  it("picks one template per decision", () => {
    expect(decisionNotice("approved", "7", "approved").template).toBe("account_approved");
    expect(decisionNotice("needs_info", "7", "needs_info").template).toBe("account_needs_info");
    expect(decisionNotice("rejected", "7", "fake_company").template).toBe("account_rejected");
  });
  it("carries the company, the reason code for ask and reject, and the question for ask only", () => {
    expect(decisionNotice("approved", "7", "approved", "ignored").params).toEqual({ organisationId: "7" });
    expect(decisionNotice("needs_info", "7", "need_cro_proof", "Please send your CRO letter.").params).toEqual({ organisationId: "7", reason: "need_cro_proof", question: "Please send your CRO letter." });
    expect(decisionNotice("needs_info", "7", "needs_info").params).toEqual({ organisationId: "7", reason: "needs_info" });
    expect(decisionNotice("rejected", "7", "fake_company", "a staff note").params).toEqual({ organisationId: "7", reason: "fake_company" });
  });
});

describe("checkQuestion", () => {
  it("takes trimmed plain text up to the cap in characters, or nothing", () => {
    expect(checkQuestion(undefined)).toBeUndefined();
    expect(checkQuestion("  Please send your CRO letter.  ")).toBe("Please send your CRO letter.");
    expect(checkQuestion("😀".repeat(QUESTION_MAX))).toHaveLength(QUESTION_MAX * 2);
    expect(checkQuestion("<script>alert(1)</script>')--")).toBe("<script>alert(1)</script>')--"); // stored as text; a page shows it as text
  });
  it("refuses empty, over-long, control or format characters and non-strings", () => {
    for (const q of ["", "   ", "x".repeat(QUESTION_MAX + 1), "a\nb", "a\u0000b", "a‮b", "a​b", "a b", 5, null, ["a"], { a: 1 }])
      expect(why(() => checkQuestion(q)), JSON.stringify(q)?.slice(0, 20)).toBe("bad_question");
  });
});
