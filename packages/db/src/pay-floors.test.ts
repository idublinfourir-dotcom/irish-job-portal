// The pure parts of pay floors and the guard order of the database calls, with a fake database. No network, no real database.
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { cleanFamily, confirmFloor, createPayFloor, FloorRefused, getFloorCheck, listFloorChecks, proposeFloor, rejectFloor, withdrawPayFloor } from "./pay-floors";

describe("cleanFamily", () => {
  it("accepts a SOC 2010 code, as it is", () => {
    for (const v of ["2134", "3412", "9279"]) expect(cleanFamily(v)).toBe(v);
  });
  it("refuses everything else: free text, other lengths, spaces, other digits, control and format characters, non-strings", () => {
    for (const v of ["", " ", "chef", "Chef", "0000", "1110", "9999", "213", "21345", " 2134", "2134 ", "21 34", "2.34", "-123", "٢١٣٤", "２１３４", "2134\n", "2134\u0000", "2134‮", "21​34", null, undefined, 2134, {}, ["2134"]])
      expect(cleanFamily(v), JSON.stringify(v)).toBeNull();
  });
});

// A database that records what it was asked and answers from a queue.
function fake(answers: { rows?: unknown[]; rowCount?: number }[] = []) {
  const calls: string[] = [];
  const query = async (sql: string) => {
    calls.push(sql);
    return { rows: [], rowCount: 0, ...(/^(begin|commit|rollback)/.test(sql) ? {} : (answers.shift() ?? {})) };
  };
  return { db: { query, connect: async () => ({ query, release: () => {} }) } as never, calls };
}
const who = { membershipId: 1, organisationId: 2, role: "account_owner" };
const why = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof FloorRefused || e instanceof QueueRefused ? (e instanceof QueueRefused ? e.why : e.message) : `other: ${(e as Error).message}`; } return "ok"; };

describe("createPayFloor, before the database", () => {
  it("refuses a bad family, amount or text id without a query", async () => {
    const bad = [{ roleFamily: "", floorEur: 40000, consentTextId: "1" }, { roleFamily: "3412", floorEur: 0, consentTextId: "1" }, { roleFamily: "3412", floorEur: 1.5, consentTextId: "1" },
      { roleFamily: "3412", floorEur: 1_000_001, consentTextId: "1" }, { roleFamily: "3412", floorEur: Number.NaN, consentTextId: "1" }, { roleFamily: "3412", floorEur: 40000, consentTextId: "0" },
      { roleFamily: "3412", floorEur: 40000, consentTextId: "1; drop table pay_floor" }, { roleFamily: "3412", floorEur: 40000, consentTextId: "9223372036854775808" }];
    for (const b of bad) {
      const { db, calls } = fake();
      expect(await why(createPayFloor(db, who, b)), JSON.stringify(b)).toBe("BAD_REQUEST");
      expect(calls).toEqual([]);
    }
  });
  it("needs a published wording, and the one the signer saw", async () => {
    expect(await why(createPayFloor(fake([{ rows: [] }]).db, who, { roleFamily: "3412", floorEur: 40000, consentTextId: "1" }))).toBe("NO_CONSENT_TEXT");
    expect(await why(createPayFloor(fake([{ rows: [{ id: "7", version: "v2", body: "x" }] }]).db, who, { roleFamily: "3412", floorEur: 40000, consentTextId: "6" }))).toBe("TEXT_CHANGED");
  });
  it("turns the database's own refusals into codes and lets anything else through", async () => {
    const text = { rows: [{ id: "7", version: "v", body: "x" }] };
    const failing = (e: object) => ({ db: { query: async (sql: string) => { if (sql.startsWith("insert")) throw Object.assign(new Error((e as { message?: string }).message ?? ""), e); return text; } } as never });
    const go = (e: object) => why(createPayFloor(failing(e).db, who, { roleFamily: "3412", floorEur: 40000, consentTextId: "7" }));
    expect(await go({ code: "P0001", message: "pay floor refused: the organisation is not an employer on the big-company list" })).toBe("NOT_BIG_COMPANY");
    expect(await go({ code: "P0001", message: "signer refused: not an active poster" })).toBe("NOT_SIGNER");
    expect(await go({ code: "23505", constraint: "pay_floor_one_pending" })).toBe("ALREADY_PENDING");
    expect(await go({ code: "23505", constraint: "something_else" })).toBe("other: ");
    expect(await go({ code: "57P01", message: "terminating" })).toBe("other: terminating");
  });
});

describe("withdrawPayFloor, before the database", () => {
  it("refuses a bad id without a query and tells the cases apart after a miss", async () => {
    const a = fake();
    expect(await why(withdrawPayFloor(a.db, who, "0"))).toBe("BAD_REQUEST");
    expect(a.calls).toEqual([]);
    expect(await why(withdrawPayFloor(fake([{ rowCount: 0 }, { rows: [] }]).db, who, "5"))).toBe("NOT_FOUND");
    expect(await why(withdrawPayFloor(fake([{ rowCount: 0 }, { rows: [{ status: "pending_check", signer: false }] }]).db, who, "5"))).toBe("NOT_SIGNER");
    expect(await why(withdrawPayFloor(fake([{ rowCount: 0 }, { rows: [{ status: "withdrawn", signer: true }] }]).db, who, "5"))).toBe("NOT_WITHDRAWABLE");
    expect(await why(withdrawPayFloor(fake([{ rowCount: 1 }]).db, who, "5"))).toBe("ok");
  });
});

describe("the staff role check comes first", () => {
  const act = (flags: { active: boolean; editor: boolean; administrator: boolean }) => fake([{ rows: [flags] }]);
  const none = { active: true, editor: false, administrator: false };
  it("refuses every call without the role, before any floor is touched", async () => {
    expect(await why(proposeFloor(fake([{ rows: [none] }]).db, "s", "1"))).toBe("not_rules_editor");
    expect(await why(confirmFloor(fake([{ rows: [none] }]).db, "s", "1"))).toBe("not_administrator");
    expect(await why(rejectFloor(fake([{ rows: [none] }]).db, "s", "1", "no_evidence"))).toBe("not_floor_staff");
    expect(await why(listFloorChecks(act(none).db, "s"))).toBe("not_floor_staff");
    expect(await why(getFloorCheck(act(none).db, "s", "1"))).toBe("not_floor_staff");
  });
  it("an editor cannot confirm and an administrator cannot propose", async () => {
    expect(await why(listFloorChecks(act({ active: true, editor: true, administrator: false }).db, "s"))).toBe("ok");
    expect(await why(listFloorChecks(act({ active: true, editor: false, administrator: true }).db, "s"))).toBe("ok");
  });
  it("refuses a disabled or odd staff id, a bad floor id and a bad reason code without a query", async () => {
    expect(await why(listFloorChecks(act({ active: false, editor: true, administrator: true }).db, "s"))).toBe("not_active_staff");
    const a = fake();
    for (const s of ["", "x".repeat(201), 5 as unknown as string]) expect(await why(listFloorChecks(a.db, s)), String(s)).toBe("not_active_staff");
    expect(await why(proposeFloor(a.db, "s", "abc"))).toBe("not_found");
    expect(await why(proposeFloor(a.db, "s", "0"))).toBe("not_found");
    for (const r of ["", "Bad", "has space", "x;y", "a".repeat(64), undefined as unknown as string]) expect(await why(rejectFloor(a.db, "s", "1", r)), String(r)).toBe("bad_reason");
    expect(a.calls).toEqual([]);
    expect(await why(listFloorChecks(a.db, "s", { after: "not a cursor!" }))).toBe("bad_cursor");
  });
});
