// Made-up titles and text only. Expected values were checked against the Python (classify.occupation).
import { describe, expect, it } from "vitest";
import { occupation, rulesMatcher, TITLE_RULES } from "./index";
import { pyRegex } from "./pyRegex";

const m = (code: string, onList: "yes" | "no" | "unknown", confidence: "none" | "low" | "medium" | "high") => ({ occupationCode: code, onCriticalSkillsList: onList, confidence });
const NONE = m("none", "unknown", "none");

// One made-up title per rule, in rule order: index, title, what the function returns with an empty description.
// The first test checks that rule N really is the first rule that matches title N.
const PER_RULE: [string, ReturnType<typeof m>][] = [
  ["Software Intern", m("intern", "no", "high")],
  ["Dental Nurse", m("ineligible-health", "no", "high")],
  ["Senior Care Worker", m("6146", "no", "high")],
  ["Healthcare Assistant", m("6145", "no", "high")],
  ["Pastry Chef", m("5434", "no", "high")],
  ["Hotel Manager", m("1221", "no", "high")],
  ["Store Manager", m("1190", "no", "high")],
  ["Accounts Payable Clerk", m("4122", "no", "high")],
  ["Warehouse Operator", m("non-cs-other", "no", "high")],
  ["Account Executive", m("3542", "no", "medium")],
  ["Graduate Programme", m("GRAD", "unknown", "low")],
  ["Product Manager", m("AMBIG-PRODUCT", "unknown", "low")],
  ["Service Desk Analyst", m("3131", "no", "high")],
  ["Recruiter", m("non-cs-other", "no", "high")],
  ["Midwife", m("2232", "yes", "high")],
  ["Staff Nurse", m("2231", "yes", "high")],
  ["Registrar", m("2211", "yes", "high")],
  ["Pharmacist", m("2213", "yes", "high")],
  ["Psychologist", m("2212", "yes", "high")],
  ["Optometrist", m("2214", "yes", "high")],
  ["Radiographer", m("2217", "yes", "high")],
  ["Podiatrist", m("2218", "yes", "high")],
  ["Audiologist", m("2219", "yes", "high")],
  ["Physiotherapist", m("2221", "yes", "high")],
  ["Occupational Therapist", m("2222", "yes", "high")],
  ["Speech and Language Therapist", m("2223", "yes", "high")],
  ["Orthoptist", m("2229", "yes", "high")],
  ["Social Worker", m("2442", "yes", "high")],
  ["Paramedic", m("3213", "yes", "high")],
  ["Prosthetist", m("3218", "yes", "high")],
  ["Chief Technology Officer", m("1136", "yes", "high")],
  ["Engineering Manager", m("2133", "yes", "high")],
  ["Scrum Master", m("2134", "yes", "high")],
  ["Cloud Architect", m("2135", "yes", "high")],
  ["Backend Engineer", m("2136", "yes", "high")],
  ["Data Scientist", m("2425", "yes", "high")],
  ["Network Engineer", m("2139", "yes", "high")],
  ["Civil Engineer", m("2121", "yes", "high")],
  ["Mechanical Engineer", m("2122", "yes", "high")],
  ["Electrical Engineer", m("2123", "yes", "high")],
  ["Hardware Engineer", m("2124", "yes", "high")],
  ["Design Engineer", m("2126", "yes", "high")],
  ["Process Engineer", m("2127", "yes", "high")],
  ["Project Engineer", m("2129", "yes", "high")],
  ["Quality Engineer", m("2461", "yes", "high")],
  ["Regulatory Affairs Lead", m("2462", "yes", "high")],
  ["Environmental Officer", m("2463", "yes", "low")],
  ["Quantity Surveyor", m("2433", "yes", "high")],
  ["Land Surveyor", m("2434", "yes", "high")],
  ["Architectural Technologist", m("2435", "yes", "high")],
  ["Construction Planner", m("2436", "yes", "high")],
  ["Site Manager", m("1122", "yes", "high")],
  ["BIM Coordinator", m("3122", "yes", "high")],
  ["Estimator", m("3531", "yes", "high")],
  ["Planning Officer", m("2432", "yes", "high")],
  ["Analytical Scientist", m("2111", "yes", "high")],
  ["Microbiologist", m("2112", "yes", "low")],
  ["Financial Controller", m("2421", "yes", "high")],
  ["Financial Analyst", m("2424", "yes", "high")],
  ["Actuary", m("2425", "yes", "high")],
  ["Patent Attorney", m("2419", "yes", "high")],
  ["Delivery Manager", m("AMBIG-PM", "unknown", "low")],
  ["Business Analyst", m("AMBIG-BA", "unknown", "low")],
  ["Architect", m("2431", "yes", "medium")],
  ["Consultant", m("AMBIG-GENERIC", "unknown", "low")],
  ["Sales Associate", m("3542", "no", "medium")],
];

describe("title rules", () => {
  it("holds the 66 rules of classify.py:27-100, in file order", () => {
    expect(TITLE_RULES).toHaveLength(66);
    expect(PER_RULE).toHaveLength(66);
    const lines = TITLE_RULES.map((r) => r.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines[0]).toBe(29);
    expect(lines[65]).toBe(99);
  });

  it.each(PER_RULE.map(([title, want], i) => [i + 1, title, want] as const))("rule %i: %s", (n, title, want) => {
    const first = TITLE_RULES.findIndex((r) => pyRegex(r.pattern).test(` ${title.toLowerCase()} `));
    expect(first, "first matching rule").toBe(n - 1);
    expect(occupation(title, "")).toEqual(want);
  });

  it("lower-cases the title and pads it with spaces", () => {
    expect(occupation("MIDWIFE", "")).toEqual(m("2232", "yes", "high"));
    expect(occupation("midwife", "")).toEqual(m("2232", "yes", "high"));
    expect(occupation("  Midwife  ", "")).toEqual(m("2232", "yes", "high"));
    expect(occupation("(Midwife)", "")).toEqual(m("2232", "yes", "high"));
    expect(occupation("Midwifery", "")).toEqual(m("2232", "yes", "high"));
    expect(occupation("Midwifex", "")).toEqual(NONE);
  });

  it("first match wins: an earlier rule beats a later one", () => {
    expect(occupation("Nurse Recruiter", "")).toEqual(m("non-cs-other", "no", "high"));
    expect(occupation("Software Engineer Intern", "")).toEqual(m("intern", "no", "high"));
  });

  it("gives none for an unknown title, an empty title and no title text", () => {
    expect(occupation("Gardener", "")).toEqual(NONE);
    expect(occupation("", "")).toEqual(NONE);
    expect(occupation("   ", "software")).toEqual(NONE);
  });
});

describe("description tests (R08)", () => {
  it("project and programme managers: IT words give 2134, construction words give 2436, IT first, else queue", () => {
    expect(occupation("Project Manager", "We use cloud tools")).toEqual(m("2134", "yes", "medium"));
    expect(occupation("Programme Manager", "an agile team")).toEqual(m("2134", "yes", "medium"));
    expect(occupation("Program Manager", "SQL")).toEqual(m("2134", "yes", "medium"));
    expect(occupation("Project Manager", "a civil site")).toEqual(m("2436", "yes", "medium"));
    expect(occupation("Project Manager", "site works and cloud")).toEqual(m("2134", "yes", "medium"));
    expect(occupation("Project Manager", "plain words")).toEqual(m("AMBIG-PM", "unknown", "low"));
    expect(occupation("Project Manager", "")).toEqual(m("AMBIG-PM", "unknown", "low"));
  });

  it("context words are whole words and any case", () => {
    expect(occupation("Project Manager", "JAVA")).toEqual(m("2134", "yes", "medium"));
    expect(occupation("Project Manager", "javascript")).toEqual(m("AMBIG-PM", "unknown", "low"));
    expect(occupation("Project Manager", "an IT system")).toEqual(m("2134", "yes", "medium"));
    expect(occupation("Project Manager", "a fit-out job")).toEqual(m("2436", "yes", "medium"));
  });

  it("business and systems analysts: IT words give 2135, else queue", () => {
    expect(occupation("Business Analyst", "sql")).toEqual(m("2135", "yes", "medium"));
    expect(occupation("Systems Analyst", "erp")).toEqual(m("2135", "yes", "medium"));
    expect(occupation("Business Analyst", "retail")).toEqual(m("AMBIG-BA", "unknown", "low"));
    expect(occupation("Business Analyst", "a civil site")).toEqual(m("AMBIG-BA", "unknown", "low"));
  });

  it("architects: IT words give 2135, else 2431", () => {
    expect(occupation("Architect", "java")).toEqual(m("2135", "yes", "medium"));
    expect(occupation("Architect", "a house")).toEqual(m("2431", "yes", "medium"));
  });

  it("generic titles with 'engineer': 212x/213x, or the queue label for field service types", () => {
    expect(occupation("Engineer", "")).toEqual(m("212x/213x", "yes", "medium"));
    expect(occupation("Engineer in Test", "")).toEqual(m("212x/213x", "yes", "medium"));
    for (const t of ["Field Service Engineer", "Installation Engineer", "Install Engineer", "Maintenance Engineer", "Service Engineer", "Customer Engineer", "Support Engineer", "Incident Engineer", "Operations Engineer"]) {
      expect(occupation(t, "software"), t).toEqual(m("engineer?", "unknown", "low"));
    }
  });

  it("generic titles without 'engineer' stay in the queue", () => {
    expect(occupation("Reliability Specialist", "software")).toEqual(m("AMBIG-GENERIC", "unknown", "low"));
    expect(occupation("Consultant", "")).toEqual(m("AMBIG-GENERIC", "unknown", "low"));
  });

  it("sales titles: on the list only with a non-EEA language word in the title or the first 3,000 characters", () => {
    expect(occupation("Sales Manager", "plain")).toEqual(m("3542", "no", "medium"));
    expect(occupation("Sales Manager", "Mandarin speaker")).toEqual(m("3542", "yes", "low"));
    expect(occupation("Sales Manager (MANDARIN)", "")).toEqual(m("3542", "yes", "low"));
    expect(occupation("Business Development Lead", "fluent korean")).toEqual(m("3542", "yes", "low"));
    expect(occupation("Sales Manager", "mandarins and oranges")).toEqual(m("3542", "no", "medium"));
    expect(occupation("Sales Manager", `${"x ".repeat(1495)}mandarin`)).toEqual(m("3542", "yes", "low"));
    expect(occupation("Sales Manager", `${"x".repeat(3000)} mandarin`)).toEqual(m("3542", "no", "medium"));
  });

  it("counts the 3,000 characters as code points, as Python does (an emoji is one)", () => {
    expect(occupation("Sales Manager", `${"\u{1F600}".repeat(2990)} mandarin`)).toEqual(m("3542", "yes", "low"));
    expect(occupation("Sales Manager", `${"\u{1F600}".repeat(3000)} mandarin`)).toEqual(m("3542", "no", "medium"));
  });

  it("reads missing text as empty", () => {
    expect(occupation("Project Manager", undefined as unknown as string)).toEqual(m("AMBIG-PM", "unknown", "low"));
    expect(occupation(null as unknown as string, null as unknown as string)).toEqual(NONE);
  });

  it("the async matcher returns the same match", async () => {
    await expect(rulesMatcher("Staff Nurse", "")).resolves.toEqual(m("2231", "yes", "high"));
    await expect(rulesMatcher("Architect", "python")).resolves.toEqual(m("2135", "yes", "medium"));
  });
});

describe("regex dialect (Python's \\b \\w \\s \\d and '.' in JavaScript)", () => {
  it("treats accented letters as word letters", () => {
    expect(occupation("Bim", "")).toEqual(m("3122", "yes", "high"));
    expect(occupation("ébim", "")).toEqual(NONE);
    expect(occupation("Chefé", "")).toEqual(NONE);
    expect(occupation("Nursé", "")).toEqual(NONE);
    expect(occupation("Bim٣", "")).toEqual(NONE);
    expect(occupation("٣ Bim", "")).toEqual(m("3122", "yes", "high"));
  });

  it("matches 'fa[cç]ade' with and without the cedilla, in any case", () => {
    for (const t of ["Façade Engineer", "FAÇADE ENGINEER", "Facade Engineer", "façade designer"]) {
      expect(occupation(t, ""), t).toEqual(m("2129", "yes", "high"));
    }
  });

  it("reads \\d as any decimal digit and \\s as any Python space", () => {
    expect(occupation("CNM 2", "")).toEqual(m("2231", "yes", "high"));
    expect(occupation("Machine learning engineer", "")).toEqual(m("212x/213x", "yes", "medium"));
    expect(occupation("QA Engineer", "")).toEqual(m("212x/213x", "yes", "medium"));
    expect(occupation("Machine\u001clearning engineer", "")).toEqual(m("212x/213x", "yes", "medium"));
    expect(occupation("Machine\u0085learning engineer", "")).toEqual(m("212x/213x", "yes", "medium"));
    // U+FEFF is a space in JavaScript but not in Python
    expect(occupation("Backend﻿Engineer", "")).toEqual(m("212x/213x", "yes", "medium"));
  });

  it("'.' stops at \\n only: \\r and U+2028 are crossed", () => {
    expect(occupation("technician\nbim", "")).toEqual(m("non-cs-other", "no", "high"));
    expect(occupation("technician\rbim", "")).toEqual(m("3122", "yes", "high"));
    expect(occupation("technician bim", "")).toEqual(m("3122", "yes", "high"));
  });

  it("matches the same code points as Python for \\w, \\s and \\d on spot checks", () => {
    expect(pyRegex(String.raw`^\w$`).test("é")).toBe(true);
    expect(pyRegex(String.raw`^\w$`).test("_")).toBe(true);
    expect(pyRegex(String.raw`^\w$`).test("́")).toBe(false);
    expect(pyRegex(String.raw`^\s$`).test("﻿")).toBe(false);
    expect(pyRegex(String.raw`^\s$`).test("\u0085")).toBe(true);
    expect(pyRegex(String.raw`^\d$`).test("٣")).toBe(true);
    expect(pyRegex(String.raw`^.$`).test("\r")).toBe(true);
    expect(pyRegex(String.raw`^.$`).test("\n")).toBe(false);
    expect(pyRegex(String.raw`^[\w-]$`).test("-")).toBe(true);
  });
});

describe("known quirks (behaviour kept from the Python, see 15-job-check-test.md and 19-job-check-rerun-67.md)", () => {
  it("known quirk: a misspelt 'Manger' is not recognised", () => {
    expect(occupation("Highway Construction Manger", "")).toEqual(NONE);
  });

  it("known quirk: 'Customer Risk Manager' reads as a financial risk manager (2424, on the list)", () => {
    expect(occupation("Customer Risk Manager", "")).toEqual(m("2424", "yes", "high"));
  });

  it("known quirk: 'Environmental Program Manager' reads as an IT project manager when the text has IT words", () => {
    expect(occupation("Environmental Program Manager", "We use cloud tools and agile")).toEqual(m("2134", "yes", "medium"));
    expect(occupation("Environmental Program Manager", "Green things")).toEqual(m("AMBIG-PM", "unknown", "low"));
  });

  it("known quirk: 'Contract Psychiatrist' is a doctor on the list, the contract length is not read here", () => {
    expect(occupation("Contract Psychiatrist", "")).toEqual(m("2211", "yes", "high"));
  });

  it("known quirk: dentists are not recognised, but a 'Doctor / Dentist' title is a doctor", () => {
    expect(occupation("Dentist", "")).toEqual(NONE);
    expect(occupation("Cosmetic Practitioner (Doctor / Dentist)", "")).toEqual(m("2211", "yes", "high"));
  });

  it("known quirk: 'Senior Machine Learning Ops' is not recognised", () => {
    expect(occupation("Senior Machine Learning Ops", "")).toEqual(NONE);
  });

  it("known quirk: 'Database Administrator' is caught by the 'administrator' rule before the database rule", () => {
    expect(occupation("Database Administrator", "")).toEqual(m("non-cs-other", "no", "high"));
  });

  it("known quirk: the not-IT word test only looks to the right: 'software technician' is non-cs, 'technician software' is not recognised", () => {
    expect(occupation("Software Technician", "")).toEqual(m("non-cs-other", "no", "high"));
    expect(occupation("Technician Software", "")).toEqual(NONE);
    expect(occupation("Technician BIM", "")).toEqual(m("3122", "yes", "high"));
  });

  it("known quirk: 'Town Planner' hits the 'planner' rule (2436), so the 'town planner' rule (2432) never fires", () => {
    expect(occupation("Town Planner", "")).toEqual(m("2436", "yes", "high"));
  });

  it("known quirk: 'HR' alone is not recognised, 'HR Manager' is (the pattern 'hr ' wants a word after the space)", () => {
    expect(occupation("HR", "")).toEqual(NONE);
    expect(occupation("HR Manager", "")).toEqual(m("non-cs-other", "no", "high"));
  });

  it("known quirk: the nurse and intern rules ignore the rest of the title ('Nurse Recruiter' is non-cs)", () => {
    expect(occupation("Nurse Recruiter", "")).toEqual(m("non-cs-other", "no", "high"));
  });
});

// ---- performance and hostile input ----

const WORDS = "lorem ipsum dolor sit amet engineer manager software cloud site civil team role salary benefits office remote hybrid sponsorship visa 12,500 €45,000 python java sql project".split(" ");
const advert = (seed: number, size: number) => {
  let x = seed + 1;
  let out = "";
  while (out.length < size) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += WORDS[x % WORDS.length] + (x % 7 === 0 ? ".\n" : " ");
  }
  return out;
};
const TITLES: string[] = ["Project Manager", "Software Engineer", "Sales Manager", "Staff Nurse", "Business Analyst", "Architect", "Gardener", "Field Service Engineer", "Quantity Surveyor", "Senior Consultant"];

describe("performance", () => {
  // Measured 10 Nov 2026: 1,000 adverts of 10,000 characters took about 530 ms (best of 3, other work running on the machine); the budget is about three times that.
  it("matches 1,000 made-up adverts of about 10,000 characters inside the budget", () => {
    const adverts = Array.from({ length: 1000 }, (_, i) => ({ title: TITLES[i % TITLES.length] ?? "", description: advert(i, 10_000) }));
    const start = performance.now();
    for (const a of adverts) occupation(a.title, a.description);
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

const BUDGET_MS = 1500;
// Slowest hostile case measured: a 1 MB title with no spaces, about 650 ms. Budget about four times that.
const HOSTILE_BUDGET_MS = 3000;
const time = (f: () => unknown) => {
  const start = performance.now();
  f();
  return performance.now() - start;
};

describe("hostile input", () => {
  const MB = 1_000_000;
  const cases: [string, string, string][] = [
    ["1 MB description, project manager", "Project Manager", "softwar ".repeat(MB / 8)],
    ["1 MB description, architect, one line with no spaces", "Architect", "a".repeat(MB)],
    ["1 MB description of digits, commas and spaces", "Business Analyst", "1,2 ".repeat(MB / 4)],
    ["1 MB description of currency signs", "Sales Manager", "€".repeat(MB)],
    ["1 MB title with no spaces", "a".repeat(MB), ""],
    ["1 MB title of unknown words", "lorem ipsum ".repeat(MB / 12), ""],
    ["1 MB title of spaces", " ".repeat(MB), ""],
    ["1 MB title of keywords", "software ".repeat(MB / 9), "x".repeat(MB)],
    ["1 MB title of 'manager, '", "manager, ".repeat(MB / 9), ""],
    ["1 MB title of 'sales' and 1 MB description", "sales ".repeat(MB / 6), "x".repeat(MB)],
    ["1 MB title of digits and commas", "1,2 ".repeat(MB / 4), ""],
    ["script and HTML tags", "<script>alert(1)</script><b>Nurse</b>", "<img src=x onerror=alert(1)><script>software</script>"],
    ["mixed scripts and odd Unicode", "مهندس 中文 😀 ́́ ‮ Engineer", "ไทย ‮ ﻿ \u0000 \ud800 python"],
    ["null bytes", "Nurse\u0000", "\u0000".repeat(10_000)],
    ["empty strings", "", ""],
    ["lone surrogates", "𐀀\ud800 Engineer", "\udfff".repeat(5000)],
  ];

  it.each(cases)("%s: no throw, inside the time budget", (_name, title, description) => {
    let result: unknown;
    const ms = time(() => {
      result = occupation(title, description);
    });
    expect(result).toBeDefined();
    expect(ms).toBeLessThan(HOSTILE_BUDGET_MS);
  });

  it("finds the word inside HTML and script text exactly as it would in plain text", () => {
    expect(occupation("<b>Nurse</b>", "")).toEqual(m("2231", "yes", "high"));
  });

  // Finding: rule 9 (classify.py:37) re-scans the rest of the title for every candidate word when a later
  // 'bim', 'software' or 'database' makes it fail, so time grows with the square of the title length.
  // Titles are short in practice (about 100 characters); 100,000 characters took about 250 ms and
  // 400,000 about 2.5 s when measured. The Python does the same; a title length cap belongs to the caller.
  it("known quirk: a very long title of rule-9 words ending in 'bim' is slow (quadratic), still finishes at 100,000 characters", () => {
    const ms = time(() => occupation(`${"operator ".repeat(11_000)}bim`, ""));
    expect(ms).toBeLessThan(HOSTILE_BUDGET_MS);
  });
});
