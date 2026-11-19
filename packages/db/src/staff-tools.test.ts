// Unit tests (no database, network or browser) for the pure parts of step 15 small wave 3: the reminder keys (scheduled-checks-cli.ts) and the
// one-working-day cut-off of the overdue view (staff-tools.ts).
import { describe, expect, it } from "vitest";
import { dueReminders, isoWeek, REMINDER_ROLE } from "./scheduled-checks-cli";
import { workingDayBefore } from "./staff-tools";

describe("isoWeek", () => {
  it("numbers weeks as ISO 8601 does, the year going with the week's Thursday", () => {
    expect(isoWeek("2026-11-18")).toBe("2026-W47");
    expect(isoWeek("2026-01-01")).toBe("2026-W01"); // a Thursday
    expect(isoWeek("2027-01-01")).toBe("2026-W53"); // a Friday: still 2026's last week
    expect(isoWeek("2024-12-30")).toBe("2025-W01"); // a Monday in 2025's first week
    expect(isoWeek("2026-11-16")).toBe(isoWeek("2026-11-22")); // Monday to Sunday is one week
    expect(isoWeek("2026-11-23")).toBe("2026-W48");
  });
});

describe("dueReminders", () => {
  const keys = (today: string, names: { name: string; reviewOn: string | null }[] = []) => dueReminders(today, names).map((r) => r.key);
  it("gives the four fixed reminders with keys that name their period", () => {
    expect(keys("2026-11-18")).toEqual(["dete_notice_check:2026-W47", "hand_check_100:2026-11", "big_company_review:2026-H2", "role_review:2026-Q4"]);
    expect(keys("2026-06-30")).toEqual(["dete_notice_check:2026-W27", "hand_check_100:2026-06", "big_company_review:2026-H1", "role_review:2026-Q2"]);
    expect(keys("2026-01-01").slice(2)).toEqual(["big_company_review:2026-H1", "role_review:2026-Q1"]);
  });
  it("gives the same keys on every day of a period, so the daily run writes each once", () => {
    expect(keys("2026-11-16")[0]).toBe(keys("2026-11-22")[0]);
    expect(keys("2026-11-01")[1]).toBe(keys("2026-11-30")[1]);
    expect(keys("2026-07-01").slice(2)).toEqual(keys("2026-09-30").slice(2));
    expect(keys("2026-10-01")[3]).not.toBe(keys("2026-09-30")[3]);
  });
  it("adds a big-company name only once its review date has come, never one with no date", () => {
    const names = [{ name: "acme", reviewOn: "2026-11-18" }, { name: "later", reviewOn: "2026-11-19" }, { name: "seeded", reviewOn: null }, { name: "old", reviewOn: "2026-05-01" }];
    const r = dueReminders("2026-11-18", names).slice(4);
    expect(r).toEqual([
      { reason: "big_company_name_review", key: "big_company_name_review:acme:2026-11-18", role: "rules_data_editor", name: "acme", reviewOn: "2026-11-18" },
      { reason: "big_company_name_review", key: "big_company_name_review:old:2026-05-01", role: "rules_data_editor", name: "old", reviewOn: "2026-05-01" },
    ]);
  });
  it("adds a registration body (S6) once its review date has come; the real bodies are not due before their date", () => {
    const r = dueReminders("2027-05-19", [], [{ id: "nmbi", reviewOn: "2027-05-19" }, { id: "coru", reviewOn: "2027-05-20" }]).slice(4);
    expect(r).toEqual([{ reason: "registration_body_review", key: "registration_body_review:nmbi:2027-05-19", role: "rules_data_editor", name: "nmbi", reviewOn: "2027-05-19" }]);
    expect(dueReminders("2026-11-19", []).length).toBe(4);
    expect(dueReminders("2027-05-19", []).slice(4).map((x) => x.name)).toEqual(["nmbi", "medical_council", "coru", "phecc", "psi"]);
  });
  it("gives each reminder its role", () => {
    for (const r of dueReminders("2026-11-18", [{ name: "acme", reviewOn: "2026-01-01" }])) expect(r.role).toBe(REMINDER_ROLE[r.reason]);
    expect(REMINDER_ROLE.role_review).toBe("administrator");
  });
});

describe("workingDayBefore", () => {
  // Irish winter time is UTC, summer time is UTC+1.
  const at = (iso: string) => workingDayBefore(new Date(iso)).toISOString();
  it("is 24 hours back from Tuesday to Friday", () => {
    expect(at("2026-11-18T10:00:00.000Z")).toBe("2026-11-17T10:00:00.000Z"); // Wednesday
    expect(at("2026-11-17T08:30:00.000Z")).toBe("2026-11-16T08:30:00.000Z"); // Tuesday back to Monday
    expect(at("2026-11-20T23:59:00.000Z")).toBe("2026-11-19T23:59:00.000Z"); // Friday
  });
  it("skips the weekend: Monday goes back to Friday at the same time", () => {
    expect(at("2026-11-23T10:00:00.000Z")).toBe("2026-11-20T10:00:00.000Z");
    expect(at("2026-11-23T00:00:00.000Z")).toBe("2026-11-20T00:00:00.000Z");
  });
  it("at the weekend, counts no weekend time: the cut-off is the start of Friday", () => {
    expect(at("2026-11-21T15:00:00.000Z")).toBe("2026-11-20T00:00:00.000Z"); // Saturday
    expect(at("2026-11-22T23:00:00.000Z")).toBe("2026-11-20T00:00:00.000Z"); // Sunday
  });
  it("works on Irish wall time in summer and across the clock change", () => {
    expect(at("2026-07-15T09:00:00.000Z")).toBe("2026-07-14T09:00:00.000Z"); // 10:00 Irish to 10:00 Irish
    expect(at("2026-07-20T00:30:00.000Z")).toBe("2026-07-17T00:30:00.000Z"); // Monday 01:30 Irish to Friday 01:30 Irish
    expect(at("2026-07-18T12:00:00.000Z")).toBe("2026-07-16T23:00:00.000Z"); // Saturday in summer: Friday 00:00 Irish
    // The clocks go back on Sunday 25 October 2026: Monday 26 October 10:00 (UTC) goes back to Friday 23 October 10:00 Irish summer time, 09:00 UTC.
    expect(at("2026-10-26T10:00:00.000Z")).toBe("2026-10-23T09:00:00.000Z");
  });
});
