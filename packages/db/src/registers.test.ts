// Unit: the number and name rules the register check uses (no database). The same cases run against the SQL function in test/registers.test.ts.
import { describe, expect, it } from "vitest";
import { NAME_CASES } from "../test/registers-helpers";
import { guessCounty, isKeptStatus, normaliseCompanyName, normaliseCroNumber, normaliseLicenceNumber } from "./registers";

describe("normaliseCompanyName", () => {
  it.each(NAME_CASES)("%s -> %s", (typed, key) => expect(normaliseCompanyName(typed)).toBe(key));
  it("the register spelling and the typed spelling meet", () => expect(normaliseCompanyName("EXAMPLE TRADING LIMITED")).toBe(normaliseCompanyName("Example Trading Ltd")));
});
describe("numbers", () => {
  it.each([["0012345", "12345"], [" IE 123 456 ", "123456"], ["ie0042", "42"], ["000", "0"], ["123456", "123456"], ["12a", "12a"]])("CRO %s -> %s", (t, n) => expect(normaliseCroNumber(t)).toBe(n));
  it.each([["ea 4373", "EA4373"], ["4373", "EA4373"], ["EA4373", "EA4373"], [" ea  12 ", "EA12"], ["XY12", "XY12"]])("WRC %s -> %s", (t, n) => expect(normaliseLicenceNumber(t)).toBe(n));
});
describe("guessCounty", () => {
  it.each([[["1 Main Street", "Town", "Co. Cork", ""], "Cork"], [["1 Main Street", "DUBLIN 2"], "Dublin"], [["Unit 5", "County Kerry"], "Kerry"], [["Cork Street", "Dublin 8", ""], "Dublin"],
    [["Cork Street", "Somewhere"], null], [["", "", "", ""], null], [["Londonderry"], "Derry"]])("%j -> %s", (lines, county) => expect(guessCounty(lines as string[])).toBe(county));
});
describe("statuses", () => {
  it("keeps Normal (with or without the trailing space) and the three leaving statuses, nothing else", () => {
    for (const s of ["Normal", "Normal ", " Strike Off Listed", "Liquidation", "Examinership"]) expect(isKeptStatus(s)).toBe(true);
    for (const s of ["Dissolved", "Liquidation (UK)", "Liquidation stayed", "Administration", "Struck Off", "Ceased", "normal", ""]) expect(isKeptStatus(s)).toBe(false);
  });
});
