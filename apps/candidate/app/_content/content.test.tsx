// Unit (check 3, no database, no network, no browser): the shared parts of the content pages (P9, P10): the plain body, the pager trail, the title and description limits, the Irish
// calendar day, the read problems, the visitor limit box, the words of the two writes (company report, contact form) with a fake fetch, and the legal text marks.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { descriptionProblem, titleProblem } from "../../lib/seo";
import { reportCompany, sendContact } from "./api";
import { Body, paragraphs } from "./body";
import { dayText, dublinDay } from "./dates";
import { Accent } from "./head";
import { LEGAL_PAGES, LegalView, isDraft, publishedDay } from "./legal";
import { SignInMore } from "./limit";
import { fit } from "./meta";
import { Problem } from "./problem";
import { TRAIL_MAX, cursorOf, pagerLinks, parseTrail } from "./trail";

vi.mock("server-only", () => ({}));

describe("the plain body (Q2 is open)", () => {
  it("shows paragraphs and keeps single line breaks", () => {
    expect(paragraphs("One.\r\n\r\nTwo\nlines.\n\n\n  \nThree")).toEqual(["One.", "Two\nlines.", "Three"]);
    const h = html(<Body text={"A\n\nB"} />);
    expect(h.match(/<p /g)).toHaveLength(2);
  });
  it("never turns text into markup, so a script in staff text is only text", () => {
    const h = html(<Body text={'<script>alert(1)</script> <img src=x onerror=alert(1)>'} />);
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;");
  });
  it("shows nothing for an empty text", () => {
    expect(html(<Body text="  " />)).not.toContain("<p");
  });
});

describe("the pager trail (Previous and Next only, #125)", () => {
  it("the first page links Next to the cursor and has no Previous", () => {
    expect(pagerLinks({ base: "/updates", back: [], next: "c1" })).toEqual({ nextHref: "/updates?after=c1", prevHref: undefined });
    expect(pagerLinks({ base: "/updates", back: [], next: null })).toEqual({ nextHref: undefined });
  });
  it("later pages walk back through the trail and forward adding their own cursor", () => {
    expect(pagerLinks({ base: "/u", after: "c1", back: [], next: "c2" })).toEqual({ prevHref: "/u", nextHref: "/u?after=c2&back=c1" });
    expect(pagerLinks({ base: "/u", after: "c2", back: ["c1"], next: "c3" })).toEqual({ prevHref: "/u?after=c1", nextHref: "/u?after=c3&back=c1%2Cc2" });
    expect(pagerLinks({ base: "/u", after: "c3", back: ["c1", "c2"], next: null })).toEqual({ prevHref: "/u?after=c2&back=c1", nextHref: undefined });
  });
  it("keeps the filter in every link", () => {
    expect(pagerLinks({ base: "/u", keep: { category: "quotas" }, after: "c1", back: [], next: "c2" }).nextHref).toBe("/u?category=quotas&after=c2&back=c1");
  });
  it("drops anything in the trail or the cursor that is not a cursor, and cuts the trail", () => {
    expect(parseTrail("good_1,,bad cursor,<x>,ok-2,../etc")).toEqual(["good_1", "ok-2"]);
    expect(parseTrail(["a", "b"])).toEqual(["a"]);
    expect(parseTrail(undefined)).toEqual([]);
    expect(parseTrail(Array.from({ length: 30 }, (_, i) => `c${i}`).join(","))).toHaveLength(TRAIL_MAX);
    expect(cursorOf("a".repeat(201))).toBeUndefined();
    expect(cursorOf("//evil.example")).toBeUndefined();
    expect(cursorOf("ok_-1")).toBe("ok_-1");
    expect(cursorOf(["x", "y"])).toBe("x");
  });
});

describe("title and description limits (frame 01 SEO spec)", () => {
  it("fit() pads a short sentence to 120 characters and cuts a long one to 160", () => {
    for (const s of ["Short.", "x".repeat(400), "A company page for a company with an ordinary name, in a county."]) {
      const d = fit(s);
      expect(descriptionProblem(d), s.slice(0, 20)).toBeNull();
    }
    expect(titleProblem("a".repeat(61))).not.toBeNull();
  });
});

describe("dates are the Irish calendar day, written out", () => {
  it("writes summer time by the Irish day (23:30 UTC in July is the next day in Ireland) and never 'Sept'", () => {
    expect(dublinDay(new Date("2026-07-01T23:30:00Z"))).toBe("2 Jul 2026");
    expect(dublinDay(new Date("2026-12-01T23:30:00Z"))).toBe("1 Dec 2026");
    expect(dublinDay("2026-09-05T10:00:00Z")).toBe("5 Sep 2026");
    expect(dublinDay("not a date")).toBeNull();
    expect(dublinDay(null)).toBeNull();
    expect(dayText("2026-11-12")).toBe("12 Nov 2026");
    expect(dayText(null)).toBeNull();
  });
  it("reads the database time of a legal text", () => {
    expect(publishedDay("2026-11-19 09:30:00.123456+00")).toBe("19 Nov 2026");
    expect(publishedDay("garbage")).toBeNull();
  });
});

describe("Accent puts the last words of a title in the accent colour", () => {
  it("two words for a long title, one for a short one, none for one word", () => {
    expect(html(<Accent text="Guides and government updates" />)).toContain('text-deep-green">government updates<');
    expect(html(<Accent text="Government updates" />)).toContain('text-deep-green">updates<');
    expect(html(<Accent text="Help" />)).not.toContain("text-deep-green");
  });
});

describe("what a page says when its read did not answer ok", () => {
  const read = (status: number, extra = {}) => ({ ok: false as const, status, code: "X", ...extra });
  it("has words for 401, 429, 400 and any other failure", () => {
    expect(html(<Problem read={read(401)} what="company page" path="/companies/x" />)).toContain("Log in to see more");
    expect(html(<Problem read={read(401)} what="company page" path="/companies/x" />)).toContain("/login?next=%2Fcompanies%2Fx");
    expect(html(<Problem read={read(429, { retryAfter: 12 })} what="guides" />)).toContain("about 12 seconds");
    expect(html(<Problem read={read(429)} what="guides" />)).toContain("Please wait a little");
    expect(html(<Problem read={read(400)} what="updates" back={{ href: "/updates", label: "Open the updates" }} />)).toContain("We could not use that updates");
    expect(html(<Problem read={read(500)} what="guide" />)).toContain("The guide could not be loaded");
  });
});

describe("the visitor limit box inside a list of jobs", () => {
  it("shows blurred rows made of shapes only, the count, and the way in", () => {
    const h = html(<SignInMore shown={6} count={{ n: 12, more: false }} path="/companies/x" />);
    expect(h).toContain("data-sign-in-for-more");
    expect(h).toContain("You can see 6 of 12");
    expect(h).toContain("/login?next=%2Fcompanies%2Fx");
    expect(h).toContain('href="/signup"');
    expect(html(<SignInMore shown={6} count={{ n: 200, more: true }} path="/x" />)).toContain("6 of 200+");
  });
});

describe("the two writes, with a fake fetch (no network)", () => {
  const fake = (status: number, body: unknown) => vi.fn(async (...args: [string, RequestInit]) => ({ ok: status < 400, status, json: async () => body, args }));
  const bodyOf = (f: ReturnType<typeof fake>) => JSON.parse(f.mock.calls[0]![1].body as string);
  it("reports a company with the company id, trims the evidence, and words the codes", async () => {
    const f = fake(200, { ok: true });
    expect((await reportCompany("77", "fake_company", "  a made-up reason  ", f)).ok).toBe(true);
    expect(bodyOf(f)).toEqual({ companyId: "77", reason: "fake_company", evidence: "a made-up reason" });
    expect(f.mock.calls[0]![0]).toBe("/api/report");
    const none = fake(200, { ok: true });
    await reportCompany("77", "other", "   ", none);
    expect(bodyOf(none)).toEqual({ companyId: "77", reason: "other" });
    for (const [status, code, text] of [[409, "ALREADY_REPORTED", "open report on this company"], [404, "COMPANY_NOT_FOUND", "no longer available"], [401, "NO_SESSION", "session has ended"], [429, "TOO_MANY_REQUESTS", "too often"], [403, "BOT_SUSPECTED", "person"], [403, "REFUSED", "cannot do that"], [413, "BODY_TOO_LARGE", "too long"], [400, "BAD_REQUEST", "not accepted"]] as const) {
      const r = await reportCompany("77", "other", "", fake(status, { code }));
      expect(r.ok, code).toBe(false);
      if (!r.ok) expect(r.message, code).toContain(text);
    }
  });
  it("sends the contact form: a visitor with name and email, a signed-in candidate without", async () => {
    const v = fake(200, { ok: true });
    await sendContact("general", "  Hello  ", { name: " Ada ", email: " ada@example.test " }, v);
    expect(bodyOf(v)).toEqual({ topic: "general", body: "Hello", name: "Ada", email: "ada@example.test" });
    const s = fake(200, { ok: true });
    await sendContact("account", "Hi", null, s);
    expect(bodyOf(s)).toEqual({ topic: "account", body: "Hi" });
    for (const [status, code] of [[429, "TOO_MANY_REQUESTS"], [403, "BAD_ORIGIN"], [400, "BAD_REQUEST"], [413, "BODY_TOO_LARGE"]] as const) expect((await sendContact("general", "x", null, fake(status, { code }))).ok).toBe(false);
  });
  it("answers a lost connection in words, never a throw", async () => {
    const r = await sendContact("general", "x", null, async () => { throw new Error("offline"); });
    expect(r).toMatchObject({ ok: false, code: "NETWORK" });
  });
});

describe("the legal pages", () => {
  it("marks a placeholder text as draft from its own data, and a real text is not marked", () => {
    expect(isDraft({ version: "placeholder-2026-11-19", body: "x" })).toBe(true);
    expect(isDraft({ version: "v1", body: "PLACEHOLDER terms." })).toBe(true);
    expect(isDraft({ version: "2026-12-01", body: "The real text." })).toBe(false);
    const t = (version: string, body: string) => html(<LegalView purpose="privacy_notice" signedIn text={{ purpose: "privacy_notice", version, body, publishedAt: "2026-11-19 09:30:00+00" }} />);
    expect(t("placeholder-2026-11-19", "Body.")).toContain("Draft text, not final");
    expect(t("v1", "Body.")).not.toContain("Draft text");
    expect(t("v1", "Body.")).toContain("Published 19 Nov 2026");
  });
  it("lists the five texts in the sidebar with the current one marked, and says so when a text is not published yet", () => {
    const h = html(<LegalView purpose="cookie_policy" signedIn={false} text={null} />);
    for (const p of LEGAL_PAGES) expect(h).toContain(p.title);
    expect(h).toMatch(/aria-current="page"[^>]*>Cookie policy</);
    expect(h).toContain("Not published yet");
    expect(h.match(/<h1\b/g)).toHaveLength(1);
    expect(h).toContain("data-join");
    expect(html(<LegalView purpose="cookie_policy" signedIn text={null} />)).not.toContain("data-join");
    for (const href of ["/terms", "/privacy", "/cookies", "/employer-acceptable-use", "/data-retention"]) expect(h).toContain(`href="${href}"`);
  });
});
