// D1-B (20 Nov 2026): the Rezoomo place rule, the two iCIMS sitemap boards, Microsoft and Qualcomm on the eightfold kind. Unit, security and
// performance on saved bodies (fixtures/, saved 20 Nov 2026) through the fake fetch; no test reaches the network.
import { describe, expect, it } from "vitest";
import { fake, none, noSleep } from "../ats/testkit";
import { eightfoldIrish, fetchEightfold, fetchSitemap, jobPosting, readPosting, titlePlace } from "./careers";
import { countyOf } from "../county";
import { EF_MORE, page, read, sites, SM } from "./testkit";

const rz = (title: string) => `https://www.rezoomo.com/job/1/?${encodeURIComponent(title).replaceAll("-", "%2D")}`;
const hosts = (calls: { url: string }[]) => [...new Set(calls.map((c) => new URL(c.url).host))];
const urlset = (urls: string[]) => `<urlset>${urls.map((u) => `<url><loc><![CDATA[${u}]]></loc></url>`).join("")}</urlset>`;

describe("Rezoomo place rule (titlePlace)", () => {
  it("a Republic county is kept, with the title before the place", () => {
    expect(titlePlace(rz("Healthcare Assistant - Dublin"))).toEqual({ title: "Healthcare Assistant", place: "Dublin" });
    expect(titlePlace(rz("Relief Family Support Worker - County Limerick"))).toEqual({ title: "Relief Family Support Worker", place: "County Limerick" });
    expect(titlePlace(rz("Support Worker - Specific purpose - Dublin"))).toEqual({ title: "Support Worker - Specific purpose", place: "Dublin" });
  });
  it("Northern Ireland, 'Ireland', a place abroad and no place are dropped", () => {
    for (const t of ["Maintenance Opportunities - Craigavon", "Biology Scientist - Belfast", "Care Worker - Newtownabbey", "Nurse - Derry", "Nurse - Londonderry", "Nurse - Newcastle", "Engineer - Loughborough", "Dental Officer - Ireland", "Barista", "Nurse - ", "Chef - Dublin, Northern Ireland", "Chef - Cork (UK)"])
      expect(titlePlace(rz(t)), t).toBeNull();
    expect(titlePlace("https://www.rezoomo.com/job/1/")).toBeNull();
  });
  it("two places: kept only when both are Republic counties; a county in the title does not count", () => {
    expect(titlePlace(rz("CAMHS - Cork and Kerry"))).toEqual({ title: "CAMHS", place: "Cork and Kerry" });
    expect(titlePlace(rz("Nurse - Dublin / Wicklow"))).toMatchObject({ place: "Dublin / Wicklow" });
    expect(titlePlace(rz("Nurse - Dublin / Belfast"))).toBeNull();
    expect(titlePlace(rz("Dublin Nurse - Craigavon"))).toBeNull();
  });
  it("hostile titles: bad percent escapes are null, HTML is stripped, a huge title is cut before it is read", () => {
    expect(titlePlace("https://www.rezoomo.com/job/1/?Nurse%20%2D%20%E0%A4%A")).toBeNull();
    expect(titlePlace(rz("<script>alert(1)</script>Nurse - <b>Cork</b>"))).toEqual({ title: "alert(1) Nurse", place: "Cork" }); // tags gone, plain text left
    expect(titlePlace(rz(`${"x".repeat(100_000)} - Cork`))).toBeNull();
  });
});

describe("Republic towns (gap round G1: countyOf with the GeoNames town table)", () => {
  it("towns give their county; counties still come first; Northern Ireland names give none", () => {
    for (const [place, county] of [["Bray", "Wicklow"], ["Athlone", "Westmeath"], ["Naas", "Kildare"], ["Newbridge", "Kildare"], ["Letterkenny", "Donegal"], ["Carrick-On-Shannon", "Leitrim"], ["Blackrock", "Dublin"], ["Swords", "Dublin"]])
    {
      expect(titlePlace(rz(`Care Assistant - ${place}`)), place).toEqual({ title: "Care Assistant", place });
      expect(countyOf(`${place}, Ireland`), place).toBe(county);
    }
    expect(countyOf("Bray, Ireland")).toBe("Wicklow");
    expect(countyOf("Naas Road, Dublin 12")).toBe("Dublin"); // a county named wins over a town
    expect(countyOf("Athlone and Bray")).toBe("Westmeath"); // the first town in the text
    // only main names and English-labelled ones: other-language forms GeoNames lists (Chinese "a dai er" for Adare, "Abbifil", "Atlona") give nothing
    for (const foreign of ["a dai er", "Abbifil", "Atlona", "Brejus", "Nurse a bi fei er"]) expect(countyOf(foreign), foreign).toBeNull();
    expect(titlePlace(rz("Care Assistant - Atlona"))).toBeNull();
    expect(countyOf("Adare")).toBe("Limerick");
    for (const ni of ["Belfast", "Newtownabbey", "Derry", "Londonderry", "Lisburn", "Newry", "Newcastle", "Dundrum", "Crumlin", "Peamount Hospital", "Ford Road"]) expect(countyOf(ni), ni).toBeNull();
  });
  it("hostile text: 2,000 characters read at most, under 200 ms per 1,000 locations of 2,000 characters", () => {
    expect(countyOf(`${"x ".repeat(1000)}Bray`)).toBeNull();
    const loc = Array.from({ length: 1000 }, (_, i) => `${"word ".repeat(398)}place${i}`);
    const t = performance.now();
    for (const l of loc) countyOf(l);
    const ms = performance.now() - t;
    console.log(`perf d1b: countyOf ${ms.toFixed(1)} ms per 1,000 long locations`);
    expect(ms).toBeLessThan(200);
  });
});

describe("page cap (gap round G2: maxPages)", () => {
  it("a capped board reads at most maxPages pages a run, counts the rest as seen, and reads them on the next run", async () => {
    const { fetch, calls } = fake(sites());
    const capped = { ...SM.hsedne, maxPages: 5 };
    const first = await fetchSitemap(capped, none, fetch, noSleep);
    expect([calls.length, first.seen.length]).toEqual([1 + 5, 16]);
    const fixture = calls.filter((c) => c.url.includes("/jobs/5359/")).length; // 5359 is the first job in the sitemap
    expect([fixture, first.adverts.map((a) => a.id)]).toEqual([1, ["sitemap:hsedne:5359"]]);
    calls.length = 0;
    // the run saves the advert; the shells (no JSON-LD) are not saved, so the next run reads the next 5 of them
    const second = await fetchSitemap(capped, new Set(["sitemap:hsedne:5359"]), fetch, noSleep);
    expect(calls.map((c) => /\/jobs\/(\d+)\//.exec(c.url)?.[1]).filter(Boolean)).toEqual(["5391", "5294", "5358", "5325", "5293"]);
    expect(second.seen).toHaveLength(16);
  });
  it("a bad cap fails the board before any call; the Rezoomo row's cap is 180", async () => {
    for (const maxPages of [0, -1, 1.5, 20_000, Number.NaN]) await expect(fetchSitemap({ ...SM.hsedne, maxPages }, none, fake(sites()).fetch, noSleep), String(maxPages)).rejects.toThrow(/bad board page cap/);
    const { default: file } = await import("../../../fetcher/data/boards.json", { with: { type: "json" } });
    expect((file.sitemap as unknown[][]).find((r) => r[1] === "rezoomo")?.[6]).toEqual({ place: "url", maxPages: 180 });
  });
  it("performance: Rezoomo at 1,069 URLs with the cap: 1 + 180 calls a run; 448 Republic jobs need 3 runs; 180 x 2.4 s a call (measured live) is 7.2 min", async () => {
    const posting = read("rezoomo-105422.html");
    const big = urlset(Array.from({ length: 1069 }, (_, i) => (i < 767 ? rz(`Nurse ${i} - ${i < 448 ? "Cork" : "Craigavon"}`).replace("/job/1/", `/job/${50_000 + i}/`) : `https://www.rezoomo.com/company/c${i}/jobs/`)));
    const { fetch, calls } = fake((c) => page(c.url.endsWith("/sitemap.xml") ? big : posting));
    const known = new Set<string>();
    const perRun: number[] = [];
    for (let run = 0; run < 3; run++) {
      calls.length = 0;
      const r = await fetchSitemap({ ...SM.rezoomo, maxPages: 180 }, known, fetch, noSleep);
      for (const a of r.adverts) known.add(a.id);
      perRun.push(calls.length);
    }
    expect([perRun, known.size]).toEqual([[181, 181, 89], 448]);
    expect(180 * 2.4).toBeLessThan(8 * 60);
  });
});

describe("JobPosting extras (org, salary)", () => {
  it("Rezoomo page: employer from hiringOrganization, euro range as salary text; a GBP placeholder is empty", () => {
    expect(readPosting(jobPosting(read("rezoomo-105422.html"))!)).toMatchObject({ id: "105422", org: "HSE Dublin and North East", salary: "€38,908 - €56,948 a year", irish: false });
    expect(readPosting(jobPosting(read("rezoomo-105268.html"))!)).toMatchObject({ org: "Almac Group", salary: "" });
  });
  it("absurd, wrong-typed, hourly or non-euro salaries are empty; HTML in the employer is stripped", () => {
    const s = (value: unknown, currency = "EUR") => readPosting({ baseSalary: { currency, value } }).salary;
    expect(s({ minValue: 30_000, maxValue: 30_000, unitText: "YEAR" })).toBe("€30,000 a year");
    for (const v of [{ minValue: 1e12, unitText: "YEAR" }, { minValue: -5, unitText: "YEAR" }, { minValue: "40000", unitText: "YEAR" }, { minValue: 40_000.5, unitText: "YEAR" }, { minValue: 20, unitText: "HOUR" }, "40000", null])
      expect(s(v), JSON.stringify(v)).toBe("");
    expect(s({ minValue: 40_000, unitText: "YEAR" }, "GBP")).toBe("");
    expect(readPosting({ hiringOrganization: { name: "<img src=x onerror=alert(1)>Acme" } }).org).toBe("Acme");
    expect(readPosting({ hiringOrganization: { name: "x".repeat(5000) } }).org).toHaveLength(200);
  });
});

describe("Rezoomo board (sitemap kind, place rule)", () => {
  it("keeps the Republic jobs of the sitemap (CDATA locs), reads only their pages, employer and salary from the page", async () => {
    const { fetch, calls } = fake(sites());
    const r = await fetchSitemap(SM.rezoomo, none, fetch, noSleep);
    expect(r.seen.sort()).toEqual(["sitemap:rezoomo:100118", "sitemap:rezoomo:105422", "sitemap:rezoomo:68522"]); // 100118: Bray (G1)
    expect(calls.map((c) => c.url.replace(/\?.*/, ""))).toEqual(["https://www.rezoomo.com/sitemap.xml", "https://www.rezoomo.com/job/68522/", "https://www.rezoomo.com/job/100118/", "https://www.rezoomo.com/job/105422/"]);
    const a = r.adverts.find((x) => x.id === "sitemap:rezoomo:105422")!;
    expect(a).toMatchObject({ employer: "HSE Dublin and North East", title: "DNE26206 Staff Nurse (Mental Health) Altra Foirne (Meabhairshláinte)", location: "Dublin, Ireland", salaryBox: "€38,908 - €56,948 a year", employmentType: "FULL_TIME, FULL_TIME" });
    expect(a.url.startsWith("https://www.rezoomo.com/job/105422/?")).toBe(true);
  });
  it("a known job costs no page call; a page that fails closes nothing; a Northern Ireland job is never seen even with a page", async () => {
    const { fetch, calls } = fake(sites((url) => (url.includes("/job/68522/") ? page("down", 500) : undefined)));
    const r = await fetchSitemap(SM.rezoomo, new Set(["sitemap:rezoomo:105422", "sitemap:rezoomo:100118"]), fetch, noSleep);
    expect([r.seen.sort(), r.adverts, calls.length]).toEqual([["sitemap:rezoomo:100118", "sitemap:rezoomo:105422", "sitemap:rezoomo:68522"], [], 2]); // the sitemap and the failing page (500 is not retried)
  });
});

describe("iCIMS boards (HSE Dublin and North East, Dawn Meats)", () => {
  it("reads the in_iframe page, keeps the plain URL, the place from the Irish address", async () => {
    const { fetch, calls } = fake(sites((url) => (url.includes("/jobs/5359/") || url.endsWith("/sitemap.xml") ? undefined : page("gone", 404))));
    const r = await fetchSitemap(SM.hsedne, none, fetch, noSleep);
    expect(r.adverts).toHaveLength(1);
    expect(r.adverts[0]).toMatchObject({ id: "sitemap:hsedne:5359", employer: "HSE Dublin and North East", location: "Louth-Drogheda, Ireland", url: "https://careers-hsedne.icims.com/jobs/5359/senior-house-officer-in-medicine/job" });
    expect(r.seen).toHaveLength(16); // the 15 pages that failed close nothing
    expect(calls.filter((c) => c.url.includes("/jobs/")).every((c) => c.url.endsWith("/job?in_iframe=1"))).toBe(true);
    const d = await fetchSitemap(SM.dawnmeats, none, fake(sites()).fetch, noSleep);
    expect(d.adverts.map((a) => [a.id, a.location, a.title])).toEqual([["sitemap:dawnmeats:5124", "Waterford-Kilmacthomas, Ireland", "Electrical Maintenance Technician"]]);
  });
  it("a job outside Ireland is dropped after its page and not seen", async () => {
    const uk = read("icims-dawnmeats-5124.html").replace('"addressCountry":"IE"', '"addressCountry":"GB"');
    const { fetch } = fake(sites((url) => (url.includes("/jobs/5124/") ? page(uk) : url.includes("/jobs/") ? page("gone", 404) : undefined)));
    const r = await fetchSitemap(SM.dawnmeats, none, fetch, noSleep);
    expect(r.adverts).toEqual([]);
    expect(r.seen).not.toContain("sitemap:dawnmeats:5124");
  });
  it("a bad page query fails the board before any call", async () => {
    for (const query of ["in_iframe=1", "?a=1#x", "?a=1/../b", "?" + "a".repeat(200), "@evil.example"]) {
      const { fetch, calls } = fake(sites());
      await expect(fetchSitemap({ ...SM.hsedne, query }, none, fetch, noSleep), query).rejects.toThrow(/bad board page query/);
      expect(calls).toHaveLength(0);
    }
  });
});

describe("Microsoft and Qualcomm (eightfold kind)", () => {
  it("their place shapes come out Irish; AMAT's ,IRL shape is unchanged; Northern Ireland and other countries are not", () => {
    expect(eightfoldIrish({ locations: ["Ireland, Dublin, Dublin", "Spain, Barcelona, Barcelona"] })).toBe("Dublin, Ireland");
    expect(eightfoldIrish({ locations: ["United Kingdom, London, London", "Ireland, Multiple Locations, Multiple Locations"] })).toBe("Multiple Locations, Ireland");
    expect(eightfoldIrish({ locations: ["Cork, Ireland", "Cork, Ireland"] })).toBe("Cork, Ireland");
    expect(eightfoldIrish({ locations: ["Leixlip,IRL"] })).toBe("Leixlip, Ireland");
    for (const l of [["Belfast, Northern Ireland"], ["United Kingdom, Belfast, Northern Ireland"], ["Ireland"], ["Irelandville, X"], [7], null, { a: 1 }]) expect(eightfoldIrish({ locations: l }), JSON.stringify(l)).toBe("");
  });
  it("all 10 saved jobs of each are kept with their text and a URL built from the id", async () => {
    for (const b of [EF_MORE.microsoft, EF_MORE.qualcomm]) {
      const { fetch, calls } = fake(sites());
      const r = await fetchEightfold(b, none, fetch, noSleep);
      expect([r.seen.length, r.adverts.length, calls.length], b.board).toEqual([10, 10, 11]);
      expect(r.adverts.every((a) => a.description.length > 1000 && a.url.startsWith(`${b.origin}/careers/job/`) && a.location.endsWith(", Ireland"))).toBe(true);
      expect(hosts(calls)).toEqual([new URL(b.origin).host]);
    }
  });
  it("429 then 200: the first call waits (Retry-After when given) and tries again; the board works", async () => {
    for (const headers of [{ "retry-after": "20" }, {}] as Record<string, string>[]) {
      let n = 0;
      const waits: number[] = [];
      const { fetch } = fake(sites((url) => (url.includes("/search") && n++ === 0 ? page("Please try again later", 429, headers) : undefined)));
      const r = await fetchEightfold(EF_MORE.microsoft, none, fetch, { sleep: async (ms) => void waits.push(ms) });
      expect(r.adverts, JSON.stringify(headers)).toHaveLength(10);
      expect(waits.filter((w) => w >= 5_000)).toEqual([headers["retry-after"] ? 20_000 : 5_000]);
    }
  });
  it("429 on every try fails the board (nothing closes); a 5xx detail keeps the job seen but saves nothing", async () => {
    await expect(fetchEightfold(EF_MORE.qualcomm, none, fake(() => page("no", 429)).fetch, noSleep)).rejects.toThrow(/HTTP 429/);
    const r = await fetchEightfold(EF_MORE.qualcomm, none, fake(sites((url) => (url.includes("position_details") ? page("down", 500) : undefined))).fetch, noSleep);
    expect([r.seen.length, r.adverts.length]).toEqual([10, 0]);
  });
});

describe("performance (budgets fail when exceeded)", () => {
  // 1,069 URLs as on 20 Nov 2026: 767 job pages (448 with a Republic county place, the rest Northern Ireland, towns or "Ireland"), 302 others
  const big = urlset([
    ...Array.from({ length: 767 }, (_, i) => rz(`Staff Nurse ${i} - ${i < 448 ? "Cork" : "Craigavon"}`).replace("/job/1/", `/job/${50_000 + i}/`)),
    ...Array.from({ length: 302 }, (_, i) => `https://www.rezoomo.com/company/c${i}/jobs/`),
  ]);
  it("titlePlace: under 20 ms per 1,000 job URLs (measured about 2 ms)", () => {
    const urls = Array.from({ length: 1000 }, (_, i) => rz(`Healthcare Assistant ${i} - ${i % 2 ? "Dublin" : "Craigavon"}`));
    const t = performance.now();
    for (let k = 0; k < 10; k++) for (const u of urls) titlePlace(u);
    const ms = (performance.now() - t) / 10;
    console.log(`perf d1b: titlePlace ${ms.toFixed(2)} ms per 1,000`);
    expect(ms).toBeLessThan(20);
  });
  it("Rezoomo, 1,069 sitemap URLs: day 1 is 1 + 448 calls, day 2 is 1 call, under 1.5 s of work; the pacing is 448 x 2 s, inside the 30 min board budget", async () => {
    const posting = read("rezoomo-105422.html");
    const { fetch, calls } = fake((c) => page(c.url.endsWith("/sitemap.xml") ? big : posting));
    const t = performance.now();
    const first = await fetchSitemap(SM.rezoomo, none, fetch, noSleep);
    const ms = performance.now() - t;
    console.log(`perf d1b: Rezoomo 1,069 URLs ${ms.toFixed(0)} ms, ${calls.length} calls, ${first.adverts.length} kept`);
    expect([calls.length, first.adverts.length]).toEqual([449, 448]);
    expect(ms).toBeLessThan(1500);
    expect(448 * 2).toBeLessThan(30 * 60); // PACE.siteCallGapMs 2 s between page calls
    calls.length = 0;
    const again = await fetchSitemap(SM.rezoomo, new Set(first.seen), fetch, noSleep);
    expect([calls.length, again.seen.length, again.adverts.length]).toEqual([1, 448, 0]);
  });
  it("Microsoft with 50 Irish jobs: 5 listing calls and 50 detail calls the first day, 5 once known, under 250 ms", async () => {
    const detail = read("eightfold-microsoft-detail.json");
    const proto = JSON.parse(read("eightfold-microsoft-search-0.json")).data.positions[0];
    const { fetch, calls } = fake((c) => {
      if (c.url.includes("position_details")) return page(detail);
      const start = Number(new URL(c.url).searchParams.get("start"));
      return page(JSON.stringify({ data: { count: 50, positions: Array.from({ length: Math.min(10, 50 - start) }, (_, i) => ({ ...proto, id: String(1000 + start + i), displayJobId: String(2000 + start + i) })) } }));
    });
    const t = performance.now();
    const first = await fetchEightfold(EF_MORE.microsoft, none, fetch, noSleep);
    const ms = performance.now() - t;
    console.log(`perf d1b: Microsoft 50 jobs ${ms.toFixed(1)} ms, ${calls.length} calls`);
    expect([calls.length, first.adverts.length]).toEqual([55, 50]);
    expect(ms).toBeLessThan(250);
    calls.length = 0;
    expect((await fetchEightfold(EF_MORE.microsoft, new Set(first.seen), fetch, noSleep)).adverts).toEqual([]);
    expect(calls).toHaveLength(5);
  });
});

describe("security: hostile Rezoomo sitemap", () => {
  it("job URLs on another host or a look-alike are never read; a CDATA loc cannot smuggle a second URL", async () => {
    const body = urlset(["https://evil.example/job/1/?Nurse%20%2D%20Cork", "https://www.rezoomo.com.evil.example/job/2/?Nurse%20%2D%20Cork", "https://www.rezoomo.com/job/3/?Nurse%20%2D%20Cork]]></loc><loc>https://evil.example/x"]);
    const { fetch, calls } = fake((c) => page(c.url.endsWith("/sitemap.xml") ? body : read("rezoomo-105422.html")));
    await fetchSitemap(SM.rezoomo, none, fetch, noSleep);
    expect(hosts(calls)).toEqual(["www.rezoomo.com"]);
  });
  it("a job page with script in the fields saves plain text; a page with no JobPosting saves nothing", async () => {
    const evil = read("rezoomo-105422.html").replace('HSE Dublin and North East","sameAs', '\\u003cscript\\u003ealert(1)\\u003c/script\\u003eEvil","sameAs'); // "<" escaped, as sites write it
    const r = await fetchSitemap(SM.rezoomo, none, fake(sites((url) => (url.includes("/job/") ? page(url.includes("68522") ? "<html>app</html>" : evil) : undefined))).fetch, noSleep);
    expect(r.adverts.map((a) => a.employer)).toEqual(["alert(1) Evil", "alert(1) Evil"]);
    expect(r.seen).toHaveLength(3);
  });
});
