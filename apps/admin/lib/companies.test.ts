// The company routes' body checks and refusal map (step 13 part 13c). No database.
import { StaffRefused } from "@portal/auth";
import { QueueRefused } from "@portal/db";
import { describe, expect, it, vi } from "vitest";
import { BadRequest } from "./account-review";
import { validLimit } from "@portal/db";
import { checkLength, MAX_BODY, MAX_SMALL_BODY, parseLimit, parseManual, parseMerge, parseOwner, refuse, statusFor } from "./companies";

const why = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof BadRequest ? e.message : "other"; } return "ok"; };
const j = JSON.stringify;

describe("parseMerge", () => {
  it("accepts two plain ids and nothing else", () => {
    expect(parseMerge(j({ absorbedId: "12", survivorId: "34" }))).toEqual({ absorbedId: "12", survivorId: "34" });
    for (const b of ["", "x", "null", "[]", "1", "{", "x".repeat(MAX_SMALL_BODY + 1)]) expect(why(() => parseMerge(b)), b).toBe("bad_body");
    expect(why(() => parseMerge(j({ absorbedId: "1", survivorId: "2", extra: 1 })))).toBe("bad_body");
    for (const id of [1, "0", "01", "-1", "1.5", "1e3", " 1", "1 ", "1;2", "", null, "12345678901234567890"]) expect(why(() => parseMerge(j({ absorbedId: id, survivorId: "2" }))), String(id)).toBe("bad_input");
    expect(why(() => parseMerge(j({ absorbedId: "1" })))).toBe("bad_input");
  });
});
describe("parseLimit and validLimit (P13)", () => {
  it("takes the company id, a number and a reason, nothing else", () => {
    expect(parseLimit(j({ organisationId: "7", memberLimit: 20, reason: "growing_team" }))).toEqual({ organisationId: "7", memberLimit: 20, reason: "growing_team" });
    expect(why(() => parseLimit(j({ organisationId: "7", memberLimit: 20, reason: "x", extra: 1 })))).toBe("bad_body");
    expect(why(() => parseLimit(j({ organisationId: "7", memberLimit: "20", reason: "x" })))).toBe("bad_body");
    expect(why(() => parseLimit(j({ organisationId: "7", memberLimit: 20 })))).toBe("bad_body");
    expect(why(() => parseLimit(j({ organisationId: 7, memberLimit: 20, reason: "x" })))).toBe("bad_input");
    expect(why(() => parseLimit("x".repeat(MAX_SMALL_BODY + 1)))).toBe("bad_body");
  });
  it("bounds the limit from 1 to 50, whole numbers only", () => {
    for (const n of [1, 10, 50]) expect(validLimit(n), String(n)).toBe(true);
    for (const n of [0, -1, 51, 1.5, NaN, Infinity, "10", null]) expect(validLimit(n), String(n)).toBe(false);
  });
  it("maps the new codes", () => {
    expect(statusFor("not_limit_staff")).toBe(403);
    expect(statusFor("below_active")).toBe(409);
    expect(statusFor("bad_limit")).toBe(400);
  });
});
describe("parseOwner", () => {
  it("accepts each action with exactly its fields", () => {
    expect(parseOwner(j({ action: "request", membershipId: "5", domainChecked: true, croChecked: false }))).toEqual({ action: "request", membershipId: "5", domainChecked: true, croChecked: false });
    expect(parseOwner(j({ action: "complete", requestId: "5" }))).toEqual({ action: "complete", requestId: "5" });
    expect(parseOwner(j({ action: "cancel", requestId: "5" }))).toEqual({ action: "cancel", requestId: "5" });
  });
  it("refuses hostile bodies", () => {
    for (const a of ["drop", "toString", "__proto__", "", null, 5, undefined]) expect(why(() => parseOwner(j({ action: a, requestId: "1" }))), String(a)).toBe("bad_action");
    expect(why(() => parseOwner(j({ action: "request", membershipId: "5", domainChecked: true, croChecked: true, requestId: "1" })))).toBe("bad_body");
    expect(why(() => parseOwner(j({ action: "complete", requestId: "5", membershipId: "5" })))).toBe("bad_body");
    expect(why(() => parseOwner(j({ action: "request", membershipId: "5", domainChecked: "true", croChecked: true })))).toBe("bad_body");
    expect(why(() => parseOwner(j({ action: "request", membershipId: "5", domainChecked: true })))).toBe("bad_body");
    expect(why(() => parseOwner(j({ action: "request", membershipId: 5, domainChecked: true, croChecked: true })))).toBe("bad_input");
    expect(why(() => parseOwner(j({ action: "cancel", requestId: "0" })))).toBe("bad_input");
    expect(why(() => parseOwner("[]"))).toBe("bad_body");
  });
});
describe("parseManual", () => {
  it("create keeps the other fields for checkManualPost, close takes only a job id", () => {
    expect(parseManual(j({ action: "create", title: "x", organisationId: "1" }))).toEqual({ action: "create", post: { title: "x", organisationId: "1" } });
    expect(parseManual(j({ action: "close", jobId: "9" }))).toEqual({ action: "close", jobId: "9" });
    expect(why(() => parseManual(j({ action: "close", jobId: "9", extra: 1 })))).toBe("bad_body");
    expect(why(() => parseManual(j({ action: "close", jobId: "x" })))).toBe("bad_input");
    expect(why(() => parseManual(j({ action: "publish" })))).toBe("bad_action");
    expect(why(() => parseManual(j({ title: "x" })))).toBe("bad_action");
    expect(why(() => parseManual("x".repeat(MAX_BODY + 1)))).toBe("bad_body");
    expect(why(() => parseManual("null"))).toBe("bad_body");
  });
  it("a __proto__ key does not change the post's shape", () => {
    const b = parseManual('{"action":"create","__proto__":{"badge":"sponsor_confirmed"}}');
    expect(b).toMatchObject({ action: "create" });
    expect(Object.keys((b as { post: object }).post)).toEqual(["__proto__"]);
  });
});
describe("checkLength", () => {
  it("passes a missing or small header and refuses a big one", () => {
    expect(why(() => checkLength(null))).toBe("ok");
    expect(why(() => checkLength("abc"))).toBe("ok");
    expect(why(() => checkLength(String(MAX_BODY)))).toBe("ok");
    expect(why(() => checkLength(String(MAX_BODY + 1)))).toBe("bad_body");
    expect(why(() => checkLength("2000", MAX_SMALL_BODY))).toBe("bad_body");
  });
});
describe("refuse", () => {
  it("maps each known code to its status", async () => {
    for (const [code, status] of [["not_company_staff", 403], ["not_account_reviewer", 403], ["not_found", 404], ["already_merged", 409], ["too_early", 409], ["bad_title", 400], ["bad_origin", 403], ["same_company", 400],
      ["not_administrator", 403], ["not_sponsor_staff", 403], ["already_confirmed", 409], ["job_not_live", 409], ["company_restricted", 409], ["decision_pending", 409],
      ["request_not_pending", 409], ["same_person", 409], ["no_statement_text", 409], ["bad_file", 400], ["empty_file", 400], ["file_too_large", 413], ["wrong_file_type", 415]] as const) {
      expect(statusFor(code), code).toBe(status);
      const r = refuse(new QueueRefused(code), "t");
      expect([r.status, await r.json()]).toEqual([status, { error: code }]);
    }
    expect(refuse(new BadRequest("bad_origin"), "t").status).toBe(403);
    expect(refuse(new StaffRefused("no_session"), "t").status).toBe(401);
  });
  it("answers an unknown failure with a plain 500 and logs the reason, not in the reply", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = refuse(new Error("select * from secret"), "t");
    expect([r.status, await r.json()]).toEqual([500, { error: "server_error" }]);
    expect(refuse(new QueueRefused("made_up_code"), "t").status).toBe(500);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
