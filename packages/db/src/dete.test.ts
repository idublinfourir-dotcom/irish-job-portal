// Unit: reading the two DETE files. No database. Fake names only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLinks, parsePermits } from "./dete";

const H = "dete_name\tyear\tpermits\tsource_file\n";

describe("parsePermits", () => {
  it("reads rows, with CRLF, a BOM and an empty source_file", () => {
    const r = parsePermits("﻿" + H.replace("\n", "\r\n") + "Acme Ltd\t2024\t5\tc-2024.xlsx\r\nBeta Ltd\t2025\t12\t\r\n");
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { deteName: "Acme Ltd", year: 2024, permits: 5, sourceFile: "c-2024.xlsx" },
      { deteName: "Beta Ltd", year: 2025, permits: 12, sourceFile: null },
    ]);
  });

  it.each([
    ["a missing header", "Acme\t2024\t5\tf\n", "header"],
    ["a wrong header", "name\tyear\tpermits\tsource_file\nAcme\t2024\t5\tf\n", "header"],
    ["an empty file", "", "header"],
  ])("refuses %s", (_, text, why) => {
    const r = parsePermits(text);
    expect(r.rows).toEqual([]);
    expect(r.errors[0]).toContain(why);
  });

  it.each([
    ["a word for permits", "Acme\t2024\tmany\tf", "line 2: permits"],
    ["a decimal", "Acme\t2024\t1.5\tf", "permits"],
    ["a number with an exponent", "Acme\t2024\t1e3\tf", "permits"],
    ["zero", "Acme\t2024\t0\tf", "permits"],
    ["a negative count", "Acme\t2024\t-3\tf", "permits"],
    ["a huge count", "Acme\t2024\t99999999999999999999\tf", "permits"],
    ["a year before 2000", "Acme\t1999\t5\tf", "year"],
    ["a year after 2100", "Acme\t2101\t5\tf", "year"],
    ["a year with letters", "Acme\t20x4\t5\tf", "year"],
    ["an empty name", "  \t2024\t5\tf", "name"],
    ["a name over 300 characters", `${"x".repeat(301)}\t2024\t5\tf`, "name"],
    ["a NUL in the name", "Ac\u0000me\t2024\t5\tf", "name"],
    ["a bell in the name", "Ac\u0007me\t2024\t5\tf", "name"],
    ["a broken-encoding character", "Ac�me\t2024\t5\tf", "name"],
    ["a long source_file", `Acme\t2024\t5\t${"f".repeat(201)}`, "source_file"],
    ["too few columns", "Acme\t2024\t5", "4 columns"],
    ["too many columns", "Acme\t2024\t5\tf\textra", "4 columns"],
    ["an empty line in the middle", "Acme\t2024\t5\tf\n\nBeta\t2024\t5\tf", "4 columns"],
  ])("refuses %s", (_, line, why) => {
    const r = parsePermits(H + line + "\n");
    expect(r.errors.join("\n")).toContain(why);
  });

  it("refuses the same name and year twice, naming the first line", () => {
    const r = parsePermits(H + "Acme\t2024\t5\tf\nAcme\t2025\t5\tf\nAcme\t2024\t6\tg\n");
    expect(r.errors).toEqual(["line 4: the same name and year as line 2"]);
  });

  it("trims names, so ' Acme ' and 'Acme' are the same name", () => {
    expect(parsePermits(H + " Acme \t2024\t5\tf\nAcme\t2024\t5\tf\n").errors).toHaveLength(1);
  });

  it("accepts a name of exactly 300 characters and odd Unicode", () => {
    const names = ["x".repeat(300), "Café Ünïcode Ltd", "株式会社テスト", "Emoji 🚀 Ltd", "é combined", "עברית Ltd", "Obrien'; drop table dete_permit_count;-- Ltd"];
    const r = parsePermits(H + names.map((n) => `${n}\t2024\t5\tf`).join("\n") + "\n");
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.deteName)).toEqual(names);
  });

  it.each([["a zero-width space", "Zero\u200bwidth Ltd"], ["a right-to-left override", "Evil \u202eLtd"], ["a byte order mark", "Bom\ufeffLtd"], ["a line separator", "Line\u2028Ltd"]])("refuses a name with %s", (_, name) => {
    expect(parsePermits(H + `${name}\t2024\t5\tf\n`).errors).toEqual(["line 2: the name is empty, over 300 characters or has control characters"]);
  });

  it("stops listing after 20 errors", () => {
    const r = parsePermits(H + Array.from({ length: 500 }, () => "A\t1\t1\tf").join("\n"));
    expect(r.errors).toHaveLength(20);
  });
});

describe("parseLinks", () => {
  const LH = "organisation_name_id\tdete_name\n";
  it("reads links", () => {
    expect(parseLinks(LH + "12\tAcme Ltd\n7\tBeta Ltd\n")).toEqual({
      rows: [{ organisationNameId: "12", deteName: "Acme Ltd" }, { organisationNameId: "7", deteName: "Beta Ltd" }],
      errors: [],
    });
  });
  it.each([
    ["a bad header", "id\tdete_name\n1\tAcme\n", "header"],
    ["a word for an id", LH + "x\tAcme\n", "organisation_name_id"],
    ["zero", LH + "0\tAcme\n", "organisation_name_id"],
    ["a negative id", LH + "-4\tAcme\n", "organisation_name_id"],
    ["an id too big for bigint", LH + "99999999999999999999\tAcme\n", "organisation_name_id"],
    ["an empty name", LH + "1\t \n", "name"],
    ["a long name", LH + `1\t${"x".repeat(301)}\n`, "name"],
    ["three columns", LH + "1\tAcme\textra\n", "2 columns"],
    ["the same DETE name twice", LH + "1\tAcme\n2\tAcme\n", "line 2"],
  ])("refuses %s", (_, text, why) => {
    expect(parseLinks(text).errors.join("\n")).toContain(why);
  });
});

describe("dete.ts source", () => {
  const src = readFileSync(new URL("./dete.ts", import.meta.url), "utf8");
  it("every SQL constant is a plain string with no value in the text", () => {
    const consts = [...src.matchAll(/^(?:export )?const ([A-Z_0-9]+) =\s*([\s\S]*?);$/gm)].filter(([, , b]) => /\b(select|insert|update)\b/.test(b!));
    expect(consts.length).toBeGreaterThanOrEqual(5);
    for (const [, name, body] of consts) {
      expect(body, name).not.toContain("`");
      expect(body, name).not.toContain("${");
    }
  });
  it("every query call passes a constant", () => {
    const calls = [...src.matchAll(/\.query(?:<[^(]*?>)?\(\s*([^,)\s]+)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const first of calls) expect(first).toMatch(/^([A-Z_0-9]+|"begin"|"commit"|"rollback")$/);
  });
});
