import { describe, expect, it } from "vitest";
import { LEGAL_PAGES, partIds, SITEMAP_QUERIES, SITEMAP_URLS, sitemapIndexXml, sitemapPart, STATIC_PAGES } from "./sitemap";

describe("the sitemap parts (S13)", () => {
  it("cut each kind at the protocol's 50,000 URLs a file, with one part even when empty", () => {
    expect(SITEMAP_URLS).toBe(50_000);
    expect(partIds("jobs", 0)).toEqual(["jobs-0"]);
    expect(partIds("jobs", 50_000)).toEqual(["jobs-0"]);
    expect(partIds("jobs", 50_001)).toEqual(["jobs-0", "jobs-1"]);
    expect(partIds("companies", 120_000)).toEqual(["companies-0", "companies-1", "companies-2"]);
  });
  it("refuse an id that is not a part before any statement, and read part n from offset n times 50,000", async () => {
    const seen: unknown[][] = [];
    const db = { query: (async (_t: string, v: unknown[]) => (seen.push(v), { rows: [] })) as never };
    for (const id of ["", "jobs", "jobs-", "jobs-x", "jobs-12345", "page-0", "pages", "jobs-0;drop", "../jobs-0", "JOBS-0", "jobs--1"]) expect(await sitemapPart(db, id), id).toBeNull();
    expect(seen).toEqual([]);
    await sitemapPart(db, "jobs-2");
    await sitemapPart(db, "companies-1");
    expect(seen).toEqual([[100_000], [50_000]]);
  });
  it("lists only live, unexpired jobs and only companies with a page", () => {
    expect(SITEMAP_QUERIES.jobs).toContain("job.status = 'live' and job.closes_at > now()");
    expect(SITEMAP_QUERIES.companies).toContain("o.status not in ('rejected', 'closed') and o.merged_into_id is null");
  });
});

describe("the sitemap index and the content parts (B21)", () => {
  it("lists every file at /sitemap/<id>.xml, escaped, in the order given", () => {
    const xml = sitemapIndexXml("https://example.test", ["jobs-0", "pages-0"]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect(xml).toContain("<sitemap><loc>https://example.test/sitemap/jobs-0.xml</loc></sitemap>");
    expect(xml.indexOf("jobs-0")).toBeLessThan(xml.indexOf("pages-0"));
    expect(sitemapIndexXml("https://a.test/?x=1&y=<2>", ["a-0"])).toContain("https://a.test/?x=1&amp;y=&lt;2&gt;/sitemap/a-0.xml");
    expect(sitemapIndexXml("https://a.test", [])).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</sitemapindex>\n');
  });
  it("gives the static pages and the legal texts in force in pages-0, and each content kind from its own statement", async () => {
    const seen: [string, unknown[] | undefined][] = [];
    const db = { query: (async (t: string, v?: unknown[]) => (seen.push([t, v]), { rows: t === SITEMAP_QUERIES.legal ? [{ key: "cookie_policy", modified: new Date("2026-11-20T10:00:00Z") }] : [{ key: "a-slug", modified: null }] })) as never };
    const pages = (await sitemapPart(db, "pages-0"))!;
    expect(pages.filter((e) => e.kind === "page").map((e) => e.key)).toEqual([...STATIC_PAGES]);
    expect(pages.at(-1)).toEqual({ kind: "legal", key: "cookie_policy", lastModified: "2026-11-20T10:00:00.000Z" });
    expect(seen[0]).toEqual([SITEMAP_QUERIES.legal, [LEGAL_PAGES]]);
    expect(await sitemapPart(db, "guides-0")).toEqual([{ kind: "guide", key: "a-slug" }]);
    expect(await sitemapPart(db, "updates-0")).toEqual([{ kind: "update", key: "a-slug" }]);
    expect(await sitemapPart(db, "help-0")).toEqual([{ kind: "help", key: "a-slug" }]);
    expect(seen.slice(1).map((s) => s[1])).toEqual([["guide"], ["update"], ["help"]]);
    expect(await sitemapPart(db, "pages-1")).toEqual([]);
    expect(await sitemapPart(db, "guides-3")).toEqual([]);
  });
  it("lists only published content and only the legal texts that have a public page", () => {
    expect(SITEMAP_QUERIES.content).toContain("from published_content_page where kind = $1");
    expect(SITEMAP_QUERIES.occupationTexts).toContain("from published_content_page");
    expect(LEGAL_PAGES).not.toContain("portal_signup_terms");
  });
});
