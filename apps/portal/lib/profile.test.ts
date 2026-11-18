// No database: the company profile body (P3), the close confirmation (P12) and the refusal codes. The owner checks and the work are the database's
// (migration 0031), tested in packages/db/test/company-profile.test.ts.
import { describe, expect, it } from "vitest";
import { checkClose, checkProfile, MAX_DESCRIPTION, profileRefusal } from "./profile";

const ok = { description: "We make fake widgets.\nTwo lines\tand a tab.", website: "https://fake-widgets.example.test/about", county: "Cork" };

describe("checkProfile", () => {
  it("takes the three fields, each a value or null", () => {
    expect(checkProfile(ok)).toEqual(ok);
    expect(checkProfile({ description: null, website: null, county: null })).toEqual({ description: null, website: null, county: null });
    expect(checkProfile({ ...ok, description: "   " })).toEqual({ ...ok, description: null }); // blank clears
    expect(checkProfile({ ...ok, description: "  x  " })!.description).toBe("x");
  });
  it("keeps a script in the description as plain text (the page escapes it)", () => {
    expect(checkProfile({ ...ok, description: "<script>alert(1)</script>" })!.description).toBe("<script>alert(1)</script>");
  });
  it("caps the description at 2,000 characters and refuses control and format characters", () => {
    expect(checkProfile({ ...ok, description: "a".repeat(MAX_DESCRIPTION) })).not.toBeNull();
    expect(checkProfile({ ...ok, description: "a".repeat(MAX_DESCRIPTION + 1) })).toBeNull();
    for (const d of ["a\u0000b", "a\u0007b", "a‮b", "a​b", 5, true, {}]) expect(checkProfile({ ...ok, description: d }), String(d)).toBeNull();
  });
  it("takes only an https website with a host, no credentials", () => {
    for (const w of ["http://fake.example.test", "javascript:alert(1)", "data:text/html,x", "https://localhost", "https://user:pw@fake.example.test", "ftp://fake.example.test",
      "fake.example.test", "https://fake.example.test/\u0000", "", 7, `https://${"a".repeat(500)}.test`]) expect(checkProfile({ ...ok, website: w }), String(w)).toBeNull();
  });
  it("takes a county from the 26 only, spelt exactly", () => {
    for (const c of ["cork", "Belfast", "Co. Cork", "", 1]) expect(checkProfile({ ...ok, county: c }), String(c)).toBeNull();
    expect(checkProfile({ ...ok, county: "Tipperary" })!.county).toBe("Tipperary");
  });
  it("refuses a missing field and every field that must not change here", () => {
    expect(checkProfile({ description: null, website: null })).toBeNull();
    for (const k of ["displayName", "name", "croNumber", "status", "slug", "verifiedAt", "memberLimit", "logoKey"]) expect(checkProfile({ ...ok, [k]: "x" }), k).toBeNull();
    for (const b of [null, [], "x", 1]) expect(checkProfile(b)).toBeNull();
  });
});

describe("checkClose", () => {
  it("takes the typed name, trimmed", () => {
    expect(checkClose({ confirmName: "  Fake Widgets Limited " })).toEqual({ confirmName: "Fake Widgets Limited" });
  });
  it("refuses an empty, long or odd name and any other field", () => {
    for (const n of ["", "   ", "x".repeat(161), "Fake‮", "a\nb", 1, null]) expect(checkClose({ confirmName: n }), String(n)).toBeNull();
    expect(checkClose({ confirmName: "Fake", force: true })).toBeNull();
    expect(checkClose({})).toBeNull();
  });
});

describe("profileRefusal", () => {
  const p = (message: string) => ({ code: "P0001", message });
  it("maps the database's codes and fails closed on any other", () => {
    expect(profileRefusal(p("team refused: NOT_OWNER only the account owner manages the team"))).toEqual({ status: 403, code: "NOT_OWNER" });
    expect(profileRefusal(p("company refused: NAME_MISMATCH"))).toEqual({ status: 400, code: "NAME_MISMATCH" });
    expect(profileRefusal(p("company refused: ORGANISATION_NOT_AVAILABLE"))).toEqual({ status: 409, code: "ORGANISATION_NOT_AVAILABLE" });
    expect(profileRefusal(p("team refused: REFUSED blocked"))).toEqual({ status: 403, code: "REFUSED" });
    expect(profileRefusal(p("something else"))).toEqual({ status: 403, code: "REFUSED" });
    expect(profileRefusal({ code: "23505" })).toBeNull();
    expect(profileRefusal(new Error("x"))).toBeNull();
  });
});
