// C4: the fresh-session rule alone, no database.
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { isFresh, ownPath, REAUTH_SECONDS, verifiedPayload } from "./reauth";

describe("isFresh", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  const at = (secondsAgo: number) => ({ createdAt: new Date(now - secondsAgo * 1000) });
  it("is true for a sign-in under 10 minutes ago and false from 10 minutes on", () => {
    expect(REAUTH_SECONDS).toBe(600);
    expect(isFresh(at(0), now)).toBe(true);
    expect(isFresh(at(599), now)).toBe(true);
    expect(isFresh(at(600), now)).toBe(false);
    expect(isFresh(at(86400), now)).toBe(false);
  });
  it("takes the ISO string a session row may carry, never counts a bad date as fresh, and allows another server's clock a little ahead", () => {
    expect(isFresh({ createdAt: new Date(now - 1000).toISOString() }, now)).toBe(true);
    expect(isFresh({ createdAt: "not a date" }, now)).toBe(false);
    expect(isFresh(at(-5), now)).toBe(true);
  });
});

describe("verifiedPayload (the email-change race check reads only tokens we signed)", () => {
  const secret = "s".repeat(32);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (payload: object, key = secret) => {
    const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
    return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
  };
  const now = Date.parse("2026-11-19T12:00:00Z");
  it("returns the payload of a token signed with the secret and not expired", () => {
    expect(verifiedPayload(sign({ updateTo: "a@b.test", exp: now / 1000 + 60 }), secret, now)).toMatchObject({ updateTo: "a@b.test" });
  });
  it("refuses another key, a changed payload, an expired token and junk", () => {
    expect(verifiedPayload(sign({ updateTo: "a@b.test" }, "t".repeat(32)), secret, now)).toBeNull();
    const [h, , sig] = sign({ updateTo: "a@b.test" }).split(".");
    expect(verifiedPayload(`${h}.${b64({ updateTo: "victim@b.test" })}.${sig}`, secret, now)).toBeNull();
    expect(verifiedPayload(sign({ updateTo: "a@b.test", exp: now / 1000 - 1 }), secret, now)).toBeNull();
    for (const junk of ["", "a.b", "a.b.c", "..", `${b64({})}.${b64({})}.`]) expect(verifiedPayload(junk, secret, now), junk).toBeNull();
  });
});

describe("ownPath (the only callbackURL the EMAIL_TAKEN answer redirects to)", () => {
  const O = "https://www.example.ie";
  it("takes a plain path on our site, with a query", () => {
    for (const u of ["/", "/account", "/account?tab=email", "/a/b-c_d.e~f", "/account?next=%2Fx", "/account#%5C", "/a%20b"]) expect(ownPath(u, O), u).toBe(true);
  });
  it("refuses every other host, every whitespace or control character, any backslash, a long path and a non-string", () => {
    const bad = ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "/\t/evil.example", "/\n/x", "/\r/x", "/ /evil.example", "/x\\y",
      "https:evil.example", "evil.example", "", "/\u0000x", "/ x", "/é", "/" + "a".repeat(1000), "/%2F%2Fevil.example", "/%2f%2fevil.example", "/%5C%5Cevil.example", "/%5cevil.example", "/x/%2F/y?z", 42, null, undefined];
    for (const u of bad) expect(ownPath(u, O), JSON.stringify(u)).toBe(false);
  });
});
