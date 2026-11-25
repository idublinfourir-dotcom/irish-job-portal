// Unit (check 3): the checker's input checks (pure) and its page body for every state: not asked yet, bad answers, each answer the read can give (qualifies, each reason, registration), and each
// refusal (400, 429, other). Fixtures only. "As built" (decision #287, L25): no per-rule results, no insurance input, no jobs-that-pass count.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckerView, headlineOf, type Answer } from "./checker-view";
import { codeOf, optionText, parseChecker, type Occupation } from "./input";

vi.mock("server-only", () => ({}));

const list: Occupation[] = [
  { code: "2231", title: "Nurses", slug: "nurses", listStatus: "critical-skills" }, { code: "5434", title: "Chefs", slug: "chefs", listStatus: "ineligible" },
  { code: "6145", title: "Carers", slug: "carers", listStatus: "other" },
];
const ok = { occupation: "Nurses (2231)", pay: "42000", degree: "yes" };

describe("what the page takes from its address", () => {
  it("is not an answer until a field is in the address", () => {
    const p = parseChecker({}, list);
    expect(p).toMatchObject({ submitted: false, query: null, errors: {} });
  });
  it("turns a good answer into the checker's query, and nothing else", () => {
    const p = parseChecker({ ...ok, degreeMonth: "2026-06", months: "24", hours: "39", title: "Staff Nurse", junk: "x" }, list);
    expect(p.errors).toEqual({});
    expect(Object.fromEntries(p.query!)).toEqual({ occupationCode: "2231", annualPay: "42000", relevantDegree: "true", degreeAwardMonth: "2026-06", contractMonths: "24", weeklyHours: "39", title: "Staff Nurse" });
    expect(parseChecker({ occupation: "5434", pay: "€ 30,500.50", degree: "no", degreeMonth: "2026-06" }, list).query!.toString()).toBe("occupationCode=5434&annualPay=30500.50&relevantDegree=false"); // the month is read only with a degree
  });
  it("takes the occupation as an option, a bare code or an exact title; nothing else", () => {
    expect(codeOf(optionText(list[0]!), list)).toBe("2231");
    expect(codeOf("2231", list)).toBe("2231");
    expect(codeOf("  chefs ", list)).toBe("5434");
    for (const bad of ["", "9999", "Nurse", "2231; drop table", "22311", "Nurses (9999)"]) expect(codeOf(bad, list), bad).toBeNull();
    expect(codeOf("2231", [])).toBe("2231"); // the picker list could not be read: the checker itself says whether the code is known
  });
  it("says what is wrong next to the field, and makes no query", () => {
    const bad = (o: Record<string, string>, field: string) => {
      const p = parseChecker({ ...ok, ...o }, list);
      expect(p.errors, field).toHaveProperty(field);
      expect(p.query).toBeNull();
    };
    bad({ occupation: "" }, "occupation");
    bad({ occupation: "Nurzes" }, "occupation");
    bad({ pay: "" }, "pay");
    bad({ pay: "12abc" }, "pay");
    bad({ pay: "99999999" }, "pay");
    bad({ pay: "-5" }, "pay");
    bad({ degree: "" }, "degree");
    bad({ degree: "maybe" }, "degree");
    bad({ degreeMonth: "2026-13" }, "degreeMonth");
    bad({ months: "1000" }, "months");
    bad({ months: "-1" }, "months");
    bad({ hours: "0" }, "hours");
    bad({ hours: "61" }, "hours");
    bad({ title: "a\u0000b" }, "title");
  });
  it("cuts what it echoes, takes the first of a repeated key, and never throws on hostile values", () => {
    const p = parseChecker({ occupation: ["Nurses (2231)", "x"], pay: "4".repeat(5000), title: "t".repeat(5000), degree: "yes" }, list);
    expect(p.values.pay.length).toBeLessThanOrEqual(120);
    expect(p.values.title.length).toBeLessThanOrEqual(200);
    expect(p.values.occupation).toBe("Nurses (2231)");
    expect(() => parseChecker({ occupation: "'; drop table job;--", pay: "<script>", degree: "<img>" }, list)).not.toThrow();
  });
});

describe("the page", () => {
  const answer = (o: Partial<Answer> = {}): Answer => ({ qualifies: true, reason: "listed_degree", minimum: 41000, why: "On the list with a degree: the minimum is €41,000.", standingLine: "Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on 12 Nov 2026.", rulesCheckedOn: "2026-11-12", registration: null, ...o });
  const view = (o: Partial<Parameters<typeof CheckerView>[0]> = {}) => html(<CheckerView parsed={parseChecker({}, list)} occupations={list} answer={null} failed={null} signedIn={false} {...o} />);

  it("is a plain GET form with the seven fields the checker reads, the picker list, and one H1", () => {
    const h = view();
    expect(h).toContain('method="get"');
    expect(h).toContain('action="/eligibility-checker"');
    for (const n of ["occupation", "pay", "months", "hours", "title", "degree", "degreeMonth"]) expect(h).toContain(`name="${n}"`);
    expect(h).toContain('<option value="Nurses (2231)"');
    expect(h.match(/<h1\b/g)).toHaveLength(1);
    expect(h).toContain("Your result appears here");
    expect(h).toContain("That is the employer’s responsibility.");
    for (const t of ["health insurance", "Find jobs that pass", "How a", "sample"]) expect(h.toLowerCase()).not.toContain(t.toLowerCase());
  });
  it("works without the picker list (its read failed)", () => {
    const h = view({ occupations: null });
    expect(h).not.toContain("<datalist");
    expect(h).toContain('name="occupation"');
  });
  it("shows the answer the read gave: headline, why, the minimum from the read, the day, the standing line", () => {
    const p = parseChecker(ok, list);
    const h = view({ parsed: p, answer: answer() });
    expect(h).toContain("This job could qualify for a");
    expect(h).toContain("On the list with a degree: the minimum is €41,000.");
    expect(h).toContain("€41,000");
    expect(h).toContain("checked 12 Nov 2026");
    expect(h).toContain("Rules last checked on 12 Nov 2026.");
    expect(h).toContain('data-result="qualifies"');
    expect(h).toContain("/jobs?occupationCode=2231");
    expect(h).toContain("/occupations/nurses");
    expect(view({ parsed: p, answer: answer({ minimum: 99999 }) })).toContain("€99,999");
  });
  it("offers to read about an occupation only when it has a page (OCC1); its jobs always", () => {
    const of = (code: string, occupations: Occupation[] | null = list) => view({ parsed: parseChecker({ ...ok, occupation: code }, list), occupations, answer: answer() });
    expect(of("5434")).toContain('href="/occupations/chefs"');
    for (const h of [of("6145"), of("2231", null)]) { // on neither list; the picker list could not be read
      expect(h).not.toContain("Read about this occupation");
      expect(h).not.toContain("/occupations/");
      expect(h).toContain("See jobs for this occupation");
    }
  });
  it("words every reason that is not a pass, with the read's own sentence", () => {
    const p = parseChecker(ok, list);
    for (const [reason, head] of [["unknown_code", "We do not know that occupation code"], ["ineligible", "not open for a Critical Skills permit"], ["contract_too_short", "contract is too short"], ["below_minimum", "salary is below the minimum"], ["degree_needed", "relevant degree is needed"], ["non_list_route_blocked", "not open without a relevant degree"], ["something_new", "does not meet the Critical Skills rules"]]) {
      const h = view({ parsed: p, answer: answer({ qualifies: false, reason, minimum: null, why: `WHY ${reason}` }) });
      expect(h, reason).toContain(head);
      expect(h).toContain(`WHY ${reason}`);
      expect(h).toContain('data-result="no"');
      expect(h).not.toContain("Minimum that applies to you");
    }
    expect(html(<>{headlineOf({ qualifies: true, reason: "recent_graduate" })}</>)).toContain("Critical Skills");
  });
  it("shows the registration block with its steps and the body's guide (BA20)", () => {
    const h = view({ parsed: parseChecker(ok, list), answer: answer({ registration: { status: "required", body: { id: "nmbi", name: "Nursing Board", url: "https://nmbi.example/" }, line: "Register first.", steps: ["One", "Two"] } }) });
    expect(h).toContain("Registration: Nursing Board");
    expect(h).toContain("<li>One</li>");
    expect(h).toContain('href="https://nmbi.example/"');
  });
  it("words each refusal and each bad answer", () => {
    expect(view({ parsed: parseChecker(ok, list), failed: { status: 429 } })).toContain("Too many checks");
    expect(view({ parsed: parseChecker(ok, list), failed: { status: 400 } })).toContain("We could not check that");
    expect(view({ parsed: parseChecker(ok, list), failed: { status: 500 } })).toContain("The check could not be run");
    const h = view({ parsed: parseChecker({ occupation: "", pay: "x", degree: "" }, list) });
    expect(h).toContain("Fix the answers marked on the left");
    expect(h).toContain("Choose an occupation.");
    expect(h).toContain("Enter the salary as a number of euro a year");
    expect(h).toContain("Say whether you have a relevant degree.");
    expect(h).toContain('aria-invalid="true"');
  });
  it("escapes what the visitor typed", () => {
    const h = view({ parsed: parseChecker({ occupation: '"><script>alert(1)</script>', pay: "<b>", degree: "no", title: "<img src=x onerror=1>" }, list) });
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<b>");
  });
  it("shows the join band to a visitor only", () => {
    expect(view()).toContain("data-join");
    expect(view({ signedIn: true })).not.toContain("data-join");
  });
});
