// Unit: the cursor token, the salary line, the SQL shapes and the input checks of the Search module. No database (a fake query function).
import { describe, expect, it } from "vitest";
import { BadSearchInput, decodeCursor, encodeCursor, getJob, listJobs, listQuery, salaryLine, SORTS, type Cursor, type Sort } from "./search";

const at = "2026-11-11 14:35:01.123456+00";
const cursorFor = (sort: Sort): Cursor => ({
  sponsor: { sort, quotaFull: false, keys: ["12", at], id: "42" },
  newest: { sort, quotaFull: true, keys: [at], id: "7" },
  salary: { sort, quotaFull: false, keys: ["65000"], id: "9223372036854775807" },
})[sort];
const token = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("cursor", () => {
  it.each(SORTS)("%s: encodes and decodes to the same cursor, keeping the microseconds", (sort) => {
    const c = cursorFor(sort);
    expect(decodeCursor(sort, encodeCursor(c))).toEqual(c);
  });

  it("is URL safe", () => {
    expect(encodeCursor(cursorFor("sponsor"))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(SORTS)("%s: refuses a cursor made for another sort", (sort) => {
    for (const other of SORTS.filter((s) => s !== sort)) expect(() => decodeCursor(sort, encodeCursor(cursorFor(other)))).toThrow(BadSearchInput);
  });

  const good = { s: "sponsor", q: false, k: ["12", at], i: "42" };
  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["not base64url", "a b!"],
    ["too long", "A".repeat(301)],
    ["not JSON", Buffer.from("{nope").toString("base64url")],
    ["null", token(null)],
    ["an array", token([])],
    ["quota not a boolean", token({ ...good, q: "false" })],
    ["too few keys", token({ ...good, k: ["12"] })],
    ["too many keys", token({ ...good, k: ["12", at, "1"] })],
    ["keys not an array", token({ ...good, k: "12" })],
    ["a number key as a number", token({ ...good, k: [12, at] })],
    ["a key under -1", token({ ...good, k: ["-2", at] })],
    ["a key over int range", token({ ...good, k: ["2147483648", at] })],
    ["SQL in a number key", token({ ...good, k: ["1; drop table job", at] })],
    ["SQL in the time key", token({ ...good, k: ["12", "2026-11-11 14:35:01'); drop table job; --"] })],
    ["a month 13", token({ ...good, k: ["12", "2026-13-11 14:35:01+00"] })],
    ["a year before 1970", token({ ...good, k: ["12", "0001-11-11 14:35:01+00"] })],
    ["a time with no zone", token({ ...good, k: ["12", "2026-11-11 14:35:01"] })],
    ["an id of 0", token({ ...good, i: "0" })],
    ["a negative id", token({ ...good, i: "-5" })],
    ["an id over bigint", token({ ...good, i: "9223372036854775808" })],
    ["an id that is a number", token({ ...good, i: 42 })],
    ["an id with SQL", token({ ...good, i: "1 or 1=1" })],
    ["no id", token({ s: "sponsor", q: false, k: ["12", at] })],
  ])("refuses %s", (_name, t) => {
    expect(() => decodeCursor("sponsor", t)).toThrow(BadSearchInput);
  });

  it("accepts the largest bigint id and an ISO time with T and Z", () => {
    expect(decodeCursor("salary", encodeCursor(cursorFor("salary"))).id).toBe("9223372036854775807");
    expect(() => decodeCursor("newest", token({ s: "newest", q: false, k: ["2026-11-11T14:35:01.5Z"], i: "1" }))).not.toThrow();
  });
});

describe("salaryLine", () => {
  it.each([
    [45000, 55000, null, "€45,000 to €55,000"],
    [45000, 45000, null, "€45,000"],
    [45000, null, null, "From €45,000"],
    [null, 55000, null, "Up to €55,000"],
    [null, null, "Grade VII", "Grade VII"],
    [null, null, "", null],
    [null, null, null, null],
    [1234567, null, null, "From €1,234,567"],
    [45000, 55000, "Grade VII", "€45,000 to €55,000"],
  ])("%s %s %s -> %s", (low, high, grade, line) => {
    expect(salaryLine(low, high, grade)).toBe(line);
  });
});

describe("the SQL", () => {
  it.each(SORTS)("%s: the first page is a constant with no parameters, one count from the same walk, no OFFSET and no job.*", (sort) => {
    const q = listQuery(sort);
    expect(q.values).toEqual([]);
    expect(q.text).toMatch(/limit 201\)/);
    expect(q.text).toMatch(/limit 21\)/);
    expect(q.text).not.toMatch(/offset|job\.\*|select \*/i);
  });

  it.each(SORTS)("%s: a next and a previous page are keysets with every value as a parameter", (sort) => {
    const c = cursorFor(sort);
    const next = listQuery(sort, c, "after");
    const prev = listQuery(sort, c, "before");
    expect(next.values).toEqual([!c.quotaFull, ...c.keys, c.id]);
    expect(next.text).toContain(") < (");
    expect(prev.text).toContain(") > (");
    expect(next.text).toMatch(/order by .*job\.id desc limit 21$/);
    expect(prev.text).toMatch(/order by .*job\.id asc limit 21$/);
    expect(next.text).not.toContain(c.id);
    expect(next.text).not.toMatch(/offset|job\.\*/i);
    expect(next.text).toContain("job.status = 'live' and job.closes_at > now()");
  });
});

describe("listJobs input", () => {
  const never = { query: () => Promise.reject(new Error("the database must not be reached")) } as never;
  it("refuses an unknown sort, both directions together, and a bad cursor, before any query", async () => {
    await expect(listJobs(never, { sort: "best" as Sort })).rejects.toThrow(BadSearchInput);
    await expect(listJobs(never, { after: encodeCursor(cursorFor("sponsor")), before: encodeCursor(cursorFor("sponsor")) })).rejects.toThrow(BadSearchInput);
    await expect(listJobs(never, { after: "garbage!" })).rejects.toThrow(BadSearchInput);
    await expect(listJobs(never, { sort: "newest", after: encodeCursor(cursorFor("sponsor")) })).rejects.toThrow(BadSearchInput);
    await expect(listJobs(never, { sort: "salary", before: encodeCursor(cursorFor("newest")) })).rejects.toThrow(BadSearchInput);
  });

  it("defaults to the sponsor sort (#157)", async () => {
    const seen: string[] = [];
    await listJobs({ query: (t: string) => (seen.push(t), Promise.resolve({ rows: [] })) } as never);
    expect(seen[0]).toContain("sponsor_sort");
  });

  it("an empty first page has count 0 and no cursors", async () => {
    expect(await listJobs({ query: () => Promise.resolve({ rows: [] }) } as never)).toEqual({ jobs: [], next: null, previous: null, count: { n: 0, more: false } });
  });
});

describe("getJob input", () => {
  const never = { query: () => Promise.reject(new Error("the database must not be reached")) } as never;
  it.each(["", "0", "-1", "1 or 1=1", "1; drop table job", "9223372036854775808", "99999999999999999999", "1.5", " 1", "0x10", "1e3", "abc", "１２"])(
    "returns null for %j without a query",
    async (id) => {
      expect(await getJob(never, id)).toBeNull();
    },
  );
  it("returns null for a number that is not a whole positive number", async () => {
    expect(await getJob(never, -3)).toBeNull();
    expect(await getJob(never, 1.5)).toBeNull();
    expect(await getJob(never, Number.NaN)).toBeNull();
  });
});
