// Unit (check 3): the company page body (P9, frame C12) rendered to HTML for every state: a company with permits, no DETE link (not linked, first-time), claims removed, no live jobs,
// the visitor limit, signed in with paging; the chart's pure functions; a hostile website. Fixtures only, no database.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NOW, card } from "../jobs/test-fixtures";
import { MONTHS_SHOWN, monthSeries, yearBars } from "./chart";
import { CLAIMS_REMOVED, CompanyView, FIRST_TIME, NOT_LINKED, NameTitle, siteOf, type CompanyData } from "./company-view";

vi.mock("server-only", () => ({}));

const permits: NonNullable<CompanyData["permits"]> = {
  byYear: [{ year: 2022, permits: 31 }, { year: 2023, permits: 44 }, { year: 2024, permits: 52 }, { year: 2025, permits: 61 }, { year: 2026, permits: 38 }],
  peakYear: 2025, trend: "up", latestMonth: { year: 2026, month: 8, permits: 6 },
  byMonth: [{ year: 2026, month: 6, permits: 5 }, { year: 2026, month: 8, permits: 6 }], dataThrough: { year: 2026, month: 8 },
};
const company = (o: Partial<CompanyData> = {}): CompanyData => ({
  id: "77", slug: "example-care", name: "Example Care Group Ltd", website: "https://www.example-care.test/about", logoUrl: null, shortDescription: "A made-up care group.", county: "Cork", claimed: true,
  labels: ["Public sector pay scale employer"], names: [{ name: "Example Care Group Limited", kind: "legal" }, { name: "Example Care", kind: "alias" }], permits,
  jobs: { jobs: [card({ id: "1", title: "Staff Nurse" }), card({ id: "2", title: "Cook" })], count: { n: 2, more: false }, signInForMore: false }, ...o,
});
const view = (o: Partial<Parameters<typeof CompanyView>[0]> = {}) => html(<CompanyView company={company()} now={NOW} signedIn={false} savedIds={[]} path="/companies/example-care" {...o} />);

describe("a company with permit history", () => {
  const h = view();
  it("shows the name with its last words on a band, the place, the website host, the claimed mark and the label", () => {
    expect(h).toMatch(/<h1[^>]*>Example Care <span[^>]*>Group Ltd<\/span><\/h1>/);
    for (const t of ["Cork", "example-care.test", "Claimed", "Public sector pay scale employer", "A made-up care group."]) expect(h).toContain(t);
    expect(h.match(/<h1\b/g)).toHaveLength(1);
  });
  it("shows the permits since 2019 as the sum of the years, the chart bars with their figures, and the three side cards", () => {
    expect(h).toMatch(/data-permit-total[^>]*>226</); // 31 + 44 + 52 + 61 + 38
    for (const y of [2022, 2023, 2024, 2025, 2026]) expect(h).toContain(`>${y}<`);
    expect(h).toContain('data-bar="peak"');
    expect(h).toContain("Peak year");
    expect(h).toContain("Rising");
    expect(h).toContain("2025 had 61 permits, 2024 had 52 permits.");
    expect(h).toContain("Aug 2026");
    expect(h).toContain("6 permits");
    expect(h).toContain("2026 covers January to August.");
  });
  it("has the per month view as a native radio switch (no script) with twenty-four months ending at the cut-off", () => {
    expect(h).toContain('id="chart-month"');
    expect(h).not.toContain("<script");
    expect((h.match(/data-chart="month"[\s\S]*?<\/ol>/)![0].match(/<li /g) ?? []).length).toBe(MONTHS_SHOWN);
  });
  it("lists the names and links the jobs, and shows nothing the decisions dropped (CRO, sector, alert, sample tags, the demo of labels on other companies)", () => {
    expect(h).toContain("Legal name");
    expect(h).toContain("Also known as");
    expect(h).toContain("2 live jobs");
    for (const t of ["CRO", "Get alerts", "Sample", "sample", "Health and social work", "How the labels look"]) expect(h).not.toContain(t);
  });
  it("sends a visitor to log in to report the company, and a signed-in candidate gets the report control", () => {
    expect(h).toContain("Log in to report this company");
    expect(h).toContain("/login?next=%2Fcompanies%2Fexample-care");
    const s = view({ signedIn: true });
    expect(s).toContain("Report this company");
    expect(s).not.toContain("Log in to report");
    expect(s).not.toContain("data-join");
    expect(h).toContain("data-join");
  });
  it("has a neutral block where the frame has a photo, and no image", () => {
    expect(h).toContain("data-photo-block");
    expect(h).not.toContain("<img");
  });
});

describe("a company with no permit figures", () => {
  const none = (labels: string[]) => view({ company: company({ permits: null, labels }) });
  it("says why, by the label, and shows no chart and no total", () => {
    expect(none(["Permit history not linked yet"])).toContain(NOT_LINKED);
    expect(none(["First-time sponsor"])).toContain(FIRST_TIME);
    expect(none([])).toContain("There are no DETE permit figures for this company.");
    for (const h of [none(["Permit history not linked yet"]), none([])]) {
      expect(h).not.toContain("data-permit-chart");
      expect(h).not.toContain("data-permit-total");
      expect(h).toContain("data-history-empty");
    }
  });
  it("says in words that a company with removed claims lost them", () => {
    expect(none(["Sponsorship claims removed"])).toContain(CLAIMS_REMOVED);
  });
  it("has no per month switch when the data has no cut-off month", () => {
    const h = view({ company: company({ permits: { ...permits, byMonth: [], dataThrough: null, latestMonth: null } }) });
    expect(h).not.toContain('id="chart-month"');
  });
});

describe("the jobs of the company", () => {
  it("a company with no live job still has its page and says so", () => {
    const h = view({ company: company({ jobs: { jobs: [], count: { n: 0, more: false }, signInForMore: false } }) });
    expect(h).toContain("0 live jobs");
    expect(h).toContain("This company has no live jobs right now.");
    expect(h).toContain("data-permit-chart");
  });
  it("shows the blurred rows and the sign-in box for a visitor over the limit, and the pager for a signed-in candidate", () => {
    const over = view({ company: company({ jobs: { jobs: Array.from({ length: 6 }, (_, i) => card({ id: String(i) })), count: { n: 9, more: false }, signInForMore: true } }) });
    expect(over).toContain("data-sign-in-for-more");
    expect(over).toContain("You can see 6 of 9");
    expect(over).not.toContain('aria-label="Pagination"');
    const paged = view({ signedIn: true, savedIds: ["1"], prevHref: "/companies/example-care", nextHref: "/companies/example-care?after=c1&back=" });
    expect(paged).toContain('aria-label="Pagination"');
    expect(paged).toContain('rel="next"');
    expect(paged).toContain("Saved: Staff Nurse");
  });
  it("counts 200 or more as '200+'", () => {
    expect(view({ company: company({ jobs: { jobs: [card()], count: { n: 200, more: true }, signInForMore: false } }) })).toContain("200+ live jobs");
  });
});

describe("the chart's pure parts", () => {
  it("marks the peak year and the last five years", () => {
    const bars = yearBars([{ year: 2019, permits: 12 }, { year: 2022, permits: 31 }, { year: 2026, permits: 38 }], 2022, 2026);
    expect(bars).toEqual([{ year: 2019, permits: 12, peak: false, recent: false }, { year: 2022, permits: 31, peak: true, recent: true }, { year: 2026, permits: 38, peak: false, recent: true }]);
  });
  it("fills every month of the last 24, zero where there is none, across a year end", () => {
    const s = monthSeries([{ year: 2025, month: 12, permits: 4 }, { year: 2026, month: 2, permits: 1 }], { year: 2026, month: 3 });
    expect(s).toHaveLength(24);
    expect(s.at(-1)).toEqual({ year: 2026, month: 3, permits: 0 });
    expect(s.at(-2)).toEqual({ year: 2026, month: 2, permits: 1 });
    expect(s.at(-4)).toEqual({ year: 2025, month: 12, permits: 4 });
    expect(s[0]).toEqual({ year: 2024, month: 4, permits: 0 });
  });
});

describe("hostile company data", () => {
  it("shows only an http or https website, never a script address", () => {
    expect(siteOf("javascript:alert(1)")).toBeNull();
    expect(siteOf("data:text/html,x")).toBeNull();
    expect(siteOf("not a url")).toBeNull();
    expect(siteOf(null)).toBeNull();
    expect(siteOf("https://www.example.test/a")).toEqual({ host: "example.test", href: "https://www.example.test/a" });
    expect(view({ company: company({ website: "javascript:alert(1)" }) })).not.toContain("javascript:");
    expect(view()).toContain('rel="noopener noreferrer nofollow"');
  });
  it("escapes a name and a description full of markup", () => {
    const h = view({ company: company({ name: "<img src=x onerror=1> Ltd", shortDescription: "<script>1</script>" }) });
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script");
  });
  it("puts no band on a one-word name and one word on a two-word name", () => {
    expect(html(<NameTitle name="Acme" />)).toBe("Acme");
    expect(html(<NameTitle name="Acme Care" />)).toMatch(/^Acme <span[^>]*>Care<\/span>$/);
    expect(html(<NameTitle name="A B C D" />)).toMatch(/^A B <span[^>]*>C D<\/span>$/);
  });
});
