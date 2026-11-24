// The staff sign-in, forgot and reset pages: every answer of the routes has a message, and every state of the three forms renders. react-dom/server, no browser, no network.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthFrame } from "./auth-frame";
import { ForgotView, ResetView, SignInView } from "./auth-forms";
import { forgotMessage, INVALID_LINK, MAX_PASSWORD, MIN_PASSWORD, noMatch, passwordProblem, resetMessage, signInMessage, tooLong, tooShort } from "./messages";

const STATUSES = [0, 400, 401, 403, 404, 429, 500, 502, 503];
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|Better Auth|INVALID_|FORBIDDEN|stack/);

describe("messages", () => {
  it("every status each route can answer, with and without a code, gives a plain sentence that is never empty", () => {
    for (const fn of [signInMessage, forgotMessage, resetMessage])
      for (const status of STATUSES) for (const code of [undefined, "INVALID_TOKEN", "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "INVALID_ORIGIN", "X"]) {
        const m = fn({ status, code });
        expect(m.length, `${fn.name} ${status} ${code}`).toBeGreaterThan(10);
        if (code !== "INVALID_TOKEN") clean(m);
      }
  });
  it("sign-in: 401 is the frame's wording, 403 says the login cannot sign in, 429 says wait, 0 says offline, an Origin 403 is not 'disabled'", () => {
    expect(signInMessage({ status: 401 })).toBe("That email and password do not match. Try again or reset your password.");
    expect(signInMessage({ status: 403 })).toMatch(/cannot sign in/);
    expect(signInMessage({ status: 403, code: "INVALID_ORIGIN" })).not.toMatch(/cannot sign in/);
    expect(signInMessage({ status: 429 })).toMatch(/Too many/);
    expect(signInMessage({ status: 0 })).toMatch(/reach the server/);
    expect(signInMessage({ status: 500 })).toMatch(/not working/);
  });
  it("sign-in never says which of the two was wrong, and forgot never says whether the address has a login", () => {
    expect(signInMessage({ status: 401 })).toMatch(/email and password do not match/);
    expect(html(<ForgotView sent />)).toMatch(/If that address belongs to a staff login/);
  });
  it("reset: each code has its own words", () => {
    expect(resetMessage({ status: 400, code: "INVALID_TOKEN" })).toBe(INVALID_LINK);
    expect(resetMessage({ status: 400, code: "PASSWORD_TOO_SHORT" })).toBe(tooShort);
    expect(resetMessage({ status: 400, code: "PASSWORD_TOO_LONG" })).toBe(tooLong);
    expect(resetMessage({ status: 429 })).toMatch(/Too many/);
  });
  it("passwordProblem holds the route's limits (8 to 128) and the repeat", () => {
    expect(passwordProblem("a".repeat(MIN_PASSWORD - 1), "a".repeat(MIN_PASSWORD - 1))).toBe(tooShort);
    expect(passwordProblem("a".repeat(MAX_PASSWORD + 1), "a".repeat(MAX_PASSWORD + 1))).toBe(tooLong);
    expect(passwordProblem("a".repeat(MIN_PASSWORD), "b".repeat(MIN_PASSWORD))).toBe(noMatch);
    expect(passwordProblem("a".repeat(MIN_PASSWORD), "a".repeat(MIN_PASSWORD))).toBeNull();
    expect(passwordProblem("a".repeat(MAX_PASSWORD), "a".repeat(MAX_PASSWORD))).toBeNull();
  });
});

describe("the frame", () => {
  const page = html(<AuthFrame title="Staff sign in" lead="Lead"><p>form</p></AuthFrame>);
  it("has one H1, the staff badge, no candidate wording and no Google or sign-up link", () => {
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toMatch(/Internal, staff only/);
    expect(page).not.toMatch(/Google|Create a free account|candidate|Launch B|Sample/i);
    clean(page);
  });
});

describe("the sign-in form", () => {
  it("renders the first state with email and password fields, autocomplete, the reset link and the 8 hour rule", () => {
    const p = html(<SignInView />);
    expect(p).toMatch(/type="email"/);
    expect(p).toMatch(/autoComplete="current-password"|autocomplete="current-password"/i);
    expect(p).toMatch(/href="\/forgot-password"/);
    expect(p).toMatch(/ends after 8 hours without use/);
    expect(p).not.toMatch(/role="alert"/);
  });
  it("shows the error under the password as an alert, and a disabled button while it asks", () => {
    const e = html(<SignInView error={signInMessage({ status: 401 })} />);
    expect(e).toMatch(/role="alert"/);
    expect(e).toMatch(/do not match/);
    expect(html(<SignInView pending />)).toMatch(/disabled/);
  });
});

describe("the forgot form", () => {
  it("first state, error state, sent state", () => {
    expect(html(<ForgotView />)).toMatch(/Send the link/);
    expect(html(<ForgotView error={forgotMessage({ status: 429 })} />)).toMatch(/role="alert"/);
    const s = html(<ForgotView sent />);
    expect(s).toMatch(/1 hour and only once/);
    expect(s).not.toMatch(/<form/);
  });
});

describe("the reset form", () => {
  it("first state names the 8 character rule and that other sign-ins end", () => {
    const p = html(<ResetView />);
    expect(p).toMatch(/At least 8 characters/);
    expect(p).toMatch(/autoComplete="new-password"|autocomplete="new-password"/i);
    expect(p).toMatch(/ends every other sign-in/);
  });
  it("error, invalid link and done states", () => {
    expect(html(<ResetView error={tooShort} />)).toMatch(/role="alert"/);
    const bad = html(<ResetView invalid />);
    expect(bad).toMatch(/ended or was already used/);
    expect(bad).toMatch(/href="\/forgot-password"/);
    expect(bad).not.toMatch(/<form/);
    expect(html(<ResetView done />)).toMatch(/href="\/sign-in"/);
  });
});
