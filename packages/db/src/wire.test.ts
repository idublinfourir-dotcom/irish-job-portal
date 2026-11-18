// The shared reply format (wire.ts): ids as text, times in UTC with Z, and the opaque id cursor. No database.
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { validId } from "./search";
import { decodeIdCursor, encodeIdCursor, isoTime, toWire } from "./wire";

const why = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return e instanceof QueueRefused ? e.why : "other"; } };

describe("validId, the one id check every app uses", () => {
  it("takes digits from 1 to the bigint top, with no leading zero", () => {
    for (const v of ["1", "10", "9223372036854775807"]) expect(validId(v), v).toBe(true);
    for (const v of ["0", "00", "01", "007", "9223372036854775808", "9".repeat(19), "1".repeat(20), "", "-1", "+1", " 1", "1\n", "1e3", "0x1", "١", 1, null, undefined, ["1"]])
      expect(validId(v), JSON.stringify(v)).toBe(false);
  });
});

describe("isoTime", () => {
  it("turns Postgres text and offset forms into ISO 8601 UTC with Z", () => {
    expect(isoTime("2026-11-18 09:30:00.123456+00")).toBe("2026-11-18T09:30:00.123Z");
    expect(isoTime("2026-11-18T09:30:00.123456+00:00")).toBe("2026-11-18T09:30:00.123Z");
    expect(isoTime("2026-11-18 10:30:00+01")).toBe("2026-11-18T09:30:00.000Z");
    expect(isoTime("2026-11-18T09:30:00.000Z")).toBe("2026-11-18T09:30:00.000Z");
  });
});

describe("toWire", () => {
  it("sends ids as text and times with Z, inside arrays and nested objects", () => {
    const at = new Date("2026-11-18T09:30:00Z");
    expect(toWire({
      organisationId: 12, myMembershipId: 3, jobs: [{ id: 5501, postedAt: "2026-11-10T08:00:00.000000+00:00", closedAt: null, salaryLow: 70000 }],
      page: { cases: [{ id: 7, jobId: null, replyDueAt: "2026-11-18 09:30:00.123456+00", level: 2 }], restrictedUntil: "2026-12-01 00:00:00+00" },
      joinedAt: at, validUntil: "2027-11-18 09:30:00+00",
    })).toEqual({
      organisationId: "12", myMembershipId: "3", jobs: [{ id: "5501", postedAt: "2026-11-10T08:00:00.000Z", closedAt: null, salaryLow: 70000 }],
      page: { cases: [{ id: "7", jobId: null, replyDueAt: "2026-11-18T09:30:00.123Z", level: 2 }], restrictedUntil: "2026-12-01T00:00:00.000Z" },
      joinedAt: at, validUntil: "2027-11-18T09:30:00.000Z",
    });
  });
  it("leaves alone what is not an id or a time: other numbers, ids already text, dates without a time, free text under any key", () => {
    expect(toWire({ id: "42", count: 3, floorEur: 45000, day: "2026-11-18", title: "2026-11-18 09:30:00+00", createdAt: "soon", text: "x" }))
      .toEqual({ id: "42", count: 3, floorEur: 45000, day: "2026-11-18", title: "2026-11-18 09:30:00+00", createdAt: "soon", text: "x" });
    expect(toWire(null)).toBeNull();
    expect(toWire([1, 2])).toEqual([1, 2]);
  });
});

describe("the id cursor", () => {
  it("round-trips an id and is opaque base64url", () => {
    const t = encodeIdCursor("cases", "1042");
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toContain("1042");
    expect(decodeIdCursor("cases", t)).toBe("1042");
  });
  it("refuses forged, changed and other lists' tokens with bad_cursor", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const c = (i: unknown) => b64({ l: "cases", i });
    for (const bad of [undefined, 5, "", "1042", "abc", "!!!", "a".repeat(201), b64(null), b64([]), b64("1"), b64({}), b64({ i: "5" }), c(1042), c("0"), c("01"),
      c("9223372036854775808"), b64({ l: "cases", i: "1", x: 1 }), b64({ i: "1", l: "cases" }), b64({ t: "2026-11-18 09:30:00+00", i: "5" }),
      encodeIdCursor("manual_jobs", "5"), encodeIdCursor("owner_reassign", "5"), Buffer.from('{"l":"cases","i":"1","__proto__":{"i":"2"}}').toString("base64url")])
      expect(why(() => decodeIdCursor("cases", bad)), String(bad)).toBe("bad_cursor");
  });
});
