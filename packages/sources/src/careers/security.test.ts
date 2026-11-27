// Security: the career-site adapters against hostile sites. Origin lock, size caps, hostile JSON-LD, sitemap bombs, bad board values.
// Everything goes through the fake fetch; a call to any other host is recorded and must never happen.
import { describe, expect, it } from "vitest";
import { fake, none, noSleep, redirect } from "../ats/testkit";
import { fetchEightfold, fetchPhenom, fetchSalesforce, fetchSitemap, jobPosting, locTexts, MAX_LOC, MAX_SITEMAPS, MAX_URLS, readPosting } from "./careers";
import { EF, page, PH, read, SF, sites, SM } from "./testkit";
import { MAX_PAGES } from "../ats/shared";

const hosts = (calls: { url: string }[]) => [...new Set(calls.map((c) => new URL(c.url).host))];
// As the sites write it: "<" escaped inside the JSON, so a "</script>" in a field cannot end the block
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o).replaceAll("<", "\\u003c")}</script>`;
const urlset = (n: number, id = (i: number) => String(i)) => `<urlset>${Array.from({ length: n }, (_, i) => `<url><loc>https://jobs.fidelity.com/ie/jobs/${id(i)}/x/</loc></url>`).join("")}</urlset>`;

describe("origin lock", () => {
  it("a sitemap index that lists a file on another host fails the board, and that host is never called", async () => {
    const { fetch, calls } = fake(() => page(`<sitemapindex><sitemap><loc>https://evil.example/s.xml</loc></sitemap></sitemapindex>`));
    await expect(fetchSitemap(SM.fmr, none, fetch, noSleep)).rejects.toThrow(/refused: request to another host/);
    expect(hosts(calls)).toEqual(["jobs.fidelity.com"]);
  });
  it("job URLs on another host (or on a look-alike host) in a sitemap are never read", async () => {
    const body = `<urlset><url><loc>https://evil.example/ie/jobs/1/x/</loc></url><url><loc>https://jobs.fidelity.com.evil.example/ie/jobs/2/x/</loc></url><url><loc>https://jobs.fidelity.com@evil.example/ie/jobs/3/x/</loc></url></urlset>`;
    const { fetch, calls } = fake(() => page(body));
    expect(await fetchSitemap({ ...SM.fmr, pattern: "/ie/jobs/(\\d+)/" }, none, fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    expect(calls).toHaveLength(1);
  });
  it("a listing or sitemap that redirects to another host fails the board; a job page that does is skipped, nothing saved", async () => {
    for (const run of [() => fetchPhenom(PH.mastercard, none, fake(() => redirect("https://evil.example/widgets", 307)).fetch, noSleep), () => fetchSitemap(SM.citi, none, fake(() => redirect("https://evil.example/s.xml")).fetch, noSleep)])
      await expect(run()).rejects.toThrow(/refused: request to another host/);
    const { fetch, calls } = fake(sites((url) => (url.includes("/job/") ? redirect("https://evil.example/job") : undefined)));
    expect((await fetchPhenom(PH.thermofisher, none, fetch, noSleep)).adverts).toEqual([]);
    expect(hosts(calls)).toEqual(["jobs.thermofisher.com"]);
  });
  it("a job id in the listing that could change the page path fails the board before any page call", async () => {
    for (const reqId of ["../../admin", "R-1/../x", "R 1", "", "x".repeat(101)]) {
      const { fetch, calls } = fake(() => page(JSON.stringify({ refineSearch: { totalHits: 1, data: { jobs: [{ reqId, country: "Ireland" }] } } })));
      await expect(fetchPhenom(PH.mastercard, none, fetch, noSleep), reqId).rejects.toThrow(/unsafe job id/);
      expect(calls).toHaveLength(1);
    }
  });
  it("bad board values (http, a path in the origin, a hostile path or name) fail before any call", async () => {
    const bad = [
      () => fetchPhenom({ ...PH.mastercard, origin: "http://careers.mastercard.com" }, none, fake(sites()).fetch, noSleep),
      () => fetchPhenom({ ...PH.mastercard, origin: "https://careers.mastercard.com/us" }, none, fake(sites()).fetch, noSleep),
      () => fetchPhenom({ ...PH.mastercard, path: "/../x" }, none, fake(sites()).fetch, noSleep),
      () => fetchPhenom({ ...PH.mastercard, path: "/us/." }, none, fake(sites()).fetch, noSleep),
      () => fetchPhenom({ ...PH.mastercard, path: "//evil.example" }, none, fake(sites()).fetch, noSleep),
      () => fetchPhenom({ ...PH.mastercard, pageId: "page11&x" }, none, fake(sites()).fetch, noSleep),
      () => fetchSitemap({ ...SM.fmr, sitemap: "@evil.example/s.xml" }, none, fake(sites()).fetch, noSleep),
      () => fetchSitemap({ ...SM.fmr, board: "../x" }, none, fake(sites()).fetch, noSleep),
    ];
    for (const run of bad) await expect(run()).rejects.toThrow(/bad board site or path|unsafe board name/);
  });
});

describe("size caps", () => {
  it("the 11 MB Salesforce file fits the 32 MB cap; a larger body or a larger Content-Length is refused", async () => {
    const row = JSON.parse(read("salesforce-jobs_2.json")).Report_Entry[1];
    const big = JSON.stringify({ Report_Entry: Array.from({ length: 11 * 1024 * 1024 / 1500 }, (_, i) => ({ ...row, Job_Requisition_Ref_ID: `JR${i}` })) });
    expect(big.length).toBeGreaterThan(11 * 1024 * 1024);
    expect((await fetchSalesforce(SF, none, fake(() => page(big)).fetch, noSleep)).seen.length).toBeGreaterThan(1000);
    await expect(fetchSalesforce(SF, none, fake(() => page("x".repeat(32 * 1024 * 1024 + 1))).fetch, noSleep)).rejects.toThrow(/body too large/);
    await expect(fetchSitemap(SM.fmr, none, fake(() => page("<urlset/>", 200, { "content-length": String(33 * 1024 * 1024) })).fetch, noSleep)).rejects.toThrow(/body too large/);
  });
});

describe("hostile JSON-LD", () => {
  it("script and markup in the fields come out as text with no tags", () => {
    const p = readPosting(jobPosting(ld({ "@type": "JobPosting", title: "<script>alert(1)</script>Engineer<img src=x onerror=alert(2)>", description: "<p>Job</p><script>steal()</script>", jobLocation: { address: { addressCountry: "IE", addressLocality: "<b>Cork</b>" } } }))!);
    expect(p.title).not.toMatch(/<|>/);
    expect(p.description).not.toMatch(/<|>/);
    expect(p.title).toContain("Engineer");
    expect(p.location).toBe("Cork, Ireland");
  });
  it("a closing script tag cannot be smuggled through JSON (</script> ends the block, and the half is not JSON)", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"a</script><script type="application/ld+json">{"@type":"JobPosting","title":"second"}</script>`;
    expect(jobPosting(html)).toEqual({ "@type": "JobPosting", title: "second" });
  });
  it("a huge description is read in full and fast; the fetcher's own limits decide what is saved", () => {
    const desc = "<p>word </p>".repeat(500_000); // 6 MB
    const t = performance.now();
    const p = readPosting(jobPosting(ld({ "@type": "JobPosting", title: "T", description: desc }))!);
    expect(p.description.length).toBeGreaterThan(2_000_000);
    expect(performance.now() - t).toBeLessThan(2000);
  });
  it("many JobPosting blocks: the first is used, and at most 20 ld+json blocks are parsed", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ld({ "@type": "JobPosting", title: `t${i}` })).join("");
    expect(jobPosting(many)).toMatchObject({ title: "t0" });
    const noise = Array.from({ length: 30 }, () => `<script type="application/ld+json">{bad</script>`).join("") + ld({ "@type": "JobPosting", title: "late" });
    expect(jobPosting(noise)).toBeNull();
  });
  it("unclosed and repeated <script tags do not make the scan slow", () => {
    for (const html of ["<script".repeat(200_000), `<script type="application/ld+json">${"{".repeat(1_000_000)}`, "<script>".repeat(200_000)]) {
      const t = performance.now();
      expect(jobPosting(html)).toBeNull();
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });
});

describe("sitemap bombs", () => {
  it("an index inside an index fails the board", async () => {
    const { fetch, calls } = fake(() => page(`<sitemapindex><sitemap><loc>https://jobs.fidelity.com/deeper${calls.length}.xml</loc></sitemap></sitemapindex>`));
    await expect(fetchSitemap(SM.fmr, none, fetch, noSleep)).rejects.toThrow(/sitemap index inside a sitemap index/);
    expect(calls).toHaveLength(2);
  });
  it(`an index of more than ${MAX_SITEMAPS} files fails before any of them is read`, async () => {
    const idx = `<sitemapindex>${Array.from({ length: MAX_SITEMAPS + 1 }, (_, i) => `<sitemap><loc>https://jobs.fidelity.com/s${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
    const { fetch, calls } = fake(() => page(idx));
    await expect(fetchSitemap(SM.fmr, none, fetch, noSleep)).rejects.toThrow(/more than 20 files/);
    expect(calls).toHaveLength(1);
  });
  it(`more than ${MAX_URLS} URLs in one file, or across the files of an index, fail the board with no page call`, async () => {
    const one = fake(() => page(urlset(MAX_URLS + 1)));
    await expect(fetchSitemap(SM.fmr, none, one.fetch, noSleep)).rejects.toThrow(/more than 100000 URLs/);
    expect(one.calls).toHaveLength(1);
    const half = urlset(MAX_URLS / 2 + 1);
    const idx = fake((c) => page(c.url.endsWith("/sitemap.xml") ? `<sitemapindex><sitemap><loc>https://jobs.fidelity.com/a.xml</loc></sitemap><sitemap><loc>https://jobs.fidelity.com/b.xml</loc></sitemap></sitemapindex>` : half));
    await expect(fetchSitemap(SM.fmr, none, idx.fetch, noSleep)).rejects.toThrow(/URLs/);
    expect(idx.calls).toHaveLength(3);
  });
  it("hostile ids in matching URLs are skipped (id from the URL) and a hostile page identifier is never used (id from the page)", async () => {
    const r = await fetchSitemap({ ...SM.fmr, pattern: "^https://jobs\\.fidelity\\.com/ie/jobs/([^/]+)/x/$" }, none, fake(() => page(urlset(3, (i) => ["%2e%2e", "a:b", "x".repeat(101)][i]!))).fetch, noSleep);
    expect(r).toEqual({ seen: [], adverts: [] });
    const sm = `<urlset><url><loc>https://jobs.citi.com/job/dublin/x/287/1</loc></url></urlset>`;
    const bad = ld({ "@type": "JobPosting", identifier: { value: "1 or 1=1; --" }, jobLocation: { address: { addressCountry: "IE" } } });
    expect(await fetchSitemap(SM.citi, none, fake((c) => page(c.url.endsWith(".xml") ? sm : bad)).fetch, noSleep)).toEqual({ seen: [], adverts: [] });
  });
});

describe("eightfold against a hostile site (W1e)", () => {
  const listing = (positions: unknown[], count = positions.length) => page(JSON.stringify({ data: { positions, count } }));
  const pos = (over: Record<string, unknown> = {}) => ({ id: 790314592423, displayJobId: "R2614187", name: "Job", locations: ["Leixlip,IRL"], ...over });
  it("a publicUrl or positionUrl on another host is never fetched nor saved: the URL is built from the origin and the numeric id", async () => {
    const evil = { publicUrl: "https://evil.example/x", positionUrl: "//evil.example/y" };
    const { fetch, calls } = fake((c) => (c.url.includes("/search?") ? listing([pos(evil)]) : page(JSON.stringify({ data: { ...evil, jobDescription: "<p>x</p>" } }))));
    const r = await fetchEightfold(EF, none, fetch, noSleep);
    expect(hosts(calls)).toEqual(["careers.appliedmaterials.com"]);
    expect(r.adverts[0]!.url).toBe("https://careers.appliedmaterials.com/careers/job/790314592423");
  });
  it("a listing that redirects to another host fails the board; a detail call that does is skipped, nothing saved, that host never called", async () => {
    await expect(fetchEightfold(EF, none, fake(() => redirect("https://evil.example/api")).fetch, noSleep)).rejects.toThrow(/refused: request to another host/);
    const { fetch, calls } = fake(sites((url) => (url.includes("position_details") ? redirect("https://evil.example/d") : undefined)));
    expect(await fetchEightfold(EF, none, fetch, noSleep)).toMatchObject({ adverts: [] });
    expect(hosts(calls)).toEqual(["careers.appliedmaterials.com"]);
  });
  it("hostile ids (path or query tricks, a non-numeric position id) fail the board before any detail call", async () => {
    for (const over of [{ displayJobId: "../x" }, { displayJobId: "R1&domain=evil" }, { displayJobId: "" }, { id: "1&hl=xx" }, { id: "abc" }, { id: 1.5 }, { id: "9".repeat(21) }]) {
      const { fetch, calls } = fake(() => listing([pos(over)]));
      await expect(fetchEightfold(EF, none, fetch, noSleep), JSON.stringify(over)).rejects.toThrow(/unsafe job id/);
      expect(calls).toHaveLength(1);
    }
  });
  it("bad board values fail before any call", async () => {
    for (const b of [{ ...EF, origin: "http://careers.appliedmaterials.com" }, { ...EF, origin: "https://careers.appliedmaterials.com/api" }, { ...EF, domain: "a.com&x=1" }, { ...EF, board: "../x" }]) {
      const { fetch, calls } = fake(sites());
      await expect(fetchEightfold(b, none, fetch, noSleep)).rejects.toThrow(/bad board site or path|unsafe board name/);
      expect(calls).toEqual([]);
    }
  });
  it(`a huge count with pages that never end stops after ${MAX_PAGES} pages and fails the board`, async () => {
    let n = 0;
    const { fetch, calls } = fake(() => listing([pos({ displayJobId: `R${n++}` })], 1e12));
    await expect(fetchEightfold(EF, none, fetch, noSleep)).rejects.toThrow(/more than 50 pages/);
    expect(calls).toHaveLength(MAX_PAGES);
  });
  it("a body over 32 MB is refused, by length or by Content-Length", async () => {
    await expect(fetchEightfold(EF, none, fake(() => page("x".repeat(32 * 1024 * 1024 + 1))).fetch, noSleep)).rejects.toThrow(/body too large/);
    await expect(fetchEightfold(EF, none, fake(() => page("{}", 200, { "content-length": String(33 * 1024 * 1024) })).fetch, noSleep)).rejects.toThrow(/body too large/);
  });
  it("script and markup in the name, the place and the description come out as text with no tags", async () => {
    const bad = pos({ name: "<script>alert(1)</script>Engineer<img src=x onerror=alert(2)>", locations: ["<b>Cork</b>,IRL"] });
    const { fetch } = fake((c) => (c.url.includes("/search?") ? listing([bad]) : page(JSON.stringify({ data: { jobDescription: "<p>Job</p><script>steal()</script><iframe src=//evil.example>" } }))));
    const a = (await fetchEightfold(EF, none, fetch, noSleep)).adverts[0]!;
    for (const f of [a.title, a.location, a.description]) expect(f).not.toMatch(/<|>/);
    expect([a.title.includes("Engineer"), a.location]).toEqual([true, "Cork, Ireland"]);
  });
});

describe("sitemap <loc> scan (OPS-2)", () => {
  const timedMs = <T>(f: () => T) => {
    const t = performance.now();
    const value = f();
    return { value, ms: performance.now() - t };
  };
  it("hostile input: <loc> then 200,000 spaces and no closing tag, and 1 MB of nested <loc>, each under 100 ms", () => {
    expect(timedMs(() => locTexts("<loc>" + " ".repeat(200_000) + "<x>")).ms).toBeLessThan(100);
    expect(timedMs(() => locTexts("<loc>".repeat(200_000))).ms).toBeLessThan(100);
    expect(timedMs(() => locTexts("<loc>" + " ".repeat(200_000) + "<x></loc>")).value).toEqual([]);
  });
  it("parses plain, padded and CDATA entries; refuses an entry over the cap", () => {
    expect(locTexts("<loc>a</loc><loc>\n  b </loc><loc> <![CDATA[ c ]]> </loc>")).toEqual(["a", "b", "c"]);
    expect(locTexts(`<loc>${"x".repeat(MAX_LOC + 1)}</loc><loc>ok</loc>`)).toEqual(["ok"]);
  });
  it("a 1 MB sitemap of 20,000 entries parses in under 200 ms", () => {
    const xml = `<urlset>${Array.from({ length: 20_000 }, (_, i) => `<url><loc>https://jobs.fidelity.com/ie/jobs/${i}/x/</loc></url>`).join("")}</urlset>`;
    expect(xml.length).toBeGreaterThan(1_000_000);
    const r = timedMs(() => locTexts(xml));
    expect(r.value).toHaveLength(20_000);
    expect(r.ms).toBeLessThan(200);
  });
  it("gives the same URLs as the old expression on every saved sitemap", () => {
    const OLD = /<loc>\s*(?:<!\[CDATA\[)?([^<]*?)(?:\]\]>)?\s*<\/loc>/g;
    for (const f of ["citi-sitemap.xml", "fidelity-sitemap.xml", "icims-dawnmeats-sitemap.xml", "icims-hsedne-sitemap.xml", "rezoomo-sitemap.xml"]) {
      const xml = read(f);
      const old = [...xml.matchAll(OLD)].map((m) => m[1]!);
      expect(old.length, f).toBeGreaterThan(0);
      expect(locTexts(xml), f).toEqual(old);
    }
  });
});
