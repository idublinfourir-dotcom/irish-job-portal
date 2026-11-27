// No database: the drift rules. The real check against a migrated database is test/migration-check.test.ts.
import { describe, expect, it } from "vitest";
import { migrationDrift, main } from "./migration-check-cli.ts";

const entries = [{ tag: "0001_a", when: 10 }, { tag: "0002_b", when: 20 }];
const hashes = ["h1", "h2"];
const rows = [{ hash: "h1", created_at: "10" }, { hash: "h2", created_at: 20 }];

describe("migrationDrift", () => {
  it("is empty when every entry matches", () => expect(migrationDrift(entries, hashes, rows)).toEqual([]));
  it("flags a missing one", () => expect(migrationDrift(entries, hashes, rows.slice(0, 1))).toEqual(["0002_b: in the repo, not applied"]));
  it("flags an extra applied one", () => expect(migrationDrift(entries, hashes, [...rows, { hash: "h3", created_at: 30 }])).toEqual(["1 applied migration(s) are not in the repo"]));
  it("flags an edited file", () => expect(migrationDrift(entries, ["h1", "edited"], rows)[0]).toMatch(/^0002_b: the file differs/));
  it("flags a different journal time", () => expect(migrationDrift([entries[0]!, { tag: "0002_b", when: 21 }], hashes, rows)[0]).toMatch(/journal time differs/));
  it("flags a journal time that is not later (drizzle would skip the file)", () => {
    const e = [{ tag: "0001_a", when: 20 }, { tag: "0002_b", when: 10 }];
    expect(migrationDrift(e, hashes, [{ hash: "h1", created_at: 20 }, { hash: "h2", created_at: 10 }])).toEqual(["0002_b: its journal time is not later than the one before (drizzle would skip it)"]);
  });
});

describe("main", () => {
  it("needs the login and takes no arguments", async () => {
    const log: string[] = [];
    expect(await main([], {}, (l) => log.push(l))).toBe(2);
    expect(await main(["x"], {}, (l) => log.push(l))).toBe(2);
  });
});
