// The account review page (frame D02): the facts' words and every state of the list, the detail card and the buttons. react-dom/server, no browser, no network.
import type { ReviewCounts, ReviewItem } from "@portal/db";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionsView, type Handlers, type Props, type ViewState } from "./actions";
import { checksOf, flagsOf, outcomeText, REJECT_REASONS, signedUpBy, typeLabel } from "./text";
import { AccountReviews, href, isTab } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/account-reviews" }));

const NOW = new Date("2026-11-24T12:00:00Z");
const COUNTS: ReviewCounts = { waiting: 3, needsInfo: 1, approved: 12, rejected: 2 };
const item = (o: Partial<ReviewItem> = {}): ReviewItem => ({
  id: "11", status: "open", claimedBy: null, createdAt: "2026-11-24 07:00:00+00", reason: "new organisation", detail: { register: "cro_company", found: true, name_matches: true, status: "Normal" },
  organisationId: "5", displayName: "Fake Hotels Ltd", kind: "employer", organisationStatus: "pending_review", signupPath: "first_time", croNumber: "810001", wrcLicenceNumber: null,
  claimantEmail: "owner@fake-hotels.example.test", emailDomain: "fake-hotels.example.test", answer: null, answeredAt: null, flags: [], lookalikeOf: null, claimantName: "Fake Owner",
  freeEmail: false, nonDomainEmail: false, permitHistory: "not_linked", lastPermitYear: null, banned: false, decidedAt: null, outcome: null, ...o,
});
const page = (items: ReviewItem[], o: { tab?: "waiting" | "needs_info" | "approved" | "rejected"; selected?: ReviewItem | null; me?: string; missingId?: boolean; next?: string; prev?: string } = {}) =>
  html(<AccountReviews tab={o.tab ?? "waiting"} items={items} counts={COUNTS} selected={o.selected === undefined ? (items[0] ?? null) : o.selected} meId={o.me ?? "me"} now={NOW} missingId={o.missingId} next={o.next} prev={o.prev} />);
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample/);

describe("the words of each fact", () => {
  it("the type label follows the sign-up path, then the kind", () => {
    expect(typeLabel({ signupPath: "dete_claim", kind: "employer" })).toBe("Existing sponsor");
    expect(typeLabel({ signupPath: "first_time", kind: "employer" })).toBe("First-time sponsor");
    expect(typeLabel({ signupPath: "agency", kind: "agency" })).toBe("Agency");
    expect(typeLabel({ signupPath: null, kind: "agency" })).toBe("Agency");
    expect(typeLabel({ signupPath: null, kind: "employer" })).toBe("Employer");
  });
  it("flags: free email, lookalike, shared mailbox, non-domain, ban, licence", () => {
    expect(flagsOf(item())).toEqual([]);
    expect(flagsOf(item({ freeEmail: true, nonDomainEmail: true })).map((f) => f.text)).toEqual(["Free email"]); // a free address is not also "non-domain"
    expect(flagsOf(item({ nonDomainEmail: true, flags: ["lookalike_domain", "shared_mailbox"], banned: true })).map((f) => f.text)).toEqual(["On ban list", "Lookalike domain", "Shared mailbox", "Non-domain email"]);
    expect(flagsOf(item({ kind: "agency", detail: { found: true } })).map((f) => f.text)).toEqual(["Licence found"]);
    expect(flagsOf(item({ kind: "agency", detail: { found: true, possibly_lapsed: true } })).map((f) => f.text)).toEqual(["Licence may have lapsed"]);
    expect(flagsOf(item({ kind: "agency", detail: null })).map((f) => f.text)).toEqual([]);
  });
  it("checks: register found and matched, not found, no check at claim, agency licence, DETE history and the first-time conflict", () => {
    const c = (o: Partial<ReviewItem>) => Object.fromEntries(checksOf(item(o)).map((x) => [x.title, x]));
    expect(c({})["CRO lookup"]).toMatchObject({ ok: true, text: "Number 810001 exists · status Normal · name matches." });
    expect(c({ detail: { register: "cro_company", found: false, name_matches: false } })["CRO lookup"]).toMatchObject({ ok: false, text: "Number 810001 is not in the CRO register." });
    expect(c({ detail: { register: "cro_company", found: true, name_matches: false, status: "Normal" } })["CRO lookup"]!.ok).toBe(false);
    expect(c({ signupPath: "dete_claim", detail: {} })["CRO lookup"]!.text).toMatch(/No register check was made at claim/);
    expect(c({ signupPath: "dete_claim", detail: null, croNumber: null })["CRO lookup"]!.text).toMatch(/No CRO number/);
    expect(c({ kind: "agency", wrcLicenceNumber: "EA9001", detail: { found: true, name_matches: true } })["Licence check"]).toMatchObject({ ok: true });
    expect(c({ kind: "agency", wrcLicenceNumber: "EA9001", detail: { found: true, name_matches: true, possibly_lapsed: true } })["Licence check"]!.ok).toBe(false);
    expect(c({ kind: "agency", wrcLicenceNumber: "EA9001", detail: { found: false } })["Licence check"]!.text).toMatch(/not on the agency register/);
    expect(c({})["Licence check"]!.text).toBe("Not an agency.");
    expect(c({})["DETE match"]).toMatchObject({ ok: true, text: "No permits on record. The label will be \"First-time sponsor\"." });
    expect(c({ permitHistory: "has_history", lastPermitYear: 2025 })["DETE match"]).toMatchObject({ ok: false, text: expect.stringMatching(/newest in 2025.*cannot be approved as a first-time sponsor/) });
    expect(c({ signupPath: "dete_claim", permitHistory: "has_history" })["DETE match"]!.ok).toBe(true);
    expect(c({ freeEmail: true, emailDomain: "gmail.com" })["Email domain"]).toMatchObject({ ok: false, text: "Free provider (gmail.com)." });
    expect(c({ nonDomainEmail: true })["Email domain"]!.text).toMatch(/is not saved as one of the company's domains/);
    expect(c({ flags: ["lookalike_domain", "shared_mailbox"], lookalikeOf: "real.example.test" })["Email domain"]!.text).toMatch(/looks like real\.example\.test.*shared mailbox/i);
    expect(c({ claimantEmail: null, emailDomain: null })["Email domain"]).toMatchObject({ ok: false, text: "No owner email on record." });
    expect(c({ banned: true })["Ban list"]).toMatchObject({ ok: false });
    expect(c({})["Ban list"]!.ok).toBe(true);
  });
  it("signed up by, and what a decided item says", () => {
    expect(signedUpBy({ claimantName: "Fake Owner", claimantEmail: "a@b.example.test" })).toBe("Signed up by Fake Owner · a@b.example.test");
    expect(signedUpBy({ claimantName: null, claimantEmail: "a@b.example.test" })).toBe("Signed up by an owner · a@b.example.test");
    expect(signedUpBy({ claimantName: null, claimantEmail: null })).toBe("No active owner on record.");
    expect(outcomeText({ outcome: "approved", organisationStatus: "verified" })).toBe("Approved");
    expect(outcomeText({ outcome: null, organisationStatus: "pending_review" })).toBeNull();
  });
  it("every word is free of dashes and error text", () => {
    for (const i of [item(), item({ freeEmail: true, nonDomainEmail: true, banned: true, flags: ["lookalike_domain", "shared_mailbox"], lookalikeOf: "x.example.test" }), item({ kind: "agency", detail: { found: false } })])
      for (const c of checksOf(i)) clean(c.title + c.text);
    for (const [, label] of REJECT_REASONS) clean(label);
    expect(REJECT_REASONS.every(([code]) => /^[a-z][a-z0-9_]{0,62}$/.test(code))).toBe(true); // the route's reason-code rule
  });
});

describe("addresses", () => {
  it("the first tab has no tab key, the others do, and an id and a cursor join them", () => {
    expect(href("waiting")).toBe("/account-reviews");
    expect(href("approved")).toBe("/account-reviews?tab=approved");
    expect(href("waiting", "12", "abc")).toBe("/account-reviews?id=12&after=abc");
    expect(isTab("needs_info")).toBe(true);
    for (const bad of [undefined, "", "all", "WAITING", "waiting ", "x'; drop table"]) expect(isTab(bad)).toBe(false);
  });
});

describe("the page", () => {
  it("shows the tabs with their counts, the list with flags and ages, and the open item's card", () => {
    const p = page([item({ id: "1", displayName: "First Ltd", freeEmail: true }), item({ id: "2", displayName: "Second Ltd", createdAt: "2026-11-24 09:00:00+00", signupPath: "dete_claim" })]);
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(p).toMatch(/Waiting[^<]*<span[^>]*>3</);
    expect(p).toMatch(/Needs more info[^<]*<span[^>]*>1</);
    expect(p).toMatch(/Approved[^<]*<span[^>]*>12</);
    expect(p).toMatch(/Rejected[^<]*<span[^>]*>2</);
    expect(p).toMatch(/aria-current="page"[^>]*>Waiting/);
    expect(p).toMatch(/First Ltd/);
    expect(p).toMatch(/Free email/);
    expect(p).toMatch(/5 h/); // 07:00 to 12:00
    expect(p).toMatch(/3 h/);
    expect(p).toMatch(/href="\/account-reviews\?id=2"/);
    expect(p).toMatch(/aria-label="Review of First Ltd"/);
    expect(p).toMatch(/Signed up by Fake Owner/);
    clean(p);
  });
  it("an open item offers Claim; mine offers the decisions; another's offers a take-over; a decided one offers nothing", () => {
    expect(page([item()])).toMatch(/Claim this review/);
    const mine = page([item({ status: "claimed", claimedBy: "me" })]);
    expect(mine).toMatch(/Approve/);
    expect(mine).toMatch(/Add the email domain \(fake-hotels\.example\.test\)/);
    expect(mine).toMatch(/Ask for more/);
    expect(mine).toMatch(/Reject/);
    expect(mine).toMatch(/Every action is written to the audit log/);
    expect(mine).not.toMatch(/Claim this review/);
    const other = page([item({ status: "claimed", claimedBy: "someone" })]);
    expect(other).toMatch(/Another reviewer holds this item/);
    expect(other).toMatch(/Take over the claim/);
    expect(other).not.toMatch(/>Approve</);
    const done = page([item({ status: "done", outcome: "approved", decidedAt: "2026-11-24 10:00:00+00" })], { tab: "approved" });
    expect(done).toMatch(/Approved on 24 Nov 2026, 10:00/);
    expect(done).toMatch(/This item is decided/);
    expect(done).not.toMatch(/Claim this review|>Reject</);
  });
  it("the decided tabs show a Decided age, the answer of a company asked for more, and the waiting note", () => {
    const p = page([item({ status: "open", organisationStatus: "needs_info", answer: "Fake answer\nsecond line", answeredAt: "2026-11-24 08:00:00+00" })], { tab: "needs_info" });
    expect(p).toMatch(/The company answered on 24 Nov 2026, 08:00/);
    expect(p).toMatch(/Fake answer/);
    expect(p).toMatch(/Waiting for the company&#x27;s answer/);
    expect(page([item({ status: "done", outcome: "rejected", decidedAt: "2026-11-24 11:00:00+00" })], { tab: "rejected" })).toMatch(/Decided/);
  });
  it("empty states per tab, a missing id, and the Previous and Next links", () => {
    expect(page([], { selected: null })).toMatch(/Nothing is waiting/);
    expect(page([], { selected: null, tab: "needs_info" })).toMatch(/No company is waiting for an answer/);
    expect(page([], { selected: null, tab: "approved" })).toMatch(/No approved companies yet/);
    expect(page([item()], { selected: null, missingId: true })).toMatch(/That item is not an account review/);
    const p = page([item()], { next: "/account-reviews?after=abc", prev: "/account-reviews" });
    expect(p).toMatch(/Previous/);
    expect(p).toMatch(/Next/);
    expect(page([item()])).not.toMatch(/Previous/);
  });
  it("owner text is escaped, never markup", () => {
    const p = page([item({ displayName: "<img src=x onerror=alert(1)> Ltd", claimantName: "<script>x</script>", answer: "<b>hi</b>", organisationStatus: "needs_info", claimantEmail: "a<b>@x.example.test" })]);
    expect(p).not.toMatch(/<img|<script|<b>/);
    expect(p).toMatch(/&lt;img src=x onerror=alert\(1\)&gt; Ltd/);
  });
  it("renders no data field a reviewer page must not hold: no id of the claimant, no raw detail, no staff id of another", () => {
    const p = page([item({ status: "claimed", claimedBy: "someone-staff-id-123", detail: { secret: "raw-detail-value" } })]);
    expect(p).not.toMatch(/someone-staff-id-123|raw-detail-value/);
  });
});

describe("the buttons", () => {
  const P: Props = { itemId: "11", status: "claimed", mine: true, emailDomain: "fake.example.test", canAddDomain: true, companyName: "Fake Ltd", listHref: "/account-reviews" };
  const S: ViewState = { ask: null, pending: false, addDomain: false, question: "", reason: "cannot_verify" };
  const H: Handlers = { onClaim() {}, onRelease() {}, onAsk() {}, onConfirm() {}, onChange() {} };
  const v = (p: Partial<Props> = {}, s: Partial<ViewState> = {}) => html(<ActionsView p={{ ...P, ...p }} s={{ ...S, ...s }} h={H} />);
  it("Ask for more waits for a question, and the domain tick is off for a free provider", () => {
    expect(v()).toMatch(/<button[^>]*disabled[^>]*>Ask for more/);
    expect(v({}, { question: "Please send the CRO certificate" })).not.toMatch(/<button[^>]*disabled[^>]*>Ask for more/);
    const free = v({ canAddDomain: false, emailDomain: "gmail.com" });
    expect(free).toMatch(/type="checkbox"[^>]*disabled/);
    expect(free).toMatch(/Not offered for a free email provider/);
  });
  it("each confirm says what will happen, an error shows in the page and in the dialog, and a pending call locks the buttons", () => {
    expect(v({}, { ask: "approve", addDomain: true })).toMatch(/becomes verified and its owner is told by email\. The domain fake\.example\.test is saved/);
    expect(v({}, { ask: "approve" })).not.toMatch(/is saved for the company/);
    expect(v({}, { ask: "ask_more" })).toMatch(/gets your question by email/);
    expect(v({}, { ask: "reject" })).toMatch(/cannot be undone from here/);
    expect(v({}, { error: "Another reviewer holds this item." }).match(/Another reviewer holds this item\./g)!.length).toBeGreaterThanOrEqual(1);
    expect(v({}, { pending: true })).toMatch(/<button[^>]*disabled[^>]*>Approve/);
    clean(v({}, { ask: "reject", error: "x" }));
  });
  it("the reject reasons are the route's codes with words", () => {
    const m = v();
    for (const [code, label] of REJECT_REASONS) {
      expect(m).toContain(`value="${code}"`);
      expect(m).toContain(label);
    }
  });
});
