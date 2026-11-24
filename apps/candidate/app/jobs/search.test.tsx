// Unit: the search page body rendered to HTML for every state (visitor limit, signed in, empty, each error code), and the alert filters.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { alertFrom, SearchView, type ListRead, type SearchProps } from "./search";
import { parseSearch } from "./format";
import { NOW, card } from "./test-fixtures";

const ok = (o: Partial<Extract<ListRead, { ok: true }>> = {}): ListRead => ({ ok: true, jobs: [card()], next: null, previous: null, count: { n: 42, more: false }, signInForMore: false, ...o });
const view = (o: Partial<SearchProps> = {}) => html(<SearchView state={parseSearch({})} now={NOW} list={ok()} signedIn={false} savedIds={[]} {...o} />);

describe("visitor", () => {
  it("shows the jobs, the sign-in box with the limit, and no paging", () => {
    const h = view({ list: ok({ jobs: [card({ id: "1" }), card({ id: "2", title: "Chef" })], signInForMore: true }) });
    expect(h).toContain("Want to see more jobs?");
    expect(h).toContain("You can see 2 of 42");
    expect(h).toContain("Create free account");
    expect(h).toContain("Sign in to create an alert");
    expect(h).not.toContain('aria-label="Pagination"');
    expect(h).not.toContain("Save Staff Nurse"); // saving needs an account
    expect(h).not.toContain("Report Staff Nurse");
  });
  it("prints 200+ when the count is capped", () => {
    expect(view({ list: ok({ count: { n: 200, more: true } }) })).toContain("200+ jobs");
  });
  it("words a visitor's request for a later page", () => {
    const h = view({ list: { ok: false, status: 401, code: "SIGN_IN_FOR_MORE" } });
    expect(h).toContain("Log in to see more jobs");
  });
});

describe("signed in", () => {
  it("shows save (marked when saved), report, the alert builder and Previous and Next only", () => {
    const h = view({ signedIn: true, savedIds: ["1042"], list: ok({ next: "n1", previous: "p1" }), state: parseSearch({ county: "Cork" }) });
    expect(h).toContain("Saved: Staff Nurse");
    expect(h).toContain("Report Staff Nurse");
    expect(h).toContain("Create alert");
    expect(h).toContain('href="/jobs?county=Cork&amp;after=n1"');
    expect(h).toContain('href="/jobs?county=Cork&amp;before=p1"');
    expect(h).toContain(">Previous<");
    expect(h).toContain(">Next<");
    expect(h).not.toMatch(/>\s*[0-9]+\s*<\/a>/); // no page numbers (#125)
    expect(h).not.toContain("Want to see more jobs?");
  });
  it("says which filters an alert cannot keep", () => {
    expect(view({ signedIn: true, state: parseSearch({ q: "nurse", postedWithin: "7" }) })).toContain("keyword, date posted filter is not saved");
  });
});

describe("empty and errors", () => {
  it("shows the empty state with clear, alert and the newest sponsor jobs", () => {
    const h = view({ list: ok({ jobs: [], count: { n: 0, more: false } }), newest: [card({ id: "9", title: "Chef", badge: "sponsor_confirmed" })] });
    expect(h).toContain("No jobs match");
    expect(h).toContain("that search");
    expect(h).toContain("Clear filters");
    expect(h).toContain("Newest jobs with a confirmed sponsor");
    expect(h).toContain("Chef");
    expect(h).not.toContain("Popular");
  });
  it.each([
    [400, "We could not use that search"],
    [429, "Too many searches"],
    [500, "Jobs could not be loaded"],
  ])("words %i", (status, text) => {
    const h = view({ list: { ok: false, status, code: "X", ...(status === 429 ? { retryAfter: 30 } : {}) } });
    expect(h).toContain(text);
    if (status === 429) expect(h).toContain("about 30 seconds");
    expect(h).not.toContain("Staff Nurse");
  });
});

describe("filters and filter sheet", () => {
  it("is one GET form (id jobs-search) with every #287 filter, the sheet toggle for phones and the active count", () => {
    const h = view({ state: parseSearch({ county: "Cork", badge: "sponsor_confirmed", salaryStated: "true" }) });
    for (const name of ["q", "sector", "county", "badge", "salaryMin", "salaryStated", "postedWithin"]) expect(h).toContain(`name="${name}"`);
    expect(h).toContain('method="get"');
    expect(h).toContain('id="jobs-search"');
    expect(h).toContain('form="jobs-search"'); // the panel's controls belong to the same form
    expect(h).toContain('id="filters-open"');
    expect(h).toContain("All filters (3)");
    expect(h).not.toContain('name="sort"'); // the default sort is the decided one (#157), so the address carries none
    expect(h).toMatch(/aria-current="true"[^>]*>Sponsors first</);
    expect(h).not.toMatch(/name="(contractType|permitHistory)"/); // L46: dropped filters stay out
  });
  it("keeps a chosen sort in the form and marks it", () => {
    const h = view({ state: parseSearch({ sort: "newest" }) });
    expect(h).toContain('name="sort" value="newest"');
    expect(h).toMatch(/aria-current="true"[^>]*>Newest</);
  });
  it("shows sector counts only when the read gave them", () => {
    expect(view({})).not.toContain(">7<");
    expect(view({ sectorCounts: [{ sector: "health", jobs: 7 }] })).toContain(">7<");
  });
  it("shows a chip per filter in use, each linking to the search without it", () => {
    const h = view({ state: parseSearch({ county: "Cork", sector: "health", salaryMin: "30000" }) });
    expect(h).toContain('href="/jobs?sector=health&amp;salaryMin=30000"'); // county dropped
    expect(h).toContain("From €30,000");
  });
  it("keeps an occupation filter and shows its title", () => {
    const h = view({ state: parseSearch({ occupationCode: "2231" }), occupationTitle: "Nursing professionals" });
    expect(h).toContain('name="occupationCode" value="2231"');
    expect(h).toContain("Occupation: Nursing professionals");
  });
});

describe("alert filters", () => {
  it("keeps only what the alert route accepts and drops invalid values", () => {
    const a = alertFrom({ sector: "health", county: "Narnia", badge: "other", salaryMin: "30000", occupationCode: "22", q: "x" }, null);
    expect(a.filters).toEqual({ sector: "health", salaryMin: 30000 });
    expect(a.notKept).toEqual(["keyword"]);
    expect(alertFrom({ county: "Cork", badge: "critical_skills_eligible", occupationCode: "2231" }, "Nurses").summary).toEqual(["Nurses", "Cork", "Critical Skills eligible"]);
  });
});

describe("card words", () => {
  it("shows the salary states of frame C08 from the read, with no figure of its own", () => {
    const states: [Parameters<typeof card>[0], string][] = [
      [{ salaryLine: "€38,000 to €45,000" }, "€38,000 to €45,000 a year"],
      [{ passRoute: "public_pay", salaryLow: null, salaryHigh: null, salaryLine: "Grade 5", payGrade: "Grade 5", payScaleLine: "Pay scale for this grade: EUR 38,166 to 56,592" }, "€38,166 to €56,592"],
      [{ passRoute: "big_company", salaryLow: null, salaryHigh: null, salaryLine: null }, "A large employer on our list"],
      [{ passRoute: "pay_floor", salaryLow: null, salaryHigh: null, salaryLine: null }, "signed a pay floor"],
      [{ passRoute: null, salaryLow: null, salaryHigh: null, salaryLine: null }, "Salary not stated"],
    ];
    for (const [o, text] of states) expect(view({ list: ok({ jobs: [card(o)] }) })).toContain(text);
  });
  it("shows badges, labels, quota, initials, freshness and the job address", () => {
    const h = view({ list: ok({ jobs: [card({ permitHistory: "first_time", quotaFull: true, badge: "sponsor_confirmed", contractMonths: 24 })] }) });
    for (const t of ["Sponsor confirmed", "First-time sponsor", "Permit quota full", "Fixed term, 2 years", "Checked today", ">EC<", 'href="/jobs/staff-nurse-cork-1042"', 'href="/companies/example-care"']) expect(h).toContain(t);
    expect(h).not.toContain("<img");
    expect(view({ list: ok({ jobs: [card({ lastCheckedAt: null })] }) })).toContain("Posted 3 days ago");
  });
  it("shows an alert that cannot hold a keyword as a note, not a form", () => {
    const h = view({ signedIn: true, state: parseSearch({ q: "nurse" }) });
    expect(h).toContain("not a keyword");
    expect(h).not.toContain('aria-label="Create alert"');
  });
});

describe("nothing from a frame ships", () => {
  it("has no sample tag, mock text, old brand, Launch B chip, Trusted Partner chip or hybrid tags", () => {
    const h = view({ signedIn: true, list: ok({ next: "n" }) });
    for (const t of ["Sample", "sample jobs", "Permitly", "Launch B", "Trusted Partner", "Hybrid", "Full time"]) expect(h).not.toContain(t);
  });
  it("escapes hostile text and has no raw html", () => {
    const evil = "<script>alert(1)</script>";
    const h = view({ state: parseSearch({ q: evil }), list: ok({ jobs: [card({ title: evil, employerName: evil, county: evil })] }) });
    expect(h).not.toContain("<script>alert");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("dangerouslySetInnerHTML");
  });
});
