// The rules data pages (frames ND3, D05, D06): the pure text and form helpers, and the views rendered to HTML for every state (no data, normal, a pending proposal as its proposer, as another
// administrator and as an editor, a viewer with no role). react-dom/server, no browser, no network, no database.
import type { PastVersion, Pending, PayDealRow, Version } from "@portal/db";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { bigEntry, employerKey, minimumsData, occupationEntry, parseCodes, payDealEntry, scaleEntry, withEntry, without } from "./build";
import { addDays, changeLines, CHANGE_LINES, dayText, historyKind, isoDay, minimumRows, pendingFor, tabOf, lastDay } from "./text";
import { BigCompanies, HistoryView, PayDeal, PendingList, Quotas, Rules, RulesNav, type Who } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/rules" }));

const NOW = new Date("2026-11-25T12:00:00Z"), TODAY = "2026-11-25";
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const clean = (t: string) => expect(t).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample|NaN|fee|graduate tier|Place names|Unclear tech/i);
const MINS = { criticalSkills: 41000, graduate: 37000, graduateMonths: 12, nonList: 69000, nonListRoute: true, minContractMonths: 24, standardWeekHours: 39, checkedOn: "2026-11-12", general: 33000, generalLower: 32000, generalLowerCodes: ["6145"], generalQuotaFullCodes: ["5330", "5441"] };
const v = (kind: string, data: unknown, o: Partial<Version> = {}): Version => ({ kind, versionId: "3", effectiveFrom: "2026-01-01", data, ...o }) as Version;
const mins = v("minimums", MINS, { hourly: { criticalSkills: 20.19, general: 16.27 } });
const IN_FORCE = [mins, v("critical_skills_list", [{ id: "cs-2136", code: "2136", title: "Fake software roles", list: "critical-skills" }]), v("ineligible_list", [{ id: "in-1225", code: "1225", title: "Fake ineligible role", list: "ineligible" }]),
  v("pay_scales", [{ code: "G1", title: "Fake grade", firstEur: 30000, lastEur: 40000, sourceUrl: "https://example.test/pay", sourcePage: 4 }]), v("big_company_names", [{ name: "fake brand", test: "brand", link: "https://example.test/pay", readOn: "2026-10-01", reviewOn: "2027-04-01" }])];
const NEXT = v("minimums", { ...MINS, criticalSkills: 42000 }, { versionId: "4", effectiveFrom: "2027-01-01" });
const ADMIN: Who = { id: "adm", roles: ["administrator"] }, EDITOR: Who = { id: "ed", roles: ["rules_data_editor"] }, NOBODY: Who = { id: "x", roles: ["content_editor"] };
const pend = (o: Partial<Pending> = {}): Pending => ({ requestId: "9", kind: "minimums", effectiveFrom: "2027-01-01", proposedBy: "ed", proposedByName: "Fake Editor", createdAt: "2026-11-25 10:00:00+00", change: { added: {}, removed: {}, changed: { criticalSkills: { before: 41000, after: 42000 } } }, ...o }) as Pending;
const page = (o: Partial<Parameters<typeof Rules>[0]> = {}) => html(<Rules tab="minimums" inForce={IN_FORCE} upcoming={[]} pending={[]} who={NOBODY} today={TODAY} now={NOW} {...o} />);

describe("text and forms", () => {
  it("a hostile tab or kind falls back to the first", () => {
    expect(tabOf("history")).toBe("history"); expect(tabOf("quotas")).toBe("quotas");
    for (const t of ["", "x", "__proto__", "minimums,history", undefined]) expect(tabOf(t as string | undefined)).toBe("minimums");
    expect(historyKind("pay_scales")).toBe("pay_scales"); expect(historyKind("'; drop")).toBe("minimums"); expect(historyKind(undefined)).toBe("minimums");
  });
  it("days and the next value: a General row only when the version has it; the next value is the first confirmed version to come", () => {
    expect(dayText("2027-01-01")).toBe("1 Jan 2027"); expect(dayText(null)).toBe(""); expect(isoDay(NOW)).toBe(TODAY); expect(addDays(TODAY, 90)).toBe("2027-02-23");
    const rows = minimumRows(mins, [NEXT]);
    expect(rows.map((r) => r.permit)).toEqual(["Critical Skills", "Critical Skills", "Critical Skills", "General", "General"]);
    expect(rows[0]).toMatchObject({ now: 41000, hourly: 20.19, next: 42000, nextFrom: "2027-01-01" });
    expect(rows[1]!.next).toBe(37000);
    expect(minimumRows(v("minimums", { ...MINS, general: undefined, generalLower: undefined }), []).length).toBe(3);
    expect(minimumRows(undefined, [])).toEqual([]);
  });
  it("a change is lines of text, capped", () => {
    expect(changeLines({ changed: { criticalSkills: { before: 1, after: 2 } }, added: { x: { code: "2136", title: "T" } }, removed: { y: "z" } })).toEqual(["Added x: 2136 T", "Removed y: z", "Changed Critical Skills minimum: 1 to 2"]);
    const many = Object.fromEntries(Array.from({ length: CHANGE_LINES + 5 }, (_, i) => [`k${i}`, i]));
    const l = changeLines({ added: many }); expect(l.length).toBe(CHANGE_LINES + 1); expect(l.at(-1)).toBe("and 5 more changes");
    expect(pendingFor([pend(), pend({ kind: "pay_scales" })], ["minimums"]).length).toBe(1);
  });
  it("the minimums form: whole numbers, all four General figures or none", () => {
    const base = { criticalSkills: "41000", graduate: "37000", graduateMonths: "12", nonList: "69000", minContractMonths: "24", standardWeekHours: "39", checkedOn: "2026-11-12" };
    expect(minimumsData(form({ ...base, nonListRoute: "on" }))).toEqual({ ok: true, value: { criticalSkills: 41000, graduate: 37000, graduateMonths: 12, nonList: 69000, minContractMonths: 24, standardWeekHours: 39, checkedOn: "2026-11-12", nonListRoute: true } });
    const g = minimumsData(form({ ...base, general: "33000", generalLower: "32000", generalLowerCodes: "6145, 6146\n6147", generalQuotaFullCodes: "" })) as { ok: true; value: Record<string, unknown> };
    expect(g.value).toMatchObject({ general: 33000, generalLowerCodes: ["6145", "6146", "6147"], generalQuotaFullCodes: [], nonListRoute: false });
    expect(minimumsData(form({ ...base, criticalSkills: "40.5" }))).toMatchObject({ ok: false });
    expect(minimumsData(form({ ...base, criticalSkills: "" }))).toMatchObject({ ok: false });
    expect(minimumsData(form({ ...base, generalLower: "32000" }))).toMatchObject({ ok: false, error: expect.stringMatching(/go together/) });
    expect(minimumsData(form({ ...base, checkedOn: "" }))).toMatchObject({ ok: false });
    expect(parseCodes(" 1,2;;3\n4 ")).toEqual(["1", "2", "3", "4"]);
  });
  it("list entries: a new occupation gets a free id, an edited one keeps its own; a scale; a brand in lower case", () => {
    expect(occupationEntry(form({ code: "2136", title: "T" }), "critical-skills", null, [])).toEqual({ ok: true, value: { id: "cs-2136", code: "2136", title: "T", list: "critical-skills" } });
    expect(occupationEntry(form({ code: "2136", title: "T" }), "critical-skills", null, ["cs-2136", "cs-2136-2"])).toMatchObject({ value: { id: "cs-2136-3" } });
    expect(occupationEntry(form({ code: "2137", title: "T2" }), "ineligible", { id: "in-1", code: "2136", title: "T", list: "ineligible" }, ["in-1"])).toMatchObject({ value: { id: "in-1", code: "2137" } });
    expect(occupationEntry(form({ code: "21", title: "T" }), "ineligible", null, [])).toMatchObject({ ok: false });
    expect(occupationEntry(form({ code: "2136", title: " " }), "ineligible", null, [])).toMatchObject({ ok: false });
    expect(scaleEntry(form({ code: "g1", title: "G", firstEur: "1", lastEur: "2", sourceUrl: "https://a.test", sourcePage: "3" }))).toEqual({ ok: true, value: { code: "G1", title: "G", firstEur: 1, lastEur: 2, sourceUrl: "https://a.test", sourcePage: 3 } });
    expect(scaleEntry(form({ code: "G", title: "G", firstEur: "x", lastEur: "2", sourceUrl: "https://a.test", sourcePage: "3" }))).toMatchObject({ ok: false });
    expect(bigEntry(form({ name: "  Fake   Brand ", test: "brand", link: "https://a.test", readOn: "2026-10-01", reviewOn: "2027-04-01" }))).toMatchObject({ value: { name: "fake brand" } });
    expect(bigEntry(form({ name: " ", test: "brand" }))).toMatchObject({ ok: false });
    expect(withEntry([1, 2, 3], 1, 9)).toEqual([1, 9, 3]); expect(withEntry([1], null, 2)).toEqual([1, 2]); expect(without([1, 2, 3], 0)).toEqual([2, 3]);
  });
  it("a pay-deal entry keeps what the list had (day added, who, the file) and says when evidence is missing; unticked On is off", () => {
    const had = { tier: 2 as const, bodyType: "section_38" as const, evidence: { kind: "service_arrangement" as const, link: null, file: { id: "0f8fad5b-d9cb-469f-a165-70867728950e.pdf", name: "a.pdf" } }, addedOn: "2026-11-01", addedBy: "ed" };
    const r = payDealEntry(form({ bodyType: "section_38", evidenceKind: "service_arrangement", link: "", note: "n", on: "on" }), had, null);
    expect(r).toEqual({ ok: true, value: { ...had, note: "n" } });
    expect(payDealEntry(form({ bodyType: "section_39", evidenceKind: "other", link: "https://a.test" }), had, null)).toMatchObject({ value: { on: false, tier: 2, addedBy: "ed" } });
    expect(payDealEntry(form({ bodyType: "section_39", evidenceKind: "other", link: "" }), null, null)).toMatchObject({ ok: false, error: expect.stringMatching(/evidence/) });
    expect(payDealEntry(form({ bodyType: "public_body", evidenceKind: "other", link: "" }), null, { id: "n", name: "n" })).toMatchObject({ ok: true, value: { tier: 2 } });
    expect(employerKey("  Fake   Hospital ")).toBe("fake hospital");
  });
});

describe("/rules", () => {
  it("salary minimums: every figure with its hourly, 'Not entered' for a next value, no fee row or graduate tier", () => {
    const p = page(); clean(p);
    expect(p).toMatch(/€41,000/); expect(p).toMatch(/€20\.19\/h/); expect(p).toMatch(/Not entered/); expect(p).toMatch(/Salary minimums/); expect(p).toMatch(/Public pay scales/); expect(p).toMatch(/Quotas/);
    expect(p).not.toMatch(/Permit fee/); expect(p).not.toMatch(/Add a future value/); // a viewer without the editor role has no form
  });
  it("a confirmed version to come is a labelled next value, never the current one", () => {
    const p = page({ upcoming: [NEXT] });
    expect(p).toMatch(/has not started yet/); expect(p).toMatch(/It starts on 1 Jan 2027/); expect(p).toMatch(/€42,000/); expect(p).toMatch(/1 Jan 2027/);
    expect(p.indexOf("In force now")).toBeLessThan(p.indexOf("Next value"));
  });
  it("while a confirmed version waits, a change made from today's figures must start before it, and the minimums editor can change that version itself", () => {
    expect(lastDay([NEXT], "minimums")).toBe("2026-12-31"); expect(lastDay([NEXT], "pay_scales")).toBeUndefined(); expect(lastDay([], "minimums")).toBeUndefined();
    expect(lastDay([{ ...NEXT, effectiveFrom: "2027-03-01" }, NEXT], "minimums")).toBe("2026-12-31"); // the first one to start
    const p = page({ who: EDITOR, upcoming: [NEXT] });
    expect(p).toMatch(/max="2026-12-31"/); expect(p).toMatch(/Up to 31 Dec 2026/); expect(p).toMatch(/Change the version of 1 Jan 2027/); expect(p).toMatch(/min="2027-01-01"/);
    expect(page({ who: EDITOR })).not.toMatch(/ max="2026|Change the version of/);
    const list = page({ tab: "critical", who: EDITOR, upcoming: [{ ...NEXT, kind: "critical_skills_list", data: [] }] }); expect(list).toMatch(/max="2026-12-31"/);
  });
  it("only a rules data editor sees the forms", () => {
    expect(page({ who: EDITOR })).toMatch(/Add a future value/);
    expect(page({ who: ADMIN })).not.toMatch(/Add a future value/); // an administrator confirms; it does not stand in for the editor
    for (const tab of ["critical", "ineligible", "scales"] as const) {
      expect(page({ tab, who: EDITOR })).toMatch(/>Edit</); expect(page({ tab, who: EDITOR })).toMatch(/>Remove</);
      expect(page({ tab, who: ADMIN })).not.toMatch(/>Edit</);
    }
  });
  it("the list tabs show their own rows, with no roles or domains column and no place names or unclear tech roles tab", () => {
    expect(page({ tab: "critical" })).toMatch(/Fake software roles/); expect(page({ tab: "ineligible" })).toMatch(/Fake ineligible role/);
    const s = page({ tab: "scales" }); expect(s).toMatch(/€30,000/); expect(s).toMatch(/Page 4/); clean(s);
    expect(page({ tab: "critical", inForce: [] })).toMatch(/Nothing is in force for this list yet/);
    expect(page({ inForce: [] })).toMatch(/No salary minimums are in force/);
  });
  it("quotas show the codes the minimums hold; a version with none says so", () => {
    const q = html(<Quotas m={MINS as never} />); expect(q).toMatch(/5330/); expect(q).toMatch(/6145/); expect(q).toMatch(/Quota full/);
    expect(html(<Quotas m={{ criticalSkills: 1 } as never} />)).toMatch(/no General permit figures/); expect(html(<Quotas m={undefined} />)).toMatch(/no General/);
  });
  it("the nav has the seven tabs, the open one marked", () => {
    const n = html(<RulesNav active="big" />);
    expect(n.match(/<a /g)!.length).toBe(7); expect(n).toMatch(/aria-current="page"[^>]*>Big-company list/); expect(n).toMatch(/href="\/rules\/pay-deal-employers"/);
  });
});

describe("a proposal waiting", () => {
  const list = (who: Who, items = [pend()]) => html(<PendingList items={items} who={who} back="/rules" now={NOW} />);
  it("shows who proposed it and the change; the proposer can only withdraw", () => {
    const p = list({ id: "ed", roles: ["rules_data_editor", "administrator"] }); clean(p);
    expect(p).toMatch(/Proposed by you/); expect(p).toMatch(/Changed Critical Skills minimum: 41000 to 42000/); expect(p).toMatch(/>Withdraw</); expect(p).not.toMatch(/>Confirm</); expect(p).not.toMatch(/>Refuse</);
    expect(p).toMatch(/A different administrator confirms it/);
  });
  it("a different administrator can confirm or refuse, not withdraw; a viewer can do none", () => {
    const a = list(ADMIN); expect(a).toMatch(/Proposed by Fake Editor/); expect(a).toMatch(/>Confirm</); expect(a).toMatch(/>Refuse</); expect(a).not.toMatch(/>Withdraw</);
    const n = list(NOBODY); expect(n).not.toMatch(/<button/); expect(n).toMatch(/An administrator decides this/);
  });
  it("a flag proposal names the company; an empty change says nothing differs; nothing waiting renders nothing", () => {
    expect(list(ADMIN, [{ requestId: "5", kind: "big_company_flag", organisationId: "330", displayName: "Fake Co", proposedBy: "ed", proposedByName: "Fake Editor", createdAt: "2026-11-25 10:00:00+00" } as Pending])).toMatch(/Flag Fake Co as a big company/);
    expect(list(ADMIN, [pend({ change: { added: {}, removed: {}, changed: {} } } as never)])).toMatch(/No entry differs/);
    expect(list(ADMIN, [])).toBe("");
  });
  it("a hostile name is escaped text", () => {
    expect(list(ADMIN, [pend({ proposedByName: "<script>x</script>" })])).not.toMatch(/<script>x/);
  });
});

describe("history", () => {
  const item = (o: Partial<PastVersion> = {}): PastVersion => ({ versionId: "3", effectiveFrom: "2026-03-01", until: null, inForce: true, seeded: false, proposedBy: "ed", proposedByName: "Fake Editor", confirmedByName: "Fake Admin", confirmedAt: "2026-02-18 09:30:00+00", change: { added: {}, removed: {}, changed: { criticalSkills: { before: 1, after: 2 } } }, ...o });
  it("each version with its days, who proposed and confirmed it, its change; Previous and Next, no page numbers", () => {
    const h = html(<HistoryView kind="minimums" items={[item(), item({ versionId: "2", until: "2026-03-01", inForce: false, seeded: true })]} prev="/rules?tab=history&kind=minimums" next="/rules?tab=history&kind=minimums&after=x" />); clean(h);
    expect(h).toMatch(/1 Mar 2026 to now/); expect(h).toMatch(/In force/); expect(h).toMatch(/Proposed by Fake Editor, confirmed by Fake Admin/); expect(h).toMatch(/The first version/); expect(h).toMatch(/>Previous</); expect(h).toMatch(/>Next</);
    expect(h).not.toMatch(/Page \d/);
  });
  it("no version yet is said", () => { expect(html(<HistoryView kind="pay_scales" items={[]} />)).toMatch(/No version of this kind has started yet/); });
  it("the history tab of the page", () => {
    const p = page({ tab: "history", history: { kind: "ineligible_list", items: [item()] } }); expect(p).toMatch(/Ineligible list/); expect(p).not.toMatch(/Add a future value/);
  });
});

describe("/rules/pay-deal-employers (frame D05)", () => {
  const row = (o: Partial<PayDealRow> = {}): PayDealRow => ({ name: "fake hospital group", tier: 2, note: null, bodyType: "section_38", evidence: { kind: "service_arrangement", link: null, file: { id: "0f8fad5b-d9cb-469f-a165-70867728950e.pdf", name: "arrangement.pdf" } }, addedOn: "2026-11-01", addedBy: "ed", addedByName: "Fake Editor", on: true, companies: 1, legalNames: 2, liveJobs: 4, ...o });
  const dp = (who: Who, items: PayDealRow[] = [row(), row({ name: "fake voluntary body", bodyType: "section_39", evidence: null, on: false, addedOn: null, addedByName: null })], selected: string | null = "fake hospital group") =>
    html(<PayDeal items={items} versionId="9" data={{ "fake hospital group": { tier: 2 } }} selected={selected} pending={[]} upcoming={[]} who={who} today={TODAY} now={NOW} />);
  it("the list with type, evidence, day added, who added it and on or off; evidence missing and the Section 39 warning; the counts of the open one", () => {
    const p = dp(NOBODY); clean(p);
    expect(p).toMatch(/Section 38/); expect(p).toMatch(/Section 39/); expect(p).toMatch(/Evidence missing/); expect(p).toMatch(/>On</); expect(p).toMatch(/>Off</); expect(p).toMatch(/1 Nov 2026/); expect(p).toMatch(/Fake Editor/);
    expect(p).toMatch(/aria-label="Open the copy arrangement\.pdf"/); expect(p).toMatch(/2 legal names/); expect(p).toMatch(/Live jobs<\/dt><dd>4/);
    expect(dp(NOBODY, [row({ bodyType: "section_39" })])).toMatch(/Open with DETE/); expect(p).not.toMatch(/Open with DETE/);
  });
  it("the forms are the rules data editor's only", () => {
    expect(dp(EDITOR)).toMatch(/Add employer/); expect(dp(EDITOR)).toMatch(/>Save</); expect(dp(EDITOR)).toMatch(/Body type/);
    for (const w of [ADMIN, NOBODY]) { const p = dp(w); expect(p).not.toMatch(/Add employer/); expect(p).not.toMatch(/>Save</); }
  });
  it("no list in force and an unknown selection are states, not errors", () => {
    expect(html(<PayDeal items={[]} versionId={null} data={{}} selected={null} pending={[]} upcoming={[]} who={EDITOR} today={TODAY} now={NOW} />)).toMatch(/No pay-deal list is in force yet/);
    expect(dp(NOBODY, [row()], "nobody")).not.toMatch(/<aside/);
  });
  it("the proposals of the pay-deal list wait here, with who proposed them", () => {
    const p = html(<PayDeal items={[row()]} versionId="9" data={{}} selected={null} pending={[pend({ kind: "public_pay_employers" } as never), pend({ requestId: "1", kind: "pay_scales" } as never)]} upcoming={[]} who={ADMIN} today={TODAY} now={NOW} />);
    expect(p).toMatch(/Pay-deal employers/); expect(p.match(/Waiting for a different administrator/g)!.length).toBe(1); expect(p).not.toMatch(/Public pay scales<\/p>/);
  });
});

describe("/rules/big-companies (frame D06)", () => {
  const big = (who: Who, rows = (IN_FORCE[4]!.data as never[])) => html(<BigCompanies rows={rows} pending={[]} upcoming={[]} who={who} today={TODAY} now={NOW} criticalSkills={41000} />);
  it("the brands with their test, link and review day; the rule in a notice; the minimum read; no roles or domains column, no match percentage", () => {
    const p = big(NOBODY); clean(p);
    expect(p).toMatch(/fake brand/); expect(p).toMatch(/A well-known brand/); expect(p).toMatch(/1 Apr 2027/); expect(p).toMatch(/expected above €41,000/); expect(p).toMatch(/Never agency contractors, never SMEs, never General permit jobs/);
    expect(p).not.toMatch(/Roles covered|Company email domains|Legal entities|% match/);
  });
  it("the add and flag forms show to a rules data editor only; an empty list is said", () => {
    expect(big(EDITOR)).toMatch(/Add brand/); expect(big(EDITOR)).toMatch(/Flag one company as big/); expect(big(EDITOR)).toMatch(/Propose the flag/);
    for (const w of [ADMIN, NOBODY]) { const p = big(w); expect(p).not.toMatch(/Add brand/); expect(p).not.toMatch(/Flag one company/); }
    expect(big(NOBODY, [])).toMatch(/Nothing is in force for this list yet/);
  });
  it("the flag proposals wait on this page", () => {
    const p = html(<BigCompanies rows={[]} pending={[{ requestId: "5", kind: "big_company_flag", organisationId: "330", displayName: "Fake Co", proposedBy: "ed", proposedByName: "Fake Editor", createdAt: "2026-11-25 10:00:00+00" } as Pending]} upcoming={[]} who={ADMIN} today={TODAY} now={NOW} criticalSkills={null} />);
    expect(p).toMatch(/Flag Fake Co/); expect(p).toMatch(/expected above the minimum/);
  });
});
