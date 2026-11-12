// Job stats, the parts that need no database: input checks and the shape of the answer, with a fake database.
import { describe, expect, it } from "vitest";
import { countJobView, COUNT_VIEW, jobStats, MAX_DAYS, MAX_ROWS, STATS_READ } from "./job-stats";

const fake = (rows: unknown[] = [], rowCount = 0) => {
  const calls: { sql: string; args: unknown[] }[] = [];
  return { calls, db: { query: async (sql: string, args: unknown[]) => { calls.push({ sql, args }); return { rows, rowCount }; } } as never };
};

describe("countJobView", () => {
  it("writes nothing for an id that is not a positive bigint", async () => {
    const f = fake();
    for (const id of ["", "0", "-1", "1.5", "abc", "1; drop table job", "9223372036854775808", " 1", "01"]) expect(await countJobView(f.db, id), id).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it("is true only when one row was written, and passes the id as a parameter", async () => {
    const yes = fake([], 1), no = fake([], 0);
    expect(await countJobView(yes.db, 42)).toBe(true);
    expect(yes.calls).toEqual([{ sql: COUNT_VIEW, args: ["42"] }]);
    expect(await countJobView(no.db, "42")).toBe(false);
  });
  it("is one statement that counts a live, unexpired job only, by Dublin day", () => {
    expect(COUNT_VIEW).toContain("j.status = 'live'");
    expect(COUNT_VIEW).toContain("j.closes_at > now()");
    expect(COUNT_VIEW).toContain("Europe/Dublin");
    expect(COUNT_VIEW).toContain("on conflict (job_id, day) do update");
  });
});

describe("jobStats", () => {
  it("filters by the company in the statement, with the window and the optional job as parameters", async () => {
    const f = fake([{ job_id: "5", title: "Chef", source: "employer", status: "live", day: "2026-11-12", views: 7, apply_clicks: 2 }]);
    expect(await jobStats(f.db, 9)).toEqual([{ jobId: "5", title: "Chef", source: "employer", status: "live", day: "2026-11-12", views: 7, applyClicks: 2 }]);
    expect(f.calls[0]).toEqual({ sql: STATS_READ, args: ["9", 29, null] });
    await jobStats(f.db, "9", { days: 1, jobId: "5" });
    expect(f.calls[1]!.args).toEqual(["9", 0, "5"]);
    expect(STATS_READ).toContain("j.organisation_id = $1::bigint");
    expect(STATS_READ).toContain(`limit ${MAX_ROWS}`);
  });
  it("refuses a bad company, window or job before any query", async () => {
    const f = fake();
    for (const [org, o] of [["0", {}], ["x", {}], [1, { days: 0 }], [1, { days: MAX_DAYS + 1 }], [1, { days: 1.5 }], [1, { days: Number.NaN }], [1, { jobId: "0" }], [1, { jobId: "1 or 1=1" }]] as const)
      await expect(jobStats(f.db, org, o as never), JSON.stringify([org, o])).rejects.toThrow("bad_input");
    expect(f.calls).toEqual([]);
    await expect(jobStats(f.db, 1, { days: MAX_DAYS })).resolves.toEqual([]);
  });
});
