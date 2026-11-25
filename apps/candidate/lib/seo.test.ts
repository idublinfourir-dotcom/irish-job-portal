// P2: the SEO helpers (pure) and robots.txt. No database, no network: robots reads the site origin from the setting only.
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import robots from "../app/robots";
import { breadcrumbLd, canonicalUrl, descriptionProblem, isFilteredSearch, jobPostingLd, jsonLd, occupationLd, organizationLd, pageDescription, pageMetadata, pageTitle, siteIndexable, titleProblem, websiteLd, type JobLdInput } from "./seo";
import { jobPath, occupationPath } from "./paths";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const ORIGIN = "https://irishworkpermit.example";
const job: JobLdInput = { source: "employer", title: "Fake Cook", advertText: "Fake advert text.", postedAt: new Date("2026-11-17T08:00:00.000Z"), closesAt: new Date("2026-12-17T08:00:00.000Z"), url: `${ORIGIN}/jobs/fake-cook-cork-7`, employerName: "Fake Org Ltd", employerWebsite: "https://example.test", county: "Cork", salaryLow: 40000, salaryHigh: 45000 };

describe("the one indexing setting", () => {
  it("is off unless SITE_INDEXABLE is exactly 1", () => {
    for (const v of [undefined, "", "0", "true", "yes", "1 ", "on"]) expect(siteIndexable({ SITE_INDEXABLE: v }), String(v)).toBe(false);
    expect(siteIndexable({ SITE_INDEXABLE: "1" })).toBe(true);
  });
  it("makes every page noindex while off, and a page may still ask for noindex while on", () => {
    const seo = { title: "Jobs", description: "x".repeat(130), path: "/jobs", origin: ORIGIN };
    expect(pageMetadata(seo, {}).robots).toEqual({ index: false, follow: false });
    expect(pageMetadata(seo, { SITE_INDEXABLE: "1" }).robots).toEqual({ index: true, follow: true });
    expect(pageMetadata({ ...seo, noindex: true }, { SITE_INDEXABLE: "1" }).robots).toEqual({ index: false, follow: false });
  });
  it("gives a canonical address, launched or not, except on a page that asks for noindex", () => {
    const seo = { title: "Jobs", description: "x".repeat(130), path: "/jobs", origin: ORIGIN };
    for (const env of [{}, { SITE_INDEXABLE: "1" }]) {
      expect(pageMetadata(seo, env).alternates).toEqual({ canonical: `${ORIGIN}/jobs` });
      expect(pageMetadata({ ...seo, noindex: true }, env)).not.toHaveProperty("alternates");
    }
  });
});

describe("robots.txt", () => {
  const was = process.env.SITE_INDEXABLE;
  beforeEach(() => Object.assign(process.env, { CANDIDATE_AUTH_URL: ORIGIN, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" }));
  afterEach(() => { if (was === undefined) delete process.env.SITE_INDEXABLE; else process.env.SITE_INDEXABLE = was; });
  it("disallows everything, and lists no sitemap, while indexing is off", () => {
    for (const v of [undefined, "0", "true"]) {
      if (v === undefined) delete process.env.SITE_INDEXABLE; else process.env.SITE_INDEXABLE = v;
      expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    }
  });
  it("when on: allows the public pages, keeps the signed-in areas and the API out, lists the sitemap index", () => {
    process.env.SITE_INDEXABLE = "1";
    const r = robots();
    expect(r.sitemap).toBe(`${ORIGIN}/sitemap-index.xml`);
    const rule = r.rules as { allow: string; disallow: string[] };
    expect(rule.allow).toBe("/");
    for (const p of ["/api/", "/account", "/login", "/signup"]) expect(rule.disallow).toContain(p);
  });
});

describe("title and description", () => {
  it("adds the brand and keeps the title part within 60 characters", () => {
    expect(pageTitle("Find jobs")).toBe("Find jobs | Irish Work Permit");
    for (const t of ["a".repeat(60), "word ".repeat(40), "é".repeat(200), "x"]) {
      const out = pageTitle(t);
      expect(out.endsWith(" | Irish Work Permit")).toBe(true);
      expect(out.length - " | Irish Work Permit".length).toBeLessThanOrEqual(60);
    }
    expect(pageTitle("a".repeat(60))).toBe(`${"a".repeat(60)} | Irish Work Permit`);
  });
  it("cuts at a word end with an ellipsis, and collapses whitespace", () => {
    const out = pageTitle("Senior Registered Nurse in the Intensive Care Unit at a Large Dublin Teaching Hospital");
    expect(out).toMatch(/^Senior Registered Nurse .*… \| Irish Work Permit$/);
    expect(pageTitle("  a   b \n c ")).toBe("a b c | Irish Work Permit");
  });
  it("cuts a description to 160 and names one that is under 120 or over 160", () => {
    const long = "word ".repeat(80);
    expect(pageDescription(long).length).toBeLessThanOrEqual(160);
    expect(descriptionProblem(pageDescription(long))).toBeNull();
    expect(descriptionProblem("x".repeat(119))).toMatch(/under 120/);
    expect(descriptionProblem("x".repeat(121))).toBeNull();
    expect(descriptionProblem("x".repeat(160))).toBeNull();
    expect(descriptionProblem("x".repeat(161))).toMatch(/over 160/);
    expect(pageDescription("short")).toBe("short");
  });
  it("names an empty or over-long title", () => {
    expect(titleProblem("")).toMatch(/empty/);
    expect(titleProblem("x".repeat(61))).toMatch(/over 60/);
    expect(titleProblem("x".repeat(60))).toBeNull();
  });
});

describe("canonical address", () => {
  it("is the origin plus a path made by paths.ts, with no query or fragment", () => {
    expect(canonicalUrl(ORIGIN, jobPath({ id: "7", title: "Fake Cook", county: "Cork" }))).toBe(`${ORIGIN}/jobs/fake-cook-cork-7`);
    expect(canonicalUrl(ORIGIN, occupationPath("staff-nurse"))).toBe(`${ORIGIN}/occupations/staff-nurse`);
    expect(canonicalUrl(`${ORIGIN}/ignored/path`, "/jobs?county=Cork#top")).toBe(`${ORIGIN}/jobs`);
  });
  it("refuses a path that could leave the site", () => {
    for (const p of ["jobs", "//evil.test/x", "https://evil.test/", "", "javascript:alert(1)"]) expect(() => canonicalUrl(ORIGIN, p), p).toThrow();
  });
});

describe("filtered search pages are noindex (#287)", () => {
  it("any filter, sort or cursor makes the address a second copy", () => {
    expect(isFilteredSearch({})).toBe(false);
    expect(isFilteredSearch({ county: "" })).toBe(false);
    for (const q of [{ county: "Cork" }, { q: "cook" }, { after: "abc" }, { sector: ["IT", "health"] }, { sort: "newest" }]) expect(isFilteredSearch(q), JSON.stringify(q)).toBe(true);
  });
});

describe("every page of the site", () => {
  it("sets a canonical address through meta() or legalMeta(), or is noindex: a new page cannot miss both", () => {
    const app = new URL("../app/", import.meta.url).pathname;
    const pages = (readdirSync(app, { recursive: true }) as string[]).filter((f) => /(^|\/)page\.tsx$/.test(f) && !f.startsWith("kit/")); // /kit is a 404 in production
    expect(pages.length).toBeGreaterThan(30);
    expect(pages.filter((f) => !/\b(meta|legalMeta|authMeta)\(|robots: \{ index: false, follow: false \}/.test(readFileSync(app + f, "utf8")))).toEqual([]);
  });
});

describe("JSON-LD", () => {
  it("Organization and WebSite name the brand and the site", () => {
    expect(organizationLd(ORIGIN)).toMatchObject({ "@context": "https://schema.org", "@type": "Organization", name: "Irish Work Permit", url: `${ORIGIN}/` });
    expect(websiteLd(ORIGIN)).toMatchObject({ "@type": "WebSite", name: "Irish Work Permit", url: `${ORIGIN}/` });
  });
  it("Occupation carries the registration body when the rules name one", () => {
    const ld = occupationLd({ name: "Nurses", code: "2231", url: `${ORIGIN}/occupations/nurses`, registrationBody: { name: "NMBI", url: "https://www.nmbi.ie/" } });
    expect(ld).toMatchObject({ "@type": "Occupation", name: "Nurses", occupationalCategory: "2231", qualifications: "Registration with NMBI", sameAs: "https://www.nmbi.ie/" });
    expect(occupationLd({ name: "Cooks", url: `${ORIGIN}/occupations/cooks`, registrationBody: null })).not.toHaveProperty("qualifications");
  });
  it("JobPosting for an employer-posted job, with the pay and place", () => {
    expect(jobPostingLd(job)).toMatchObject({
      "@type": "JobPosting", title: "Fake Cook", datePosted: "2026-11-17T08:00:00.000Z", validThrough: "2026-12-17T08:00:00.000Z", hiringOrganization: { name: "Fake Org Ltd" },
      jobLocation: { address: { addressRegion: "Cork", addressCountry: "IE" } }, baseSalary: { currency: "EUR", value: { minValue: 40000, maxValue: 45000, unitText: "YEAR" } },
    });
  });
  it("NEVER a JobPosting for a fetched job, a staff-posted one, an agency one or an unknown source (#92)", () => {
    for (const source of ["fetched", "admin_manual", "agency", "", "Employer", "employer ", "EMPLOYER", "other"]) expect(jobPostingLd({ ...job, source }), source).toBeNull();
  });
  it("no JobPosting without advert text (the description is required)", () => {
    expect(jobPostingLd({ ...job, advertText: null })).toBeNull();
    expect(jobPostingLd({ ...job, advertText: "" })).toBeNull();
  });
  it("gives one pay figure as a value and a range as its two ends (Google: a value, or a minValue and a maxValue)", () => {
    const pay = (low: number, high: number | null) => ((jobPostingLd({ ...job, salaryLow: low, salaryHigh: high })!.baseSalary as { value: Record<string, unknown> }).value);
    expect(pay(52000, null)).toEqual({ "@type": "QuantitativeValue", value: 52000, unitText: "YEAR" });
    expect(pay(52000, 52000)).toEqual({ "@type": "QuantitativeValue", value: 52000, unitText: "YEAR" });
    expect(pay(52000, 60000)).toEqual({ "@type": "QuantitativeValue", minValue: 52000, maxValue: 60000, unitText: "YEAR" });
  });
  it("keeps the advert text (Google reads the description as HTML), line breaks included", () => {
    expect(jobPostingLd({ ...job, advertText: "Cook & clean.\n<b>Bold</b> &amp; <script>x()</script>" })!.description).toBe("Cook &amp; clean.\n&lt;b&gt;Bold&lt;/b&gt; &amp;amp; &lt;script&gt;x()&lt;/script&gt;");
  });
  it("adds little to the page: the advert once more and under 1,000 characters around it", () => {
    const text = "Plain words about a made-up job. ".repeat(600);
    expect(jsonLd(jobPostingLd({ ...job, advertText: text })!).length).toBeLessThan(text.length + 1000);
  });
  it("BreadcrumbList numbers the crumbs from 1, with absolute addresses, the page itself last without one", () => {
    expect(breadcrumbLd(ORIGIN, [{ label: "Home", href: "/" }, { label: "Nurses" }])).toEqual({
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` }, { "@type": "ListItem", position: 2, name: "Nurses" }],
    });
    // a crumb that is a filtered search (noindex) is left out, and the last crumb never carries an address
    const ld = breadcrumbLd(ORIGIN, [{ label: "Find a job", href: "/jobs" }, { label: "IT", href: "/jobs?sector=IT" }, { label: "Cook", href: "/jobs/cook-1" }]);
    expect((ld.itemListElement as { name: string; item?: string }[]).map((x) => [x.name, x.item])).toEqual([["Find a job", `${ORIGIN}/jobs`], ["Cook", undefined]]);
    for (const href of ["//evil.test/x", "https://evil.test/"]) expect(() => breadcrumbLd(ORIGIN, [{ label: "x", href }, { label: "y" }]), href).toThrow();
  });
  it("leaves out pay it does not have", () => {
    const ld = jobPostingLd({ ...job, salaryLow: null, salaryHigh: null, closesAt: null, county: null })!;
    for (const k of ["baseSalary", "validThrough"]) expect(ld).not.toHaveProperty(k);
  });
  it("can never close the script it sits in", () => {
    const text = jsonLd({ name: "</script><script>alert(1)</script>", other: "a < b" });
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual({ name: "</script><script>alert(1)</script>", other: "a < b" });
  });
});
