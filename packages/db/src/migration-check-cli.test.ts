// No database: the drift rules. The real check against a migrated database is test/migration-check.test.ts.
import { describe, expect, it } from "vitest";
import { migrationDrift, main } from "./migration-check-cli.ts";

const entries = [{ tag: "0001_a", when: 10 }, { tag: "0002_b", when: 20 }];
const hashes = ["h1", "h2"];
const rows = [{ hash: "h1", created_at: "10" }, { hash: "h2", created_at: 20 }];

describe("migrationDrift", () => {
  it("is empty when every entry matches", () => expect(migrationDrift(entries, hashes, rows)).toEqual({ problems: [], pending: [] }));
  it("a pending tail (entries at the end with no applied row) is pending, not a problem", () =>
    expect(migrationDrift(entries, hashes, rows.slice(0, 1))).toEqual({ problems: [], pending: ["0002_b"] }));
  it("a gap (an entry missing in the middle while a later one is applied) fails", () => {
    const e3 = [...entries, { tag: "0003_c", when: 30 }];
    const r = migrationDrift(e3, [...hashes, "h3"], [rows[0]!, { hash: "h3", created_at: 30 }]);
    expect(r.problems[0]).toMatch(/^0002_b: the file differs/);
  });
  it("flags an extra applied one", () => expect(migrationDrift(entries, hashes, [...rows, { hash: "h3", created_at: 30 }]).problems).toEqual(["1 applied migration(s) are not in the repo"]));
  it("flags an edited file", () => expect(migrationDrift(entries, ["h1", "edited"], rows).problems[0]).toMatch(/^0002_b: the file differs/));
  it("flags a different journal time", () => expect(migrationDrift([entries[0]!, { tag: "0002_b", when: 21 }], hashes, rows).problems[0]).toMatch(/journal time differs/));
  it("flags a journal time that is not later (drizzle would skip the file)", () => {
    const e = [{ tag: "0001_a", when: 20 }, { tag: "0002_b", when: 10 }];
    expect(migrationDrift(e, hashes, [{ hash: "h1", created_at: 20 }, { hash: "h2", created_at: 10 }]).problems).toEqual(["0002_b: its journal time is not later than the one before (drizzle would skip it)"]);
  });
});

describe("main", () => {
  it("needs the login and takes no arguments", async () => {
    const log: string[] = [];
    expect(await main([], {}, (l) => log.push(l))).toBe(2);
    expect(await main(["x"], {}, (l) => log.push(l))).toBe(2);
  });
});
