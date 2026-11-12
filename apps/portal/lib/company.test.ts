// No database: the body checks and the refusal codes of the claim and register POSTs.
import { describe, expect, it } from "vitest";
import { checkClaim, checkRegister, refusalFor } from "./company";

describe("checkClaim", () => {
  it("takes only a positive whole-number organisationId", () => {
    expect(checkClaim({ organisationId: 7 })).toEqual({ organisationId: 7 });
    for (const bad of [null, [], "7", 7, {}, { organisationId: "7" }, { organisationId: 0 }, { organisationId: -1 }, { organisationId: 1.5 }, { organisationId: 2 ** 53 },
      { organisationId: Infinity }, { organisationId: null }, { organisationId: [7] }, { organisationId: { id: 7 } }, { organisationId: "7; drop table organisation" }])
      expect(checkClaim(bad), JSON.stringify(bad)).toBeNull();
  });
  it("refuses any extra field, a portal user id above all", () => {
    for (const extra of [{ portalUserId: "someone" }, { portal_user_id: "x" }, { userId: "x" }, { status: "verified" }, JSON.parse('{"__proto__": {"x": 1}}')])
      expect(checkClaim({ organisationId: 7, ...extra }), JSON.stringify(extra)).toBeNull();
  });
});

describe("checkRegister", () => {
  const employer = { kind: "employer", displayName: "Fake Ltd", croNumber: "123456" };
  const agency = { kind: "agency", displayName: "Fake Agency", wrcLicenceNumber: "EA-1234" };
  it("takes an employer with a CRO number and an agency with a licence (and maybe a CRO number)", () => {
    expect(checkRegister(employer)).toEqual({ kind: "employer", displayName: "Fake Ltd", croNumber: "123456", wrcLicenceNumber: null });
    expect(checkRegister(agency)).toEqual({ kind: "agency", displayName: "Fake Agency", croNumber: null, wrcLicenceNumber: "EA-1234" });
    expect(checkRegister({ ...agency, croNumber: "99" })?.croNumber).toBe("99");
    expect(checkRegister({ ...employer, displayName: "  Ó Briain Teo  " })?.displayName).toBe("Ó Briain Teo");
  });
  it("writes each number one way: no leading zeros on a CRO number, an upper-case licence", () => {
    for (const [given, want] of [["0777001", "777001"], ["00000777", "777"], ["777001", "777001"], ["0", "0"], ["000", "0"], ["10", "10"], ["00123456", "123456"]])
      expect(checkRegister({ ...employer, croNumber: given })?.croNumber, given).toBe(want);
    expect(checkRegister({ ...agency, wrcLicenceNumber: "ea-0901" })?.wrcLicenceNumber).toBe("EA-0901");
    expect(checkRegister({ ...agency, wrcLicenceNumber: "Ea-0901x" })?.wrcLicenceNumber).toBe("EA-0901X");
    expect(checkRegister({ ...agency, croNumber: "0099" })?.croNumber).toBe("99"); // an agency's optional CRO number too
    // #210: the same cleaning as register_organisation: spaces and a leading IE on the CRO number; spaces, case and a missing EA on the licence
    for (const [given, want] of [["IE 777001", "777001"], ["ie0777001", "777001"], [" 777 001 ", "777001"], ["IE777001", "777001"], ["I E 123", "123"]])
      expect(checkRegister({ kind: "employer", displayName: "Fake Ltd", croNumber: given })?.croNumber, given).toBe(want);
    for (const [given, want] of [["ea 1234", "EA1234"], ["1234", "EA1234"], [" EA 0901 ", "EA0901"], ["EA 1", "EA1"]])
      expect(checkRegister({ ...agency, wrcLicenceNumber: given })?.wrcLicenceNumber, given).toBe(want);
    for (const bad of ["IE", "IEX123", "123456789", "IE IE 123"]) expect(checkRegister({ kind: "employer", displayName: "Fake Ltd", croNumber: bad }), bad).toBeNull();
    expect(checkRegister({ ...agency, croNumber: "0abc" })).toBeNull(); // still refused when not digits
  });
  it("refuses another kind, a missing or odd number, and the wrong number for the kind", () => {
    for (const bad of [
      { ...employer, kind: "public_body" }, { ...employer, kind: "EMPLOYER" }, { ...employer, kind: ["employer"] }, { displayName: "x", croNumber: "1" },
      { kind: "employer", displayName: "Fake Ltd" }, { ...employer, croNumber: 123456 }, { ...employer, croNumber: "12a" }, { ...employer, croNumber: "123456789" }, { ...employer, croNumber: "" },
      { ...employer, wrcLicenceNumber: "EA1" }, { kind: "agency", displayName: "Fake" }, { ...agency, wrcLicenceNumber: "x".repeat(21) },
      { ...agency, croNumber: "abc" }, { ...employer, croNumber: "1' or '1'='1" },
    ]) expect(checkRegister(bad), JSON.stringify(bad)).toBeNull();
  });
  it("refuses an empty, huge, symbol-only, nested or control-character name", () => {
    for (const displayName of ["", " ", "a", "x".repeat(161), "!!!", "日本", { name: "Fake" }, ["Fake"], 42, null, "Fake\u0000Ltd", "Fake\nLtd",
      "Fake\u202eLtd", "Fake\u200bLtd", "Fake\u200dLtd", "\u2066Fake Ltd", "Fake\ufeffLtd", "Fake\u00adLtd"])
      expect(checkRegister({ ...employer, displayName }), JSON.stringify(displayName)).toBeNull();
    expect(checkRegister({ ...employer, displayName: "Robert'); drop table organisation;--" })?.displayName).toBe("Robert'); drop table organisation;--");
  });
  it("refuses any extra field and any body that is not an object", () => {
    for (const bad of [{ ...employer, portalUserId: "x" }, { ...employer, status: "verified" }, { ...employer, signupPath: "admin" }, null, [employer], "employer", 1])
      expect(checkRegister(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("refusalFor", () => {
  const p = (message: string) => ({ code: "P0001", message });
  it("maps each refusal of the functions to its code", () => {
    expect(refusalFor(p("claim refused: email not verified"))).toEqual({ status: 403, code: "EMAIL_NOT_VERIFIED" });
    expect(refusalFor(p("sign-up refused: email not verified"))?.code).toBe("EMAIL_NOT_VERIFIED");
    expect(refusalFor(p("claim refused: organisation is not unclaimed"))).toEqual({ status: 409, code: "ORGANISATION_NOT_AVAILABLE" });
    expect(refusalFor(p("CRO number 123 already belongs to another organisation"))?.code).toBe("NUMBER_ALREADY_REGISTERED");
    expect(refusalFor({ code: "23505", constraint: "one_company_per_login" })).toEqual({ status: 409, code: "ALREADY_IN_A_COMPANY" });
    expect(refusalFor({ code: "23505", constraint: "one_owner_per_org" })?.code).toBe("ORGANISATION_NOT_AVAILABLE");
    expect(refusalFor({ code: "23505", constraint: "organisation_cro_unique" })?.code).toBe("NUMBER_ALREADY_REGISTERED");
    expect(refusalFor({ code: "23505", constraint: "organisation_wrc_unique" })?.code).toBe("NUMBER_ALREADY_REGISTERED");
  });
  it("gives a banned domain, a banned number and a blocked login the same generic code (#191), and so any other function refusal", () => {
    for (const m of ["claim refused: email domain is banned", "sign-up refused: email domain is banned", "claim refused: company number is banned",
      "sign-up refused: company number is banned", "claim refused: unknown, blocked or deleted login", "sign-up refused: kind must be employer or agency", "something new"])
      expect(refusalFor(p(m)), m).toEqual({ status: 403, code: "REFUSED" });
  });
  it("leaves every other error alone, so it is a 500 and not a quiet refusal", () => {
    for (const e of [{ code: "23505", constraint: "organisation_slug_key" }, { code: "42501" }, new Error("boom"), null, undefined]) expect(refusalFor(e)).toBeNull();
  });
});
