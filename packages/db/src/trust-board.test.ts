// Unit tests of the trust board reads' pure parts (no database): the id label, the tab and cursor checks that run before any query, and that every statement is fixed text.
import { describe, expect, it, vi } from "vitest";
import { QueueRefused } from "./admin-queue";
import { BANS, TRUST_COUNTS, TRUST_LIST, TRUST_TABS, listBans, listTrust, listWrcReported, trustLabel, wrcSql } from "./trust-board";

const never = { query: vi.fn(async () => { throw new Error("no query may run"); }) };
const why = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof QueueRefused ? e.why : "other"; } return "accepted"; };
const tok = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("trust board", () => {
  it("one label for reports and cases: a letter and the id, 4 digits at least", () => {
    expect([trustLabel("report", "91"), trustLabel("case", 91), trustLabel("case", "123456")]).toEqual(["R-0091", "C-0091", "C-123456"]);
  });
  it("a bad tab or a bad token is refused before the database is asked", async () => {
    expect(await why(listTrust(never, "s", { tab: "everything" }))).toBe("bad_tab");
    for (const after of ["", "x".repeat(201), "not a token", tok({ b: "open" }), tok({ b: "closed", t: "2026-01-01 10:00:00+00", k: "case", i: "1" }), tok({ b: "open", t: "2026-01-01 10:00:00+00", k: "case", i: "01" })])
      expect(await why(listTrust(never, "s", { tab: "open", after })), after.slice(0, 20)).toBe("bad_cursor");
    expect(await why(listBans(never, "s", { after: tok({ l: "cases", i: "5" }) }))).toBe("bad_cursor");
    expect(await why(listWrcReported(never, "s", { after: "1" }))).toBe("bad_cursor");
    expect(never.query).not.toHaveBeenCalled();
  });
  it("every statement is fixed text with only the three cursor values bound, and each tab has its own", () => {
    const all = [...Object.values(TRUST_LIST), TRUST_COUNTS, BANS, wrcSql(false), wrcSql(true)];
    for (const sql of all) expect(sql.match(/\$\d+/g)?.every((p) => ["$1", "$2", "$3"].includes(p)) ?? true).toBe(true);
    expect(Object.keys(TRUST_LIST).sort()).toEqual(TRUST_TABS.flatMap((t) => [t, `${t}:after`]).sort());
    expect(TRUST_LIST.waiting).not.toMatch(/from report r\b/); // waiting and appeals hold cases only
    expect(TRUST_LIST.appeals).not.toMatch(/from report r\b/);
    expect(TRUST_COUNTS).toContain("limit 200");
  });
});
