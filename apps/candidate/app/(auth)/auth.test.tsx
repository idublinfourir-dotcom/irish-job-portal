// P11, unit: the sign-up, sign-in, verify and reset pages. Every answer code of the routes has a plain sentence, every screen renders in every state to HTML
// (react-dom/server, no browser, no network, no database), the return address check refuses everything that could leave the site, and the titles and
// descriptions keep frame 01's size rules. Only Next's own pieces and the data layer are stood in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ signedIn: false, google: false, origin: "http://localhost:3000" as string | null }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("../../lib/data", () => ({
  readSignedIn: async () => state.signedIn,
  readSignInProviders: () => ({ google: state.google }),
  siteOrigin: () => { if (!state.origin) throw new Error("no origin"); return state.origin; },
}));
import { descriptionProblem, titleProblem } from "../../lib/seo";
import { checkedNext } from "./next-path";
import { LOGIN_META, RESET_META, SIGNUP_META, VERIFY_META, authMeta } from "./meta";
import { emailProblem, NO_ANSWER_BODY, passwordProblem, PASSWORD_MAX, PASSWORD_MIN, resetLinkError, say, verifyError, type Flow } from "./messages";
import { CheckEmailView, ForgotView, LoginView, NotForYouView, ResetView, SignupView, VerifiedView } from "./views";
import SignupPage from "../signup/page";
import LoginPage from "../login/page";
import VerifyPage from "../verify/page";
import ResetPage from "../reset/page";

const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Better Auth|INVALID_|FORBIDDEN|stack trace|Sample|Launch B|dangerouslySetInnerHTML/);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
beforeEach(() => Object.assign(state, { signedIn: false, google: false, origin: "http://localhost:3000" }));

describe("messages: every code the routes answer with has a plain sentence", () => {
  const STATUSES = [0, 400, 401, 403, 404, 409, 413, 429, 500, 503];
  const CODES = [undefined, "X", "BOT_SUSPECTED", "TOO_MANY_REQUESTS", "INVALID_ORIGIN", "INVALID_EMAIL", "VALIDATION_ERROR", "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG"];
  const FLOWS: Flow[] = ["signup", "signin", "resend", "reset-request", "reset", "change-email", "request", "upload"];
  it("any flow, status and code gives a sentence that is never empty and never the server's own text", () => {
    for (const flow of FLOWS) for (const status of STATUSES) for (const code of CODES) {
      const s = say(flow, { ok: false, status, code }).text;
      expect(s.length, `${flow} ${status} ${code}`).toBeGreaterThan(15);
      clean(s);
    }
  });
  it("the codes named in the sign-in routes' contract (docs/openapi/candidate.yaml) each have their own words in the flow that gets them", () => {
    const yaml = readFileSync(join(import.meta.dirname, "../../../../docs/openapi/candidate.yaml"), "utf8");
    const authPost = yaml.slice(yaml.indexOf("operationId: candidateAuthPost"), yaml.indexOf("/api/jobs:"));
    const named = new Set([...authPost.matchAll(/`([A-Z][A-Z_]{5,})`/g)].map((m) => m[1]!));
    // REAUTH_REQUIRED belongs to change-email and link-social, which the account page builds (P17), not these pages; the rest are used here.
    const flowOf: Record<string, Flow[]> = {
      SIGNUP_ANSWERS_REFUSED: ["signup"], SIGNUP_NAME_REFUSED: ["signup"], INVALID_EMAIL: ["signup", "resend", "change-email", "reset-request"], INVALID_EMAIL_OR_PASSWORD: ["signin", "change-email"],
      ALREADY_VERIFIED: ["change-email"], BOT_SUSPECTED: ["signup", "signin", "reset-request", "resend", "change-email"], EMAIL_TAKEN: ["signup"], VALIDATION_ERROR: ["signup"],
    };
    const generic = new Set(FLOWS.map((f) => say(f, { ok: false, status: 400, code: "ZZZ_NOT_A_CODE" }).text));
    for (const code of named) {
      if (code === "REAUTH_REQUIRED" || code === "INVALID_TOKEN" || !flowOf[code]) continue; // INVALID_TOKEN is checked in the reset test below
      for (const flow of flowOf[code]!) {
        const s = say(flow, { ok: false, status: code === "INVALID_EMAIL_OR_PASSWORD" ? 401 : 400, code }).text;
        expect(generic.has(s), `${flow} ${code}: ${s}`).toBe(false);
      }
    }
    expect([...named]).toEqual(expect.arrayContaining(["SIGNUP_ANSWERS_REFUSED", "SIGNUP_NAME_REFUSED", "BOT_SUSPECTED", "ALREADY_VERIFIED"]));
  });
  it("sign-in: wrong password, unverified (shows the check-your-email screen), suspended (no code), 429, bot check, offline", () => {
    expect(say("signin", { ok: false, status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }).text).toBe("That email and password do not match. Try again or reset your password.");
    expect(say("signin", { ok: false, status: 403, code: "EMAIL_NOT_VERIFIED" })).toEqual({ text: "Your email is not verified yet.", screen: "check-email" });
    expect(say("signin", { ok: false, status: 403 }).text).toMatch(/cannot sign in/);
    expect(say("signin", { ok: false, status: 403, code: "INVALID_ORIGIN" }).text).not.toMatch(/cannot sign in/);
    expect(say("signin", { ok: false, status: 429 }).text).toMatch(/Too many tries/);
    expect(say("signin", { ok: false, status: 403, code: "BOT_SUSPECTED" }).text).toMatch(/person/);
    expect(say("signin", { ok: false, status: 0 }).text).toMatch(/reach the site/);
  });
  it("sign-up: refused answers, name, terms missing, a taken email (never said at sign-up, but worded), password length", () => {
    const say400 = (code: string) => say("signup", { ok: false, status: 400, code }).text;
    expect(say400("SIGNUP_ANSWERS_REFUSED")).toMatch(/18 or over/);
    expect(say400("SIGNUP_NAME_REFUSED")).toMatch(/name/);
    expect(say400("EMAIL_TAKEN")).toMatch(/already has an account/);
    expect(say400("USER_ALREADY_EXISTS")).toMatch(/already has an account/);
    expect(say("signup", { ok: false, status: 503, code: "SIGNUP_TERMS_MISSING" }).text).toMatch(/not open yet/);
    expect(say400("PASSWORD_TOO_SHORT")).toContain(String(PASSWORD_MIN));
    expect(say400("PASSWORD_TOO_LONG")).toContain(String(PASSWORD_MAX));
  });
  it("reset and verify links: an ended, used or unknown token has its own words, an unknown code never gets echoed", () => {
    expect(say("reset", { ok: false, status: 400, code: "INVALID_TOKEN" }).text).toMatch(/expired or was already used/);
    for (const c of ["TOKEN_EXPIRED", "INVALID_TOKEN", "EMAIL_TAKEN", "USER_NOT_FOUND", "INVALID_USER", "<script>alert(1)</script>", undefined]) { clean(verifyError(c)); expect(verifyError(c).length).toBeGreaterThan(20); expect(verifyError(c)).not.toContain("<script>"); }
    expect(verifyError("EMAIL_TAKEN")).toMatch(/Another account/);
    expect(verifyError("TOKEN_EXPIRED")).toMatch(/expired or was already used/);
    expect(resetLinkError("INVALID_TOKEN")).toMatch(/expired or was already used/);
    expect(resetLinkError("<b>x</b>")).not.toContain("<b>");
    expect(say("resend", { ok: false, status: 400, code: "ALREADY_VERIFIED" }).text).toMatch(/already verified/);
    expect(say("change-email", { ok: false, status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }).text).toMatch(/password does not match/);
  });
  it("the password rule is 8 to 128 characters (#178) and the email shape is checked before a send", () => {
    expect(passwordProblem("a".repeat(PASSWORD_MIN - 1))).toMatch(/at least 8/);
    expect(passwordProblem("a".repeat(PASSWORD_MAX + 1))).toMatch(/at most 128/);
    expect(passwordProblem("a".repeat(PASSWORD_MIN))).toBeUndefined();
    expect(passwordProblem("a".repeat(PASSWORD_MAX))).toBeUndefined();
    expect(PASSWORD_MIN).toBe(8);
    for (const bad of ["", "a", "a@b", "a b@c.ie", `${"a".repeat(250)}@b.ie`]) expect(emailProblem(bad), bad).toBeTruthy();
    expect(emailProblem("a.b@example.ie")).toBeUndefined();
  });
  it("the 'No' answer sends only the answer", () => {
    expect(NO_ANSWER_BODY).toEqual({ needsPermit: false });
  });
});

describe("the sign-up screen (NS3, M06, DD40)", () => {
  const base = { answer: null, employersHref: "http://localhost:3001/", next: null } as const;
  it("has one H1, the permit question with Yes before No, the name field, the 18 tick, the terms tick with both links and an 8 character rule", () => {
    const p = html(<SignupView {...base} />);
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(p.indexOf('value="yes"')).toBeGreaterThan(0);
    expect(p.indexOf('value="yes"')).toBeLessThan(p.indexOf('value="no"'));
    expect(p).toMatch(/name="name"/);
    expect(p).toMatch(/name="over18"/);
    expect(p).toMatch(/I am 18 or over/);
    expect(p).toMatch(/name="acceptsTerms"/);
    expect(p).toMatch(/href="\/terms"/);
    expect(p).toMatch(/href="\/privacy"/);
    expect(p).toMatch(/At least 8 characters/);
    expect(p).not.toMatch(/10 characters/);
    expect(p).toMatch(/autoComplete="new-password"|autocomplete="new-password"/i);
    expect(text(p)).toMatch(/Do you need, or will you soon need, an employment permit to work in Ireland/);
    clean(p);
  });
  it("hides the Google button until the site has Google (Q24), shows it when it has", () => {
    expect(html(<SignupView {...base} />)).not.toMatch(/Continue with Google/);
    expect(html(<SignupView {...base} google />)).toMatch(/Continue with Google/);
  });
  it("hides the employer portal link when the setting is absent, and keeps the return address on the sign in link", () => {
    expect(html(<SignupView {...base} employersHref={null} />)).not.toMatch(/Employer portal/);
    const p = html(<SignupView {...base} next="/jobs/staff-nurse-cork-4821" />);
    expect(p).toMatch(/Employer portal/);
    expect(p).toContain('href="/login?next=%2Fjobs%2Fstaff-nurse-cork-4821"');
  });
  it("fields are required only for a Yes, so a No can be said without typing anything", () => {
    const yes = html(<SignupView {...base} answer="yes" />), no = html(<SignupView {...base} answer="no" />);
    expect(yes.match(/required=""/g)!.length).toBeGreaterThan(no.match(/required=""/g)!.length);
    expect(no).toMatch(/If you answer &quot;No&quot;/);
  });
  it("shows an error as an alert and a pending state with a disabled button", () => {
    expect(html(<SignupView {...base} answer="yes" error={say("signup", { ok: false, status: 400, code: "SIGNUP_NAME_REFUSED" }).text} />)).toMatch(/role="alert"/);
    expect(html(<SignupView {...base} answer="yes" pending />)).toMatch(/disabled=""[^>]*>Creating|Creating/);
  });
  it("the 'No' screen (C24) names who can sign up and offers a way back, the checker, the jobs and the employer portal when there is one", () => {
    const p = html(<NotForYouView employersHref="http://localhost:3001/" />);
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(text(p)).toMatch(/This site is only for people who need a permit/);
    expect(text(p)).toMatch(/Stamp 2 or Stamp 1G/);
    expect(p).toMatch(/Change my answer/);
    expect(p).toMatch(/href="\/eligibility-checker"/);
    expect(p).toMatch(/href="\/jobs"/);
    expect(p).toMatch(/href="http:\/\/localhost:3001\/"/);
    expect(html(<NotForYouView employersHref={null} />)).not.toMatch(/I am an employer or agency/);
  });
});

describe("check your email (C27)", () => {
  it("shows the address, a resend button that waits, and the way to change a wrong address", () => {
    const p = html(<CheckEmailView email="fake.person@example.test" wait={45} />);
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(p).toMatch(/fake\.person@example\.test/);
    expect(p).toMatch(/You can resend in 45 seconds/);
    expect(p).toMatch(/disabled=""[^>]*>Resend email/);
    expect(p).toMatch(/Wrong address\?/);
    expect(p).not.toMatch(/Saved for you/); // the pending save is Later (L2, #287)
    expect(html(<CheckEmailView email="a@example.test" wait={1} />)).toMatch(/in 1 second\./);
    expect(html(<CheckEmailView email="a@example.test" wait={0} />)).not.toMatch(/disabled=""[^>]*>Resend email/);
    clean(p);
  });
  it("the change form asks for the new address and the password, and says what a flash message says", () => {
    const p = html(<CheckEmailView email="a@example.test" wait={0} changing flash={{ kind: "error", text: say("change-email", { ok: false, status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }).text }} />);
    expect(p).toMatch(/name="newEmail"/);
    expect(p).toMatch(/name="password"/);
    expect(p).toMatch(/role="alert"/);
    expect(p).toMatch(/password does not match/);
  });
  it("with no address (a visitor who opened /verify, or a link that did not work) it asks for the email first", () => {
    const p = html(<CheckEmailView email={null} wait={0} flash={{ kind: "error", text: verifyError("TOKEN_EXPIRED") }} />);
    expect(p).toMatch(/name="email"/);
    expect(p).toMatch(/Send the link/);
    expect(p).toMatch(/expired or was already used/);
  });
  it("a sign-in that found the email unverified says so before the address line", () => {
    expect(text(html(<CheckEmailView email="a@example.test" wait={0} reason="Your email is not verified yet." />))).toMatch(/Your email is not verified yet\. We sent a link to/);
  });
});

describe("sign in, reset and verified screens (C26, C27)", () => {
  it("sign in: email and password with the right autocomplete, keep me signed in ticked, forgot password, create account, no Google by default", () => {
    const p = html(<LoginView next={null} />);
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(p).toMatch(/autoComplete="username"|autocomplete="username"/i);
    expect(p).toMatch(/autoComplete="current-password"|autocomplete="current-password"/i);
    expect(p).toMatch(/name="rememberMe"[^>]*checked|checked[^>]*name="rememberMe"/);
    expect(p).toMatch(/href="\/reset"/);
    expect(p).toMatch(/href="\/signup"/);
    expect(p).not.toMatch(/Google/);
    expect(html(<LoginView next="/jobs/a-1" google />)).toMatch(/Continue with Google/);
    expect(html(<LoginView next="/jobs/a-1" />)).toContain('href="/signup?next=%2Fjobs%2Fa-1"');
    expect(text(html(<LoginView next={null} notice="Google sign-in did not finish." />))).toMatch(/Google sign-in did not finish/);
  });
  it("sign in error is an alert under the password field, and the button is disabled while it asks", () => {
    const e = html(<LoginView next={null} error={say("signin", { ok: false, status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }).text} />);
    expect(e).toMatch(/role="alert"/);
    expect(e).toMatch(/do not match/);
    expect(html(<LoginView next={null} pending />)).toMatch(/disabled=""[^>]*>Signing in/);
  });
  it("forgot: first state, error state, sent state (never says whether the address has an account)", () => {
    expect(html(<ForgotView />)).toMatch(/Send the link/);
    expect(html(<ForgotView error={say("reset-request", { ok: false, status: 429 }).text} />)).toMatch(/role="alert"/);
    const s = html(<ForgotView sent />);
    expect(text(s)).toMatch(/If that address has an account/);
    expect(text(s)).toMatch(/1 hour and only once/);
    expect(s).not.toMatch(/<form/);
  });
  it("reset: the form (8 characters, repeat), the done state, and the link that did not work with a way to ask again", () => {
    const f = html(<ResetView />);
    expect(f).toMatch(/name="password"/);
    expect(f).toMatch(/name="repeat"/);
    expect(f).toMatch(/At least 8 characters/);
    expect(f).toMatch(/minLength="8"|minlength="8"/i);
    expect(html(<ResetView error="The two passwords are not the same." />)).toMatch(/role="alert"/);
    expect(html(<ResetView done />)).toMatch(/Password[\s\S]*changed/);
    const bad = html(<ResetView invalid linkProblem={resetLinkError("INVALID_TOKEN")} />);
    expect(text(bad)).toMatch(/expired or was already used/);
    expect(bad).toMatch(/href="\/reset"/);
    expect(bad).not.toMatch(/<form/);
  });
  it("verified: a visitor goes on to sign in, a signed-in person continues; the return address is kept", () => {
    expect(html(<VerifiedView signedIn={false} loginHref="/login?next=%2Fjobs%2Fa-1" continueHref="/jobs" />)).toContain('href="/login?next=%2Fjobs%2Fa-1"');
    const s = html(<VerifiedView signedIn continueHref="/jobs/a-1" loginHref="/login" />);
    expect(s).toContain('href="/jobs/a-1"');
    expect(s).toMatch(/Continue/);
  });
  it("no screen ships a photo, an image tag, a Sample mark, a dash, or a number copied from a frame", () => {
    const all = [html(<SignupView answer={null} employersHref={null} next={null} />), html(<NotForYouView employersHref={null} />), html(<CheckEmailView email="a@example.test" wait={3} />), html(<LoginView next={null} />),
      html(<ForgotView />), html(<ResetView />), html(<VerifiedView signedIn={false} loginHref="/login" continueHref="/jobs" />)].join("");
    clean(all);
    expect(all).not.toMatch(/<img|amara@|Permitly|At least 10|10 characters|Northquay/i);
  });
});

describe("the return address (?next=) is only ever one of our own paths", () => {
  const OK = ["/jobs/staff-nurse-cork-4821", "/jobs?county=Cork&q=nurse", "/permit-services/request?job=1042", "/", "/companies/fake-org", "/account/alerts"];
  const BAD = [
    "//evil.example", "/\\evil.example", "\\\\evil.example", "https://evil.example/", "http://localhost:3000.evil.example/", "javascript:alert(1)", "data:text/html,x", "evil.example", "", " /jobs/a-1",
    "/\t/evil.example", "/\n/evil.example", "/jobs/a\u0000b", "/jobs/%2F%2Fevil.example", "/%2F/evil.example", "/%5Cevil.example", "/jobs/a\\b", `/${"a".repeat(1001)}`, "/ jobs", "/аpple", "/login", "/login?next=/jobs/a-1",
    "/signup", "/verify?verified=1", "/reset?token=x", "/api/auth/candidate/sign-out", "/API/anything",
  ];
  it("accepts plain own paths", () => { for (const v of OK) expect(checkedNext(v), v).toBe(v); });
  it("refuses an open redirect in every shape, an address that would send a signed-in person back to a sign-in page or into the API, and any non-string", () => {
    for (const v of BAD) expect(checkedNext(v), JSON.stringify(v)).toBeNull();
    for (const v of [undefined, ["/jobs/a-1", "/jobs/b-2"], ["//evil.example"], []]) expect(checkedNext(v as string[] | undefined), JSON.stringify(v)).toBeNull();
  });
  it("without a site address setting nothing is accepted (fails closed)", () => {
    state.origin = null;
    expect(checkedNext("/jobs/a-1")).toBeNull();
  });
});

describe("titles and descriptions (frame 01 SEO spec)", () => {
  it("each page has a title of 60 characters or fewer, a description of 120 to 160, and is noindex whatever the site setting", () => {
    for (const [title, description] of [SIGNUP_META, LOGIN_META, VERIFY_META, RESET_META]) {
      expect(titleProblem(title)).toBeNull();
      expect(descriptionProblem(description)).toBeNull();
      const m = authMeta(title, description);
      expect(String(m.title)).toMatch(/ \| Irish Work Permit$/);
      expect(m.robots).toEqual({ index: false, follow: false });
      clean(`${m.title} ${m.description}`);
    }
  });
  it("the reset page also sends no referrer (its address holds a token)", async () => {
    const { generateMetadata } = await import("../reset/page");
    expect(generateMetadata().referrer).toBe("no-referrer");
  });
});

describe("the pages (server components): redirects, the checked return address, and what each state renders", () => {
  const search = (q: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(q) });
  const redirectsTo = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return String((e as Error).message).replace("NEXT_REDIRECT ", ""); } return null; };

  it("a signed-in candidate on /signup or /login goes on to the checked return address, or the jobs page when it is not one of ours", async () => {
    state.signedIn = true;
    for (const page of [SignupPage, LoginPage]) {
      expect(await redirectsTo(() => page(search({ next: "/jobs/staff-nurse-cork-4821" })))).toBe("/jobs/staff-nurse-cork-4821");
      expect(await redirectsTo(() => page(search({})))).toBe("/jobs");
      for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "/login"]) expect(await redirectsTo(() => page(search({ next: bad }))), bad).toBe("/jobs");
      expect(await redirectsTo(() => page(search({ next: ["/jobs/a-1", "/jobs/b-2"] })))).toBe("/jobs");
    }
  });
  it("a visitor gets the sign-up form with the employer link from the setting (hidden when the setting is absent) and Google only when set", async () => {
    const el = await SignupPage(search({ next: "/jobs/a-1" }));
    expect(el.props).toMatchObject({ google: false, next: "/jobs/a-1" });
    state.google = true;
    expect((await SignupPage(search({}))).props).toMatchObject({ google: true, next: null });
    const prev = process.env.PORTAL_AUTH_URL, env = process.env as Record<string, string | undefined>;
    delete env.PORTAL_AUTH_URL; Object.assign(env, { NODE_ENV: "production" });
    try { expect((await SignupPage(search({}))).props.employersHref).toBeNull(); } finally { if (prev) env.PORTAL_AUTH_URL = prev; Object.assign(env, { NODE_ENV: "test" }); }
  });
  it("the sign-in page hands the form the checked path only, and shows one fixed line for a Google error, never the code", async () => {
    expect((await LoginPage(search({ next: "//evil.example" }))).props.next).toBeNull();
    expect((await LoginPage(search({ next: "/jobs/a-1" }))).props.next).toBe("/jobs/a-1");
    const e = await LoginPage(search({ error: "<script>alert(1)</script>" }));
    expect(e.props.notice).toMatch(/Google sign-in did not finish/);
    expect(e.props.notice).not.toContain("<script>");
  });
  it("/verify: verified, an error (which wins over verified, as the library adds it to the same address), and the bare address", async () => {
    const verified = await VerifyPage(search({ verified: "1", next: "/jobs/a-1" }));
    expect(verified.props).toMatchObject({ signedIn: false, loginHref: "/login?next=%2Fjobs%2Fa-1", continueHref: "/jobs/a-1" });
    state.signedIn = true;
    expect((await VerifyPage(search({ verified: "1" }))).props).toMatchObject({ signedIn: true, continueHref: "/jobs" });
    const err = await VerifyPage(search({ verified: "1", error: "TOKEN_EXPIRED" }));
    expect(err.props).toMatchObject({ email: null, initialFlash: { kind: "error" } });
    expect(err.props.initialFlash.text).toMatch(/expired or was already used/);
    expect((await VerifyPage(search({ error: "<b>x</b>" }))).props.initialFlash.text).not.toContain("<b>");
    expect((await VerifyPage(search({}))).props).toMatchObject({ email: null, next: null });
    expect((await VerifyPage(search({ verified: "1", next: "//evil.example" }))).props.continueHref).toBe("/jobs");
  });
  it("/reset: no token asks for the email; a token chooses the password (also when signed in); an error or an empty or huge token is the 'did not work' screen", async () => {
    expect((await ResetPage(search({}))).type.name).toBe("ForgotFlow");
    state.signedIn = true;
    expect(await redirectsTo(() => ResetPage(search({})))).toBe("/jobs"); // the bare address: a signed-in person goes to their account
    const withToken = await ResetPage(search({ token: "abc123" }));
    expect(withToken.type.name).toBe("ResetFlow"); // an emailed link opened while signed in keeps its token
    expect(withToken.props).toEqual({ token: "abc123" });
    for (const q of [{ error: "INVALID_TOKEN" }, { token: "" }, { token: "x".repeat(201) }, { token: ["a", "b"] as string[] }, { token: "abc", error: "INVALID_TOKEN" }]) {
      const el = await ResetPage(search(q));
      expect(el.type.name, JSON.stringify(q).slice(0, 40)).toBe("ResetView");
      expect(el.props.invalid).toBe(true);
    }
  });
});
