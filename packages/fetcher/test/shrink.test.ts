// OPS-1: the shrink guard. Unit (fake database, statements recorded) and integration (real test database as app_fetcher). No network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/db";
import { runBoards, shrinkRefusal, type Db } from "../src";
import { advert, deps, fakeModel, plan, task } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `fake:b:${from + i}`);
const T = { kind: "fake", board: "b" };

describe("shrinkRefusal (unit)", () => {
  it("300 known and 20 seen is refused; 300 and 290 passes; 300 and 210 (30% lost) passes; 300 and 209 is refused", () => {
    expect(shrinkRefusal(T, ids(300), ids(20), "")).toMatch(/^list shrank from 300 to 20/);
    expect(shrinkRefusal(T, ids(300), ids(290), "")).toBeNull();
    expect(shrinkRefusal(T, ids(300), ids(210), "")).toBeNull();
    expect(shrinkRefusal(T, ids(300), ids(209), "")).not.toBeNull();
  });
  it("small boards: under 10 known is never held; 10 known losing 5 passes, losing 6 is refused", () => {
    expect(shrinkRefusal(T, ids(9), ids(1), "")).toBeNull();
    expect(shrinkRefusal(T, ids(10), ids(5), "")).toBeNull();
    expect(shrinkRefusal(T, ids(10), ids(4), "")).not.toBeNull();
  });
  it("new ids in the list do not hide a loss", () => {
    expect(shrinkRefusal(T, ids(100), [...ids(20), ...ids(500, 1000)], "")).not.toBeNull();
  });
  it("the override names kind/board exactly", () => {
    expect(shrinkRefusal(T, ids(300), ids(20), "fake/b")).toBeNull();
    expect(shrinkRefusal(T, ids(300), ids(20), "other/x, fake/b")).toBeNull();
    expect(shrinkRefusal(T, ids(300), ids(20), "fake/bb")).not.toBeNull();
    expect(shrinkRefusal(T, ids(300), ids(20), "fake")).not.toBeNull();
  });
  it("one pass over two lists: 100,000 known ids in under 200 ms", () => {
    const t = performance.now();
    shrinkRefusal(T, ids(100_000), ids(50_000), "");
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("runBoards with the guard (fake database)", () => {
  it("a refused run writes only the failure: no FINISH, no advert row", async () => {
    const sql: string[] = [];
    const query = async (s: string) => {
      sql.push(s);
      if (s.startsWith("select external_id")) return { rows: ids(30).map((external_id) => ({ external_id, content_hash: "h" })) };
      return { rows: [{ id: "1" }] };
    };
    const db = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Db;
    const [r] = await runBoards(deps(db, [task("fake", "b", [], ids(3))]));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^list shrank from 30 to 3/) });
    expect(sql.some((s) => s.startsWith("with seen") || s.startsWith("insert into fetched_advert"))).toBe(false);
    expect(sql.at(-1)).toMatch(/^with run as/);
  });
});

describe("integration: real database", () => {
  let db: TestDb;
  const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
  const list = (n: number) => Array.from({ length: n }, (_, i) => advert(`g${i}`));
  const run = async (adverts: ReturnType<typeof list>, seen = adverts.map((a) => a.id)) =>
    (await runBoards(deps(db.pool("app_fetcher"), [task("fake", "b", adverts, seen)], { checkBatch: fakeModel().checkBatch }), (x) => plan(x, "passed")))[0]!;
  const live = async () => (await su("select count(*)::int as n, (select count(*)::int from job_text) as t from job where status = 'live'"))[0] as { n: number; t: number };
  beforeAll(async () => {
    db = await createTestDb();
    expect(await run(list(20))).toMatchObject({ ok: true, passed: 20 });
  });
  afterAll(() => db.drop());

  it("a wave of failed reads (2 of 20 seen) is refused and leaves every job live with its text", async () => {
    const r = await run([], list(2).map((a) => a.id));
    expect(r).toMatchObject({ ok: false, closed: 0 });
    expect(r.error).toMatch(/^list shrank from 20 to 2/);
    expect(await live()).toEqual({ n: 20, t: 20 });
    expect((await su("select error from fetch_run order by id desc limit 1"))[0]).toMatchObject({ error: expect.stringMatching(/shrank/) });
  });
  it("a normal drop (3 of 20 gone) closes them", async () => {
    expect(await run([], list(17).map((a) => a.id))).toMatchObject({ ok: true, closed: 3 });
    expect(await live()).toEqual({ n: 17, t: 17 });
  });
  it("the override accepts a real mass closing", async () => {
    vi.stubEnv("FETCHER_ALLOW_SHRINK", "fake/b");
    try {
      expect(await run([], list(2).map((a) => a.id))).toMatchObject({ ok: true, closed: 15 });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await live()).toEqual({ n: 2, t: 2 });
  });
});
