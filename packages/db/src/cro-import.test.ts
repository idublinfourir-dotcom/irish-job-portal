// Unit: the zip reader, the CSV reader, the row rules and the batching of the CRO import, with a fake database. No network, no real files.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { better, croRows, csvRecords, importCro, openCsvInZip, type CroRow, type CroStats } from "./cro-import";
import { ImportRefused } from "./registers";
import { croCsv, croZip, makeZip } from "../test/registers-helpers";

const dir = mkdtempSync(join(tmpdir(), "cro-unit-"));
const file = (name: string, data: Buffer) => (writeFileSync(join(dir, name), data), join(dir, name));
async function* chunks(s: string, size = 7) { for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size); }
const all = async <T>(g: AsyncIterable<T>) => { const o: T[] = []; for await (const x of g) o.push(x); return o; };
const text = async (f: string) => { const s = await openCsvInZip(f); s.setEncoding("utf8"); let t = ""; for await (const c of s) t += c; return t; };
const fresh = (): CroStats => ({ read: 0, kept: 0, skipped: 0, repeated: 0 });

describe("csvRecords", () => {
  it("reads quotes, doubled quotes, line breaks inside quotes, CRLF, empty cells and a BOM, in tiny chunks", async () => {
    const s = '﻿a,b,c\r\n1,"x, ""y""",\r\n2,"line\nbreak",z\n\n3,,';
    expect(await all(csvRecords(chunks(s)))).toEqual([["a", "b", "c"], ["1", 'x, "y"', ""], ["2", "line\nbreak", "z"], ["3", "", ""]]);
  });
  it("cuts a huge field and a huge record instead of growing, and survives an unterminated quote", async () => {
    const huge = "x".repeat(100_000);
    const [row] = await all(csvRecords(chunks(`${huge},b\n`, 5000)));
    expect(row![0]!.length).toBe(2000);
    const wide = await all(csvRecords(chunks("a,".repeat(5000) + "\n")));
    expect(wide[0]!.length).toBe(100);
    const open = await all(csvRecords(chunks(`h\n"never closed,${huge}\nnext,row\n`, 100)));
    expect(open.length).toBeLessThanOrEqual(2);
    expect(open.every((r) => r.every((f) => f.length <= 2000))).toBe(true);
  });
});

describe("croRows", () => {
  const run = async (csv: string) => { const stats = fresh(); return { rows: await all(croRows(csvRecords(chunks(csv, 50)), stats)), stats }; };
  it("keeps the four statuses, trims, reads columns by name, and finds company type and county", async () => {
    const { rows, stats } = await run(croCsv([
      { num: "100", name: "EXAMPLE TRADING LIMITED", status: "Normal " }, { num: "101", name: "Gone Ltd", status: "Dissolved" }, { num: "102", name: "Leaving Ltd", status: "Strike Off Listed" },
      { num: "103", name: "Liq Ltd", status: "Liquidation" }, { num: "104", name: "Exam Ltd", status: "Examinership" }, { num: "105", name: "UK Ltd", status: "Liquidation (UK)" },
    ]));
    expect(rows.map((r) => [r.croNumber, r.status, r.normalisedName])).toEqual([["100", "Normal", "example trading"], ["102", "Strike Off Listed", "leaving"], ["103", "Liquidation", "liq"], ["104", "Examinership", "exam"]]);
    expect(rows[0]).toMatchObject({ companyType: "LTD - Private Company Limited by Shares", county: "Cork" });
    expect(stats).toMatchObject({ read: 6, kept: 4, skipped: 0 });
  });
  it("skips rows with an odd number or no or over-long name, strips control characters, and keeps SQL-looking names as plain text", async () => {
    const { rows, stats } = await run(croCsv([{ num: "abc", name: "A Ltd" }, { num: "12", name: "" }, { num: "13", name: "x".repeat(1999) + "y" }, { num: "14", name: "Bob\u0000 \u0007Ltd'; drop table x;--" }, { num: "0015", name: "Fine Ltd" }]));
    expect(stats.skipped).toBe(3);
    expect(rows.map((r) => [r.croNumber, r.name])).toEqual([["14", "Bob Ltd'; drop table x;--"], ["15", "Fine Ltd"]]);
  });
  it("refuses a file with a missing column or no rows", async () => {
    await expect(run("company_num,company_name\n1,A\n")).rejects.toThrow(/no column company_status/);
    await expect(run("")).rejects.toThrow(/empty/);
  });
});

describe("the zip", () => {
  it("reads a deflated and a stored csv", async () => {
    expect(await text(file("a.zip", croZip([{ num: "1", name: "A" }])))).toContain("company_num");
    expect(await text(file("b.zip", makeZip([{ name: "x/companies.csv", data: "h\nrow\n", method: 0 }])))).toBe("h\nrow\n");
  });
  it.each([
    ["no csv", makeZip([{ name: "readme.txt", data: "hi" }]), /no csv/],
    ["too many files", makeZip(Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }))), /21 files/],
    ["an encrypted entry", makeZip([{ name: "a.csv", data: "x", flags: 1 }]), /encrypted/],
    ["a huge declared size", makeZip([{ name: "a.csv", data: "x", declaredSize: 2 ** 31 }]), /limit/],
    ["not a zip", Buffer.from("this is not a zip file at all"), /not a zip/],
  ])("refuses %s", async (name, zip, why) => {
    await expect(openCsvInZip(file(`${name.replaceAll(" ", "-")}.zip`, zip))).rejects.toThrow(why);
  });
  it("stops an entry that unzips to more than the zip says", async () => {
    const f = file("lie.zip", makeZip([{ name: "a.csv", data: "y".repeat(100_000), declaredSize: 10 }]));
    await expect(text(f)).rejects.toThrow(ImportRefused);
  });
  it("refuses a cut-short zip", async () => {
    const z = croZip([{ num: "1", name: "A" }]);
    await expect(openCsvInZip(file("short.zip", z.subarray(0, z.length - 30)))).rejects.toThrow();
  });
});

describe("importCro", () => {
  const row = (n: number, statusDate = "2020-01-01", status = "Normal"): CroRow => ({ croNumber: String(n), name: `N${n}`, normalisedName: `n${n}`, status, companyType: null, county: null, statusDate });
  async function* rowsOf(list: CroRow[]) { yield* list; }
  const fake = (before: number) => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const query = async (sql: string, params?: unknown[]) => (calls.push({ sql, params }), sql.includes("count(*)") ? { rows: [{ n: before }], rowCount: 1 } : { rows: [], rowCount: 0 });
    return { calls, query: query as unknown as pg.Pool["query"] };
  };
  it("the later status date wins a repeated number, the earlier row wins a tie", () => {
    expect(better({ statusDate: "2026-05-01" }, { statusDate: "2024-01-01" })).toBe(true);
    expect(better({ statusDate: "2024-01-01" }, { statusDate: "2026-05-01" })).toBe(false);
    expect(better({ statusDate: "2024-01-01" }, { statusDate: "2024-01-01" })).toBe(false);
    expect(better({ statusDate: "2024-01-01" }, { statusDate: "" })).toBe(true);
  });
  it("sends one statement per 5,000 rows, keeps the best repeated row, and marks and deletes after", async () => {
    const db = fake(0);
    const list = [...Array.from({ length: 12_000 }, (_, i) => row(i + 1)), row(5, "2026-01-01", "Liquidation"), row(6, "2019-01-01")];
    const r = await importCro(db, rowsOf(list), "2026-11-12", fresh());
    const upserts = db.calls.filter((c) => c.sql.startsWith("insert"));
    expect(upserts.length).toBe(3); // 12,000 distinct rows: 5,000 + 5,000 + 2,000
    expect(db.calls.length).toBe(upserts.length + 3); // + count, mark, delete
    expect((upserts[2]!.params![0] as string[]).length).toBe(2001) // 2,000 new + number 5 sent again with its later date;
    expect(r.repeated).toBe(2);
    expect(upserts.flatMap((u) => u.params![3] as string[]).filter((s) => s === "Liquidation")).toHaveLength(1);
  });
  it("refuses, before marking anything, a file with under 80% of the rows we hold", async () => {
    const db = fake(1000);
    await expect(importCro(db, rowsOf(Array.from({ length: 700 }, (_, i) => row(i + 1))), "2026-11-12", fresh())).rejects.toThrow(/refused before marking/);
    expect(db.calls.some((c) => c.sql.startsWith("update"))).toBe(false);
  });
});
