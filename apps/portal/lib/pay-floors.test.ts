// The pay floor route's body check. No database.
import { rulesV1 } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { checkFloor as checkWith } from "./pay-floors";

const lists = (await rulesV1()).occupationLists; // version 1, as the database holds it
const checkFloor = (b: unknown) => checkWith(b, lists);

const sign = { action: "sign", roleFamily: "2134", floorEur: 45000, consentTextId: "7" };

describe("checkFloor", () => {
  it("accepts a sign and a withdraw", () => {
    expect(checkFloor(sign)).toEqual({ action: "sign", roleFamily: "2134", floorEur: 45000, consentTextId: "7" });
    expect(checkFloor({ action: "withdraw", floorId: 3 })).toEqual({ action: "withdraw", floorId: 3 });
  });
  it("refuses anything else", () => {
    for (const b of [null, undefined, 5, "sign", [], {}, { action: "sign" }, { action: "approve", floorId: 1 }, { action: "activate", floorId: 1 }]) expect(checkFloor(b), JSON.stringify(b)).toBeNull();
  });
  it("refuses unknown fields: no organisation, status, signer or approval from the body", () => {
    for (const extra of [{ organisationId: 2 }, { status: "active" }, { signerMembershipId: 1 }, { approvalRequestId: 1 }, { validUntil: "2099-01-01" }, { __proto__: { x: 1 }, y: 1 }])
      expect(checkFloor({ ...sign, ...extra }), JSON.stringify(extra)).toBeNull();
    expect(checkFloor({ action: "withdraw", floorId: 3, status: "active" })).toBeNull();
    expect(checkFloor({ action: "withdraw", floorId: 3, organisationId: 2 })).toBeNull();
  });
  it("refuses a family on the Ineligible list, and lets one on both lists or on neither through (#231)", () => {
    expect(checkFloor({ ...sign, roleFamily: "1225" })).toBeNull(); // Ineligible only
    expect(checkFloor({ ...sign, roleFamily: "2229" })).not.toBeNull(); // on both lists: the Critical Skills entry stands (listAnswer)
    expect(checkFloor({ ...sign, roleFamily: "4000" })).not.toBeNull(); // on neither
  });
  it("refuses bad amounts, families and ids", () => {
    for (const eur of [0, -1, 1.5, "45000", null, Number.NaN, Infinity, 1_000_001, 1e21, [45000]]) expect(checkFloor({ ...sign, floorEur: eur }), String(eur)).toBeNull();
    for (const f of ["", " ", "x", 5, null, "chef", "Software Engineer", "213", "21345", " 2134", "2134‮", "21​34", "2134\u0000", "a".repeat(81)]) expect(checkFloor({ ...sign, roleFamily: f }), String(f)).toBeNull();
    for (const t of [7, "", "0", "07", "abc", "1;2", "1".repeat(19), null]) expect(checkFloor({ ...sign, consentTextId: t }), String(t)).toBeNull();
    for (const id of [0, -1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) expect(checkFloor({ action: "withdraw", floorId: id }), String(id)).toBeNull();
  });
});
