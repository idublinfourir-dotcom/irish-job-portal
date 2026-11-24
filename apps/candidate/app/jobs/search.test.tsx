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

describe("visitor, frame N02", () => {
  const n02 = (o: Partial<SearchProps> = {}) => view({ state: parseSearch({ q: "nurse", county: "Cork", sector: "health", badge: "sponsor_confirmed" }), minimums: { criticalSkills: 41000, minContractMonths: 24, rulesCheckedOn: "2026-11-12" }, sectorCounts: [{ sector: "health", jobs: 7 }], ...o });
  it("has the big heading with the searched words on peach, the county on green, and the permit words on lilac with the shield", () => {
    const h = n02();
    expect(h).toMatch(/<h1[^>]*>.*bg-peach[^>]*>Nurse jobs<\/span> in <span[^>]*bg-deep-green[^>]*>Cork<\/span>.*where a <span[^>]*bg-lilac[^>]*>permit is realistic<\/span>.*data-icon="shield"/);
    expect(h).not.toContain("<img"); // no photo in the heading
    expect(h).not.toContain("with permit sponsorship");
  });
  it("starts the heading with a capital for a sector and for no filter", () => {
    expect(view({ state: parseSearch({ sector: "health" }) })).toContain(">Health jobs</span>");
    expect(view({})).toMatch(/<h1[^>]*>.*>Jobs<\/span>/);
  });
  it("shows the count from the read, large, and rechecked daily; no count without one", () => {
    const h = view({ list: ok({ count: { n: 3, more: false } }) });
    expect(h).toMatch(/data-count-big[^>]*><span[^>]*>3<\/span><span[^>]*>jobs, rechecked daily</);
    expect(view({ list: ok({ count: { n: 200, more: true } }) })).toMatch(/data-count-big[^>]*><span[^>]*>200\+<\/span>/);
    expect(view({ list: ok({ count: null }) })).not.toContain("data-count-big");
  });
  it("has the white bar with title, county and a sector select with counts, and a Find jobs button", () => {
    const h = n02();
    for (const t of ['name="q"', 'name="county"', 'id="sector"', "Health (7)", "Find jobs"]) expect(h).toContain(t);
    expect(h).not.toMatch(/type="radio"[^>]*name="sector"/); // the panel does not repeat the sector (one value in the address)
  });
  it("has the pill row: lilac when set, outline when not, each a details of links, and Sort by", () => {
    const h = n02({ state: parseSearch({ county: "Cork", sector: "health" }) });
    expect(h).toContain("All filters (2)");
    expect(h).toMatch(/<summary[^>]*bg-lilac[^>]*>Sector: Health/);
    expect(h).toMatch(/<summary[^>]*bg-lilac[^>]*>County: Cork/);
    expect(h).toMatch(/<summary[^>]*border-line[^>]*>Badge: any/);
    expect(h).toMatch(/<summary[^>]*border-line[^>]*>Salary: any/);
    expect(h).toContain('href="/jobs?sector=health"'); // County: any link keeps the other filter
    expect(h).toContain("Sort by");
    expect(h).not.toContain("Contract: "); // no contract pill (L46, #247)
    expect(h).not.toMatch(/aria-label="(Grid|List)/); // no grid or list toggle
  });
  it("has the dark alert card with the chips of the filters an alert can hold and the sign in", () => {
    const h = n02();
    expect(h).toMatch(/data-alert-rail.*Get new jobs like these by email/);
    expect(h).toContain("Health");
    expect(h).toContain("Sponsor confirmed");
    expect(h).toContain("Your keyword filter is not saved in it.");
    expect(h).toContain('href="/login?next=');
  });
  it("has the Permit rules card with the minimum and the offer length from the read, and the checker link; none without the read", () => {
    const h = n02();
    for (const t of ["Permit rules", "€41,000 is the minimum salary for a Critical Skills permit", "at least 2 years", "Checked 12 Nov 2026", 'href="/eligibility-checker"', "Open the eligibility checker"]) expect(h).toContain(t);
    expect(h).not.toContain("Rules for nurses");
    expect(h).not.toContain("40,904"); // no figure of its own
    const none = n02({ minimums: null });
    expect(none).not.toContain("Permit rules");
    expect(none).toContain("Got an offer? We can handle your permit");
  });
  it("has the N02 list card: badge row first, title, employer and when, pay and a round arrow, and no View job text", () => {
    const h = view({ list: ok({ jobs: [card({ county: "Cork", contractMonths: 24 })] }) });
    expect(h).toMatch(/data-job-card="1042".*Critical Skills eligible.*Cork · Fixed term, 2 years.*Staff Nurse.*Example Care Ltd.*Checked today/);
    expect(h).toContain('aria-label="View Staff Nurse"');
    expect(h).toContain('aria-label="Log in to save Staff Nurse"');
    expect(h).not.toContain("View job");
  });
  it("keeps the blurred rows and the dark sign-in box over them", () => {
    const h = view({ list: ok({ jobs: [card()], signInForMore: true }) });
    expect(h.match(/data-placeholder/g)).toHaveLength(2);
    expect(h).toContain("data-sign-in-for-more");
  });
  it("says nothing of N02 to a signed-in candidate", () => {
    const h = view({ signedIn: true, minimums: { criticalSkills: 41000, minContractMonths: 24, rulesCheckedOn: "2026-11-12" } });
    for (const t of ["data-alert-rail", "data-rules-rail", "<summary", "data-count-big", "Permit rules"]) expect(h).not.toContain(t);
    expect(h).toContain("View job"); // C04 as W1 built it
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
    expect(h).toContain('data-tile="light"');
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
      [{ salaryLine: "€38,000 to €45,000" }, ">a year<"],
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
    for (const t of ["Sample", "sample jobs", "Permitly", "Launch B", "Trusted Partner", "Hybrid", "Full time", "Rules for nurses"]) expect(view()).not.toContain(t);
  });
  it("escapes hostile text and has no raw html", () => {
    const evil = "<script>alert(1)</script>";
    const h = view({ state: parseSearch({ q: evil }), list: ok({ jobs: [card({ title: evil, employerName: evil, county: evil })] }) });
    expect(h).not.toContain("<script>alert");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("dangerouslySetInnerHTML");
  });
});
