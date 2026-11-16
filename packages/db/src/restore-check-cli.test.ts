// No database: the manifest rules and the comparisons. The real restore is packages/db/test/backup.test.ts.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORMAT, type Manifest } from "./backup-cli.ts";
import { ageProblems, countProblems, fileProblems, main, migrationProblems, parseManifest, repoMigrationHashes, runRestoreCheck } from "./restore-check-cli.ts";

const H = (c: string) => c.repeat(64);
const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  format: FORMAT, createdAt: "2026-11-16T12:00:00.000Z", serverVersion: "17.11", pgDumpVersion: "pg_dump (PostgreSQL) 17.11", schemas: ["public", "private", "drizzle"],
  tables: [{ name: "public.job", rows: 3, data: true }, { name: "public.cro_company", rows: 90000, data: false }], migrations: [H("a"), H("b")],
  dump: { file: "db-20261116T1200Z.dump", bytes: 100, sha256: H("c") }, ...over,
});
const NOW = new Date("2026-11-16T20:00:00Z");

describe("parseManifest", () => {
  it("reads a good one", () => expect(parseManifest(JSON.stringify(manifest()))).toEqual(manifest()));
  it.each([
    ["not JSON", "{nope", /not valid JSON/],
    ["JSON null", "null", /not an object/],
    ["another format version", JSON.stringify(manifest({ format: 2 })), /format is 2/],
    ["no format", JSON.stringify({ ...manifest(), format: undefined }), /format is undefined/],
    ["a bad time", JSON.stringify(manifest({ createdAt: "yesterday" })), /createdAt/],
    ["a negative count", JSON.stringify(manifest({ tables: [{ name: "public.job", rows: -1, data: true }] })), /tables are malformed/],
    ["a fractional count", JSON.stringify(manifest({ tables: [{ name: "public.job", rows: 1.5, data: true }] })), /tables are malformed/],
    ["a short hash", JSON.stringify(manifest({ migrations: ["abc"] })), /migrations are malformed/],
    ["a dump file name that climbs out", JSON.stringify(manifest({ dump: { file: "../../etc/passwd", bytes: 1, sha256: H("c") } })), /dump entry/],
    ["a dump file name with a folder", JSON.stringify(manifest({ dump: { file: "x/db-20261116T1200Z.dump", bytes: 1, sha256: H("c") } })), /dump entry/],
  ])("refuses %s", (_n, text, why) => expect(() => parseManifest(text)).toThrow(why));
});

describe("age", () => {
  it("passes under 48 hours, fails at 48, fails in the future, and can be turned off", () => {
    expect(ageProblems(manifest(), NOW, 48)).toEqual([]);
    expect(ageProblems(manifest({ createdAt: "2026-11-14T20:00:01Z" }), NOW, 48)).toEqual([]);
    expect(ageProblems(manifest({ createdAt: "2026-11-14T20:00:00Z" }), NOW, 48)[0]).toMatch(/48.0 hours old, the limit is 48/);
    expect(ageProblems(manifest({ createdAt: "2026-11-17T20:00:00Z" }), NOW, 48)).toHaveLength(1);
    expect(ageProblems(manifest({ createdAt: "2020-01-01T00:00:00Z" }), NOW, null)).toEqual([]);
  });
});

describe("dump file", () => {
  it("matches name, size and hash, or says which differs", () => {
    expect(fileProblems(manifest(), "db-20261116T1200Z.dump", 100, H("c"))).toEqual([]);
    expect(fileProblems(manifest(), "db-20261116T1200Z.dump", 101, H("c"))).toEqual(["size 101, the manifest says 100"]);
    expect(fileProblems(manifest(), "db-20261116T1200Z.dump", 100, H("d"))).toEqual(["SHA-256 differs from the manifest"]);
    expect(fileProblems(manifest(), "other.dump", 100, H("c"))[0]).toMatch(/is named "other.dump"/);
  });
});

describe("row counts", () => {
  const restored = [{ name: "public.job", rows: 3 }, { name: "public.cro_company", rows: 0 }];
  it("equal: nothing wrong, and cro_company is expected empty", () => expect(countProblems(manifest(), restored)).toEqual([]));
  it("one off by one is named", () => expect(countProblems(manifest(), [{ name: "public.job", rows: 4 }, restored[1]!])).toEqual(['table "public.job": 4 rows, the manifest says 3']));
  it("cro_company with rows is wrong", () => expect(countProblems(manifest(), [restored[0]!, { name: "public.cro_company", rows: 1 }])[0]).toMatch(/cro_company": 1 rows, the manifest says 0/));
  it("a missing table and an extra table are both named", () => {
    expect(countProblems(manifest(), [restored[1]!])).toEqual(['table "public.job" is missing after the restore']);
    expect(countProblems(manifest(), [...restored, { name: "public.new", rows: 0 }])).toEqual(['table "public.new" is not in the manifest']);
  });
  it("a manifest that claims cro_company data was included is refused", () => {
    const m = manifest({ tables: [{ name: "public.cro_company", rows: 5, data: true }] });
    expect(countProblems(m, [{ name: "public.cro_company", rows: 5 }])[0]).toMatch(/must be marked as data not included/);
  });
  it("a hostile table name is only compared and printed quoted, never run", () => {
    const m = manifest({ tables: [{ name: "x; drop table job", rows: 1, data: true }] });
    expect(countProblems(m, [])).toEqual(['table "x; drop table job" is missing after the restore']);
  });
});

describe("migrations", () => {
  const repo = [H("a"), H("b"), H("c")];
  it("the backup may be behind the repo, not ahead and not different", () => {
    expect(migrationProblems(manifest(), [H("a"), H("b")], repo)).toEqual([]);
    expect(migrationProblems(manifest({ migrations: [H("a"), H("x")] }), [H("a"), H("x")], repo)).toEqual(["migration 1 differs from the repo's file"]);
    expect(migrationProblems(manifest({ migrations: [H("a"), H("b")] }), [H("a"), H("b")], [H("a")])[0]).toMatch(/2 migrations, the repo only 1/);
  });
  it("what was restored must equal the manifest", () => expect(migrationProblems(manifest(), [H("a")], repo)).toHaveLength(1));
  it("the repo's list is every file in the journal, as SHA-256", () => {
    const h = repoMigrationHashes();
    expect(h.length).toBeGreaterThanOrEqual(27);
    expect(h.every((x) => /^[0-9a-f]{64}$/.test(x))).toBe(true);
  });
});

describe("runRestoreCheck stops before touching any server", () => {
  const files = async (text: string) => { const d = await mkdtemp(join(tmpdir(), "rc-")); await writeFile(join(d, "m.json"), text); return { manifest: join(d, "m.json"), dump: join(d, "db-20261116T1200Z.dump") }; };
  const run = async (f: { manifest: string; dump: string }, extra = {}) => {
    const lines: string[] = [];
    // The address is unreachable and the network guard would refuse it: reaching it at all would fail the test.
    const ok = await runRestoreCheck({ adminUrl: "postgres://x:y@db.example.test/postgres", env: {}, log: (l) => lines.push(l), now: NOW, ...f, ...extra });
    return { ok, lines };
  };
  it("a manifest that is not JSON", async () => expect(await run(await files("{"))).toMatchObject({ ok: false, lines: ["FAIL manifest: the manifest is not valid JSON"] }));
  it("an old manifest, unless the age rule is off", async () => {
    const f = await files(JSON.stringify(manifest({ createdAt: "2026-11-01T00:00:00Z" })));
    expect((await run(f)).lines.at(-1)).toMatch(/^FAIL age: .*hours old/);
    expect((await run(f, { maxAgeHours: null })).lines.at(-1)).toMatch(/^FAIL dump file: cannot read it/); // got past the age check
  });
  it("a dump of another name or with other bytes", async () => {
    const f = await files(JSON.stringify(manifest()));
    await writeFile(f.dump, "not the dump");
    expect((await run(f)).lines.at(-1)).toMatch(/^FAIL dump file: size 12, the manifest says 100; SHA-256 differs/);
    expect((await run({ ...f, dump: join(f.dump, "..", "..", "x.dump") })).lines.at(-1)).toMatch(/^FAIL dump file: cannot read it/);
  });
});

describe("main", () => {
  it("needs both files and the address", async () => {
    const lines: string[] = [];
    expect(await main([], {}, (l) => lines.push(l))).toBe(2);
    expect(await main(["--dump", "a", "--manifest", "b"], {}, (l) => lines.push(l))).toBe(2);
    expect(await main(["--dump", "a", "--manifest", "b", "--wat"], { RESTORE_ADMIN_URL: "x" }, (l) => lines.push(l))).toBe(2);
    expect(lines[1]).toMatch(/RESTORE_ADMIN_URL is not set/);
  });
});
