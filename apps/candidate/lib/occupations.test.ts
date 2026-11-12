import { describe, expect, it } from "vitest";
import { OCCUPATION_CODES } from "./occupations";

describe("the occupation codes a candidate may pick", () => {
  it("are the codes of both badge lists, all four digits", () => {
    expect(OCCUPATION_CODES.size).toBeGreaterThan(200);
    for (const c of OCCUPATION_CODES) expect(c).toMatch(/^\d{4}$/);
    expect(OCCUPATION_CODES.has("1122")).toBe(true); // a Critical Skills code
    expect(OCCUPATION_CODES.has("1225")).toBe(true); // an ineligible one
    expect(OCCUPATION_CODES.has("0000")).toBe(false);
  });
});
