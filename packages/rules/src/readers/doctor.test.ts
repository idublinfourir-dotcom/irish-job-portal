import { describe, expect, test } from "vitest";
import { doctorGradeWithoutTwoYears, permanentOrSpecifiedPurpose } from "./index";

describe("R10 doctorGradeWithoutTwoYears", () => {
  test.each([
    ["Registrar", "12 months", true],
    ["Registrar", "2 year contract", false],
    ["SHO", "contract of three years", false],
    ["Fellowship", "post for 2-year term", false],
    ["Locum consultant", "fixed term 3 years", false],
    ["Registrar", "a 5 year post", false],
    ["Registrar", "a year contract", true],
    ["Nurse", "x", false],
    ["Consultant", "x", false],
    ["Non-consultant hospital doctor", "x", true],
    ["Fellow", "1 year contract", true],
  ])("title %j, description %j gives %j", (title, description, expected) => {
    expect(doctorGradeWithoutTwoYears(title, description)).toBe(expected);
  });
  test("known quirk: '2 years of experience' does not count as a stated term, so it queues", () => {
    expect(doctorGradeWithoutTwoYears("Registrar", "2 years of experience required")).toBe(true);
  });
  test("known quirk: 'term of four years' does not count (the word 'term' alone is not enough)", () => {
    expect(doctorGradeWithoutTwoYears("NCHD", "term of four years")).toBe(true);
  });
  test("only the first 6,000 characters of the description are read", () => {
    expect(doctorGradeWithoutTwoYears("Registrar", "x".repeat(6000) + " 2 year contract")).toBe(true);
  });
});

describe("R11 permanentOrSpecifiedPurpose", () => {
  test.each(["permanent / specified purpose", "Permanent or Temporary post", "fixed-term & permanent", "permanent and fixed", "specified purpose/permanent", "Permanent/Fixed term", "permanent  or  specified purpose"])(
    "true for %j",
    (text) => expect(permanentOrSpecifiedPurpose(text)).toBe(true),
  );
  test("false for a single word, the wrong order or text past 6,000 characters", () => {
    expect(permanentOrSpecifiedPurpose("permanent post")).toBe(false);
    expect(permanentOrSpecifiedPurpose("temporary permanent")).toBe(false);
    expect(permanentOrSpecifiedPurpose("x".repeat(6000) + "permanent or temporary")).toBe(false);
  });
});
