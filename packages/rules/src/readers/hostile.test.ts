// Performance and security tests: adverts are untrusted text and these readers are regular expressions.
import { describe, expect, test } from "vitest";
import { checkSalary, doctorGradeWithoutTwoYears, noSponsorshipPhrase, permanentOrSpecifiedPurpose, readContract, readSalary, scamWording, sponsorshipAvailable } from "./index";

/** Run every reader on one advert. Returns nothing: the tests only care that it finishes in time and does not throw. */
function runAll(title: string, description: string, box = "", employmentType: string | null = "") {
  noSponsorshipPhrase(title, description);
  sponsorshipAvailable(description);
  scamWording(description);
  readContract(title, employmentType, description);
  doctorGradeWithoutTwoYears(title, description);
  permanentOrSpecifiedPurpose(description);
  const { low, high } = readSalary(description, box);
  checkSalary(low, high);
}

function timed(f: () => void): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}

// Made-up sentences, repeated to about 10,000 characters. Fake text only.
const SENTENCES = [
  "We are looking for a Senior Software Engineer to join our growing team in Dublin.",
  "The salary is €55,000 to €65,000 depending on experience, plus a bonus of €5,000.",
  "This is a 12 month fixed term contract with the option to extend for two years.",
  "Applicants must have the right to work in Ireland. We do not offer visa sponsorship.",
  "Our company turnover is €350m and we have 2,000 staff across 14 countries.",
  "Benefits: pension, health cover, 25 days leave, relocation help, a laptop allowance.",
  "Please send your CV by email; there is no registration fee and no deposit of any kind.",
  "This role requires you to be a national of an EU member state. Salary box: \u20ac80,000.00/yr - \u20ac90,000.00/yr.",
  "This post provides maternity cover for a colleague who is covering maternity leave. Turnover \u20ac2bn/year.",
  "Registrar post, permanent / specified purpose, 5 years, based at a hospital in Cork.",
];
function fakeAdvert(n: number): string {
  let out = "";
  for (let i = 0; out.length < 10_000; i++) out += SENTENCES[(i + n) % SENTENCES.length] + " ";
  return out;
}

// Measured on 10 Nov 2026 on the build machine (shared with other jobs): 1,000 adverts took 0.9 to 2.3 s. Budget: about three times the slowest, 6 s.
const ADVERTS_BUDGET_MS = 6000;
// Every hostile case below ran in well under 0.1 s when measured; the budget leaves room for a busy machine.
const CASE_BUDGET_MS = 3000;

describe("performance", () => {
  test("budget: 1,000 made-up adverts of about 10,000 characters through every reader", () => {
    const adverts = Array.from({ length: 1000 }, (_, n) => fakeAdvert(n));
    const ms = timed(() => adverts.forEach((a, n) => runAll("Senior Registrar " + n, a, "\u20ac60,000 - \u20ac70,000")));
    expect(ms).toBeLessThan(ADVERTS_BUDGET_MS);
  });
});

const MB = 1_000_000;
const HOSTILE: [string, string][] = [
  ["1 MB of one letter", "a".repeat(MB)],
  ["1 MB of spaces", " ".repeat(MB)],
  ["1 MB of new lines", "\n".repeat(MB)],
  ["one 1 MB line of words with no spaces", ("w".repeat(30) + ",").repeat(MB / 31)],
  ["1 MB of euro signs", "\u20ac".repeat(MB)],
  ["1 MB of commas", ",".repeat(MB)],
  ["1 MB of dots", ".".repeat(MB)],
  ["1 MB of '1,'", "1,".repeat(MB / 2)],
  ["1 MB of '1 '", "1 ".repeat(MB / 2)],
  ["1 MB of '1,000'", "1,000".repeat(MB / 5)],
  ["1 MB of '1k'", "1k".repeat(MB / 2)],
  ["1 MB of '\u20ac1 '", "\u20ac1 ".repeat(MB / 3)],
  ["1 MB of '1 \u20ac '", "1 \u20ac ".repeat(MB / 4)],
  ["1 MB of 'no '", "no ".repeat(MB / 3)],
  ["'no' then 1 MB of 'a '", "no " + "a ".repeat(MB / 2)],
  ["1 MB of 'pay '", "pay ".repeat(MB / 4)],
  ["1 MB of '6 month '", "6 month ".repeat(MB / 8)],
  ["1 MB of 'permanent '", "permanent ".repeat(MB / 10)],
  ["'permanent' then 1 MB of spaces", "permanent" + " ".repeat(MB)],
  ["'12 month' then 1 MB of x", "12 month" + "x".repeat(MB)],
  ["'contract' then 1 MB of x", "contract" + "x".repeat(MB)],
  ["a run of 10,000 digits", "1".repeat(10_000)],
  ["digits and separators in turn", "12345 6789,".repeat(5000)],
  ["HTML and script tags", "<script>alert(1)</script><b>\u20ac50,000</b><img src=x onerror=alert(1)>".repeat(5000)],
  ["mixed scripts and odd Unicode", "\u0645\u0631\u062d\u0628\u0627 \u65e5\u672c\u8a9e \u0130\u0131\u017f\u212a \u{1F600}\u{1D7D8} \u202f\u0085\ufeff \u20ac\u0665\u0660\u0660\u0660\u0660".repeat(5000)],
  ["null bytes", "\0".repeat(1000) + "\u20ac50,000" + "\0".repeat(1000)],
  ["lone surrogates", "\ud800 \udc00 \u20ac50,000 \ud800".repeat(5000)],
  ["1 MB of 'must be a national of '", "must be a national of ".repeat(MB / 22)],
  ["1 MB of 'requires you to be '", "requires you to be ".repeat(MB / 19)],
  ["1 MB of 'must ' then one 'be a national of an EU'", "must ".repeat(MB / 5) + "be a national of an EU"],
  ["1 MB of 'needs' with no spaces", "needs".repeat(MB / 5)],
  ["1 MB of 'maternity '", "maternity ".repeat(MB / 10)],
  ["1 MB of 'covering a '", "covering a ".repeat(MB / 11)],
  ["1 MB of 'cover for the a b '", "cover for the a b ".repeat(MB / 18)],
  ["1 MB of '\u20ac1,000/'", "\u20ac1,000/".repeat(MB / 7)],
  ["1 MB of '\u20ac1,000 / yr '", "\u20ac1,000 / yr ".repeat(MB / 13)],
  ["1 MB of '\u20ac80,000/yea'", "\u20ac80,000/yea".repeat(MB / 11)],
  ["1 MB of '/' after one amount", "\u20ac80,000" + "/".repeat(MB)],
  ["1 MB of '/ ' after one amount", "\u20ac80,000" + "/ ".repeat(MB / 2)],
  ["odd Unicode around the new patterns", "\u0130\u0131 must be a n\u0430tional of an EU \u202f\u20ac80,000\u200b/\u200byr maternity\u00a0\u00a0cover".repeat(5000)],
  // NEW BEHAVIOUR (11 Nov 2026) patterns: near matches repeated to 1 MB.
  ["1 MB of 'must be legally '", "must be legally ".repeat(MB / 16)],
  ["1 MB of 'must be eligible to work in '", "must be eligible to work in ".repeat(MB / 27)],
  ["1 MB of 'right to work in ireland ' (never a whole line)", "right to work in ireland ".repeat(MB / 25)],
  ["1 MB of new lines and one bullet line", "\n".repeat(MB) + " \u2022 Right to work in Ireland.\n"],
  ["1 MB of spaces before a line item", " ".repeat(MB) + "right to work in ireland"],
  ["1 MB of 'right to work in ireland and uk ' with tabs", "right to work in ireland and\tuk \t".repeat(MB / 30)],
  ["1 MB of 'work authorisation: '", "work authorisation: ".repeat(MB / 20)],
  ["'work authorisation' then 1 MB of spaces", "work authorisation" + " ".repeat(MB)],
  ["1 MB of '12 month ftc '", "12 month ftc ".repeat(MB / 13)],
  ["1 MB of 'ftc ' then a number", "ftc ".repeat(MB / 4) + "12 months"],
  ["1 MB of 'dedicated '", "dedicated ".repeat(MB / 10)],
  ["1 MB of '3rd year '", "3rd year ".repeat(MB / 9)],
  ["1 MB of 'placement '", "placement ".repeat(MB / 10)],
  ["1 MB of 'intern' with no spaces", "intern".repeat(MB / 6)],
  ["odd Unicode around the new wording", "\u0130\u0131 must\u00a0be\u00a0eligible to work in Ireland \u202f\u200b\n \u2022 right\u00a0to work in ireland\n".repeat(5000)],
  ["empty text", ""],
];

describe("security: hostile text neither throws nor hangs", () => {
  test.each(HOSTILE)("%s", (_name, text) => {
    const ms = timed(() => runAll(text.slice(0, 200), text, text.slice(0, 200)));
    expect(ms).toBeLessThan(CASE_BUDGET_MS);
  });

  test("the new patterns still answer under hostile padding", () => {
    const pad = "a ".repeat(MB / 2);
    expect(noSponsorshipPhrase("", pad + "requires you to be a national of an EU member state")).not.toBeNull();
    expect(readContract("E", "", "maternity cover " + pad).result).toBe("short");
    expect(readSalary(pad, "\u20ac80,000/yr").low).toBe(80000);
    expect(noSponsorshipPhrase("", pad + "\nmust be eligible to work in Ireland")).not.toBeNull();
    expect(noSponsorshipPhrase("", pad + "\n Right to work in Ireland.")).not.toBeNull();
    expect(readContract("E (12 month FTC)", "", pad).result).toBe("short");
    expect(readContract("E", "", pad + " dedicated placement").result).toBe("ok"); // past the first 6,000 characters
  });

  test("missing and empty fields", () => {
    expect(() => runAll("", "", "", null)).not.toThrow();
    expect(() => runAll("", "", "", undefined as unknown as null)).not.toThrow();
    expect(readSalary("", "")).toEqual({ low: null, high: null });
    expect(readSalary("")).toEqual({ low: null, high: null });
    expect(readContract("", undefined, "")).toEqual({ result: "ok", reason: "permanent or not stated" });
  });

  test("hostile text does not change the answers: an amount inside script tags is still read as an amount", () => {
    expect(readSalary("<script>alert('\u20ac50,000')</script>")).toEqual({ low: 50000, high: 50000 });
  });
});
