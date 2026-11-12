// The trust and safety route bodies and the refusal map. No database.
import { describe, expect, it } from "vitest";
import { BadRequest } from "./account-review";
import { CASE_ACTIONS, checkLength, MAX_BODY, parseBody, REPORT_ACTIONS, statusFor } from "./trust-safety";

const why = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BadRequest ? e.message : "other";
  }
  return "ok";
};
const report = (b: unknown) => why(() => parseBody(typeof b === "string" ? b : JSON.stringify(b), REPORT_ACTIONS));
const kase = (b: unknown) => why(() => parseBody(JSON.stringify(b), CASE_ACTIONS));

describe("report bodies", () => {
  it("accepts each action with exactly its fields", () => {
    expect(report({ action: "hide", reportId: "12" })).toBe("ok");
    expect(report({ action: "clear", reportId: "12" })).toBe("ok");
    expect(report({ action: "uphold", reportId: "12", caseKind: "false_claim", reasonCode: "false_sponsorship", noticeSummary: "The job said sponsor confirmed.\nIt was not." })).toBe("ok");
  });
  it("refuses hostile bodies", () => {
    for (const b of ["", "x", "null", "[]", "1", '"hide"', "{", JSON.stringify({ action: "hide", reportId: "1", ...{ ["__proto__"]: 1 } })]) expect(report(b), b).not.toBe("ok");
    expect(report({ action: "hide" })).toBe("bad_body");
    expect(report({ action: "hide", reportId: "1", extra: 1 })).toBe("bad_body");
    expect(report({ action: "hide", reportId: "1", caseKind: "false_claim" })).toBe("bad_body"); // a field of another action
    expect(report({ action: "drop", reportId: "1" })).toBe("bad_action");
    expect(report({ action: "toString", reportId: "1" })).toBe("bad_action");
    expect(report({ action: "constructor", reportId: "1" })).toBe("bad_action");
    for (const id of [1, "0", "-1", "01", "1.5", "1; drop table report", "99999999999999999999", null, true]) expect(report({ action: "hide", reportId: id }), String(id)).toBe("bad_id");
    expect(report({ action: "uphold", reportId: "1", caseKind: "False Claim", reasonCode: "x" })).toBe("bad_kind");
    expect(report({ action: "uphold", reportId: "1", caseKind: "false_claim", reasonCode: "x", noticeSummary: "a".repeat(1001) })).toBe("bad_summary");
    expect(report({ action: "uphold", reportId: "1", caseKind: "false_claim", reasonCode: "x", noticeSummary: "bad ‮ text" })).toBe("bad_summary");
    expect(report({ action: "uphold", reportId: "1", caseKind: "false_claim", reasonCode: "x", noticeSummary: "   " })).toBe("bad_summary");
    expect(report("x".repeat(MAX_BODY + 1))).toBe("bad_body");
  });
});

describe("case bodies", () => {
  it("accepts each action with exactly its fields", () => {
    expect(kase({ action: "open", organisationId: "3", caseKind: "instant_ban", reasonCode: "asks_for_money", jobId: "9" })).toBe("ok");
    expect(kase({ action: "record_reply", caseId: "3", text: "We did sponsor.", receivedAt: "2026-11-12T10:00:00Z" })).toBe("ok");
    expect(kase({ action: "record_appeal", caseId: "3", text: "Appeal", receivedAt: "2026-11-12T10:00:00.123+01:00" })).toBe("ok");
    expect(kase({ action: "decide", caseId: "3", outcome: "ban", conclusive: true })).toBe("ok");
    expect(kase({ action: "decide_appeal", caseId: "3", result: "overturned" })).toBe("ok");
    for (const a of ["notify", "confirm", "refuse", "propose_ban_lift", "mark_wrc"]) expect(kase({ action: a, caseId: "3" }), a).toBe("ok");
  });
  it("refuses hostile bodies", () => {
    expect(kase({ action: "decide", caseId: "3", outcome: "strike", conclusive: true })).toBe("bad_body"); // conclusive only with a ban
    expect(kase({ action: "decide", caseId: "3", outcome: "warn" })).toBe("bad_outcome");
    expect(kase({ action: "decide", caseId: "3", outcome: "ban", conclusive: "yes" })).toBe("bad_flag");
    expect(kase({ action: "decide_appeal", caseId: "3", result: "maybe" })).toBe("bad_result");
    expect(kase({ action: "record_reply", caseId: "3", text: "x", receivedAt: "yesterday" })).toBe("bad_time");
    expect(kase({ action: "record_reply", caseId: "3", text: "x", receivedAt: "2026-13-45T10:00:00Z" })).toBe("bad_time");
    expect(kase({ action: "record_reply", caseId: "3", text: "x", receivedAt: "2026-11-12T10:00:00" })).toBe("bad_time"); // no zone
    expect(kase({ action: "record_reply", caseId: "3", text: "a".repeat(5001), receivedAt: "2026-11-12T10:00:00Z" })).toBe("bad_text");
    expect(kase({ action: "record_reply", caseId: "3", text: "nul \u0000", receivedAt: "2026-11-12T10:00:00Z" })).toBe("bad_text");
    expect(kase({ action: "record_reply", caseId: "3", text: ["x"], receivedAt: "2026-11-12T10:00:00Z" })).toBe("bad_text");
    expect(kase({ action: "record_reply", caseId: "3", receivedAt: "2026-11-12T10:00:00Z" })).toBe("bad_body");
    expect(kase({ action: "open", organisationId: "3", caseKind: "instant_ban" })).toBe("bad_body");
  });
  it("checks the length header before the body is read", () => {
    expect(why(() => checkLength(String(MAX_BODY + 1)))).toBe("bad_body");
    expect(why(() => checkLength(null))).toBe("ok");
  });
});

describe("refusal codes", () => {
  it("maps each code to its status and unknown codes to null", () => {
    expect(statusFor("bad_body")).toBe(400);
    expect(statusFor("no_session")).toBe(401);
    expect(statusFor("not_trust_and_safety")).toBe(403);
    expect(statusFor("bad_origin")).toBe(403);
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("same_person")).toBe(409);
    expect(statusFor("reply_window_open")).toBe(409);
    expect(statusFor("not_reviewer")).toBeNull();
    expect(statusFor("toString")).toBeNull();
  });
});
