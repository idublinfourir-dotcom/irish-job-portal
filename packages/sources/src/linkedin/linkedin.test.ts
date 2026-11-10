// Unit tests for the LinkedIn adapter: a fake fetch, a fake sleep, made-up text only.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseLinkedinDetail, searchUrl, TERM_GROUPS } from "./index";
import { detailPage, fixture, idOf, isSearch, ORIGIN, page, redirect, row, run, searchPage, startOf, termOf, TODAY } from "./testkit";

const empty = (c: { url: string }) => (isSearch(c.url) ? page("") : page(detailPage()));
const terms = TERM_GROUPS.flatMap(([, t]) => t);

describe("the terms", () => {
  it("44 terms in 7 groups, in the Python order", () => {
    expect(terms.length).toBe(44);
    expect(TERM_GROUPS.map(([g, t]) => [g, t.length])).toEqual([["health", 18], ["hospitality", 3], ["it", 6], ["construction", 8], ["finance", 4], ["pharma", 4], ["retail", 1]]);
  });
});

describe("the search", () => {
  it("the URL shape for the first request", async () => {
    const { urls } = await run(empty);
    expect(urls[0]).toBe(`${ORIGIN}/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=staff%20nurse&location=Ireland&start=0`);
  });
  it("the Python's header and a 30 second limit go with every request", async () => {
    const { calls } = await run(empty);
    expect(calls[0]!.headers).toEqual({ "User-Agent": expect.stringContaining("Chrome/128.0") });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("an empty first page ends the term at once: 44 requests, no sleep", async () => {
    const { calls, waits, result } = await run(empty);
    expect(calls.length).toBe(44);
    expect(waits).toEqual([]);
    expect(result.stop).toBeNull();
    expect(new Set(calls.map((c) => termOf(c.url))).size).toBe(44);
  });
  it("pages on with start = ids seen so far, at most 4 pages a term, and a sleep of 1.5 to 2.5 s after each page with ids", async () => {
    const { urls, waits } = await run((c) => (termOf(c.url) === "staff nurse" ? page(searchPage([startOf(c.url) + 1, startOf(c.url) + 2, startOf(c.url) + 3])) : page("")));
    expect(urls.filter((u) => termOf(u) === "staff nurse").map(startOf)).toEqual([0, 3, 6, 9]);
    expect(waits.slice(0, 4)).toEqual([1500, 1500, 1500, 1500]); // then 1200 before each detail
  });
  it("the wait is 1500 + random * 1000", async () => {
    const { waits } = await run((c) => (termOf(c.url) === "midwife" && startOf(c.url) === 0 ? page(searchPage([5])) : page("")), [], { random: () => 0.5 });
    expect(waits[0]).toBe(2000);
  });
  it("ids are deduplicated within a page, in order; seenCount sums the pages", async () => {
    const { result } = await run((c) => (termOf(c.url) === "midwife" ? page(searchPage([3, 1, 3, 2, 1])) : page("")));
    expect(result.waiting.map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(result.seen).toEqual(["3", "1", "2"]);
    expect(result.seenCount).toBe(3 * 4); // known quirk below: the same page comes back for every start
  });
  it("known quirk: an id on two pages counts twice in seenCount but once in seen", async () => {
    const { result } = await run((c) => (termOf(c.url) === "midwife" ? page(searchPage([7])) : page("")));
    expect(result.seenCount).toBe(4);
    expect(result.seen).toEqual(["7"]);
  });
  it("new rows carry the term, the group and today's date; the first group name comes from the terms table", async () => {
    const { result } = await run((c) => (termOf(c.url) === "sous chef" && startOf(c.url) === 0 ? page(searchPage([42])) : page("")));
    expect(result.waiting.filter((r) => r.id === "42")).toEqual([{ id: "42", term: "sous chef", group: "hospitality", firstSeen: TODAY, lastSeen: TODAY, done: true }]); // done: this run read it
  });
  it("an id already in the list keeps its term, group, first date and done flag; only lastSeen changes", async () => {
    const old = row(9, "retail", { term: "store manager", firstSeen: "2026-10-01", lastSeen: "2026-10-02", done: true });
    const { result, urls } = await run((c) => (termOf(c.url) === "midwife" && startOf(c.url) === 0 ? page(searchPage([9])) : page("")), [old]);
    expect(result.waiting).toEqual([{ ...old, lastSeen: TODAY }]);
    expect(urls.some((u) => idOf(u) === "9")).toBe(false); // a done id is not read again
  });
  it("known quirk: any other status in the search (here 500 and 404) just ends the term and the search goes on", async () => {
    const { calls, result } = await run((c) => (termOf(c.url) === "staff nurse" ? page("boom", 500) : termOf(c.url) === "midwife" ? page("", 404) : page("")));
    expect(calls.length).toBe(44);
    expect(result.stop).toBeNull();
  });
  it("known quirk: only spaces are escaped in the term", () => {
    expect(searchUrl("c++ dev & co/é", 5)).toBe(`${ORIGIN}/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=c++%20dev%20&%20co/é&location=Ireland&start=5`);
    expect(terms.every((t) => /^[a-z ]+$/.test(t))).toBe(true); // so today the quirk changes nothing
  });
  it("reads the real shape of a search page (fixture: real class names, made-up text)", async () => {
    const { result } = await run((c) => (termOf(c.url) === "staff nurse" && startOf(c.url) === 0 ? page(fixture("search-page.html")) : page("")));
    expect(result.seen).toEqual(["1000000001", "1000000002", "1000000003"]);
  });
});

describe("searchFrom and searchNext", () => {
  it("searchNext is 44 when the search ran to its end, and a run started at 44 makes no search request", async () => {
    const a = await run(empty);
    expect(a.result.searchNext).toBe(44);
    const b = await run(empty, [row(1)], { searchFrom: 44 });
    expect(b.urls.filter(isSearch)).toEqual([]);
    expect(b.result.adverts).toHaveLength(1);
  });
  it("starts at the term it is given; a bad value means 0", async () => {
    expect(termOf((await run(empty, [], { searchFrom: 43 })).urls[0]!)).toBe("store manager");
    for (const bad of [-1, 1.5, NaN, Infinity]) expect(termOf((await run(empty, [], { searchFrom: bad })).urls[0]!)).toBe("staff nurse");
  });
  it("a 429 in the search leaves searchNext at the term that was refused", async () => {
    const { result } = await run((c) => (termOf(c.url) === "midwife" ? page("", 429) : page("")));
    expect(result.searchNext).toBe(3);
  });
  it("the backlog rule leaves searchNext as it was given", async () => {
    const { result } = await run(empty, Array.from({ length: 251 }, (_, i) => row(100 + i)), { searchFrom: 7 });
    expect(result.searchNext).toBe(7);
  });
});

describe("the backlog rule", () => {
  const waiting = (n: number) => Array.from({ length: n }, (_, i) => row(100 + i));
  it("250 waiting: the search runs (44 requests), then 250 details", async () => {
    const { calls } = await run(empty, waiting(250));
    expect(calls.filter((c) => isSearch(c.url)).length).toBe(44);
    expect(calls.length).toBe(44 + 250);
  });
  it("251 waiting: no search at all, 250 details, one id left", async () => {
    const { calls, result } = await run(empty, waiting(251));
    expect(calls.filter((c) => isSearch(c.url)).length).toBe(0);
    expect(calls.length).toBe(250);
    expect(result.waiting.filter((r) => !r.done).length).toBe(1);
  });
  it("done rows do not count as waiting", async () => {
    const { calls } = await run(empty, [...waiting(250), ...Array.from({ length: 50 }, (_, i) => row(900 + i, "health", { done: true }))]);
    expect(calls.filter((c) => isSearch(c.url)).length).toBe(44);
  });
});

describe("the batch", () => {
  const detailIds = (urls: string[]) => urls.filter((u) => !isSearch(u)).map(idOf);
  const list = [row(1, "health"), row(2, "health"), row(3, "health"), row(4, "it"), row(5, "it"), row(6, "retail"), row(7, "health", { done: true })];
  it("one from each group in turn (group names in plain string order), at random inside a group, never a done id", async () => {
    // random() = 0 makes the shuffle [a,b,c] -> [b,c,a]
    const { urls } = await run(empty, list, { random: () => 0 });
    expect(detailIds(urls)).toEqual(["2", "5", "6", "3", "4", "1"]);
  });
  it("the order inside a group follows random", async () => {
    const a = await run(empty, list, { random: () => 0 });
    const b = await run(empty, list, { random: () => 0.99 });
    expect(detailIds(a.urls).filter((i) => "123".includes(i))).not.toEqual(detailIds(b.urls).filter((i) => "123".includes(i)));
  });
  it("at most 250 are read", async () => {
    const { urls } = await run(empty, Array.from({ length: 300 }, (_, i) => row(1000 + i, i % 2 ? "it" : "health")));
    expect(detailIds(urls).length).toBe(250);
  });
  it("a sleep of 1.2 to 2.2 s comes before each detail", async () => {
    const { waits } = await run(empty, [row(1), row(2)], { random: () => 0.25 });
    expect(waits.slice(-2)).toEqual([1450, 1450]);
  });
  it("the detail URL is the jobPosting API with the id", async () => {
    const { urls } = await run(empty, [row(1234567890)]);
    expect(urls.at(-1)).toBe(`${ORIGIN}/jobs-guest/jobs/api/jobPosting/1234567890`);
  });
  it("ids found by this run's search are read in the same run", async () => {
    const { result } = await run((c) => (isSearch(c.url) ? (termOf(c.url) === "midwife" && startOf(c.url) === 0 ? page(searchPage([77])) : page("")) : page(detailPage({ title: "T77" }))));
    expect(result.adverts.map((a) => a.id)).toEqual(["linkedin:ie:77"]);
    expect(result.waiting.find((r) => r.id === "77")!.done).toBe(true);
  });
  it("the input list is not changed", async () => {
    const input = [row(1)];
    const copy = structuredClone(input);
    await run(empty, input);
    expect(input).toEqual(copy);
  });
});

describe("the detail parse", () => {
  const full = parseLinkedinDetail("55", detailPage({ title: " Nurse ", employer: "Acme Ltd", place: "Cork, Ireland", desc: "Line one.<br>Line two", type: "Full-time", salary: "&euro;40,000" }));
  it("every field", () => {
    expect(full).toEqual({
      id: "linkedin:ie:55", source: "linkedin", board: "ie", employer: "Acme Ltd", title: "Nurse", location: "Cork, Ireland",
      description: "Line one.\nLine two", url: `${ORIGIN}/jobs/view/55`, employmentType: "Full-time", salaryBox: "€40,000",
    });
  });
  it("a missing field is an empty string, not a failure", () => {
    expect(parseLinkedinDetail("1", '<h2 class="topcard__title">Only a title</h2>')).toEqual({
      id: "linkedin:ie:1", source: "linkedin", board: "ie", employer: "", title: "Only a title", location: "", description: "", url: `${ORIGIN}/jobs/view/1`, employmentType: "", salaryBox: "",
    });
  });
  it("the employer falls back to the plain topcard__flavor span", () => {
    expect(parseLinkedinDetail("1", fixture("detail-bare.html")).employer).toBe("Plain Employer Ltd");
  });
  it("the link wins over the plain span", () => {
    expect(parseLinkedinDetail("1", '<span class="topcard__flavor">Plain</span><a class="topcard__org-name-link x">Linked</a>').employer).toBe("Linked");
  });
  it("the criteria table pairs the n-th heading with the n-th text; only 'Employment type' is used", () => {
    const d = fixture("detail-page.html");
    expect(parseLinkedinDetail("1", d).employmentType).toBe("Full-time");
    expect(parseLinkedinDetail("1", d.replace("Employment type", "Job function")).employmentType).toBe("");
  });
  it("HTML in the description: tags go, break tags become new lines, entities are decoded", () => {
    const a = parseLinkedinDetail("1", fixture("detail-page.html"));
    expect(a.description).toBe("About the role \n\n\n We need a made up nurse & a made up second nurse.\n\n Made up duty one\n Made up duty two");
    expect(a.title).toBe("Made Up Staff Nurse");
    expect(a.location).toBe("Dublin, County Dublin, Ireland");
    expect(a.salaryBox).toBe("€40,000 - €50,000");
  });
  it("the fixture with real class names gives an advert with a non-empty id, title and url", () => {
    const a = parseLinkedinDetail("1000000001", fixture("detail-page.html"));
    expect(a.id && a.title && a.url).toBeTruthy();
  });
  it("known quirk: criteria values are not HTML-unescaped (the employment type keeps its entity)", () => {
    expect(parseLinkedinDetail("1", detailPage({ type: "Full&#45;time &amp; more" })).employmentType).toBe("Full&#45;time &amp; more");
  });
  it("known quirk: the description ends at the first closing div, so a nested div cuts it short", () => {
    const d = '<div class="show-more-less-html__markup"><div>inner</div> after the inner div</div>';
    expect(parseLinkedinDetail("1", d).description).toBe("inner");
  });
  it("known quirk: when a heading repeats the later one wins; extra headings without a text are dropped", () => {
    const k = (s: string) => `<h3 class="description__job-criteria-subheader">${s}</h3>`;
    const v = (s: string) => `<span class="description__job-criteria-text">${s}</span>`;
    expect(parseLinkedinDetail("1", k("Employment type") + v("Part-time") + k("Employment type") + v("Contract")).employmentType).toBe("Contract");
    expect(parseLinkedinDetail("1", k("Seniority") + k("Employment type") + v("Mid")).employmentType).toBe(""); // "Employment type" has no text to pair with
  });
  it("known quirk: a criteria text that is only white space comes out as its last character", () => {
    const d = '<h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text">   </span>';
    expect(parseLinkedinDetail("1", d).employmentType).toBe(" ");
  });
  it("a criteria text that starts with a tag gives nothing", () => {
    const d = '<h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text"><b>Full</b>-time</span>';
    expect(parseLinkedinDetail("1", d).employmentType).toBe(""); // the text starts with "<": no match, as in Python
  });
  it("known quirk: a 200 page with none of the known class names still gives an advert, with every field empty", async () => {
    const { result } = await run((c) => (isSearch(c.url) ? page("") : page("<html>sign in to continue</html>")), [row(8)]);
    expect(result.adverts).toHaveLength(1);
    expect(result.adverts[0]).toMatchObject({ id: "linkedin:ie:8", title: "", employer: "", description: "" });
  });
});

describe("stops: 429, 999 and 403", () => {
  const stopAt = (status: number) => (c: { url: string }) => page("limit", status, c.url.includes("start=3") ? {} : {});
  for (const status of [429, 999, 403]) {
    it(`known quirk: a ${status} in the search skips the whole detail phase (no advert is read), and the ids found before it are kept`, async () => {
      // staff nurse gives one page of ids, then the second page is refused
      const { result, urls } = await run((c) => (startOf(c.url) === 0 ? page(searchPage([1, 2])) : stopAt(status)(c)), [row(50)]);
      expect(result.stop).toEqual({ phase: "search", reason: "limit", status, message: `search stopped: status ${status}` });
      expect(result.waiting.map((r) => [r.id, r.done])).toEqual([["50", false], ["1", false], ["2", false]]);
      expect(result.adverts).toEqual([]);
      expect(urls.some((u) => !isSearch(u))).toBe(false); // known quirk: a stop in the search means no advert is read this run
      expect(result.requests).toBe(urls.length);
    });
    it(`${status} in the detail phase: stop, keep the adverts read, the refused id stays waiting`, async () => {
      // random 0: the order inside the group is [b, c, a] = 2, 3, 1
      const { result } = await run((c) => (isSearch(c.url) ? page("") : idOf(c.url) === "3" ? page("limit", status) : page(detailPage({ title: `T${idOf(c.url)}` }))), [row(1), row(2), row(3)]);
      expect(result.stop).toEqual({ phase: "detail", reason: "limit", status, message: `detail stopped: status ${status}` });
      expect(result.adverts.map((a) => a.title)).toEqual(["T2"]);
      expect(Object.fromEntries(result.waiting.map((r) => [r.id, r.done]))).toEqual({ 1: false, 2: true, 3: false });
    });
  }
  it("known quirk: an id is marked done before its page is read, so a bad page (500) is never tried again", async () => {
    const first = await run((c) => (isSearch(c.url) ? page("") : page("oops", 500)), [row(1)]);
    expect(first.result.waiting[0]!.done).toBe(true);
    expect(first.result.adverts).toEqual([]);
    const second = await run(empty, first.result.waiting);
    expect(second.urls.filter((u) => !isSearch(u))).toEqual([]);
  });
  it("an empty 200 page also counts as read (done, no advert)", async () => {
    const { result } = await run((c) => (isSearch(c.url) ? page("") : page("")), [row(1)]);
    expect(result.waiting[0]!.done).toBe(true);
    expect(result.adverts).toEqual([]);
  });
  it("a fetch that fails (network down) ends the run as a typed stop and keeps the state", async () => {
    const { result } = await run((c) => {
      if (isSearch(c.url)) return page("");
      throw new TypeError("fetch failed");
    }, [row(1)]);
    expect(result.stop).toEqual({ phase: "detail", reason: "network", status: null, message: "detail stopped: request failed" });
    expect(result.waiting[0]!.done).toBe(false);
  });
  it("the run's own output is a plain object that survives JSON (L8 saves it)", async () => {
    const { result } = await run((c) => (isSearch(c.url) ? page("") : page(detailPage())), [row(1)]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("retry on 429 (decision #144, off by default)", () => {
  const limited = (n: number, headers: Record<string, string> = {}) => {
    let left = n;
    return (c: { url: string }) => (isSearch(c.url) && left-- > 0 ? page("slow down", 429, headers) : isSearch(c.url) ? page("") : page(detailPage()));
  };
  it("off by default: the first 429 stops the run", async () => {
    const { result, calls } = await run(limited(1));
    expect(result.stop).toMatchObject({ phase: "search", status: 429 });
    expect(calls.length).toBe(1);
  });
  it("the first wait, then doubled each time", async () => {
    const { result, waits, calls } = await run(limited(3), [], { options: { retry: { tries: 5, firstWaitMs: 1000 } } });
    expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(result.stop).toBeNull();
    expect(calls.slice(0, 4).map((c) => c.url)).toEqual(Array(4).fill(calls[0]!.url)); // the same request each time
  });
  it("Retry-After in seconds wins over the doubling", async () => {
    const { waits } = await run(limited(2, { "retry-after": "7" }), [], { options: { retry: { tries: 5, firstWaitMs: 1000 } } });
    expect(waits.slice(0, 2)).toEqual([7000, 7000]);
  });
  it("Retry-After as a date is counted from the response's own Date header", async () => {
    const { waits } = await run(limited(1, { "retry-after": "Tue, 10 Nov 2026 08:20:30 GMT", date: "Tue, 10 Nov 2026 08:20:00 GMT" }), [], { options: { retry: { tries: 2, firstWaitMs: 1000 } } });
    expect(waits[0]).toBe(30_000);
  });
  it("no wait is longer than the cap (default 5 minutes); a year in Retry-After is cut", async () => {
    const a = await run(limited(1, { "retry-after": "31536000" }), [], { options: { retry: { tries: 2, firstWaitMs: 1000 } } });
    expect(a.waits[0]).toBe(300_000);
    const b = await run(limited(1, { "retry-after": "31536000" }), [], { options: { retry: { tries: 2, firstWaitMs: 1000, maxWaitMs: 60_000 } } });
    expect(b.waits[0]).toBe(60_000);
    const c = await run(limited(9), [], { options: { retry: { tries: 9, firstWaitMs: 100_000 } } });
    expect(Math.max(...c.waits.slice(0, 9))).toBe(300_000);
  });
  it("a negative, zero, garbled or past Retry-After falls back to the doubling", async () => {
    for (const h of ["-5", "0", "soon", "", "Mon, 09 Nov 2026 08:20:00 GMT"]) {
      const { waits } = await run(limited(1, { "retry-after": h, date: "Tue, 10 Nov 2026 08:20:00 GMT" }), [], { options: { retry: { tries: 2, firstWaitMs: 1500 } } });
      expect(waits[0]).toBe(1500);
    }
  });
  it("gives up when the tries are used up, and stops as the Python does", async () => {
    const { result, calls, waits } = await run(limited(99), [], { options: { retry: { tries: 2, firstWaitMs: 10 } } });
    expect(calls.length).toBe(3); // the first try and 2 more
    expect(waits).toEqual([10, 20]);
    expect(result.stop).toEqual({ phase: "search", reason: "limit", status: 429, message: "search stopped: status 429" });
  });
  it("tries: 0 is the same as off", async () => {
    const { calls } = await run(limited(99), [], { options: { retry: { tries: 0, firstWaitMs: 10 } } });
    expect(calls.length).toBe(1);
  });
  for (const status of [999, 403]) {
    it(`${status} is never retried`, async () => {
      const { calls, waits, result } = await run(() => page("no", status), [], { options: { retry: { tries: 5, firstWaitMs: 10 } } });
      expect(calls.length).toBe(1);
      expect(waits).toEqual([]);
      expect(result.stop).toMatchObject({ status });
    });
  }
  it("500 is not retried either", async () => {
    const { calls } = await run((c) => (isSearch(c.url) ? page("", 500) : page("")), [], { options: { retry: { tries: 5, firstWaitMs: 10 } } });
    expect(calls.length).toBe(44);
  });
  it("works in the detail phase too: the same id is asked again, then read once", async () => {
    let n = 0;
    const { result, urls } = await run((c) => (isSearch(c.url) ? page("") : n++ === 0 ? page("", 429) : page(detailPage())), [row(5)], { options: { retry: { tries: 1, firstWaitMs: 10 } } });
    expect(urls.filter((u) => !isSearch(u))).toEqual([`${ORIGIN}/jobs-guest/jobs/api/jobPosting/5`, `${ORIGIN}/jobs-guest/jobs/api/jobPosting/5`]);
    expect(result.adverts).toHaveLength(1);
    expect(result.requests).toBe(46);
  });
  it("gives up in the detail phase: the id stays waiting", async () => {
    const { result } = await run((c) => (isSearch(c.url) ? page("") : page("", 429)), [row(5)], { options: { retry: { tries: 1, firstWaitMs: 10 } } });
    expect(result.stop).toMatchObject({ phase: "detail", status: 429 });
    expect(result.waiting[0]!.done).toBe(false);
  });
});

describe("the request budget (decision #144, off by default)", () => {
  it("off by default: no limit", async () => {
    const { result } = await run(empty);
    expect(result.requests).toBe(44);
  });
  it("0 means no request at all", async () => {
    const { calls, result } = await run(empty, [row(1)], { options: { maxRequests: 0 } });
    expect(calls.length).toBe(0);
    expect(result.stop).toEqual({ phase: "search", reason: "budget", status: null, message: "search stopped: request budget used up" });
    expect(result.waiting).toEqual([row(1)]);
  });
  it("stops in the search at the number, keeps the ids found, reads nothing", async () => {
    const { calls, result } = await run((c) => (isSearch(c.url) ? page(searchPage([startOf(c.url) + 1])) : page(detailPage())), [], { options: { maxRequests: 6 } });
    expect(calls.length).toBe(6);
    expect(result.requests).toBe(6);
    expect(result.stop).toMatchObject({ phase: "search", reason: "budget" });
    expect(result.adverts).toEqual([]);
    expect(result.waiting.length).toBeGreaterThan(0);
    expect(result.waiting.every((r) => !r.done)).toBe(true);
  });
  it("stops in the detail phase at the number", async () => {
    const waiting = Array.from({ length: 300 }, (_, i) => row(100 + i));
    const { calls, result } = await run(empty, waiting, { options: { maxRequests: 10 } });
    expect(calls.length).toBe(10);
    expect(result.stop).toMatchObject({ phase: "detail", reason: "budget" });
    expect(result.adverts).toHaveLength(10);
    expect(result.waiting.filter((r) => r.done)).toHaveLength(10);
  });
  it("the state it gives back starts the next run: nothing lost, nothing read twice", async () => {
    let waiting = Array.from({ length: 260 }, (_, i) => row(100 + i, ["health", "it", "retail"][i % 3]));
    const asked: string[] = [];
    const handler = (c: { url: string }) => {
      if (!isSearch(c.url)) asked.push(idOf(c.url));
      return empty(c);
    };
    const reads: string[] = [];
    let searchFrom = 0;
    for (let i = 0; i < 30 && waiting.some((r) => !r.done); i++) {
      const { result } = await run(handler, waiting, { options: { maxRequests: 40 }, searchFrom });
      reads.push(...result.adverts.map((a) => a.id));
      waiting = result.waiting;
      searchFrom = result.searchNext;
    }
    expect(waiting.every((r) => r.done)).toBe(true);
    expect(waiting).toHaveLength(260);
    expect(new Set(asked).size).toBe(260);
    expect(asked).toHaveLength(260); // each id asked exactly once
    expect(reads).toHaveLength(260);
  });
  it("a search cut short by the budget carries on at the same term next time, and then reaches the details", async () => {
    const a = await run(empty, [row(1)], { options: { maxRequests: 10 } });
    expect(a.result.searchNext).toBe(10);
    expect(a.result.adverts).toEqual([]);
    const b = await run(empty, a.result.waiting, { options: { maxRequests: 100 }, searchFrom: a.result.searchNext });
    expect(b.urls.filter(isSearch).map((u) => termOf(u))).toEqual(terms.slice(10));
    expect(b.result.searchNext).toBe(44);
    expect(b.result.adverts).toHaveLength(1);
  });
  it("a retry counts as a request; with no request left the 429 is the stop", async () => {
    const { calls, result } = await run(() => page("", 429), [], { options: { maxRequests: 2, retry: { tries: 5, firstWaitMs: 10 } } });
    expect(calls.length).toBe(2);
    expect(result.stop).toMatchObject({ reason: "budget" });
  });
  it("a same-site redirect hop counts as a request", async () => {
    const { result } = await run((c) => (c.url.includes("start=0") && !c.url.includes("moved") ? redirect(`${ORIGIN}/jobs-guest/jobs/api/seeMoreJobPostings/search?moved=1&start=0`) : page("")), [], { options: { maxRequests: 3 } });
    expect(result.requests).toBe(3);
  });
});

describe("mock services: nothing in this folder reaches a network or a timer by itself", () => {
  it("a run with a fake fetch never calls the global fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("real network");
    });
    await run(empty, [row(1)]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("no source file in the folder names a global fetch, a timer, Math.random, the clock, a file or a database", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !/\.(test|parity)\.ts$|^testkit\.ts$|^vitest/.test(f));
    expect(files.sort()).toEqual(["html.ts", "index.ts", "linkedin.ts", "terms.ts"]);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/globalThis\.fetch|setTimeout|setInterval|Math\.random|Date\.now|new Date\(|node:fs|node:net|node:http|sqlite|postgres|process\.env/);
    }
  });
});
