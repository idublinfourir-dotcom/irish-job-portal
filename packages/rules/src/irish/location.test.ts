import { describe, expect, it } from "vitest";
import { locationLooksIrish } from "./location";

describe("locationLooksIrish (R02)", () => {
  it.each(["Dublin", "cork city", "Remote, Ireland", "IRL", "Co. Mayo", "Bray", "Letterkenny, Donegal"])("accepts %s", (loc) => {
    expect(locationLooksIrish(loc)).toBe(true);
  });
  it.each(["", "London", "Remote", "Dublinesque", "Corkscrew", "Belfast", "Fingal"])("rejects %s", (loc) => {
    expect(locationLooksIrish(loc)).toBe(false);
  });
  it("known quirk: this list has irl and ireland but not fingal or dun laoghaire (the Irish check list is different)", () => {
    expect(locationLooksIrish("Fingal")).toBe(false);
    expect(locationLooksIrish("Dún Laoghaire")).toBe(false);
    expect(locationLooksIrish("IRL")).toBe(true);
  });
  it("known quirk: Northern Ireland counts as Irish here because it contains the word ireland", () => {
    expect(locationLooksIrish("Belfast, Northern Ireland")).toBe(true);
  });
  it("known quirk: Unicode word boundary, a letter with an accent next to the town keeps it from matching", () => {
    expect(locationLooksIrish("Corké")).toBe(false);
  });
  it("known quirk: dotless and dotted capital I match i, as in Python", () => {
    expect(locationLooksIrish("IRELAND".replace("I", "İ"))).toBe(true);
    expect(locationLooksIrish("ırelanD")).toBe(true);
  });
  it("can be called many times with the same answer (no leftover regex state)", () => {
    for (let k = 0; k < 3; k++) expect(locationLooksIrish("Dublin")).toBe(true);
  });
});
