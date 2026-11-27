// Integration (real test database) for the database size check of audit DB-4: it runs as the read-only app_backup login with no new privilege,
// reads pg_database_size and the 10 largest tables from the catalog, goes red over the limit, and stays under 50 ms.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, SIZE_SQL, sizeCheck } from "../src/scheduled-checks-cli";
import { createTestDb, urlFor, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());
const run = async (limitMb?: number, role = "app_backup") => {
  const out: string[] = [];
  const code = await main(["size"], { SIZE_BACKUP_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" }, (l) => out.push(l), undefined, limitMb);
  return { code, out };
};

describe("database size check (scheduled-checks-cli.ts size)", () => {
  it("as app_backup: the real database size and the 10 largest tables, green under the limit", async () => {
    const real = Number((await db.query("postgres", "select pg_database_size(current_database()) n")).rows[0].n);
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`database size: ${(real / 1024 / 1024).toFixed(1)} MB, limit 350 MB (free plan cap 500 MB)`);
    expect(r.out.length).toBe(11);
    expect(r.out.slice(1).every((l) => /^ +\d+\.\d MB {2}[a-z_]+\.[a-z_0-9]+$/.test(l))).toBe(true);
  });
  it("over the limit: exit 1 (a red run) with the top tables listed", async () => {
    const r = await run(1);
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/limit 1 MB \(free plan cap 500 MB\): OVER THE LIMIT/);
    expect(r.out.length).toBe(11);
  });
  it("security: app_backup holds no privilege beyond its migration's (no superuser, no grant added), and still reads the sizes", async () => {
    const b = (await db.query("postgres", "select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, array(select r.rolname::text from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = 'app_backup'::regrole order by 1) memberof from pg_roles where rolname = 'app_backup'")).rows[0];
    expect(b).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, memberof: ["pg_read_all_data"] });
    expect((await db.query("app_backup", SIZE_SQL)).rows[0].top.length).toBe(10);
    // read only: the same login still cannot write
    await expect(db.query("app_backup", "create table size_probe(x int)")).rejects.toThrow(/permission denied/);
  });
  it("a login that cannot connect is a refused run (exit 1), never green", async () => {
    const r = await run(undefined, "no_such_role");
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^refused: /);
  });
  it("performance: catalog only, under 50 ms (median of 5 on the warm connection)", async () => {
    const c = db.pool("app_backup");
    await sizeCheck(c, () => {});
    const times: number[] = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); await sizeCheck(c, () => {}); times.push(performance.now() - t); }
    expect(times.sort((a, b) => a - b)[2]!).toBeLessThan(50);
  });
});
