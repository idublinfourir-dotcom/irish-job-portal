import { describe, expect, test } from "vitest";
import { checkSalary, readSalary, salaryStage } from "./index";

const sal = (d: string, box = "") => readSalary(d, box);

describe("R12 readSalary: what it reads", () => {
  test.each([
    ["Salary: €45,000 - €55,000", 45000, 55000],
    ["€50k", 50000, 50000],
    ["€ 62.5k to €70k", 62500, 70000],
    ["€45.5k", 45500, 45500],
    ["45.000 EUR", 45000, 45000],
    ["50,000 EUR", 50000, 50000],
    ["€50 000,00", 50000, 50000],
    ["€45,000 per annum", 45000, 45000],
    ["€14,999 and €15,000", 15000, 15000],
    ["€50,000 and then €80,000 later", 50000, 80000],
    ["Salary €45,000 plus bonus €50,000", 45000, 50000],
  ])("%j gives %d to %d", (text, low, high) => {
    expect(sal(text)).toEqual({ low, high });
  });
  test("the benefit box is read first, then the description", () => {
    expect(sal("x", "€48,000")).toEqual({ low: 48000, high: 48000 });
    expect(sal("salary 52,000 euro", "€10,000")).toEqual({ low: 52000, high: 52000 });
  });
  test("the high is the largest amount within 80 characters of the first, not further", () => {
    expect(sal("€50,000 " + "x".repeat(100) + " €90,000")).toEqual({ low: 50000, high: 50000 });
  });
  test("reads Arabic-Indic digits as Python does", () => {
    expect(sal("€٥٠٠٠٠")).toEqual({ low: 50000, high: 50000 });
  });
});

describe("R12 readSalary: what it skips", () => {
  test.each([
    ["Revenue €350m and €400 million"],
    ["€45,000 bonus"],
    ["€500 per day"],
    ["€3,000 per day"],
    ["€12,000 salary"],
    ["€450000"],
    ["£50,000"],
    ["€5K"],
    ["€1,234,567.89"],
    [""],
  ])("%j gives nothing", (text) => {
    expect(sal(text)).toEqual({ low: null, high: null });
  });
});

describe("R12 readSalary: known quirks", () => {
  test("known quirk F1: hourly pay is never read (the amount pattern needs 4 digits, a k or thousands)", () => {
    expect(sal("Pay €21.00 per hour")).toEqual({ low: null, high: null });
    expect(sal("Pay €17.40 per Hour")).toEqual({ low: null, high: null });
  });
  test("a yearly slash form is pay, not a revenue figure (NEW BEHAVIOUR, 10 Nov 2026; the Python skipped these)", () => {
    expect(sal("€50,000/year")).toEqual({ low: 50000, high: 50000 });
    expect(sal("€50,000 / year")).toEqual({ low: 50000, high: 50000 });
    expect(sal("€50,000 - €60,000 / year")).toEqual({ low: 50000, high: 60000 });
  });
  test("known quirk F2: an amount followed by any other '/' is still skipped", () => {
    expect(sal("€50,000/employee")).toEqual({ low: null, high: null });
    expect(sal("€50,000 / yrs-ago")).toEqual({ low: null, high: null });
    expect(sal("€50,000/")).toEqual({ low: null, high: null });
  });
  test("known quirk F4: slash-separated country ranges lose the first figure", () => {
    expect(sal("Ireland €50,000 / Poland €30,000 / Germany €60,000")).toEqual({ low: 60000, high: 60000 });
  });
  test("known quirk F5: a narrow no-break space (U+202F) works as a thousands separator", () => {
    expect(sal("50 000 EUR")).toEqual({ low: 50000, high: 50000 });
    expect(sal("€40 904")).toEqual({ low: 40904, high: 40904 });
  });
});

describe("R12 readSalary: salary box with yearly slash forms", () => {
  test.each([
    ["€80,000.00/yr - €90,000.00/yr", 80000, 90000],
    ["\u20ac80,000/YEAR", 80000, 80000],
    ["€80,000 / annum", 80000, 80000],
    ["€80,000/yearly", 80000, 80000],
    ["€80,000/annually", 80000, 80000],
    ["€80,000/pa", 80000, 80000],
  ])("%j", (box, low, high) => {
    expect(readSalary("", box)).toEqual({ low, high });
  });
  test("hourly and daily forms stay hourly and daily", () => {
    expect(readSalary("", "€500/day")).toEqual({ low: null, high: null });
    expect(readSalary("", "€150/hr")).toEqual({ low: null, high: null });
    expect(readSalary("", "€50,000/hr")).toEqual({ low: null, high: null });
  });
  test("revenue figures are still dropped", () => {
    expect(readSalary("Our revenue is €350m/yr and €2bn/year.")).toEqual({ low: null, high: null });
    expect(readSalary("Turnover €400 million / year")).toEqual({ low: null, high: null });
  });
  test("a word that only starts like a yearly form is not one", () => {
    expect(readSalary("", "€80,000/yrs")).toEqual({ low: null, high: null });
    expect(readSalary("", "€80,000/pat")).toEqual({ low: null, high: null });
    expect(readSalary("", "€80,000/yearbook")).toEqual({ low: null, high: null });
  });
});

describe("R13 checkSalary", () => {
  test("the four results", () => {
    expect(checkSalary(null, null, 40904)).toBe("not stated");
    expect(checkSalary(40904, 40904, 40904)).toBe("pass");
    expect(checkSalary(40903, 50000, 40904)).toBe("range crosses");
    expect(checkSalary(30000, 40903, 40904)).toBe("below");
    expect(checkSalary(30000, null, 40904)).toBe("below");
  });
  test("the minimum is a parameter (from the rules snapshot, #229)", () => {
    expect(checkSalary(45000, 45000, 50000)).toBe("below");
    expect(checkSalary(45000, 60000, 50000)).toBe("range crosses");
  });
});

describe("R13 salaryStage", () => {
  test("below, range crosses and pass do not depend on the flags", () => {
    for (const big of [false, true]) {
      for (const agency of [false, true]) {
        expect(salaryStage("below", big, agency)).toBe("8 salary below €40,904");
        expect(salaryStage("range crosses", big, agency)).toBe("8 range crosses €40,904 (no rule yet)");
        expect(salaryStage("pass", big, agency)).toBe("PASS (salary stated)");
      }
    }
  });
  test("no salary passes only for a big company that is not an agency", () => {
    expect(salaryStage("not stated", true, false)).toBe("PASS (big-company rule)");
    expect(salaryStage("not stated", true, true)).toBe("8 no salary, not a big company");
    expect(salaryStage("not stated", false, false)).toBe("8 no salary, not a big company");
    expect(salaryStage("not stated", false, true)).toBe("8 no salary, not a big company");
  });
});
