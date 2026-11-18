import { describe, expect, it } from "vitest";
import { FetchFailedError } from "../types";
import { PACE, fetchAmazon, fetchAshby, fetchGreenhouse, fetchSmartRecruiters, fetchWorkday } from "./index";
import { clone, fake, fixtures as fx, none, reply, type Call, noSleep } from "./testkit";

const GH = { slug: "acme", employer: "Acme Ltd" };
const WD = { employer: "Acme Ltd", tenant: "acme", wd: "wd3", site: "External" };
const WD_BASE = "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External";
const SR_BASE = "https://api.smartrecruiters.com/v1/companies/acme";
const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(FetchFailedError);
  return e as FetchFailedError;
};

// ---- the shapes of failure every adapter must tell apart from "empty" ----------------------------------------------
// One table, five adapters: each is given a good body for its first request and bad ones.
const adapters = [
  { name: "greenhouse", run: (f: ReturnType<typeof fake>["fetch"]) => fetchGreenhouse(GH, none, f, noSleep), empty: { jobs: [] } },
  { name: "ashby", run: (f: ReturnType<typeof fake>["fetch"]) => fetchAshby(GH, none, f, noSleep), empty: { jobs: [] } },
  { name: "smartrecruiters", run: (f: ReturnType<typeof fake>["fetch"]) => fetchSmartRecruiters(GH, none, f, noSleep), empty: { content: [], totalFound: 0 } },
  { name: "workday", run: (f: ReturnType<typeof fake>["fetch"]) => fetchWorkday(WD, none, f, noSleep), empty: { total: 0, jobPostings: [] } },
  { name: "amazon", run: (f: ReturnType<typeof fake>["fetch"]) => fetchAmazon(undefined, none, f, noSleep), empty: { jobs: [], hits: 0 } },
];

describe.each(adapters)("$name: failed is not empty", ({ run, empty }) => {
  it("an empty board resolves with nothing seen (jobs may be closed from it)", async () => {
    expect(await run(fake(() => reply(empty)).fetch)).toEqual({ seen: [], adverts: [] });
  });
  it.each([404, 500])("HTTP %i is a failure, with no retry", async (status) => {
    const { fetch, calls } = fake(() => reply({ error: "x" }, status));
    const e = await rejects(run(fetch));
    expect(e.message).toContain(String(status));
    expect(calls).toHaveLength(1);
  });
  it.each([429, 503])("HTTP %i is a failure after 3 tries (W1)", async (status) => {
    const { fetch, calls } = fake(() => reply({ error: "x" }, status));
    const e = await rejects(run(fetch));
    expect(e.message).toMatch(new RegExp(`^HTTP ${status} after 3 tries`));
    expect(calls).toHaveLength(3);
  });
  it("a body that is not JSON is a failure", async () => {
    await rejects(run(fake(() => new Response("<html>Service unavailable</html>", { status: 200 })).fetch));
    await rejects(run(fake(() => new Response("", { status: 200 })).fetch));
  });
  it("a network error is a failure", async () => {
    await rejects(run(fake(() => Promise.reject(new TypeError("fetch failed"))).fetch));
  });
  it("a timeout is a failure", async () => {
    const e = await rejects(run(fake(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))).fetch));
    expect(e.message).toContain("TimeoutError");
  });
  it("a body of the wrong kind (null, a list, a number) is a failure", async () => {
    for (const body of [null, [], 5, "text"]) await rejects(run(fake(() => reply(body)).fetch));
  });
  it("every request sends an honest name (W1), a timeout signal, and does not follow redirects by itself", async () => {
    const { fetch, calls } = fake(() => reply(empty));
    await run(fetch);
    expect(calls[0]?.headers).toEqual({
      "User-Agent": "IrishWorkPermitJobs/1.0 (job listing fetcher; +https://irishworkpermit.ie)",
      Accept: "application/json",
      "Accept-Language": "en-IE,en;q=0.9",
      "Content-Type": "application/json",
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(calls[0]?.redirect).toBe("manual");
  });
});

describe.each([
  ["greenhouse", fetchGreenhouse],
  ["ashby", fetchAshby],
  ["smartrecruiters", fetchSmartRecruiters],
])("%s: board name is checked", (_n, run) => {
  it("a slug that could change the host or path is refused before any request", async () => {
    for (const slug of ["a/b", "a b", "", "x@evil.example", "..%2f", "a?b"]) {
      const { fetch, calls } = fake(() => reply({}));
      await rejects(run({ slug, employer: "E" }, none, fetch));
      expect(calls).toHaveLength(0);
    }
  });
});

// ---- Greenhouse (run_day.py:147-157) -------------------------------------------------------------------------------
describe("fetchGreenhouse", () => {
  const serve = (body: unknown = fx.greenhouse) => fake(() => reply(body));

  it("reads the board with one GET and keeps only Irish jobs", async () => {
    const { fetch, calls } = serve();
    const r = await fetchGreenhouse(GH, none, fetch, noSleep);
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"]]);
    expect(r.seen).toEqual(fx.greenhouse.jobs.slice(0, 2).map((j) => `greenhouse:acme:${j.id}`));
    expect(r.adverts).toHaveLength(2); // the third posting is in Berlin
  });
  it("maps the fields to a RawAdvert", async () => {
    const [a] = (await fetchGreenhouse(GH, none, serve().fetch, noSleep)).adverts;
    const j = fx.greenhouse.jobs[0]!;
    expect(a).toMatchObject({ id: `greenhouse:acme:${j.id}`, source: "greenhouse", board: "acme", employer: "Acme Ltd", title: j.title.trim(), location: j.location.name, url: j.absolute_url, employmentType: "", salaryBox: "" });
    expect(a?.description.length).toBeGreaterThan(100);
    expect(a?.description).not.toMatch(/[<>]|&lt;|&gt;/); // escaped HTML decoded and stripped
    expect(a?.description).toContain("\n");
  });
  it("a known id is seen but not returned again", async () => {
    const j = fx.greenhouse.jobs[0]!;
    const r = await fetchGreenhouse(GH, new Set([`greenhouse:acme:${j.id}`]), serve().fetch, noSleep);
    expect(r.seen).toHaveLength(2);
    expect(r.adverts.map((a) => a.id)).toEqual([`greenhouse:acme:${fx.greenhouse.jobs[1]!.id}`]);
  });
  it("a job with no location, or a null one, is skipped like a foreign job", async () => {
    const body = clone(fx.greenhouse) as { jobs: Record<string, unknown>[] };
    delete body.jobs[0]!.location;
    body.jobs[1]!.location = null;
    body.jobs[2]!.location = { name: null };
    expect(await fetchGreenhouse(GH, none, serve(body).fetch, noSleep)).toEqual({ seen: [], adverts: [] });
  });
  it("known quirk: a missing 'jobs' key is a failure, a missing id on an Irish job is a failure", async () => {
    await rejects(fetchGreenhouse(GH, none, serve({}).fetch, noSleep));
    const body = clone(fx.greenhouse) as { jobs: Record<string, unknown>[] };
    delete body.jobs[0]!.id;
    await rejects(fetchGreenhouse(GH, none, serve(body).fetch, noSleep));
  });
  it("a null title or content gives empty strings", async () => {
    const body = clone(fx.greenhouse) as { jobs: Record<string, unknown>[] };
    body.jobs[0]!.title = null;
    body.jobs[0]!.content = null;
    body.jobs[0]!.absolute_url = null;
    const [a] = (await fetchGreenhouse(GH, none, serve(body).fetch, noSleep)).adverts;
    expect([a?.title, a?.description, a?.url]).toEqual(["", "", ""]);
  });
  it("a numeric id is written as digits, a title is stripped", async () => {
    const body = { jobs: [{ id: 123, title: "  Nurse 　", location: { name: "Cork" }, content: "", absolute_url: "u" }] };
    const [a] = (await fetchGreenhouse(GH, none, serve(body).fetch, noSleep)).adverts;
    expect([a?.id, a?.title]).toEqual(["greenhouse:acme:123", "Nurse"]);
  });
});

// ---- Ashby (run_day.py:177-189) ------------------------------------------------------------------------------------
describe("fetchAshby", () => {
  const serve = (body: unknown = fx.ashby) => fake(() => reply(body));

  it("reads the board with one GET asking for compensation", async () => {
    const { fetch, calls } = serve();
    await fetchAshby(GH, none, fetch, noSleep);
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true"]]);
  });
  it("keeps jobs whose main or secondary location is Irish, joined with ' / '", async () => {
    const r = await fetchAshby(GH, none, serve().fetch, noSleep);
    expect(r.seen).toEqual([`ashby:acme:${fx.ashby.jobs[0]!.id}`, `ashby:acme:${fx.ashby.jobs[2]!.id}`]); // Dublin; Remote (EU) + Galway
    expect(r.adverts.map((a) => a.location)).toEqual(["Dublin", "Remote (EU) / Galway"]);
  });
  it("maps title, plain description, url, employment type and the pay summary", async () => {
    const [a] = (await fetchAshby(GH, none, serve().fetch, noSleep)).adverts;
    const j = fx.ashby.jobs[0]!;
    expect(a).toMatchObject({ source: "ashby", board: "acme", title: j.title.trim(), description: j.descriptionPlain, url: j.jobUrl, employmentType: j.employmentType, salaryBox: "EUR 50K - EUR 60K" });
  });
  it("does not run the description through text(): plain text keeps its ampersands", async () => {
    const body = { jobs: [{ id: "1", title: "T", location: "Dublin", descriptionPlain: "R&D <b> &amp; more" }] };
    const [a] = (await fetchAshby(GH, none, serve(body).fetch, noSleep)).adverts;
    expect(a?.description).toBe("R&D <b> &amp; more");
  });
  it("a null compensation or null secondaryLocations is fine; a null location entry is a failure", async () => {
    const ok = { jobs: [{ id: "1", title: "T", location: "Cork", secondaryLocations: null, compensation: null }] };
    expect((await fetchAshby(GH, none, serve(ok).fetch, noSleep)).seen).toHaveLength(1);
    await rejects(fetchAshby(GH, none, serve({ jobs: [{ id: "1", location: "Cork", secondaryLocations: [{ location: null }] }] }).fetch, noSleep));
  });
  it("known quirk: a missing 'jobs' key is an empty board, not a failure", async () => {
    expect(await fetchAshby(GH, none, serve({}).fetch, noSleep)).toEqual({ seen: [], adverts: [] });
  });
  it("a known id is seen but not returned again", async () => {
    const r = await fetchAshby(GH, new Set([`ashby:acme:${fx.ashby.jobs[0]!.id}`]), serve().fetch, noSleep);
    expect([r.seen.length, r.adverts.length]).toEqual([2, 1]);
  });
});

// ---- SmartRecruiters (run_day.py:220-236) --------------------------------------------------------------------------
function srServer(extra?: (c: Call) => Response | undefined) {
  return fake((c) => {
    const x = extra?.(c);
    if (x) return x;
    if (c.url.includes("/postings?")) return reply(fx.srList);
    const id = c.url.split("/postings/")[1] ?? "";
    return fx.srDetails[id] ? reply(fx.srDetails[id]) : reply({}, 404);
  });
}
describe("fetchSmartRecruiters", () => {
  const ids = fx.srList.content.map((p) => p.id);

  it("one list call then one detail call per posting, in order", async () => {
    const { fetch, calls } = srServer();
    const r = await fetchSmartRecruiters(GH, none, fetch, noSleep);
    expect(calls.map((c) => c.url)).toEqual([`${SR_BASE}/postings?country=ie&limit=100&offset=0`, ...ids.map((id) => `${SR_BASE}/postings/${id}`)]);
    expect(r.seen).toEqual(ids.map((id) => `smartrecruiters:acme:${id}`));
    expect(r.adverts).toHaveLength(3);
  });
  it("builds the record from the detail: four sections joined by newlines, city plus Ireland, employment label", async () => {
    const [a] = (await fetchSmartRecruiters(GH, none, srServer().fetch, noSleep)).adverts;
    const d = fx.srDetails[ids[0]!] as { name: string; postingUrl: string; location: { city: string } };
    expect(a).toMatchObject({ source: "smartrecruiters", board: "acme", title: d.name.trim(), location: `${d.location.city}, Ireland`, url: d.postingUrl, employmentType: "Full-time" });
    expect(a?.description.split("\n").length).toBeGreaterThanOrEqual(4);
    expect(a?.description).not.toMatch(/<|&#xa0;|&amp;/); // HTML and entities handled (&#xa0; is a no-break space)
  });
  it("known ids make no detail call", async () => {
    const { fetch, calls } = srServer();
    const r = await fetchSmartRecruiters(GH, new Set([`smartrecruiters:acme:${ids[0]}`, `smartrecruiters:acme:${ids[2]}`]), fetch, noSleep);
    expect(calls).toHaveLength(2); // list + one detail
    expect(r.seen).toHaveLength(3);
    expect(r.adverts.map((a) => a.id)).toEqual([`smartrecruiters:acme:${ids[1]}`]);
  });
  it("pages by 100 until totalFound", async () => {
    const page = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ id: String(start + i) }));
    const { fetch, calls } = fake((c) => {
      const off = Number(new URL(c.url).searchParams.get("offset"));
      return reply({ totalFound: 250, content: page(Math.min(100, 250 - off), off) });
    });
    const known = new Set(Array.from({ length: 250 }, (_, i) => `smartrecruiters:acme:${i}`));
    const r = await fetchSmartRecruiters(GH, known, fetch, noSleep);
    expect(calls.map((c) => new URL(c.url).searchParams.get("offset"))).toEqual(["0", "100", "200"]);
    expect(r.seen).toHaveLength(250);
  });
  it("exactly 100 postings and totalFound 100 is one page", async () => {
    const { fetch, calls } = fake(() => reply({ totalFound: 100, content: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) }));
    await fetchSmartRecruiters(GH, new Set(Array.from({ length: 100 }, (_, i) => `smartrecruiters:acme:${i}`)), fetch, noSleep);
    expect(calls).toHaveLength(1);
  });
  it("a failed detail call fails the whole board (no partial seen list)", async () => {
    const { fetch } = srServer((c) => (c.url.endsWith(`/postings/${ids[1]}`) ? reply({}, 500) : undefined));
    await rejects(fetchSmartRecruiters(GH, none, fetch, noSleep));
  });
  it("a failed second list page fails the whole board", async () => {
    const { fetch } = fake((c) => (c.url.endsWith("offset=100") ? reply({}, 502) : reply({ totalFound: 150, content: [{ id: "1" }] })));
    await rejects(fetchSmartRecruiters(GH, new Set(["smartrecruiters:acme:1"]), fetch, noSleep));
  });
  it("known quirk: a missing 'content' key is an empty board, a null city prints as None", async () => {
    expect(await fetchSmartRecruiters(GH, none, fake(() => reply({})).fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    const { fetch } = fake((c) => (c.url.includes("?") ? reply({ totalFound: 1, content: [{ id: "9" }] }) : reply({ name: "N", location: { city: null } })));
    expect((await fetchSmartRecruiters(GH, none, fetch, noSleep)).adverts[0]?.location).toBe("None, Ireland");
  });
  it("a detail with no jobAd, no location and no type gives empty fields (the id is still recorded)", async () => {
    const { fetch } = fake((c) => (c.url.includes("?") ? reply({ totalFound: 1, content: [{ id: "9" }] }) : reply({ name: "N" })));
    const [a] = (await fetchSmartRecruiters(GH, none, fetch, noSleep)).adverts;
    expect([a?.id, a?.description, a?.location, a?.employmentType, a?.url]).toEqual(["smartrecruiters:acme:9", "\n\n\n", ", Ireland", "", ""]);
  });
});

// ---- Workday (run_day.py:239-267) ----------------------------------------------------------------------------------
const paths = fx.wdList.jobPostings.map((p) => p.externalPath);
function wdServer(extra?: (c: Call) => Response | undefined) {
  return fake((c) => {
    const x = extra?.(c);
    if (x) return x;
    if (c.method === "POST") return reply(fx.wdList);
    const d = fx.wdDetails[c.url.slice(WD_BASE.length)];
    return d ? reply(d) : reply({}, 404);
  });
}
describe("fetchWorkday", () => {
  it("POSTs the Python's body, then one GET per posting", async () => {
    const { fetch, calls } = wdServer();
    await fetchWorkday(WD, none, fetch, noSleep);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${WD_BASE}/jobs`, body: { appliedFacets: {}, limit: 20, offset: 0, searchText: "Ireland" } });
    expect(calls.slice(1).map((c) => [c.method, c.url])).toEqual(paths.map((p) => ["GET", WD_BASE + p]));
  });
  it("keeps a posting whose main or additional location is Irish and joins the locations with ' / '", async () => {
    const r = await fetchWorkday(WD, none, wdServer().fetch, noSleep);
    expect(r.adverts.map((a) => a.location)).toEqual(["Ireland - Cork - Testville", "Greece - Athens - Sampletown / Ireland - Dublin - Examplebridge"]);
    expect(r.seen).toEqual([`workday:acme:${paths[0]}`, `workday:acme:${paths[1]}`]);
  });
  it("maps the detail: title, plain-text description, external url, time type; employer from the board", async () => {
    const [a] = (await fetchWorkday(WD, none, wdServer().fetch, noSleep)).adverts;
    const d = (fx.wdDetails[paths[0]!] as { jobPostingInfo: { title: string; externalUrl: string; timeType: string } }).jobPostingInfo;
    expect(a).toMatchObject({ id: `workday:acme:${paths[0]}`, source: "workday", board: "acme", employer: "Acme Ltd", title: d.title.trim(), url: d.externalUrl, employmentType: d.timeType, salaryBox: "" });
    expect(a?.description).not.toMatch(/<\/?(p|li|ul|span|div|b|u|br)\b/);
    expect(a?.description).toContain("\n");
  });
  it("a foreign posting is neither returned nor counted as seen", async () => {
    const only = clone(fx.wdDetails[paths[1]!]) as { jobPostingInfo: Record<string, unknown> };
    delete only.jobPostingInfo.additionalLocations;
    const { fetch } = wdServer((c) => (c.method === "GET" ? reply(only) : undefined));
    expect(await fetchWorkday(WD, none, fetch, noSleep)).toEqual({ seen: [], adverts: [] });
  });
  it("known ids make no detail call and are seen without the location check", async () => {
    const { fetch, calls } = wdServer();
    const r = await fetchWorkday(WD, new Set([`workday:acme:${paths[0]}`, `workday:acme:${paths[1]}`]), fetch, noSleep);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]); // only the third posting is new, and it has no detail
    expect(r.seen).toEqual([`workday:acme:${paths[0]}`, `workday:acme:${paths[1]}`]);
  });
  it("known quirk: a detail call that fails is skipped and the posting is NOT counted as seen", async () => {
    const r = await fetchWorkday(WD, none, wdServer().fetch, noSleep); // the fixture's third posting has no detail: 404
    expect(r.seen).not.toContain(`workday:acme:${paths[2]}`);
    for (const bad of [() => reply({}, 500), () => new Response("not json"), () => reply({ other: 1 }), () => Promise.reject(new TypeError("x")), () => reply(null)]) {
      const { fetch } = wdServer((c) => (c.method === "GET" ? (bad() as Response) : undefined));
      expect(await fetchWorkday(WD, none, fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    }
  });
  it("known quirk: a detail with additionalLocations null fails the whole board", async () => {
    const d = clone(fx.wdDetails[paths[0]!]) as { jobPostingInfo: Record<string, unknown> };
    d.jobPostingInfo.additionalLocations = null;
    await rejects(fetchWorkday(WD, none, wdServer((c) => (c.method === "GET" ? reply(d) : undefined)).fetch, noSleep));
  });
  it("a posting with no externalPath is skipped without a request (the 5 Nov KeyError fix)", async () => {
    const { fetch, calls } = fake(() => reply({ total: 2, jobPostings: [{ title: "x" }, { externalPath: "" }] }));
    expect(await fetchWorkday(WD, none, fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    expect(calls).toHaveLength(1);
  });
  it("pages by 20 until total", async () => {
    const { fetch, calls } = fake(() => reply({ total: 45, jobPostings: [] }));
    await fetchWorkday(WD, none, fetch, noSleep);
    expect(calls.map((c) => (c.body as { offset: number }).offset)).toEqual([0, 20, 40]);
  });
  it("stops once the offset is above 600 whatever total says", async () => {
    const { fetch, calls } = fake(() => reply({ total: 1_000_000, jobPostings: [] }));
    await fetchWorkday(WD, none, fetch, noSleep);
    expect(calls).toHaveLength(31); // offsets 0, 20, ... 600
    expect((calls.at(-1)?.body as { offset: number }).offset).toBe(600);
  });
  it("total exactly 600 is 30 pages", async () => {
    const { fetch, calls } = fake(() => reply({ total: 600, jobPostings: [] }));
    await fetchWorkday(WD, none, fetch, noSleep);
    expect(calls).toHaveLength(30);
  });
  it("known quirk: a missing 'jobPostings' or 'total' is an empty board", async () => {
    expect(await fetchWorkday(WD, none, fake(() => reply({})).fetch, noSleep)).toEqual({ seen: [], adverts: [] });
  });
  it("a failed list page fails the whole board", async () => {
    let n = 0;
    await rejects(fetchWorkday(WD, none, fake(() => (n++ ? reply({}, 500) : reply({ total: 60, jobPostings: [] }))).fetch, noSleep));
  });
  it("W1: a posting whose one list location is not Irish gets no detail call; several, none or an Irish one still do", async () => {
    const list = { total: 5, jobPostings: [
      { externalPath: "/job/uk", locationsText: "United Kingdom - Walton Oaks" },
      { externalPath: "/job/ie", locationsText: "Ireland - Cork - Ringaskiddy" },
      { externalPath: "/job/two", locationsText: "2 Locations" },
      { externalPath: "/job/none" },
      { externalPath: "/job/odd", locationsText: 7 },
    ] };
    const { fetch, calls } = fake((c) => (c.method === "POST" ? reply(list) : reply({}, 404)));
    await fetchWorkday(WD, none, fetch, noSleep);
    expect(calls.slice(1).map((c) => c.url.slice(WD_BASE.length))).toEqual(["/job/ie", "/job/two", "/job/none", "/job/odd"]);
  });
  it("W1: a detail refused with 429 after the retries fails the board (a skipped detail would close a known posting)", async () => {
    const { fetch, calls } = wdServer((c) => (c.method === "GET" ? reply({}, 429) : undefined));
    const e = await rejects(fetchWorkday(WD, none, fetch, noSleep));
    expect(e.message).toMatch(/^HTTP 429 after 3 tries/);
    expect(calls).toHaveLength(4); // the list, then 3 tries of the first detail; no further detail call
  });
  it("W1: the calls of one board are 300 ms apart, none before the first", async () => {
    const waits: number[] = [];
    const { fetch, calls } = wdServer();
    await fetchWorkday(WD, none, fetch, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual(Array.from({ length: calls.length - 1 }, () => PACE.workdayCallGapMs));
  });
  it("tenant, wd and site are checked before any request", async () => {
    for (const bad of [{ ...WD, tenant: "a/b" }, { ...WD, wd: "wd3.evil.example/x" }, { ...WD, site: "a b" }]) {
      const { fetch, calls } = fake(() => reply({}));
      await rejects(fetchWorkday(bad, none, fetch, noSleep));
      expect(calls).toHaveLength(0);
    }
  });
});

// ---- Amazon (run_day.py:270-282) -----------------------------------------------------------------------------------
describe("fetchAmazon", () => {
  const serve = (body: unknown = fx.amazon) => fake(() => reply(body));

  it("reads page 0 of the Ireland search with 100 results", async () => {
    const { fetch, calls } = serve();
    await fetchAmazon(undefined, none, fetch, noSleep);
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "https://www.amazon.jobs/en/search.json?loc_query=Ireland&country=IRL&result_limit=100&offset=0"]]);
  });
  it("maps the fields: id_icims id, job path url, three description parts, schedule type", async () => {
    const r = await fetchAmazon(undefined, none, serve().fetch, noSleep);
    const j = fx.amazon.jobs[0]!;
    expect(r.seen).toEqual(fx.amazon.jobs.map((x) => `amazon:amazon:${x.id_icims}`));
    expect(r.adverts[0]).toMatchObject({ id: `amazon:amazon:${j.id_icims}`, source: "amazon", board: "amazon", employer: "Amazon", title: j.title.trim(), location: "Dublin, IRL", url: `https://www.amazon.jobs${j.job_path}`, employmentType: j.job_schedule_type, salaryBox: "" });
    expect(r.adverts[0]?.description).not.toMatch(/<br|<a /);
    expect(r.adverts[0]?.description.split("\n").length).toBeGreaterThan(5);
  });
  it("falls back to location when normalized_location is empty, and to job_path for the id", async () => {
    const body = { hits: 1, jobs: [{ id_icims: "", job_path: "/en/jobs/1", title: "T", normalized_location: "", location: "IE, Cork" }] };
    const [a] = (await fetchAmazon(undefined, none, serve(body).fetch, noSleep)).adverts;
    expect([a?.id, a?.location, a?.description]).toEqual(["amazon:amazon:/en/jobs/1", "IE, Cork", "\n\n"]);
  });
  it("known quirk: no Irish filter (the search is the filter), so a non-Irish location is kept", async () => {
    const body = { hits: 1, jobs: [{ id_icims: "1", job_path: "/p", title: "T", normalized_location: "Berlin, DEU" }] };
    expect((await fetchAmazon(undefined, none, serve(body).fetch, noSleep)).seen).toEqual(["amazon:amazon:1"]);
  });
  it("pages by 100 until hits", async () => {
    const { fetch, calls } = fake((c) => {
      const off = Number(new URL(c.url).searchParams.get("offset"));
      return reply({ hits: 250, jobs: Array.from({ length: Math.min(100, 250 - off) }, (_, i) => ({ id_icims: String(off + i), job_path: "/p" })) });
    });
    const r = await fetchAmazon(undefined, new Set(Array.from({ length: 250 }, (_, i) => `amazon:amazon:${i}`)), fetch, noSleep);
    expect(calls.map((c) => new URL(c.url).searchParams.get("offset"))).toEqual(["0", "100", "200"]);
    expect([r.seen.length, r.adverts.length]).toEqual([250, 0]);
  });
  it("a known id is seen but not returned again", async () => {
    const r = await fetchAmazon(undefined, new Set([`amazon:amazon:${fx.amazon.jobs[0]!.id_icims}`]), serve().fetch, noSleep);
    expect([r.seen.length, r.adverts.length]).toEqual([3, 2]);
  });
  it("known quirk: a missing 'jobs' or 'hits' key is a failure, not an empty board", async () => {
    await rejects(fetchAmazon(undefined, none, serve({ hits: 0 }).fetch, noSleep));
    await rejects(fetchAmazon(undefined, none, serve({ jobs: [] }).fetch, noSleep));
  });
  it("known quirk: the same job on two pages is seen twice and returned twice", async () => {
    const body = { hits: 2, jobs: [{ id_icims: "7", job_path: "/p" }, { id_icims: "7", job_path: "/p" }] };
    const r = await fetchAmazon(undefined, none, serve(body).fetch, noSleep);
    expect([r.seen, r.adverts.length]).toEqual([["amazon:amazon:7", "amazon:amazon:7"], 2]);
  });
});
