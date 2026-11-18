// Unit tests for the account review route's pure parts: the body check, the Origin test and the refusal-to-status map. No database.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BadRequest, checkLength, checkOrigin, MAX_BODY, parseBody, statusFor } from "./account-review";

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BadRequest ? e.message : "other";
  }
  return "accepted";
};
const body = (o: unknown) => JSON.stringify(o);

describe("parseBody", () => {
  it("accepts each action with its own fields", () => {
    expect(parseBody(body({ action: "claim", itemId: "12" }))).toEqual({ action: "claim", itemId: "12" });
    expect(parseBody(body({ action: "release", itemId: "12" })).action).toBe("release");
    expect(parseBody(body({ action: "approve", itemId: "12", addDomain: true })).addDomain).toBe(true);
    expect(parseBody(body({ action: "ask_more", itemId: "12" })).reason).toBeUndefined();
    expect(parseBody(body({ action: "ask_more", itemId: "12", reason: "need_cro_proof" })).reason).toBe("need_cro_proof");
    expect(parseBody(body({ action: "ask_more", itemId: "12", question: "Please send your CRO letter." })).question).toBe("Please send your CRO letter.");
    for (const b of [{ action: "ask_more", itemId: "12", question: 5 }, { action: "reject", itemId: "12", reason: "nope", question: "x" }, { action: "approve", itemId: "12", question: "x" }])
      expect(code(() => parseBody(body(b))), JSON.stringify(b)).toBe("bad_body");
    expect(parseBody(body({ action: "ask_more", itemId: "12", question: "😀".repeat(1000) })).question).toHaveLength(2000); // the longest question fits the cap
    expect(parseBody(body({ action: "reject", itemId: "12", reason: "not_a_company" })).reason).toBe("not_a_company");
  });
  it("refuses text that is not a plain JSON object", () => {
    for (const t of ["", "not json", "null", "[]", '"claim"', "12", "true", '[{"action":"claim","itemId":"1"}]']) expect(code(() => parseBody(t)), t).toBe("bad_body");
  });
  it("refuses unknown fields, including prototype tricks", () => {
    expect(code(() => parseBody(body({ action: "claim", itemId: "1", staffId: "someone" })))).toBe("bad_body");
    expect(code(() => parseBody('{"action":"claim","itemId":"1","__proto__":{"x":1}}'))).toBe("bad_body");
    expect(code(() => parseBody('{"action":"claim","itemId":"1","constructor":1}'))).toBe("bad_body");
  });
  it("refuses a missing, unknown or non-string action", () => {
    for (const a of [undefined, "", "delete", "APPROVE", 1, null, ["approve"], { a: 1 }]) expect(code(() => parseBody(body({ action: a, itemId: "1" }))), String(a)).toBe("bad_action");
  });
  it("refuses an item id that is not a plain digit string", () => {
    for (const i of [undefined, 1, null, "", "-1", "1.5", "0x10", " 1", "1 ", "1; drop table review_item", "1' or '1'='1", "١٢", "1".repeat(20), ["1"], { id: 1 }])
      expect(code(() => parseBody(body({ action: "claim", itemId: i }))), String(i)).toBe("bad_item_id");
  });
  it("refuses addDomain and reason on the wrong action or with the wrong type", () => {
    expect(code(() => parseBody(body({ action: "approve", itemId: "1", addDomain: "yes" })))).toBe("bad_body");
    expect(code(() => parseBody(body({ action: "approve", itemId: "1", addDomain: 1 })))).toBe("bad_body");
    expect(code(() => parseBody(body({ action: "reject", itemId: "1", addDomain: true, reason: "x" })))).toBe("bad_body");
    expect(code(() => parseBody(body({ action: "approve", itemId: "1", reason: "fine" })))).toBe("bad_body");
    expect(code(() => parseBody(body({ action: "claim", itemId: "1", reason: "fine" })))).toBe("bad_body");
    expect(code(() => parseBody(body({ action: "reject", itemId: "1", reason: 5 })))).toBe("bad_body");
    expect(code(() => parseBody(body({ action: "ask_more", itemId: "1", reason: { a: 1 } })))).toBe("bad_body");
  });
  it("requires a reason to reject", () => {
    expect(code(() => parseBody(body({ action: "reject", itemId: "1" })))).toBe("bad_reason");
  });
  it("refuses a body over the size limit before parsing it", () => {
    expect(code(() => parseBody(body({ action: "claim", itemId: "1", pad: "x".repeat(MAX_BODY) })))).toBe("bad_body");
    expect(code(() => parseBody(" ".repeat(MAX_BODY + 1)))).toBe("bad_body");
  });
});

describe("checkLength", () => {
  it("refuses a content-length over the limit before the body is read, and lets a small, missing or odd one through", () => {
    for (const h of [String(MAX_BODY + 1), "999999999", "1e9"]) expect(code(() => checkLength(h)), h).toBe("bad_body");
    for (const h of [null, "", "0", "120", String(MAX_BODY), "abc"]) expect(code(() => checkLength(h)), String(h)).toBe("accepted");
  });
});

describe("checkOrigin", () => {
  const own = "https://admin.example.test";
  it("accepts only the admin app's own origin", () => {
    expect(code(() => checkOrigin(own, own))).toBe("accepted");
    for (const o of [null, "", "null", "https://evil.example.test", "http://admin.example.test", "https://admin.example.test:8443", "https://admin.example.test.evil.test", "https://admin.example.test/"])
      expect(code(() => checkOrigin(o, own)), String(o)).toBe("bad_origin");
  });
});

describe("statusFor", () => {
  it("maps refusals to 400, 401, 403, 404 or 409", () => {
    expect(statusFor("bad_body")).toBe(400);
    expect(statusFor("no_session")).toBe(401);
    expect(statusFor("not_active")).toBe(401);
    expect(statusFor("not_reviewer")).toBe(403);
    expect(statusFor("bad_origin")).toBe(403);
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("claimed_by_other")).toBe(409);
    expect(statusFor("free_email_domain")).toBe(409);
    expect(statusFor("has_permit_history")).toBe(409);
    expect(statusFor("domain_owned_by_other")).toBe(409);
    expect(statusFor("claimant_not_active")).toBe(409);
  });
  it("does not know a made-up code, so the route answers a plain 500", () => {
    expect(statusFor("db password is hunter2")).toBeNull();
    expect(statusFor("__proto__")).toBeNull();
    expect(statusFor("constructor")).toBeNull();
  });
  it("knows every code the database module can refuse with", () => {
    const src = readFileSync(new URL("../../../packages/db/src/account-review.ts", import.meta.url), "utf8");
    const codes = new Set([...src.matchAll(/QueueRefused\("([a-z_]+)"/g)].map((m) => m[1]!));
    expect(codes.size).toBeGreaterThan(10);
    for (const c of codes) expect(statusFor(c), c).not.toBeNull();
  });
});
