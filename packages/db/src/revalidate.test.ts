// Unit: the signed revalidate call (Stage 3 step 2). The check refuses everything not signed with the secret, not fresh or not on the fixed list; the
// caller sends nothing when it is not set up and never throws. A fake fetch stands in for the candidate site. Time budget: the check reads untrusted
// text (up to MAX_BODY characters); measured 27 Nov 2026 at about 0.02 ms a call, budget 1 ms.
import { describe, expect, it, vi } from "vitest";
import { ALL_PAGES, CONTENT_PATHS, checkRevalidate, LEGAL_PATHS, MAX_BODY, REVALIDATE_HEADER, revalidateCandidate, revalidateOn, signBody } from "./revalidate";

const SECRET = "fake-revalidate-secret-fake-revalidate-secret";
const env = { REVALIDATE_SECRET: SECRET, CANDIDATE_AUTH_URL: "http://localhost:3000" };
const NOW = 1_800_000_000_000;
const signed = (o: unknown, secret = SECRET) => { const body = JSON.stringify(o); return [body, signBody(body, secret)] as const; };
const check = (o: unknown, secret?: string, now = NOW) => { const [b, s] = signed(o, secret); return checkRevalidate(b, s, env, now); };

describe("checkRevalidate", () => {
  it("passes a fresh, signed body of known paths", () => {
    for (const paths of [CONTENT_PATHS, LEGAL_PATHS, [ALL_PAGES]]) expect(check({ paths, at: NOW - 59_000 })).toEqual({ paths });
    expect(check({ paths: [{ path: "/terms" }], tags: [], at: NOW })).toEqual({ paths: [{ path: "/terms" }] });
  });
  it("refuses an unsigned, wrongly signed or tampered body", () => {
    const [body, sig] = signed({ paths: LEGAL_PATHS, at: NOW });
    for (const s of [null, "", "abc", "zz".repeat(32), signBody(body, "another-secret-another-secret-another"), sig.slice(0, -2), sig + "00"]) expect(checkRevalidate(body, s, env, NOW), String(s)).toEqual({ refused: 401, code: "BAD_SIGNATURE" });
    expect(checkRevalidate(body.replace("/terms", "/cookies"), sig, env, NOW)).toEqual({ refused: 401, code: "BAD_SIGNATURE" });
    expect(checkRevalidate("x".repeat(MAX_BODY + 1), signBody("x".repeat(MAX_BODY + 1), SECRET), env, NOW)).toEqual({ refused: 401, code: "BAD_SIGNATURE" });
  });
  it("refuses a signed body older or newer than 60 s (a replay), or with no time", () => {
    for (const at of [NOW - 60_001, NOW + 60_001, "1800000000000", null, undefined]) expect(check({ paths: LEGAL_PATHS, at }), String(at)).toEqual({ refused: 401, code: "STALE" });
  });
  it("refuses a signed body naming a path, type, key or tag off the list", () => {
    const bad: unknown[] = [
      { paths: [{ path: "/account" }], at: NOW }, { paths: [{ path: "/guides/[slug]" }], at: NOW }, { paths: [{ path: "/guides", type: "layout" }], at: NOW },
      { paths: [{ path: "/../terms" }], at: NOW }, { paths: [{ path: "/terms", extra: 1 }], at: NOW }, { paths: [], at: NOW }, { paths: "/terms", at: NOW },
      { paths: [null], at: NOW }, { paths: Array(100).fill({ path: "/terms" }), at: NOW },
    ];
    for (const o of bad) expect(check(o), JSON.stringify(o).slice(0, 60)).toEqual({ refused: 400, code: "UNKNOWN_PATH" });
    expect(check({ paths: LEGAL_PATHS, at: NOW, tags: ["jobs"] })).toEqual({ refused: 400, code: "UNKNOWN_TAG" });
    for (const o of [{ paths: LEGAL_PATHS, at: NOW, evil: 1 }, [1], null, "x"]) expect(check(o)).toEqual({ refused: 400, code: "BAD_BODY" });
    const body = "{not json";
    expect(checkRevalidate(body, signBody(body, SECRET), env, NOW)).toEqual({ refused: 400, code: "BAD_BODY" });
  });
  it("is off (503) when the secret is missing or short, whatever the call", () => {
    const [b, s] = signed({ paths: LEGAL_PATHS, at: NOW }, "short");
    for (const e of [{}, { REVALIDATE_SECRET: "" }, { REVALIDATE_SECRET: "short" }]) expect(checkRevalidate(b, s, e, NOW)).toEqual({ refused: 503, code: "NOT_CONFIGURED" });
  });
  it("time budget: a check of the largest body stays under 1 ms", () => {
    const big = JSON.stringify({ paths: LEGAL_PATHS, at: NOW, pad: "x".repeat(MAX_BODY - 200) });
    const t: number[] = [];
    for (let i = 0; i < 51; i++) { const s = performance.now(); checkRevalidate(big, "ab".repeat(32), env, NOW); t.push(performance.now() - s); }
    expect(t.sort((a, b) => a - b)[25]).toBeLessThan(1);
  });
});

describe("revalidateCandidate", () => {
  it("sends the signed body to the candidate site's route", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("{}"));
    expect(await revalidateCandidate(env, LEGAL_PATHS, send)).toBe(true);
    const [url, init] = send.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:3000/api/revalidate");
    const body = init!.body as string, sig = (init!.headers as Record<string, string>)[REVALIDATE_HEADER]!;
    expect(checkRevalidate(body, sig, env)).toEqual({ paths: LEGAL_PATHS });
  });
  it("sends nothing when not set up, and never throws when the site fails or does not answer", async () => {
    const send = vi.fn(async () => new Response("{}"));
    for (const e of [{}, { REVALIDATE_SECRET: SECRET }, { CANDIDATE_AUTH_URL: "http://localhost:3000" }, { ...env, REVALIDATE_SECRET: "short" }]) {
      expect(revalidateOn(e)).toBe(false);
      expect(await revalidateCandidate(e, LEGAL_PATHS, send as unknown as typeof fetch)).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await revalidateCandidate(env, LEGAL_PATHS, (async () => new Response("{}", { status: 401 })) as typeof fetch)).toBe(false);
    expect(await revalidateCandidate(env, LEGAL_PATHS, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch)).toBe(false);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
