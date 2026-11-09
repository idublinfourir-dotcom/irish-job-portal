// Ported from schema-trial-3 41-harness.sql to 46-run.sh (test C3): retention and erasure, with fixtures in replica mode
// (CHECKs still run, triggers and foreign-key checks off), two drains as app_admin, then the trial's assertions.
// The SQL files in retention-sql/ are the trial's, unchanged except for the psql-only lines (\set, \timing, \echo, \gset), which psql() strips.
// The 50,000 candidate page sweep is not here (it becomes a CI page gate).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import pg from "pg";
import { createTestDb, urlFor } from "./db";

const sql = (f: string) => readFileSync(join(__dirname, "retention-sql", f), "utf8");
const db = await createTestDb();
afterAll(() => db.drop());

const as = async (role: string, text: string) => {
  const c = new pg.Client({ connectionString: urlFor(db.name, role) });
  await c.connect();
  try { return await c.query(text); } finally { await c.end(); }
};

// 44-reload.sh: harness, then both fixture files (each one query, as postgres)
for (const f of ["41-harness.sql", "42-fixtures-all.sql", "43-fixtures-2.sql"]) await as("postgres", sql(f));
const orphans = (await as("postgres", "select count(*)::int n from c3t.orphans()")).rows[0].n;

// 46-run.sh: two drains as app_admin, then the assertions
await as("postgres", "drop table if exists c3t.lastrun; create table c3t.lastrun(k text primary key, j jsonb); create view c3t.last as select j from c3t.lastrun where k='1'; create view c3t.last2 as select j from c3t.lastrun where k='2'; grant select, insert on c3t.lastrun to app_admin;");
await as("app_admin", "insert into c3t.lastrun select '1', c3t.drain(); insert into c3t.lastrun select '2', c3t.drain();");
const runs = (await as("postgres", "select k, j->>'stuck' stuck, j->>'ncalls' calls from c3t.lastrun order by k")).rows;
await as("postgres", sql("45-assert.sql"));
const results = (await as("postgres", "select grp, name, ok, detail from c3t.result order by n")).rows;
// 47-extra-a, b, c, run in that order after 45-assert as the trial ran them. psql-only lines are dropped. The test user
// postgres cannot SET ROLE, so each statement goes to a connection logged in as the role the file has "set"; a
// "set [local] role X" moves the pointer, "reset role" and "commit" move it back. Like the trial (ON_ERROR_STOP 0), an
// error does not stop the file; errors are kept in sqlErrors and checked by a test below.
const statements = (text: string) => text.replace(/^\\(set|timing|echo).*$/gm, "").replace(/ \\gset$/gm, ";")
  .match(/(?:--.*|\$\$[\s\S]*?\$\$|'(?:[^']|'')*'|[^;'$-]|-(?!-)|\$(?!\$))+;?/g)!.map((t) => t.replace(/^(\s*--.*\n)+/, "").trim()).filter((t) => t.replace(/--.*/g, "").trim() && t !== ";");
const sqlErrors: string[] = [];
async function runAsRoles(text: string) {
  const conns = new Map<string, pg.Client>();
  const on = async (role: string) => {
    if (!conns.has(role)) { const c = new pg.Client({ connectionString: urlFor(db.name, role) }); await c.connect(); conns.set(role, c); }
    return conns.get(role)!;
  };
  let role = "postgres", pending = false; // pending: a "begin" seen before the role switch
  for (const st of statements(text)) {
    const code = st.replace(/--.*/g, "").trim().replace(/;$/, "");
    const m = /^set (local )?role (\w+)$/i.exec(code);
    if (m) { role = m[2]!; if (pending) { await (await on(role)).query("begin"); pending = false; } continue; }
    if (/^reset role$/i.test(code)) { role = "postgres"; continue; }
    if (/^begin$/i.test(code)) { pending = true; continue; }
    if (pending) { await (await on(role)).query("begin"); pending = false; }
    try { await (await on(role)).query(code); } catch (e) { sqlErrors.push(`${role}: ${(e as Error).message} :: ${code.slice(0, 100)}`); await (await on(role)).query("rollback").catch(() => {}); }
    if (/^commit$/i.test(code)) role = "postgres";
  }
  for (const c of conns.values()) await c.end();
}
for (const f of ["47-extra-a.sql", "47-extra-b.sql", "47-extra-c.sql"]) await runAsRoles(sql(f));
const extra = (await as("postgres", "select grp, name, ok, detail from c3t.result order by n offset " + results.length)).rows;

it("fixtures leave no foreign key orphans (44-reload.sh)", () => expect(orphans).toBe(0));
it("run1 is not stuck (46-run.sh)", () => expect(runs[0].stuck).toBe("false"));
it("run2 is not stuck (46-run.sh)", () => expect(runs[1].stuck).toBe("false"));
for (const r of results) it(`[${r.grp}] ${r.name}`, () => expect(r.ok, r.detail).toBe(true));
for (const r of extra) it(`[${r.grp}] ${r.name} (47-extra)`, () => expect(r.ok, r.detail).toBe(true));
it("the 47-extra files ran without a SQL error", () => expect(sqlErrors).toEqual([]));
