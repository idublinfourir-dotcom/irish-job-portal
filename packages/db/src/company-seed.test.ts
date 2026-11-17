// Unit: the company seed file reader and the slug base. No database. The real file is the checked list in packages/db/seed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_ROWS, parseSeed, slugBase } from "./company-seed.ts";

const HEAD = "display_name\tkind\tbrand_names\tdete_names";
const file = (...rows: string[]) => [HEAD, ...rows].join("\n") + "\n";
const errs = (...rows: string[]) => parseSeed(file(...rows)).errors;

describe("parseSeed", () => {
  it("reads the real 94-row file with no error: 72 employers, 18 public bodies, 4 agencies, 194 DETE names", () => {
    const { rows, errors } = parseSeed(readFileSync(new URL("../seed/companies-2026-11.tsv", import.meta.url), "utf8"));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(94);
    const kinds = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});
    expect(kinds).toEqual({ employer: 72, public_body: 18, agency: 4 });
    expect(rows.flatMap((r) => r.deteNames)).toHaveLength(194);
  });

  it("splits by ' ;; ', trims, drops repeats in a cell, allows no DETE names, and keeps a CRLF file", () => {
    const { rows, errors } = parseSeed(file("Acme\temployer\t Acme ;; Acme Jobs ;; Acme\tAcme Ltd ;; Acme (Cork) Ltd", "Beta\tagency\tBeta\t").replace(/\n/g, "\r\n"));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, displayName: "Acme", kind: "employer", brandNames: ["Acme", "Acme Jobs"], deteNames: ["Acme Ltd", "Acme (Cork) Ltd"] },
      { line: 3, displayName: "Beta", kind: "agency", brandNames: ["Beta"], deteNames: [] },
    ]);
    expect(parseSeed(file("A;;B\temployer\tA;;B\t")).rows[0]!.brandNames).toEqual(["A;;B"]); // only " ;; " splits
  });

  it("refuses a wrong header, a wrong column count, a bad kind and a missing brand name", () => {
    expect(parseSeed("name\tkind\n").errors).toEqual(["line 1: the header must be: display_name <tab> kind <tab> brand_names <tab> dete_names"]);
    expect(errs("Acme\temployer\tAcme")).toEqual(["line 2: expected 4 columns, found 3"]);
    expect(errs("Acme\temployer\tAcme\tX\tY")).toEqual(["line 2: expected 4 columns, found 5"]);
    expect(errs("Acme\tcharity\tAcme\t")[0]).toMatch(/^line 2: kind must be employer, public_body, agency/);
    expect(errs("Acme\tEmployer\tAcme\t")[0]).toMatch(/kind must be/);
    expect(errs("Acme\temployer\t\tAcme Ltd")).toEqual(["line 2: at least one brand name is needed"]);
  });

  it("refuses empty, over-long, control-character and letterless names", () => {
    const long = "A".repeat(301);
    for (const bad of [
      "\temployer\tAcme\t", `${long}\temployer\tAcme\t`, "!!!\temployer\tAcme\t", "Ac\u0007me\temployer\tAcme\t", // display name
      "Acme\temployer\tAcme ;;  ;; B\t", "Acme\temployer\tAcme ;; \t", `Acme\temployer\t${long}\t`, "Acme\temployer\t---\t",
      "Acme\temployer\tAcme\tAcme\u200b Ltd", "Acme\temployer\tAcme\tAcme \u202eLtd", "Acme\temployer\tAc\ufeffme\t", "Acme\temployer\tAc\u0000me\t",
      `Acme\temployer\tAcme\t${Array.from({ length: 51 }, (_, i) => `N${i}`).join(" ;; ")}`, // over 50 names in a cell
    ]) expect(errs(bad), JSON.stringify(bad)).toHaveLength(1);
    expect(errs(`${"A".repeat(300)}\temployer\tAcme\t`)).toEqual([]);
  });

  it("refuses a DETE name on two rows, but not one repeated in its own row", () => {
    expect(errs("Acme\temployer\tAcme\tShared Ltd", "Beta\temployer\tBeta\tShared Ltd")).toEqual(['line 3: the DETE name "Shared Ltd" is also on line 2']);
    expect(errs("Acme\temployer\tAcme\tShared Ltd ;; Shared Ltd")).toEqual([]);
  });

  it("keeps SQL-like text as plain text, and refuses a file over the row limit; stops after 20 errors", () => {
    const sql = "Robert'); drop table organisation;--";
    expect(parseSeed(file(`${sql}\temployer\t${sql}\t${sql}`)).rows[0]).toMatchObject({ displayName: sql, brandNames: [sql], deteNames: [sql] });
    expect(parseSeed(file(...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `C${i}\temployer\tC${i}\t`))).errors).toEqual([`the file has ${MAX_ROWS + 1} rows, over ${MAX_ROWS}`]);
    expect(errs(...Array.from({ length: 30 }, () => "x"))).toHaveLength(20);
  });
});

describe("slugBase", () => {
  it("is register_organisation's slug: letters and digits, lower-case, joined by hyphens", () => {
    expect(slugBase("Abbott")).toBe("abbott");
    expect(slugBase("St James's Hospital Dublin")).toBe("st-james-s-hospital-dublin");
    expect(slugBase("  Turner & Townsend  ")).toBe("turner-townsend");
    expect(slugBase("Médecins Sans Frontières/Doctors (MSF)")).toBe("m-decins-sans-fronti-res-doctors-msf");
    expect(slugBase("Spectrum.Life")).toBe("spectrum-life");
    expect(slugBase("!!!")).toBe("");
  });
});
