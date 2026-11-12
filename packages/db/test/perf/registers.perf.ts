// Performance: the CRO register at full size. A fake file the size of the real one (829,000 rows, 343,000 kept, 194 MB unzipped) is imported by the
// command in its own process, twice. Budgets: time, peak memory of that process, table size and growth after the second import; and the sign-up
// reads (a name search on the full table and a number lookup) stay under a page budget. Fake data only.
import { execFile } from "node:child_process";
import { createWriteStream, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "../db";
import { CRO_HEADER, croLine, makeZip } from "../registers-helpers";
import { assertPageBudget, measurePages } from "./pages";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
export const IMPORT_SECONDS = 240;
export const IMPORT_MB = 600;
export const SIZE_MB = 250; // 343,000 rows with name, type, county and the trigram index; the free plan holds 500 MB in all
const ROWS = 829_081;
// Three different made-up words per company, so a name search behaves like a real register and not like 343,000 near-copies.
const word = (n: number) => (n % 1_000_003_007).toString(36).toUpperCase();
const KEPT_EVERY = 829_081 / 343_099;

let db: TestDb;
beforeAll(async () => void (db = await createTestDb()));
afterAll(() => db.drop());

const cli = fileURLToPath(new URL("../../src/registers-cli.ts", import.meta.url));
const run = promisify(execFile);
const mb = async () => Number((await db.pool("postgres").query("select pg_total_relation_size('cro_company') / 1048576.0 as mb")).rows[0].mb);

it("imports a full-size file within the time, memory and size budgets, and a second import does not bloat the table", async () => {
  // The csv is written to disk and zipped in memory: one 194 MB buffer, in this process only (the import runs in another).
  const dir = mkdtempSync(join(tmpdir(), "registers-perf-"));
  const csv = join(dir, "companies.csv");
  const out = createWriteStream(csv);
  out.write(CRO_HEADER + "\n");
  for (let i = 1; i <= ROWS; i++) {
    const kept = Math.floor(i / KEPT_EVERY) !== Math.floor((i - 1) / KEPT_EVERY);
    if (!out.write(croLine({ num: String(100000 + i), name: `${word(i * 2654435761)} ${word(i * 40503 + 17)} ${word(i * 97 + 5)} LIMITED`, status: kept ? "Normal " : "Dissolved" }) + "\n")) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
  const { readFileSync } = await import("node:fs");
  const zip = join(dir, "companies.csv.zip");
  writeFileSync(zip, makeZip([{ name: "companies.csv", data: readFileSync(csv) }]));

  const env = { ...process.env, FETCHER_DATABASE_URL: urlFor(db.name, "app_fetcher"), DATABASE_SSL: "disable" };
  const times: number[] = [];
  const logs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    logs.push((await run("node", [cli, "cro", "--file", zip], { env, maxBuffer: 10 ** 7 })).stdout);
    times.push((Date.now() - t) / 1000);
  }
  const rows = Number((await db.pool("postgres").query("select count(*) c from cro_company")).rows[0].c);
  const sizeAfterFirstMb = times.length && (await mb());
  const peak = Math.max(...logs.map((l) => Number(/peak memory (\d+) MB/.exec(l)![1])));
  console.log(`CRO import: ${rows} rows kept, table and index ${Math.round(sizeAfterFirstMb)} MB after two imports, import times ${times.map((t) => t.toFixed(0)).join(" s and ")} s, peak memory ${peak} MB`);
  expect(rows).toBeGreaterThan(343_000 * 0.99);
  expect(rows).toBeLessThan(343_200 * 1.01);
  for (const t of times) expect(t).toBeLessThan(IMPORT_SECONDS);
  expect(peak).toBeLessThan(IMPORT_MB);
  expect(sizeAfterFirstMb).toBeLessThan(SIZE_MB);

  // The sign-up reads on the full table, as app_portal.
  await db.pool("postgres").query("analyze cro_company");
  const c = await db.pool("app_portal").connect();
  try {
    const search = await measurePages(c, [{ text: "select cro_number, name, status, company_type, county from cro_company where normalised_name operator(extensions.%) $1 order by extensions.similarity(normalised_name, $1) desc limit 20", values: [`${word(777 * 2654435761).toLowerCase()} ${word(777 * 40503 + 17).toLowerCase()}`] }]);
    const lookup = await measurePages(c, [{ text: "select name, normalised_name, status from cro_company where cro_number = $1", values: ["100777"] }]);
    console.log(`name search ${search[0]!.pages} pages ${search[0]!.ms} ms (${search[0]!.scans}); number lookup ${lookup[0]!.pages} pages`);
    assertPageBudget("cro name search", search, 1000);
    assertPageBudget("cro number lookup", lookup, 20);
  } finally {
    c.release();
  }
});
