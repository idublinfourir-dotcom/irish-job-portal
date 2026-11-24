// The fetched-job queue page (frame ND2): the stage words, the check list from a dry run, and every state of the list, the detail card and the buttons.
// react-dom/server, no browser, no network.
import type { DryRun, QueueItem, QueueItemDetail } from "@portal/db";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionsView, type Handlers, type Props, type ViewState } from "./actions";
import { checkRows, CHECK_TITLE, initials, readCheckParams, REJECT_REASONS, sourceLabel, stageLabel } from "./text";
import { FetchedJobs, href, type Counts } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/fetched-jobs" }));

const NOW = new Date("2026-11-24T12:00:00Z");
const COUNTS: Counts = { total: 5, stages: [{ stage: "7 contract unclear (admin queue)", count: 3 }, { stage: "5 unsure occupation (admin queue)", count: 2 }, { stage: null, count: 0 }] };
const row = (o: Partial<QueueItem> = {}): QueueItem => ({
  id: "21", status: "open", claimedBy: null, jobId: "9", organisationId: "4", title: "Fake Engineer", employerName: "Fake Employer Ltd", advertUrl: "https://jobs.example.test/a", occupationCode: "2134",
  permitHistory: "not_linked", sponsorPermits: null, stage: "7 contract unclear (admin queue)", reason: "specified purpose", wrcAgency: false, queuedAt: "2026-11-24 03:00:00+00", county: "Cork", sourceKind: "careers_page", ...o,
});
const detail = (o: Partial<QueueItemDetail> = {}): QueueItemDetail => ({ ...row(), advertText: "The saved advert text.", quotedEvidence: "a specified purpose contract", matcherModel: "fake-model", ...o });
const DRY: DryRun = {
  itemId: "21", jobId: "9", wouldPublish: true, passRoute: "stated_pay", failedStage: null, badge: "critical_skills_eligible", occupationCode: "2134", salaryLow: 50000, salaryHigh: 50000, payGrade: null, quotaFull: false,
  stage: "PASS (salary stated)", checks: [
    { check: "irish_employer", result: "pass", detail: "known employer" }, { check: "sponsorship_wording", result: "pass", detail: null }, { check: "occupation_known", result: "pass", detail: "2134" },
    { check: "critical_skills_list", result: "pass", detail: "2134" }, { check: "contract", result: "pass", detail: "ok" }, { check: "salary", result: "pass", detail: "pass" }, { check: "scam_wording", result: "pass", detail: null },
  ],
};
const SOC = [{ code: "2134", title: "Programmer" }, { code: "2231", title: "Registered nurse" }];
const page = (o: { items?: QueueItem[]; selected?: QueueItemDetail | null; me?: string; dry?: DryRun | null; problem?: string; stage?: string; soc?: string; missingId?: boolean; next?: string; prev?: string; counts?: Counts } = {}) =>
  html(<FetchedJobs items={o.items ?? [row()]} counts={o.counts ?? COUNTS} stage={o.stage} selected={o.selected === undefined ? detail() : o.selected} meId={o.me ?? "me"} dryState={{ dry: o.dry === undefined ? null : o.dry, problem: o.problem }}
    socOptions={SOC} soc={o.soc ?? "2134"} contract={false} now={NOW} missingId={o.missingId} next={o.next} prev={o.prev} />);
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample|Match \d/);

describe("words", () => {
  it("a stage text loses its number and its bracket, and starts with a capital", () => {
    expect(stageLabel("7 contract unclear (admin queue)")).toBe("Contract unclear");
    expect(stageLabel("5 unsure occupation (admin queue)")).toBe("Unsure occupation");
    expect(stageLabel("7 doctor grade, contract unconfirmed (admin queue, #95)")).toBe("Doctor grade, contract unconfirmed");
    expect(stageLabel("0 advert too long (admin queue)")).toBe("Advert too long");
    expect(stageLabel(null)).toBe("No advert record");
    expect(stageLabel("")).toBe("No advert record".replace("No advert record", "Queued"));
  });
  it("initials, source and the check titles", () => {
    expect(initials("Northquay Hospital Group")).toBe("NH");
    expect(initials("Stripe")).toBe("ST");
    expect(initials("<b>")).toBe("?");
    expect(sourceLabel("careers_page")).toBe("careers page");
    for (const k of ["irish_employer", "sponsorship_wording", "occupation_known", "critical_skills_list", "contract", "salary", "scam_wording"]) expect(CHECK_TITLE[k]).toBeTruthy();
  });
  it("check rows: pass, fail, unsure, not reached, then the quota and the pay grade", () => {
    const rows = checkRows({ ...DRY, quotaFull: true, payGrade: "Staff Nurse", checks: [
      { check: "irish_employer", result: "pass", detail: null }, { check: "contract", result: "unsure", detail: "specified purpose" }, { check: "salary", result: "not_run", detail: null }, { check: "occupation_known", result: "fail", detail: "no code" },
    ] });
    expect(rows.map((r) => [r.title, r.ok])).toEqual([["Irish employer", true], ["Contract", false], ["Salary", null], ["Occupation", false], ["Quota", false], ["Pay-scale grade", true]]);
    expect(rows[1]!.text).toBe("Unsure, so a person decides. specified purpose");
    expect(rows[2]!.text).toMatch(/Not reached/);
    expect(rows[4]!.text).toMatch(/quota .* is full/);
    expect(rows[5]!.text).toBe("Staff Nurse");
    expect(checkRows(DRY).at(-1)).toMatchObject({ title: "Quota", ok: true });
  });
  it("the check address keeps a 4 digit code and pay of up to 7 digits, and drops anything else", () => {
    expect(readCheckParams({ soc: "2134", low: "50000", high: "60000", contract: "1" })).toEqual({ soc: "2134", low: 50000, high: 60000, contract: true });
    expect(readCheckParams({ soc: "21345", low: "-5", high: "1e3", contract: "yes" })).toEqual({ soc: undefined, low: undefined, high: undefined, contract: false });
    expect(readCheckParams({ soc: "2134'; drop", low: "12345678" })).toMatchObject({ soc: undefined, low: undefined });
    expect(readCheckParams({})).toEqual({ soc: undefined, low: undefined, high: undefined, contract: false });
  });
  it("every word is free of dashes", () => {
    for (const [, l] of REJECT_REASONS) clean(l);
    clean(checkRows(DRY).map((r) => r.title + r.text).join(" "));
  });
});

describe("addresses", () => {
  it("builds the queue address from the parts it is given", () => {
    expect(href()).toBe("/fetched-jobs");
    expect(href({ stage: "7 contract unclear (admin queue)", id: "5" })).toBe("/fetched-jobs?stage=7+contract+unclear+%28admin+queue%29&id=5");
    expect(href({ soc: "2134", low: 1, high: 2, contract: true, after: "x" })).toBe("/fetched-jobs?after=x&soc=2134&low=1&high=2&contract=1");
  });
});

describe("the page", () => {
  it("shows All with the total, one chip per stage that has a count, the list and the open item's card", () => {
    const p = page({ dry: DRY });
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(p).toMatch(/All <span[^>]*>5</);
    expect(p).toMatch(/Contract unclear <span[^>]*>3</);
    expect(p).toMatch(/Unsure occupation <span[^>]*>2</);
    expect(p).not.toMatch(/No advert record <span/); // a null stage cannot be a tab
    expect(p).toMatch(/aria-current="page"[^>]*>All/);
    expect(p).toMatch(/Fake Engineer/);
    expect(p).toMatch(/9 h/); // 03:00 to 12:00
    expect(p).toMatch(/href="\/fetched-jobs\?id=21"/);
    expect(p).toMatch(/Why it was queued: quoted evidence/);
    expect(p).toMatch(/a specified purpose contract/);
    expect(p).toMatch(/Irish employer/);
    expect(p).toMatch(/Quota/);
    expect(p).toMatch(/Critical Skills eligible/);
    expect(p).toMatch(/Claim this job/);
    expect(p).toMatch(/Every decision is written to the audit log/);
    clean(p);
  });
  it("a chip of the open stage is marked, and the list links keep the stage", () => {
    const p = page({ stage: "7 contract unclear (admin queue)" });
    expect(p).toMatch(/aria-current="page"[^>]*>Contract unclear/);
    expect(p).toMatch(/href="\/fetched-jobs\?stage=7\+contract\+unclear\+%28admin\+queue%29&amp;id=21"/);
  });
  it("my claimed item shows the SOC picker, the contract tick, pay, Check, Approve and publish, Reject; another's shows a take-over only", () => {
    const mine = page({ selected: detail({ status: "claimed", claimedBy: "me" }), dry: DRY });
    for (const w of ["SOC code", "2134 · Programmer", "2231 · Registered nurse", "The contract is at least 2 years", "Pay from", "Check this SOC code", "Approve and publish", "Reject", "Release"]) expect(mine, w).toContain(w);
    const other = page({ selected: detail({ status: "claimed", claimedBy: "someone" }) });
    expect(other).toMatch(/Another reviewer holds this item/);
    expect(other).toMatch(/Take over the claim/);
    expect(other).not.toMatch(/Approve and publish/);
  });
  it("a code the rules would not publish says where they stopped; no dry run asks for one; a problem shows", () => {
    expect(page({ dry: { ...DRY, wouldPublish: false, failedStage: "6 not on Critical Skills list", badge: null } })).toMatch(/would not publish yet: the rules stopped at “6 not on Critical Skills list”/);
    expect(page({ dry: null })).toMatch(/Pick a SOC code and press Check/);
    expect(page({ dry: null, problem: "That occupation code is not on the Critical Skills list. Pick one from the list." })).toMatch(/not on the Critical Skills list/);
  });
  it("shows the advert text in a closed details block, as text; the evidence missing; the WRC and DETE signals", () => {
    const p = page({ selected: detail({ advertText: "Line one\n<script>x</script>", quotedEvidence: null, permitHistory: "has_history", sponsorPermits: 7, wrcAgency: true }) });
    expect(p).toMatch(/<details/);
    expect(p).not.toMatch(/<script>/);
    expect(p).toMatch(/No quote was saved for this advert/);
    expect(p).toMatch(/7 DETE permits in 5 years/);
    expect(p).toMatch(/On the agency register/);
  });
  it("empty states, a missing id and the Previous and Next links", () => {
    expect(page({ items: [], selected: null, counts: { total: 0, stages: [] } })).toMatch(/The queue is empty/);
    expect(page({ items: [], selected: null, stage: "7 contract unclear (admin queue)" })).toMatch(/Nothing in this category/);
    expect(page({ missingId: true, selected: null })).toMatch(/That item is not a fetched job/);
    const p = page({ next: "/fetched-jobs?after=a", prev: "/fetched-jobs" });
    expect(p).toMatch(/Previous/);
    expect(p).toMatch(/Next/);
  });
  it("advert and employer text is escaped, never markup", () => {
    const p = page({ items: [row({ title: "<img src=x onerror=1>", employerName: "<b>Evil</b>" })], selected: detail({ title: "<img src=x onerror=1>", employerName: "<b>Evil</b>", quotedEvidence: "<script>a</script>", reason: "<i>r</i>" }) });
    expect(p).not.toMatch(/<img|<script|<b>|<i>/);
  });
  it("renders no staff id of another reviewer", () => {
    expect(page({ selected: detail({ status: "claimed", claimedBy: "other-staff-id-777" }) })).not.toMatch(/other-staff-id-777/);
  });
});

describe("the buttons", () => {
  const P: Props = { itemId: "21", status: "claimed", mine: true, stage: "7 contract unclear (admin queue)", socOptions: SOC, soc: "2134", contract: false, listHref: "/fetched-jobs" };
  const S: ViewState = { ask: null, pending: false, soc: "2134", contract: false, low: "", high: "", reason: "duplicate" };
  const H: Handlers = { onClaim() {}, onRelease() {}, onAsk() {}, onConfirm() {}, onChange() {} };
  const v = (p: Partial<Props> = {}, s: Partial<ViewState> = {}) => html(<ActionsView p={{ ...P, ...p }} s={{ ...S, ...s }} h={H} />);
  it("the check form is a plain GET back to the queue with the item and the stage, so it works without a script", () => {
    const m = v();
    expect(m).toMatch(/<form[^>]*action="\/fetched-jobs" method="get"/);
    expect(m).toMatch(/name="id" value="21"/);
    expect(m).toMatch(/name="stage" value="7 contract unclear \(admin queue\)"/);
    expect(m).toMatch(/name="soc"/);
  });
  it("a code not on the list shows as such, an empty code asks for one and locks the buttons, pending locks them too", () => {
    expect(v({}, { soc: "9999" })).toMatch(/9999 \(not on the Critical Skills list\)/);
    const none = v({}, { soc: "" });
    expect(none).toMatch(/Pick a code/);
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Approve and publish/);
    expect(v({}, { pending: true })).toMatch(/<button[^>]*disabled[^>]*>Reject/);
  });
  it("each confirm says what will happen; the reject dialog lists the reason codes", () => {
    expect(v({}, { ask: "approve" })).toMatch(/goes live with SOC code 2134 and the Critical Skills eligible badge/);
    const rej = v({}, { ask: "reject" });
    expect(rej).toMatch(/never shown to candidates/);
    for (const [code, label] of REJECT_REASONS) {
      expect(rej).toContain(`value="${code}"`);
      expect(rej).toContain(label);
    }
    clean(rej);
  });
  it("shows an error from the route, claims and decided items", () => {
    expect(v({}, { error: "The rules would not publish this job." })).toMatch(/The rules would not publish this job\./);
    expect(v({ mine: false, status: "open" })).toMatch(/Claim this job/);
    expect(v({ status: "done" })).toMatch(/This item is decided/);
  });
});
