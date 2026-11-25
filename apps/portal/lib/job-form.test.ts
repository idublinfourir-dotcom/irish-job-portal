// Unit test of the #66 range note: the graduate minimum is filled in from the figure it is given, never typed in the wording.
import { describe, expect, it } from "vitest";
import { rangeNote } from "./job-form";

describe("rangeNote", () => {
  it("quotes the minimum it is given", () => {
    expect(rangeNote(36848)).toBe("Pay depends on where you start on the scale. Experienced candidates, and recent graduates (€36,848 minimum), usually qualify. Employer-paid health insurance also counts.");
    expect(rangeNote(37000)).toContain("(€37,000 minimum)");
    expect(rangeNote(37000)).not.toContain("36,848");
  });
});
