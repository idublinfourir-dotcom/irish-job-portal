import { describe, expect, it } from "vitest";
import lists from "../../fetcher/data/occupation-lists.json";
import soc from "../data/soc2010-unit-groups.json";
import { isSoc2010, SOC2010_CODES, socTitle } from "./soc";

describe("the SOC 2010 reader", () => {
  it("holds the 369 unit groups ONS counts, four digits each, with a title", () => {
    expect(SOC2010_CODES.size).toBe(369);
    for (const u of soc.unit_groups) { expect(u.code).toMatch(/^[1-9]\d{3}$/); expect(u.title.length).toBeGreaterThan(3); }
  });
  it("names its source and licence", () => {
    expect(soc.source).toMatch(/^https:\/\/www\.ons\.gov\.uk\/file\?uri=.*structuresoc2010/);
    expect(soc.licence).toMatch(/Open Government Licence v3\.0/);
    expect(soc.read_on).toBe("2026-11-13");
  });
  it("covers every code on the two occupation lists", () => {
    for (const e of lists) expect(SOC2010_CODES.has(e.code), `${e.id} ${e.code}`).toBe(true);
  });
  it("answers a title for a code and null for anything else", () => {
    expect(socTitle("1115")).toBe("Chief executives and senior officials");
    expect(socTitle("9999")).toBeNull();
  });
  it("refuses a code just outside the list, other shapes and hostile text", () => {
    for (const c of ["9999", "0000", "1110", "111", "11150", " 1115", "1115 ", "1115\n", "１１１５", "1; drop table job", "__proto__", "constructor", "", null, undefined, 1115, {}, ["1115"]])
      expect(isSoc2010(c), JSON.stringify(c)).toBe(false);
    expect(isSoc2010("1115")).toBe(true);
  });
  it("is a set lookup: 100,000 checks stay far inside the budget", () => {
    const t = performance.now();
    for (let i = 0; i < 100_000; i++) isSoc2010(i % 2 ? "9999" : "2136");
    expect(performance.now() - t).toBeLessThan(200); // measured about 3 ms; a scan of 369 would be about 100x slower
  });
});
