// The pure trust and safety rules: the 12-month level count (#214 a) and the decision timing (#44 fair process, #213 instant ban). No database.
import { describe, expect, it } from "vitest";
import { CASE_KINDS, decideTiming, levelFor } from "./trust-safety";

const now = new Date("2026-11-12T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 864e5);

describe("levelFor", () => {
  it("counts only strikes decided in the 12 months before now, and stops at 3", () => {
    expect(levelFor([], now)).toBe(1);
    expect(levelFor([ago(30)], now)).toBe(2);
    expect(levelFor([ago(30), ago(200)], now)).toBe(3);
    expect(levelFor([ago(1), ago(2), ago(3), ago(4)], now)).toBe(3);
    expect(levelFor([ago(400)], now)).toBe(1); // older than 12 months: no longer counts
    expect(levelFor([new Date("2025-11-12T12:00:00Z")], now)).toBe(1); // exactly 12 months: out
    expect(levelFor([new Date("2025-11-12T12:00:01Z")], now)).toBe(2); // one second inside
  });
});

describe("decideTiming", () => {
  const due = new Date(now.getTime() + 3 * 864e5);
  const past = ago(1);
  const t = (outcome: string, replyDueAt: Date | null, replied = false, conclusive = false) => decideTiming({ outcome, replyDueAt, replied, conclusive, now });
  it("clearing is always allowed", () => {
    expect(t("cleared", null)).toBeNull();
    expect(t("cleared", due)).toBeNull();
  });
  it("a strike needs the employer notified, then a reply or the window passed", () => {
    expect(t("strike", null)).toBe("not_notified");
    expect(t("strike", due)).toBe("reply_window_open");
    expect(t("strike", due, true)).toBeNull();
    expect(t("strike", past)).toBeNull();
    expect(t("strike", now)).toBe("reply_window_open"); // the last moment of the window is still inside it
  });
  it("a ban waits for the 7 days even after a reply, unless the evidence is conclusive (#213)", () => {
    expect(t("ban", null)).toBe("not_notified");
    expect(t("ban", due, true)).toBe("reply_window_open");
    expect(t("ban", past)).toBeNull();
    expect(t("ban", null, false, true)).toBeNull();
    expect(t("ban", due, false, true)).toBeNull();
  });
  it("each case kind has its own reason codes", () => {
    expect(CASE_KINDS.instant_ban).toEqual(["asks_for_money", "fake_company", "fake_job"]);
    expect(CASE_KINDS.false_claim).toEqual(["false_sponsorship"]);
  });
});
