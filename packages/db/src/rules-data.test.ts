// No database: the rules data checks, the change shown to staff, the seed's values against the files and constants, and the daily run's pay rule.
// The end-to-end runs are packages/db/test/rules-versions.test.ts.
import { readFileSync } from "node:fs";
import * as R from "@portal/rules";
import { describe, expect, it } from "vitest";
import { diffVersion, hourlyOf } from "./rules-admin";
import { BadRulesData, cleanData, type BigName, type Minimums } from "./rules-data";
import { belowMinimum, main as runMain } from "./rules-run-cli.ts";
import { brandList, main as seedMain, seedData } from "./rules-seed-cli.ts";

const M: Minimums = { criticalSkills: 40904, graduate: 36848, graduateMonths: 12, nonList: 68911, nonListRoute: true, minContractMonths: 24, standardWeekHours: 39, checkedOn: "2026-11-12" };
const bad = (kind: Parameters<typeof cleanData>[0], v: unknown) => { try { cleanData(kind, v); return "ok"; } catch (e) { return e instanceof BadRulesData ? "bad" : "other"; } };
const big = (name: string, o: Partial<BigName> = {}): BigName => ({ name, test: "brand", link: null, readOn: null, reviewOn: null, ...o });

describe("the seed gives exactly today's values", () => {
  const s = seedData();
  it("the minimums are the constants", () => {
    expect(s.minimums).toEqual({ criticalSkills: R.CRITICAL_SKILLS_MINIMUM, graduate: R.GRADUATE_MINIMUM, graduateMonths: R.GRADUATE_MONTHS, nonList: R.NON_LIST_MINIMUM,
      nonListRoute: R.NON_LIST_ROUTE, minContractMonths: R.MIN_CONTRACT_MONTHS, standardWeekHours: R.STANDARD_WEEK_HOURS, checkedOn: R.RULES_CHECKED_ON });
  });
  it("the two occupation lists, put back together, are the file; the public pay employers are the file", () => {
    const file = JSON.parse(readFileSync(new URL("../../fetcher/data/occupation-lists.json", import.meta.url), "utf8"));
    expect([...(s.critical_skills_list as unknown[]), ...(s.ineligible_list as unknown[])]).toEqual(file);
    expect((s.critical_skills_list as unknown[]).length).toBe(59);
    expect((s.ineligible_list as unknown[]).length).toBe(188);
    expect(s.public_pay_employers).toEqual(JSON.parse(readFileSync(new URL("../../fetcher/data/L2/public_employers_candidates.json", import.meta.url), "utf8")));
  });
  it("the big-company names are BIG_COMPANY_BRANDS then BIG_COMPANY_LIST_150, each with its test", () => {
    const names = s.big_company_names as BigName[];
    expect(names.map((e) => e.name)).toEqual([...R.BIG_COMPANY_BRANDS, ...R.BIG_COMPANY_LIST_150]);
    expect(names.filter((e) => e.test === "brand").length).toBe(42);
    expect(names.filter((e) => e.test === "250_staff").map((e) => e.name).sort()).toEqual(["chemist warehouse", "mccabes pharmacy", "mccauley"]);
    expect(names.every((e) => e.link === null && e.readOn === null && e.reviewOn === null)).toBe(true);
    for (const e of names) expect(R.cleanEmployerName(e.name), e.name).toBe(e.name);
  });
  it("brandList refuses a changed file shape rather than guessing", () => {
    expect(() => brandList("", "BIG_COMPANY_BRANDS")).toThrow(/not found/);
    expect(() => brandList("export const X: readonly string[] = [];", "X")).toThrow(/not a list/);
    expect(brandList('export const X: readonly string[] = [\n  "a", "b",\n];', "X")).toEqual(["a", "b"]);
  });
});

describe("cleanData", () => {
  it("takes good data of each kind and drops nothing", () => {
    expect(cleanData("minimums", M)).toEqual(M);
    expect(cleanData("public_pay_employers", { "hse": { tier: 1 }, "x y": { tier: 2, note: "n" } })).toEqual({ "hse": { tier: 1 }, "x y": { tier: 2, note: "n" } });
    expect(cleanData("big_company_names", [big("a b", { link: "https://example.test/x", readOn: "2026-11-01", reviewOn: "2027-11-01" })])).toHaveLength(1);
  });
  it("refuses a missing, zero, negative, fractional or text minimum and unknown fields", () => {
    for (const k of Object.keys(M)) { const m: Record<string, unknown> = { ...M }; delete m[k]; expect(bad("minimums", m), k).toBe("bad"); }
    for (const v of [0, -1, 1.5, "40904", null, 2_000_000]) expect(bad("minimums", { ...M, criticalSkills: v }), String(v)).toBe("bad");
    expect(bad("minimums", { ...M, extra: 1 })).toBe("bad");
    expect(bad("minimums", { ...M, nonListRoute: "yes" })).toBe("bad");
    for (const d of ["2026-02-30", "26-11-12", "2026-11-12T00:00", ""]) expect(bad("minimums", { ...M, checkedOn: d }), d).toBe("bad");
    for (const v of [null, [], "x", 1]) expect(bad("minimums", v)).toBe("bad");
  });
  it("the four General permit fields are optional, all or none (version 1 has none)", () => {
    const G = { general: R.GENERAL_MINIMUM, generalLower: R.GENERAL_LOWER_MINIMUM, generalLowerCodes: [...R.GENERAL_LOWER_CODES], generalQuotaFullCodes: [] as string[] };
    expect(cleanData("minimums", M)).toEqual(M); // no General fields in, none out
    expect(Object.keys(cleanData("minimums", M) as object)).toHaveLength(8);
    expect(cleanData("minimums", { ...M, ...G })).toEqual({ ...M, ...G });
    expect(cleanData("minimums", { ...M, ...G, generalQuotaFullCodes: ["6145", "5434"] })).toMatchObject({ generalQuotaFullCodes: ["6145", "5434"] });
    for (const k of Object.keys(G)) { const m: Record<string, unknown> = { ...M, ...G }; delete m[k]; expect(bad("minimums", m), `without ${k}`).toBe("bad"); }
    for (const k of Object.keys(G)) expect(bad("minimums", { ...M, [k]: (G as Record<string, unknown>)[k] }), `only ${k}`).toBe("bad");
    for (const v of [0, -1, 1.5, "36605", null, 2_000_000]) { expect(bad("minimums", { ...M, ...G, general: v })).toBe("bad"); expect(bad("minimums", { ...M, ...G, generalLower: v })).toBe("bad"); }
    for (const v of [null, "6145", ["614"], ["61456"], ["61a5"], [6145], ["6145", "6145"], [["6145"]], { 0: "6145" }, Array(201).fill("6145")])
      for (const k of ["generalLowerCodes", "generalQuotaFullCodes"]) expect(bad("minimums", { ...M, ...G, [k]: v }), `${k} ${JSON.stringify(v)?.slice(0, 20)}`).toBe("bad");
    expect(bad("minimums", { ...M, ...G, generalExtra: 1 })).toBe("bad");
  });
  it("refuses an empty list, a duplicate, a wrong list name, a bad code and control or format characters", () => {
    const e = { id: "cs-1122", code: "1122", title: "Site Manager", list: "critical-skills" };
    expect(bad("critical_skills_list", [e])).toBe("ok");
    for (const v of [[], {}, null, [e, e], [{ ...e, list: "ineligible" }], [{ ...e, code: "112" }], [{ ...e, code: "11a2" }], [{ ...e, title: "" }],
      [{ ...e, title: "a‮b" }], [{ ...e, title: "a\u0000b" }], [{ ...e, extra: 1 }], [{ ...e, id: "Bad Id" }]]) expect(bad("critical_skills_list", v), JSON.stringify(v)).toBe("bad");
    expect(bad("ineligible_list", [e])).toBe("bad");
    expect(bad("public_pay_employers", {})).toBe("bad");
    for (const v of [{ HSE: { tier: 1 } }, { " hse": { tier: 1 } }, { hse: { tier: 3 } }, { hse: { tier: 1, x: 1 } }, { hse: { tier: 1, note: "a​b" } }]) expect(bad("public_pay_employers", v), JSON.stringify(v)).toBe("bad");
  });
  it("big-company names must be cleaned, with a known test, an https link and real dates", () => {
    for (const v of [[big("Google")], [big("a  b")], [big(" a")], [big("a-b")], [big("a", { test: "other" as never })], [big("a", { link: "http://x.test" })],
      [big("a", { link: "javascript:alert(1)" })], [big("a", { readOn: "2026-13-01" })], [big("a"), big("a")], []]) expect(bad("big_company_names", v), JSON.stringify(v)).toBe("bad");
  });
});

describe("diffVersion", () => {
  it("shows entries added, removed and changed, whatever the key order", () => {
    const d = diffVersion("big_company_names", [big("a"), big("b")], [big("b", { test: "250_staff" }), big("c")]);
    expect(Object.keys(d.added)).toEqual(["c"]);
    expect(Object.keys(d.removed)).toEqual(["a"]);
    expect(d.changed.b).toEqual({ before: big("b"), after: big("b", { test: "250_staff" }) });
    expect(diffVersion("minimums", M, { ...M, criticalSkills: 42000 }).changed).toEqual({ criticalSkills: { before: 40904, after: 42000 } });
    expect(diffVersion("public_pay_employers", { a: { tier: 1, note: "n" } }, { a: { note: "n", tier: 1 } })).toEqual({ added: {}, removed: {}, changed: {} });
    expect(Object.keys(diffVersion("minimums", null, M).added).length).toBe(8);
  });
});

describe("the daily run's pay rule (as the posting check)", () => {
  const cs = new Set(["2136"]);
  const job = (o: object) => ({ id: "1", occupation_code: "2136", salary_low: 40000, salary_high: null, health_insurance_eur: null, weekly_hours: 39, ...o });
  it("counts the top of the range plus health insurance, against the minimum for the hours, with >=", () => {
    expect(belowMinimum(job({ salary_low: 40904 }), M, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: 40903 }), M, cs)).toBe(true);
    expect(belowMinimum(job({ salary_low: 30000, salary_high: 41000 }), M, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: 40000, health_insurance_eur: 904 }), M, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: 40904, weekly_hours: 40 }), M, cs)).toBe(true); // 40 hours need 41,953.60
    expect(belowMinimum(job({ salary_low: 41954, weekly_hours: 40 }), M, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: 40904, weekly_hours: null }), M, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: null }), M, cs)).toBe(true);
  });
  it("a role not on the Critical Skills list needs the non-list minimum, and fails when that route is closed", () => {
    expect(belowMinimum(job({ occupation_code: "9999", salary_low: 68911 }), M, cs)).toBe(false);
    expect(belowMinimum(job({ occupation_code: "9999", salary_low: 68910 }), M, cs)).toBe(true);
    expect(belowMinimum(job({ occupation_code: "9999", salary_low: 90000 }), { ...M, nonListRoute: false }, cs)).toBe(true);
  });
});

describe("the daily run's pay rule for a General post", () => {
  const cs = new Set(["2136"]);
  const G: Minimums = { ...M, general: R.GENERAL_MINIMUM, generalLower: R.GENERAL_LOWER_MINIMUM, generalLowerCodes: ["6145"], generalQuotaFullCodes: [] };
  const job = (o: object) => ({ id: "1", permit_type: "general", occupation_code: "6145", salary_low: 33000, salary_high: null, health_insurance_eur: null, weekly_hours: 39, ...o });
  it("uses the General minimum, not the Critical Skills one", () => {
    expect(belowMinimum(job({}), G, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: 32690 }), G, cs)).toBe(true);
    expect(belowMinimum(job({ occupation_code: "3545", salary_low: 36604 }), G, cs)).toBe(true);
    expect(belowMinimum(job({ occupation_code: "3545", salary_low: 36605 }), G, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: 30000, salary_high: 32691 }), G, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: 31000, health_insurance_eur: 1691 }), G, cs)).toBe(false);
    expect(belowMinimum(job({ salary_low: null }), G, cs)).toBe(true);
    expect(belowMinimum(job({ permit_type: "critical_skills" }), G, cs)).toBe(true); // the same pay on a Critical Skills post is below 68,911
  });
  it("stays live when the minimums in force have no General figures", () => {
    expect(belowMinimum(job({}), M, cs)).toBe(false);
  });
});

describe("the two commands' arguments", () => {
  it("refuse arguments and a missing login, without connecting", async () => {
    const lines: string[] = [];
    expect(await seedMain(["x"], {}, (l) => lines.push(l))).toBe(2);
    expect(await seedMain([], {}, (l) => lines.push(l))).toBe(2);
    expect(await runMain(["x"], {}, (l) => lines.push(l))).toBe(2);
    expect(await runMain([], {}, (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual(["usage: rules-seed-cli.ts (no arguments)", "DATABASE_URL_MIGRATE is not set (the owner's login, as for migrations)",
      "usage: rules-run-cli.ts (no arguments)", "RULES_ADMIN_DATABASE_URL is not set (the app_admin login)"]);
  });
});

describe("pay-deal entries (B66)", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e.pdf";
  const ev = (o: object = {}) => ({ kind: "service_arrangement", link: "https://example.test/a", file: { id, name: "a.pdf" }, ...o });
  const e = (o: object = {}) => ({ tier: 2, note: "n", bodyType: "section_38", evidence: ev(), addedOn: "2026-11-25", addedBy: "staff_1", ...o });
  it("keeps the checked fields, drops on: true (on is the default) and keeps on: false; an old entry (tier and note) is unchanged", () => {
    expect(cleanData("public_pay_employers", { a: e({ on: true }), b: e({ on: false }), c: { tier: 1 } })).toEqual({ a: e(), b: e({ on: false }), c: { tier: 1 } });
    expect(cleanData("public_pay_employers", { a: e({ evidence: ev({ file: null }) }) })).toEqual({ a: e({ evidence: ev({ file: null }) }) });
  });
  it("refuses unknown fields, body types and evidence kinds, a bad link, a file id that is a path or another prefix, no link and no file, and a list with every entry off", () => {
    for (const x of [e({ extra: 1 }), e({ bodyType: "Section 38" }), e({ on: "no" }), e({ on: null }), e({ addedOn: "2026-02-30" }), e({ addedBy: "a b" }), e({ addedBy: 5 }), e({ evidence: null }),
      e({ evidence: [] }), e({ evidence: ev({ kind: "hearsay" }) }), e({ evidence: ev({ link: "http://example.test/a" }) }), e({ evidence: ev({ link: "javascript:alert(1)" }) }),
      e({ evidence: ev({ link: undefined }) }), e({ evidence: ev({ extra: 1 }) }), e({ evidence: ev({ link: null, file: null }) }),
      ...["cv/" + id, "../" + id, id + ".html", id.replace(".pdf", ".exe"), id.toUpperCase(), "", 5].map((bad_) => e({ evidence: ev({ file: { id: bad_, name: "a.pdf" } }) })),
      e({ evidence: ev({ file: { id, name: "a\u202e.pdf" } }) }), e({ evidence: ev({ file: { id, name: "x".repeat(201) } }) }), e({ evidence: ev({ file: { id } }) }),
      e({ on: false })]) expect(bad("public_pay_employers", { a: x }), JSON.stringify(x)).toBe("bad");
  });
});

describe("the hourly figure (B64)", () => {
  it("is the yearly minimum over 52 weeks of the standard week, to the cent; the General figures only when the version has them", () => {
    expect(hourlyOf({ ...M, general: 36605, generalLower: 32691, generalLowerCodes: ["6145"], generalQuotaFullCodes: [] })).toEqual({ criticalSkills: 20.17, graduate: 18.17, nonList: 33.98, general: 18.05, generalLower: 16.12 });
    expect(hourlyOf({ ...M, standardWeekHours: 40 })).toEqual({ criticalSkills: 19.67, graduate: 17.72, nonList: 33.13 });
  });
});

describe("pay scales (#269)", () => {
  const V1 = JSON.parse(readFileSync(new URL("../../rules/data/pay-scales-v1.json", import.meta.url), "utf8")) as R.PayScale[];
  const g = (o: Record<string, unknown> = {}) => ({ code: "2135", title: "Staff Nurse", firstEur: 38166, lastEur: 56592, sourceUrl: "https://example.test/p.pdf", sourcePage: 14, ...o });
  it("version 1 (40 health grades from the HSE 1 June 2026 scales) passes its own check unchanged", () => {
    expect(cleanData("pay_scales", V1)).toEqual(V1);
    expect(V1).toHaveLength(40);
    expect(V1.every((e) => e.firstEur <= e.lastEur && e.sourceUrl.startsWith("https://assets.hse.ie/") && e.sourcePage > 0)).toBe(true);
    expect(V1.filter((e) => e.note).map((e) => e.code)).toEqual(["2283", "2280", "2135", "2674", "2143"]); // the adaptation placement note on nurse grades
    expect(V1.some((e) => ["2861", "2635"].includes(e.code))).toBe(false); // adaptation and awaiting-registration pay: not a permit job
  });
  it("keeps the checked fields only and the note when there is one", () => {
    expect(cleanData("pay_scales", [g({ note: "Fake note" })])).toEqual([g({ note: "Fake note" })]);
    expect(cleanData("pay_scales", [g({ firstEur: 59278, lastEur: 59278 })])).toHaveLength(1); // a one-point scale
  });
  it("refuses an empty or broken list: bad codes, a scale out of order, links, pages, text and duplicates", () => {
    for (const v of [[], {}, null, "x", [g({ code: "" })], [g({ code: "2135' or 1=1" })], [g({ code: "abcd" })], [g({ code: "A".repeat(13) })],
      [g({ firstEur: 60000, lastEur: 50000 })], [g({ firstEur: 0 })], [g({ lastEur: 1_000_001 })], [g({ firstEur: 38166.5 })], [g({ firstEur: "38166" })],
      [g({ sourceUrl: "http://example.test/p.pdf" })], [g({ sourceUrl: "javascript:alert(1)" })], [g({ sourcePage: 0 })], [g({ sourcePage: "14" })],
      [g({ title: "" })], [g({ title: "x".repeat(201) })], [g({ title: "Fake‮title" })], [g({ note: "Fake\u0007" })], [g({ note: 5 })],
      [g({ extra: 1 })], [{ code: "2135" }], [g(), g()], Array.from({ length: 2001 }, (_, i) => g({ code: `G${i}` }))]) expect(bad("pay_scales", v), JSON.stringify(v).slice(0, 80)).toBe("bad");
  });
  it("the change shown to staff is keyed by grade code", () => {
    const d = diffVersion("pay_scales", [g(), g({ code: "2674" })], [g({ lastEur: 57000 }), g({ code: "1012" })]);
    expect([Object.keys(d.added), Object.keys(d.removed), Object.keys(d.changed)]).toEqual([["1012"], ["2674"], ["2135"]]);
  });
  it("checkSnapshot refuses an empty pay scales list and accepts none at all (no version yet)", async () => {
    const s = await R.rulesV1();
    expect(R.checkSnapshot({ ...s, payScales: V1 })).toBeTruthy();
    expect(R.checkSnapshot(s).payScales).toBeUndefined();
    expect(() => R.checkSnapshot({ ...s, payScales: [] })).toThrow(/pay scales list is empty/);
  });
});
