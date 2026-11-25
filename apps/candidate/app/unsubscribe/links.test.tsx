// P17c, unit: the two emailed-link pages of the candidate site, /unsubscribe (DD29) and /data-request (DD30): every state rendered to HTML, the words for every code
// of the two API routes (read from docs/openapi/candidate.yaml), the link checks, and the page files with the data layer stood in. No browser, network or database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reads: [] as string[], unsub: null as unknown, dr: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("../../lib/data", () => ({
  readUnsubscribe: async (t: string, s: string) => { state.reads.push(`unsub ${t} ${s}`); return state.unsub; },
  readDataRequest: async (t: string) => { state.reads.push(`dr ${t}`); return state.dr; },
}));
import { descriptionProblem, titleProblem } from "../../lib/seo";
import DataRequestPage, { generateMetadata as drMeta } from "../data-request/page";
import { dataRequestSay, endsAt, exportName, INVALID_LINK, parseToken } from "../data-request/messages";
import { DataRequestView } from "../data-request/views";
import UnsubscribePage, { generateMetadata as unsubMeta } from "./page";
import { BAD_LINK, parseLink, unsubscribeSay } from "./messages";
import { UnsubscribeView } from "./views";

const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Sample|Launch B|dangerouslySetInnerHTML|<img|https?:\/\/(?!www\.w3\.org)/);
const T = "T".repeat(40), D = "D".repeat(43);
const alert = { filters: ["County: Dublin", "Sector: IT"], frequency: "weekly" as const, status: "active" as const };
beforeEach(() => { state.reads = []; state.unsub = null; state.dr = null; });

describe("/unsubscribe views (DD29)", () => {
  it("ask, one alert: what it stops in words, how often, Confirm, and a way to stop all instead", () => {
    const h = html(<UnsubscribeView view="ask" scope="one" alert={alert} otherHref="/unsubscribe?token=x&amp;scope=all" />);
    expect(h.match(/<h1/g)).toHaveLength(1);
    for (const w of ["Stop this", "County: Dublin", "Sector: IT", "Every week", "Sending emails", "Confirm: stop this alert", "Stop all job alerts instead"]) expect(h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(w);
    clean(h);
  });
  it("ask, all: says it stops every alert, offers to stop only this one", () => {
    const h = html(<UnsubscribeView view="ask" scope="all" alert={{ ...alert, status: "paused", frequency: "daily", filters: [] }} otherHref="/x" />);
    expect(h).toContain("Confirm: stop all alerts");
    expect(h).toContain("Every job");
    expect(h).toContain("Every day");
    expect(h).toContain("Paused");
    expect(h).toContain("Stop only this alert instead");
  });
  it("done (one and all), already done and a bad link each have their own words; an error and pending show on the ask screen", () => {
    expect(html(<UnsubscribeView view="done" scope="one" alert={null} />)).toContain("Your other alerts are not changed");
    expect(html(<UnsubscribeView view="done" scope="all" alert={null} />)).toContain("We will not send you any more job alert emails");
    expect(html(<UnsubscribeView view="already" scope="one" alert={alert} />)).toContain("already stopped");
    expect(html(<UnsubscribeView view="bad" scope="one" alert={null} />)).toContain(BAD_LINK);
    expect(html(<UnsubscribeView view="bad" scope="one" alert={null} problem="Slow down." />)).toContain("Slow down.");
    const a = html(<UnsubscribeView view="ask" scope="one" alert={alert} error="Oops." pending />);
    expect(a).toContain('role="alert"');
    expect(a).toContain("disabled");
  });
  it("never says whose account it is: no email, name or id in any state", () => {
    for (const v of ["ask", "done", "already", "bad"] as const) expect(html(<UnsubscribeView view={v} scope="all" alert={alert} />)).not.toMatch(/@|Amara|candidate_user/);
  });
});

describe("/unsubscribe page", () => {
  const page = (q: Record<string, string | string[] | undefined>) => UnsubscribePage({ searchParams: Promise.resolve(q) });
  it("a malformed link reads nothing and shows the bad-link state; hostile values never reach the read", async () => {
    for (const q of [{}, { token: T }, { scope: "one" }, { token: "short", scope: "one" }, { token: T, scope: "both" }, { token: `${T}/../x`, scope: "one" }, { token: [T, T], scope: "one" }, { token: "T".repeat(65), scope: "one" }, { token: "<script>".padEnd(40, "a"), scope: "all" }]) {
      expect((await page(q as never)).props.view, JSON.stringify(q)).toBe("bad");
    }
    expect(state.reads).toEqual([]);
  });
  it("an unknown token (alert null) is the bad-link state; a limit or failure says so; an unsubscribed alert is already done; a live one asks, with the other scope offered", async () => {
    state.unsub = { ok: true, data: { scope: "one", alert: null } };
    expect((await page({ token: T, scope: "one" })).props.view).toBe("bad");
    state.unsub = { ok: false, status: 429, code: "TOO_MANY_REQUESTS" };
    expect((await page({ token: T, scope: "one" })).props.problem).toMatch(/Too many tries/);
    state.unsub = { ok: false, status: 400, code: "BAD_REQUEST" };
    expect((await page({ token: T, scope: "one" })).props.problem).toBeUndefined();
    state.unsub = { ok: true, data: { scope: "one", alert: { ...alert, status: "unsubscribed" } } };
    expect((await page({ token: T, scope: "one" })).props.view).toBe("already");
    expect((await page({ token: T, scope: "all" })).props.token).toBe(T); // for all the others may still be live, so it asks
    state.unsub = { ok: true, data: { scope: "one", alert } };
    const el = await page({ token: T, scope: "one" });
    expect(el.props).toMatchObject({ token: T, scope: "one", alert, otherHref: `/unsubscribe?token=${T}&scope=all` });
  });
  it("is noindex with no referrer, its title 60 or fewer and its description 120 to 160", () => {
    const m = unsubMeta();
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.referrer).toBe("no-referrer");
    expect(titleProblem(String(m.title).replace(" | Irish Work Permit", ""))).toBeNull();
    expect(descriptionProblem(String(m.description))).toBeNull();
  });
  it("parseLink takes only the API's own shape", () => {
    expect(parseLink(T, "all")).toEqual({ token: T, scope: "all" });
    expect(parseLink("a".repeat(31), "all")).toBeNull();
    expect(parseLink(undefined, "all")).toBeNull();
  });
});

describe("/data-request views (DD30)", () => {
  it("export ask: what happens, when the link ends in Irish time, Confirm", () => {
    const h = html(<DataRequestView view="ask" purpose="export" expiresAt="2026-11-26T09:30:00.123456+00:00" />);
    expect(h.match(/<h1/g)).toHaveLength(1);
    const t = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const w of ["copy of your data", "works once", "ends on 26 Nov 2026 at 09:30", "Confirm: download my data", "If you did not ask for this, close the page"]) expect(t).toContain(w);
    clean(h);
  });
  it("erase ask: deletion needs a second person and cannot be undone", () => {
    const t = html(<DataRequestView view="ask" purpose="erase" expiresAt="2026-07-26 09:30:00+00" />).replace(/<[^>]+>/g, " ");
    expect(t).toContain("Confirm: delete my account");
    expect(t).toContain("second member");
    expect(t).toContain("cannot be undone");
    expect(t).toContain("ends on 26 Jul 2026 at 10:30"); // summer time
  });
  it("exported, erased, used or expired (one state: the API cannot tell them apart) and bad link", () => {
    expect(html(<DataRequestView view="exported" purpose="export" />)).toContain("downloaded");
    expect(html(<DataRequestView view="erased" purpose="erase" />)).toContain("second member");
    expect(html(<DataRequestView view="invalid" purpose="export" />)).toContain(INVALID_LINK);
    expect(html(<DataRequestView view="bad" purpose="export" problem="Slow down." />)).toContain("Slow down.");
    expect(html(<DataRequestView view="ask" purpose="export" error="Oops." pending />)).toContain('role="alert"');
  });
  it("never says whose account it is", () => {
    for (const v of ["ask", "exported", "erased", "invalid", "bad"] as const) expect(html(<DataRequestView view={v} purpose="export" expiresAt="2026-11-26T09:30:00Z" />)).not.toMatch(/@|Amara|candidate_user/);
  });
});

describe("/data-request page", () => {
  const page = (q: Record<string, string | string[] | undefined>) => DataRequestPage({ searchParams: Promise.resolve(q) });
  it("a malformed token reads nothing; hostile values never reach the read", async () => {
    for (const q of [{}, { token: "short" }, { token: `${D}x` }, { token: `${D.slice(1)}/` }, { token: [D, D] }, { token: "<script>".padEnd(43, "a") }]) expect((await page(q as never)).props.view, JSON.stringify(q)).toBe("bad");
    expect(state.reads).toEqual([]);
  });
  it("a live link asks with its purpose and end; 404 is used or expired; 400, a limit and a failure say so", async () => {
    state.dr = { ok: true, data: { purpose: "erase", expiresAt: "2026-11-26T09:30:00+00:00" } };
    expect((await page({ token: D })).props).toMatchObject({ token: D, purpose: "erase", expiresAt: "2026-11-26T09:30:00+00:00" });
    state.dr = { ok: true, data: { purpose: "anything else", expiresAt: "x" } };
    expect((await page({ token: D })).props.purpose).toBe("export");
    state.dr = { ok: false, status: 404, code: "INVALID_LINK" };
    expect((await page({ token: D })).props.view).toBe("invalid");
    state.dr = { ok: false, status: 429, code: "TOO_MANY_REQUESTS" };
    expect((await page({ token: D })).props).toMatchObject({ view: "bad", problem: expect.stringMatching(/Too many tries/) });
  });
  it("is noindex with no referrer, its title 60 or fewer and its description 120 to 160", () => {
    const m = drMeta();
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.referrer).toBe("no-referrer");
    expect(titleProblem(String(m.title).replace(" | Irish Work Permit", ""))).toBeNull();
    expect(descriptionProblem(String(m.description))).toBeNull();
  });
  it("the helpers: token shape, end time, export file name (no path, no quote)", () => {
    expect(parseToken(D)).toBe(D);
    expect(parseToken(`${D}=`)).toBeNull();
    expect(endsAt("nonsense")).toBeNull();
    expect(exportName('attachment; filename="my-data-2026-11-25.json"')).toBe("my-data-2026-11-25.json");
    expect(exportName('attachment; filename="../../etc/passwd"')).toBe("my-data.json");
    expect(exportName(null)).toBe("my-data.json");
  });
});

describe("words for every code of the two routes (docs/openapi/candidate.yaml)", () => {
  const yaml = readFileSync(join(import.meta.dirname, "../../../../docs/openapi/candidate.yaml"), "utf8");
  const block = (path: string) => {
    const from = yaml.indexOf(`\n  ${path}:\n`), end = yaml.indexOf("\n  /api/", from + 5);
    const b = yaml.slice(from, end < 0 ? undefined : end);
    const refs = [...b.matchAll(/responses\/([A-Za-z]+)'/g)].map((m) => { const i = yaml.indexOf(`\n    ${m[1]}:\n`); return yaml.slice(i, i + 700).split("\n").slice(0, 12).join("\n"); });
    return [b, ...refs].join("\n");
  };
  const codesIn = (s: string) => [...new Set([...[...s.matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((m) => m[1]!), ...[...s.matchAll(/code: ([A-Z][A-Z_]{4,})/g)].map((m) => m[1]!)])];
  it("/api/alerts/unsubscribe: each code has its own sentence", () => {
    const codes = codesIn(block("/api/alerts/unsubscribe"));
    expect(codes).toEqual(expect.arrayContaining(["BAD_REQUEST", "TOO_MANY_REQUESTS", "BODY_TOO_LARGE"]));
    const generic = unsubscribeSay({ ok: false, status: 400, code: "ZZZ" });
    for (const code of codes) expect(unsubscribeSay({ ok: false, status: code === "TOO_MANY_REQUESTS" ? 429 : 400, code }), code).not.toBe(generic);
  });
  it("/api/data-request: each code has its own sentence", () => {
    const codes = codesIn(block("/api/data-request"));
    expect(codes).toEqual(expect.arrayContaining(["BAD_REQUEST", "INVALID_LINK", "BAD_ORIGIN", "BODY_TOO_LARGE", "TOO_MANY_REQUESTS"]));
    const generic = dataRequestSay({ ok: false, status: 400, code: "ZZZ" });
    for (const code of codes) expect(dataRequestSay({ ok: false, status: code === "TOO_MANY_REQUESTS" ? 429 : 400, code }), code).not.toBe(generic);
    expect(dataRequestSay({ ok: false, status: 0 })).toMatch(/reach the site/);
    expect(dataRequestSay({ ok: false, status: 500 })).toMatch(/our side/);
  });
});
