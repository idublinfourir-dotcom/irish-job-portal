// Unit: the pure helpers (no database, no network, no browser).
import { describe, expect, it } from "vitest";
import { activeFilters, ago, contractText, euro, euroText, initials, jobDescription, jobTitleText, loginHref, parseSearch, queryOf, readQuery, searchDescription, searchHeading, searchHref, searchTitle } from "./format";
import { NOW } from "./test-fixtures";

describe("money and dates", () => {
  it("prints euros and turns the read's EUR into the sign", () => {
    expect(euro(40904)).toBe("€40,904");
    expect(euroText("Pay scale for this grade: EUR 38,166 to 56,592")).toBe("Pay scale for this grade: €38,166 to €56,592");
  });
  it("words a date against now", () => {
    expect(ago("2026-11-23T01:00:00.000Z", NOW)).toBe("today");
    expect(ago(new Date("2026-11-22T10:00:00.000Z"), NOW)).toBe("yesterday");
    expect(ago("2026-11-20T10:00:00.000Z", NOW)).toBe("3 days ago");
    expect(ago("2026-11-02T10:00:00.000Z", NOW)).toBe("3 weeks ago");
    expect(ago("2026-05-02T10:00:00.000Z", NOW)).toBe("6 months ago");
    expect(ago(null, NOW)).toBeNull();
    expect(ago("not a date", NOW)).toBeNull();
    expect(ago("2027-01-01T00:00:00.000Z", NOW)).toBe("today"); // a time in the future is never a negative
  });
  it("makes initials and contract text", () => {
    expect(initials("Example Care Ltd")).toBe("EC");
    expect(initials("123 456")).toBe("?");
    expect(contractText(24)).toBe("2 years");
    expect(contractText(12)).toBe("1 year");
    expect(contractText(18)).toBe("18 months");
    expect(contractText(null)).toBeNull();
  });
});

describe("the search query", () => {
  it("keeps the first value of each known key and nothing else", () => {
    const s = parseSearch({ q: [" nurse ", "x"], county: "Cork", sector: "", evil: "1", sort: "newest", after: "tok" });
    expect(s).toEqual({ filters: { q: "nurse", county: "Cork" }, sort: "newest", after: "tok", before: undefined });
    expect(activeFilters(s.filters)).toBe(2);
  });
  it("cuts a hostile long value instead of passing it on whole", () => {
    expect(parseSearch({ q: "a".repeat(5000) }).filters.q).toHaveLength(400);
  });
  it("builds links that keep the filters and never write an empty one", () => {
    const s = parseSearch({ county: "Cork", badge: "sponsor_confirmed" });
    expect(searchHref(s)).toBe("/jobs?county=Cork&badge=sponsor_confirmed");
    expect(searchHref(s, { after: "abc" })).toBe("/jobs?county=Cork&badge=sponsor_confirmed&after=abc");
    expect(searchHref(parseSearch({}))).toBe("/jobs");
    expect(queryOf(parseSearch({ q: "a&b=c" })).toString()).toBe("q=a%26b%3Dc"); // a value cannot add a key
    expect(readQuery(parseSearch({ county: "Cork", after: "t1" })).toString()).toBe("county=Cork&after=t1"); // the read gets the page's token, the page's own links do not
    expect(queryOf(parseSearch({ county: "Cork", after: "t1" })).toString()).toBe("county=Cork");
  });
  it("sends a log in link back only to an own path", () => {
    expect(loginHref("/jobs?county=Cork")).toBe("/login?next=%2Fjobs%3Fcounty%3DCork");
    for (const bad of ["https://evil.test/", "//evil.test", "javascript:alert(1)", "/x\\y"]) expect(loginHref(bad)).toBe("/login");
  });
});

describe("titles and descriptions (frame 01 SEO spec)", () => {
  it("has a title of 60 characters or fewer plus the site name, and a description of 120 to 160", () => {
    for (const f of [{}, { county: "Cork" }, { q: "nurse", county: "Roscommon" }, { q: "x".repeat(300), county: "Westmeath", sector: "construction and engineering" }]) {
      const t = searchTitle(f);
      expect(t.endsWith(" | Irish Work Permit")).toBe(true);
      expect(t.length - " | Irish Work Permit".length).toBeLessThanOrEqual(60);
      const d = searchDescription(f);
      expect(d.length).toBeGreaterThanOrEqual(120);
      expect(d.length).toBeLessThanOrEqual(160);
    }
    expect(searchHeading({ q: "nurse", county: "Cork" })).toBe("Nurse jobs in Cork");
    expect(searchHeading({ county: "Cork'; drop table job;--", sector: "Narnia" })).toBe("Jobs"); // a value the read refuses never reaches a heading or a title
    expect(searchTitle({ county: "<script>" })).toBe("Find a job | Irish Work Permit");
  });
  it("has a job title and description inside the limits whatever the job", () => {
    for (const j of [{ title: "A", employerName: "B", county: null, badge: null }, { title: "T".repeat(200), employerName: "E".repeat(200), county: "Cork", badge: "sponsor_confirmed" }, { title: "Staff Nurse", employerName: "Example Care Ltd", county: "Cork", badge: "critical_skills_eligible" }]) {
      expect(jobTitleText(j).length - " | Irish Work Permit".length).toBeLessThanOrEqual(60);
      const d = jobDescription(j);
      expect(d.length).toBeGreaterThanOrEqual(120);
      expect(d.length).toBeLessThanOrEqual(160);
    }
  });
});
