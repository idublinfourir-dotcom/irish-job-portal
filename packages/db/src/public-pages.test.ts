import { getRules } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { getCompanyPage, getOccupationPage, scopedQuery, summarisePermits, type ListEntry } from "./public-pages";
import { BadSearchInput, encodeCursor, PAGE_SIZE } from "./search";

const NOW = new Date("2026-11-12T10:00:00Z");
const fake = (answers: (text: string) => unknown[] = () => []) => {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  return { calls, query: (async (text: string, values?: unknown[]) => { calls.push({ text, values }); return { rows: answers(text) }; }) as never };
};

describe("summarisePermits", () => {
  it("is null when no DETE name is linked", () => expect(summarisePermits([], NOW)).toBeNull());
  it("keeps 2019 on, finds the peak and the trend of the last full year against the one before", () => {
    const p = summarisePermits([{ year: 2018, month: null, permits: 500 }, { year: 2019, month: null, permits: 3 }, { year: 2024, month: null, permits: 30 }, { year: 2025, month: null, permits: 20 }], NOW)!;
    expect(p.byYear).toEqual([{ year: 2019, permits: 3 }, { year: 2024, permits: 30 }, { year: 2025, permits: 20 }]);
    expect(p.peakYear).toBe(2024);
    expect(p.trend).toBe("down");
    expect(p.latestMonth).toBeNull();
  });
  it("trend: up, flat, and none when neither year had permits", () => {
    const t = (a: number, b: number) => summarisePermits([{ year: 2024, month: null, permits: b }, { year: 2025, month: null, permits: a }], NOW)!.trend;
    expect(t(5, 4)).toBe("up");
    expect(t(4, 4)).toBe("flat");
    expect(summarisePermits([{ year: 2020, month: null, permits: 4 }], NOW)!.trend).toBeNull();
  });
  it("a tie for the peak goes to the later year", () => expect(summarisePermits([{ year: 2022, month: null, permits: 9 }, { year: 2023, month: null, permits: 9 }], NOW)!.peakYear).toBe(2023));
  it("uses the yearly total when there is one, else adds the months, and names the latest month with permits", () => {
    const p = summarisePermits([
      { year: 2025, month: null, permits: 10 }, { year: 2025, month: 3, permits: 4 }, // yearly wins: no double count
      { year: 2026, month: 1, permits: 2 }, { year: 2026, month: 4, permits: 3 }, { year: 2026, month: 6, permits: 0 },
    ], NOW)!;
    expect(p.byYear).toEqual([{ year: 2025, permits: 10 }, { year: 2026, permits: 5 }]);
    expect(p.latestMonth).toEqual({ year: 2026, month: 4, permits: 3 });
  });
  it("a linked company with rows only before 2019 has an empty list, not null", () => {
    expect(summarisePermits([{ year: 2017, month: null, permits: 4 }], NOW)).toMatchObject({ byYear: [], peakYear: null, trend: null });
  });
});

describe("scopedQuery", () => {
  it("binds the scope value and takes the column from a fixed table, never from input", () => {
    const hostile = "1'; drop table job; --";
    const q = scopedQuery("occupation", hostile);
    expect(q.values).toEqual([hostile]);
    expect(q.text).not.toContain("drop");
    expect(q.text).toContain("job.occupation_code = $1::text");
    expect(scopedQuery("company", "5").text).toContain("job.organisation_id = $1::bigint");
  });
  it("asks for one row more than a page, live jobs only, and names its columns", () => {
    const { text } = scopedQuery("company", "5");
    expect(text).toContain(`limit ${PAGE_SIZE + 1}`);
    expect(text).toContain("job.status = 'live' and job.closes_at > now()");
    expect(text).not.toMatch(/select job\.\*|offset/i);
  });
  it("a cursor adds the row comparison and its values after the scope value; a bad cursor throws", () => {
    const token = encodeCursor({ sort: "sponsor", quotaFull: false, keys: ["3", "2026-10-01 10:00:00.5+00"], id: "42" });
    const q = scopedQuery("occupation", "2136", token);
    expect(q.values).toEqual(["2136", true, "3", "2026-10-01 10:00:00.5+00", "42"]);
    expect(q.text).toContain("< ($2::boolean, $3::int, $4::timestamptz, $5::bigint)");
    expect(() => scopedQuery("occupation", "2136", "x")).toThrow(BadSearchInput);
    // a cursor made for the company sort does not fit the occupation sort
    expect(() => scopedQuery("occupation", "2136", encodeCursor({ sort: "newest", quotaFull: false, keys: ["2026-10-01 10:00:00+00"], id: "1" }))).toThrow(BadSearchInput);
  });
});

describe("getCompanyPage", () => {
  it("runs nothing for a bad slug", async () => {
    const db = fake();
    for (const s of ["", "Upper", "a b", "x'--"]) expect(await getCompanyPage(db, s)).toBeNull();
    expect(db.calls).toHaveLength(0);
  });
  it("is not found for an unknown, rejected or closed company, and runs no further statement", async () => {
    expect(await getCompanyPage(fake(), "none")).toBeNull();
    for (const status of ["rejected", "closed"]) {
      const db = fake(() => [{ id: "1", slug: "x", status, merged: false }]);
      expect(await getCompanyPage(db, "x")).toBeNull();
      expect(db.calls).toHaveLength(1);
    }
  });
  it("answers a merged company with the target slug, and runs no job statement", async () => {
    const db = fake(() => [{ id: "1", slug: "old", status: "verified", merged: true, merged_slug: "new" }]);
    expect(await getCompanyPage(db, "old")).toEqual({ merged: "new" });
    expect(db.calls).toHaveLength(1);
  });
});

describe("getOccupationPage", () => {
  const lists: ListEntry[] = [{ code: "1111", title: "T", list: "ineligible" }];
  it("is not found for a code on neither list, with no statement", async () => {
    const db = fake();
    for (const c of ["2222", "11", "abcd", "1111 ", "", "1111;"]) expect(await getOccupationPage(db, c, { lists })).toBeNull();
    expect(db.calls).toHaveLength(0);
  });
  it("the minimums and the date come from the rules in force (#229)", async () => {
    const db = fake((t) => (t.includes("count(*)") ? [{ n: 0 }] : []));
    const today = await getRules();
    const rules = { ...today, minimums: { ...today.minimums, criticalSkills: 45000, nonListRoute: false, checkedOn: "2027-03-01" } };
    const p = await getOccupationPage(db, "2134", { rules });
    expect(p).toMatchObject({ listStatus: "critical-skills", rulesCheckedOn: "2027-03-01", minimums: { withDegree: 45000, withoutDegreeOrNotListed: null, basedOnWeekHours: 39 } });
    expect(p!.standingLine).toContain("Rules last checked on 2027-03-01.");
    expect((await getOccupationPage(db, "2134"))!.minimums).toMatchObject({ withDegree: 40904, withoutDegreeOrNotListed: 68911 });
  });
  it("an ineligible code has no minimums", async () => {
    const p = await getOccupationPage(fake((t) => (t.includes("count(*)") ? [{ n: 0 }] : [])), "1111", { lists });
    expect(p).toMatchObject({ code: "1111", listStatus: "ineligible", minimums: null, text: null });
  });
});
