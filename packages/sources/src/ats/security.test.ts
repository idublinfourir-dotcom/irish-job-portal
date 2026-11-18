// Responses are untrusted. These tests feed hostile bodies to every adapter and check four things: no untyped throw,
// no hang, no request to any host but the one the adapter was given, and bounded work.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FetchFailedError } from "../types";
import { fetchAmazon, fetchAshby, fetchGreenhouse, fetchSmartRecruiters, fetchWorkday } from "./index";
import { text } from "./shared";
import { fake, none, redirect, reply, noSleep } from "./testkit";

const GH = { slug: "acme", employer: "Acme" };
const WD = { employer: "Acme", tenant: "acme", wd: "wd3", site: "External" };
const BUDGET_MS = 3000; // measured: the slowest case (the 10 MB description) takes about 1.0 s, every other case under 0.3 s
const timed = async <T>(run: () => Promise<T> | T) => {
  const t = performance.now();
  const value = await run();
  return { value, ms: performance.now() - t };
};

// ---- text and odd Unicode in every field, every adapter --------------------------------------------------------------
const HOSTILE = [
  "<script>alert(1)</script>",
  "\u0000",
  "‮evil‬",
  "\ud800 lone surrogate \udfff",
  "​‍﻿",
  "😀".repeat(50),
  "&#0;&#xD800;&#999999999999;&#x110000;",
  "<img src=x onerror=alert(1)>",
  "'; DROP TABLE jobs;--",
  "e" + "́".repeat(200),
  "<<<<<",
  "ünï-cødé ЖЖ 漢字 العربية",
  "\\u0000 %00 ${7*7} {{7*7}}",
];
describe.each(HOSTILE)("hostile text %#", (h) => {
  const place = `Dublin ${h}`;
  const cases = [
    () => fetchGreenhouse(GH, none, fake(() => reply({ jobs: [{ id: h, title: h, location: { name: place }, content: h, absolute_url: h }] })).fetch, noSleep),
    () => fetchAshby(GH, none, fake(() => reply({ jobs: [{ id: h, title: h, location: place, secondaryLocations: [{ location: h }], descriptionPlain: h, jobUrl: h, employmentType: h, compensation: { compensationTierSummary: h } }] })).fetch, noSleep),
    () =>
      fetchSmartRecruiters(
        GH,
        none,
        fake((c) => (c.url.includes("?") ? reply({ totalFound: 1, content: [{ id: "1" }] }) : reply({ name: h, location: { city: h }, postingUrl: h, typeOfEmployment: { label: h }, jobAd: { sections: { companyDescription: { text: h }, jobDescription: { text: h }, qualifications: { text: h }, additionalInformation: { text: h } } } }))).fetch, noSleep,
      ),
    () =>
      fetchWorkday(
        WD,
        none,
        fake((c) => (c.method === "POST" ? reply({ total: 1, jobPostings: [{ externalPath: "/job/x" }] }) : reply({ jobPostingInfo: { title: h, location: place, additionalLocations: [h], jobDescription: h, externalUrl: h, timeType: h } }))).fetch, noSleep,
      ),
    () => fetchAmazon(undefined, none, fake(() => reply({ hits: 1, jobs: [{ id_icims: h, job_path: h, title: h, normalized_location: h, description: h, basic_qualifications: h, preferred_qualifications: h, job_schedule_type: h }] })).fetch, noSleep),
  ];
  it.each(cases.map((c, i) => [["greenhouse", "ashby", "smartrecruiters", "workday", "amazon"][i], c] as const))("%s gives a clean record", async (n, run) => {
    const r = await run();
    expect(r.adverts).toHaveLength(1);
    for (const v of Object.values(r.adverts[0]!)) expect(typeof v).toBe("string");
    // Every description goes through text(), which drops a complete tag. Ashby's descriptionPlain is plain text in the
    // Python too (not passed through text()), so it is kept as given: whoever shows it must escape it.
    if (n === "ashby") expect(r.adverts[0]!.description).toBe(h);
    else expect(r.adverts[0]!.description).not.toContain("<script>");
  });
});

// ---- size ------------------------------------------------------------------------------------------------------------
describe("big and long input", () => {
  const MB = 1024 * 1024;
  it("a 10 MB description is read in time", async () => {
    const body = { jobs: [{ id: 1, title: "t", location: { name: "Dublin" }, content: "&lt;p&gt;" + "word ".repeat(2 * MB) + "&lt;/p&gt;", absolute_url: "u" }] };
    const { value, ms } = await timed(() => fetchGreenhouse(GH, none, fake(() => reply(body)).fetch, noSleep));
    expect(value.adverts[0]!.description.length).toBeGreaterThan(9 * MB);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a 10 MB body that is not JSON is a failure, in time", async () => {
    const { ms } = await timed(() => expect(fetchGreenhouse(GH, none, fake(() => new Response("x".repeat(10 * MB))).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a body over the 32 MB cap is a failure, even one that is valid JSON", async () => {
    const big = JSON.stringify({ jobs: [], pad: "x".repeat(33 * MB) });
    await expect(fetchGreenhouse(GH, none, fake(() => new Response(big)).fetch, noSleep)).rejects.toThrow("too large");
  });
  it("a declared length over the cap is refused before the body is read", async () => {
    const res = new Response("{}", { headers: { "content-length": String(40 * MB) } });
    const read = vi.spyOn(res, "text");
    await expect(fetchGreenhouse(GH, none, fake(() => res).fetch, noSleep)).rejects.toThrow("too large");
    expect(read).not.toHaveBeenCalled();
  });

  // The Python's regular expressions are quadratic on some of these (a "<" with no ">" after it). text() does not hang.
  const pathological: [string, string][] = [
    ["1 MB of '<'", "<".repeat(MB)],
    ["1 MB of '<br'", "<br".repeat(MB / 3)],
    ["1 MB of '</p'", "</p".repeat(MB / 3)],
    ["1 MB of '<>'", "<>".repeat(MB / 2)],
    ["1 MB of '&'", "&".repeat(MB)],
    ["1 MB of '&#' and digits", "&#" + "9".repeat(MB) + ";"],
    ["1 MB of '&#x' and hex", "&#x" + "f".repeat(MB)],
    ["1 MB of '&amp' with no semicolon", "&amp".repeat(MB / 4)],
    ["1 MB of 32-letter entity names", ("&" + "a".repeat(32)).repeat(MB / 33)],
    ["1 MB line with no spaces", "x".repeat(MB)],
    ["1 MB of blank lines with spaces", "\n \n".repeat(MB / 3)],
    ["1 MB newline then spaces then text", "\n" + " ".repeat(MB) + "x"],
    ["1 MB of spaces and tabs", " \t".repeat(MB / 2)],
    ["1 MB of digits and commas", "1,".repeat(MB / 2)],
    ["1 MB of currency signs", "€$£".repeat(MB / 3)],
    ["1 MB of null bytes", "\u0000".repeat(MB)],
    ["1 MB of a tag with a huge attribute and no end", "<a " + "b=c ".repeat(MB / 4)],
  ];
  it.each(pathological)("text() over %s", async (_n, s) => {
    const { ms } = await timed(() => text(s));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a 1 MB advert goes through a whole adapter in time", async () => {
    const body = { jobs: [{ id: 1, title: "t", location: { name: "Dublin" }, content: "<".repeat(MB), absolute_url: "u" }] };
    const { value, ms } = await timed(() => fetchGreenhouse(GH, none, fake(() => reply(body)).fetch, noSleep));
    expect(value.adverts).toHaveLength(1);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a title or location of 1 MB goes through the Irish filter in time", async () => {
    const body = { jobs: [{ id: 1, title: "t", location: "x".repeat(MB) + " Dublin" }, { id: 2, title: "t", location: "Dublin".repeat(MB / 6) }, { id: 3, title: "t", location: "é".repeat(MB) }] };
    const { value, ms } = await timed(() => fetchAshby(GH, none, fake(() => reply(body)).fetch, noSleep));
    expect(value.seen).toHaveLength(1); // only the first: "Dublin" repeated has no word boundary
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a list of 100,000 postings is read once, in time", async () => {
    const jobs = Array.from({ length: 100_000 }, (_, i) => ({ id: i, title: "t", location: { name: i % 2 ? "Dublin" : "Paris" }, content: "", absolute_url: "u" }));
    const { value, ms } = await timed(() => fetchGreenhouse(GH, none, fake(() => reply({ jobs })).fetch, noSleep));
    expect(value.seen).toHaveLength(50_000);
    expect(ms).toBeLessThan(BUDGET_MS * 2);
  });
});

// ---- a list that lies about its size --------------------------------------------------------------------------------
describe("a list that claims a million postings", () => {
  it("smartrecruiters: stops after 50 list requests with the typed error", async () => {
    const { fetch, calls } = fake((c) => {
      const off = Number(new URL(c.url).searchParams.get("offset"));
      return reply({ totalFound: 1_000_000, content: Array.from({ length: 100 }, (_, i) => ({ id: String(off + i) })) });
    });
    const known = new Set(Array.from({ length: 5000 }, (_, i) => `smartrecruiters:acme:${i}`));
    await expect(fetchSmartRecruiters(GH, known, fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    expect(calls).toHaveLength(50);
  });
  it("amazon: stops after 50 list requests with the typed error", async () => {
    const { fetch, calls } = fake((c) => {
      const off = Number(new URL(c.url).searchParams.get("offset"));
      return reply({ hits: 1_000_000, jobs: Array.from({ length: 100 }, (_, i) => ({ id_icims: String(off + i), job_path: "/p" })) });
    });
    await expect(fetchAmazon(undefined, none, fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    expect(calls).toHaveLength(50);
  });
  it("workday: the 600 rule holds, 31 list requests", async () => {
    const { fetch, calls } = fake(() => reply({ total: 1_000_000, jobPostings: [] }));
    await fetchWorkday(WD, none, fetch, noSleep);
    expect(calls).toHaveLength(31);
  });
  it("an empty page ends paging early (no 10,000 empty requests)", async () => {
    const sr = fake(() => reply({ totalFound: 1_000_000, content: [] }));
    expect(await fetchSmartRecruiters(GH, none, sr.fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    expect(sr.calls).toHaveLength(1);
    const am = fake(() => reply({ hits: 1_000_000, jobs: [] }));
    expect(await fetchAmazon(undefined, none, am.fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    expect(am.calls).toHaveLength(1);
  });
  it("totals that are not numbers are a failure, not a loop", async () => {
    for (const total of ["99999999", null, {}, [5]]) {
      await expect(fetchSmartRecruiters(GH, none, fake(() => reply({ totalFound: total, content: [] })).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
      await expect(fetchWorkday(WD, none, fake(() => reply({ total, jobPostings: [] })).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
      await expect(fetchAmazon(undefined, none, fake(() => reply({ hits: total, jobs: [] })).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    }
  });
});

// ---- only the host the adapter was given ------------------------------------------------------------------------------
describe("the adapter only calls the host it was given", () => {
  const EVIL = ["//evil.example/x", "@evil.example/x", "https://evil.example/x", "/../../../evil", "\\\\evil.example\\x", ":443@evil.example", "?u=https://evil.example/", "#@evil.example", "\n@evil.example"];
  it.each(EVIL)("workday externalPath %j", async (path) => {
    const { fetch, calls } = fake((c) => (c.method === "POST" ? reply({ total: 1, jobPostings: [{ externalPath: path }] }) : reply({ jobPostingInfo: { title: "t", location: "Dublin" } })));
    await fetchWorkday(WD, none, fetch, noSleep).catch((e: unknown) => expect(e).toBeInstanceOf(FetchFailedError));
    for (const c of calls) expect(new URL(c.url).host).toBe("acme.wd3.myworkdayjobs.com");
  });
  it.each(EVIL)("smartrecruiters posting id %j", async (id) => {
    const { fetch, calls } = fake((c) => (c.url.includes("?") ? reply({ totalFound: 1, content: [{ id }] }) : reply({ name: "t" })));
    await fetchSmartRecruiters(GH, none, fetch, noSleep).catch((e: unknown) => expect(e).toBeInstanceOf(FetchFailedError));
    for (const c of calls) expect(new URL(c.url).host).toBe("api.smartrecruiters.com");
  });
  it("a url field in the response (postingUrl, absolute_url, externalUrl, jobUrl) is data, never requested", async () => {
    const evil = "https://evil.example/steal";
    const sr = fake((c) => (c.url.includes("?") ? reply({ totalFound: 1, content: [{ id: "1", ref: evil }] }) : reply({ name: "t", postingUrl: evil, ref: evil })));
    await fetchSmartRecruiters(GH, none, sr.fetch, noSleep);
    const wd = fake((c) => (c.method === "POST" ? reply({ total: 1, jobPostings: [{ externalPath: "/j", url: evil }] }) : reply({ jobPostingInfo: { location: "Dublin", externalUrl: evil } })));
    await fetchWorkday(WD, none, wd.fetch, noSleep);
    const gh = fake(() => reply({ jobs: [{ id: 1, title: "t", location: { name: "Dublin" }, absolute_url: evil }] }));
    await fetchGreenhouse(GH, none, gh.fetch, noSleep);
    for (const c of [...sr.calls, ...wd.calls, ...gh.calls]) expect(c.url).not.toContain("evil");
  });
  it("a redirect to another host is a failure and the other host is never called", async () => {
    const run = [
      (f: ReturnType<typeof fake>["fetch"]) => fetchGreenhouse(GH, none, f, noSleep),
      (f: ReturnType<typeof fake>["fetch"]) => fetchAshby(GH, none, f, noSleep),
      (f: ReturnType<typeof fake>["fetch"]) => fetchSmartRecruiters(GH, none, f, noSleep),
      (f: ReturnType<typeof fake>["fetch"]) => fetchWorkday(WD, none, f, noSleep),
      (f: ReturnType<typeof fake>["fetch"]) => fetchAmazon(undefined, none, f, noSleep),
    ];
    for (const r of run) {
      for (const to of ["https://evil.example/x", "http://acme.wd3.myworkdayjobs.com.evil.example/", "//evil.example/", "https://evil.example@boards-api.greenhouse.io/"]) {
        const { fetch, calls } = fake((c) => (c.url.includes("evil.example") && !c.url.includes("@") ? reply({}) : redirect(to)));
        await expect(r(fetch)).rejects.toBeInstanceOf(FetchFailedError);
        expect(calls.filter((c) => new URL(c.url).hostname.endsWith("evil.example"))).toHaveLength(0);
      }
    }
  });
  it("a redirect on the same host is followed for a GET, at most 3 hops", async () => {
    let n = 0;
    const { fetch, calls } = fake(() => (n++ < 3 ? redirect("/v1/boards/acme/jobs?content=true&x=" + n) : reply({ jobs: [] })));
    expect(await fetchGreenhouse(GH, none, fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    expect(calls).toHaveLength(4);
    const loop = fake(() => redirect("/again"));
    await expect(fetchGreenhouse(GH, none, loop.fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    expect(loop.calls).toHaveLength(4);
  });
  it("a POST redirect that would change the method is a failure; one that keeps it is followed", async () => {
    const a = fake(() => redirect("/other", 302));
    await expect(fetchWorkday(WD, none, a.fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
    expect(a.calls).toHaveLength(1);
    let n = 0;
    const b = fake(() => (n++ ? reply({ total: 0 }) : redirect("/wday/cxs/acme/External/jobs", 307)));
    expect(await fetchWorkday(WD, none, b.fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    expect(b.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });
  it("a redirect with no Location is a failure", async () => {
    await expect(fetchGreenhouse(GH, none, fake(() => new Response(null, { status: 302 })).fetch, noSleep)).rejects.toThrow("HTTP 302 redirect not followed");
  });
  // 14 Nov 2026: 13 Workday boards failed with a bare "HTTP 303 redirect not followed", so the log could not show where Workday sent us.
  it("a refused redirect names where it pointed: no query, no fragment, no credentials, at most 120 characters of address", async () => {
    const why = async (loc: string, status = 303) => (await fetchWorkday(WD, none, fake(() => redirect(loc, status)).fetch, noSleep).catch((e: Error) => e.message)) as string;
    expect(await why("https://community.workday.com/maintenance-page?token=s3cret#frag")).toBe("HTTP 303 redirect to https://community.workday.com/maintenance-page not followed");
    expect(await why("/wday/maintenance", 302)).toBe("HTTP 302 redirect to https://acme.wd3.myworkdayjobs.com/wday/maintenance not followed");
    expect(await why("https://admin:hunter2@evil.example/x")).toBe("HTTP 303 redirect to https://evil.example/x not followed");
    const long = await why("/" + "a".repeat(5000));
    expect(long.length).toBe("HTTP 303 redirect to  not followed".length + 120);
    expect(await why("http://[not-an-address")).toBe("HTTP 303 redirect to an unreadable address not followed");
    expect(await why("javascript:alert(1)//\u0007")).not.toMatch(/[\u0000-\u001f]/u);
  });
});

// ---- no network without the injected fetch -----------------------------------------------------------------------------
describe("no adapter reaches the network by itself", () => {
  it("the global fetch is never called when a fake is passed", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await fetchGreenhouse(GH, none, fake(() => reply({ jobs: [] })).fetch, noSleep);
    await fetchAshby(GH, none, fake(() => reply({ jobs: [] })).fetch, noSleep);
    await fetchSmartRecruiters(GH, none, fake(() => reply({ content: [] })).fetch, noSleep);
    await fetchWorkday(WD, none, fake(() => reply({})).fetch, noSleep);
    await fetchAmazon(undefined, none, fake(() => reply({ jobs: [], hits: 0 })).fetch, noSleep);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("the source files name no network library and use fetch only as the parameter", () => {
    const dir = new URL(".", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => /^(adapters|shared|index)\.ts$/.test(n))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/node:(http|https|net|tls|dns|dgram|child_process)|from "(undici|axios|node-fetch|got|ky|request)"|globalThis\.fetch|XMLHttpRequest|WebSocket/);
      expect(src.match(/\bfetch\(/g)?.length ?? 0, f).toBeLessThanOrEqual(1); // the one call inside makeCaller
    }
  });
});

// ---- time out -------------------------------------------------------------------------------------------------------
describe("timeout", () => {
  it("every request carries a 45 second timeout signal, and its firing is a typed failure", async () => {
    // AbortSignal.timeout is not driven by fake timers, so the test takes the signal and fires it itself.
    const ctrl = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctrl.signal);
    try {
      const { fetch } = fake((c) => new Promise<Response>((_, reject) => c.signal?.addEventListener("abort", () => reject(c.signal?.reason))));
      const p = fetchGreenhouse(GH, none, fetch, noSleep).then(() => null, (e: unknown) => e);
      await Promise.resolve();
      expect(spy).toHaveBeenCalledWith(45_000);
      ctrl.abort(new DOMException("The operation timed out.", "TimeoutError"));
      const e = await p;
      expect(e).toBeInstanceOf(FetchFailedError);
      expect((e as FetchFailedError).message).toContain("TimeoutError");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---- odd JSON ----------------------------------------------------------------------------------------------------------
describe("odd JSON", () => {
  it("object-prototype key names in the body are plain keys", async () => {
    const body = JSON.parse('{"__proto__":{"jobs":[{"id":1}]},"constructor":{"jobs":1},"jobs":[]}') as unknown;
    expect(await fetchGreenhouse(GH, none, fake(() => reply(body)).fetch, noSleep)).toEqual({ seen: [], adverts: [] });
    const noJobs = JSON.parse('{"__proto__":{"jobs":[{"id":1}]}}') as unknown;
    await expect(fetchGreenhouse(GH, none, fake(() => reply(noJobs)).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError); // inherited "jobs" does not count
  });
  it("deeply nested JSON is a typed failure or a normal read, never a crash", async () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    await expect(fetchGreenhouse(GH, none, fake(() => new Response(deep)).fetch, noSleep)).rejects.toBeInstanceOf(FetchFailedError);
  });
  it("empty and missing fields in every position are typed failures or clean records", async () => {
    for (const j of [{}, { id: null }, { id: 1, title: null, location: {} }, { location: { name: "Dublin" } }, null, 5, "x", []]) {
      const r = await fetchGreenhouse(GH, none, fake(() => reply({ jobs: [j] })).fetch, noSleep).then(() => "ok", (e: unknown) => e);
      if (r !== "ok") expect(r).toBeInstanceOf(FetchFailedError);
    }
  });
});
