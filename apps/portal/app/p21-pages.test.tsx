// P21: every refusal code of every route the company, team, account status, settings and help pages call has its own plain sentence (the codes are read from docs/openapi/portal.yaml, not typed here),
// and every state of every page renders. react-dom/server, no browser, no network, no database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

import { CODE_TEXT, COUNTIES, day, needsReauth, say } from "./_account/messages";
import { caseState, StatusView, type Case, type StatusPage } from "./account-status/view";
import { CompanyView, type Company } from "./company/view";
import { CloseView } from "./company/forms";
import { ContactView } from "./help/forms";
import { topicsFor } from "./help/topics";
import { HelpView } from "./help/view";
import { SettingsView } from "./settings/view";
import { TeamView, type Team } from "./team/forms";

/** The page as HTML, without React's comment markers between text pieces. */
const html = (e: ReactElement) => renderToStaticMarkup(e).replaceAll("<!-- -->", "");
const yaml = parse(readFileSync(join(import.meta.dirname, "../../../docs/openapi/portal.yaml"), "utf8")) as { paths: Record<string, Record<string, unknown>>; components: { schemas: { County: { enum: string[] } } } };
/** Every UPPER_SNAKE code a path's text names between backticks, or gives as an example `code`. */
function codesOf(path: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) out.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "code" && typeof x === "string" && /^[A-Z_]+$/.test(x)) out.add(x); walk(x); }
  };
  walk(yaml.paths[path]);
  return [...out];
}
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|Better Auth|[A-Z]{3,}_[A-Z_]{3,}|stack|\bban(ned)?\b|reporter|evidence/i);

describe("messages", () => {
  // The codes the pages' own routes can answer (the logo's public GET and the sign-up codes of the auth route are not called by these pages).
  const PATHS = ["/api/portal/company", "/api/portal/company/close", "/api/portal/company/logo", "/api/portal/contact", "/api/portal/status", "/api/portal/team", "/api/portal/account", "/api/portal/account/export", "/api/portal/notices/settings"];
  const AUTH = ["REAUTH_REQUIRED", "DOMAIN_CHANGE_REFUSED", "INVALID_EMAIL", "EMAIL_TAKEN"]; // change-email on /api/auth/portal/{path}
  it("every code of every route the pages call has a sentence, and none is a raw code", () => {
    const codes = [...new Set([...PATHS.flatMap(codesOf), ...AUTH])];
    expect(codes.length).toBeGreaterThan(30); // the yaml walk finds them
    const missing = codes.filter((c) => !(c in CODE_TEXT));
    expect(missing).toEqual([]);
    for (const c of codes) { expect(CODE_TEXT[c]!.length).toBeGreaterThan(15); clean(CODE_TEXT[c]!); }
    for (const c of AUTH) expect(yaml.paths["/api/auth/portal/{path}"] && JSON.stringify(yaml.paths["/api/auth/portal/{path}"])).toContain(c);
  });
  it("no sentence is the same as another's for different meanings (each code says its own thing)", () => {
    const text = Object.values(CODE_TEXT);
    expect(new Set(text).size).toBe(text.length);
  });
  it("every status with no known code still gives a plain sentence", () => {
    for (const status of [0, 400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503]) for (const code of [undefined, "X", "INVALID_ORIGIN"]) { const m = say({ status, code }); expect(m.length).toBeGreaterThan(15); clean(m); }
    expect(say({ status: 0 })).toMatch(/reach the server/);
    expect(say({ status: 429 })).toMatch(/Too many/);
    expect(say({ status: 403, code: "REFUSED" })).not.toMatch(/ban|block/i); // a ban answers the same REFUSED as a blocked login (#191)
  });
  it("REAUTH_REQUIRED is the only answer that sends the person to sign in again", () => {
    expect(needsReauth({ status: 403, code: "REAUTH_REQUIRED" })).toBe(true);
    expect(needsReauth({ status: 403, code: "NOT_OWNER" })).toBe(false);
    expect(needsReauth({ status: 401 })).toBe(false);
  });
  it("the county list is the yaml's", () => expect([...COUNTIES]).toEqual(yaml.components.schemas.County.enum));
  it("dates are Irish time and a bad one gives null", () => {
    expect(day("2026-11-09T23:30:00.000Z")).toBe("9 Nov 2026");
    expect(day("2026-07-09T23:30:00.000Z")).toBe("10 Jul 2026"); // summer time
    expect(day(null)).toBeNull();
    expect(day("nope")).toBeNull();
  });
});

const C: Company = { name: "Fake Hotels Limited", slug: "fake-hotels", status: "verified", description: "A made-up hotel group.", descriptionMax: 2000, website: "https://www.fakehotels.example", county: "Galway", claimed: true, labels: ["First-time sponsor"], croNumber: "000123", croStatus: "Normal", legalNames: ["Fake Hotels Limited"], permitsSince: 2019, permitCount: null };
const company = (c: Partial<Company> = {}, o: Partial<{ isOwner: boolean; logoSrc: string | null; publicHref: string | null; members: number | null; invites: number | null }> = {}) =>
  html(<CompanyView c={{ ...C, ...c }} isOwner={o.isOwner ?? true} logoSrc={o.logoSrc ?? null} publicHref={o.publicHref === undefined ? "https://c.example/companies/fake-hotels" : o.publicHref} members={o.members ?? 3} invites={o.invites ?? 1} />);

describe("company profile (E18, BA31)", () => {
  it("owner: the form, the logo button, the 2000 limit, the editable county, the read-only name, the records, the preview, the close section, the public link", () => {
    const p = company();
    for (const t of ["Company profile", "Upload logo", "PNG, JPEG or WebP, up to 1 MB", "22 of 2000 characters", "Display name", "Ask us if it is wrong", "From the records", "You cannot edit these", "000123 · status Normal", "No permit record is linked", "Claimed", "First-time sponsor", "Preview", "Close my company", "View public page", "Ask us to fix it"]) expect(p, t).toContain(t);
    expect(p).toMatch(/<select[^>]*name="county"/); // CF20
    expect(p).toMatch(/<input[^>]*readonly[^>]*value="Fake Hotels Limited"|<input[^>]*value="Fake Hotels Limited"[^>]*readonly/i); // CF100
    expect(p).not.toMatch(/PNG or SVG|240 px|61 of 300/); // CF47, CF48
    expect(p).toContain('href="https://c.example/companies/fake-hotels"');
    expect(p).toContain('href="/help?topic=account#contact"');
  });
  it("viewer or other non-owner: the same page with no buttons, a locked form and no close section", () => {
    const p = company({}, { isOwner: false });
    expect(p).not.toMatch(/Upload logo|Close my company|type="submit"|>Save</);
    expect(p).toContain("Only the account owner can change the profile");
    expect(p).toMatch(/<textarea[^>]*readonly/i);
  });
  it("a suspended company: warned, no save, no close; its public link is hidden; a pending one can edit but has no public link", () => {
    const s = company({ status: "suspended" });
    expect(s).toContain("cannot be changed now");
    expect(s).not.toMatch(/type="submit"|Close my company|View public page/);
    const w = company({ status: "pending_review" });
    expect(w).toMatch(/type="submit"/);
    expect(w).not.toContain("View public page");
  });
  it("records: legal names, a permit count (singular and plural), no link yet, a missing CRO number; a logo is shown from its own path; no logo shows initials", () => {
    expect(company({ permitCount: 1 })).toContain("1 permit since 2019");
    expect(company({ permitCount: 148, labels: [] })).toContain("148 permits since 2019");
    expect(company({ croNumber: null, croStatus: null, legalNames: [] })).toMatch(/None given[\s\S]*Not on record yet|Not on record yet[\s\S]*None given/);
    expect(company({}, { logoSrc: "/api/portal/company/logo/a.png" })).toContain('src="/api/portal/company/logo/a.png"');
    expect(company()).toMatch(/data-logo[^>]*>FH</);
  });
  it("hostile text is escaped, never markup", () => {
    const p = company({ name: "<script>alert(1)</script> Ltd", description: "<img src=x onerror=1>" });
    expect(p).not.toMatch(/<script>|<img src=x/);
    expect(p).toContain("&lt;script&gt;");
  });
  it("close: the counts, the typed name, the final warning, and the end screen with what was ended", () => {
    const p = html(<CloseView name="Fake Hotels Limited" members={3} invites={1} open />);
    for (const t of ["Type Fake Hotels Limited to confirm", "3 memberships end", "1 open invitation is cancelled", "This cannot be undone", "Keep my company"]) expect(p, t).toContain(t);
    expect(html(<CloseView name="X Ltd" members={1} invites={0} open />)).toContain("1 membership ends");
    expect(html(<CloseView name="X Ltd" members={null} invites={null} open />)).not.toMatch(/\d+ memberships? ends?|\d+ open invitations? (is|are)/);
    expect(html(<CloseView name="X Ltd" members={1} invites={0} open done={{ jobsClosed: 2, membershipsEnded: 1, invitesCancelled: 0 }} />)).toContain("2 jobs closed, 1 memberships ended, 0 invitations cancelled");
  });
});

const T: Team = {
  members: [
    { membershipId: "1", name: "Fake Owner", email: "owner@fake.example", role: "account_owner", isSigner: true, lastActiveAt: "2026-11-20T10:00:00.000Z" },
    { membershipId: "2", name: null, email: "poster@fake.example", role: "poster", isSigner: false, lastActiveAt: null },
  ],
  invites: [{ membershipId: "3", email: "new@fake.example", role: "recruiter", isSigner: true, invitedAt: "2026-11-18T09:00:00.000Z", expiresAt: "2026-11-25T09:00:00.000Z" }],
  requests: [{ membershipId: "4", name: "Fake Asker", email: "asker@fake.example" }],
};
const team = (t: Partial<Team> = {}, o: Partial<{ isOwner: boolean; limit: number; error: string; note: string }> = {}) => html(<TeamView team={{ ...T, ...t }} myId="1" isOwner={o.isOwner ?? true} limit={o.limit ?? 10} error={o.error} note={o.note} act={async () => true} />);

describe("team (E19, DD17)", () => {
  it("owner: people with the real role names, the signer column, last active, invites, requests, the invite form with a role picker, transfer", () => {
    const p = team();
    for (const t of ["Account owner", "Poster", "Fake Owner (you)", "owner@fake.example", "20 Nov 2026", "Not yet", "Invited", "Recruiter · invite sent 18 Nov 2026", "Resend", "Cancel", "Change role", "Remove", "Join requests", "Fake Asker", "Approve", "Refuse", "Invite a teammate", "Send invite", "Transfer ownership", "4 of 10 places used"]) expect(p, t).toContain(t);
    for (const r of ["Viewer", "Poster", "Recruiter"]) expect(p).toContain(`>${r}</option>`);
    expect(p).not.toMatch(/>Member</); // CF97
    expect(p).toMatch(/and the person who posted the job|as does the person who posted the job/); // CF89
    expect(p).not.toMatch(/company domain/i); // CF96: no domain sentence on the invite form
  });
  it("a non-owner sees the people and nothing to press, and no invitations, requests or transfer", () => {
    const p = team({ invites: [], requests: [] }, { isOwner: false });
    expect(p).toContain("Fake Owner (you)");
    expect(p).not.toMatch(/Remove|Change role|Resend|Invite a teammate|Join requests|Transfer ownership|type="submit"/);
  });
  it("full: x of limit and a locked invite button; an error and a done line show", () => {
    const p = team({}, { limit: 4 });
    expect(p).toContain("4 of 4 places used");
    expect(p).toContain("The team is full");
    expect(p).toMatch(/<button[^>]*disabled[^>]*>Send invite|<button[^>]*type="submit"[^>]*disabled/);
    expect(team({}, { error: "Only the account owner can do this." })).toContain("Only the account owner can do this.");
    expect(team({}, { note: "We sent an invitation." })).toContain("We sent an invitation.");
  });
  it("transfer with no other member says to invite first", () => expect(team({ members: [T.members[0]!], invites: [], requests: [] })).toContain("Invite a teammate first"));
  it("hostile names and emails are escaped", () => expect(team({ members: [{ ...T.members[0]!, name: "<b>x</b>" }] })).not.toContain("<b>x</b>"));
});

const K = (o: Partial<Case> = {}): Case => ({ id: "7", caseKind: "false_claim", reasonCode: "false_sponsorship", jobTitle: "Fake Role", noticeSummary: "Staff summary.", stage: "reply_window", outcome: null, level: null, createdAt: "2026-11-10T09:00:00.000Z", notifiedAt: "2026-11-11T09:00:00.000Z", replyDueAt: "2026-11-18T09:00:00.000Z", employerReply: null, repliedAt: null, decidedAt: null, appealDueAt: null, appealText: null, appealedAt: null, appealDecidedAt: null, canReply: false, canAppeal: false, ...o });
const P = (o: Partial<StatusPage> = {}): StatusPage => ({ status: "verified", restrictedUntil: null, claimsRemovedAt: null, isOwner: true, strikesLast12Months: 0, cases: [], ...o });
const status = (p: Partial<StatusPage> = {}) => html(<StatusView p={P(p)} />);

describe("account status (E20, DD18)", () => {
  it("good standing with no cases", () => {
    const p = status();
    for (const t of ["Account status", "Good standing", "No strikes", "No cases", "Instant ban"]) expect(p, t).toContain(t);
    expect(p).not.toMatch(/Strike 1 of 3/);
  });
  it("strike 1, 2 and 3 light the right box and name the state", () => {
    expect(status({ strikesLast12Months: 1 })).toMatch(/Strike 1 of 3[\s\S]*Warning/);
    expect(status({ strikesLast12Months: 2 })).toContain("Restricted");
    expect(status({ strikesLast12Months: 3 })).toMatch(/Strike 3 of 3[\s\S]*Banned/);
    expect(status({ strikesLast12Months: 1 })).toMatch(/data-strike="1" data-on="true"/);
    expect(status({ strikesLast12Months: 9 })).toContain("Strike 3 of 3"); // never "of 3" over 3
  });
  it("an open case the owner can reply to shows the reply form and the date; no documents, no evidence button (CF101, L8)", () => {
    const p = status({ cases: [K({ canReply: true })] });
    for (const t of ["Case 7 · Fake Role", "Waiting for your reply", "Your reply", "Send reply", "Reply by 18 Nov 2026", "Staff summary.", "Text only"]) expect(p, t).toContain(t);
    expect(p).not.toMatch(/See the evidence|Add documents|type="file"|Choose files/);
  });
  it("a decided case the owner can appeal shows the appeal form and the window the read gives (CF49), not a typed number of days", () => {
    const p = status({ strikesLast12Months: 1, cases: [K({ stage: "decided", outcome: "strike", level: 1, decidedAt: "2026-11-20T09:00:00.000Z", appealDueAt: "2026-11-27T09:00:00.000Z", canAppeal: true, employerReply: "We fixed it.", repliedAt: "2026-11-12T09:00:00.000Z" })] });
    for (const t of ["Decided: strike applied", "Appeal this decision", "Send appeal", "Appeal by 27 Nov 2026", "We fixed it."]) expect(p, t).toContain(t);
  });
  it("a viewer or poster sees the case and no form", () => {
    const p = status({ isOwner: false, cases: [K({ canReply: true })] });
    expect(p).not.toMatch(/Send reply|<textarea/);
  });
  it("post-appeal states: appealed, upheld, overturned; and cleared", () => {
    const base = { decidedAt: "2026-11-20T09:00:00.000Z", outcome: "strike", appealText: "Here is why.", appealedAt: "2026-11-21T09:00:00.000Z" };
    expect(caseState(K({ ...base, stage: "appealed" })).text).toBe("Appeal sent");
    expect(caseState(K({ ...base, stage: "upheld", appealDecidedAt: "2026-11-22T09:00:00.000Z" })).text).toBe("Appeal decided: decision kept");
    expect(caseState(K({ ...base, stage: "overturned", appealDecidedAt: "2026-11-22T09:00:00.000Z" })).text).toBe("Appeal decided: decision overturned");
    expect(caseState(K({ decidedAt: "2026-11-20T09:00:00.000Z", outcome: "cleared", stage: "decided" })).text).toBe("Decided: no strike");
    expect(caseState(K({ decidedAt: "2026-11-20T09:00:00.000Z", outcome: "ban", stage: "decided" })).text).toBe("Decided: account banned");
    expect(status({ cases: [K({ ...base, stage: "appealed" })] })).toContain("Here is why.");
  });
  it("restricted, suspended, banned and closed companies each say so, and claims removed shows its date; no word of a report, reporter or evidence anywhere", () => {
    expect(status({ status: "verified_restricted", restrictedUntil: "2026-12-01T09:00:00.000Z" })).toContain("Until 1 Dec 2026");
    expect(status({ status: "suspended" })).toContain("This account is suspended");
    expect(status({ status: "banned" })).toContain("This account is banned");
    expect(status({ status: "closed" })).toContain("This company is closed");
    expect(status({ claimsRemovedAt: "2026-11-01T09:00:00.000Z" })).toContain("Since 1 Nov 2026");
    const all = [status({ strikesLast12Months: 3, status: "banned", cases: [K({ canReply: true }), K({ id: "8", stage: "decided", outcome: "ban", decidedAt: "2026-11-20T09:00:00.000Z" })] })].join("");
    expect(all).not.toMatch(/reporter|evidence|\breported\b|candidate reported/i); // #99, #220
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
  it("copy: CF73 says what happens (hidden and suspended at once, a ban can follow); CF49 gives no typed day count", () => {
    const p = status();
    expect(p).toMatch(/hides your jobs and suspends the account at once/);
    expect(p).not.toMatch(/removes the account and all jobs|7 days|14 days|90 days/);
  });
  it("staff text is escaped", () => expect(status({ cases: [K({ noticeSummary: "<script>x</script>", jobTitle: "<b>t</b>" })] })).not.toMatch(/<script>|<b>t/));
});

const settings = (o: Partial<{ email: string; reminder: boolean | null; banner: "confirm" | "EMAIL_TAKEN" | null }> = {}) => html(<SettingsView email={o.email ?? "owner@fake.example"} reminder={o.reminder === undefined ? true : o.reminder} banner={o.banner ?? null} />);
describe("settings (BA30)", () => {
  it("shows the email, change, sign out everywhere, the switch, download and delete", () => {
    const p = settings();
    for (const t of ["Settings", "owner@fake.example", "Change", "Sign out everywhere", "3 days before a job I posted ends", "Security notices", "Download my data", "Delete my login", "Sign-in", "Notifications", "Your data"]) expect(p, t).toContain(t);
    expect(p).toMatch(/role="switch"[^>]*checked=""/);
    expect(settings({ reminder: false })).not.toMatch(/role="switch"[^>]*checked=""/);
  });
  it("a failed notice read says so instead of a guessed switch; the return banners show", () => {
    expect(settings({ reminder: null })).toContain("cannot show your notification settings");
    expect(settings({ banner: "confirm" })).toContain("Link confirmed");
    expect(settings({ banner: "EMAIL_TAKEN" })).toContain("already has a login");
    expect(settings()).not.toMatch(/Link confirmed|already has a login/);
  });
  it("no dangerous HTML, no password box of our own (re-sign-in uses the sign-in page)", () => expect(settings()).not.toMatch(/dangerouslySetInnerHTML|type="password"/));
});

describe("help (BA22)", () => {
  const help = (o: Partial<{ signedIn: boolean; member: boolean; topic: string; candidateHelp: string | null }> = {}) => html(<HelpView signedIn={o.signedIn ?? true} member={o.member ?? true} topic={o.topic ?? ""} candidateHelp={o.candidateHelp === undefined ? "https://c.example/help" : o.candidateHelp} signIn="/sign-in" />);
  it("a member: topic cards to the pages that answer, the contact form with every topic but appeal", () => {
    const p = help();
    for (const t of ["How can we", "Contact us", "Send message", 'href="/settings"', 'href="/verification"', 'href="/account-status"', 'href="/team"', "A question about the site", "My account or company", "My data: export or erase", "Something else"]) expect(p, t).toContain(t);
    expect(p).not.toContain('value="appeal"');
    expect(p).not.toMatch(/name="name"|name="email"/); // the login's own are used
  });
  it("a visitor (a blocked login holds no session) sees the appeal topic only, with name and email, and a sign-in link", () => {
    expect(topicsFor(false)).toEqual(["appeal"]);
    const p = help({ signedIn: false, member: false });
    expect(p).toContain('value="appeal"');
    expect(p).toMatch(/name="name"/);
    expect(p).toMatch(/name="email"/);
    expect(p).toContain('href="/sign-in"');
    expect(p).not.toContain("My data: export");
  });
  it("the topic from the address is kept only when this sender may use it", () => {
    expect(html(<ContactView signedIn topic="account" />)).toMatch(/<option value="account" selected/);
    expect(html(<ContactView signedIn topic="appeal" />)).not.toContain('value="appeal"');
    expect(html(<ContactView signedIn={false} topic="general" />)).toMatch(/value="appeal"/);
  });
  it("the candidate-site link is left out when its address is not set; sent state", () => {
    expect(help({ candidateHelp: null })).not.toContain("Open candidate help");
    expect(html(<ContactView signedIn topic="" sent />)).toContain("Message sent");
    expect(html(<ContactView signedIn topic="" error="Too many tries. Wait 10 minutes, then try again." />)).toContain("Too many tries");
  });
});

describe("the whole slice", () => {
  it("no page shows a frame's dummy data, Launch B, a photo or a dash", () => {
    const all = [company(), team(), status({ strikesLast12Months: 1, cases: [K({ canReply: true })] }), settings(), html(<HelpView signedIn member topic="" candidateHelp={null} signIn="/sign-in" />)].join("");
    expect(all).not.toMatch(/Harbourline|Aoife|Ciaran|Sinead|Oisin|T-0087|\(sample\)|Sample|Permitly|Launch B|Candidate search|Contact requests|<img src="http/);
    expect(all).not.toMatch(/[\u2013\u2014]|dangerouslySetInnerHTML/);
    expect(all).not.toMatch(/#[0-9a-f]{6}\b/i); // no hand-typed colour
  });
});
