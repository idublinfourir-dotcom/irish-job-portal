// P18: the words and the presentational parts of the dashboard, jobs list, close and renew, report, notices and pay floors, rendered to HTML (react-dom/server) with fixture
// props for every state. No database, no network. Every refusal code of every route these pages call is read from docs/openapi/portal.yaml and must have a plain sentence.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

import { DashboardView } from "../dashboard/view";
import { JobsView } from "../jobs/view";
import { NoticesView } from "../notices/view";
import { PayFloorsView } from "../pay-floors/view";
import { CloseView, RenewView, ReportView } from "./actions";
import {
  closeMessage, countWord, daysLeft, expiryWord, floorMessage, holdWord, inTab, jobState, noticeMessage, noticeWord, notRecognisedMessage, rateWord, renewedWord, renewMessage, REPORT_REASONS,
  reportMessage, REVIEW_WORD, roleWord, STATE_WORD, TABS, tabKey, totals, type Job,
} from "./words";

const NOW = Date.parse("2026-11-25T10:00:00Z");
const base: Job = { id: "1", title: "Fake Role", status: "live", permitType: "general", applicationRoute: "own_page", hasOwnPage: true, county: "Cork", postedAt: "2026-11-10T09:00:00Z", closesAt: "2026-12-10T09:00:00Z", closedAt: null, closeReason: null, hireAnswer: null, reason: null, reviewCode: null, exceptionConfirmed: false, clientCheck: false };
const j = (o: Partial<Job> = {}): Job => ({ ...base, ...o });
const STATES: Job[] = [
  j({ id: "1", title: "Fake Live" }), j({ id: "2", title: "Fake Draft", status: "draft" }), j({ id: "3", title: "Fake In Review", status: "in_review", reason: "staff_check" }),
  j({ id: "4", title: "Fake Under Review", status: "under_review", reason: "pay_check" }), j({ id: "5", title: "Fake Renewal Check", status: "under_review", reason: "renewal_check", reviewCode: "PAY_BELOW_MINIMUM" }),
  j({ id: "6", title: "Fake Hidden", status: "hidden", reason: "report" }), j({ id: "7", title: "Fake Expired", status: "closed", closeReason: "expired", closedAt: "2026-11-02T00:00:00Z" }),
  j({ id: "8", title: "Fake Closed", status: "closed", closeReason: "closed", closedAt: "2026-11-03T00:00:00Z" }), j({ id: "9", title: "Fake Removed", status: "closed", closeReason: "removed", closedAt: "2026-11-04T00:00:00Z" }),
];
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|null\b|[A-Z]{3,}_[A-Z_]{3,}/);

describe("words", () => {
  it("every job state has a word, a tab, an expiry cell and a hold sentence that is never a raw code", () => {
    for (const x of STATES) {
      const s = jobState(x);
      expect(STATE_WORD[s]).toBeTruthy();
      expect(TABS.some(([key]) => key !== "all" && inTab(key, x)), x.title).toBe(true);
      clean(expiryWord(x, NOW)); const h = holdWord(x, "2 Nov 2026"); if (h) clean(h);
    }
    expect(jobState(j({ status: "closed", closeReason: "under_review_expired" }))).toBe("expired");
    expect(holdWord(STATES[4]!, null)).toMatch(/below the minimum/);
    expect(holdWord(j({ status: "in_review", reason: "restricted_company" }), null)).toMatch(/restricted/);
  });
  it("BA33: every review code of the yaml has its own words", () => {
    const y = parse(readFileSync(join(import.meta.dirname, "../../../../docs/openapi/portal.yaml"), "utf8"));
    const codes: string[] = y.paths["/api/portal/jobs"].get.responses["200"].content["application/json"].schema.properties.jobs.items.properties.reviewCode.enum.filter(Boolean);
    expect(codes.length).toBeGreaterThan(8);
    for (const c of codes) { expect(REVIEW_WORD[c], c).toBeTruthy(); clean(REVIEW_WORD[c]!); }
  });
  it("one count rule: a count at the route's cap reads 200+, tabs filter by the same function", () => {
    expect(countWord(5)).toBe("5"); expect(countWord(200)).toBe("200+");
    expect(inTab("all", STATES[0]!)).toBe(true);
    expect(STATES.filter((x) => inTab("removed", x)).map((x) => x.id)).toEqual(["6", "9"]);
    expect(tabKey("nonsense")).toBe("all"); expect(tabKey(["live"])).toBe("all");
  });
  it("days, rates, sums and role names", () => {
    expect(daysLeft("2026-11-28T10:00:00Z", NOW)).toBe(3); expect(daysLeft("2026-11-25T11:00:00Z", NOW)).toBe(1); expect(daysLeft(null, NOW)).toBeNull();
    expect(expiryWord(j({ closesAt: "2026-11-28T10:00:00Z" }), NOW)).toBe("3 days left");
    expect(rateWord(412, 9)).toBe("2.2%"); expect(rateWord(0, 0)).toBe("None yet");
    expect([...totals([{ jobId: "1", day: "a", views: 2, applyClicks: 1 }, { jobId: "1", day: "b", views: 3, applyClicks: 0 }]).values()]).toEqual([{ views: 5, clicks: 1 }]);
    expect(roleWord("account_owner")).toBe("Account owner"); expect(roleWord("viewer")).toBe("Viewer"); expect(roleWord("poster")).toBe("Poster"); expect(roleWord("recruiter")).toBe("Recruiter");
  });
  it("renewal answers: renewed with the end date, or held with the rule in words", () => {
    expect(renewedWord({ status: "live", closesAt: "2026-12-25T10:00:00Z" })).toMatch(/until 25 Dec 2026/);
    expect(renewedWord({ status: "under_review", code: "PAY_BELOW_MINIMUM" })).toMatch(/under review.*below the minimum/);
    expect(renewMessage({ status: 422, code: "OCCUPATION_INELIGIBLE" })).toMatch(/Tick the box/);
  });
  it("unknown notice keys read as a general notice and known ones have words", () => {
    expect(noticeWord("zzz")[0]).toBe("You have a notice");
    // every notice the code writes for a portal login has its own words (the keys are read from the migrations and packages/db; the decision, floor and second-row keys are made from codes)
    const dir = (d: string) => readdirSync(new URL(d, import.meta.url)).filter((f) => /\.(sql|ts)$/.test(f) && !f.includes(".test.")).map((f) => readFileSync(new URL(d + f, import.meta.url), "utf8")).join("\n");
    const code = (dir("../../../../packages/db/migrations/") + dir("../../../../packages/db/src/")).replace(/"\s*\+\s*"/g, "");
    const keys = new Set([...code.matchAll(/into notification\s*\([^)]*portal_user_id[^)]*\)([\s\S]{0,300}?)'(?:account|rules|services_case)',\s*'([a-z_]+)'/g)].map((m) => m[2]!));
    for (const k of ["account_approved", "account_needs_info", "account_rejected", "pay_floor_approved", "pay_floor_rejected", "owner_reassign_done"]) keys.add(k);
    expect(keys.size).toBeGreaterThanOrEqual(17);
    expect([...keys].filter((k) => noticeWord(k)[0] === "You have a notice")).toEqual([]);
    expect(noticeWord("team_removed")[0]).toMatch(/^You were removed/); // the removed person gets it, not the team
    expect(noticeWord("report_outcome").join(" ")).not.toMatch(/Account status/); // the reporter gets it; that page never shows a report
    for (const k of ["job_hidden", "strike", "pay_floor_approved", "account_approved", "job_expiry_reminder"]) { expect(noticeWord(k)[0]).not.toBe("You have a notice"); clean(noticeWord(k).join(" ")); }
  });
});

// Every status and code each route can give, read from the yaml, gets a sentence that is not empty and not a raw code.
describe("messages: every refusal code of every route these pages call (docs/openapi/portal.yaml)", () => {
  const y = parse(readFileSync(join(import.meta.dirname, "../../../../docs/openapi/portal.yaml"), "utf8")) as { paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>> };
  const answers = (path: string, verb: "get" | "post") => {
    const out: { status: number; code?: string }[] = [{ status: 0 }, { status: 500 }];
    for (const [status, r] of Object.entries(y.paths[path]![verb]!.responses)) {
      const codes = [...(r.description ?? "").matchAll(/`([A-Z][A-Z_]{3,})`/g)].map((m) => m[1]);
      if (Number(status) >= 400) { out.push({ status: Number(status) }); for (const code of codes) out.push({ status: Number(status), code }); }
    }
    return out;
  };
  const routes: [string, "get" | "post", (a: { status: number; code?: string }) => string][] = [
    ["/api/portal/jobs/close", "post", closeMessage], ["/api/portal/jobs/renew", "post", renewMessage], ["/api/portal/report", "post", reportMessage],
    ["/api/portal/agency-jobs/not-recognised", "post", notRecognisedMessage], ["/api/portal/pay-floors", "post", floorMessage], ["/api/portal/notices", "post", noticeMessage],
  ];
  it.each(routes)("%s", (path, verb, fn) => {
    const list = answers(path, verb);
    expect(list.length).toBeGreaterThan(5);
    const seen = new Set<string>();
    for (const a of list) { const m = fn(a); expect(m.length, `${path} ${a.status} ${a.code}`).toBeGreaterThan(15); clean(m); seen.add(m); }
    expect(seen.size, path).toBeGreaterThan(3);
  });
  it("close: the BA9 states each have their own sentence", () => {
    const m = [closeMessage({ status: 403, code: "NOT_A_POSTER" }), closeMessage({ status: 409, code: "BAD_STATE" }), closeMessage({ status: 429 }), closeMessage({ status: 404, code: "JOB_NOT_FOUND" })];
    expect(new Set(m).size).toBe(4);
  });
  it("the pay floor re-sign-in code is a sign-in prompt, not a password box", () => {
    expect(floorMessage({ status: 403, code: "REAUTH_REQUIRED" })).toMatch(/sign in again/);
  });
});

const fx = {
  now: NOW, role: "account_owner", jobs: STATES, stats: [{ jobId: "1", day: "2026-11-24", views: 40, applyClicks: 4 }, { jobId: "1", day: "2026-11-20", views: 10, applyClicks: 1 }],
  status: { status: "verified", strikesLast12Months: 1, restrictedUntil: null, cases: [{ canReply: true, canAppeal: false }] },
  team: { myMembershipId: "1", members: [{ membershipId: "1", name: "Fake Person", email: "a@example.test", role: "account_owner", isSigner: true }, { membershipId: "2", name: null, email: "b@example.test", role: "viewer", isSigner: false }] },
  teamOk: true, agency: [{ id: "77", title: "Fake Agency Job", agencyId: "88", agencyName: "Fake Recruit Ltd", status: "live", postedAt: "2026-11-18T09:30:00Z" }],
};
describe("dashboard view", () => {
  it("owner: tiles, an ending job, real role names, agency list with both buttons, no Hire recorded or Applied", () => {
    const s = html(<DashboardView {...fx} jobs={[...STATES, j({ id: "10", title: "Fake Ending", closesAt: "2026-11-27T10:00:00Z" })]} />);
    expect(s).toMatch(/Good morning|Good afternoon/); expect(s).toContain("Apply clicks, 30 days"); expect(s).toContain("Fake Ending ends in 2 days");
    expect(s).toMatch(/Account owner/); expect(s).toMatch(/Viewer/); expect(s).toContain("Fake Person"); expect(s).toContain("Fake Agency Job"); expect(s).toContain("I do not recognise this job"); expect(s).toContain(">Report<");
    expect(s).not.toMatch(/Hire recorded|New applicants|>Applied<|company domain|Member</); clean(s.replace(/<[^>]+>/g, " "));
  });
  it("viewer: no write button at all", () => {
    const s = html(<DashboardView {...fx} role="viewer" jobs={[j({ closesAt: "2026-11-26T10:00:00Z" })]} />);
    expect(s).not.toMatch(/>Renew<|>Close<|I do not recognise|Invite|Request permit services/); expect(s).toMatch(/Ask a poster/);
  });
  it("poster has Renew and Close but not the owner's agency button; recruiter sees permit services", () => {
    const s = html(<DashboardView {...fx} role="poster" jobs={[j({ closesAt: "2026-11-26T10:00:00Z" })]} />);
    expect(s).toContain(">Renew<"); expect(s).not.toContain("I do not recognise");
    expect(html(<DashboardView {...fx} role="recruiter" />)).toContain("Request permit services");
  });
  it("empty and failed reads: an empty company, and every card unavailable", () => {
    expect(html(<DashboardView {...fx} jobs={[]} agency={[]} />)).toMatch(/No jobs yet.*No agency has posted/s);
    const s = html(<DashboardView now={NOW} role="account_owner" team={null} teamOk={false} />);
    expect(s).toContain("Your jobs cannot be shown now"); expect(s).toContain("The account status cannot be shown now"); expect(s).toContain("The team cannot be shown now"); expect(s).toContain("The agency jobs list cannot be shown now");
  });
  it("a restricted or suspended company still renders with its status in words", () => {
    expect(html(<DashboardView {...fx} status={{ ...fx.status, status: "suspended" }} />)).toContain("Suspended");
    expect(html(<DashboardView {...fx} status={{ ...fx.status, status: "verified_restricted", restrictedUntil: "2026-12-30T00:00:00Z" }} />)).toContain("Restricted until 30 Dec 2026");
  });
});

describe("jobs view", () => {
  it("tabs with counts by one rule, hold sentences, stats card with Apply clicks", () => {
    const s = html(<JobsView now={NOW} role="account_owner" jobs={STATES} stats={fx.stats} />);
    for (const t of ["All 9", "Live 1", "In review 1", "Under review 2", "Expired 1", "Closed 1", "Removed 2", "Drafts 1"]) expect(s, t).toContain(t);
    expect(s).toContain("Apply clicks"); expect(s).toContain("Click rate"); expect(s).toContain("Fake Live stats"); expect(s).toContain("Last 30 days");
    expect(s).not.toMatch(/>Applied<|page 2/i);
  });
  it("each tab shows only its jobs; a closed job shows Closed by you with its date", () => {
    const s = html(<JobsView now={NOW} role="account_owner" jobs={STATES} stats={[]} tab="closed" />);
    expect(s).toContain("Fake Closed"); expect(s).not.toContain("Fake Live<"); expect(s).toContain("Closed by you on 3 Nov 2026");
  });
  it("Previous and Next only; the job form links show for a poster (P19 is built) and never for a viewer", () => {
    const many = Array.from({ length: 45 }, (_, i) => j({ id: String(100 + i), title: `Fake Bulk ${i}` }));
    const s = html(<JobsView now={NOW} role="poster" jobs={many} stats={[]} from="20" />);
    expect(s).toContain('rel="prev"'); expect(s).toContain('rel="next"'); expect(s).toContain('href="/jobs/new"'); expect(s).toMatch(/href="\/jobs\/\d+\/edit"/);
    expect(html(<JobsView now={NOW} role="viewer" jobs={many} stats={[]} />)).not.toMatch(/\/jobs\/new|\/edit/);
    expect(html(<JobsView now={NOW} role="poster" jobs={STATES} stats={[]} />)).toContain('href="/jobs/new?from=7"'); // Repost on an expired job
  });
  it("viewer sees no write button; empty and failed states", () => {
    expect(html(<JobsView now={NOW} role="viewer" jobs={STATES} stats={[]} />)).not.toMatch(/>Renew<|>Close</);
    expect(html(<JobsView now={NOW} role="account_owner" jobs={[]} stats={[]} />)).toContain("No jobs yet");
    expect(html(<JobsView now={NOW} role="account_owner" jobs={STATES} stats={[]} tab="draft" />)).not.toContain("Fake Live<");
    expect(html(<JobsView now={NOW} role="account_owner" />)).toContain("We cannot show your jobs now");
  });
  it("hostile address values fall back to safe defaults", () => {
    for (const x of [{ tab: "<script>" }, { from: "-1" }, { from: "9".repeat(50) }, { pick: "zz" }]) expect(html(<JobsView now={NOW} role="account_owner" jobs={STATES} stats={[]} {...x} />)).not.toContain("<script>");
  });
});

describe("close, renew, report", () => {
  it("close asks yes or no (CF45), not three answers; a draft skips the question (B52); Close is off until answered", () => {
    const live = html(<CloseView title="Fake" draft={false} canRenew />);
    expect(live).toContain("Did you hire someone through us?"); expect(live).toContain(">Yes<"); expect(live).toContain(">No<"); expect(live).not.toMatch(/somewhere else|no longer open/);
    expect(live).toMatch(/disabled=""[^>]*>Close job|>Close job<\/button>/); expect(live).toContain("Renew for 30 days instead");
    const draft = html(<CloseView title="Fake" draft canRenew={false} />);
    expect(draft).not.toContain("Did you hire"); expect(draft).not.toContain("Renew for 30 days instead");
    const held = html(<CloseView title="Fake" draft={false} canRenew={false} />); // under review or in review: not in search, and not live to keep
    expect(held).not.toContain("Keep it live"); expect(held).not.toContain("leaves search"); expect(held).toContain("not in search now");
    expect(html(<CloseView title="Fake" draft={false} canRenew={false} error={closeMessage({ status: 409, code: "BAD_STATE" })} />)).toContain("cannot be closed in its current state");
  });
  it("renew: held with a code, and the exception tick (BA36)", () => {
    expect(html(<RenewView text={renewedWord({ status: "under_review", code: "PAY_BELOW_MINIMUM" })} />)).toContain("under review");
    const s = html(<RenewView text={renewMessage({ status: 422 })} exception="Except for fake nurses" />);
    expect(s).toContain("Except for fake nurses"); expect(s).toContain("I confirm my company meets this exception");
  });
  it("report: the reasons of the target, the evidence box, sent state, error state", () => {
    const job = html(<ReportView kind="job" />), co = html(<ReportView kind="company" />);
    for (const [, label] of REPORT_REASONS.job) expect(job).toContain(label);
    expect(co).toContain("The company is not real"); expect(job).not.toContain("The company is not real");
    expect(html(<ReportView kind="job" sent />)).toContain("Report sent");
    expect(html(<ReportView kind="job" error={reportMessage({ status: 409, code: "ALREADY_REPORTED" })} />)).toContain("already have an open report");
  });
});

describe("notices view", () => {
  const item = { id: "1", category: "account", templateKey: "job_hidden", createdAt: "2026-11-24T09:00:00Z", readAt: null };
  it("unread and read, empty, failed, bad cursor, paging", () => {
    const s = html(<NoticesView items={[item, { ...item, id: "2", readAt: "2026-11-24T10:00:00Z", templateKey: "mystery" }]} next="abc" unread={1} after="zzz" />);
    expect(s).toContain("One of your jobs was hidden"); expect(s).toContain("You have a notice"); expect(s).not.toContain("mystery"); expect(s).toContain("1 unread");
    expect(s).toContain('rel="prev"'); expect(s).toContain("/notices?after=abc");
    expect(html(<NoticesView items={[]} next={null} unread={0} />)).toContain("No notices yet");
    expect(html(<NoticesView next={null} unread={0} />)).toContain("We cannot show your notices now");
    expect(html(<NoticesView items={[]} next={null} unread={0} bad />)).toContain("not available");
    expect(html(<NoticesView items={[item]} next={null} unread={200} />)).toContain("200 or more");
  });
});

describe("pay floors view", () => {
  const text = { id: "5", version: "1", body: "FAKE WORDING" };
  const floors = [{ id: "1", roleFamily: "2136", floorEur: 65000, status: "pending_check", signedAt: "2026-11-18T09:00:00Z", validUntil: "2027-11-18T09:00:00Z", endedAt: null, signerName: "Fake Signer", signerTitle: "Account owner" }, { id: "2", roleFamily: "2231", floorEur: 40000, status: "withdrawn", signedAt: "2026-10-18T09:00:00Z", validUntil: "2027-10-18T09:00:00Z", endedAt: "2026-11-01T09:00:00Z", signerName: null, signerTitle: null }];
  it("signer: wording, form, status words, Withdraw only on a waiting or active floor", () => {
    const s = html(<PayFloorsView canSign text={text} floors={floors} />);
    expect(s).toContain("FAKE WORDING"); expect(s).toContain('name="roleFamily"'); expect(s).toContain("Waiting for a check"); expect(s).toContain("Withdrawn"); expect((s.match(/>Withdraw</g) ?? []).length).toBe(1); expect(s).toContain("€65,000");
  });
  it("viewer: no form, no Withdraw; no wording, empty and failed states", () => {
    const s = html(<PayFloorsView canSign={false} text={text} floors={floors} />);
    expect(s).not.toContain('name="roleFamily"'); expect(s).not.toContain(">Withdraw<"); expect(s).toContain("not sign them");
    expect(html(<PayFloorsView canSign text={null} floors={[]} />)).toMatch(/No wording is published yet.*No pay floors yet/s);
    expect(html(<PayFloorsView canSign text={null} />)).toContain("We cannot show your pay floors now");
  });
});
