// The pulled Drizzle schema (src/schema) still matches the migrations: the same tables and views, with the same columns.
// If this fails after a migration change, pull the schema again (steps at the top of src/schema/schema.ts).
import { getTableColumns, getTableName, getViewName, is } from "drizzle-orm";
import { getViewConfig, PgTable, PgView } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as schema from "../src/schema";
import { createTestDb, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.drop());

test("every table and view in public has the same columns in the Drizzle schema", async () => {
  const fromSchema: Record<string, string[]> = {};
  for (const x of Object.values(schema)) {
    if (is(x, PgTable)) fromSchema[getTableName(x)] = Object.values(getTableColumns(x)).map((c) => c.name).sort();
    else if (is(x, PgView)) fromSchema[getViewName(x)] = Object.values(getViewConfig(x).selectedFields).map((c) => (c as { name: string }).name).sort();
  }
  const { rows } = await db.pool("postgres").query<{ t: string; cols: string[] }>(
    "select table_name t, array_agg(column_name::text order by column_name::text) cols from information_schema.columns where table_schema = 'public' group by table_name",
  );
  const fromDb = Object.fromEntries(rows.map((r) => [r.t, r.cols.sort()]));
  expect(fromSchema).toEqual(fromDb);
});
