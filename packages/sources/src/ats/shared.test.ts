import { describe, expect, it } from "vitest";
import golden from "./fixtures/text-golden.json";
import { FetchFailedError } from "../types";
import { PACE, clip, htmlUnescape, isIrish, makeCaller, pyStrip, text } from "./shared";
import { fake, redirect, reply } from "./testkit";

// text-golden.json: made-up fuzz strings (tags, entities, odd whitespace, odd Unicode) and what the Python
// (fetch_ats.py text() and IRL.search) answered for each, made by step5/parity/L3/make_text_golden.py.
describe("text() and the Irish filter against the Python", () => {
  it("gives the Python's answer for every fuzz string", () => {
    const bad = (golden.text as [string, string][]).filter(([input, want]) => text(input) !== want);
    expect(bad.length).toBe(0);
    expect(golden.text.length).toBe(1500);
  });
  it("gives the Python's yes or no for every fuzz location", () => {
    const bad = (golden.irl as [string, boolean][]).filter(([input, want]) => isIrish(input) !== want);
    expect(bad.length).toBe(0);
  });
});

describe("text()", () => {
  it("turns break tags into newlines and drops other tags", () => {
    expect(text("<p>One</p><p>Two<br>Three</p><ul><li>A</li><li>B</li></ul><h2>Head</h2>tail<div>x</div>")).toBe("One\n Two\nThree\n A\n B\n Head\ntail x");
  });
  it("decodes escaped HTML (the Greenhouse kind) once, then strips tags (a double-escaped & stays escaped)", () => {
    expect(text("&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;&lt;p&gt;It&#39;s&nbsp;fine&lt;/p&gt;")).toBe("Fish &amp; chips\n It's\u00a0fine");
  });
  it("handles null, undefined and empty", () => {
    expect([text(null), text(undefined), text("")]).toEqual(["", "", ""]);
  });
  it("leaves unknown entities and bare ampersands (R&D) alone, as Python does", () => {
    expect(text("R&D and &nonsense; &D")).toBe("R&D and &nonsense; &D");
  });
  it("known quirk: a legacy entity with no semicolon is decoded inside a word", () => {
    expect(text("&notable")).toBe("¬able");
  });
  it("known quirk: a tag-like run in plain text is dropped", () => {
    expect(text("a < b and c > d")).toBe("a d");
  });
  it("collapses blank lines and runs of spaces and tabs", () => {
    expect(text("a \t  b\n \n\n c")).toBe("a b\n c");
  });
  it("refuses a value that is not text (Python raises, the board fails)", () => {
    expect(() => text(5)).toThrow();
  });
});

describe("Python whitespace", () => {
  it("strips what Python strips and keeps the byte order mark", () => {
    expect(pyStrip("\x1c\x85　 hi  \n")).toBe("hi");
    expect(pyStrip("﻿hi")).toBe("﻿hi");
  });
  it("stays fast on a long run of white space inside the text (untrusted titles and descriptions)", () => {
    const hostile = `a${" ".repeat(80_000)}b`;
    const t0 = performance.now();
    expect(pyStrip(hostile)).toBe(hostile);
    expect(pyStrip(`${" ".repeat(80_000)}a${"\t".repeat(80_000)}`)).toBe("a");
    expect(performance.now() - t0).toBeLessThan(200); // measured under 5 ms; the old regular expression took 4.8 s
  });
});

describe("htmlUnescape", () => {
  it("handles numeric edge cases like Python", () => {
    expect(htmlUnescape("&#128;&#xD800;&#1114112;&#0;&#x41;&#65")).toBe("€���AA");
  });
  it("does not treat object property names as entities", () => {
    expect(htmlUnescape("&constructor; &__proto__;")).toBe("&constructor; &__proto__;");
  });
});

describe("isIrish", () => {
  it("matches whole words only, any case", () => {
    expect([isIrish("Dublin, Ireland"), isIrish("CORK"), isIrish("Corkscrew"), isIrish("Ennis-West"), isIrish("Cafédublin"), isIrish("New York")]).toEqual([true, true, false, true, false, false]);
  });
});

// ---- W1: 429 and 503, Retry-After, the wait budgets, the failure text --------------------------------------------------
describe("makeCaller on HTTP 429 and 503 (W1)", () => {
  const ORIGIN = "https://acme.wd3.myworkdayjobs.com";
  const URL0 = `${ORIGIN}/wday/cxs/acme/External/jobs`;
  const DATE = "Wed, 18 Nov 2026 10:00:00 GMT";
  const limited = (headers: Record<string, string> = {}, status = 429, body = "rate limited") => new Response(body, { status, headers });
  /** A caller over a fake fetch that answers from `answers` in turn (the last one repeats), and a sleep that only records. */
  function caller(answers: (() => Response)[], opts: { budget?: { leftMs: number }; gapMs?: number } = {}) {
    const { fetch, calls } = fake(() => answers[Math.min(calls.length - 1, answers.length - 1)]!());
    const waits: number[] = [];
    const call = makeCaller("acme", fetch, ORIGIN, { sleep: async (ms) => void waits.push(ms), ...opts });
    return { call, calls, waits };
  }
  const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as FetchFailedError);

  it("429 then 200 succeeds after one backoff wait (5 s)", async () => {
    const { call, calls, waits } = caller([() => limited(), () => reply({ ok: 1 })]);
    expect(await call(URL0)).toEqual({ ok: 1 });
    expect([calls.length, waits]).toEqual([2, [5_000]]);
  });
  it("backoff order 5 s then 15 s, and at most 3 tries; the failure names the tries", async () => {
    const { call, calls, waits } = caller([() => limited()]);
    const e = await failure(call(URL0));
    expect(e).toBeInstanceOf(FetchFailedError);
    expect(e.message).toMatch(/^HTTP 429 after 3 tries/);
    expect([calls.length, waits]).toEqual([3, [5_000, 15_000]]);
  });
  it("503 is retried the same way; 500 and 404 are not", async () => {
    expect((await caller([() => limited({}, 503), () => reply(1)]).call(URL0))).toBe(1);
    for (const status of [404, 500]) {
      const { call, calls } = caller([() => limited({}, status), () => reply(1)]);
      await failure(call(URL0));
      expect(calls).toHaveLength(1);
    }
  });
  it.each([
    ["seconds", { "retry-after": "7" }, 7_000],
    ["an HTTP date, counted from the Date header", { "retry-after": "Wed, 18 Nov 2026 10:00:12 GMT", date: DATE }, 12_000],
    ["missing", {}, 5_000],
    ["negative", { "retry-after": "-30" }, 5_000],
    ["zero", { "retry-after": "0" }, 5_000],
    ["text", { "retry-after": "soon, maybe" }, 5_000],
    ["a date in the past", { "retry-after": "Wed, 18 Nov 2026 09:00:00 GMT", date: DATE }, 5_000],
    ["a date with no Date header", { "retry-after": DATE }, 5_000],
    ["huge (capped at 60 s)", { "retry-after": "999999999" }, 60_000],
    ["too many digits", { "retry-after": "1".repeat(40) }, 5_000],
    ["a date years away (capped)", { "retry-after": "Fri, 18 Nov 2050 10:00:00 GMT", date: DATE }, 60_000],
  ])("Retry-After %s", async (_n, headers, wait) => {
    const { call, waits } = caller([() => limited(headers), () => reply(1)]);
    await call(URL0);
    expect(waits).toEqual([wait]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(PACE.maxWaitMs);
  });
  it("the board's wait budget (90 s): a hostile Retry-After gets one 60 s wait, then the board gives up", async () => {
    const { call, calls, waits } = caller([() => limited({ "retry-after": "86400" })]);
    const e = await failure(call(URL0));
    expect(e.message).toMatch(/^HTTP 429 after 2 tries/);
    expect([calls.length, waits]).toEqual([2, [60_000]]);
    // the budget is per caller (per board): a second call of the same board gets no more wait
    const before = calls.length;
    await failure(call(URL0));
    expect([calls.length - before, waits.length]).toEqual([1, 1]);
  });
  it("the run's shared wait budget: once used up, a 429 is given up at once", async () => {
    const budget = { leftMs: 6_000 };
    const a = caller([() => limited(), () => reply(1)], { budget });
    await a.call(URL0);
    expect(budget.leftMs).toBe(1_000);
    const b = caller([() => limited(), () => reply(1)], { budget });
    await failure(b.call(URL0));
    expect([b.calls.length, b.waits]).toEqual([1, []]);
  });
  it("the failure text names the status, the useful headers and the start of the body, cut and without control characters", async () => {
    const headers = { "retry-after": "999999999", "cf-ray": "8e1f2a3b4c5d6e7f-DUB", "cf-mitigated": "challenge", server: "cloudflare", "x-other": "not logged" };
    const body = "<html>\r\nError 1015\u0000\u001b[31m\u2028You are being rate limited" + "x".repeat(5000);
    const { call } = caller([() => limited(headers, 429, body)], { budget: { leftMs: 0 } });
    const e = await failure(call(URL0));
    expect(e.message).toMatch(/^HTTP 429 \(retry-after 999999999; cf-ray 8e1f2a3b4c5d6e7f-DUB; cf-mitigated challenge; server cloudflare\): <html> Error 1015 \[31m You are being rate limitedx+$/);
    expect(e.message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(e.message).not.toContain("not logged");
    expect(e.message.length).toBeLessThan(400);
  });
  it("a hostile header value is cut to 60 characters and loses its control characters (no log injection)", async () => {
    // fetch itself refuses CR and LF in a header value; tab, other control bytes and DEL get through, so they are stripped here
    const { call } = caller([() => limited({ server: "cloudflare\t\u0001\u007f2026-11-18 fetch OK: all boards fine " + "y".repeat(500) })], { budget: { leftMs: 0 } });
    const e = await failure(call(URL0));
    expect(e.message).not.toMatch(/\p{Cc}/u);
    expect(/server ([^;)]*)/.exec(e.message)![1]!.length).toBeLessThanOrEqual(60);
  });
  it("a huge 429 body is not read in full: one chunk at most", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => { pulled++; c.enqueue(new Uint8Array(64 * 1024).fill(65)); } });
    const { call } = caller([() => new Response(endless, { status: 429 })], { budget: { leftMs: 0 } });
    const e = await failure(call(URL0));
    expect(pulled).toBeLessThanOrEqual(3); // the stream's own read-ahead, never the whole body
    expect(e.message.length).toBeLessThan(300);
  });
  it("a retry never reaches another host: a redirect after a 429 is still checked against the origin", async () => {
    const { call, calls } = caller([() => limited(), () => redirect("https://evil.example/x")]);
    const e = await failure(call(URL0));
    expect(e.message).toBe("refused: request to another host");
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([ORIGIN, ORIGIN]);
  });
  it("gapMs pauses before every call but the first", async () => {
    const { call, waits } = caller([() => reply(1)], { gapMs: 300 });
    await call(URL0);
    await call(URL0);
    await call(URL0);
    expect(waits).toEqual([300, 300]);
  });
  it("clip removes control, format and line-separator characters and cuts by code point", () => {
    expect(clip("a\r\nb\u0000c\u200bd\u2029e", 100)).toBe("a b c d e");
    expect(clip("😀".repeat(10), 3)).toBe("😀😀😀");
  });
});
