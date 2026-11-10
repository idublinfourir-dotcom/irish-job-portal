// Guards every trigger, CHECK rule, unique rule and app-role right in schema `public` with one comparison against
// rules-snapshot.txt. Dropping or changing any of them fails this test unless the txt file changes in the same pull request,
// where a reviewer sees it. It proves a rule is still there as written, not that it does the right thing (see mutation-gaps.test.ts).
// To accept a change on purpose: npx vitest run --project db packages/db/test/rules-snapshot.test.ts -u
// then read the diff of rules-snapshot.txt before committing.
// The mutation script leaves this file out of its run (it would notice every removal), see mutation/run.mjs.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

const APP_ROLES = ["app_candidate", "app_portal", "app_admin", "app_fetcher"];
const TABLE_RIGHTS = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
const COLUMN_RIGHTS = ["select", "insert", "update", "references"];
// Performance budget for the catalog read: the read took about 33 ms when measured, the limit is about five times that.
const BUDGET_MS = 200;
const fold = (s: string) => s.replace(/\s+/g, " ").trim();

const triggers = `select 'trigger ' || t.tgname || ' on ' || c.relname || ': ' || pg_get_triggerdef(t.oid) as line
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname = 'public'`;
const checks = `select 'check ' || k.conname || ' on ' || c.relname || ': ' || pg_get_constraintdef(k.oid) as line
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where k.contype = 'c' and n.nspname = 'public'`;
const uniques = `select 'unique ' || pg_get_indexdef(i.indexrelid) as line
  from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
  where i.indisunique and not i.indisprimary and n.nspname = 'public'`;
// One line per role and table or view. Column rights are listed only where the table-level right is not held.
const rights = `select 'rights ' || r.rolname || ' on ' || c.relname || ': table[' ||
    coalesce((select string_agg(p, ',' order by p) from unnest($1::text[]) p where has_table_privilege(r.oid, c.oid, p)), '') || '] columns[' ||
    coalesce((select string_agg(p || '(' || cols || ')', ' ' order by p) from (
      select p, string_agg(a.attname, ',' order by a.attname) as cols
      from unnest($2::text[]) p, pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        and not has_table_privilege(r.oid, c.oid, p) and has_column_privilege(r.oid, c.oid, a.attnum, p)
      group by p) x), '') || ']' as line
  from pg_roles r, pg_class c join pg_namespace n on n.oid = c.relnamespace
  where r.rolname = any($3::text[]) and n.nspname = 'public' and c.relkind in ('r', 'v', 'p')`;

test("every trigger, CHECK rule, unique rule and app-role right matches rules-snapshot.txt", async () => {
  const t0 = performance.now();
  const lines: string[] = [];
  for (const sql of [triggers, checks, uniques])
    lines.push(...(await db.query("postgres", sql)).rows.map((r) => fold(r.line)));
  lines.push(...(await db.query("postgres", rights, [TABLE_RIGHTS, COLUMN_RIGHTS, APP_ROLES])).rows.map((r) => fold(r.line)));
  const ms = performance.now() - t0;
  expect(lines.length).toBeGreaterThan(500); // the read found the rules, not an empty catalog
  await expect(`${lines.sort().join("\n")}\n`).toMatchFileSnapshot("./rules-snapshot.txt");
  expect(ms).toBeLessThan(BUDGET_MS);
});