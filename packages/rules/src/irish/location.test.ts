import { describe, expect, it } from "vitest";
import { locationIsIrelandOnly, locationLooksIrish, postBasedElsewhere } from "./location";

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

// Decision #149: Ireland only. Made-up locations in the shapes the adverts use.
describe("locationIsIrelandOnly (#149)", () => {
  it.each([
    "Dublin",
    "Dublin 2, Ireland / Dublin 18, Ireland",
    "Sligo / Cootehill",
    "Ireland - Clonmel / Ireland - Donegal Town",
    "Remote, Ireland",
    "Ireland, Limerick / Ireland, Cork",
    "Virginia, County Cavan, Ireland",
    "Dún Laoghaire-Rathdown, Ireland",
    "Carrick-on-Shannon, Ireland",
  ])("Irish only: %s", (loc) => {
    expect(locationIsIrelandOnly(loc)).toBe(true);
  });
  it.each([
    "Dublin or London",
    "Dublin, Ireland; London, England",
    "Cork, Ireland / Quincy, Massachusetts",
    "USA, GA, Atlanta / Ireland, Dublin",
    "Eindhoven,NLD / Dublin,IRL / Munich,DEU",
    "Ireland, Dublin / Germany, Berlin",
    "Dublin, Ireland / Remote, France",
    "Dublin OR London",
    "Dublin, Ireland / Toronto, Ontario",
    "IRL.Dublin.Dockline / France, Paris",
  ])("Irish plus foreign: %s", (loc) => {
    expect(locationIsIrelandOnly(loc)).toBe(false);
  });
  it.each(["London", "Paris, France", "Remote", "Remote, United Kingdom"])("foreign only: %s", (loc) => {
    expect(locationIsIrelandOnly(loc)).toBe(false);
  });
  it.each(["Belfast", "Derry", "Newry, Ireland", "Northern Ireland", "Belfast, Northern Ireland", "Dublin / NI", "Dublin or Belfast", "Armagh, Ireland"])(
    "Northern Ireland is the UK: %s",
    (loc) => {
      expect(locationIsIrelandOnly(loc)).toBe(false);
    },
  );
  it("empty is no", () => {
    expect(locationIsIrelandOnly("")).toBe(false);
  });
  it("a country code counts only straight after a comma, so plain words are safe", () => {
    expect(locationIsIrelandOnly("Dublin, Canada Quay")).toBe(false); // "canada" is a name
    expect(locationIsIrelandOnly("Dublin, Ireland, can work")).toBe(true);
    expect(locationIsIrelandOnly("Dublin, Ireland ita")).toBe(true);
  });
  it("a name inside a longer word does not count", () => {
    expect(locationIsIrelandOnly("Dublin, Londonbridge Road")).toBe(true);
    expect(locationIsIrelandOnly("Dublin, Spainsville")).toBe(true);
  });
});

describe("postBasedElsewhere (#149)", () => {
  it.each([
    "This role can be based in Dublin or London office locations.",
    "THIS ROLE CAN BE BASED IN DUBLIN OR LONDON CORPORATE OFFICE LOCATIONS",
    "This role is located in Dublin, Ireland or London, United Kingdom, or Berlin, Germany.",
    "The position may be based out of Cork or Paris.",
  ])("says the post can be elsewhere: %s", (t) => {
    expect(postBasedElsewhere(t)).toBe(true);
  });
  it.each([
    "",
    "We have offices in London and Dublin.",
    "We have teams across Europe.",
    "You will travel to London twice a year.",
    "This role is based in Dublin and reports to a manager in London.",
    "This role can be based in Dublin or remotely within Ireland.",
    "This role can be based in our Cork or Dublin office. Our London office is separate.",
    "We are looking for candidates who are based in Dublin or London.",
  ])("ordinary sentences do not match: %s", (t) => {
    expect(postBasedElsewhere(t)).toBe(false);
  });
  it("can be called many times with the same answer (no leftover regex state)", () => {
    for (let k = 0; k < 3; k++) expect(postBasedElsewhere("This role can be based in Dublin or London.")).toBe(true);
  });
});

// NEW BEHAVIOUR (11 Nov 2026): a list on the next lines.
describe("postBasedElsewhere: a list on the next lines", () => {
  it.each([
    "This role can be based in any of the following offices: \nLONDON, PARIS, MADRID OR DUBLIN\nWe build things.",
    "This role is located in:\n  Dublin\n  Cork\n  Berlin, Germany\nAbout us",
    "The position may be based in the following locations:\r\nDublin\r\nParis\r\n",
    "The job can also be based at any of these sites:\nDublin\nBoston\n",
  ])("a place outside Ireland in the list: %j", (t) => {
    expect(postBasedElsewhere(t)).toBe(true);
  });
  it.each([
    "This role can be based in any of the following offices:\nDublin\nCork\nGalway",
    "This role can be based in any of the following offices:\n\nParis\n",
    "This role can be based in any of the following offices:\nDublin\nOur London office is a long way from here and does not matter to this role at all.",
    "This role can be based in any of the following offices:\nDublin\nCork\nGalway\nLimerick\nSligo\nKerry\nLondon",
    "This role can be based in the following offices: London",
    "We have offices in the following places:\nLondon\nDublin",
    "This role is based in Dublin.\nLondon\nParis",
  ])("not read as an elsewhere post: %j", (t) => {
    expect(postBasedElsewhere(t)).toBe(false);
  });
  it("can be called many times with the same answer", () => {
    for (let k = 0; k < 3; k++) expect(postBasedElsewhere("This role can be based in these offices:\nLondon\n")).toBe(true);
  });
});
