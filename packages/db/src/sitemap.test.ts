import { describe, expect, it } from "vitest";
import { partIds, SITEMAP_QUERIES, SITEMAP_URLS, sitemapPart } from "./sitemap";

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
    for (const id of ["", "jobs", "jobs-", "jobs-x", "jobs-12345", "pages-0", "jobs-0;drop", "../jobs-0", "JOBS-0", "jobs--1"]) expect(await sitemapPart(db, id), id).toBeNull();
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
