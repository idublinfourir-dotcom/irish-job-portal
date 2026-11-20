// Unit: the JSON-LD reader, the Irish filters, the sitemap reader and the four career-site adapters, on saved bodies through the fake fetch.
import { describe, expect, it } from "vitest";
import { FetchFailedError } from "../types";
import { fake, none, noSleep } from "../ats/testkit";
import { eightfoldIrish, fetchEightfold, fetchPhenom, fetchSalesforce, fetchSitemap, jobPosting, readPosting, SALESFORCE_JOBS } from "./careers";
import { EF, page, PH, read, SF, sites, SM } from "./testkit";

const posting = (name: string) => readPosting(jobPosting(read(name))!);
const ld = (...blocks: string[]) => `<html><head>${blocks.map((b) => `<script type="application/ld+json">${b}</script>`).join("")}</head></html>`;

describe("JSON-LD JobPosting reader", () => {
  it("Citi: identifier is the Workday id, the place is IE, no employment type", () => {
    const p = posting("citi-103214426512.html");
    expect(p).toMatchObject({ id: "261007676", title: "Data Engineer (Officer)", location: "Dublin, Ireland", irish: true, employmentType: "", datePosted: "2026-11-12", url: "https://jobs.citi.com/job/dublin/data-engineer-officer/287/103214426512" });
    expect(p.description.startsWith("Discover your future at Citi")).toBe(true);
    expect(p.description).not.toMatch(/<\/?[a-z]/);
  });
  it("Phenom: the description escaped twice comes out as plain text", () => {
    const p = posting("phenom-mastercard-R-291229.html");
    expect(p).toMatchObject({ id: "R-291229", title: "Senior Enterprise Operations Engineer", location: "Dublin 18, Ireland", irish: true, employmentType: "FULL_TIME", datePosted: "2026-11-17" });
    expect(p.description.startsWith("Our Purpose")).toBe(true);
    expect(p.description).not.toMatch(/&lt;|&gt;|<\/?[a-z]/);
    expect(posting("phenom-statestreet-R-793506.html")).toMatchObject({ id: "R-793506", employmentType: "OTHER, FULL_TIME", location: "Dublin, Ireland" });
    expect(posting("phenom-abbott-31165733.html")).toMatchObject({ id: "31165733", title: "Warehouse Operator", location: "Kilkenny, Ireland" });
  });
  it("Fidelity: the script type written application/ld&#x2B;json is found", () => {
    expect(read("fidelity-2136526.html")).toContain('type="application/ld&#x2B;json"');
    expect(posting("fidelity-2136526.html")).toMatchObject({ id: "2136526", title: "Data Engineer", location: "Galway, Ireland", irish: true, employmentType: "OTHER" });
  });
  it("missing fields are empty, never a throw; no JobPosting is null", () => {
    expect(readPosting({ "@type": "JobPosting" })).toEqual({ id: "", title: "", description: "", datePosted: "", location: "", irish: false, employmentType: "", url: "", org: "", salary: "" });
    expect(readPosting({ "@type": "JobPosting", identifier: 42, title: ["x"], jobLocation: "Dublin", employmentType: [null, "FULL_TIME"] })).toMatchObject({ id: "42", title: "", irish: false, employmentType: "FULL_TIME" });
    expect(jobPosting("<html>no scripts</html>")).toBeNull();
    expect(jobPosting(ld('{"@type":"WebPage"}', '{"@type":"BreadcrumbList"}'))).toBeNull();
  });
  it("passes over bad JSON and other scripts; finds a posting in a list, in @graph, or with @type as a list", () => {
    const want = { "@type": "JobPosting", title: "T" };
    expect(jobPosting(`<script>var x = {"@type":"JobPosting"}</script>${ld("{bad json", JSON.stringify(want))}`)).toEqual(want);
    expect(jobPosting(ld(JSON.stringify([{ "@type": "WebPage" }, want])))).toEqual(want);
    expect(jobPosting(ld(JSON.stringify({ "@graph": [{ "@type": "Organization" }, want] })))).toEqual(want);
    expect(jobPosting(ld(JSON.stringify({ "@type": ["Thing", "JobPosting"], title: "L" })))).toMatchObject({ title: "L" });
    expect(jobPosting(`<SCRIPT TYPE='application/ld+json'>${JSON.stringify(want)}</SCRIPT >`)).toEqual(want);
  });
});

describe("Irish filters", () => {
  const place = (country: unknown, locality = "X") => ({ "@type": "Place", address: { addressCountry: country, addressLocality: locality } });
  it("an Irish addressCountry is Ireland, IE or IRL, as text or as a named country", () => {
    for (const c of ["Ireland", "IE", "ie", " IRL ", { name: "Ireland" }]) expect(readPosting({ jobLocation: place(c) }).irish, JSON.stringify(c)).toBe(true);
    for (const c of ["United Kingdom", "GB", "Northern Ireland", "", null, 7]) expect(readPosting({ jobLocation: place(c) }).irish, JSON.stringify(c)).toBe(false);
  });
  it("a job with many places keeps only its Irish ones in the location", () => {
    expect(readPosting({ jobLocation: [place("United Kingdom", "Paisley"), place("Ireland", "Remote"), place("IE", "Remote")] })).toMatchObject({ irish: true, location: "Remote, Ireland" });
  });
  it("Phenom: a job the Ireland filter lists but whose page is in the UK is dropped after its page, and is not seen", async () => {
    const uk = read("phenom-thermofisher-R-01367934.html").replace('"addressCountry": "Ireland"', '"addressCountry": "United Kingdom"').replace(/"addressCountry":"Ireland"/g, '"addressCountry":"United Kingdom"');
    expect(readPosting(jobPosting(uk)!).irish).toBe(false);
    const { fetch } = fake(sites((url) => (url.includes("/job/R-01367934/") ? page(uk) : undefined)));
    const r = await fetchPhenom(PH.thermofisher, none, fetch, noSleep);
    expect(r.seen).toEqual(["phenom:thermofisher:R-01369062"]);
    expect(r.adverts.map((a) => a.id)).toEqual(["phenom:thermofisher:R-01369062"]);
  });
  it("Salesforce: only rows whose Countries has Ireland", async () => {
    const { fetch, calls } = fake(sites());
    const r = await fetchSalesforce(SF, none, fetch, noSleep);
    expect(calls.map((c) => c.url)).toEqual([SALESFORCE_JOBS]);
    expect(r.seen).toEqual(["salesforce:salesforce:JR317362", "salesforce:salesforce:JR327834"]);
    expect(r.adverts[0]).toMatchObject({ source: "salesforce", board: "salesforce", employer: "Salesforce (SFDC)", location: "Ireland - Dublin", employmentType: "Full time", url: expect.stringContaining("_JR317362") });
    expect(r.adverts[0]!.description).not.toMatch(/<\/?[a-z]/);
    expect((await fetchSalesforce(SF, new Set(["salesforce:salesforce:JR317362"]), fetch, noSleep)).adverts.map((a) => a.id)).toEqual(["salesforce:salesforce:JR327834"]);
  });
});

describe("phenom", () => {
  it("one POST with the site's body and the Ireland filter, then a page per Irish job; a job listed in another country gets no page", async () => {
    const { fetch, calls } = fake(sites());
    const r = await fetchPhenom(PH.thermofisher, none, fetch, noSleep);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://jobs.thermofisher.com/widgets",
      "GET https://jobs.thermofisher.com/global/en/job/R-01367934/CMBL-Scientist-I",
      "GET https://jobs.thermofisher.com/global/en/job/R-01369062/Account-Manager",
    ]);
    expect(calls[0]!.body).toMatchObject({ lang: "en_global", country: "global", pageId: "page13", from: 0, size: 50, ddoKey: "refineSearch", selected_fields: { country: ["Ireland"] } });
    expect(r.seen).toEqual(["phenom:thermofisher:R-01367934", "phenom:thermofisher:R-01369062"]);
    expect(r.adverts[1]).toMatchObject({ id: "phenom:thermofisher:R-01369062", title: "Account Manager", location: "Remote, Ireland", employer: "Thermo Fisher (PPD)", url: "https://jobs.thermofisher.com/global/en/job/R-01369062/Account-Manager" });
  });
  it("a known id is seen with no page call", async () => {
    const { fetch, calls } = fake(sites());
    const r = await fetchPhenom(PH.thermofisher, new Set(["phenom:thermofisher:R-01367934"]), fetch, noSleep);
    expect(calls).toHaveLength(2);
    expect(r.seen).toHaveLength(2);
    expect(r.adverts.map((a) => a.id)).toEqual(["phenom:thermofisher:R-01369062"]);
  });
  it("pages of 50 until totalHits; a job on two pages is one job", async () => {
    const job = (i: number) => ({ reqId: `R-${i}`, title: "T", country: "Ireland" });
    const { fetch, calls } = fake((c) => {
      if (c.method !== "POST") return page("no posting");
      const from = (c.body as { from: number }).from;
      return page(JSON.stringify({ refineSearch: { totalHits: 85, data: { jobs: Array.from({ length: from ? 35 : 50 }, (_, i) => job(from ? from + i - 1 : i)) } } }));
    });
    const r = await fetchPhenom(PH.mastercard, none, fetch, noSleep);
    expect(calls.filter((c) => c.method === "POST").map((c) => (c.body as { from: number }).from)).toEqual([0, 50]);
    expect(r.seen).toHaveLength(84); // R-49 is on both pages
  });
  it("a page that fails saves nothing but keeps its job seen; a refused page for the rate limit fails the board", async () => {
    const down = fake(sites((url) => (url.includes("/job/") ? page("boom", 500) : undefined)));
    expect(await fetchPhenom(PH.thermofisher, none, down.fetch, noSleep)).toEqual({ seen: ["phenom:thermofisher:R-01367934", "phenom:thermofisher:R-01369062"], adverts: [] });
    const limited = fake(sites((url) => (url.includes("/job/") ? page("slow down", 429) : undefined)));
    await expect(fetchPhenom(PH.thermofisher, none, limited.fetch, noSleep)).rejects.toThrow(/HTTP 429/);
  });
  it("a listing that fails or has the wrong shape fails the board", async () => {
    await expect(fetchPhenom(PH.mastercard, none, fake(() => page("err", 500)).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    await expect(fetchPhenom(PH.mastercard, none, fake(() => page('{"refineSearch":{"data":{}}}')).fetch, noSleep)).rejects.toThrow(/unexpected response shape/);
    await expect(fetchPhenom(PH.mastercard, none, fake(() => page("<html>challenge</html>")).fetch, noSleep)).rejects.toThrow(/unexpected response shape/);
  });
  it("pauses PACE.siteCallGapMs between calls", async () => {
    const waits: number[] = [];
    await fetchPhenom(PH.thermofisher, none, fake(sites()).fetch, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([2000, 2000]);
  });
});

describe("sitemap", () => {
  it("Citi (id from the page): only the Dublin job URLs, each page read, the JobPosting's identifier is the id", async () => {
    const { fetch, calls } = fake(sites());
    const r = await fetchSitemap(SM.citi, none, fetch, noSleep);
    expect(calls.map((c) => c.url)).toEqual([
      "https://jobs.citi.com/sitemap.xml",
      "https://jobs.citi.com/job/dublin/operations-readiness-lead-analyst-digital-assets/287/103381223888",
      "https://jobs.citi.com/job/dublin/data-engineer-officer/287/103214426512",
    ]);
    expect(r.seen).toContain("sitemap:citi:261007676");
    expect(r.seen).toHaveLength(2);
    expect(r.adverts.find((a) => a.id === "sitemap:citi:261007676")).toMatchObject({ title: "Data Engineer (Officer)", url: "https://jobs.citi.com/job/dublin/data-engineer-officer/287/103214426512", employer: "Citi" });
    // known: the pages are still read (the URL has no Workday id), but no record is handed over
    expect((await fetchSitemap(SM.citi, new Set(r.seen), fetch, noSleep)).adverts).toEqual([]);
  });
  it("Fidelity (id from the URL): only /ie/jobs/<id>/ pages; a known id costs no page call", async () => {
    const { fetch, calls } = fake(sites());
    const r = await fetchSitemap(SM.fmr, none, fetch, noSleep);
    expect(calls).toHaveLength(3);
    expect(r.seen).toEqual(["sitemap:fmr:2136258", "sitemap:fmr:2136526"]);
    expect(r.adverts.map((a) => [a.id, a.location])).toEqual([["sitemap:fmr:2136258", expect.stringContaining("Ireland")], ["sitemap:fmr:2136526", "Galway, Ireland"]]);
    const again = fake(sites());
    expect(await fetchSitemap(SM.fmr, new Set(r.seen), again.fetch, noSleep)).toEqual({ seen: r.seen, adverts: [] });
    expect(again.calls).toHaveLength(1);
  });
  it("walks a sitemap index: every file it lists, on the same host", async () => {
    const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://jobs.fidelity.com/s1.xml</loc></sitemap><sitemap><loc>https://jobs.fidelity.com/s2.xml?a=1&amp;b=2</loc></sitemap></sitemapindex>`;
    const set = (id: string) => `<urlset><url><loc>https://jobs.fidelity.com/ie/jobs/${id}/x/</loc></url></urlset>`;
    const { fetch, calls } = fake((c) => {
      const u = new URL(c.url);
      if (u.pathname === "/sitemap.xml") return page(index);
      if (u.pathname === "/s1.xml") return page(set("2136526"));
      if (u.pathname === "/s2.xml") return page(set("2136258"));
      return page("not found", 404);
    });
    const r = await fetchSitemap(SM.fmr, new Set(["sitemap:fmr:2136526", "sitemap:fmr:2136258"]), fetch, noSleep);
    expect(calls.map((c) => c.url)).toEqual(["https://jobs.fidelity.com/sitemap.xml", "https://jobs.fidelity.com/s1.xml", "https://jobs.fidelity.com/s2.xml?a=1&b=2"]);
    expect(r.seen).toEqual(["sitemap:fmr:2136526", "sitemap:fmr:2136258"]);
  });
  it("a sitemap that fails fails the board; an empty one is an empty board", async () => {
    await expect(fetchSitemap(SM.fmr, none, fake(() => page("err", 503)).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    expect(await fetchSitemap(SM.fmr, none, fake(() => page("<urlset></urlset>")).fetch, noSleep)).toEqual({ seen: [], adverts: [] });
  });
});

describe("eightfold", () => {
  const SEARCH = "https://careers.appliedmaterials.com/api/pcsx/search?domain=appliedmaterials.com&query=&location=Ireland&start=";
  const detail = (pid: string) => `https://careers.appliedmaterials.com/api/pcsx/position_details?position_id=${pid}&domain=appliedmaterials.com&hl=en`;
  it("Irish filter: a Leixlip job is kept, a 7-city job without IRL is dropped, only the Irish places are the location", () => {
    expect(eightfoldIrish({ locations: ["Leixlip,IRL"] })).toBe("Leixlip, Ireland");
    expect(eightfoldIrish({ locations: ["Eindhoven,NLD", "Milan,ITA", "England-Berkshire,GBR", "Bernin,FRA", "Grenoble,FRA", "Munich,DEU", "Dresden,DEU"] })).toBe("");
    expect(eightfoldIrish({ locations: ["England-Berkshire,GBR", "Dublin,IRL", "Leixlip,IRL", "Dublin,IRL"] })).toBe("Dublin, Ireland / Leixlip, Ireland");
    for (const locations of [undefined, [], ["IRL"], ["Belfast,GBR"], ["Ireland"], [7, null]]) expect(eightfoldIrish({ locations }), JSON.stringify(locations)).toBe("");
  });
  it("pages start=0 and start=10 until count 13, then one detail call per new job; ids are eightfold:amat:<R-number>", async () => {
    const { fetch, calls } = fake(sites());
    const r = await fetchEightfold(EF, none, fetch, noSleep);
    expect(calls.slice(0, 2).map((c) => c.url)).toEqual([`${SEARCH}0&sort_by=relevance`, `${SEARCH}10&sort_by=relevance`]);
    expect(calls).toHaveLength(2 + 13);
    expect(calls[2]!.url).toBe(detail("790314592423"));
    expect(r.seen).toHaveLength(13);
    expect(r.seen.every((id) => /^eightfold:amat:R\d{7}$/.test(id))).toBe(true);
    expect(r.adverts[0]).toMatchObject({ id: "eightfold:amat:R2614187", source: "eightfold", board: "amat", employer: "Applied Materials", title: "Customer Support Technician", location: "Leixlip, Ireland", url: "https://careers.appliedmaterials.com/careers/job/790314592423" });
    expect(r.adverts.find((a) => a.id === "eightfold:amat:R2632370")).toMatchObject({ title: "Data Scientist - EMEA", location: "Dublin, Ireland" });
  });
  it("the description HTML comes out as text", async () => {
    const r = await fetchEightfold(EF, none, fake(sites()).fetch, noSleep);
    const d = r.adverts.find((a) => a.id === "eightfold:amat:R2632370")!.description;
    expect(d.startsWith("Who We Are")).toBe(true);
    expect(d).toContain("Applied Materials is the global leader");
    expect(d).not.toMatch(/<\/?[a-z]|&nbsp;|&amp;/);
  });
  it("a known id costs no detail call; a job listed with no Irish place is dropped before its detail call", async () => {
    const { fetch, calls } = fake(sites());
    const all = await fetchEightfold(EF, none, fetch, noSleep);
    calls.length = 0;
    expect(await fetchEightfold(EF, new Set(all.seen), fetch, noSleep)).toEqual({ seen: all.seen, adverts: [] });
    expect(calls).toHaveLength(2);
    const noIrl = read("eightfold-amat-search-10.json").replace(/"Dublin,IRL",\s*/g, "").replace(/,\s*"Leixlip,IRL"/g, "");
    const two = fake(sites((url) => (url.includes("start=10") ? page(noIrl) : undefined)));
    const r = await fetchEightfold(EF, none, two.fetch, noSleep);
    expect(r.seen).toHaveLength(11);
    expect(r.seen).not.toContain("eightfold:amat:R2632370");
    expect(two.calls.some((c) => c.url.includes("790319296162"))).toBe(false);
  });
  it("a detail call that fails keeps its job seen but saves nothing; one refused for the rate limit fails the board", async () => {
    const down = fake(sites((url) => (url.includes("position_details") ? page("boom", 500) : undefined)));
    const r = await fetchEightfold(EF, none, down.fetch, noSleep);
    expect([r.seen.length, r.adverts.length]).toEqual([13, 0]);
    const odd = fake(sites((url) => (url.includes("position_details") ? page('{"data":{"jobDescription":7}}') : undefined)));
    expect((await fetchEightfold(EF, none, odd.fetch, noSleep)).adverts).toEqual([]);
    const limited = fake(sites((url) => (url.includes("position_details") ? page("slow down", 429) : undefined)));
    await expect(fetchEightfold(EF, none, limited.fetch, noSleep)).rejects.toThrow(/HTTP 429/);
  });
  it("a listing that fails or has the wrong shape fails the board; an empty page stops the paging", async () => {
    await expect(fetchEightfold(EF, none, fake(() => page("err", 500)).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    await expect(fetchEightfold(EF, none, fake(() => page('{"data":{"count":3}}')).fetch, noSleep)).rejects.toThrow(/unexpected response shape/);
    await expect(fetchEightfold(EF, none, fake(() => page("<html>challenge</html>")).fetch, noSleep)).rejects.toThrow(/body is not JSON/);
    const empty = fake(() => page('{"data":{"positions":[],"count":99}}'));
    expect(await fetchEightfold(EF, none, empty.fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    expect(empty.calls).toHaveLength(1);
  });
  it("pauses PACE.siteCallGapMs between calls", async () => {
    const waits: number[] = [];
    await fetchEightfold(EF, none, fake(sites()).fetch, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual(Array(14).fill(2000));
  });
});
