import { describe, expect, it } from "vitest";
import { checkIrishEmployer, type IrishCheckJob } from "./check";

const EN = "We are hiring and you will join our team for the role with us to build things of value. ";
const job = (o: Partial<IrishCheckJob> = {}): IrishCheckJob => ({ employer: "Acme", title: "Nurse", description: EN, location: "Dublin", ...o });
const run = (o: Partial<IrishCheckJob>, known = false) => checkIrishEmployer(job(o), known);

describe("checkIrishEmployer (R03), every branch", () => {
  it("location in Northern Ireland: not irish, even with an Irish employer", () => {
    expect(run({ location: "Belfast" }, true)).toEqual({ verdict: "not irish", reason: "location is in Northern Ireland (UK)" });
    expect(run({ location: "Derry City" })).toEqual({ verdict: "not irish", reason: "location is in Northern Ireland (UK)" });
  });
  it("garbled text: unsure", () => {
    const description = Array(60).fill("x").join(" ");
    expect(run({ description })).toEqual({ verdict: "unsure", reason: "advert text is garbled" });
  });
  it("strong foreign signs with no Irish text: not irish, first four only, sorted", () => {
    const description = EN + "NHS band 5 Belfast Derry Catalunya";
    expect(run({ description }).reason).toBe("strong foreign signs: band 5, belfast, catalunya, derry");
  });
  it("advert not in English counts as a strong sign", () => {
    const description = Array(60).fill("lorem ipsum dolor").join(" ");
    expect(run({ description })).toEqual({ verdict: "not irish", reason: "strong foreign signs: advert not in English" });
  });
  it("strong signs are ignored when the text has Irish details", () => {
    expect(run({ description: EN + "NHS style post, Dublin 4" }).verdict).toBe("irish");
  });
  it("known employer with an Irish place", () => {
    expect(run({}, true)).toEqual({ verdict: "irish", reason: "employer known in Ireland" });
  });
  it("known employer with an Irish detail in the text and a vague place", () => {
    expect(run({ location: "Somewhere", description: EN + "Stamp 4 holders" }, true).reason).toBe("employer known in Ireland");
  });
  it("known employer, location Ireland, no foreign signs", () => {
    expect(run({ location: "Ireland" }, true)).toEqual({ verdict: "irish", reason: "employer known in Ireland, location Ireland" });
  });
  it("known employer, location Ireland, but remote or a weak foreign sign: falls through to unsure", () => {
    expect(run({ location: "Remote, Ireland" }, true).verdict).toBe("unsure");
    expect(run({ location: "Ireland", description: EN + "pay in USD" }, true).verdict).toBe("unsure");
  });
  it("Irish town and Irish details", () => {
    expect(run({ description: EN + "Please hold a PRSI number" }).reason).toBe("Irish town and Irish details in the advert");
  });
  it("Irish town, no foreign signs", () => {
    expect(run({})).toEqual({ verdict: "irish", reason: "Irish town, no foreign signs (employer still to match)" });
  });
  it("Irish town but weak foreign signs", () => {
    expect(run({ description: EN + "salary £45,000 or $5000 in England" }).reason).toBe("Irish town but foreign signs: $5, england, £4");
  });
  it("vague location: unsure", () => {
    expect(run({ location: "Remote" })).toEqual({ verdict: "unsure", reason: "only a vague location" });
  });
  it("wrongly mapped places do not count as an Irish town", () => {
    expect(run({ location: "Hospital, Cork" }).reason).toBe("only a vague location");
    expect(run({ location: "  Ireland" }).reason).toBe("only a vague location");
  });
  it("the employer name and title are part of the evidence text", () => {
    expect(run({ employer: "HSE" }).reason).toBe("Irish town and Irish details in the advert");
    expect(run({ title: "Nurse, NHS Band 6" }).verdict).toBe("not irish");
  });
  it("empty fields do not throw", () => {
    expect(run({ employer: "", title: "", description: "", location: "" })).toEqual({ verdict: "unsure", reason: "only a vague location" });
  });
  it("keeps no state between calls", () => {
    const a = run({ description: EN + "NHS" });
    expect(run({ description: EN + "NHS" })).toEqual(a);
  });
});

describe("checkIrishEmployer (R03), known quirks", () => {
  it("known quirk: the text only needs a Dublin-style Irish detail to cancel strong foreign signs, so UK adverts with an Irish word pass", () => {
    expect(run({ description: EN + "NHS Band 6, Belfast, with an HSE partner" }).verdict).toBe("irish");
  });
  it("known quirk: a location containing derry is Northern Ireland even for Irish place names that start with derry", () => {
    expect(run({ location: "Derrybeg, Donegal" }).reason).toBe("location is in Northern Ireland (UK)");
  });
  it("known quirk: the lookbehind only excludes northern ireland with one plain space", () => {
    const d = EN + "Based in Northern  Ireland";
    expect(run({ description: d }).reason).toBe("Irish town and Irish details in the advert");
    expect(run({ description: EN + "Based in Northern Ireland" }).reason).toBe("strong foreign signs: northern ireland");
  });
  it("known quirk: Unicode word boundary, a letter after nhs hides the sign", () => {
    expect(run({ description: EN + "NHSé" }).verdict).toBe("irish");
    expect(run({ description: EN + "NHS" }).verdict).toBe("not irish");
  });
  it("known quirk: accented patterns, espana with a tilde matches, a combining tilde does not", () => {
    expect(run({ description: EN + "ESPAÑA" }).verdict).toBe("not irish");
    expect(run({ description: EN + "españa" }).verdict).toBe("irish");
  });
  it("known quirk: dotted and dotless capital I match i, as in Python", () => {
    expect(run({ description: EN + "Northern İreland" }).reason).toBe("strong foreign signs: northern i\u0307reland");
    expect(run({ location: "ırelanD" }, true).verdict).toBe("irish"); // the known employer + location Ireland rule
  });
  it("known quirk: eircodes need capital letters", () => {
    expect(run({ location: "Somewhere", description: EN + "D02 X285" }, true).reason).toBe("employer known in Ireland");
    expect(run({ location: "Somewhere", description: EN + "d02 x285" }, true).verdict).toBe("unsure");
  });
  it("known quirk: Unicode digits count as digits in currency and Dublin district patterns", () => {
    expect(run({ description: EN + "£ ٣" }).reason).toBe("Irish town but foreign signs: £ ٣");
    expect(run({ location: "Somewhere", description: EN + "Dublin ٣" }, true).reason).toBe("employer known in Ireland");
  });
  it("known quirk: words are split on Python whitespace, so a next-line mark (U+0085) separates words", () => {
    // 41 words joined by U+0085: Python sees 41 words, none English; a JS \s split would see one word and skip the test
    const description = Array(41).fill("xxxx").join("\x85");
    expect(run({ description }).reason).toBe("strong foreign signs: advert not in English");
  });
  it("known quirk: only the first 300 words are measured for garbled and English tests", () => {
    const description = Array(300).fill("the").join(" ") + " " + Array(300).fill("x").join(" ");
    expect(run({ description }).verdict).toBe("irish");
  });
});
