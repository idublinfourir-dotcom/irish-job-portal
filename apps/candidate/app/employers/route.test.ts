// Unit (check 3 and a security check): /employers is a temporary redirect to the employer portal's own origin and nothing else. It passes nothing from the request on, so the only place it can send
// anyone is that one origin; with no portal address in production it is the 404 page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { employersHref } from "../_home/meta";
import { GET } from "./route";

const call = (...args: unknown[]) => (GET as (...a: unknown[]) => Response)(...args);
afterEach(() => vi.unstubAllEnvs());

describe("/employers", () => {
  it("redirects with 307 to the portal's origin", () => {
    vi.stubEnv("PORTAL_AUTH_URL", "https://portal.example.test/some/path?x=1#h");
    const r = call();
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("https://portal.example.test/");
  });
  it("sends only to that one origin whatever the request carries (a query, a host header, a next address)", () => {
    vi.stubEnv("PORTAL_AUTH_URL", "https://portal.example.test");
    const hostile = new Request("https://site.example.test/employers?next=https://evil.example/&to=//evil.example&url=javascript:1", { headers: { host: "evil.example", "x-forwarded-host": "evil.example", referer: "https://evil.example/" } });
    for (const args of [[], [hostile], [hostile, { params: Promise.resolve({ x: "//evil.example" }) }]]) {
      const r = call(...args);
      expect(new URL(r.headers.get("location")!).origin).toBe("https://portal.example.test");
      expect(r.headers.get("location")).toBe("https://portal.example.test/");
      expect(r.status).toBe(307);
    }
  });
  it("uses the development portal address when none is set outside production, and the 404 page in production", () => {
    vi.stubEnv("PORTAL_AUTH_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(employersHref()).toBe("http://localhost:3001/");
    expect(call().headers.get("location")).toBe("http://localhost:3001/");
    vi.stubEnv("NODE_ENV", "production");
    expect(employersHref()).toBeNull();
    let digest = "";
    try { call(); } catch (e) { digest = (e as { digest?: string }).digest ?? ""; }
    expect(digest).toMatch(/NEXT_(HTTP_ERROR_FALLBACK|NOT_FOUND)/);
    expect(digest).toContain("404");
  });
});
