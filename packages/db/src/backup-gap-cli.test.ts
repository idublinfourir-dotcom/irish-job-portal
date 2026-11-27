// No network, no database: the gap between two backups from their names, and when the run goes red.
import { describe, expect, it } from "vitest";
import { gapHours, main, stampTime } from "./backup-gap-cli.ts";

const run = (argv: string[], env: NodeJS.ProcessEnv = {}) => { const lines: string[] = []; return { code: main(argv, env, (l) => lines.push(l)), lines }; };

describe("backup gap", () => {
  it("reads the UTC time from a name or a bucket key, and nothing from other text", () => {
    expect(stampTime("db-20261127T0647Z")).toBe(Date.UTC(2026, 10, 27, 6, 47));
    expect(stampTime("db/2026/11/db-20261127T0647Z.json")).toBe(Date.UTC(2026, 10, 27, 6, 47));
    expect(stampTime("")).toBeNull();
    expect(stampTime("db-2026.json; rm -rf /")).toBeNull();
  });
  it("counts hours across a day, a month and a year", () => {
    expect(gapHours("db/2026/11/db-20261127T0047Z.json", "db-20261127T0647Z")).toBe(6);
    expect(gapHours("db/2026/11/db-20261130T1847Z.json", "db-20261201T0047Z")).toBe(6);
    expect(gapHours("db/2026/12/db-20261231T2157Z.json", "db-20270101T0855Z")).toBeCloseTo(10.97, 2);
    expect(gapHours("", "db-20261127T0647Z")).toBeNull();
  });
  it("only prints while no limit is set, and is quiet about a first backup", () => {
    expect(run(["db/2026/11/db-20261126T2157Z.json", "db-20261127T0855Z"])).toEqual({ code: 0, lines: ["the backup before this one is 11.0 hours older"] });
    expect(run(["", "db-20261127T0855Z"], { BACKUP_MAX_GAP_HOURS: "8" })).toEqual({ code: 0, lines: ["no earlier backup to compare with"] });
  });
  it("goes red only over the limit: 8 hours passes at 8.0 and fails at 8.1", () => {
    const env = { BACKUP_MAX_GAP_HOURS: "8" };
    expect(run(["db/2026/11/db-20261127T0047Z.json", "db-20261127T0847Z"], env).code).toBe(0);
    const late = run(["db/2026/11/db-20261127T0047Z.json", "db-20261127T0853Z"], env);
    expect(late.code).toBe(1);
    expect(late.lines.at(-1)).toMatch(/^::error::the gap between backups was 8\.1 hours, over the 8 allowed/);
  });
  it("refuses a wrong call or a limit that is not a number above 0, with nothing compared", () => {
    expect(run([]).code).toBe(2);
    expect(run(["a", "b", "c"]).code).toBe(2);
    for (const bad of ["0", "-1", "soon", "8; echo x"]) expect(run(["", "db-20261127T0855Z"], { BACKUP_MAX_GAP_HOURS: bad }).code, bad).toBe(2);
  });
});
