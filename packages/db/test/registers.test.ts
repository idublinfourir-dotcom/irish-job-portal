// Integration and security: the register check at sign-up, the CRO and WRC imports, and who may read or write what, on the real test database.
// The outside services (CRO portal, WRC site) are fake fetches serving made-up files. Made-up companies and agencies only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { croRows, csvRecords, importCro } from "../src/cro-import";
import { importWrc } from "../src/wrc-import";
import { main } from "../src/registers-cli";
import { normaliseCompanyName } from "../src/registers";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { croLine, croCsv, croZip, makeZip, NAME_CASES, wrcBbox, wrcPdf, CRO_HEADER, type CroLine, type WrcLine } from "./registers-helpers";
import { parseWrc } from "../src/wrc-import";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
let F: { portal: () => Promise<string> };
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
beforeAll(async () => {
  db = await createTestDb();
  ({ F, su } = fixtures(db) as unknown as { F: typeof F; su: typeof su });
});
afterAll(() => db.drop());

const hasPdftotext = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
const tmp = mkdtempSync(join(tmpdir(), "registers-it-"));
let nFile = 0;
const fileOf = (data: Buffer | string, ext: string) => (writeFileSync(join(tmp, `f${++nFile}.${ext}`), data), join(tmp, `f${nFile}.${ext}`));
const fetcherEnv = () => ({ FETCHER_DATABASE_URL: urlFor(db.name, "app_fetcher"), DATABASE_SSL: "disable" });
const adminEnv = () => ({ WRC_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" });
const noFetch = (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch;
async function runCro(zip: Buffer, today: string) {
  const out: string[] = [];
  const code = await main(["cro", "--file", fileOf(zip, "zip")], fetcherEnv(), (l) => void out.push(l), { fetch: noFetch, today: () => today });
  return { code, out: out.join("\n") };
}
const cro = async (number: string) => (await su("select * from cro_company where cro_number = $1", [number])).rows[0];

// ===== the name rule: SQL and JS agree =====
describe("name key", () => {
  it.each(NAME_CASES)("SQL and JS both give the same key for %s", async (typed, key) => {
    expect((await su("select private.normalise_company_name($1) k", [typed])).rows[0].k).toBe(key);
    expect(normaliseCompanyName(typed)).toBe(key);
  });
});

// ===== the register check =====
describe("register_organisation", () => {
  const register = async (kind: "employer" | "agency", name: string, cro: string | null, wrc: string | null) => {
    const r = (await db.pool("app_portal").query("select private.register_organisation($1, $2, $3, $4, $5) r", [await F.portal(), kind, name, cro, wrc])).rows[0].r;
    const org = (await su("select cro_number, wrc_licence_number from organisation where id = $1", [r.organisation_id])).rows[0];
    const detail = (await su("select detail, reason from review_item where organisation_id = $1 and queue = 'account_review'", [r.organisation_id])).rows[0];
    return { r, org, detail: detail.detail, reason: detail.reason };
  };
  const addCro = (n: string, name: string, status = "Normal") => su("insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) values ($1, $2, $3, $4, current_date)", [n, name, normaliseCompanyName(name), status]);

  it("a CRO company found: status shown, Ltd matches LIMITED, and the typed IE, spaces and zeros are cleaned", async () => {
    await addCro("700001", "ACME TRADING LIMITED");
    const x = await register("employer", "Acme Trading Ltd", " IE 00 700001 ", null);
    expect(x.org.cro_number).toBe("700001");
    expect(x.detail).toEqual({ register: "cro_company", found: true, name_matches: true, status: "Normal" });
    expect(x.reason).toBe("new organisation");
    expect(x.r.found_in_register).toBe(true);
  });
  it("a status with a trailing space is shown trimmed; a leaving status goes to review with the status shown", async () => {
    await addCro("700002", "LEAVING CO LIMITED", "Strike Off Listed ");
    await addCro("700003", "GONE CO LIMITED", "Not in latest file");
    expect((await register("employer", "Leaving Co", "700002", null)).detail).toMatchObject({ found: true, status: "Strike Off Listed", name_matches: true });
    expect((await register("employer", "Gone Co", "ie700003", null)).detail).toMatchObject({ found: true, status: "Not in latest file" });
  });
  it("a different name is found but not matching", async () => {
    await addCro("700004", "REAL NAME LIMITED");
    expect((await register("employer", "Something Else Ltd", "700004", null)).detail).toMatchObject({ found: true, name_matches: false });
  });
  it("an unknown number still goes to review, marked not found, with no status", async () => {
    const x = await register("employer", "Unknown Ltd", "IE 9999999", null);
    expect(x.detail).toEqual({ register: "cro_company", found: false, name_matches: false });
    expect(x.r.status).toBe("pending_review");
    expect((await register("employer", "No Number Ltd", null, null)).detail).toMatchObject({ found: false });
  });
  it("a WRC number is found with or without EA, spaces or lower case, and the name matches the agency or trading name", async () => {
    await su("insert into wrc_licence(licence_number, agency_name, trading_name, missed_imports) values ('EA7001', 'FAKE STAFF LIMITED', null, 0), ('EA7011', 'ANOTHER STAFF LIMITED', 'Quick Hire', 0), ('EA7012', 'THIRD STAFF LIMITED', null, 0), ('EA7002', 'Other Agency', null, 2)");
    const a = await register("agency", "Fake Staff Ltd", null, "7001");
    expect(a.org.wrc_licence_number).toBe("EA7001");
    expect(a.detail).toEqual({ register: "wrc_licence", found: true, name_matches: true, possibly_lapsed: false });
    expect((await register("agency", "quick hire", null, " ea 7011 ")).detail).toMatchObject({ found: true, name_matches: true });
    expect((await register("agency", "Wrong Name", null, "EA7012")).detail).toMatchObject({ found: true, name_matches: false });
    expect((await register("agency", "Other Agency", null, "ea7002")).detail).toMatchObject({ found: true, possibly_lapsed: true });
    expect((await register("agency", "Nobody", null, "7777")).detail).toEqual({ register: "wrc_licence", found: false, name_matches: false });
  });
  it("an empty name key never matches", async () => {
    await su("insert into wrc_licence(licence_number, agency_name) values ('EA7003', '--')");
    expect((await register("agency", "---", null, "EA7003")).detail).toMatchObject({ found: true, name_matches: false });
  });
});

// ===== the CRO import =====
describe("CRO import (as app_fetcher, through the command)", () => {
  const lines = (extra: CroLine[] = []): CroLine[] => [
    { num: "810001", name: "FIRST IMPORT LIMITED" }, { num: "810002", name: "Second Import Ltd", status: "Strike Off Listed" }, { num: "810003", name: "Dissolved Co", status: "Dissolved" },
    { num: "810004", name: "Third Import Limited", address: ["Unit 1", "Dublin 4"] }, ...extra,
  ];
  beforeEach(async () => void (await su("delete from cro_company")));
  it("imports, imports again without duplicates, moves last_seen_on, marks a vanished row and deletes it after 90 days", async () => {
    const first = await runCro(croZip(lines()), "2026-11-01");
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/read 4 rows, kept 3/);
    expect(await cro("810003")).toBeUndefined();
    expect(await cro("810001")).toMatchObject({ name: "FIRST IMPORT LIMITED", normalised_name: "first import", status: "Normal", company_type: "LTD - Private Company Limited by Shares", county: "Cork" });
    expect(await cro("810004")).toMatchObject({ county: "Dublin" });
    expect((await cro("810002")).status).toBe("Strike Off Listed");
    // second file: 810001 renamed, 810002 gone, a new one
    const second = lines().filter((l) => l.num !== "810002");
    second[0] = { num: "810001", name: "FIRST IMPORT RENAMED LIMITED" };
    await runCro(croZip([...second, { num: "810005", name: "New Co Ltd" }]), "2026-11-08");
    expect((await su("select count(*)::int n from cro_company where cro_number like '81000%'")).rows[0].n).toBe(4);
    expect(await cro("810001")).toMatchObject({ name: "FIRST IMPORT RENAMED LIMITED", last_seen_on: new Date("2026-11-08T00:00:00") });
    // DB-3: a gone row's date is the day it went; an unchanged row (810004) keeps the date it was last written
    expect(await cro("810002")).toMatchObject({ status: "Not in latest file", last_seen_on: new Date("2026-11-08T00:00:00") });
    expect(await cro("810004")).toMatchObject({ status: "Normal", last_seen_on: new Date("2026-11-01T00:00:00") });
    // a run on a day more than 90 days later without 810002 deletes it; the unchanged companies stay
    await runCro(croZip([...second, { num: "810005", name: "New Co Ltd" }]), "2027-02-20");
    expect(await cro("810002")).toBeUndefined();
    expect(await cro("810004")).toMatchObject({ status: "Normal", last_seen_on: new Date("2026-11-01T00:00:00") });
    expect(await cro("810001")).toMatchObject({ name: "FIRST IMPORT RENAMED LIMITED", status: "Normal" });
    expect((await su("select row_count from register_import where source = 'cro'")).rows[0].row_count).toBe(3);
  });
  it("DB-3: importing the same file again a week later writes 0 rows (every row's version is unchanged); a company back in the file is live again", async () => {
    const many = Array.from({ length: 3000 }, (_, i): CroLine => ({ num: String(870000 + i), name: `Same ${i} Ltd`, address: ["Main St", "Galway"] }));
    expect((await runCro(croZip(many), "2026-11-01")).code).toBe(0);
    const versions = async () => (await su("select string_agg(cro_number || ':' || ctid::text || ':' || xmin::text, ',' order by cro_number) v from cro_company")).rows[0].v;
    const before = await versions();
    const fetcher = db.pool("app_fetcher");
    const writes: number[] = [];
    const counting = { query: async (sql: string, p?: unknown[]) => { const r = await fetcher.query(sql, p); if (/^(insert|update|delete)/.test(sql)) writes.push(r.rowCount ?? 0); return r; } };
    const stats = { read: 0, kept: 0, skipped: 0, repeated: 0 };
    const r = await importCro(counting as never, croRows(csvRecords([croCsv(many)]), stats), "2026-11-08", stats);
    expect(r).toMatchObject({ kept: 3000, written: 0, marked: 0, deleted: 0 });
    expect(writes.reduce((a, b) => a + b, 0)).toBe(0); // at most 1% asked (audit DB-3); none measured
    expect(await versions()).toBe(before);
    // a company dropped for one week and back the next is written twice: gone, then live with that day's date
    await runCro(croZip(many.slice(1)), "2026-11-15");
    expect(await cro("870000")).toMatchObject({ status: "Not in latest file", last_seen_on: new Date("2026-11-15T00:00:00") });
    await runCro(croZip(many), "2026-11-22");
    expect(await cro("870000")).toMatchObject({ status: "Normal", last_seen_on: new Date("2026-11-22T00:00:00") });
  });
  it("a repeated number in the file keeps the row with the later status date", async () => {
    await runCro(croZip(Array.from({ length: 3 }, (_, i): CroLine => ({ num: String(821000 + i), name: `Before ${i} Ltd` }))), "2026-11-08");
    const r = await runCro(croZip([{ num: "820001", name: "Old Row", statusDate: "2024-01-10" }, { num: "820002", name: "Filler Ltd" }, { num: "821000", name: "Before 0 Ltd" }, { num: "821001", name: "Before 1 Ltd" }, { num: "820001", name: "New Row", statusDate: "2026-04-27" }, { num: "820001", name: "Late Tie", statusDate: "2026-04-27" }]), "2026-11-09");
    expect(r.out).toMatch(/2 repeated/);
    expect((await cro("820001")).name).toBe("New Row");
  });
  it("refuses a file with under 80% of the companies we hold, and marks nothing", async () => {
    const many = Array.from({ length: 20 }, (_, i): CroLine => ({ num: String(830000 + i), name: `Bulk ${i} Ltd` }));
    await runCro(croZip(many), "2026-11-10");
    const before = (await su("select count(*)::int n from cro_company where status = 'Not in latest file'")).rows[0].n;
    const r = await runCro(croZip(many.slice(0, 2)), "2026-11-17");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refused/);
    expect((await su("select count(*)::int n from cro_company where status = 'Not in latest file'")).rows[0].n).toBe(before);
  });
  it("finds the file through package_show, with a fake CRO portal, and the app_fetcher login", async () => {
    const zip = croZip([{ num: "840001", name: "Portal Fetched Ltd" }]);
    const fake = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("package_show")) return new Response(JSON.stringify({ result: { resources: [{ url: "https://opendata.cro.ie/dl/companies.csv.zip" }] } }));
      if (u === "https://opendata.cro.ie/dl/companies.csv.zip") return new Response(new Uint8Array(zip));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const out: string[] = [];
    expect(await main(["cro"], fetcherEnv(), (l) => void out.push(l), { fetch: fake, today: () => "2026-11-12" })).toBe(0);
    expect((await cro("840001")).name).toBe("Portal Fetched Ltd");
  });

  describe("hostile files", () => {
    const rows = async () => (await su("select count(*)::int n from cro_company")).rows[0].n;
    it("a refused zip (many files, a lying size, no csv) writes nothing and exits 1", async () => {
      const n = await rows();
      for (const bad of [
        makeZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.csv`, data: "x" }))),
        makeZip([{ name: "companies.csv", data: croCsv([{ num: "850001", name: "Liar Ltd" }]).repeat(2000), declaredSize: 100 }]),
        makeZip([{ name: "x.txt", data: "no" }]),
        Buffer.from("not a zip"),
      ]) expect((await runCro(bad, "2026-11-12")).code).toBe(1);
      expect(await rows()).toBe(n);
      expect(await cro("850001")).toBeUndefined();
    });
    it("huge fields, broken quoting, odd characters and SQL-looking names neither crash nor write junk", async () => {
      const csv = [CRO_HEADER, croLine({ num: "860001", name: "Robert'); DROP TABLE cro_company;-- Ltd" }), croLine({ num: "860002", name: "x".repeat(50_000) }), croLine({ num: "86\u00003", name: "Nul Ltd" }),
        croLine({ num: "860004", name: "Nul\u0000 Name\u0007 Ltd" }), croLine({ num: "'; drop table cro_company;--", name: "Bad Number Ltd" }), croLine({ num: "860005", name: "Fine Ltd" }),
        `860006,"unterminated quote ${"y".repeat(20_000)}`].join("\n");
      const r = await runCro(makeZip([{ name: "companies.csv", data: csv }]), "2026-11-12");
      expect(r.code).toBe(0);
      expect((await cro("860001")).name).toBe("Robert'); DROP TABLE cro_company;-- Ltd");
      expect(await cro("860002")).toBeUndefined();
      expect((await cro("860004")).name).toBe("Nul Name Ltd");
      expect(await cro("860005")).toBeDefined();
      expect((await su("select count(*)::int n from cro_company where cro_number !~ '^[0-9]+$'")).rows[0].n).toBe(0);
      expect((await su("select count(*)::int n from cro_company where length(name) > 300")).rows[0].n).toBe(0);
    });
    it("a file with a missing column is refused", async () => {
      const r = await runCro(makeZip([{ name: "companies.csv", data: "company_num,company_name\n1,A\n" }]), "2026-11-12");
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/no column/);
    });
  });
});

// ===== the WRC import =====
describe("WRC import (as app_admin)", () => {
  const L = (n: number, county = "Dublin"): WrcLine => ({ name: `Wrc Test Agency ${n} Limited`, trading: n % 2 ? `Trade ${n}` : undefined, address: `${n} Example Road`, licence: `EA${9000 + n}`, county });
  const list = (n: number) => parseWrc(wrcBbox(Array.from({ length: n }, (_, i) => L(i + 1))));
  const q = (n: number) => su("select * from wrc_licence where licence_number = $1", [`EA${9000 + n}`]).then((r) => r.rows[0]);
  it("imports, keeps first_seen_on, moves last_seen_on, counts missed lists and flags a licence missing twice in a row, without removing it", async () => {
    await su("delete from wrc_licence");
    const a = db.pool("app_admin");
    const r1 = await importWrc(a, list(40), "2026-11-01", "etag1");
    expect(r1).toMatchObject({ rows: 40, before: 0, lapsed: [] });
    const r2 = await importWrc(a, list(39), "2026-11-08", "etag2");
    expect(r2.lapsed).toEqual([]);
    expect(await q(40)).toMatchObject({ missed_imports: 1 });
    expect(await q(1)).toMatchObject({ first_seen_on: new Date("2026-11-01T00:00:00"), last_seen_on: new Date("2026-11-08T00:00:00"), missed_imports: 0, county: "Dublin" });
    const r3 = await importWrc(a, list(39), "2026-11-15", "etag3");
    expect(r3.lapsed).toEqual(["EA9040"]);
    expect(await q(40)).toMatchObject({ missed_imports: 2 }); // still there
    await importWrc(a, list(40), "2026-11-22", "etag4"); // back on the list
    expect(await q(40)).toMatchObject({ missed_imports: 0 });
    expect((await su("select validator from register_import where source = 'wrc'")).rows[0].validator).toBe("etag4");
  });
  it("refuses, writing nothing, an empty list, a list 10% off the last one, and a layout with many unreadable rows; --accept-count-change lets the size through", async () => {
    const a = db.pool("app_admin");
    const state = async () => JSON.stringify((await su("select licence_number, last_seen_on, missed_imports from wrc_licence order by id")).rows);
    const was = await state();
    await expect(importWrc(a, { rows: [], duplicates: [], badNumbers: 0 }, "2026-12-01", null)).rejects.toThrow(/no agency rows/);
    await expect(importWrc(a, list(30), "2026-12-01", null)).rejects.toThrow(/more than 5% apart/);
    await expect(importWrc(a, { ...list(40), badNumbers: 5 }, "2026-12-01", null)).rejects.toThrow(/layout may have changed/);
    expect(await state()).toBe(was);
    await expect(importWrc(a, list(30), "2026-12-01", null, { acceptCountChange: true })).resolves.toMatchObject({ rows: 30 });
  });
  it("each import flags again the adverts still open against the new list, in its transaction (0047); gone adverts keep their flag", async () => {
    const a = db.pool("app_admin");
    const src = (await su("insert into job_source(kind, board) values ('greenhouse', 'wrc-reflag') returning id")).rows[0].id;
    const advert = async (ext: string, employer: string) => (await su("insert into fetched_advert(job_source_id, external_id, employer_name, result) values ($1, $2, $3, 'rejected') returning id", [src, ext, employer])).rows[0].id;
    const flags = async () => (await su("select external_id, wrc_agency from fetched_advert where job_source_id = $1 order by external_id", [src])).rows.map((r) => [r.external_id, r.wrc_agency]);
    const base = list(30).rows;
    await importWrc(a, { rows: base, duplicates: [], badNumbers: 0 }, "2026-12-02", null, { acceptCountChange: true });
    await advert("a-open", "Late Fake Recruiters Ltd");
    await advert("b-gone", "Late Fake Recruiters Ltd");
    await advert("c-dropped", "Trade 1"); // EA9001's trading name now
    await advert("d-plain", "Fake Bakery Ltd");
    await su("update fetched_advert set gone_at = now() where job_source_id = $1 and external_id = 'b-gone'", [src]);
    expect(await flags()).toEqual([["a-open", false], ["b-gone", false], ["c-dropped", true], ["d-plain", false]]);
    const next = [...base.map((r) => (r.licenceNumber === "EA9001" ? { ...r, tradingName: "Renamed Fake Trade" } : r)),
      { licenceNumber: "EA9999", agencyName: "LATE FAKE RECRUITERS LIMITED", tradingName: "Late Fake Recruiters Ltd", address: null, county: null }];
    // a refused import changes no flag (same transaction)
    await expect(importWrc(a, { rows: next.slice(0, 5), duplicates: [], badNumbers: 0 }, "2026-12-03", null)).rejects.toThrow(/more than 5% apart/);
    expect(await flags()).toEqual([["a-open", false], ["b-gone", false], ["c-dropped", true], ["d-plain", false]]);
    const r = await importWrc(a, { rows: next, duplicates: [], badNumbers: 0 }, "2026-12-03", null);
    expect(await flags()).toEqual([["a-open", true], ["b-gone", false], ["c-dropped", false], ["d-plain", false]]);
    expect(r.reflagged).toBe(2);
    expect((await importWrc(a, { rows: next, duplicates: [], badNumbers: 0 }, "2026-12-04", null)).reflagged).toBe(0); // nothing left to change
  });
  it.skipIf(!hasPdftotext)("the command fetches the alias, imports, and does nothing when ETag and Last-Modified are unchanged (unless --force)", async () => {
    const pdf = wrcPdf([L(31, "Cork"), L(32, "Cork")]);
    let hits = 0;
    const fake = (async () => (hits++, new Response(new Uint8Array(pdf), { headers: { etag: '"abc"', "last-modified": "Thu, 05 Nov 2026 15:50:50 GMT" } }))) as typeof fetch;
    await su("delete from wrc_licence");
    const out: string[] = [];
    const log = (l: string) => void out.push(l);
    expect(await main(["wrc"], adminEnv(), log, { fetch: fake, today: () => "2027-01-05" })).toBe(0);
    expect((await q(31)).county).toBe("Cork");
    expect(out.join("\n")).toMatch(/2 agencies/);
    out.length = 0;
    await su("delete from wrc_licence");
    expect(await main(["wrc"], adminEnv(), log, { fetch: fake, today: () => "2027-01-12" })).toBe(0);
    expect(out.join("\n")).toMatch(/has not changed/);
    expect(await q(31)).toBeUndefined();
    expect(await main(["wrc", "--force", "--accept-count-change"], adminEnv(), log, { fetch: fake, today: () => "2027-01-12" })).toBe(0);
    expect(await q(31)).toBeDefined();
    expect(hits).toBe(3);
  });
});

// ===== who may do what =====
describe("security", () => {
  const denied = async (role: Parameters<TestDb["pool"]>[0], sql: string, params: unknown[] = []) => {
    await expect(db.pool(role).query(sql, params)).rejects.toMatchObject({ code: "42501" });
  };
  it("each import login writes only its own register", async () => {
    await denied("app_fetcher", "insert into wrc_licence(licence_number) values ('EA1')");
    await denied("app_fetcher", "select 1 from wrc_licence");
    await denied("app_admin", "insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) values ('1','a','a','Normal',current_date)");
    await denied("app_admin", "delete from cro_company");
    await db.pool("app_fetcher").query("insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) values ('870001','a','a','Normal',current_date) on conflict do nothing");
    await db.pool("app_admin").query("insert into wrc_licence(licence_number, agency_name) values ('EA870001','a') on conflict do nothing");
  });
  it("the portal and the candidate site cannot write either register, and cannot read the WRC list at all", async () => {
    for (const role of ["app_portal", "app_candidate"] as const) {
      await denied(role, "insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) values ('2','a','a','Normal',current_date)");
      await denied(role, "update cro_company set status = 'x'");
      await denied(role, "delete from wrc_licence");
      await denied(role, "select * from wrc_licence");
      await denied(role, "select * from register_import");
      await denied(role, "insert into register_import(source, imported_on, row_count) values ('cro', current_date, 1)");
    }
    await db.pool("app_portal").query("select count(*) from cro_company"); // the portal still reads the CRO register
    await denied("app_candidate", "select count(*) from cro_company");
    await denied("app_portal", "select private.normalise_company_name('x')");
  });
  it("the sign-up answer and the review item carry no WRC name or address", async () => {
    await su("insert into wrc_licence(licence_number, agency_name, trading_name, address) values ('EA7100', 'Secret Agency Name', 'Secret Trading', '99 Secret Street') on conflict do nothing");
    const r = (await db.pool("app_portal").query("select private.register_organisation($1, 'agency', 'Someone', null, 'EA7100') r", [await F.portal()])).rows[0].r;
    const item = (await su("select detail from review_item where organisation_id = $1", [r.organisation_id])).rows[0].detail;
    expect(JSON.stringify([r, item])).not.toMatch(/Secret/);
  });
  it("the import logins cannot read or write anything else through the new table", async () => {
    await db.pool("app_fetcher").query("insert into register_import(source, imported_on, row_count) values ('cro', current_date, 5) on conflict (source) do update set row_count = 5");
    await expect(db.pool("app_admin").query("insert into register_import(source, imported_on, row_count) values ('other', current_date, 1)")).rejects.toThrow(/check/);
  });
});
