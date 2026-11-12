// The rules route's body check and refusal map. No database.
import { StaffRefused } from "@portal/auth";
import { QueueRefused } from "@portal/db";
import { describe, expect, it, vi } from "vitest";
import { BadRequest } from "./account-review";
import { checkLength, MAX_BODY, parseBody, refuse } from "./rules";

const why = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof BadRequest ? e.message : "other"; } return "ok"; };
const body = (b: unknown) => why(() => parseBody(typeof b === "string" ? b : JSON.stringify(b)));

describe("parseBody", () => {
  it("accepts each action with exactly its fields", () => {
    expect(body({ action: "propose", kind: "minimums", effectiveFrom: "2027-01-01", data: {} })).toBe("ok");
    expect(body({ action: "propose_flag", organisationId: "12" })).toBe("ok");
    for (const action of ["confirm", "refuse", "withdraw"]) expect(body({ action, requestId: "12" }), action).toBe("ok");
  });
  it("refuses hostile bodies", () => {
    for (const b of ["", "x", "null", "[]", "1", '"confirm"', "{", "x".repeat(MAX_BODY + 1)]) expect(body(b), b.slice(0, 10)).toBe("bad_body");
    for (const a of ["drop", "toString", "__proto__", "constructor", "", null, 5]) expect(body({ action: a, requestId: "1" }), String(a)).toBe("bad_action");
    expect(body({ action: "confirm" })).toBe("bad_body");
    expect(body({ action: "confirm", requestId: "1", status: "confirmed" })).toBe("bad_body");
    expect(body({ action: "propose_flag", organisationId: "1", requestId: "1" })).toBe("bad_body");
    expect(body({ action: "propose", kind: "minimums", effectiveFrom: "2027-01-01" })).toBe("bad_body");
    expect(body({ action: "propose", kind: 5, effectiveFrom: "2027-01-01", data: {} })).toBe("bad_body");
    for (const id of ["0", "01", "-1", "1.5", "1e3", "12345678901234567890", " 1", "1;2", "", 1, null]) expect(body({ action: "refuse", requestId: id }), String(id)).toBe("bad_id");
  });
  it("refuses a long content-length before reading", () => {
    expect(() => checkLength(String(MAX_BODY + 1))).toThrow(BadRequest);
    expect(() => checkLength(null)).not.toThrow();
  });
});

describe("refuse", () => {
  const out = async (e: unknown) => { const r = refuse(e); return [r.status, await r.json()]; };
  it("maps the codes the database calls raise, and says which entry is bad", async () => {
    expect(await out(new QueueRefused("not_administrator"))).toEqual([403, { error: "not_administrator" }]);
    expect(await out(new QueueRefused("same_person"))).toEqual([409, { error: "same_person" }]);
    expect(await out(new QueueRefused("bad_data", "minimums: x"))).toEqual([400, { error: "bad_data", detail: "minimums: x" }]);
    expect(await out(new BadRequest("bad_origin"))).toEqual([403, { error: "bad_origin" }]);
    expect(await out(new StaffRefused("not_active"))).toEqual([401, { error: "not_active" }]);
  });
  it("answers an unknown failure with a plain 500 and keeps the detail out of the reply", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await out(new Error("password=secret"))).toEqual([500, { error: "server_error" }]);
    expect(await out(new QueueRefused("made_up_code"))).toEqual([500, { error: "server_error" }]);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
