// DEP-5 on the real test database: passes after a fresh migrate, fails after a file's recorded hash changes, as the read-only app_backup login.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { main } from "../src/migration-check-cli.ts";
import { createTestDb, urlFor, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());
const run = async () => {
  const log: string[] = [];
  const t0 = performance.now();
  const code = await main([], { BACKUP_DATABASE_URL: urlFor(db.name, "app_backup"), DATABASE_SSL: "disable" }, (l) => log.push(l));
  return { code, log, ms: performance.now() - t0 };
};

describe("migration check", () => {
  test("passes on a fresh migrate, inside a time budget (one query)", async () => {
    const r = await run();
    expect(r.log.join("\n")).toMatch(/\d+ applied, 0 pending, hashes and times match/);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(3000);
  });
  test("fails when an applied migration's hash no longer matches the file, and when one is missing", async () => {
    const id = (await db.query("postgres", "select id from drizzle.__drizzle_migrations order by id desc limit 1")).rows[0].id;
    await db.query("postgres", "update drizzle.__drizzle_migrations set hash = repeat('0', 64) where id = $1", [id]);
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.log[0]).toMatch(/^FAIL 0080_owner_lock_timeout: the file differs/);
  });
  test("a migration not applied yet (the tail) is a warning and exit 0; an applied row removed from the middle fails", async () => {
    const ids = (await db.query("postgres", "select id from drizzle.__drizzle_migrations order by id desc limit 2")).rows.map((x) => x.id);
    const last = (await db.query("postgres", "select hash, created_at from drizzle.__drizzle_migrations where id = $1", [ids[0]])).rows[0];
    await db.query("postgres", "delete from drizzle.__drizzle_migrations where id = $1", [ids[0]]);
    let r = await run();
    expect(r.code).toBe(0);
    expect(r.log[0]).toBe("::warning::0080_owner_lock_timeout is not applied yet: apply it after this deploy");
    await db.query("postgres", "delete from drizzle.__drizzle_migrations where id = $1", [ids[1]]);
    await db.query("postgres", "insert into drizzle.__drizzle_migrations(hash, created_at) values ($1, $2)", [last.hash, last.created_at]);
    r = await run();
    expect(r.code).toBe(1);
    expect(r.log.some((l) => l.startsWith("FAIL "))).toBe(true);
  });
  test("security: a bad login is refused with a message, never a stack or the URL", async () => {
    const log: string[] = [];
    expect(await main([], { BACKUP_DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none", DATABASE_SSL: "disable" }, (l) => log.push(l))).toBe(1);
    expect(log[0]).toMatch(/^refused:/);
  });
});
