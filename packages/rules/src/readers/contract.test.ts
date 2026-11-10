import { describe, expect, test } from "vitest";
import { readContract } from "./index";

describe("R09 readContract: months stated", () => {
  test("under 24 months is short", () => {
    expect(readContract("Engineer", "", "This is a 6 month contract")).toEqual({ result: "short", reason: "6 months" });
    expect(readContract("E", "", "23 mths role")).toEqual({ result: "short", reason: "23 months" });
    expect(readContract("E", "", "fixed term 12 months")).toEqual({ result: "short", reason: "12 months" });
  });
  test("24 months or more is ok", () => {
    expect(readContract("E", "", "24 months contract")).toEqual({ result: "ok", reason: "24 months" });
    expect(readContract("E", "", "a 36-month fixed term")).toEqual({ result: "ok", reason: "36 months" });
  });
  test("known quirk: the second form 'contract ... 6 months' is read (the old group number crashed here)", () => {
    expect(readContract("E", "", "Contract for 6 months")).toEqual({ result: "short", reason: "6 months" });
  });
  test("known quirk: '1 year contract role' is ok because years are not parsed (D8)", () => {
    expect(readContract("E", "", "1 year contract role")).toEqual({ result: "ok", reason: "permanent or not stated" });
  });
  test("a sentence end between the number and the word hides it", () => {
    expect(readContract("E", "", "6 months. contract").result).toBe("ok");
    expect(readContract("E", "", "contract.  6 months").result).toBe("ok");
    expect(readContract("E", "", "6 monthsx contract").result).toBe("ok");
  });
  test("reads the title and only the first 6,000 characters of the description", () => {
    expect(readContract("6 month contract", "", "x").result).toBe("short");
    expect(readContract("E", "", "x".repeat(6000) + " 6 month contract").result).toBe("ok");
  });
  test("counts code points, not UTF-16 units, when it cuts at 6,000", () => {
    expect(readContract("E", "", "\u{1F600}".repeat(3000) + " 6 month contract").result).toBe("short");
  });
  test("reads Arabic-Indic digits as Python does", () => {
    expect(readContract("E", "", "٦ month contract")).toEqual({ result: "short", reason: "6 months" });
  });
});

describe("R09 readContract: employment type, title and phrases", () => {
  test("a temporary, intern or seasonal type is short, with the type as the reason", () => {
    expect(readContract("E", "Temporary", "x")).toEqual({ result: "short", reason: "Temporary" });
    expect(readContract("E", "Intern Programme", "x")).toEqual({ result: "short", reason: "Intern Programme" });
    expect(readContract("E", "SEASONAL", "x")).toEqual({ result: "short", reason: "SEASONAL" });
  });
  test("a contract type or a temporary word in the title is unclear", () => {
    expect(readContract("E", "Full time contract", "x")).toEqual({ result: "unclear", reason: "Full time contract" });
    expect(readContract("Temp engineer", "", "x")).toEqual({ result: "unclear", reason: "title" });
    expect(readContract("Locum doctor", null, "x")).toEqual({ result: "unclear", reason: "title" });
  });
  test("a contract phrase in the description is unclear, with the phrase as the reason", () => {
    expect(readContract("E", "", "a fixed term contract here")).toEqual({ result: "unclear", reason: "fixed term contract" });
    expect(readContract("E", "", "This role is a CONTRACT")).toEqual({ result: "unclear", reason: "This role is a CONTRACT" });
  });
  test("nothing stated is ok", () => {
    expect(readContract("E", null, "nothing")).toEqual({ result: "ok", reason: "permanent or not stated" });
    expect(readContract("E", undefined, "")).toEqual({ result: "ok", reason: "permanent or not stated" });
  });
});
