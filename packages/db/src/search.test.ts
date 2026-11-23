// Unit: the cursor token, the salary line, the SQL shapes and the input checks of the Search module. No database (a fake query function).
import { describe, expect, it } from "vitest";
import { checkAlert } from "./alerts";
import { CONDITIONS, rulesV1 } from "@portal/rules";
import {
  BadSearchInput, card, checkJobFilters, checkSearch, decodeCursor, encodeCursor, filterHash, getJob, listJobs, listQuery, MAX_Q, employerLabels, jobMinimums, parseSearch, payScaleLine, salaryLine, searchParams,
  sectorCounts, sectorCountsQuery, SORTS, toAlertBody, type Cursor, type SearchFilters, type Sort,
} from "./search";

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

  const none = filterHash({});
  const good = { s: "sponsor", q: false, k: ["12", at], i: "42", f: none };
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
    ["no id", token({ s: "sponsor", q: false, k: ["12", at], f: none })],
    ["no filter hash", token({ s: "sponsor", q: false, k: ["12", at], i: "42" })],
    ["another filter hash", token({ ...good, f: filterHash({ county: "Cork" }) })],
    ["a filter hash that is not a string", token({ ...good, f: 1 })],
  ])("refuses %s", (_name, t) => {
    expect(() => decodeCursor("sponsor", t)).toThrow(BadSearchInput);
  });

  it("accepts the largest bigint id and an ISO time with T and Z", () => {
    expect(decodeCursor("salary", encodeCursor(cursorFor("salary"))).id).toBe("9223372036854775807");
    expect(() => decodeCursor("newest", token({ s: "newest", q: false, k: ["2026-11-11T14:35:01.5Z"], i: "1", f: none }))).not.toThrow();
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
    expect(next.text).toMatch(/order by .*job\.id desc limit 21\)/);
    expect(prev.text).toMatch(/order by .*job\.id asc limit 21\)/);
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

// ===== S1, S2 (#247): the filters =====
const url = (s: string) => parseSearch(new URLSearchParams(s));
const refused = (s: string) => expect(() => url(s), s).toThrow(BadSearchInput);

describe("parseSearch", () => {
  it("reads each filter, and nothing set means no filters", () => {
    expect(url("")).toEqual({});
    expect(url("q=nurse")).toEqual({ q: "nurse" });
    expect(url("occupationCode=2231")).toEqual({ occupationCode: "2231" });
    expect(url("sector=IT")).toEqual({ sector: "IT" });
    expect(url("sector=pharma+and+science")).toEqual({ sector: "pharma and science" });
    expect(url("county=Cork")).toEqual({ county: "Cork" });
    expect(url("salaryMin=0")).toEqual({ salaryMin: 0 });
    expect(url("salaryMin=1000000")).toEqual({ salaryMin: 1_000_000 });
    expect(url("badge=sponsor_confirmed")).toEqual({ badge: "sponsor_confirmed" });
    expect(url("badge=critical_skills_eligible")).toEqual({ badge: "critical_skills_eligible" }); // B9
    for (const d of [1, 3, 7, 30]) expect(url(`postedWithin=${d}`)).toEqual({ postedWithin: d });
    expect(url("salaryStated=true")).toEqual({ salaryStated: true });
    expect(url("q=nurse&occupationCode=2231&sector=health&county=Dublin&salaryMin=40000&badge=sponsor_confirmed&postedWithin=7&salaryStated=true")).toEqual({
      q: "nurse", occupationCode: "2231", sector: "health", county: "Dublin", salaryMin: 40000, badge: "sponsor_confirmed", postedWithin: 7, salaryStated: true,
    });
  });

  it("an empty value means any, and a keyword is trimmed", () => {
    expect(url("q=&sector=&county=&salaryMin=&badge=&postedWithin=&salaryStated=&occupationCode=")).toEqual({});
    expect(url("q=%20%20nurse%20")).toEqual({ q: "nurse" });
    expect(url("q=%20%20%20")).toEqual({});
  });

  it("ignores keys it does not know (sort, cursors, tracking tags)", () => {
    expect(url("sort=salary&after=abc&utm_source=x&county=Cork")).toEqual({ county: "Cork" });
  });

  it.each([
    "sector=it", "sector=Health", "sector=nothing", "county=Narnia", "county=cork", "occupationCode=9999", "occupationCode=22", "salaryMin=-1",
    "salaryMin=1000001", "salaryMin=2.5", "salaryMin=1e5", "salaryMin=abc", "salaryMin=%2010", "badge=other", "badge=Critical_Skills_Eligible",
    "postedWithin=2", "postedWithin=0", "postedWithin=365", "postedWithin=x", "salaryStated=1", "salaryStated=false", "salaryStated=yes",
    "county=Cork&county=Dublin", "q=a&q=b", "sector=IT&sector=",
  ])("refuses %s", (s) => refused(s));

  it("caps the keyword at 200 characters, counted after trimming", () => {
    expect(url(`q=${"a".repeat(MAX_Q)}`).q).toHaveLength(MAX_Q);
    expect(url(`q=${"a".repeat(MAX_Q)}%20%20`).q).toHaveLength(MAX_Q);
    refused(`q=${"a".repeat(MAX_Q + 1)}`);
    refused(`q=${"a".repeat(100_000)}`);
  });

  it.each(["%00", "a%00b", "a%0Ab", "a%0Db", "a%09b", "%1B%5B31m", "a%7Fb", "a%C2%85b"])("refuses the control character in %s", (q) => refused(`q=${q}`));

  it("keeps hostile but printable text as it is: it only ever goes to the database as a parameter", () => {
    for (const q of ["'; drop table job; --", "nurse -cook", '"senior nurse"', "nurse or cook", "\u202Eesrun", "nu\u200Brse", "nu\uFEFFrse", ") or 1=1 --", "$1", "%", "_"])
      expect(url(`q=${encodeURIComponent(q)}`)).toEqual({ q });
  });

  it("is the inverse of searchParams", () => {
    const f: SearchFilters = { q: "nurse & cook", occupationCode: "2231", sector: "construction and engineering", county: "Dublin", salaryMin: 40000, badge: "sponsor_confirmed", postedWithin: 30, salaryStated: true };
    expect(parseSearch(searchParams(f))).toEqual(f);
    expect(parseSearch(searchParams({}))).toEqual({});
  });
});

describe("checkSearch (what listJobs runs on its filters)", () => {
  it("refuses unknown keys, wrong types and non-objects; false salaryStated means any", () => {
    for (const f of [null, [], "x", 5, { nope: 1 }, { sort: "salary" }, { q: 5 }, { salaryMin: "5" }, { postedWithin: "7" }, { salaryStated: "true" }, { salaryStated: 1 }, { sector: "it" }])
      expect(() => checkSearch(f), JSON.stringify(f)).toThrow(BadSearchInput);
    expect(checkSearch(undefined)).toEqual({});
    expect(checkSearch({ salaryStated: false, county: null, q: " " })).toEqual({});
  });
});

describe("the alert filters are one check for search and alerts", () => {
  const occ = new Set(["2231"]);
  const alertOf = checkAlert(occ);
  const cases: Record<string, unknown>[] = [
    {}, { occupationCode: "2231" }, { occupationCode: "1122" }, { sector: "IT" }, { sector: "it" }, { county: "Cork" }, { county: "Narnia" }, { salaryMin: 0 },
    { salaryMin: -1 }, { salaryMin: 1_000_001 }, { salaryMin: 2.5 }, { badge: "sponsor_confirmed" }, { badge: "critical_skills_eligible" },
    { sector: "health", county: "Dublin", salaryMin: 40000, badge: "sponsor_confirmed", occupationCode: "2231" },
  ];
  it.each(cases)("%j: accepted by both or by neither, with the same values", (b) => {
    const shared = checkJobFilters(b, occ);
    const a = alertOf({ ...b, frequency: "daily" });
    expect(a === null).toBe(shared === null);
    if (shared && a) expect({ occupationCode: a.occupation_code, sector: a.sector, county: a.county, salaryMin: a.salary_min, badge: a.badge }).toEqual(shared);
  });
  it("a search's alert filters are a body checkAlert accepts with the same values; q, postedWithin and salaryStated are left out", () => {
    const f = url("q=nurse&occupationCode=2231&sector=health&county=Dublin&salaryMin=40000&badge=sponsor_confirmed&postedWithin=7&salaryStated=true");
    expect(toAlertBody(f)).toEqual({ occupationCode: "2231", sector: "health", county: "Dublin", salaryMin: 40000, badge: "sponsor_confirmed" });
    expect(alertOf({ ...toAlertBody(f), frequency: "weekly" })).toEqual({ occupation_code: "2231", sector: "health", county: "Dublin", salary_min: 40000, badge: "sponsor_confirmed", frequency: "weekly" });
    expect(alertOf({ ...toAlertBody({}), frequency: "daily" })).toEqual({ occupation_code: null, sector: null, county: null, salary_min: null, badge: null, frequency: "daily" });
  });
});

describe("a cursor is tied to its filters", () => {
  const c = cursorFor("newest");
  it("decodes only with the filter set it was made with", () => {
    const a: SearchFilters = { county: "Cork" }, b: SearchFilters = { county: "Dublin" };
    const t = encodeCursor(c, filterHash(a));
    expect(decodeCursor("newest", t, filterHash(a))).toEqual(c);
    for (const other of [{}, b, { county: "Cork", q: "nurse" }, { q: "Cork" }]) expect(() => decodeCursor("newest", t, filterHash(other))).toThrow(BadSearchInput);
    expect(() => decodeCursor("newest", encodeCursor(c))).not.toThrow();
    expect(() => decodeCursor("newest", encodeCursor(c), filterHash(a))).toThrow(BadSearchInput);
  });
  it("the hash depends on the values, not the order the keys were given in", () => {
    expect(filterHash({ county: "Cork", sector: "IT" })).toBe(filterHash({ sector: "IT", county: "Cork" }));
    expect(filterHash({ salaryMin: 1 })).not.toBe(filterHash({ postedWithin: 1 }));
  });
  it("listJobs refuses a cursor from another filter set before any query", async () => {
    const never = { query: () => Promise.reject(new Error("the database must not be reached")) } as never;
    await expect(listJobs(never, { sort: "newest", after: encodeCursor(c), filters: { county: "Cork" } })).rejects.toThrow(BadSearchInput);
    await expect(listJobs(never, { sort: "newest", before: encodeCursor(c, filterHash({ county: "Cork" })) })).rejects.toThrow(BadSearchInput);
    await expect(listJobs(never, { filters: { county: "Narnia" } as never })).rejects.toThrow(BadSearchInput);
  });
});

describe("the filter SQL", () => {
  const all: SearchFilters = { q: "x'); drop table job; --", occupationCode: "2231", sector: "IT", county: "Cork", salaryMin: 40000, badge: "sponsor_confirmed", postedWithin: 7, salaryStated: true };
  it.each(SORTS)("%s: every filter value is a parameter, on the first page and on a cursor page", (sort) => {
    const first = listQuery(sort, undefined, "after", all);
    expect(first.values).toEqual(["x'); drop table job; --", "2231", "IT", "Cork", 40000, "sponsor_confirmed", 7]);
    const next = listQuery(sort, cursorFor(sort), "after", all);
    const c = cursorFor(sort);
    expect(next.values).toEqual([!c.quotaFull, ...c.keys, c.id, ...first.values]);
    for (const q of [first, next]) {
      for (const v of first.values) if (typeof v === "string") expect(q.text).not.toContain(v);
      expect(q.text).toContain("websearch_to_tsquery('english', $");
      expect(q.text).toContain("job.status = 'live' and job.closes_at > now()");
      expect(q.text).not.toMatch(/offset|job\.\*/i);
    }
    expect(first.text).toMatch(/limit 201\)/);
    // the keyword is one GIN match in its own CTE, and a cursor page walks ids only, then reads its 21 rows
    expect(first.text).toMatch(/^with kw as materialized \(select id from job where status = 'live' and search_vector @@ websearch_to_tsquery/);
    expect(next.text).toContain("page as materialized (select job.id from job where");
    expect(listQuery(sort, cursorFor(sort), "after", { county: "Cork" }).text).toMatch(/^with page as materialized \(select job\.id from job where/);
  });
});

describe("sectorCounts", () => {
  it("lists every sector in order, zero included, and ignores a stored sector outside the list", async () => {
    const db = { query: () => Promise.resolve({ rows: [{ sector: "IT", n: 5 }, { sector: "it", n: 2 }, { sector: "health", n: 1 }] }) } as never;
    expect(await sectorCounts(db)).toEqual([
      { sector: "health", jobs: 1 }, { sector: "IT", jobs: 5 }, { sector: "construction and engineering", jobs: 0 }, { sector: "finance", jobs: 0 },
      { sector: "care", jobs: 0 }, { sector: "hospitality", jobs: 0 }, { sector: "pharma and science", jobs: 0 }, { sector: "other", jobs: 0 },
    ]);
  });
});

describe("sectorCountsQuery (B11)", () => {
  it("is the live jobs grouped by sector, every filter a parameter", () => {
    const q = sectorCountsQuery({ county: "Cork", salaryMin: 40000, badge: "critical_skills_eligible", postedWithin: 7, salaryStated: true, occupationCode: "2231" });
    expect(q.text).toMatch(/^select job\.sector, count\(\*\)::int as n from job where job\.status = 'live' and job\.closes_at > now\(\)/);
    expect(q.text).toMatch(/group by job\.sector$/);
    expect(q.values).toEqual(["2231", "Cork", 40000, "critical_skills_eligible", 7]);
    expect(q.text).not.toContain("Cork");
  });
  it("leaves the sector filter out, so the other sectors show what they would give", () => {
    expect(sectorCountsQuery({ sector: "IT", county: "Cork" }).values).toEqual(["Cork"]);
    expect(sectorCountsQuery({ sector: "IT" }).text).not.toContain("job.sector =");
  });
  it("a keyword is one materialized match, and a hostile keyword stays a parameter", () => {
    const q = sectorCountsQuery({ q: "x'); drop table job; --" });
    expect(q.text).toMatch(/^with kw as materialized \(select id from job where status = 'live' and search_vector @@ websearch_to_tsquery\('english', \$1::text\)\) select/);
    expect(q.text).not.toContain("drop");
  });
  it("refuses a bad filter before any statement", async () => {
    await expect(sectorCounts({ query: () => { throw new Error("ran"); } } as never, { county: "Narnia" } as never)).rejects.toThrow(BadSearchInput);
  });
  it("without filters it asks for all live jobs", async () => {
    const seen: unknown[][] = [];
    await sectorCounts({ query: (t: string, v: unknown[]) => (seen.push([t, v]), Promise.resolve({ rows: [] })) } as never);
    expect(seen).toEqual([[sectorCountsQuery().text, []]]);
  });
});

describe("job card fields (B7)", () => {
  const row = {
    id: "5", title: "Nurse", employer_name: "Fake Care Ltd", county: "Cork", salary_low: null, salary_high: null, pay_grade: "NURSE-1", pass_route: "public_pay", badge: null,
    quota_full: true, posted_at: new Date("2026-11-01T00:00:00Z"), posted_text: "x", sponsor_sort: 3, salary_sort: 0, last_ok_at: null,
    contract_months: 24, permit_history: "has_history", source: "employer", employer_slug: "fake-care", employer_logo_url: null,
  };
  const scale = { code: "NURSE-1", title: "Staff nurse", firstEur: 33000, lastEur: 50000, sourceUrl: "https://example.test", sourcePage: 1 };
  it("carries the new fields, and the pay scale line only when the grade is a scale of the rules in force", async () => {
    const rules = { ...(await rulesV1()), payScales: [scale] };
    expect(card(row, rules)).toMatchObject({
      contractMonths: 24, permitHistory: "has_history", source: "employer", employerSlug: "fake-care", employerLogoUrl: null, quotaFull: true,
      payScaleLine: "Pay scale for this grade: EUR 33,000 to 50,000",
    });
    expect(card(row).payScaleLine).toBeNull();
    expect(card({ ...row, pay_grade: "Grade 5 (free text)" }, rules).payScaleLine).toBeNull();
    expect(payScaleLine(rules, null)).toBeNull();
  });
});

describe("job page fields (B6)", () => {
  it("jobMinimums: nonList is null when that route is off, the General figures null until a version has them", async () => {
    const m = (await rulesV1()).minimums;
    expect(jobMinimums({ ...m, nonListRoute: false }).nonList).toBeNull();
    expect(jobMinimums(m)).toMatchObject({ criticalSkills: m.criticalSkills, graduate: m.graduate, nonList: m.nonList, general: null, generalLower: null, generalLowerCodes: null });
    expect(jobMinimums({ ...m, general: 36605, generalLower: 34000, generalLowerCodes: ["6145"], generalQuotaFullCodes: [] })).toMatchObject({ general: 36605, generalLowerCodes: ["6145"] });
  });
  it("employerLabels follows the company page rule", () => {
    expect(employerLabels("has_history", null)).toEqual([]);
    expect(employerLabels("first_time", null)).toEqual(["First-time sponsor"]);
    expect(employerLabels("not_linked", new Date())).toEqual(["Permit history not linked yet", "Sponsorship claims removed"]);
  });
  it("CONDITIONS is the one list the portal and the job read share", () => expect(CONDITIONS["6145"]).toContain("private household"));
});
