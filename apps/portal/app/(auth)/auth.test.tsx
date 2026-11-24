// P13: every answer of the routes the employer sign-up, sign-in and claim forms call has a message, and every state of every form renders. react-dom/server, no browser, no network.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

import { AuthFrame, STEPS } from "./frame";
import { afterVerify, CheckEmailView, ForgotView, ResendView, ResetView, SignInView, SignUpView } from "./forms";
import { AcceptView, AgencyView, AnswerView, ClaimView, croFound, FirstTimeView, firstTimeHref } from "./company-forms";
import { verifyCallback } from "./api";
import {
  acceptMessage, answerMessage, companyMessage, INVALID_LINK, linkMessage, MAX_PASSWORD, MIN_PASSWORD, noMatch, passwordProblem, resetMessage, searchMessage, signInMessage, signUpMessage, tooLong, tooShort,
} from "./messages";

const STATUSES = [0, 400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503];
const CODES = [undefined, "INVALID_TOKEN", "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "INVALID_ORIGIN", "BAD_ORIGIN", "BOT_SUSPECTED", "EMAIL_NOT_VERIFIED", "SIGNUP_ANSWERS_REFUSED", "SIGNUP_NAME_REFUSED", "SIGNUP_TERMS_MISSING",
  "ALREADY_IN_A_COMPANY", "ORGANISATION_NOT_AVAILABLE", "CLAIM_COOL_DOWN", "REFUSED", "NUMBER_ALREADY_REGISTERED", "BAD_REQUEST", "NO_SESSION", "TOO_MANY_REQUESTS", "NOT_WAITING_FOR_ANSWER", "INVITE_NOT_VALID", "TEAM_FULL", "ALREADY_IN_TEAM", "X"];
const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Better Auth|INVALID_|FORBIDDEN|[A-Z]{3,}_[A-Z_]{3,}|stack|\bban(ned)?\b/i);

describe("messages", () => {
  it("every status and code of every route gives a plain sentence that is never empty and never a raw code", () => {
    for (const fn of [signUpMessage, signInMessage, linkMessage, resetMessage, companyMessage, searchMessage, answerMessage, acceptMessage])
      for (const status of STATUSES) for (const code of CODES) {
        const m = fn({ status, code });
        expect(m.length, `${fn.name} ${status} ${code}`).toBeGreaterThan(10);
        clean(m);
      }
  });
  it("BA7: every claim and register refusal has its own sentence", () => {
    const codes = ["ALREADY_IN_A_COMPANY", "ORGANISATION_NOT_AVAILABLE", "CLAIM_COOL_DOWN", "EMAIL_NOT_VERIFIED", "REFUSED", "NUMBER_ALREADY_REGISTERED"];
    const seen = new Set(codes.map((code) => companyMessage({ status: 409, code })));
    expect(seen.size).toBe(codes.length);
    expect(companyMessage({ status: 429, code: "CLAIM_COOL_DOWN" })).toMatch(/24 hours/);
    expect(companyMessage({ status: 403, code: "REFUSED" })).not.toMatch(/ban|block/i); // a ban answers the same REFUSED as a blocked login and the page must not say which
    expect(companyMessage({ status: 429, code: "TOO_MANY_REQUESTS" })).toMatch(/Too many/);
    expect(companyMessage({ status: 0 })).toMatch(/reach the server/);
  });
  it("sign-in: 401 is the frame's wording, an unconfirmed email says so, a blocked login does not leak, an Origin 403 is not 'cannot sign in'", () => {
    expect(signInMessage({ status: 401 })).toBe("That email and password do not match. Try again or reset your password.");
    expect(signInMessage({ status: 403, code: "EMAIL_NOT_VERIFIED" })).toMatch(/Confirm your email/);
    expect(signInMessage({ status: 403, code: "FORBIDDEN" })).toMatch(/cannot sign in/);
    expect(signInMessage({ status: 403, code: "INVALID_ORIGIN" })).not.toMatch(/cannot sign in/);
    expect(signInMessage({ status: 429 })).toMatch(/Too many/);
  });
  it("sign-up: each code has its own words", () => {
    expect(signUpMessage({ status: 400, code: "SIGNUP_ANSWERS_REFUSED" })).toMatch(/terms/);
    expect(signUpMessage({ status: 400, code: "SIGNUP_NAME_REFUSED" })).toMatch(/name/);
    expect(signUpMessage({ status: 400, code: "PASSWORD_TOO_SHORT" })).toBe(tooShort);
    expect(signUpMessage({ status: 503, code: "SIGNUP_TERMS_MISSING" })).toMatch(/not open yet/);
  });
  it("reset: each code has its own words", () => {
    expect(resetMessage({ status: 400, code: "INVALID_TOKEN" })).toBe(INVALID_LINK);
    expect(resetMessage({ status: 400, code: "PASSWORD_TOO_LONG" })).toBe(tooLong);
  });
  it("passwordProblem holds the route's limits (8 to 128) and the repeat", () => {
    expect(passwordProblem("a".repeat(MIN_PASSWORD - 1))).toBe(tooShort);
    expect(passwordProblem("a".repeat(MAX_PASSWORD + 1))).toBe(tooLong);
    expect(passwordProblem("a".repeat(MIN_PASSWORD), "b".repeat(MIN_PASSWORD))).toBe(noMatch);
    expect(passwordProblem("a".repeat(MIN_PASSWORD), "a".repeat(MIN_PASSWORD))).toBeNull();
    expect(passwordProblem("a".repeat(MAX_PASSWORD))).toBeNull();
  });
});

describe("small pure parts", () => {
  it("the verify callback is our own page and carries a checked return path, encoded", () => {
    expect(verifyCallback(null)).toBe("/verify-email");
    expect(verifyCallback("/sign-up/agency")).toBe("/verify-email?next=%2Fsign-up%2Fagency");
    expect(afterVerify("employer", null)).toBe("/sign-up/claim");
    expect(afterVerify("agency", null)).toBe("/sign-up/agency");
    expect(afterVerify("agency", "/team/accept?token=x")).toBe("/team/accept?token=x");
  });
  it("a register row goes to the first-time form with its number and name, encoded; anything else without them", () => {
    expect(firstTimeHref({ croNumber: "623456", name: "A & B <Ltd>" })).toBe("/sign-up/first-time?cro=623456&name=A%20%26%20B%20%3CLtd%3E");
    expect(firstTimeHref({ croNumber: null, name: "x" })).toBe("/sign-up/first-time");
  });
  it("croFound: a register row is found, a row on the site is 'already on the site', no row is none (leading zeros and IE do not matter)", () => {
    const rows = [{ organisationId: null, name: "FAKE LTD", croNumber: "623456", county: "Cork" }, { organisationId: "7", name: "Fake Two", croNumber: "500001", county: null }];
    const body = { results: rows };
    expect(croFound(body, "IE 0623456")).toEqual({ kind: "found", name: "FAKE LTD", county: "Cork" });
    expect(croFound(body, "500001")).toEqual({ kind: "onsite" });
    expect(croFound(body, "999999")).toEqual({ kind: "none" });
    expect(croFound({ results: "nope" }, "623456")).toEqual({ kind: "none" });
  });
});

describe("the frame", () => {
  const page = html(<AuthFrame step={2} title="Title" lead="Lead" panel={["One", "two"]} panelLead="Panel lead" candidates="https://c.example/" help="https://c.example/help"><p>form</p></AuthFrame>);
  it("has one H1, the four steps with the current one marked, the aside cards, the legal line and the help link", () => {
    expect(page.match(/<h1/g)).toHaveLength(1);
    for (const s of STEPS) expect(page).toContain(s);
    expect(page.match(/aria-current="step"/g)).toHaveLength(1);
    expect(page).toMatch(/Asking candidates for money is an instant ban/);
    expect(page).toMatch(/href="\/terms"/);
    expect(page).toMatch(/href="\/privacy"/);
    expect(page).toMatch(/href="https:\/\/c\.example\/help"/);
    expect(page).not.toMatch(/[\u2013\u2014]/);
  });
  it("hides the candidate and help links when their address is not set, and drops the header when bare", () => {
    const bare = html(<AuthFrame bare title="T" panel={["a", "b"]} panelLead="x"><p>form</p></AuthFrame>);
    expect(bare).not.toMatch(/For candidates|Help|<header/);
  });
});

describe("the account forms", () => {
  it("sign-up: name, email, password and the terms tick (required), an error shows in an alert, pending disables the button", () => {
    const p = html(<SignUpView termsHref="/terms" />);
    expect(p).toMatch(/name="name"/);
    expect(p).toMatch(/type="email"/);
    expect(p).toMatch(/type="password"[^>]*autoComplete="new-password"|autoComplete="new-password"[^>]*type="password"/);
    expect(p).toMatch(/name="acceptsTerms"[^>]*required|required[^>]*name="acceptsTerms"/);
    expect(p).toMatch(/href="\/terms"/);
    expect(html(<SignUpView error="Tick the box to accept the terms." />)).toMatch(/Tick the box/);
    expect(html(<SignUpView pending />)).toMatch(/disabled/);
  });
  it("check your email: names the address, resend, resent and error states, and the way back to sign up", () => {
    expect(html(<CheckEmailView email="a@b.example" />)).toMatch(/a@b\.example/);
    expect(html(<CheckEmailView email="a@b.example" resent />)).toMatch(/sent the link again/);
    expect(html(<CheckEmailView email="a@b.example" error="Too many tries." />)).toMatch(/Too many tries/);
    expect(html(<CheckEmailView email="a@b.example" />)).toMatch(/href="\/sign-up"/);
  });
  it("sign-in: fields, forgot link, error, the confirmation resend after an unconfirmed email, and a success notice", () => {
    const p = html(<SignInView />);
    expect(p).toMatch(/autoComplete="current-password"/);
    expect(p).toMatch(/href="\/forgot-password"/);
    expect(html(<SignInView error="That email and password do not match." />)).toMatch(/role="alert"/);
    expect(html(<SignInView notVerified />)).toMatch(/Send the confirmation link again/);
    expect(html(<SignInView notVerified resent />)).toMatch(/sent the link again/);
    expect(html(<SignInView notice="Your password was changed." />)).toMatch(/Your password was changed/);
  });
  it("forgot and resend never say whether the address has an account; reset has form, invalid and done states", () => {
    expect(html(<ForgotView sent />)).toMatch(/If that address has an employer login/);
    expect(html(<ResendView sent />)).toMatch(/If that address has an account/);
    expect(html(<ResendView />)).toMatch(/type="email"/);
    expect(html(<ResetView />)).toMatch(/Repeat new password/);
    expect(html(<ResetView invalid />)).toMatch(/does not work/);
    expect(html(<ResetView done />)).toMatch(/Password changed/);
    expect(html(<ResetView error={noMatch} />)).toMatch(/not the same/);
  });
});

describe("the company step", () => {
  const rows = [{ organisationId: "11", name: "Fake Quay Hotels Limited", croNumber: "712001", county: "Galway" }, { organisationId: null, name: "FAKE HARBOUR SUPPLIES LIMITED", croNumber: "713001", county: "Cork" }];
  it("claim: idle, loading, results with a company to claim and a register row to register, not found, search error, claim error, and the first-time way out", () => {
    const base = { q: "", email: "me@example.test", results: [] as typeof rows };
    expect(html(<ClaimView {...base} status="idle" />)).toMatch(/My company is not listed: I am a first-time sponsor/);
    expect(html(<ClaimView {...base} status="idle" />)).toMatch(/disabled/); // nothing picked: the claim button is off
    expect(html(<ClaimView {...base} status="loading" q="fake" />)).toMatch(/Searching/);
    const found = html(<ClaimView {...base} status="done" q="fake" results={rows} picked="11" />);
    expect(found).toMatch(/Fake Quay Hotels Limited/);
    expect(found).toMatch(/Galway · CRO 712001/);
    expect(found).toMatch(/type="radio"[^>]*checked|checked[^>]*type="radio"/);
    expect(found).toMatch(/href="\/sign-up\/first-time\?cro=713001&amp;name=FAKE%20HARBOUR%20SUPPLIES%20LIMITED"/); // the register row (DD8)
    expect(found).toMatch(/Register as a first-time sponsor/);
    expect(html(<ClaimView {...base} status="done" q="zzzz" />)).toMatch(/We did not find that company/); // the not-found state (DD8)
    expect(html(<ClaimView {...base} status="error" error="Too many tries." q="fake" />)).toMatch(/Too many tries/);
    expect(html(<ClaimView {...base} status="done" results={rows} picked="11" error="This company is no longer open to claim." />)).toMatch(/no longer open/);
    expect(html(<ClaimView {...base} status="idle" />)).toMatch(/readOnly=""|readonly=""/i);
  });
  it("first-time: found, not found, already on the site (to the claim step), lookup error, free email note, the label notice, send error", () => {
    const base = { cro: "712001", name: "Fake Quay Hotels Limited", email: "me@gmail.test" };
    expect(html(<FirstTimeView {...base} found={{ kind: "found", name: "FAKE LTD", county: "Cork" }} />)).toMatch(/Found: FAKE LTD · Cork/);
    expect(html(<FirstTimeView {...base} found={{ kind: "none" }} />)).toMatch(/did not find this number/);
    const onsite = html(<FirstTimeView {...base} found={{ kind: "onsite" }} />);
    expect(onsite).toMatch(/already on the site/);
    expect(onsite).toMatch(/href="\/sign-up\/claim\?q=712001"/);
    expect(html(<FirstTimeView {...base} found={{ kind: "error", text: "Too many tries." }} />)).toMatch(/Too many tries/);
    expect(html(<FirstTimeView {...base} free />)).toMatch(/free email provider/);
    expect(html(<FirstTimeView {...base} />)).not.toMatch(/free email provider/);
    const p = html(<FirstTimeView {...base} error="We cannot take this request" />);
    expect(p).toMatch(/First-time sponsor&quot; label/);
    expect(p).not.toMatch(/automatically/); // CF68
    expect(p).toMatch(/We cannot take this request/);
    expect(p).not.toMatch(/Your name and role|HR Manager/); // no role field (L51)
  });
  it("agency: licence, name, optional CRO, the no-fee tick, no WRC register line (CF123), the lapse line says new postings stop (CF66)", () => {
    const p = html(<AgencyView />);
    expect(p).toMatch(/name="wrcLicenceNumber"/);
    expect(p).toMatch(/name="noFee"[^>]*required|required[^>]*name="noFee"/);
    expect(p).toMatch(/We will check it against the WRC register/);
    expect(p).not.toMatch(/On the WRC register|list of/);
    expect(p).not.toMatch(/pauses your jobs/);
    expect(p).toMatch(/stops new postings/);
    expect(html(<AgencyView error="Check the details." />)).toMatch(/Check the details/);
  });
  it("answer and accept: one plain note and no upload; one button", () => {
    const a = html(<AnswerView />);
    expect(a).toMatch(/<textarea/);
    expect(a).not.toMatch(/type="file"|Upload/);
    expect(html(<AnswerView error="Write one line." />)).toMatch(/Write one line/);
    expect(html(<AcceptView />)).toMatch(/Accept the invitation/);
    expect(html(<AcceptView error="This invitation has ended." />)).toMatch(/has ended/);
  });
});
