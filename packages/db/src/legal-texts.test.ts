// Unit tests (no database, network or browser) for R5's input checks (legal-texts.ts) and the site purposes of the public read (public-read.ts).
import { describe, expect, it } from "vitest";
import { isLegalPurpose, MAX_LEGAL_BODY, validLegalBody, validVersion } from "./legal-texts";
import { legalInForce, SITE_PURPOSES } from "./public-read";

describe("legal text input checks", () => {
  it("knows the six legal purposes only", () => {
    for (const p of ["signup_terms", "portal_signup_terms", "privacy_notice", "cookie_policy", "employer_acceptable_use", "data_retention"]) expect(isLegalPurpose(p)).toBe(true);
    for (const p of ["visibility", "pay_floor", "Signup_terms", "", null, 1, ["privacy_notice"]]) expect(isLegalPurpose(p)).toBe(false);
  });
  it("takes a short lower-case label, as the placeholder's", () => {
    for (const v of ["placeholder-2026-11-12", "v1", "2026.12.01", "a_b", "x".repeat(64)]) expect(validVersion(v), v).toBe(true);
    for (const v of ["", "V1", "-a", ".a", "_a", "a b", "a/b", "a\n", "x".repeat(65), "á", 1, null]) expect(validVersion(v), String(v)).toBe(false);
  });
  it("takes plain text with line breaks and tabs, refuses blank, too long, control and format characters", () => {
    for (const b of ["x", "Line 1\nLine 2\r\n\tTabbed", "Fadas: á é í ó ú", "x".repeat(MAX_LEGAL_BODY)]) expect(validLegalBody(b)).toBe(true);
    for (const b of ["", " ", "\n\t", "a\u0000", "a\u001b[31m", "a\u007f", "a\u0085", "a‮", "a⁦", "a​", "a‍", "a؜", "a﻿", "x".repeat(MAX_LEGAL_BODY + 1), 5, null, {}])
      expect(validLegalBody(b), JSON.stringify(b)).toBe(false);
  });
});

describe("the public read's purposes", () => {
  it("each site shows its own terms and the shared texts (privacy, cookies, employer acceptable use, data retention), never the other site's terms", () => {
    const shared = ["privacy_notice", "cookie_policy", "employer_acceptable_use", "data_retention"];
    expect(SITE_PURPOSES).toEqual({ candidate: ["signup_terms", ...shared], portal: ["portal_signup_terms", ...shared] });
  });
  it("refuses another purpose before any query", async () => {
    const db = { query: () => { throw new Error("no query expected"); } } as never;
    for (const [site, p] of [["candidate", "portal_signup_terms"], ["portal", "signup_terms"], ["candidate", null], ["portal", "visibility"]] as const)
      await expect(legalInForce(db, site, p)).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });
});
