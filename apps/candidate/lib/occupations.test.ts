import { describe, expect, it } from "vitest";
import { OCCUPATION_CODES } from "./occupations";

describe("the occupation codes a candidate may pick", () => {
  it("are every SOC 2010 unit group, so both badge lists and more, all four digits", () => {
    expect(OCCUPATION_CODES.size).toBe(369);
    for (const c of OCCUPATION_CODES) expect(c).toMatch(/^\d{4}$/);
    expect(OCCUPATION_CODES.has("1122")).toBe(true); // a Critical Skills code
    expect(OCCUPATION_CODES.has("1225")).toBe(true); // an ineligible one
    expect(OCCUPATION_CODES.has("3111")).toBe(true); // a SOC code on neither list
    for (const c of ["0000", "9999", "1110"]) expect(OCCUPATION_CODES.has(c)).toBe(false);
  });
});
