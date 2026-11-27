// No database: the retention loop with a fake run_retention. The real rules on real rows are packages/db/test/retention-cli.test.ts.
import { describe, expect, it } from "vitest";
import { memoryStore, s3Settings, s3Store } from "./file-store.ts";
import { drain, main, sweep, SWEEP_AGE_MS } from "./retention-cli.ts";

type S = { rule: string | null; target?: string; done: number; left: number; skipped?: unknown[]; storage_keys?: string[] };
const fake = (steps: S[]) => {
  let i = 0;
  const batches: unknown[] = [];
  const db = { query: async (_q: string, p: unknown[]) => (batches.push(p[0]), { rows: [{ r: { skipped: [], storage_keys: [], ...steps[Math.min(i++, steps.length - 1)] } }] }) } as never;
  return { db, calls: () => i, batches };
};
const run = async (steps: S[], batch?: number, cap?: number) => {
  const lines: string[] = [];
  const f = fake(steps);
  return { code: await drain(f.db, (l) => lines.push(l), batch, cap), lines, f };
};

describe("retention loop", () => {
  it("loops until rule is null, one line per call and a total", async () => {
    const r = await run([{ rule: "apply_click", done: 5, left: 2 }, { rule: "apply_click", done: 2, left: 0 }, { rule: "expired_login_rows", target: "candidate_session", done: 1, left: 0, skipped: [{}] }, { rule: null, done: 0, left: 0 }]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["apply_click: 5 done, 2 left, 0 skipped", "apply_click: 2 done, 0 left, 0 skipped", "expired_login_rows (candidate_session): 1 done, 0 left, 1 skipped", "retention: 8 rows handled"]);
    expect(r.f.calls()).toBe(4);
  });
  it("nothing due: one call, green", async () => {
    const r = await run([{ rule: null, done: 0, left: 0 }]);
    expect(r).toMatchObject({ code: 0, lines: ["retention: 0 rows handled"] });
  });
  it("passes the batch size", async () => {
    expect((await run([{ rule: null, done: 0, left: 0 }], 7)).f.batches).toEqual([7]);
  });
  it("the cap stops the loop and goes red", async () => {
    const r = await run([{ rule: "apply_click", done: 1, left: 9 }], 1, 3);
    expect(r.f.calls()).toBe(3);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toMatch(/cap of 3 calls/);
  });
  it("a rule that makes no progress stops the loop and goes red", async () => {
    const r = await run([{ rule: "unverified_account", target: "candidate", done: 0, left: 4 }]);
    expect(r.f.calls()).toBe(1);
    expect(r).toMatchObject({ code: 1 });
    expect(r.lines.at(-1)).toMatch(/no progress/);
  });
  it("storage keys are removed from the store and counted, and the run stays green", async () => {
    const store = memoryStore();
    for (const k of ["cv/a", "case/b"]) await store.put(k, new Uint8Array([1]), "application/pdf");
    const lines: string[] = [];
    const f = fake([{ rule: "application_and_cv", done: 1, left: 0, storage_keys: ["cv/a", "case/b"] }, { rule: null, done: 0, left: 0 }]);
    expect(await drain(f.db, (l) => lines.push(l), undefined, undefined, () => store)).toBe(0);
    expect(store.objects.size).toBe(0);
    expect(lines.at(-1)).toBe("stored files: 2 removed, 0 failed");
  });
  it("a failed removal finishes the loop, prints a count (never a key), and goes red", async () => {
    const store = memoryStore();
    store.failNext();
    const lines: string[] = [];
    const f = fake([{ rule: "application_and_cv", done: 1, left: 0, storage_keys: ["x\ny", "cv/ok"] }, { rule: null, done: 0, left: 0 }]);
    expect(await drain(f.db, (l) => lines.push(l), undefined, undefined, () => store)).toBe(1);
    expect(f.calls()).toBe(2);
    expect(lines.join("\n")).toContain("stored files: 1 removed, 1 failed");
    expect(lines.at(-1)).toBe("not removed (file store: fake failure): 1 files, the weekly orphan sweep removes them");
    expect(lines.join("\n")).not.toMatch(/cv\/ok|x\ny/);
  });
  it("missing FILES_S3_ settings make every removal fail, naming the settings, never their values", async () => {
    const lines: string[] = [];
    const f = fake([{ rule: "inactive_profile_warning", done: 1, left: 0, storage_keys: ["cv/a"] }, { rule: null, done: 0, left: 0 }]);
    const off = () => s3Store(s3Settings({ FILES_S3_KEY_ID: "fake-key-id" }));
    expect(await drain(f.db, (l) => lines.push(l), undefined, undefined, off)).toBe(1);
    expect(lines.at(-1)).toMatch(/FILES_S3_SECRET, FILES_S3_BUCKET, FILES_S3_REGION not set/);
    expect(lines.join()).not.toContain("fake-key-id");
  });
  it("no stored files: the store is never made", async () => {
    const r = await run([{ rule: "apply_click", done: 1, left: 0 }, { rule: null, done: 0, left: 0 }]);
    expect(r.code).toBe(0); // the default store would throw without FILES_S3_* set
  });
});

describe("retention main, failure paths", () => {
  it("refuses arguments and a missing login with exit 2", async () => {
    expect(await main(["x"], {}, () => {})).toBe(2);
    expect(await main(["sweep", "x"], {}, () => {})).toBe(2);
    const s: string[] = [];
    expect(await main(["sweep"], { RETENTION_ADMIN_DATABASE_URL: "postgres://x" }, (l) => s.push(l))).toBe(2);
    expect(s).toEqual(["SWEEP_BACKUP_DATABASE_URL is not set (the app_backup login)"]);
    const lines: string[] = [];
    expect(await main([], {}, (l) => lines.push(l))).toBe(2);
    expect(lines.join()).toMatch(/RETENTION_ADMIN_DATABASE_URL is not set/);
  });
  it("an unreachable database is red", async () => {
    const lines: string[] = [];
    expect(await main([], { RETENTION_ADMIN_DATABASE_URL: "postgres://app_admin:pw@127.0.0.1:1/postgres", DATABASE_SSL: "disable" }, (l) => lines.push(l))).toBe(1);
    expect(lines.join()).toMatch(/^refused:/);
  });
});

describe("the orphan sweep, no database", () => {
  const NOW = Date.parse("2026-11-29T03:00:00Z");
  const setup = async (ages: Record<string, number>) => {
    const store = memoryStore();
    for (const [k, age] of Object.entries(ages)) { await store.put(k, new Uint8Array([1]), "application/pdf"); store.times.set(k, new Date(NOW - age)); }
    return store;
  };
  const named = (keys: string[]) => {
    const asked: unknown[] = [];
    return { asked, db: { query: async (_q: string, p: unknown[]) => (asked.push(p[0]), { rows: (p[0] as string[]).filter((k) => keys.includes(k)).map((k) => ({ k })) }) } as never };
  };
  it("asks only about keys older than 24 hours, keeps every key a row names, removes the rest", async () => {
    const store = await setup({ "cv/named": 2 * SWEEP_AGE_MS, "cv/orphan": SWEEP_AGE_MS + 1, "cv/young": SWEEP_AGE_MS, "case/young": 1000, "rules/x": 9 * SWEEP_AGE_MS, "check/x": 9 * SWEEP_AGE_MS });
    const d = named(["cv/named"]);
    const lines: string[] = [];
    expect(await sweep(d.db, (l) => lines.push(l), () => store, NOW)).toBe(0);
    expect(d.asked).toEqual([["cv/named", "cv/orphan"]]);
    expect([...store.objects.keys()].sort()).toEqual(["case/young", "check/x", "cv/named", "cv/young", "rules/x"]);
    expect(lines).toEqual(["sweep: 2 files older than 24 hours, 1 still named by a row, 1 orphans removed (cv/ 1, case/ 0, authority/ 0, logo/ 0, sponsor/ 0, evidence/ 0), 0 failed"]);
  });
  it("the proportional guard: 5 orphans pass; 6 of 11 older files is refused; 6 of 12 passes", async () => {
    const ages = (orphans: number, named: number) => Object.fromEntries([...Array.from({ length: orphans }, (_, i) => [`cv/o${i}`, 2 * SWEEP_AGE_MS]), ...Array.from({ length: named }, (_, i) => [`cv/n${i}`, 2 * SWEEP_AGE_MS])]);
    const keep = (n: number) => Array.from({ length: n }, (_, i) => `cv/n${i}`);
    const s0 = await setup(ages(5, 0));
    expect(await sweep(named(keep(0)).db, () => {}, () => s0, NOW)).toBe(0);
    expect(s0.objects.size).toBe(0);
    const s1 = await setup(ages(6, 5));
    expect(await sweep(named(keep(5)).db, () => {}, () => s1, NOW)).toBe(1);
    expect(s1.objects.size).toBe(11);
    const s2 = await setup(ages(6, 6));
    expect(await sweep(named(keep(6)).db, () => {}, () => s2, NOW)).toBe(0);
    expect(s2.objects.size).toBe(6);
  });
  it("a failing query removes nothing", async () => {
    const store = await setup({ "cv/orphan": 2 * SWEEP_AGE_MS });
    const db = { query: async () => { throw new Error("refused"); } } as never;
    await expect(sweep(db, () => {}, () => store, NOW)).rejects.toThrow("refused");
    expect(store.objects.size).toBe(1);
  });
});
