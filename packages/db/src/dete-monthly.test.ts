// Unit tests, no database and no network: the .xlsx reader, the converter, the download (with a fake fetch) and the hostile files.
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parsePermits } from "./dete.ts";
import { deteUrl, downloadDete, MAX_DOWNLOAD, xlsxToTsv } from "./dete-monthly.ts";
import { companiesXlsx, makeXlsx, makeZip } from "./xlsx-fixture.ts";
import { MAX_PART, XlsxRefused } from "./xlsx.ts";

const HEAD = "dete_name\tyear\tpermits\tsource_file\n";
/** What the monthly run does with a file before it connects: convert, then the import's own checks. Returns the error lines, or [] when accepted. */
const refused = (buf: Buffer, year = 2026): string[] => {
  try {
    return parsePermits(xlsxToTsv(buf, year)).errors;
  } catch (e) {
    expect(e).toBeInstanceOf(XlsxRefused);
    return [(e as Error).message];
  }
};

describe("the converter", () => {
  it("reads the 2026 layout: Total row and zero counts left out, names cleaned, the same name added up, sorted", () => {
    const buf = companiesXlsx([["Zed Ltd", 3], ["Acme & Sons  Limited", 2], ["Zero Ltd", 0], ["Line_x000D_\nBreak Ltd", 1], ["Acme & Sons Limited", 4]]);
    expect(xlsxToTsv(buf, 2026)).toBe(`${HEAD}Acme & Sons Limited\t2026\t6\tcompanies-2026.xlsx\nLine Break Ltd\t2026\t1\tcompanies-2026.xlsx\nZed Ltd\t2026\t3\tcompanies-2026.xlsx\n`);
  });

  it('finds the Total column by its header ("Total", "Grand Total" or "...Grand Total"), not by position', () => {
    for (const header of ["Total", "Grand Total", "Permits Issued Grand Total"]) {
      const buf = makeXlsx([["Employer Name", "Jan", header], ["A Ltd", 1, 7], ["Grand Total", 1, 7]]);
      expect(xlsxToTsv(buf, 2023)).toBe(`${HEAD}A Ltd\t2023\t7\tcompanies-2023.xlsx\n`);
    }
  });

  it("the converted file passes the import's own checks", () => {
    expect(parsePermits(xlsxToTsv(companiesXlsx([["Acme Limited", 5]]), 2026))).toEqual({ rows: [{ deteName: "Acme Limited", year: 2026, permits: 5, sourceFile: "companies-2026.xlsx" }], errors: [] });
  });

  it("handles inline strings, rich text, phonetic runs, numeric references and a self-closing cell", () => {
    const sheet =
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Employer Name</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" s="3"/></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>2</v></c></row></sheetData></worksheet>';
    const strings = '<sst><si><t>Empty Ltd</t></si><si><r><t>Rich </t></r><r><rPr/><t>&amp; Co &#x26; &#38; &lt;b&gt;</t></r><rPh><t>ignored</t></rPh></si></sst>';
    const buf = makeXlsx([], { "xl/worksheets/sheet1.xml": sheet, "xl/sharedStrings.xml": strings });
    expect(xlsxToTsv(buf, 2024)).toBe(`${HEAD}Rich & Co & & <b>\t2024\t2\tcompanies-2024.xlsx\n`);
  });

  it("is fast enough for a file four times today's size", () => {
    const buf = companiesXlsx(Array.from({ length: 35_000 }, (_, i): [string, number] => [`Fake Company ${i} Limited`, 1 + (i % 9)]));
    const t = performance.now();
    expect(parsePermits(xlsxToTsv(buf, 2026)).rows).toHaveLength(35_000);
    expect(performance.now() - t).toBeLessThan(3000); // about 0.1 s for the real 8,400 rows; the limit is loose on purpose
  });
});

describe("hostile files are refused whole", () => {
  it("not a zip, an HTML page, an empty file, a truncated zip", () => {
    for (const bad of [Buffer.from("<html><body>404 Not Found</body></html>"), Buffer.from("PK\x03\x04 and then nothing useful"), Buffer.alloc(0), companiesXlsx([["A", 1]]).subarray(0, 120)])
      expect(refused(bad)[0]).toMatch(/not a readable \.xlsx file/);
  });

  it("a part over the size cap, stated or real, and a part that lies about its size", () => {
    expect(refused(makeXlsx([], { "xl/worksheets/sheet1.xml": { data: "x", usize: MAX_PART + 1 } }))[0]).toMatch(/over \d+ bytes/);
    expect(refused(makeXlsx([], { "xl/worksheets/sheet1.xml": Buffer.alloc(MAX_PART + 1) }))[0]).toMatch(/over \d+ bytes/); // a real 48 MB expansion
    expect(refused(makeXlsx([], { "xl/worksheets/sheet1.xml": { data: Buffer.alloc(2_000_000), usize: 10 } }))[0]).toMatch(/does not inflate to its stated size/);
    expect(refused(makeXlsx([], { "xl/worksheets/sheet1.xml": { data: "<worksheet/>", usize: 100 } }))[0]).toMatch(/size or checksum/);
  });

  it("a wrong checksum, an encrypted part, no workbook, no first sheet, a text that does not exist", () => {
    expect(refused(makeXlsx([], { "xl/workbook.xml": { data: "<workbook/>", crc: crc32(Buffer.from("other")) } }))[0]).toMatch(/size or checksum/);
    expect(refused(makeXlsx([], { "xl/workbook.xml": { data: "<workbook/>", flags: 1 } }))[0]).toMatch(/encrypted/);
    expect(refused(makeZip({ "readme.txt": "hello" }))[0]).toMatch(/no workbook/);
    expect(refused(makeXlsx([], { "xl/_rels/workbook.xml.rels": "<Relationships/>" }))[0]).toMatch(/no first worksheet/);
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>';
    expect(refused(makeXlsx([], { "xl/worksheets/sheet1.xml": sheet }))[0]).toMatch(/does not exist/);
  });

  it("a number that is not a number", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1e999</v></c></row></sheetData></worksheet>';
    expect(refused(makeXlsx([], { "xl/worksheets/sheet1.xml": sheet }))[0]).toMatch(/not a number/);
  });

  it.each([["a control character", "Bad&#7;Name Ltd"], ["a character reference that is not a character", "Broken &#xFFFFFFFF; Ltd"]])("a raw XML reference to %s is refused", (_, raw) => {
    const sst = `<sst><si><t>Employer Name</t></si><si><t>Total</t></si><si><t>${raw}</t></si></sst>`;
    expect(refused(makeXlsx([["Employer Name", "Total"], ["x", 1]], { "xl/sharedStrings.xml": sst }))[0]).toMatch(/line 2: the name is empty/);
  });

  it("a missing Total column, or no employers at all", () => {
    expect(refused(makeXlsx([["Employer Name", "Jan"], ["A Ltd", 1]]))[0]).toMatch(/no "Total" column/);
    expect(refused(companiesXlsx([]))[0]).toMatch(/no employer/);
    expect(refused(companiesXlsx([["Zero Ltd", 0]]))[0]).toMatch(/no employer/);
  });

  it.each([
    ["negative", -1],
    ["fractional", 2.5],
    ["huge", 1_000_001],
    ["text", "twelve"],
  ])("a %s count refuses the file, even beside good rows and a row that would cancel it", (_, bad) => {
    const rows = refused(companiesXlsx([["Good Ltd", 5], ["Bad Ltd", bad], ["Bad Ltd", 5]]));
    expect(rows[0]).toMatch(/the count must be a whole number from 0 to 1000000/);
  });

  it("two names whose counts add up past the import's limit are refused by the import's own check", () => {
    expect(refused(companiesXlsx([["Big Ltd", 600_000], ["Big Ltd", 600_000]]))[0]).toMatch(/permits must be a whole number/);
  });

  it.each([
    ["a control character (XML escape)", "Bad_x0007_Name Ltd"],
    ["a right-to-left override", "Evil ‮Ltd"],
    ["a zero-width space", "Zero​Width Ltd"],
    ["a byte order mark", "Bom﻿Ltd"],
    ["a name over 300 characters", "x".repeat(301)],
  ])("a name with %s is refused", (_, name) => {
    expect(refused(companiesXlsx([["Fine Ltd", 1], [name, 1]]))[0]).toMatch(/line \d+: the name is empty, over 300 characters or has control characters/);
  });
});

describe("the download (fetch is always a fake)", () => {
  const xlsx = companiesXlsx([["Acme Limited", 5]]);
  const reply = (body: BodyInit | null, init?: ResponseInit & { url?: string }) => new Response(body, init);
  const fake = (r: Response | Error) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const get = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    return { get, calls };
  };

  it("asks for the fixed address of the year, with redirects refused, and returns the bytes", async () => {
    const { get, calls } = fake(reply(new Uint8Array(xlsx)));
    expect(await downloadDete(2026, get)).toEqual(xlsx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://enterprise.gov.ie/en/publications/publication-files/employment-permits-issued-to-companies-2026.xlsx");
    expect(calls[0]!.url).toBe(deteUrl(2026));
    expect(calls[0]!.init?.redirect).toBe("error");
  });

  it("404 is null (not published yet); any other failure throws", async () => {
    expect(await downloadDete(2026, fake(reply("nope", { status: 404 })).get)).toBeNull();
    for (const status of [403, 500, 503]) await expect(downloadDete(2026, fake(reply("x", { status })).get)).rejects.toThrow(`HTTP ${status}`);
    await expect(downloadDete(2026, fake(new Error("network down")).get)).rejects.toThrow("network down");
  });

  it("an HTML error page sent with status 200 is refused", async () => {
    await expect(downloadDete(2026, fake(reply("<!doctype html><title>Error</title>", { headers: { "content-type": "text/html" } })).get)).rejects.toThrow(/not an \.xlsx/);
  });

  it("a reply over the cap is refused by its stated length and by its real length", async () => {
    await expect(downloadDete(2026, fake(reply("x", { headers: { "content-length": String(MAX_DOWNLOAD + 1) } })).get)).rejects.toThrow(/over 10485760 bytes/);
    const big = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024 * 1024)) });
    await expect(downloadDete(2026, fake(reply(big)).get)).rejects.toThrow(/over 10485760 bytes/);
  });

  it("only a year with a known layout is asked for, so the path cannot be steered", async () => {
    for (const year of [2020, 2101, 2026.5, NaN, Number("2026/../x")]) {
      const f = fake(reply("x"));
      await expect(downloadDete(year, f.get)).rejects.toThrow(/no DETE file layout/);
      expect(f.calls).toHaveLength(0);
    }
  });
});
