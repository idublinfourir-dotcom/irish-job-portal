// No database: the body checks of the candidate account routes. Everything that is not exactly a good body is refused (null).
import { describe, expect, it } from "vitest";
import { checkAnswer, checkDelete, checkJobId, checkProfile, checkSettings, checkStage, degreeBox, EXPORT_SQL, exportFilename, isStamp4, STAMPS } from "./candidate";

const check = checkProfile(new Set(["2136", "2229"]));
const good = { fullName: "Fake Person", phone: "+353 1 234 5678", occupationCode: "2136", yearsExperience: 5, hasRelevantDegree: true, degreeField: "Computing",
  degreeAwardedMonth: "2026-05-01", registrationBody: "Engineers Ireland", registrationNumber: "A-12", registrationStatus: "in_progress", locationKind: "ireland", currentStamp: "1G" };

describe("checkProfile", () => {
  it("accepts a full profile and maps it to the columns", () => {
    expect(check(good)).toMatchObject({ full_name: "Fake Person", occupation_code: "2136", years_experience: 5, degree_awarded_month: "2026-05-01", current_stamp: "1G" });
  });
  it("a PUT with keys left out stores them empty", () => {
    const r = check({ fullName: " Ana " });
    expect(r).toMatchObject({ full_name: "Ana", phone: null, current_stamp: null });
    expect(check({})).not.toBeNull();
    expect(check({ phone: null, occupationCode: null })).not.toBeNull();
  });
  it("accepts every stamp in the list, and only those", () => {
    for (const currentStamp of STAMPS) expect(check({ locationKind: "ireland", currentStamp }), currentStamp).not.toBeNull();
    for (const currentStamp of ["7", "4 ", "stamp 4", "", "4EUFAM2", "1g"]) expect(check({ locationKind: "ireland", currentStamp }), currentStamp).toBeNull();
  });
  it("refuses what the table's checks would refuse", () => {
    expect(check({ currentStamp: "1G" })).toBeNull(); // a stamp needs Ireland
    expect(check({ locationKind: "abroad", currentStamp: "1G" })).toBeNull();
    expect(check({ degreeAwardedMonth: "2026-05-01" })).toBeNull(); // a degree date needs a degree
    expect(check({ hasRelevantDegree: false, degreeAwardedMonth: "2026-05-01" })).toBeNull();
    for (const degreeAwardedMonth of ["2026-05-02", "2026-13-01", "2026-00-01", "1949-05-01", "2101-05-01", "2026-5-1", "2026-05-01T00:00", "now()"])
      expect(check({ hasRelevantDegree: true, degreeAwardedMonth }), degreeAwardedMonth).toBeNull();
  });
  it("refuses hostile bodies", () => {
    const bad: unknown[] = [
      null, undefined, "x", 5, [], [good], { ...good, extra: 1 }, { ...good, visibleToEmployers: true }, { ...good, visible_to_employers: true }, { ...good, candidateUserId: "other" },
      { ...good, id: 1 }, JSON.parse('{"__proto__":{"a":1}}'),
      { ...good, fullName: "" }, { ...good, fullName: "  " }, { ...good, fullName: "x".repeat(121) }, { ...good, fullName: 5 }, { ...good, fullName: ["a"] },
      { ...good, fullName: "a\u0000b" }, { ...good, fullName: "a\nb" }, { ...good, fullName: "a‮b" }, { ...good, fullName: "a​b" },
      { ...good, phone: "call me" }, { ...good, phone: "1234" }, { ...good, phone: "1".repeat(31) }, { ...good, phone: "12345; drop table x" },
      { ...good, occupationCode: "9999" }, { ...good, occupationCode: 2136 }, { ...good, occupationCode: "2136 " }, { ...good, occupationCode: "' or 1=1" },
      { ...good, yearsExperience: -1 }, { ...good, yearsExperience: 61 }, { ...good, yearsExperience: 1.5 }, { ...good, yearsExperience: "5" }, { ...good, yearsExperience: NaN },
      { ...good, hasRelevantDegree: "true" }, { ...good, hasRelevantDegree: 1 },
      { ...good, degreeField: "x".repeat(121) }, { ...good, registrationBody: "x".repeat(121) }, { ...good, registrationNumber: "x".repeat(61) },
      { ...good, registrationStatus: "done" }, { ...good, locationKind: "mars" }, { ...good, locationKind: "IRELAND" },
    ];
    for (const b of bad) expect(check(b), JSON.stringify(b)).toBeNull();
  });
});

describe("the small body checks", () => {
  it("checkJobId takes only a bigint-sized text id", () => {
    expect(checkJobId({ jobId: "12" })).toEqual({ jobId: "12" });
    for (const b of [null, [], {}, { jobId: 12 }, { jobId: "0" }, { jobId: "-1" }, { jobId: "1e3" }, { jobId: "9223372036854775808" }, { jobId: "1", userId: "x" }, { jobId: "1; drop table job" }])
      expect(checkJobId(b), JSON.stringify(b)).toBeNull();
  });
  it("checkAnswer takes yes, not_yet or no", () => {
    for (const answer of ["yes", "not_yet", "no"]) expect(checkAnswer({ clickId: "3", answer })).toEqual({ clickId: "3", answer });
    for (const b of [{ clickId: "3" }, { clickId: "3", answer: "maybe" }, { clickId: 3, answer: "yes" }, { clickId: "3", answer: "yes", status: "yes" }, { answer: "yes" }, null])
      expect(checkAnswer(b), JSON.stringify(b)).toBeNull();
  });
  it("checkStage takes a known stage", () => {
    expect(checkStage({ jobId: "3", stage: "interview" })).toEqual({ jobId: "3", stage: "interview" });
    for (const b of [{ jobId: "3" }, { jobId: "3", stage: "hired!" }, { jobId: "3", stage: "Offer" }, { jobId: "3", stage: "offer", origin: "on_site" }, { stage: "offer" }])
      expect(checkStage(b), JSON.stringify(b)).toBeNull();
  });
  it("checkSettings takes the three categories as booleans and never switches the account category off", () => {
    expect(checkSettings({ job_alerts: false })).toEqual({ job_alerts: false });
    expect(checkSettings({ job_alerts: true, apply_reminders: false, account: true })).toEqual({ job_alerts: true, apply_reminders: false, account: true });
    for (const b of [{}, null, [], { account: false }, { job_alerts: false, account: false }, { job_alerts: "no" }, { marketing: true }, { job_alerts: 0 }, { job_alerts: null }])
      expect(checkSettings(b), JSON.stringify(b)).toBeNull();
  });
  it("checkDelete wants { confirm: true } and nothing else", () => {
    expect(checkDelete({ confirm: true })).toEqual({ confirm: true });
    for (const b of [{}, null, { confirm: "true" }, { confirm: 1 }, { confirm: false }, { confirm: true, id: "x" }]) expect(checkDelete(b), JSON.stringify(b)).toBeNull();
  });
  it("Stamp 4 is every stamp that starts with 4", () => {
    expect(STAMPS.filter(isStamp4)).toEqual(["4", "4EUFAM", "4D", "4S"]);
    expect(isStamp4(null)).toBe(false);
  });
});

describe("the data export", () => {
  it("names the file by the UTC date", () => {
    expect(exportFilename(new Date("2026-11-13T23:59:59Z"))).toBe("my-data-2026-11-13.json");
    expect(exportFilename(new Date("2026-11-14T00:00:00Z"))).toBe("my-data-2026-11-14.json");
  });
  it("reads no password, token, key or dedupe column, and filters by the candidate id", () => {
    expect(EXPORT_SQL).not.toMatch(/password|token|storage_key|dedupe_key|unsubscribe/i);
    expect(EXPORT_SQL).not.toMatch(/select \*|\.\*/);
    expect(EXPORT_SQL.match(/\$1/g)!.length).toBeGreaterThanOrEqual(12);
  });
});

describe("degreeBox (S19, #69, #108): the degree box pre-fill from the award month, in Irish time", () => {
  const at = (iso: string) => new Date(iso);
  it("no degree, or no answer, is none whatever the date", () => {
    expect(degreeBox(false, null, at("2026-11-18T12:00:00Z"))).toBe("none");
    expect(degreeBox(null, null, at("2026-11-18T12:00:00Z"))).toBe("none");
    expect(degreeBox(false, "2026-10-01", at("2026-11-18T12:00:00Z"))).toBe("none");
  });
  it("a degree with no date is relevant", () => expect(degreeBox(true, null, at("2026-11-18T12:00:00Z"))).toBe("relevant"));
  it("recent until the same month a year on starts in Dublin (summer time: Dublin is an hour ahead of UTC)", () => {
    expect(degreeBox(true, "2025-05-01", at("2026-04-30T22:59:59Z"))).toBe("last_12_months"); // 23:59:59 on 30 April in Dublin
    expect(degreeBox(true, "2025-05-01", at("2026-04-30T23:00:00Z"))).toBe("relevant"); // already 1 May in Dublin, still April in UTC
  });
  it("winter: Dublin is on UTC", () => {
    expect(degreeBox(true, "2025-12-01", at("2026-11-30T23:59:59Z"))).toBe("last_12_months");
    expect(degreeBox(true, "2025-12-01", at("2026-12-01T00:00:00Z"))).toBe("relevant");
    expect(degreeBox(true, "2025-01-01", at("2025-12-31T23:59:59Z"))).toBe("last_12_months"); // the year turns over
    expect(degreeBox(true, "2025-01-01", at("2026-01-01T00:00:00Z"))).toBe("relevant");
  });
  it("this month and a month still to come are recent; an old degree is relevant", () => {
    expect(degreeBox(true, "2026-11-01", at("2026-11-18T12:00:00Z"))).toBe("last_12_months");
    expect(degreeBox(true, "2027-06-01", at("2026-11-18T12:00:00Z"))).toBe("last_12_months");
    expect(degreeBox(true, "1995-09-01", at("2026-11-18T12:00:00Z"))).toBe("relevant");
  });
});
