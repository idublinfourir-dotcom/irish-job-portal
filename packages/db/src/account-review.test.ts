// Unit tests for the pure parts of the account review module: the email domain cut, the free provider list, the page token and the reason code. No database.
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { decodeReviewCursor, domainOf, FREE_EMAIL_DOMAINS, isFreeEmailDomain, REASON } from "./account-review";

describe("domainOf", () => {
  it("is the part after the first @, lower case, as the sign-up functions cut it", () => {
    expect(domainOf("Jane@Acme.IE")).toBe("acme.ie");
    expect(domainOf("a@b@c.com")).toBe("b");
    expect(domainOf("no-at-sign")).toBeNull();
    expect(domainOf("ends@")).toBeNull();
    expect(domainOf(null)).toBeNull();
  });
});

describe("isFreeEmailDomain", () => {
  it("catches the common free providers and not a company domain", () => {
    for (const d of ["gmail.com", "outlook.com", "hotmail.ie", "yahoo.ie", "icloud.com", "proton.me", "eircom.net"]) expect(isFreeEmailDomain(d), d).toBe(true);
    for (const d of ["hotmail.fr", "outlook.co.uk", "yahoo.co.in", "rediffmail.com", "gmx.de", "web.de", "qq.com", "163.com", "tutanota.com", "fastmail.com"]) expect(isFreeEmailDomain(d), d).toBe(true);
    for (const d of ["acme.ie", "gmail.com.acme.ie", "notgmail.com", "mail.gmail.com.example.test"]) expect(isFreeEmailDomain(d), d).toBe(false);
  });
  it("holds only lower case names, because domains are compared lower case", () => {
    for (const d of FREE_EMAIL_DOMAINS) expect(d).toBe(d.toLowerCase());
  });
});

describe("REASON", () => {
  it("accepts a code and refuses free text", () => {
    for (const r of ["not_a_company", "needs_info", "a", "checked_cro2"]) expect(REASON.test(r), r).toBe(true);
    for (const r of ["", "Not a real company", "has space", "UPPER", "1starts_with_digit", "semi;colon", "x".repeat(64), "line\nbreak"]) expect(REASON.test(r), r).toBe(false);
  });
});

describe("decodeReviewCursor", () => {
  const token = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const why = (t: unknown) => {
    try {
      decodeReviewCursor(t);
    } catch (e) {
      return e instanceof QueueRefused ? e.why : "other";
    }
    return "accepted";
  };
  it("takes a token made from a time and an id", () => {
    expect(decodeReviewCursor(token({ t: "2026-11-12 10:00:00.123456+00", i: "42" }))).toEqual(["2026-11-12 10:00:00.123456+00", "42"]);
  });
  it("refuses anything else", () => {
    for (const t of [undefined, 5, "", "!!", "x".repeat(201), token("text"), token(null), token({ t: "yesterday", i: "1" }), token({ t: "2026-11-12 10:00:00+00", i: "1; drop" }), token({ t: "2026-11-12 10:00:00+00" })])
      expect(why(t), String(t)).toBe("bad_cursor");
  });
});
