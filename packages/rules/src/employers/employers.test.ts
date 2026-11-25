import { describe, expect, it } from "vitest";
import { BIG_COMPANY_NAMES_V1 } from "../snapshot";
import { BIG_COMPANY_BRANDS, BIG_COMPANY_LIST_150, cleanEmployerName, isAgencyName, isBigCompany, nameTitlePlaceKey, publicPayTier, urlOrNameKey, HSE_ENTRY } from ".";

describe("cleanEmployerName (R15)", () => {
  it.each([
    ["Google Ireland Limited", "google"],
    ["The Dawn Meats Group Ltd.", "dawn meats"],
    ["Johnson & Johnson", "johnson and johnson"],
    ["Acme (Cork) Services", "acme"],
    ["  Acme   Care  ", "acme care"],
    ["Ltd", ""],
    ["", ""],
  ])("%s -> %s", (input, want) => expect(cleanEmployerName(input)).toBe(want));
  it("known quirk: differs from the database normalised_name, which keeps suffix words and the text in brackets", () => {
    expect(cleanEmployerName("Acme Group Ireland (Holdings) Ltd")).toBe("acme");
  });
  it("known quirk: brackets do not span a line break, and an unclosed bracket stays (its text is kept)", () => {
    expect(cleanEmployerName("Acme (a\nb) c")).toBe("acme a b c");
    expect(cleanEmployerName("Acme (unclosed")).toBe("acme unclosed");
  });
  it("known quirk: only \\n stops a bracket, so a carriage return or U+2028 inside brackets is removed with them", () => {
    expect(cleanEmployerName("Acme (a\rb) c")).toBe("acme c");
    expect(cleanEmployerName("Acme (a b) c")).toBe("acme c");
  });
  it("known quirk: letters outside a-z vanish, so accented names are cut", () => {
    expect(cleanEmployerName("Ünited Care")).toBe("nited care");
    expect(cleanEmployerName("İstanbul Ltd")).toBe("i stanbul");
  });
  it("known quirk: suffix words are removed inside a name, not only at the end", () => {
    expect(cleanEmployerName("Group Health Ireland Care")).toBe("health care");
  });
});

describe("isBigCompany (R15)", () => {
  it("has the 42 brands of the Python list", () => expect(BIG_COMPANY_BRANDS).toHaveLength(42));
  it.each(["Turner & Townsend", "Version 1", "Bon Secours Health System Ireland", "Bon Secours Hospital Cork", "Trinity Care (IRL)",
    "Mater Private Network", "PwC Ireland", "Affidea UK & Ireland", "Curam Care Homes Limited"])("#150: matches %s", (e) => expect(isBigCompany(e, BIG_COMPANY_NAMES_V1)).toBe(true));
  it.each(["Versional Ltd", "Turner Electrical", "Trinity College Dublin", "Mater Misericordiae University Hospital", "Enable Tech", "Boots Ireland"])(
    "#150: does not match %s", (e) => expect(isBigCompany(e, BIG_COMPANY_NAMES_V1)).toBe(false));
  it("#150: every listed name is already in cleaned form, so it can match", () =>
    expect(BIG_COMPANY_LIST_150.filter((b) => cleanEmployerName(b) !== b)).toEqual([]));
  it.each(["Google", "GOOGLE IRELAND LIMITED", "Meta Platforms Ireland", "Eli Lilly and Company", "J P Morgan", "Citi"])("matches %s", (e) =>
    expect(isBigCompany(e, BIG_COMPANY_NAMES_V1)).toBe(true),
  );
  it.each(["Metadata Ltd", "Intelligent Systems", "", "Nobody", "Bank of Citi"])("does not match %s", (e) => expect(isBigCompany(e, BIG_COMPANY_NAMES_V1)).toBe(false));
  it("known quirk: any name that starts with a brand word matches, even an unrelated or agency name", () => {
    expect(isBigCompany("Apple Hospitality Recruitment", BIG_COMPANY_NAMES_V1)).toBe(true);
    expect(isBigCompany("Oracle Care Home", BIG_COMPANY_NAMES_V1)).toBe(true);
  });
  it("known quirk: a brand with an accent is cut by the cleaning, so it no longer matches", () => {
    expect(isBigCompany("Ünited", BIG_COMPANY_NAMES_V1)).toBe(false);
  });
});

describe("isAgencyName (R16)", () => {
  it.each(["Hays Recruitment", "CPL Resources", "Nurse Finders", "Nursefinders", "Robert Walters", "ROBERT HALF"])("flags %s", (e) =>
    expect(isAgencyName(e)).toBe(true),
  );
  it.each(["Google", "", null, undefined])("does not flag %s", (e) => expect(isAgencyName(e)).toBe(false));
  it("known quirk: loose words flag ordinary employers (people, search, jobs, excel, lincoln, hire)", () => {
    for (const e of ["People Inc", "Search Engines Ltd", "Lincoln Hospital", "Excel Dental", "Hire Vehicles", "Careers Ireland"]) expect(isAgencyName(e)).toBe(true);
  });
  it("known quirk: dotless and dotted I match i, as in Python", () => {
    expect(isAgencyName("recruıt")).toBe(true); // dotless i
    expect(isAgencyName("sELECTİON")).toBe(true); // dotted capital I
  });
});

describe("publicPayTier (R17)", () => {
  const candidates = new Map<string, 1 | 2>([
    ["beaumont hospital", 2],
    ["children’s health ireland jobs", 2],
    [HSE_ENTRY, 1],
  ]);
  it("tier 1 for HSE names while the HSE entry is on the list", () => {
    for (const e of ["HSE", "hse west", "Health Service Executive", "  The HSE.  "]) expect(publicPayTier(e, candidates)).toBe(1);
  });
  it("the HSE switch off (#261): without the entry an HSE name is tier 0 like any employer, and the Section 38 names still match", () => {
    const off = new Map([...candidates].filter(([k]) => k !== HSE_ENTRY));
    for (const e of ["HSE", "hse west", "Health Service Executive", "  The HSE.  "]) expect(publicPayTier(e, off)).toBe(0);
    expect(publicPayTier("Beaumont Hospital", off)).toBe(2);
    expect(publicPayTier("HSE", new Map([["hse", 2]]))).toBe(2); // an exact list name still matches as any other
  });
  it("tier 2 for an exact lower-case candidate name, spaces around it ignored", () => {
    expect(publicPayTier(" Beaumont Hospital ", candidates)).toBe(2);
    expect(publicPayTier("Children’s Health Ireland Jobs", candidates)).toBe(2);
  });
  it("tier 0 otherwise", () => {
    for (const e of ["Beaumont Hospital Dublin", "Rehse Ltd", "", null, undefined]) expect(publicPayTier(e, candidates)).toBe(0);
  });
  it("known quirk: a curly and a straight apostrophe are different names", () => {
    expect(publicPayTier("Children's Health Ireland Jobs", candidates)).toBe(0);
  });
  it("#299: every name the HSE itself uses on live and in the frozen set is tier 1", () => {
    for (const e of ["HSE Mid West", "HSE Mid-West", "HSE Dublin and North East", "HSE Dublin & South East", "HSE West and North West region", "HSE West North West", "HSE South West", "HSE Dublin and Midlands",
      "HSE Dublin and North East Recruitment", "HSE Medical Manpower Donegal", "Health Service Executive", "Health Service Executive (HSE)", "Health Service Executive, Dublin and Midlands", "HSE - Cork Kerry Community Healthcare", "HSE CHO Dublin North City and County",
      "Health Service Executive Mid West Mental Health Services", "The Health Service Executive", "hse - cork"])
      expect([e, publicPayTier(e, candidates)]).toEqual([e, 1]);
  });
  it("#299: a company whose name only holds the word (health, safety and environment) is not the HSE, so it never passes with no pay check", () => {
    for (const e of ["Acme HSE Contractors", "HSE Recruitment Ltd", "HSE Recruitment", "HSE Staffing Dublin", "HSE Dublin Limited", "HSE Safety Consultants Cork", "HSE Solutions", "HSE Ireland", "HSE Training Galway",
      "Dublin HSE", "Not the HSE Dublin", "Health Service Executive Search Ltd", "Health Service Executive Staffing", "HSEDublin", "HSE Westside", "HSE Corkscrew", "Dublin Health Service Executive", "HSE West Engineering", "HSE Cork Scaffolding",
      "Health Service Executive Recruitment Partners", "HSE\u200bDublin", "HSE Dublin \u041bimited", "HSE and", "HSE Region", "HSE D\u0443blin", "HSE Dublin\nAcme"])
      expect([e, publicPayTier(e, candidates)]).toEqual([e, 0]);
    expect(publicPayTier("Acme HSE Contractors", new Map([["acme hse contractors", 2], [HSE_ENTRY, 1]]))).toBe(2); // an exact list name still matches as any other
  });
  it("#299: a very long name costs nothing", () => {
    const t = performance.now();
    for (const e of ["hse ".repeat(20_000), `hse ${"dubli".repeat(20_000)}`, `HSE ${"-".repeat(100_000)}`]) publicPayTier(e, candidates);
    expect(performance.now() - t).toBeLessThan(500);
  });
  it("names like constructor or __proto__ do not hit object internals", () => {
    expect(publicPayTier("constructor", candidates)).toBe(0);
    expect(publicPayTier("__proto__", candidates)).toBe(0);
  });
});

describe("duplicate keys (R22)", () => {
  const base = { url: "", employer: "Acme Ltd", title: "Nurse", location: "Dublin" };
  it("urlOrNameKey: the url when there is one", () => {
    expect(urlOrNameKey({ ...base, url: "https://x.example/1" })).toBe("u:https://x.example/1");
  });
  it("urlOrNameKey: otherwise cleaned name, lower-case title, lower-case location", () => {
    expect(urlOrNameKey(base)).toBe('t:["acme","nurse","dublin"]');
    expect(urlOrNameKey({ ...base, employer: "ACME Limited", title: "NURSE", location: "DUBLIN" })).toBe(urlOrNameKey(base));
  });
  it("urlOrNameKey: a url key never equals a name key", () => {
    expect(urlOrNameKey({ ...base, url: 't:["acme","nurse","dublin"]' })).not.toBe(urlOrNameKey(base));
  });
  it("known quirk: same url, different employer, is the same key; same job at two urls is not", () => {
    expect(urlOrNameKey({ ...base, url: "u" })).toBe(urlOrNameKey({ ...base, employer: "Other", url: "u" }));
    expect(urlOrNameKey({ ...base, url: "u1" })).not.toBe(urlOrNameKey({ ...base, url: "u2" }));
  });
  it("nameTitlePlaceKey: cleaned name | title words | first board place", () => {
    expect(nameTitlePlaceKey("Acme Ltd", "  Senior  Nurse (Night)!", "Cork, Dublin")).toBe("acme|senior nurse night|cork");
  });
  it("nameTitlePlaceKey: missing values give empty parts", () => {
    expect(nameTitlePlaceKey(null, null, null)).toBe("||");
  });
  it("known quirk: this key's place list is a third one: no kerry, clare, mayo or cavan, but blanchardstown", () => {
    expect(nameTitlePlaceKey("A", "t", "Killarney, Kerry")).toBe("a|t|");
    expect(nameTitlePlaceKey("A", "t", "Sandyford, Dublin")).toBe("a|t|sandyford");
  });
  it("known quirk: the place is the leftmost one in the text, not the first in the list", () => {
    expect(nameTitlePlaceKey("A", "t", "Galway or Cork")).toBe("a|t|galway");
  });
  it("known quirk: a title with accents loses those letters", () => {
    expect(nameTitlePlaceKey("A", "Médecin", "Cork")).toBe("a|m decin|cork");
  });
});
