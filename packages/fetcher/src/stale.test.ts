// Unit: the stale-board close (W1c follow-up). The age rule runs in SQL (store.ts CLOSE_STALE, proven on the database in
// test/stale.test.ts); here: what the fetcher hands it, and that a 'source_stale' job counts as the fetcher's own close, so it reopens.
import { describe, expect, it } from "vitest";
import { changeOf, FETCHER_CLOSED, stateOf } from "./plan";
import { CLOSE_STALE, closeStale, STALE_BOARD_DAYS } from "./store";
import type { Db, Known } from "./types";

const known = (o: Partial<Known>): Known => ({ advertId: 1, hash: "h", gone: true, jobId: 9, status: "closed", closeReason: "source_stale", ...o });

describe("stale-board close", () => {
  it("one statement, given the run's time and 7 days; returns the count", async () => {
    const calls: unknown[][] = [];
    const db = { query: async (sql: string, p: unknown[]) => (calls.push([sql, ...p]), { rows: [{ n: 3 }] }) } as unknown as Db;
    const now = new Date("2026-11-25T05:17:00Z");
    expect(await closeStale(db, now)).toBe(3);
    expect(calls).toEqual([[CLOSE_STALE, now, 7]]);
    expect(STALE_BOARD_DAYS).toBe(7);
  });
  it("only live fetched jobs, strictly older than the cutoff, counted from the last good fetch or else the first sighting", () => {
    expect(CLOSE_STALE).toContain("j.source = 'fetched' and j.status = 'live'");
    expect(CLOSE_STALE).toContain("coalesce(s.last_ok_at, f.first_seen_at) < $1::timestamptz - make_interval(days => $2::int)");
  });
  it("a 'source_stale' job is the fetcher's own close: listed again it is assessed again and reopens; staff closes still settle", () => {
    expect(FETCHER_CLOSED).toContain("source_stale");
    expect(stateOf(known({}), "h")).toBe("again");
    const p = { action: "job", advert: {} as never, text: "", job: { status: "live" } as never } as const;
    expect(changeOf(known({}), p)).toBe("reopen");
    expect(stateOf(known({ closeReason: "removed" }), "h")).toBe("settle");
  });
});
