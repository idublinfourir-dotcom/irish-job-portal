import { describe, expect, it } from "vitest";
import { scoreGate, type GateRow } from "./score";

const rows = (passedRight: number, passedWrong: number, rejectedRight: number, rejectedWrong: number): GateRow[] => [
  ...Array.from({ length: passedRight }, (_, i) => ({ id: `pr${i}`, passed: true, qualifies: true })),
  ...Array.from({ length: passedWrong }, (_, i) => ({ id: `pw${i}`, passed: true, qualifies: false })),
  ...Array.from({ length: rejectedRight }, (_, i) => ({ id: `rr${i}`, passed: false, qualifies: false })),
  ...Array.from({ length: rejectedWrong }, (_, i) => ({ id: `rw${i}`, passed: false, qualifies: true })),
];

describe("scoreGate", () => {
  it("counts both sides and lists the wrong ids", () => {
    const s = scoreGate(rows(8, 2, 5, 1));
    expect(s).toMatchObject({ scored: 16, passed: 10, passedCorrect: 8, share: 0.8, rejected: 6, rejectedCorrect: 5, enoughRows: false, holds: false });
    expect(s.rejectedShare).toBeCloseTo(5 / 6);
    expect(s.wrongPassed).toEqual(["pw0", "pw1"]);
    expect(s.wrongRejected).toEqual(["rw0"]);
    expect(s.note).toContain("not a gate");
  });

  it("holds at 98% with 300 rows (49 of 50 is exactly 98%)", () => {
    expect(scoreGate(rows(49, 1, 250, 0)).holds).toBe(true);
    expect(scoreGate(rows(294, 6, 0, 0))).toMatchObject({ share: 0.98, holds: true, note: "The gate holds." });
  });

  it("fails at 97%", () => {
    const s = scoreGate(rows(291, 9, 0, 0));
    expect(s.share).toBe(0.97);
    expect(s).toMatchObject({ enoughRows: true, holds: false, note: "The gate does not hold." });
  });

  it("fails under 300 rows even at 100%, and says why", () => {
    const s = scoreGate(rows(50, 0, 249, 0));
    expect(s).toMatchObject({ scored: 299, share: 1, enoughRows: false, holds: false });
    expect(s.note).toMatch(/at least 300/);
  });

  it("holds at exactly 300 rows", () => {
    expect(scoreGate(rows(50, 0, 250, 0)).holds).toBe(true);
  });

  it("does not hold when nothing passed, and reports no share", () => {
    const s = scoreGate(rows(0, 0, 300, 0));
    expect(s).toMatchObject({ passed: 0, share: null, shareLow95: null, holds: false });
    expect(s.note).toMatch(/No job passed/);
  });

  it("reports no rejected share when nothing was rejected, and handles no rows", () => {
    expect(scoreGate(rows(300, 0, 0, 0)).rejectedShare).toBeNull();
    expect(scoreGate([])).toMatchObject({ scored: 0, share: null, holds: false });
  });

  it("a matcher cannot reach the gate by rejecting everything in doubt without the rejected share showing", () => {
    const s = scoreGate(rows(10, 0, 100, 190));
    expect(s.holds).toBe(true);
    expect(s.rejectedShare).toBeCloseTo(100 / 290);
    expect(s.wrongRejected).toHaveLength(190);
  });

  it("gives the Wilson lower end, lower than the share on a small count", () => {
    // known value: 49 of 50 at 95% Wilson is about 0.8951
    expect(scoreGate(rows(49, 1, 0, 0)).shareLow95).toBeCloseTo(0.8951, 3);
    const big = scoreGate(rows(2940, 60, 0, 0)).shareLow95!;
    expect(big).toBeGreaterThan(0.97);
    expect(big).toBeLessThan(0.98);
    expect(scoreGate(rows(1, 0, 0, 0)).shareLow95).toBeCloseTo(0.2065, 3);
  });
});
