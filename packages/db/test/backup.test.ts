// The backup and the restore check on the real test database: back up a seeded copy as app_backup, restore it into a new database on the same
// server, and the check passes; a changed count fails; the snapshot holds while another connection writes. pg_dump and pg_restore run inside the
// test container (backup-helpers.ts). Fake data only, no network beyond the local container.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { runBackup } from "../src/backup-cli";
import { repoMigrationHashes, runRestoreCheck } from "../src/restore-check-cli";
import { createTestDb, urlFor, testPassword, type TestDb } from "./db";
import { seed, tempDir, toolEnv } from "./backup-helpers";

// A dump and a restore take about 1 s alone here; the first one on GitHub's runner, beside the other test files, passed 5 s (16 Nov, PR #56).
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
});
afterAll(() => db.drop());

const backupUrl = () => { const u = new URL(urlFor(db.name, "app_backup")); u.password = testPassword(); return u.toString(); };
const adminUrl = () => urlFor("postgres");
const backup = async (afterSnapshot?: () => Promise<void>) => runBackup({ url: backupUrl(), env: toolEnv(), out: await tempDir(), afterSnapshot });
const check = async (r: { dumpPath: string; manifestPath: string }, extra = {}) => {
  const lines: string[] = [];
  const ok = await runRestoreCheck({ adminUrl: adminUrl(), dump: r.dumpPath, manifest: r.manifestPath, env: toolEnv(), log: (l) => lines.push(l), ...extra });
  return { ok, lines };
};
const rowsOf = (m: { tables: { name: string; rows: number }[] }, name: string) => m.tables.find((t) => t.name === name)?.rows;

describe("backup and restore check", () => {
  test("backs up as app_backup, restores into a new database, and the check passes", async () => {
    const r = await backup();
    const m = r.manifest;
    expect(m.dump.bytes).toBeGreaterThan(1000);
    expect(m.migrations).toEqual(repoMigrationHashes()); // drizzle's recorded hashes are the SHA-256 of the repo's files
    expect(rowsOf(m, "public.candidate_user")).toBe(5);
    expect(m.tables.find((t) => t.name === "public.cro_company")).toMatchObject({ rows: 40, data: false });
    expect(m.tables.map((t) => t.name.split(".")[0])).toEqual(expect.arrayContaining(["public", "drizzle"])); // private holds functions only
    const c = await check(r);
    expect(c.lines.join("\n")).toContain("restore check passed");
    expect(c.ok).toBe(true);
    const dbs = await db.query("postgres", "select count(*)::int n from pg_database where datname like 'restore\\_check\\_%'");
    expect(dbs.rows[0].n).toBe(0); // the restored database is dropped
  });

  test("one count changed in the manifest fails the check", async () => {
    const r = await backup();
    const m = JSON.parse(await readFile(r.manifestPath, "utf8"));
    m.tables.find((t: { name: string }) => t.name === "public.candidate_user").rows += 1;
    await writeFile(r.manifestPath, JSON.stringify(m));
    const c = await check(r);
    expect(c.ok).toBe(false);
    expect(c.lines.at(-1)).toMatch(/FAIL row counts: table "public.candidate_user": 5 rows, the manifest says 6/);
  });

  test("a changed byte in the dump fails before anything is restored", async () => {
    const r = await backup();
    const bytes = await readFile(r.dumpPath);
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
    await writeFile(r.dumpPath, bytes);
    const c = await check(r);
    expect(c.ok).toBe(false);
    expect(c.lines.at(-1)).toMatch(/FAIL dump file: .*SHA-256 differs/);
    expect(c.lines.join("\n")).not.toContain("ok   restore");
  });

  test("rows written by another connection during the dump are in neither the counts nor the dump", async () => {
    const before = (await db.query("postgres", "select count(*)::int n from candidate_user")).rows[0].n as number;
    const r = await backup(async () => {
      await db.query("postgres", "insert into candidate_user(id,name,email,email_verified,updated_at) values ('late','Fake','late@example.test',true,now())");
      await db.query("postgres", "delete from wrc_licence");
    });
    expect(rowsOf(r.manifest, "public.candidate_user")).toBe(before);
    expect(rowsOf(r.manifest, "public.wrc_licence")).toBe(1); // the delete is not seen either
    const c = await check(r);
    expect(c.lines.join("\n")).toContain("restore check passed");
    expect((await db.query("postgres", "select count(*)::int n from candidate_user")).rows[0].n).toBe(before + 1);
  });

  test("a failed dump leaves no dump file and an unreachable server prints no address", async () => {
    const out = await tempDir();
    await expect(runBackup({ url: backupUrl(), env: { ...toolEnv(), PG_TOOLS_PREFIX: "false" }, out })).rejects.toThrow();
    expect(await readdir(out)).toEqual([]);
  });
});
