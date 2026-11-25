// Unit: runBoards with a fake Db that records statements. No database, no network. Design 3.1.
import { describe, expect, it } from "vitest";
import { runBoards, type Db } from "../src";
import { advert, deps, plan, task } from "./helpers";

type Log = { sql: string[]; inTx: number; maxOpen: number };
// Answers like the database would, just enough for the loop. `fail` makes a statement throw.
function fakeDb(known: string[] = [], fail?: (sql: string) => boolean, content_hash: string | null = "h"): { db: Db; log: Log } {
  const log: Log = { sql: [], inTx: 0, maxOpen: 0 };
  const query = async (sql: string) => {
    log.sql.push(sql);
    if (fail?.(sql)) throw new Error("fake database error");
    if (sql.startsWith("select external_id")) return { rows: known.map((external_id) => ({ external_id, content_hash })) };
    if (sql.startsWith("with k as")) return { rows: [{ norm: "acme ltd", id: "7", status: "unclaimed" }] };
    return { rows: [{ id: "1" }] };
  };
  const db = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Db;
  return { db, log };
}
const kinds = (sql: string[]) => sql.map((s) => s.split(" ").slice(0, 3).join(" "));

describe("runBoards", () => {
  it("runs the statements of 3.1 in order for one board with a rejected advert", async () => {
    const { db, log } = fakeDb();
    const a = advert("1");
    const [r] = await runBoards(deps(db, [task("fake", "b", [a])]), (x) => plan(x, "reject"));
    expect(kinds(log.sql)).toEqual(["insert into job_source(kind,", "insert into fetch_run(job_source_id)", "select external_id, f.id", "insert into fetched_advert(job_source_id,", "with seen as"]);
    expect(r).toMatchObject({ ok: true, error: null, seen: 1, rejected: 1, passed: 0, queued: 0, unsaved: [] });
  });

  it("saves a passed advert in one transaction: begin first, commit last", async () => {
    const { db, log } = fakeDb();
    const a = advert("1");
    const [r] = await runBoards(deps(db, [task("fake", "b", [a])]), (x) => plan(x, "passed"));
    const tx = log.sql.slice(3, -1);
    expect(tx[0]).toBe("begin");
    expect(tx.at(-1)).toBe("commit");
    expect(tx).toHaveLength(6); // begin, employer, advert, job, text, commit
    expect(r).toMatchObject({ passed: 1 });
  });

  it("a failed fetch writes the failure and no advert", async () => {
    const { db, log } = fakeDb();
    const t = { kind: "fake", board: "b", fetch: async () => { throw new Error("HTTP 500 ".repeat(100)); } };
    const [r] = await runBoards(deps(db, [t]));
    expect(r!.ok).toBe(false);
    expect(r!.error).toMatch(/^HTTP 500/);
    expect(kinds(log.sql).at(-1)).toBe("with run as");
    expect(log.sql.some((s) => s.startsWith("insert into fetched_advert"))).toBe(false);
    expect(log.sql.some((s) => s.startsWith("with seen"))).toBe(false); // nothing is marked seen, nothing closes
  });

  it("an empty answer while adverts were known counts as a failed fetch", async () => {
    const { db } = fakeDb(["fake:b:old"]);
    const [r] = await runBoards(deps(db, [task("fake", "b", [], [])]));
    expect(r).toMatchObject({ ok: false, error: "returned nothing while 1 adverts were known" });
  });

  it("an empty answer for a board with no known adverts is fine", async () => {
    const { db } = fakeDb();
    const [r] = await runBoards(deps(db, [task("fake", "b", [], [])]));
    expect(r).toMatchObject({ ok: true, seen: 0 });
  });

  it("hands the known ids to the fetch", async () => {
    const { db } = fakeDb(["fake:b:old"]);
    const t = task("fake", "b", []);
    await runBoards(deps(db, [t]));
    expect([...t.calls[0]!]).toEqual(["fake:b:old"]);
  });
  it("an advert with no hash is never known, whatever its board's reread day: it comes back with its text at the next run (0077)", async () => {
    const { db } = fakeDb(["fake:b:old"], undefined, null);
    const t = task("fake", "b", [advert("old")]);
    await runBoards(deps(db, [t]), (x) => plan(x, "reject"));
    expect([...t.calls[0]!]).toEqual([]);
  });

  it("stops assessing after the deadline and leaves the rest for the next run", async () => {
    const { db, log } = fakeDb();
    const list = [advert("1"), advert("2")];
    const [r] = await runBoards(deps(db, [task("fake", "b", list)], { deadline: new Date("2026-11-10T11:00:00Z") }), (x) => plan(x, "reject"));
    expect(r!.unsaved).toEqual(list.map((a) => a.id));
    expect(log.sql.some((s) => s.startsWith("insert into fetched_advert"))).toBe(false);
    expect(r!.ok).toBe(true);
  });

  it("a throwing advert goes to unsaved and the others are still saved", async () => {
    const { db } = fakeDb();
    const list = [advert("1"), advert("2"), advert("3")];
    const [r] = await runBoards(deps(db, [task("fake", "b", list)]), (x) => {
      if (x.id.endsWith(":2")) throw new Error("boom");
      return plan(x, "reject");
    });
    expect(r).toMatchObject({ ok: true, rejected: 2, unsaved: ["fake:b:2"] });
  });

  it("a write that throws goes to unsaved and rolls back", async () => {
    const { db, log } = fakeDb([], (s) => s.startsWith("insert into job("));
    const [r] = await runBoards(deps(db, [task("fake", "b", [advert("1")])]), (x) => plan(x, "passed"));
    expect(r).toMatchObject({ passed: 0, unsaved: ["fake:b:1"] });
    expect(log.sql).toContain("rollback");
  });

  it("a defer plan writes nothing and keeps the id", async () => {
    const { db, log } = fakeDb();
    const [r] = await runBoards(deps(db, [task("fake", "b", [advert("1")])]), () => ({ action: "defer", why: "model error" }));
    expect(r!.unsaved).toEqual(["fake:b:1"]);
    expect(log.sql.some((s) => s.startsWith("insert into fetched_advert"))).toBe(false);
  });

  it("a board whose first statement fails is reported and does not stop the others", async () => {
    let n = 0;
    const { db } = fakeDb([], (s) => s.startsWith("insert into job_source") && ++n === 1);
    const reports = await runBoards(deps(db, [task("fake", "a", []), task("fake", "c", [])], { concurrency: 1 }));
    expect(reports.map((r) => r.ok)).toEqual([false, true]);
    expect(reports[0]!.error).toBe("fake database error");
  });

  it("runs no more boards at once than the concurrency", async () => {
    const { db } = fakeDb();
    let open = 0, max = 0;
    const slow = (b: string) => ({ kind: "fake", board: b, fetch: async () => { max = Math.max(max, ++open); await new Promise((r) => setTimeout(r, 5)); open--; return { seen: [], adverts: [] }; } });
    await runBoards(deps(db, ["a", "b", "c", "d", "e"].map(slow), { concurrency: 2 }));
    expect(max).toBe(2);
  });
});
