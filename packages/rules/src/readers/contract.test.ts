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

describe("R09 readContract: maternity cover is short (NEW BEHAVIOUR, 10 Nov 2026)", () => {
  test.each([
    ["This role provides maternity cover for a Project Manager.", "maternity cover"],
    ["Maternity leave cover for our Dublin office", "Maternity leave cover"],
    ["You will be covering a colleague on maternity leave", "covering a colleague on maternity leave"],
    ["Cover for the maternity leave of the team lead", "Cover for the maternity leave"],
    ["MATERNITY\u00a0COVER", "MATERNITY\u00a0COVER"],
  ])("%j", (text, reason) => {
    expect(readContract("Project Manager", "Full time", text)).toEqual({ result: "short", reason });
  });
  test("it is read in the title too, and wins over a permanent-looking employment type", () => {
    expect(readContract("Accountant (maternity cover)", "Full time", "x")).toEqual({ result: "short", reason: "maternity cover" });
  });
  test("a months figure is read first", () => {
    expect(readContract("E", "", "maternity cover, 6 month contract")).toEqual({ result: "short", reason: "6 months" });
  });
  test("other talk of maternity is not maternity cover", () => {
    expect(readContract("E", "", "We offer generous maternity leave and a pension.")).toEqual({ result: "ok", reason: "permanent or not stated" });
    expect(readContract("E", "", "Maternity pay is covered in full. Permanent role.")).toEqual({ result: "ok", reason: "permanent or not stated" });
    expect(readContract("E", "", "maternity coverage plan")).toEqual({ result: "ok", reason: "permanent or not stated" });
  });
  test("only the first 6,000 characters are read", () => {
    expect(readContract("E", "", "x".repeat(6000) + " maternity cover").result).toBe("ok");
  });
});

describe("R09 NEW BEHAVIOUR (11 Nov 2026): FTC, student placements and interns are short", () => {
  test.each([
    ["Engineer (12 month FTC)", "x", "12 months"],
    ["Engineer - 6 months FTC", "x", "6 months"],
    ["Engineer 12-month-FTC", "x", "12 months"],
    ["Engineer", "FTC for 9 months", "9 months"],
  ])("FTC with a length under 24 months: %j", (title, text, reason) => {
    expect(readContract(title, "Full time", text)).toEqual({ result: "short", reason });
  });
  test("FTC with 24 months or no length is not short", () => {
    expect(readContract("Engineer (24 month FTC)", "", "x").result).toBe("ok");
    expect(readContract("Engineer (FTC)", "", "x").result).toBe("ok");
    expect(readContract("E", "", "the FTCs of the world, 12 monthly reports").result).toBe("ok");
  });
  test.each([
    ["E", "Candidates should be 3rd Year Students with a dedicated Placement Program.", "3rd Year Students"],
    ["E", "Students with a dedicated Placement pursuing degrees", "dedicated Placement"],
    ["E", "Open to Second-Year students only", "Second-Year students"],
    ["E", "A student placement from January", "student placement"],
    ["E", "You are a placement student at a university", "placement student"],
    ["Software Engineer Intern", "x", "Intern"],
    ["2027 Cyber Internship (Dublin)", "x", "Internship"],
  ])("student placement or intern title: %j %j", (title, text, reason) => {
    expect(readContract(title, "Full time", text)).toEqual({ result: "short", reason });
  });
  test.each([
    ["Internal Auditor", "We run an internship programme and a graduate scheme."],
    ["International Sales Manager", "Our interns love us."],
    ["E", "Final year students may apply for the graduate programme."],
    ["E", "We offer placement services to clients and a dedicated team."],
    ["E", "Students of life are welcome"],
  ])("is not read as short: %j %j", (title, text) => {
    expect(readContract(title, "", text)).toEqual({ result: "ok", reason: "permanent or not stated" });
  });
  test("a months figure is read before the placement words", () => {
    expect(readContract("E", "", "6 month contract for a student placement")).toEqual({ result: "short", reason: "6 months" });
  });
});
