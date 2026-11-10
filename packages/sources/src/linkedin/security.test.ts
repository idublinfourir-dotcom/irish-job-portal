// The pages are untrusted. These tests feed hostile answers to the adapter and check: no throw past the typed stop, no hang
// (a time budget on every case), no request to any host but www.linkedin.com, and bounded work.
import { describe, expect, it } from "vitest";
import { parseLinkedinDetail } from "./index";
import { strip } from "./html";
import { detailPage, idOf, isSearch, ORIGIN, page, redirect, row, run, searchPage, termOf } from "./testkit";

const BUDGET_MS = 3000; // measured: the slowest cases (10 MB bodies, 3 million "<") take 250 to 360 ms; every other case is under 50 ms. Budget about 8 times the slowest.
const timed = async <T>(f: () => Promise<T> | T) => {
  const t = performance.now();
  const value = await f();
  return { value, ms: performance.now() - t };
};
const empty = (c: { url: string }) => (isSearch(c.url) ? page("") : page(detailPage()));
const onlyLinkedin = (urls: string[]) => expect(urls.every((u) => u.startsWith(`${ORIGIN}/`))).toBe(true);

describe("big bodies", () => {
  it("a 10 MB search page and a 10 MB detail page are treated as 'nothing', not parsed", async () => {
    const big = "jobPosting:1 ".repeat(800_000); // 10.4 MB
    const { value, ms } = await timed(() => run((c) => (isSearch(c.url) ? page(big) : page(big)), [row(5)]));
    expect(value.result.seen).toEqual([]);
    expect(value.result.adverts).toEqual([]);
    expect(value.result.waiting.map((r) => r.done)).toEqual([true]);
    expect(value.result.stop).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a body that says it is 10 MB in content-length is refused before it is read", async () => {
    let read = false;
    const res = { status: 200, headers: new Headers({ "content-length": String(10 * 1024 * 1024) }), text: async () => ((read = true), "x") } as unknown as Response;
    await run(() => res);
    expect(read).toBe(false);
  });
  it("a search page under the size cap with 200,000 different ids adds at most 100 rows", async () => {
    const ids = Array.from({ length: 200_000 }, (_, i) => 1_000_000_000 + i);
    const body = searchPage(ids);
    expect(body.length).toBeLessThan(4 * 1024 * 1024 + 20_000_000);
    const { value, ms } = await timed(() => run((c) => (isSearch(c.url) ? (termOf(c.url) === "staff nurse" ? page(body) : page("")) : page("")), [], { options: { maxRequests: 6 } }));
    expect(value.result.waiting.length).toBeLessThanOrEqual(4 * 100); // 4 pages of one term, 100 each at most
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a million ids in one page: refused for its size, or capped, never a million rows", async () => {
    const body = "jobPosting:7".repeat(1_000_000);
    const { value, ms } = await timed(() => run((c) => (isSearch(c.url) ? page(body) : page("")), [], { options: { maxRequests: 3 } }));
    expect(value.result.waiting.length).toBeLessThanOrEqual(100);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("a 3 MB page of one very long line with no spaces", async () => {
    const body = "x".repeat(3_000_000);
    const { value, ms } = await timed(() => run((c) => (isSearch(c.url) ? page("") : page(body)), [row(1)]));
    expect(value.result.adverts).toHaveLength(1);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("ids", () => {
  const BAD = ["123/../../x", "evil.com#", "12 34", "", "١٢٣", "1".repeat(21), "../..", "123?x=1", "123\n", "//evil.example/1", "123@evil.example", "1e5", "-1", "0x10"];
  it("an id in the waiting list that is not plain digits is never put in a URL: no request, marked done", async () => {
    const { result, urls } = await run(empty, BAD.map((id) => row(id)));
    expect(urls.filter((u) => !isSearch(u))).toEqual([]);
    expect(result.waiting.every((r) => r.done)).toBe(true);
    expect(result.adverts).toEqual([]);
    onlyLinkedin(urls);
  });
  it("a plain digit id of 20 digits is allowed, 21 is not", async () => {
    const { urls } = await run(empty, [row("1".repeat(20)), row("1".repeat(21))]);
    expect(urls.filter((u) => !isSearch(u)).map(idOf)).toEqual(["1".repeat(20)]);
  });
  it("a search page with ids in other scripts, with 1000 digits, or with a path in them gives only the plain short ones", async () => {
    const body = ["jobPosting:١٢٣٤", `jobPosting:${"9".repeat(1000)}`, "jobPosting:../../x", "jobPosting:55/../../y", "jobPosting:", "jobPosting: 7"].join(" ");
    const { result, urls } = await run((c) => (isSearch(c.url) && termOf(c.url) === "staff nurse" ? page(body) : page("")));
    expect(result.seen).toEqual(["55"]);
    onlyLinkedin(urls);
    for (const u of urls.filter((u) => !isSearch(u))) expect(u).toBe(`${ORIGIN}/jobs-guest/jobs/api/jobPosting/55`);
  });
});

describe("redirects", () => {
  const TARGETS = ["https://evil.example/x", "//evil.example/x", "http://www.linkedin.com.evil.example/x", "https://www.linkedin.com@evil.example/x", "http://www.linkedin.com/x", "https://ie.linkedin.com/x", "javascript:alert(1)", "https://www.linkedin.com:8443/x"];
  for (const target of TARGETS) {
    it(`a redirect to ${target} is not followed (search and detail)`, async () => {
      const { result, urls } = await run(() => redirect(target), [row(5)]);
      onlyLinkedin(urls);
      expect(urls.length).toBe(44 + 1); // every search is 'nothing', then one detail
      expect(result.stop).toBeNull();
      expect(result.adverts).toEqual([]);
    });
  }
  it("a redirect with no Location, or a Location that is not a URL, is 'nothing'", async () => {
    const a = await run(() => new Response(null, { status: 302 }));
    const b = await run(() => redirect("http://[::1"));
    expect(a.result.stop).toBeNull();
    expect(b.result.stop).toBeNull();
  });
  it("a redirect to the same site is followed, at most 3 hops, each one counted", async () => {
    const { urls, result } = await run((c) => (c.url.includes("hop=") ? redirect(`${ORIGIN}/a?hop=${c.url.length}`) : redirect(`${ORIGIN}/a?hop=0`)), [], { options: { maxRequests: 4 } });
    expect(urls.length).toBe(4); // the first call plus 3 hops, then it gives up on that page (nothing) and the next search needs a 5th request
    expect(result.requests).toBe(4);
    onlyLinkedin(urls);
  });
  it("a 301 loop to itself ends after 3 hops per page (4 requests), without a hang", async () => {
    const { value: urls, ms } = await timed(async () => (await run((c) => redirect(c.url))).urls);
    expect(urls.length).toBe(44 * 4);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("Retry-After", () => {
  const hostile = ["31536000", "99999999999999999999", "-1", "-99999999", "1e9", "NaN", "Infinity", "5, 6", " 5 ", "x".repeat(1_000_000), "Tue, 10 Nov 2999 08:20:00 GMT", "Tue, 10 Nov 1999 08:20:00 GMT", "Tue, 99 Nov 2026 99:99:99 GMT"];
  for (const h of hostile) {
    it(`Retry-After ${JSON.stringify(h.slice(0, 40))} gives a finite wait of at most 5 minutes`, async () => {
      let n = 0;
      const { waits, result } = await run((c) => (n++ === 0 ? page("", 429, { "retry-after": h, date: "Tue, 10 Nov 2026 08:20:00 GMT" }) : empty(c)), [], { options: { retry: { tries: 3, firstWaitMs: 1000 } } });
      expect(Number.isFinite(waits[0])).toBe(true);
      expect(waits[0]).toBeGreaterThan(0);
      expect(waits[0]).toBeLessThanOrEqual(300_000);
      expect(result.stop).toBeNull();
    });
  }
  it("many tries with a long first wait never ask for more than the cap", async () => {
    const { waits } = await run(() => page("", 429), [], { options: { retry: { tries: 2000, firstWaitMs: 1e9 } } });
    expect(waits.length).toBe(2000);
    expect(Math.max(...waits)).toBe(300_000);
  });
});

describe("hostile text in every field", () => {
  const HOSTILE = ["<script>alert(1)</script>", "\u0000", "‮evil‬", "\ud800 lone surrogate \udfff", "​‍﻿", "😀".repeat(50), "&#0;&#xD800;&#999999999999;&#x110000;", "<img src=x onerror=alert(1)>", "'; DROP TABLE jobs;--", "e" + "́".repeat(200), "&lt;script&gt;alert(1)&lt;/script&gt;", "<<<<<<<<<<", "</div></h2></a></span>"];
  for (const h of HOSTILE) {
    it(`${JSON.stringify(h.slice(0, 30))} in title, employer, place, description, type and salary`, async () => {
      const d = detailPage({ title: h, employer: h, place: h, desc: h, type: h, salary: h });
      const { value, ms } = await timed(() => run((c) => (isSearch(c.url) ? page("") : page(d)), [row(1)]));
      expect(value.result.adverts).toHaveLength(1);
      const a = value.result.adverts[0]!;
      for (const v of Object.values(a)) expect(typeof v).toBe("string");
      expect(a.url).toBe(`${ORIGIN}/jobs/view/1`); // the URL never comes from the page
      expect(a.id).toBe("linkedin:ie:1");
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
  it("tags in the text are removed (a real tag never reaches the output)", () => {
    const a = parseLinkedinDetail("1", detailPage({ desc: "<script>x()</script><img src=x onerror=y()>text<b>bold</b>" }));
    expect(a.description).not.toMatch(/<(script|img|b)\b/i);
  });
  it("finding, not a failure: an unclosed tag stays as literal text, as in Python, so the page that shows an advert must still escape it", () => {
    expect(parseLinkedinDetail("1", detailPage({ desc: "x <script src=evil" })).description).toBe("x <script src=evil");
    expect(parseLinkedinDetail("1", detailPage({ desc: "&lt;script&gt;alert(1)&lt;/script&gt;" })).description).toBe("alert(1)"); // decoded first, then removed as a tag
  });
});

describe("patterns that could backtrack badly (all linear here)", () => {
  const N = 300_000;
  const cases: Record<string, string> = {
    "many title openers, no closer": "topcard__title>".repeat(N),
    "many description openers, no closer": "show-more-less-html__markup>".repeat(N / 2),
    "many criteria headings, no tag after them": 'description__job-criteria-subheader">x'.repeat(N / 4),
    "many criteria texts with no > at all": "description__job-criteria-text".repeat(N / 4),
    "many empty criteria": 'description__job-criteria-subheader"><'.repeat(N / 4),
    "only < signs": "<".repeat(3_000_000),
    "only < and >": "<>".repeat(1_500_000),
    "a tag that is never closed, repeated": "<a ".repeat(N),
    "a long run of spaces between two words": "a" + " ".repeat(1_000_000) + "b",
    "a long run of tabs and new lines": "a" + "\t\n".repeat(500_000) + "b",
    "alternating space and letter": "a ".repeat(1_000_000),
    "many ampersands": "&".repeat(1_000_000),
    "many half entities": "&#".repeat(500_000),
    "long entity names": "&" + "a".repeat(1_000_000),
  };
  for (const [name, body] of Object.entries(cases)) {
    it(name, async () => {
      const { ms } = await timed(() => parseLinkedinDetail("1", body));
      expect(ms).toBeLessThan(BUDGET_MS);
    });
    it(`${name}, inside the opening tags of a real field`, async () => {
      const { ms } = await timed(() => parseLinkedinDetail("1", `<h2 class="topcard__title">${body}</h2><div class="show-more-less-html__markup">${body}</div><span class="topcard__flavor">${body}</span>`));
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
  it("strip of 1 MB of spaces around one letter", () => {
    expect(strip(" ".repeat(1_000_000) + "a" + " ".repeat(1_000_000))).toBe("a");
  });
});

describe("failures of the fetch itself", () => {
  it("a fetch that throws, a rejected body, a timeout abort: a typed stop each time, never a throw", async () => {
    const boom = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    const a = await run(boom as never);
    expect(a.result.stop).toMatchObject({ reason: "network" });
    const b = await run(() => ({ status: 200, headers: new Headers(), text: async () => Promise.reject(new Error("reset")) }) as unknown as Response);
    expect(b.result.stop).toMatchObject({ reason: "network" });
  });
  it("a reply that is not a Response at all (no headers) is a stop or nothing, never an unhandled throw", async () => {
    const r = await run(() => ({ status: 200 }) as unknown as Response).catch((e: unknown) => e);
    expect(r).toBeDefined(); // ponytail: the fetch contract is trusted here, a plain object is not a Response
  });
});
