// The tool pages of step 16 wave 3 (P29b): every state of /figures, /settings, /legal-texts, /data-requests, /solicitors and /me, rendered to HTML with fixture props
// (react-dom/server, no browser, no network), and the pure words behind them. Fake people and fake companies only.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_NAV, adminLinks, type AdminRole } from "@portal/ui";
import { ControlsView as DataControls } from "../data-requests/controls";
import { DataRequests } from "../data-requests/view";
import { canProposeErase, confirmText, ERASE_GOES } from "../data-requests/text";
import { DoneView } from "../figures/done-button";
import { REMINDER, reminderText, safeLink, dayText } from "../figures/text";
import { ChecksBlock, DecisionsBlock, Figures, OverdueBlock, RisesBlock, SampleBlock, SignupBlock, TargetsBlock, type Blocks } from "../figures/view";
import { ControlsView as LegalControls } from "../legal-texts/controls";
import { proposalProblem, PURPOSES } from "../legal-texts/text";
import { LegalTexts } from "../legal-texts/view";
import { DownloadView } from "../me/download";
import { Me } from "../me/view";
import { ControlsView as SettingControls } from "../settings/controls";
import { readValue, valueText } from "../settings/text";
import { Settings } from "../settings/view";
import { FirmFormView } from "../solicitors/controls";
import { Solicitors } from "../solicitors/view";
import { ReauthNotice } from "./reauth";
import { toolWords } from "./words";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/" }));
const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Launch B|Sample\b|NaN/);
const NOW = new Date("2026-11-25T12:00:00Z");
const IDLE = { pending: false };
const noop = () => {};

describe("settings", () => {
  const list = [
    { key: "draft_job", value: 12, unit: "months", is_guess: true, solicitor_confirmed_at: null, updated_at: "2026-11-01 09:30:00.123456+00" },
    { key: "visitor_limit", value: null, unit: "count", is_guess: false, solicitor_confirmed_at: "2026-11-10 09:00:00+00", updated_at: "2026-11-02 09:30:00+00" },
  ];
  it("shows every setting with its value, the guess and the solicitor's confirmation, and a propose form when nothing waits", () => {
    const p = html(<Settings settings={list} pending={[]} meId="me" />);
    expect(p).toMatch(/Draft job/);
    expect(p).toMatch(/12 months/);
    expect(p).toMatch(/A guess/);
    expect(p).toMatch(/Not yet confirmed by the solicitor/);
    expect(p).toMatch(/Not set/);
    expect(p).toMatch(/Confirmed by the solicitor on/);
    expect(p.match(/Propose this value/g)).toHaveLength(2);
    clean(p);
  });
  it("a change by someone else can be confirmed or refused, and says what confirming does", () => {
    const p = html(<Settings settings={list} pending={[{ requestId: "5", key: "draft_job", value: 6, proposedBy: "other" }]} meId="me" />);
    expect(p).toMatch(/Waiting for a second administrator: 6 months, proposed by another administrator/);
    expect(p).toMatch(/>Confirm</);
    expect(p).toMatch(/>Refuse</);
    expect(p).toMatch(/at once, for everyone/);
  });
  it("my own proposal can only be withdrawn: no confirm button and no confirm box at all", () => {
    const p = html(<Settings settings={list} pending={[{ requestId: "5", key: "draft_job", value: 6, proposedBy: "me" }]} meId="me" />);
    expect(p).toMatch(/proposed by you/);
    expect(p).toMatch(/Withdraw my change/);
    expect(p).not.toMatch(/>Confirm</);
    expect(p).not.toMatch(/Confirm the change/);
  });
  it("an error and a busy state show", () => {
    const h = { onText: noop, onAsk: noop, onPropose: noop, onConfirm: noop, onRefuse: noop };
    const p = html(<SettingControls p={{ settingKey: "draft_job", unit: "months" }} s={{ pending: true, error: toolWords("no_change", 409) }} ui={{ ask: false, text: "6" }} h={h} />);
    expect(p).toMatch(/That is already the value/);
    expect(p).toMatch(/disabled=""/);
  });
  it("the box's text is a whole number from 0 to 100,000, or empty for not set; anything else is held back", () => {
    expect([readValue(""), readValue(" 6 "), readValue("0"), readValue("100000")]).toEqual([null, 6, 0, 100000]);
    for (const bad of ["100001", "-1", "1.5", "1e3", "abc", "１２", "1 2", "9999999", "0x10"]) expect(readValue(bad), bad).toBeUndefined();
    expect(valueText(null, "days")).toBe("Not set");
    expect(valueText(7, "days")).toBe("7 days");
  });
});

describe("legal texts", () => {
  const versions = [
    { id: "3", purpose: "signup_terms", version: "2026-11-12", body: "PLACEHOLDER <b>TEXT</b>.", publishedAt: "2026-11-12 09:30:00+00" },
    { id: "2", purpose: "signup_terms", version: "old-1", body: "OLD", publishedAt: "2026-10-12 09:30:00+00" },
  ];
  const proposal = { requestId: "9", purpose: "privacy_notice", version: "2026-12-01", body: "NEW TEXT", proposedBy: "other", createdAt: "2026-11-20 09:00:00+00" };
  it("shows every purpose, the text in force escaped, earlier versions, and says when nothing is published", () => {
    const p = html(<LegalTexts versions={versions} pending={[]} meId="me" roles={["content_editor"]} />);
    for (const [, label] of PURPOSES) expect(p).toContain(label);
    expect(p).toMatch(/In force: version 2026-11-12/);
    expect(p).toContain("PLACEHOLDER &lt;b&gt;TEXT&lt;/b&gt;.");
    expect(p).not.toContain("<b>TEXT");
    expect(p).toMatch(/Earlier versions: old-1/);
    expect(p).toMatch(/Nothing is published for this text yet/);
    clean(p);
  });
  it("a content editor gets the propose form; an administrator who is not a content editor does not", () => {
    expect(html(<LegalTexts versions={versions} pending={[]} meId="me" roles={["content_editor"]} />)).toMatch(/Propose this version/);
    const admin = html(<LegalTexts versions={versions} pending={[]} meId="me" roles={["administrator"]} />);
    expect(admin).not.toMatch(/Propose this version/);
    expect(admin).toMatch(/A content editor proposes a new version/);
  });
  it("a proposal by someone else: an administrator confirms or refuses, a content editor only waits; the proposer only withdraws", () => {
    const view = (roles: string[], by: string) => html(<LegalTexts versions={versions} pending={[{ ...proposal, proposedBy: by }]} meId="me" roles={roles} />);
    const admin = view(["administrator"], "other");
    expect(admin).toMatch(/Confirm and publish/);
    expect(admin).toMatch(/New sign-ups consent to it from then on/);
    const editor = view(["content_editor"], "other");
    expect(editor).not.toMatch(/Confirm and publish|Publish it/);
    expect(editor).toMatch(/An administrator who did not propose it/);
    for (const roles of [["administrator"], ["content_editor"], ["administrator", "content_editor"]]) {
      const mine = view(roles, "me");
      expect(mine, roles.join()).toMatch(/Withdraw my proposal/);
      expect(mine, roles.join()).not.toMatch(/Confirm and publish|Publish it/);
    }
  });
  it("a refused sign-in age shows the sign in again notice; other refusals show their sentence", () => {
    const h = { onField: noop, onAsk: noop, onPropose: noop, onConfirm: noop, onRefuse: noop };
    const p = { purpose: "privacy_notice", label: "Privacy notice", isAdmin: false, canPropose: true };
    const re = html(<LegalControls p={p} s={{ pending: false, error: toolWords("reauth_required", 403), reauth: true }} ui={{ ask: false, version: "v", body: "b" }} h={h} />);
    expect(re).toMatch(/Sign in again/);
    expect(re).toMatch(/in the last 10 minutes/);
    const taken = html(<LegalControls p={p} s={{ pending: false, error: toolWords("version_taken", 409) }} ui={{ ask: false, version: "v", body: "b" }} h={h} />);
    expect(taken).toMatch(/already used for this text/);
    expect(html(<LegalControls p={p} s={IDLE} ui={{ ask: false, version: "", body: "", problem: toolWords("bad_version", 400) }} h={h} />)).toMatch(/Version label|version label/);
  });
  it("a proposal is checked before it is sent: the label's shape, a blank text, a long text, a hidden character", () => {
    expect(proposalProblem("2026-12-01", "A text.\nLine two\twith a tab")).toBeNull();
    expect(proposalProblem("Bad Label", "x")).toBe("bad_version");
    expect(proposalProblem("", "x")).toBe("bad_version");
    expect(proposalProblem("-start", "x")).toBe("bad_version");
    expect(proposalProblem("a".repeat(65), "x")).toBe("bad_version");
    for (const body of ["", "   \n ", "x".repeat(100001), "a‮b", "a​b", "a\u0000b", "a\u0007b"]) expect(proposalProblem("v1", body), JSON.stringify(body.slice(0, 5))).toBe("bad_body_text");
    expect(proposalProblem("v1", "x".repeat(100000))).toBeNull();
  });
});

describe("data requests", () => {
  const item = (o = {}) => ({ itemId: "52", status: "open", createdAt: "2026-11-19 09:30:00+00", surface: "candidate_site", email: "person@example.test", signedIn: false, confirmPurpose: null, confirmSentAt: null, confirmedAt: null, ...o });
  const pending = { requestId: "160", itemId: "52", kind: "candidate", proposedBy: "other", createdAt: "2026-11-19 09:40:00+00" };
  it("an open request shows the email, the surface and where the owner's confirmation stands; nothing else about the person", () => {
    const p = html(<DataRequests items={[item({ confirmPurpose: "erase", confirmSentAt: "2026-11-19 09:35:00+00" })]} truncated={false} pending={[]} meId="me" />);
    expect(p).toMatch(/person@example\.test/);
    expect(p).toMatch(/Candidate site/);
    expect(p).toMatch(/An erase link was sent on .*Waiting for the account owner/);
    expect(p).toMatch(/Send the export link/);
    expect(p).toMatch(/None waiting/);
    expect(p).not.toMatch(/Propose an erase/); // not proved yet
    clean(p);
  });
  it("an erase can be proposed only when the request is proved: sent while signed in, or the owner confirmed an erase", () => {
    expect(canProposeErase(item({ signedIn: true }))).toBe(true);
    expect(canProposeErase(item({ confirmPurpose: "erase", confirmedAt: "x" }))).toBe(true);
    expect(canProposeErase(item({ confirmPurpose: "export", confirmedAt: "x" }))).toBe(false);
    expect(canProposeErase(item())).toBe(false);
    expect(html(<DataRequests items={[item({ signedIn: true })]} truncated={false} pending={[]} meId="me" />)).toMatch(/Propose an erase/);
  });
  it("the words of the confirmation", () => {
    const w = (t: string) => `W(${t.slice(0, 10)})`;
    expect(confirmText({ confirmPurpose: null, confirmSentAt: null, confirmedAt: null }, w)).toMatch(/No link has been sent/);
    expect(confirmText({ confirmPurpose: "export", confirmSentAt: "2026-11-19 09:35:00+00", confirmedAt: "2026-11-20 09:35:00+00" }, w)).toBe("The account owner confirmed an export on W(2026-11-20).");
  });
  it("an erase waiting for someone else names what goes in its confirm box and can be refused; my own can only be withdrawn", () => {
    const other = html(<DataRequests items={[item()]} truncated={false} pending={[pending]} meId="me" />);
    expect(other).toMatch(/Erase the candidate sign-in for person@example\.test/);
    expect(other).toMatch(/Erase this account for good\?/);
    expect(other).toMatch(/It cannot be undone/);
    for (const g of ERASE_GOES) expect(other).toContain(g);
    expect(other).toMatch(/open services case/);
    expect(other).toMatch(/Confirm the erase/);
    const mine = html(<DataRequests items={[item()]} truncated={false} pending={[{ ...pending, proposedBy: "me" }]} meId="me" />);
    expect(mine).toMatch(/Withdraw my erase/);
    expect(mine).not.toMatch(/Confirm the erase|Erase the account|Erase this account for good/);
  });
  it("an erase whose request is not in the list still reads, and shows no id of a person", () => {
    const p = html(<DataRequests items={[]} truncated={false} pending={[{ ...pending, userId: "q8Hn2LxV0aB7cD9eF1gH3iJ5kL7mN9oP" } as never]} meId="me" />);
    expect(p).toMatch(/the person on request 52/);
    expect(p).not.toMatch(/q8Hn2/);
    expect(p).toMatch(/No data request is open/);
  });
  it("a truncated list says so; every refusal of the route shows its sentence", () => {
    expect(html(<DataRequests items={[item()]} truncated pending={[]} meId="me" />)).toMatch(/oldest 100/);
    const h = { onAsk: noop, onSend: noop, onDo: noop };
    for (const code of ["not_confirmed", "open_services_case", "same_person", "no_account", "close_company_first", "not_open"])
      expect(html(<DataControls p={{ kind: "erase", requestId: "1", who: "a@example.test", account: "candidate sign-in", mine: false }} s={{ pending: false, error: toolWords(code, 409) }} ask={null} h={h} />), code).toContain(toolWords(code, 409).replace(/'/g, "&#x27;"));
  });
});

describe("solicitors", () => {
  const items = [{ id: "3", firm: "Fake Solicitors LLP", contact: "fake.firm@example.test", active: true, createdAt: "2026-11-20 09:00:00+00" }, { id: "4", firm: "Old Firm", contact: "old@example.test", active: false, createdAt: "2026-11-01 09:00:00+00" }];
  it("an administrator can add, edit and deactivate an active firm; a handler only reads", () => {
    const admin = html(<Solicitors items={items} isAdmin />);
    expect(admin).toMatch(/Add a firm/);
    expect(admin).toMatch(/Deactivate/);
    expect(admin.match(/Deactivate/g)).toHaveLength(1); // an inactive firm has no form
    const handler = html(<Solicitors items={items} isAdmin={false} />);
    expect(handler).toMatch(/Fake Solicitors LLP/);
    expect(handler).not.toMatch(/Add a firm|Deactivate|Save/);
    clean(admin + handler);
  });
  it("an empty list says so for each role, and a refusal shows", () => {
    expect(html(<Solicitors items={[]} isAdmin />)).toMatch(/Add the first firm above/);
    expect(html(<Solicitors items={[]} isAdmin={false} />)).toMatch(/An administrator adds the firms/);
    expect(html(<FirmFormView s={{ pending: false, error: toolWords("bad_firm", 400) }} draft={{ firm: "", contact: "" }} adding h={{ onField: noop, onSave: noop }} />)).toMatch(/1 to 200 characters/);
  });
});

describe("my data", () => {
  it("shows the name, the roles in words, and the download; a login with no role says so", () => {
    const p = html(<Me name="Fake Staff" roles={["account_reviewer", "administrator"]} />);
    expect(p).toMatch(/Fake Staff/);
    expect(p).toMatch(/Account reviewer/);
    expect(p).toMatch(/Download my data/);
    expect(p).toMatch(/never holds case evidence/);
    expect(html(<Me name="N" roles={[]} />)).toMatch(/No role yet/);
    clean(p);
  });
  it("the download shows busy, done, an error and the sign in again notice", () => {
    expect(html(<DownloadView s={{ pending: true }} onDownload={noop} />)).toMatch(/Preparing the file/);
    expect(html(<DownloadView s={{ pending: false, done: true }} onDownload={noop} />)).toMatch(/saved to your downloads/);
    expect(html(<DownloadView s={{ pending: false, error: toolWords("not_active_staff", 403) }} onDownload={noop} />)).toMatch(/login is disabled/);
    expect(html(<DownloadView s={{ pending: false, error: "x", reauth: true }} onDownload={noop} />)).toMatch(/Sign in again/);
    expect(html(<ReauthNotice back="/me" />)).toMatch(/come back to this page/);
  });
});

describe("figures", () => {
  const targets = { weeklyActiveCandidates: 420, yesIApplied: 75, markApplied: 30, hires: 4, hiredOnSite: 0, liveJobs: 1200, reports30Days: 6, reportsPer1000LiveJobs: null };
  const all: Blocks = {
    targets,
    signup: [{ day: "2026-11-18", count: 12 }, { day: "2026-11-17", count: 9 }],
    rises: [{ deteName: "Fake Ltd", year: 2026, before: 3, after: 5, organisation: null, foundAt: "2026-11-15T03:10:00.000Z" }],
    overdue: { before: "2026-11-24T10:00:00.000Z", items: [{ id: "88", queue: "fetched_job", status: "open", claimed_by: null, created_at: "2026-11-20 05:40:00+00" }, { id: "89", queue: "account_review", status: "claimed", claimed_by: "q8Hn2LxV0aB7cD9eF1gH3iJ5kL7mN9oP", created_at: "2026-11-20 05:40:00+00" }], truncated: false, approvals: [{ id: "41", kind: "setting", target_table: "setting", created_at: "2026-11-15 09:00:00+00" }], approvalsTruncated: false },
    checks: { items: [{ id: "501", reason: "dete_page_changed", detail: { key: "k", role: "rules_data_editor", name: "Fake notices", address: "https://dete.example.test/page", newTitles: "A new title" }, status: "open", created_at: "2026-11-16 05:40:00+00" }, { id: "502", reason: "dete_page_failing", detail: { key: "k", role: "rules_data_editor", address: "javascript:alert(1)", failure: "HTTP 404" }, status: "claimed", created_at: "2026-11-16 05:40:00+00" }], truncated: false },
    sample: { key: "hand_check_100:2026-11", createdAt: "2026-11-19 09:00:00+00", jobs: [{ id: "7", title: "Fake Engineer", employerName: "Fake Ltd", sourceUrl: "https://jobs.example.test/1", source: "fetched", badge: "critical_skills_eligible", permitType: "critical_skills", passRoute: "stated_pay", occupationCode: "2136", salaryLow: 45000, salaryHigh: 55000, stage: "7 passed", reason: null, quotedEvidence: "Fake quote", approvedByYou: true }] },
    decisions: { next: "99", items: [{ itemId: "88", label: "rejected", reasonCode: "not_in_ireland", decidedAt: "2026-11-16 10:40:00+00", title: "Fake Nurse", employerName: "Fake Clinic", county: "Dublin", occupationCode: "2231", stage: "4 low confidence" }] },
  };
  it("shows every block with its numbers and words", () => {
    const p = html(<Figures b={all} now={NOW} />);
    expect(p).toMatch(/Launch target counts/);
    expect(p).toMatch(/>420</);
    expect(p).toMatch(/No live job/); // reports per 1,000 with no live job
    expect(p).toMatch(/21 in the last 2 days shown/);
    expect(p).toMatch(/18 Nov 2026/);
    expect(p).toMatch(/Not linked/);
    expect(p).toMatch(/Nobody has it/);
    expect(p).toMatch(/Held by a reviewer/);
    expect(p).toMatch(/Changes waiting for a second person/);
    expect(p).toMatch(/A DETE page changed/);
    expect(p).toMatch(/You approved it: ask someone else to check/);
    expect(p).toMatch(/Fake quote/);
    expect(p).toMatch(/not_in_ireland|not in ireland/);
    expect(p).toMatch(/Mark done/);
    expect(p).toMatch(/href="\/figures\?after=99#decisions"/);
    expect(p).not.toMatch(/q8Hn2/); // no staff id
    clean(p);
  });
  it("a block whose read refused the roles is not drawn, and the rest still is", () => {
    const p = html(<Figures b={{ ...all, overdue: null, checks: null, sample: null, decisions: null }} now={NOW} />);
    for (const gone of ["Overdue", "Scheduled checks", "Accuracy sample", "Fetched-job decisions"]) expect(p, gone).not.toContain(gone);
    expect(p).toMatch(/Launch target counts/);
    const bare = html(<Figures b={{ signup: all.signup, rises: all.rises, targets: null, overdue: null, checks: null, sample: null, decisions: null }} now={NOW} />);
    expect(bare).not.toMatch(/Launch target counts|Overdue|Scheduled checks/);
    expect(bare).toMatch(/Sign-ups who answered/);
  });
  it("empty states and truncation notices", () => {
    expect(html(<SignupBlock d={[]} />)).toMatch(/No sign-up has answered no yet/);
    expect(html(<RisesBlock d={[]} />)).toMatch(/No name rose/);
    expect(html(<OverdueBlock now={NOW} d={{ before: "2026-11-24T10:00:00.000Z", items: [], truncated: false, approvals: [], approvalsTruncated: false }} />)).toMatch(/Nothing is overdue/);
    expect(html(<OverdueBlock now={NOW} d={{ before: "2026-11-24T10:00:00.000Z", items: [], truncated: true, approvals: [], approvalsTruncated: true }} />)).toMatch(/More items are overdue[\s\S]*More changes are waiting/);
    expect(html(<ChecksBlock d={{ items: [], truncated: true }} />)).toMatch(/No reminder is open[\s\S]*More reminders/);
    expect(html(<SampleBlock d={{ key: null, createdAt: null, jobs: [] }} />)).toMatch(/No live job yet/);
    expect(html(<DecisionsBlock d={{ next: null, items: [] }} />)).toMatch(/No decision here/);
    expect(html(<TargetsBlock d={targets} />)).toMatch(/>0</);
  });
  it("a link that is not a plain web address is never drawn as a link, and a first page link comes back", () => {
    expect(safeLink("https://dete.example.test/a")).toBe("https://dete.example.test/a");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "ftp://x", "https://a b", undefined]) expect(safeLink(bad), String(bad)).toBeNull();
    const p = html(<ChecksBlock d={all.checks!} />);
    expect(p).not.toMatch(/javascript:/);
    expect(p).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(html(<DecisionsBlock d={{ next: null, items: all.decisions!.items }} prev="/figures#decisions" />)).toMatch(/href="\/figures#decisions"/);
  });
  it("a reminder reason always has words, the day reads in words, and a failed done shows", () => {
    for (const r of Object.keys(REMINDER)) expect(reminderText(r)).toMatch(/^[A-Z]/);
    expect(reminderText("something_new")).toBe("Something new");
    expect(dayText("2026-02-03")).toBe("3 Feb 2026");
    expect(html(<DoneView s={{ pending: false, error: toolWords("already_decided", 409) }} onDone={noop} />)).toMatch(/already done/);
  });
});

describe("the sidebar links of these pages", () => {
  const roleLinks = (r: AdminRole | null) => adminLinks(r ? [r] : []).flatMap((g) => g.links.map((l) => l.href));
  const WANT: Record<string, string[]> = { "/figures": ["any"], "/me": ["any"], "/settings": ["administrator"], "/data-requests": ["administrator"], "/legal-texts": ["content_editor", "administrator"], "/solicitors": ["services_case_handler", "administrator"] };
  it("each link shows to exactly the roles its route lets in (admin.yaml x-roles), and every one has a page folder", () => {
    for (const [href, who] of Object.entries(WANT)) {
      const link = ADMIN_NAV.flatMap((g) => g.links).find((l) => l.href === href)!;
      expect(link, href).toBeDefined();
      expect(link.roles === undefined ? ["any"] : [...link.roles].sort(), href).toEqual([...who].sort());
    }
    expect(roleLinks(null)).toEqual(expect.arrayContaining(["/figures", "/me"]));
    expect(roleLinks(null)).not.toEqual(expect.arrayContaining(["/settings"]));
    expect(roleLinks("content_editor")).toContain("/legal-texts");
    expect(roleLinks("content_editor")).not.toContain("/data-requests");
    expect(roleLinks("services_case_handler")).toContain("/solicitors");
    expect(roleLinks("services_case_handler")).not.toContain("/legal-texts");
  });
});
