// The staff sign-in's return address: a path of our own only (an open redirect is a security finding). No database, no network.
import { describe, expect, it } from "vitest";
import { checkedNext } from "./next-path";

describe("checkedNext", () => {
  it("keeps a path of our own, with its query", () => {
    for (const ok of ["/accounts", "/employer-jobs?queue=scam_flag&id=4", "/companies/12", "/contact?id=9#top"]) expect(checkedNext(ok), ok).toBe(ok);
  });
  it("refuses every way off the site, a sign-in page and the API", () => {
    const bad = ["//evil.example", "/\\evil.example", "https://evil.example/", "http:evil.example", "javascript:alert(1)", "/%2Fevil.example", "/%5Cevil.example", "/%2f/evil.example", "evil.example", "", "/\t/evil.example", "/a b", "/sign-in", "/sign-in?next=/", "/api/accounts", "/reset-password?token=x", "/" + "a".repeat(1100)];
    for (const v of bad) expect(checkedNext(v), JSON.stringify(v)).toBeNull();
    for (const v of [undefined, ["/accounts", "/contact"]]) expect(checkedNext(v as never)).toBeNull();
  });
});
