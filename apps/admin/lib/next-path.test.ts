// The return address of the staff sign-in: only an own path is taken, everything else is refused (an open redirect is a security finding). No database, no network.
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
let checkedNext: (v: string | string[] | undefined) => string | null;
beforeAll(async () => {
  Object.assign(process.env, { STAFF_AUTH_URL: "https://admin.example.test", STAFF_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ checkedNext } = await import("./next-path"));
});

describe("checkedNext", () => {
  it("takes an own path, with a query", () => {
    expect(checkedNext("/staff")).toBe("/staff");
    expect(checkedNext("/audit?kind=security&from=2026-11-01")).toBe("/audit?kind=security&from=2026-11-01");
    expect(checkedNext("/content?tab=guide&id=41")).toBe("/content?tab=guide&id=41");
  });
  it("refuses another site, a scheme, a protocol-relative address, a backslash, an encoded slash, a repeated key and a long one", () => {
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "https:evil.example", "javascript:alert(1)", "/%2Fevil.example", "/%5Cevil.example", "/%2fevil", "evil", "", " /x", "/x y", "/\u0000", "/" + "a".repeat(1001)])
      expect(checkedNext(bad), JSON.stringify(bad).slice(0, 40)).toBeNull();
    expect(checkedNext(["/staff", "/audit"])).toBeNull();
    expect(checkedNext(undefined)).toBeNull();
  });
  it("refuses a path that would loop back to sign-in or into the API", () => {
    for (const bad of ["/sign-in", "/sign-in?next=/staff", "/forgot-password", "/reset-password?token=x", "/api/staff", "/API/audit/export"]) expect(checkedNext(bad), bad).toBeNull();
  });
});
