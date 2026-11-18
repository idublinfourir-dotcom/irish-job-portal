// Unit: the domain check every saved company domain passes (domain-check.ts) and the domain seed's file reader. No database.
import { describe, expect, it } from "vitest";
import { domainProblem } from "./domain-check";
import { MAX_DOMAIN_ROWS, parseDomainSeed } from "./domain-seed";

describe("domainProblem", () => {
  it("passes plain lower-case host names", () => {
    for (const d of ["example.ie", "fake-co.ie", "mail.fake-co.co.uk", "a1.example.com", "x.io", `${"a".repeat(63)}.ie`]) expect(domainProblem(d), d).toBeNull();
  });
  it("refuses anything that is not one", () => {
    const bad = [
      "", "ie", "localhost", "Example.ie", "EXAMPLE.IE", "https://example.ie", "example.ie/jobs", "example.ie:443", "user@example.ie", " example.ie", "example.ie ",
      "example..ie", ".example.ie", "example.ie.", "-example.ie", "example-.ie", "exa_mple.ie", "127.0.0.1", "10.0.0.1", "192.168.1.300", "[::1]", "::1",
      "xn--pple-43d.com", "fake.xn--p1ai", `${"a".repeat(64)}.ie`, `${"a.".repeat(127)}ie`, "<script>.ie", "ex ample.ie", "exam\u0000ple.ie",
      "аpple.com", "exampӏe.ie", "example。ie", "ex​ample.ie", "exámple.ie", 42, null, undefined, ["example.ie"],
    ];
    for (const d of bad) expect(domainProblem(d), JSON.stringify(d)).toBe("bad_domain");
  });
  it("refuses a free email provider's domain", () => {
    for (const d of ["gmail.com", "outlook.ie", "eircom.net", "proton.me"]) expect(domainProblem(d), d).toBe("free_email_domain");
    expect(domainProblem("notgmail.com")).toBeNull();
  });
});

const HEAD = "display_name\tdomain\tevidence_url\tevidence_quote";
const file = (...rows: string[]) => [HEAD, ...rows].join("\n") + "\n";

describe("parseDomainSeed", () => {
  it("reads good lines, CRLF and a BOM too", () => {
    const p = parseDomainSeed("﻿" + file("Fake Co\tfake-co.ie\thttps://fake-co.ie/contact\tEmail jobs@fake-co.ie", "Other Ltd\tother.ie\thttps://other.ie\tquote").replace(/\n/g, "\r\n"));
    expect(p).toEqual({
      rows: [
        { line: 2, displayName: "Fake Co", domain: "fake-co.ie", evidenceUrl: "https://fake-co.ie/contact" },
        { line: 3, displayName: "Other Ltd", domain: "other.ie", evidenceUrl: "https://other.ie" },
      ],
      refused: [], errors: [],
    });
  });
  it("refuses the whole file for a wrong header, a short line or too many rows", () => {
    expect(parseDomainSeed("name\tdomain\n").errors).toEqual(["line 1: the header must be: display_name <tab> domain <tab> evidence_url <tab> evidence_quote"]);
    expect(parseDomainSeed(file("Fake Co\tfake-co.ie\thttps://x.ie")).errors).toEqual(["line 2: expected 4 columns, found 3"]);
    expect(parseDomainSeed(file(...Array(MAX_DOMAIN_ROWS + 1).fill("A\ta.ie\thttps://a.ie\tq"))).errors[0]).toMatch(/over 2000/);
  });
  it("refuses a bad line alone and keeps the rest", () => {
    const p = parseDomainSeed(file(
      "Fake Co\tFake-Co.ie\thttps://x.ie\tq", "Fake Co\tgmail.com\thttps://x.ie\tq", "Fake Co\thttps://fake.ie\thttps://x.ie\tq", "Fake Co\t1.2.3.4\thttps://x.ie\tq",
      "Fake Co\txn--fke-qla.ie\thttps://x.ie\tq", "\tfake.ie\thttps://x.ie\tq", "Fake Co\tfake.ie\thttp://x.ie\tq", "Fake Co\tfake.ie\tjavascript:alert(1)\tq",
      "Fake Co\tfake.ie\thttps://x.ie\t", "Fake\u0007 Co\tfake.ie\thttps://x.ie\tq", "Good Co\tgood.ie\thttps://good.ie\tq",
    ));
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => r.line)).toEqual([12]);
    expect(p.refused).toHaveLength(10);
    expect(p.refused[0]).toBe('line 2 (Fake Co "Fake-Co.ie"): not a plain lower-case host name (no scheme, path, port, IP address, punycode or single label)');
    expect(p.refused[1]).toMatch(/^line 3 .*free email provider/);
    expect(p.refused[6]).toMatch(/^line 8 .*https/);
    expect(p.refused[8]).toMatch(/^line 10 .*quote/);
  });
});
