// The pay floor check route's body check and refusal map. No database.
import { StaffRefused } from "@portal/auth";
import { QueueRefused } from "@portal/db";
import { describe, expect, it, vi } from "vitest";
import { BadRequest, checkLength, checkOrigin } from "./account-review";
import { MAX_BODY, parseBody, refuse } from "./pay-floors";

const why = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof BadRequest ? e.message : "other"; } return "ok"; };
const body = (b: unknown) => why(() => parseBody(typeof b === "string" ? b : JSON.stringify(b)));

describe("parseBody", () => {
  it("accepts each action with exactly its fields", () => {
    expect(body({ action: "propose", floorId: "12" })).toBe("ok");
    expect(body({ action: "confirm", floorId: "12" })).toBe("ok");
    expect(body({ action: "reject", floorId: "12", reason: "no_evidence" })).toBe("ok");
  });
  it("refuses hostile bodies", () => {
    for (const b of ["", "x", "null", "[]", "1", '"propose"', "{", "x".repeat(MAX_BODY + 1)]) expect(body(b), b).not.toBe("ok");
    expect(body({ action: "propose" })).toBe("bad_floor_id");
    expect(body({ action: "propose", floorId: 12 })).toBe("bad_floor_id"); // a number, not text
    for (const id of ["0", "01", "-1", "1.5", "1e3", "12345678901234567890", " 1", "1 ", "1;2", ""]) expect(body({ action: "confirm", floorId: id }), id).toBe("bad_floor_id");
    expect(body({ action: "drop", floorId: "1" })).toBe("bad_action");
    for (const a of ["toString", "constructor", "__proto__", "", null, 5]) expect(body({ action: a, floorId: "1" }), String(a)).toBe("bad_action");
    expect(body({ action: "propose", floorId: "1", extra: 1 })).toBe("bad_body");
    expect(body({ action: "propose", floorId: "1", status: "active" })).toBe("bad_body");
    expect(body({ action: "propose", floorId: "1", reason: "x" })).toBe("bad_reason"); // a reason belongs to reject only
    expect(body({ action: "confirm", floorId: "1", reason: "x" })).toBe("bad_reason");
    expect(body({ action: "reject", floorId: "1" })).toBe("bad_reason");
    for (const r of ["", "Bad", "has space", "1abc", "a;b", "a‮b", "a".repeat(64), 5, null]) expect(body({ action: "reject", floorId: "1", reason: r }), String(r)).toBe("bad_reason");
  });
});

describe("the route's shared checks", () => {
  it("refuses a missing or foreign Origin and a long content-length", () => {
    expect(() => checkOrigin(null, "http://a")).toThrow(BadRequest);
    expect(() => checkOrigin("http://evil", "http://a")).toThrow(BadRequest);
    expect(() => checkOrigin("http://a", "http://a")).not.toThrow();
    expect(() => checkLength("100000")).toThrow(BadRequest);
    expect(() => checkLength(null)).not.toThrow();
  });
});

describe("refuse", () => {
  const out = async (e: unknown) => { const r = refuse(e); return [r.status, (await r.json()).error]; };
  it("maps every code the database calls raise", async () => {
    expect(await out(new QueueRefused("not_administrator"))).toEqual([403, "not_administrator"]);
    expect(await out(new QueueRefused("not_rules_editor"))).toEqual([403, "not_rules_editor"]);
    expect(await out(new QueueRefused("same_person"))).toEqual([409, "same_person"]);
    expect(await out(new QueueRefused("floor_not_pending"))).toEqual([409, "floor_not_pending"]);
    expect(await out(new QueueRefused("not_found"))).toEqual([404, "not_found"]);
    expect(await out(new BadRequest("bad_origin"))).toEqual([403, "bad_origin"]);
    expect(await out(new StaffRefused("no_session"))).toEqual([401, "no_session"]);
  });
  it("answers an unknown failure with a plain 500 and keeps the detail out of the reply", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await out(new Error("password=secret"))).toEqual([500, "server_error"]);
    expect(await out(new QueueRefused("made_up_code"))).toEqual([500, "server_error"]);
    expect(await out("string")).toEqual([500, "server_error"]);
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });
});
