// P17c, unit: the portal's /data-request page (DD30): every state rendered to HTML, the words for every code of GET and POST /api/data-request (read from
// docs/openapi/portal.yaml), the link check and the page file with the data layer stood in. No browser, network or database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reads: [] as string[], read: { status: 200, body: {} as Record<string, unknown> } }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("../../lib/data", () => ({ readDataRequest: async (t: string) => { state.reads.push(t); return state.read; }, candidateHref: () => null, readLogin: async () => null }));
import Page, { metadata } from "./page";
import { dataRequestSay, INVALID_LINK, parseToken } from "./messages";
import { DataRequestView } from "./views";

const D = "D".repeat(43);
const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|dangerouslySetInnerHTML|<img/);
beforeEach(() => { state.reads = []; state.read = { status: 200, body: {} }; });

describe("the portal /data-request views", () => {
  it("ask (export and erase) names what happens, when the link ends and Confirm, in login wording", () => {
    const e = html(<DataRequestView view="ask" purpose="export" expiresAt="2026-11-26T09:30:00.123456+00:00" />);
    expect(e.match(/<h1/g)).toHaveLength(1);
    const t = e.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const w of ["copy of your data", "works once", "ends on 26 Nov 2026 at 09:30", "Confirm: download my data"]) expect(t).toContain(w);
    const d = html(<DataRequestView view="ask" purpose="erase" expiresAt="2026-11-26T09:30:00Z" />);
    expect(d).toContain("Confirm: delete my login");
    expect(d).toContain("cannot be undone");
    clean(e); clean(d);
  });
  it("exported, erased, used or expired, bad link, error and pending", () => {
    expect(html(<DataRequestView view="exported" purpose="export" />)).toContain("downloaded");
    expect(html(<DataRequestView view="erased" purpose="erase" />)).toContain("second member");
    expect(html(<DataRequestView view="invalid" purpose="export" />)).toContain(INVALID_LINK);
    expect(html(<DataRequestView view="bad" purpose="export" problem="Slow down." />)).toContain("Slow down.");
    expect(html(<DataRequestView view="ask" purpose="export" error="Oops." pending />)).toContain('role="alert"');
  });
  it("never says whose login it is", () => {
    for (const v of ["ask", "exported", "erased", "invalid", "bad"] as const) expect(html(<DataRequestView view={v} purpose="export" expiresAt="2026-11-26T09:30:00Z" />)).not.toMatch(/@|company_name|portal_user/);
  });
});

describe("the portal /data-request page", () => {
  const page = (q: Record<string, string | string[] | undefined>) => Page({ searchParams: Promise.resolve(q) });
  it("a malformed token reads nothing; a live link asks; 404 is used or expired; a limit and a failure say so", async () => {
    for (const q of [{}, { token: "short" }, { token: `${D}x` }, { token: [D, D] }, { token: "<script>".padEnd(43, "a") }]) expect((await page(q as never)).props.view, JSON.stringify(q)).toBe("bad");
    expect(state.reads).toEqual([]);
    state.read = { status: 200, body: { purpose: "erase", expiresAt: "2026-11-26T09:30:00+00:00" } };
    expect((await page({ token: D })).props).toMatchObject({ token: D, purpose: "erase" });
    state.read = { status: 404, body: { code: "INVALID_LINK" } };
    expect((await page({ token: D })).props.view).toBe("invalid");
    state.read = { status: 429, body: { code: "TOO_MANY_REQUESTS" } };
    expect((await page({ token: D })).props.problem).toMatch(/Too many tries/);
  });
  it("is noindex with no referrer, a title of 60 or fewer and a description of 120 to 160", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
    expect(String(metadata.title).replace(" | Irish Work Permit", "").length).toBeLessThanOrEqual(60);
    expect(String(metadata.description).length).toBeGreaterThanOrEqual(120);
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
  });
  it("each code the portal contract names has its own sentence", () => {
    const yaml = readFileSync(join(import.meta.dirname, "../../../../docs/openapi/portal.yaml"), "utf8");
    const from = yaml.indexOf("\n  /api/data-request:\n"), b = yaml.slice(from, yaml.indexOf("\n  /api/", from + 5));
    const refs = [...b.matchAll(/responses\/([A-Za-z]+)'/g)].map((m) => { const i = yaml.indexOf(`\n    ${m[1]}:\n`); return yaml.slice(i, i + 700).split("\n").slice(0, 12).join("\n"); });
    const s = [b, ...refs].join("\n");
    const codes = [...new Set([...[...s.matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((m) => m[1]!), ...[...s.matchAll(/code: ([A-Z][A-Z_]{4,})/g)].map((m) => m[1]!)])];
    expect(codes).toEqual(expect.arrayContaining(["BAD_REQUEST", "INVALID_LINK", "BAD_ORIGIN", "TOO_MANY_REQUESTS"]));
    const generic = dataRequestSay({ ok: false, status: 400, code: "ZZZ" });
    for (const code of codes) expect(dataRequestSay({ ok: false, status: code === "TOO_MANY_REQUESTS" ? 429 : 400, code }), code).not.toBe(generic);
    expect(parseToken(D)).toBe(D);
  });
});
